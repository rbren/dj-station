//! Beatify (PRD "Beatify" tab): turn an arbitrary audio file into material
//! with mathematically perfect beats.
//!
//! The headless pipeline is `detect → fit → warp → trim → emit`:
//!
//! 1. [`detect`] runs a beat tracker (`beat_this` when installed, the
//!    built-in DSP tracker otherwise) and throws the downbeats away —
//!    Beatify knows about beats and nothing else. No meter, no bars.
//! 2. [`grid`] fits `t = phase + n × period` with outlier rejection,
//!    scores seed agreement, places warp anchors and computes the two
//!    competing meters (worst flam / peak stretch) as pure arithmetic.
//! 3. [`warp`] renders the audio through the anchor map, pitch-preserving,
//!    once, at save time.
//! 4. [`store`] keeps the result under `<data_dir>/beatify/<hash>/`.
//!
//! **The region is the import.** Whatever span is analyzed becomes the
//! track; everything outside is discarded, so the grid is only ever
//! applied to audio it was fitted against. The render carries one beat of
//! padding at each end (MOD-A14), which is why `grid.phase` is one period
//! and never zero.

pub mod audition;
pub mod build;
pub mod detect;
pub mod grid;
pub mod store;
pub mod warp;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::decode::AudioData;
pub use build::Lay;
pub use detect::{BeatRun, BeatThisTracker, BeatTracker, DspTracker, TrackerStatus};
pub use grid::{
    Agreement, Anchor, Fit, Grid, Quality, Reading, SeedReading, Sweep, SweepPoint, Verdict,
};
pub use store::BEATIFY_DIR_NAME;
pub use warp::WarpMap;

/// Ruler grouping default (TV-4a). A display preference with no claim
/// about the music; stored per track (§6 open question 6).
pub const DEFAULT_RULER_GROUP: u32 = 4;

/// Everything the import modal needs after a detection pass. Cheap to
/// re-derive for a different reading (§3.8) and cheap to re-query for a
/// different warp strength (MOD-A22) — no audio is touched by either.
#[derive(Debug, Clone)]
pub struct Analysis {
    pub tracker: String,
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
            self.beats.clone(),
            self.confidence.clone(),
            self.agreement.clone(),
            base,
            reading,
            self.region,
            self.lead_in,
        )
    }
}

/// Fit the raw detections (no reading applied).
fn base_fit(beats: &[f64]) -> Result<Fit> {
    grid::fit_beats(beats).ok_or_else(|| anyhow!("not enough steady beats to fit a grid"))
}

#[allow(clippy::too_many_arguments)]
fn assemble(
    tracker: String,
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
    let reference = runs
        .first()
        .ok_or_else(|| anyhow!("the tracker returned no beats"))?
        .beats
        .clone();
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
        reference,
        confidence,
        agreement,
        base,
        reading,
        region,
        lead_in,
    )
}

/// The full warp render (MOD-A24): one pass, at save time.
pub fn render(audio: &AudioData, analysis: &Analysis, strength: f64) -> (AudioData, WarpMap) {
    let map = analysis.map_at(strength);
    let out = warp::render(audio, &map, analysis.output_secs());
    (out, map)
}

/// Render only the beats currently being heard (MOD-A23): the A/B toggle
/// and the sync check never render a whole track.
pub fn render_window(
    audio: &AudioData,
    analysis: &Analysis,
    strength: f64,
    start_secs: f64,
    secs: f64,
) -> AudioData {
    let map = analysis.map_at(strength);
    let start = start_secs.max(0.0);
    let shifted = WarpMap {
        points: map.points.iter().map(|(s, d)| (*s, d - start)).collect(),
    };
    warp::render(audio, &shifted, secs.max(0.0))
}

// ---------------------------------------------------------------------------
// §5 payload — the contract with the rest of dj-station
// ---------------------------------------------------------------------------

/// Display-only ruler grouping (TV-4a, OUT-1b).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ruler {
    pub group: u32,
}

impl Default for Ruler {
    fn default() -> Self {
        Ruler {
            group: DEFAULT_RULER_GROUP,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarpSpec {
    pub strength: f64,
    /// Anchor spacing in beats; 0 is the no-warp position (MOD-17).
    pub anchor_stride: usize,
    pub map: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisMeta {
    pub tracker: String,
    pub agreement: Agreement,
    /// Per-beat confidence, drives the density band at close zoom (TV-5).
    pub confidence: Vec<f32>,
}

/// What Save writes (MOD-A27): everything needed to redraw the track and
/// to reproduce the render.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatifyRecord {
    /// Original file, untouched (OUT-2: only re-warping reads it).
    pub source: String,
    /// Content hash of the source — how records are keyed (MOD-A28).
    pub source_hash: String,
    /// Provenance only: which part of the source this came from (MOD-A15).
    pub source_span: [f64; 2],
    /// Constant-tempo render — this IS the track.
    pub warped: String,
    pub grid: Grid,
    /// Seconds, applied at cut time, separate from the grid (MOD-22).
    pub lead_in: f64,
    pub ruler: Ruler,
    pub warp: WarpSpec,
    pub quality: Quality,
    pub analysis: AnalysisMeta,
    /// Metrical level / half-beat phase the grid was read at (MOD-A30).
    pub reading: Reading,
}

/// What Save decided, as opposed to what the analysis measured.
#[derive(Debug, Clone)]
pub struct Commit<'a> {
    pub source: &'a std::path::Path,
    pub source_hash: &'a str,
    /// Display name of the render (`boys.beatified.wav`).
    pub warped_name: &'a str,
    pub strength: f64,
    pub lead_in: f64,
    pub ruler: Ruler,
}

/// Assemble the §5 payload for a finished render.
pub fn record(analysis: &Analysis, commit: &Commit<'_>, map: &WarpMap) -> BeatifyRecord {
    let Commit {
        source,
        source_hash,
        warped_name,
        strength,
        lead_in,
        ruler,
    } = *commit;
    let span = [
        map.source_time(0.0),
        map.source_time(analysis.output_secs()),
    ];
    BeatifyRecord {
        source: source.display().to_string(),
        source_hash: source_hash.to_string(),
        source_span: span,
        warped: warped_name.to_string(),
        grid: analysis.grid,
        lead_in,
        ruler,
        warp: WarpSpec {
            strength,
            anchor_stride: grid::anchor_stride(strength).unwrap_or(0),
            map: map.pairs(),
        },
        quality: analysis.quality_at(strength),
        analysis: AnalysisMeta {
            tracker: analysis.tracker.clone(),
            agreement: analysis.agreement.clone(),
            confidence: analysis.confidence.clone(),
        },
        reading: analysis.reading,
    }
}
