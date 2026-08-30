//! Beat analysis: where the beats of a piece of audio are, how even they
//! are, and how to pull them onto a grid.
//!
//! The headless pipeline is `detect → fit → warp`:
//!
//! 1. [`detect`] runs a beat tracker (`beat_this` when installed, the
//!    built-in DSP tracker otherwise) and throws the downbeats away —
//!    this crate knows about beats and nothing else. No meter, no bars.
//! 2. [`grid`] fits `t = phase + n × period` with outlier rejection,
//!    scores seed agreement, places warp anchors and computes the two
//!    competing meters (worst flam / peak stretch) as pure arithmetic.
//! 3. [`warp`] renders the audio through the anchor map, pitch-preserving.
//!
//! Its one consumer is the Clip page ([`crate::clip`]): tempo detection
//! for a span, the tapped-grid fit behind right-shift taps, and the WSOLA
//! stretch a tap warp is rendered through.

pub mod detect;
pub mod grid;
pub mod warp;

use anyhow::{anyhow, Result};

use crate::decode::AudioData;
pub use detect::{BeatRun, BeatThisTracker, BeatTracker, DspTracker, TrackerStatus};
pub use grid::{
    Agreement, Anchor, Fit, Grid, Quality, Reading, SeedReading, Sweep, SweepPoint, TapAlignment,
    TapOutcome, TapVerdict, Verdict,
};
pub use warp::WarpMap;

/// Everything one detection pass found. Cheap to re-derive for a
/// different reading and cheap to re-query for a different warp strength
/// — no audio is touched by either.
#[derive(Debug, Clone)]
pub struct Analysis {
    pub tracker: String,
    /// Every tracker pass, kept whole. The grid is fitted to ONE of them
    /// (`seed`); the others are what the agreement score is made of, what
    /// the seed picker offers, and what taps choose between — none of
    /// which can re-run the tracker (MOD-26).
    pub runs: Vec<BeatRun>,
    /// Which run `beats` came from.
    pub seed: String,
    /// Detections of the reference seed, source seconds.
    pub beats: Vec<f64>,
    pub confidence: Vec<f32>,
    pub agreement: Agreement,
    /// Grid fitted to the detections, with the reading applied.
    pub fit: Fit,
    pub reading: Reading,
    /// Span the detections were taken from, source seconds (MOD-A8).
    pub region: [f64; 2],
    /// First/last whole grid beat inside the region.
    pub first_index: f64,
    pub last_index: f64,
    pub grid: Grid,
    pub sweep: Sweep,
    pub lead_in: f64,
    /// MOD-23 auto-flag: the inter-beat histogram is bimodal at 2:1.
    pub metrical_flag: bool,
}

impl Analysis {
    /// Head padding: one beat (MOD-A14), so `grid.phase == period`.
    pub fn head_pad(&self) -> f64 {
        self.grid.period
    }

    /// Length of the rendered track: the beats plus a beat of padding at
    /// each end.
    pub fn output_secs(&self) -> f64 {
        (self.grid.beats as f64 + 1.0) * self.grid.period
    }

    pub fn anchors_at(&self, strength: f64) -> Vec<Anchor> {
        grid::anchors_for_strength(
            &self.fit,
            self.first_index,
            self.last_index,
            self.head_pad(),
            strength,
        )
    }

    pub fn map_at(&self, strength: f64) -> WarpMap {
        WarpMap::from_anchors(&self.anchors_at(strength))
    }

    /// Meters for a slider position (MOD-13) — anchor arithmetic only.
    pub fn quality_at(&self, strength: f64) -> Quality {
        grid::quality(
            &self.fit,
            &self.anchors_at(strength),
            self.first_index,
            self.head_pad(),
        )
    }

    /// Signed per-beat residuals for the error strip (MOD-4), seconds.
    pub fn residuals_at(&self, strength: f64) -> Vec<f64> {
        grid::warped_residuals(
            &self.fit,
            &self.anchors_at(strength),
            self.first_index,
            self.head_pad(),
        )
    }

    /// Where the source tempo departs from the target (MOD-3).
    pub fn drift_spans(&self) -> Vec<grid::DriftSpan> {
        grid::drift_spans(&self.fit, self.first_index, self.last_index)
    }

    /// Fitted index of the first grid line at or after the file start.
    /// Beat numbering in the import modal counts from here, so beat 0 is
    /// a line you can actually see rather than an extrapolation.
    fn lattice_origin(&self) -> f64 {
        (-self.fit.phase / self.fit.period).ceil()
    }

    /// The fitted grid in SOURCE seconds, spanning the whole file: what
    /// the import modal draws over the source waveform and snaps its
    /// region to.
    ///
    /// [`Analysis::grid`] cannot do this job — it is the OUTPUT timebase,
    /// where phase is the head pad (MOD-A14) and beat 0 is a beat of the
    /// render that does not exist yet. This one is where the beats are in
    /// the file you are looking at. It deliberately runs past the
    /// analyzed region, because the region is an INPUT to the next
    /// detection run: a grid line has to exist outside it for the region
    /// to be moved by whole beats.
    pub fn source_grid(&self, duration_secs: f64) -> Grid {
        let period = self.fit.period;
        let phase = self.fit.line(self.lattice_origin());
        let span = ((duration_secs - phase) / period).floor();
        Grid {
            bpm: self.fit.bpm(),
            period,
            phase,
            beats: span.max(0.0) as usize + 1,
        }
    }

    /// Which [`Analysis::source_grid`] beat each residual belongs to, so
    /// the error strip can sit over the beat it is about. Detections that
    /// outlier rejection threw away have no residual, so these indices
    /// skip — they are not `0..residuals.len()`.
    pub fn residual_beats(&self) -> Vec<f64> {
        let origin = self.lattice_origin();
        self.fit
            .beats
            .iter()
            .filter(|b| b.index >= self.first_index)
            .map(|b| b.index - origin)
            .collect()
    }

    /// Source-time positions of the fitted grid lines — what the click
    /// track ticks against while phase 1 plays the unwarped audio.
    pub fn source_grid_times(&self) -> Vec<f64> {
        let mut n = self.first_index;
        let mut out = Vec::new();
        while n <= self.last_index {
            out.push(self.fit.line(n));
            n += 1.0;
        }
        out
    }

    /// Output-time positions of every grid line (the warped click track).
    pub fn output_grid_times(&self) -> Vec<f64> {
        (0..self.grid.beats)
            .map(|n| self.grid.beat_time(n as f64))
            .collect()
    }

    /// Re-read the same detections at a different metrical level or phase
    /// (§3.8). The tracker never runs again (MOD-26).
    pub fn with_reading(&self, reading: Reading) -> Result<Analysis> {
        let base = base_fit(&self.beats)?;
        assemble(
            self.tracker.clone(),
            self.runs.clone(),
            self.seed.clone(),
            self.beats.clone(),
            self.confidence.clone(),
            self.agreement.clone(),
            base,
            reading,
            self.region,
            self.lead_in,
        )
    }

    /// Fit the grid to a DIFFERENT seed's detections (§3.8a).
    ///
    /// `analyze` takes the first run as reference, which is a position in
    /// a list rather than a merit; when the seeds split, the one that was
    /// right may not be the one that was first. Every run is already in
    /// hand, so this is a re-fit, never a re-run (MOD-26) — but confidence
    /// and the lead-in are measurements of THESE beats against the audio,
    /// so they are taken again rather than carried over.
    pub fn with_seed(&self, seed: &str, audio: &AudioData, reading: Reading) -> Result<Analysis> {
        let run = self
            .runs
            .iter()
            .find(|r| r.seed == seed)
            .ok_or_else(|| anyhow!("no seed called {seed} in this analysis"))?;
        if run.beats.len() < 4 {
            return Err(anyhow!("seed {seed} found too few beats to fit a grid"));
        }
        let beats = run.beats.clone();
        let mono = audio.mono_mix();
        let confidence = grid::beat_confidence(&mono, audio.sample_rate, &beats);
        let lead_in = grid::measure_lead_in(&mono, audio.sample_rate, &beats);
        let base = base_fit(&beats)?;
        assemble(
            self.tracker.clone(),
            self.runs.clone(),
            seed.to_string(),
            beats,
            confidence,
            self.agreement.clone(),
            base,
            reading,
            self.region,
            lead_in,
        )
    }

    /// Let a tap sequence choose the seed and the reading (§3.8a).
    ///
    /// The taps do not touch the grid: [`grid::reconcile_taps`] picks a
    /// candidate that already exists and this re-seats the analysis onto
    /// it. A refused verdict changes nothing and says why.
    pub fn with_taps(
        &self,
        taps: &[f64],
        audio: &AudioData,
    ) -> Result<(Analysis, grid::TapVerdict)> {
        let runs: Vec<(String, Vec<f64>)> = self
            .runs
            .iter()
            .map(|r| (r.seed.clone(), r.beats.clone()))
            .collect();
        let verdict = grid::reconcile_taps(&runs, taps);
        if verdict.outcome != grid::TapOutcome::Chose {
            return Ok((self.clone(), verdict));
        }
        let next = self.with_seed(&verdict.seed, audio, verdict.reading)?;
        Ok((next, verdict))
    }
}

/// Fit the raw detections (no reading applied).
fn base_fit(beats: &[f64]) -> Result<Fit> {
    grid::fit_beats(beats).ok_or_else(|| anyhow!("not enough steady beats to fit a grid"))
}

#[allow(clippy::too_many_arguments)]
fn assemble(
    tracker: String,
    runs: Vec<BeatRun>,
    seed: String,
    beats: Vec<f64>,
    confidence: Vec<f32>,
    agreement: Agreement,
    base: Fit,
    reading: Reading,
    region: [f64; 2],
    lead_in: f64,
) -> Result<Analysis> {
    let fit = grid::apply_reading(&base, reading);
    let first_index = fit.first_index().ceil();
    let last_index = fit.last_index().floor();
    if last_index - first_index < 1.0 {
        return Err(anyhow!("that region is shorter than two beats"));
    }
    let period = fit.period;
    let grid_out = Grid {
        bpm: 60.0 / period,
        period,
        // OUT-1a: beat 0 always has a beat of audio behind it.
        phase: period,
        beats: (last_index - first_index) as usize + 1,
    };
    let sweep = grid::sweep(&fit, first_index, last_index, period);
    let metrical_flag = grid::ibi_bimodal(&beats);
    Ok(Analysis {
        tracker,
        runs,
        seed,
        beats,
        confidence,
        agreement,
        fit,
        reading,
        region,
        first_index,
        last_index,
        grid: grid_out,
        sweep,
        lead_in,
        metrical_flag,
    })
}

/// Run detection over `region` (whole file when `None`) and fit a grid.
///
/// The tracker sees a few beats of context beyond the region and its
/// context detections are dropped (ANL-2a), so the region edges are not
/// distorted by a hard boundary.
pub fn analyze(
    audio: &AudioData,
    tracker: &dyn BeatTracker,
    region: Option<(f64, f64)>,
    reading: Reading,
) -> Result<Analysis> {
    let runs = tracker.detect(audio, region)?;
    let first = runs
        .first()
        .ok_or_else(|| anyhow!("the tracker returned no beats"))?;
    let (seed, reference) = (first.seed.clone(), first.beats.clone());
    if reference.len() < 4 {
        return Err(anyhow!("too few beats in that region to fit a grid"));
    }
    let agreement = grid::score_agreement(
        &runs
            .iter()
            .map(|r| (r.seed.clone(), r.beats.clone()))
            .collect::<Vec<_>>(),
    );
    let mono = audio.mono_mix();
    let confidence = grid::beat_confidence(&mono, audio.sample_rate, &reference);
    let lead_in = grid::measure_lead_in(&mono, audio.sample_rate, &reference);
    let base = base_fit(&reference)?;
    let region = region
        .map(|(a, b)| [a.min(b), a.max(b)])
        .unwrap_or([0.0, audio.duration_secs()]);
    assemble(
        tracker.id(),
        runs,
        seed,
        reference,
        confidence,
        agreement,
        base,
        reading,
        region,
        lead_in,
    )
}
