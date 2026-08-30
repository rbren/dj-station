//! Grid fitting, seed agreement and the warp meters (PRD §2.2, §3.0.1,
//! §3.6, §3.7).
//!
//! Everything here is arithmetic over detected beat times — no audio is
//! rendered (MOD-A22), which is what lets the warp slider be continuous
//! and live.
//!
//! Beat indices are `f64`, not integers, because the `Shift ½ beat`
//! reading correction (MOD-24) moves the grid half a period relative to
//! the detections: after it, a detection sits at index `n - 0.5`. Every
//! consumer treats indices as positions on one line, so half-integers cost
//! nothing and the correction stays a pure grid transform (MOD-26).

use serde::{Deserialize, Serialize};

/// Residual band the user cannot hear (MOD-4/MOD-5), seconds.
pub const IN_BAND_SECS: f64 = 0.005;
/// Meter thresholds (MOD-14).
pub const FLAM_GREEN_MS: f64 = 5.0;
pub const STRETCH_GREEN_PCT: f64 = 1.2;
/// How far the lead-in slider reaches (MOD-20), seconds. The measured
/// value lands near 12–16 ms on typical material; the range is wide
/// because material that wants a long reach-back (a swelling pad, a
/// pickup note) exists and 40 ms could not express it.
pub const LEAD_IN_MAX: f64 = 0.250;
/// Safety pad added to the measured attack offset (MOD-18).
pub const LEAD_IN_PAD: f64 = 0.002;
/// How far either side of a grid line an attack is looked for. This
/// bounds what MEASUREMENT can return, and it is deliberately much
/// tighter than `LEAD_IN_MAX`: an onset further than this from the beat
/// belongs to a different beat.
pub const ATTACK_RADIUS: f64 = 0.025;
/// Densest and sparsest anchor spacing the warp slider can reach.
pub const MIN_STRIDE: usize = 1;
pub const MAX_STRIDE: usize = 64;

/// The two-number grid a beatified track is described by (OUT-1).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grid {
    pub bpm: f64,
    pub period: f64,
    /// Seconds of beat 0 in the warped file. Always one period — the head
    /// padding from MOD-A14 (OUT-1a).
    pub phase: f64,
    /// Number of beats in the warped file.
    pub beats: usize,
}

impl Grid {
    /// Time of beat `n` in the warped file (OUT-1).
    pub fn beat_time(&self, n: f64) -> f64 {
        self.phase + n * self.period
    }
}

/// One detection with the grid index the fit assigned it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FittedBeat {
    pub index: f64,
    /// Source seconds.
    pub time: f64,
}

/// A least-squares grid fitted over detections (ANL-6).
#[derive(Debug, Clone, PartialEq)]
pub struct Fit {
    pub period: f64,
    /// Source seconds of grid index 0.
    pub phase: f64,
    pub beats: Vec<FittedBeat>,
    /// Detections dropped by outlier rejection (doubled / missed beats).
    pub rejected: usize,
}

impl Fit {
    pub fn bpm(&self) -> f64 {
        60.0 / self.period
    }

    /// Fitted line at index `n`, source seconds.
    pub fn line(&self, n: f64) -> f64 {
        self.phase + n * self.period
    }

    pub fn first_index(&self) -> f64 {
        self.beats.first().map(|b| b.index).unwrap_or(0.0)
    }

    pub fn last_index(&self) -> f64 {
        self.beats.last().map(|b| b.index).unwrap_or(0.0)
    }

    /// Signed residuals (detection minus grid line), source seconds.
    pub fn residuals(&self) -> Vec<f64> {
        self.beats
            .iter()
            .map(|b| b.time - self.line(b.index))
            .collect()
    }
}

/// Outlier rejection threshold as a fraction of the period, and how many
/// reject/refit passes run (ANL-6).
const REJECT_FRACTION: f64 = 0.15;
const REFIT_PASSES: usize = 2;
/// Half-width (in detections) of the local trend a residual is judged
/// against. Outliers must be measured against the LOCAL tempo, not the
/// straight line: on a drifting track the line's own residual is large and
/// judging against it throws away perfectly good beats.
const TREND_HALF: usize = 4;
/// How fast the walking period follows what the detections actually do.
const WALK_ADAPT: f64 = 0.3;

/// Fit `t = phase + n × period` over detected beat times, with iterative
/// outlier rejection so a doubled or missed beat cannot drag the line.
pub fn fit_beats(times: &[f64]) -> Option<Fit> {
    if times.len() < 4 {
        return None;
    }
    let mut times: Vec<f64> = times.to_vec();
    times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let mut ibis: Vec<f64> = times.windows(2).map(|w| w[1] - w[0]).collect();
    ibis.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let period = ibis[ibis.len() / 2];
    if !(period.is_finite() && period > 0.0) {
        return None;
    }

    let mut kept = walk_indices(&times, period);
    let mut rejected = 0usize;
    let (mut phase, mut period) = lsq(&kept)?;
    for _ in 0..REFIT_PASSES {
        let before = kept.len();
        kept = reject_outliers(kept, phase, period);
        rejected += before - kept.len();
        if kept.len() < 4 {
            return None;
        }
        let (p, q) = lsq(&kept)?;
        phase = p;
        period = q;
    }

    // Re-base indices on the first surviving beat so index 0 is real.
    let base = kept[0].index;
    for b in kept.iter_mut() {
        b.index -= base;
    }
    phase += base * period;

    Some(Fit {
        period,
        phase,
        beats: kept,
        rejected,
    })
}

/// Assign a grid index to every detection by walking them with a period
/// that follows the material. A gap of ~2 periods is two beats; a gap far
/// under one period is a doubled detection and shares its neighbour's
/// index, where outlier rejection can pick between them.
fn walk_indices(times: &[f64], seed_period: f64) -> Vec<FittedBeat> {
    let mut period = seed_period;
    let mut out = Vec::with_capacity(times.len());
    // Steps are measured from the last detection that ADVANCED the index,
    // so a doubled beat shares an index without pushing everything after
    // it half a beat late.
    let mut anchor_time = times[0];
    let mut anchor_index = 0.0f64;
    out.push(FittedBeat {
        index: anchor_index,
        time: times[0],
    });
    for &t in &times[1..] {
        let dt = t - anchor_time;
        let ratio = dt / period;
        // Under three quarters of a period is a doubled detection, not a
        // rushed beat: round() would call an exact half-period gap a beat
        // and shift every index after it.
        let steps = if ratio < 0.75 { 0.0 } else { ratio.round() };
        out.push(FittedBeat {
            index: anchor_index + steps,
            time: t,
        });
        if steps >= 1.0 {
            let observed = dt / steps;
            if (observed - period).abs() < 0.2 * period {
                period += WALK_ADAPT * (observed - period);
            }
            anchor_index += steps;
            anchor_time = t;
        }
    }
    out
}

/// Drop detections that miss the LOCAL trend of the residual curve — a
/// doubled or missed beat — while leaving genuine drift alone.
fn reject_outliers(beats: Vec<FittedBeat>, phase: f64, period: f64) -> Vec<FittedBeat> {
    let residuals: Vec<f64> = beats
        .iter()
        .map(|b| b.time - (phase + b.index * period))
        .collect();
    let limit = REJECT_FRACTION * period;
    let mut out: Vec<FittedBeat> = Vec::with_capacity(beats.len());
    let mut last_deviation = f64::INFINITY;
    for (i, b) in beats.iter().enumerate() {
        let lo = i.saturating_sub(TREND_HALF);
        let hi = (i + TREND_HALF + 1).min(residuals.len());
        let mut window: Vec<f64> = residuals[lo..hi].to_vec();
        window.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let trend = window[window.len() / 2];
        let deviation = (residuals[i] - trend).abs();
        if deviation > limit {
            continue;
        }
        // Two detections claiming one grid index: keep the better one.
        match out.last() {
            Some(prev) if (prev.index - b.index).abs() < 1e-9 => {
                if deviation < last_deviation {
                    out.pop();
                    out.push(*b);
                    last_deviation = deviation;
                }
            }
            _ => {
                out.push(*b);
                last_deviation = deviation;
            }
        }
    }
    out
}

/// Ordinary least squares of `time = phase + index × period`.
fn lsq(beats: &[FittedBeat]) -> Option<(f64, f64)> {
    let n = beats.len() as f64;
    if n < 2.0 {
        return None;
    }
    let mean_i = beats.iter().map(|b| b.index).sum::<f64>() / n;
    let mean_t = beats.iter().map(|b| b.time).sum::<f64>() / n;
    let mut num = 0.0;
    let mut den = 0.0;
    for b in beats {
        num += (b.index - mean_i) * (b.time - mean_t);
        den += (b.index - mean_i) * (b.index - mean_i);
    }
    if den <= 0.0 || num <= 0.0 {
        return None;
    }
    let period = num / den;
    Some((mean_t - period * mean_i, period))
}

// ---------------------------------------------------------------------------
// Reading corrections (§3.8)
// ---------------------------------------------------------------------------

/// How the fitted grid is read (MOD-23, MOD-24). Pure transforms on the
/// fit — neither re-runs the tracker (MOD-26).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    /// Metrical level: 2.0 doubles the tempo, 0.5 halves it.
    pub factor: f64,
    /// Offbeat phase fix: the grid moves half a period.
    pub half_shift: bool,
}

impl Default for Reading {
    fn default() -> Self {
        Reading {
            factor: 1.0,
            half_shift: false,
        }
    }
}

impl Reading {
    pub fn is_identity(&self) -> bool {
        (self.factor - 1.0).abs() < 1e-9 && !self.half_shift
    }
}

/// Apply a reading correction to a fit.
///
/// `factor = 2` halves the period and doubles every index (the detections
/// stay where they are; the grid simply names them twice as fast).
/// `factor = 0.5` keeps every other detection, since the odd ones are no
/// longer on the grid. `half_shift` slides the grid — not the audio — half
/// a period, so detections land on half-integer indices.
pub fn apply_reading(fit: &Fit, reading: Reading) -> Fit {
    let factor = if reading.factor > 0.0 {
        reading.factor
    } else {
        1.0
    };
    let period = fit.period / factor;
    let mut beats: Vec<FittedBeat> = fit
        .beats
        .iter()
        .map(|b| FittedBeat {
            index: b.index * factor,
            time: b.time,
        })
        .collect();
    if factor < 1.0 {
        // Half-tempo: the in-between detections are off-grid now.
        beats.retain(|b| (b.index - b.index.round()).abs() < 1e-6);
    }
    let phase = if reading.half_shift {
        for b in beats.iter_mut() {
            b.index -= 0.5;
        }
        fit.phase + period / 2.0
    } else {
        fit.phase
    };
    Fit {
        period,
        phase,
        beats,
        rejected: fit.rejected,
    }
}

/// MOD-23 auto-flag: is the inter-beat-interval histogram bimodal at 2:1?
/// True when a meaningful share of the gaps sit at half or double the
/// median — either mode can be the majority, so both are tested.
pub fn ibi_bimodal(times: &[f64]) -> bool {
    if times.len() < 8 {
        return false;
    }
    let mut ibis: Vec<f64> = times.windows(2).map(|w| w[1] - w[0]).collect();
    ibis.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = ibis[ibis.len() / 2];
    if median <= 0.0 {
        return false;
    }
    let share = |target: f64| {
        ibis.iter()
            .filter(|d| (*d - target).abs() < 0.1 * median)
            .count() as f64
            / ibis.len() as f64
    };
    share(median / 2.0) > 0.2 || share(median * 2.0) > 0.2
}

// ---------------------------------------------------------------------------
// Seed agreement (§3.0.1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    Unanimous,
    MostlyAgreed,
    Split,
    MetricalSplit,
    /// One tracker, so there is nothing to compare (the DSP fallback).
    SingleTracker,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedReading {
    pub seed: String,
    pub bpm: f64,
    pub beats: usize,
    /// Mean gap between this seed's detections, seconds. The four fields
    /// below are the RAW intervals — nothing rejected — because that is
    /// what makes them diagnostic: a doubled beat shows up in `ibi_min`
    /// and a missed one in `ibi_max`, which is precisely the news the
    /// fitted BPM hides. Defaulted so records written before they existed
    /// still read.
    #[serde(default)]
    pub ibi_mean: f64,
    #[serde(default)]
    pub ibi_min: f64,
    #[serde(default)]
    pub ibi_max: f64,
    /// Population variance of those intervals, seconds².
    #[serde(default)]
    pub ibi_variance: f64,
}

/// Raw interval statistics of one run: mean, min, max, variance.
fn ibi_stats(beats: &[f64]) -> (f64, f64, f64, f64) {
    let ibis: Vec<f64> = beats.windows(2).map(|w| w[1] - w[0]).collect();
    if ibis.is_empty() {
        return (0.0, 0.0, 0.0, 0.0);
    }
    let n = ibis.len() as f64;
    let mean = ibis.iter().sum::<f64>() / n;
    let var = ibis.iter().map(|d| (d - mean) * (d - mean)).sum::<f64>() / n;
    (
        mean,
        ibis.iter().cloned().fold(f64::INFINITY, f64::min),
        ibis.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
        var,
    )
}

/// The three axes of MOD-A4, never collapsed before the user sees them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agreement {
    pub verdict: Verdict,
    pub tempo_spread_bpm: f64,
    pub phase_agreement_pct: f64,
    pub metrical_split: bool,
    pub readings: Vec<SeedReading>,
    /// Source-second spans where the seeds disagree (MOD-A6).
    pub disagreement_spans: Vec<[f64; 2]>,
}

/// Beats agree when every seed lands within this of the reference.
pub const PHASE_TOLERANCE_SECS: f64 = 0.020;

pub fn score_agreement(runs: &[(String, Vec<f64>)]) -> Agreement {
    let readings: Vec<SeedReading> = runs
        .iter()
        .map(|(seed, beats)| {
            let (ibi_mean, ibi_min, ibi_max, ibi_variance) = ibi_stats(beats);
            SeedReading {
                seed: seed.clone(),
                bpm: fit_beats(beats).map(|f| f.bpm()).unwrap_or(0.0),
                beats: beats.len(),
                ibi_mean,
                ibi_min,
                ibi_max,
                ibi_variance,
            }
        })
        .collect();
    if runs.len() < 2 {
        return Agreement {
            verdict: Verdict::SingleTracker,
            tempo_spread_bpm: 0.0,
            phase_agreement_pct: 100.0,
            metrical_split: false,
            readings,
            disagreement_spans: Vec::new(),
        };
    }

    let bpms: Vec<f64> = readings
        .iter()
        .map(|r| r.bpm)
        .filter(|b| *b > 0.0)
        .collect();
    let spread = match (
        bpms.iter().cloned().fold(f64::INFINITY, f64::min),
        bpms.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
    ) {
        (lo, hi) if lo.is_finite() && hi.is_finite() => hi - lo,
        _ => f64::INFINITY,
    };
    // Metrical split: some seed reads a 2:1 or 1:2 relative of another.
    let metrical_split = bpms.iter().any(|a| {
        bpms.iter()
            .any(|b| *a > 0.0 && *b > 0.0 && ((a / b) - 2.0).abs() < 0.15)
    });

    // Phase agreement: reference seed's beats, matched against the rest.
    let reference = &runs[0].1;
    let mut matched = 0usize;
    let mut disagreement: Vec<f64> = Vec::new();
    for &t in reference {
        let ok = runs[1..]
            .iter()
            .all(|(_, beats)| nearest_distance(beats, t) <= PHASE_TOLERANCE_SECS);
        if ok {
            matched += 1;
        } else {
            disagreement.push(t);
        }
    }
    let phase_pct = if reference.is_empty() {
        0.0
    } else {
        100.0 * matched as f64 / reference.len() as f64
    };

    let verdict = if metrical_split {
        Verdict::MetricalSplit
    } else if spread < 0.1 && phase_pct > 98.0 {
        Verdict::Unanimous
    } else if spread < 0.5 && phase_pct > 90.0 {
        Verdict::MostlyAgreed
    } else {
        Verdict::Split
    };

    Agreement {
        verdict,
        tempo_spread_bpm: if spread.is_finite() { spread } else { 0.0 },
        phase_agreement_pct: phase_pct,
        metrical_split,
        readings,
        disagreement_spans: merge_spans(&disagreement, 1.0),
    }
}

fn nearest_distance(beats: &[f64], t: f64) -> f64 {
    beats
        .iter()
        .map(|b| (b - t).abs())
        .fold(f64::INFINITY, f64::min)
}

// ---------------------------------------------------------------------------
// Tap reconciliation (§3.8a)
// ---------------------------------------------------------------------------
//
// A TAP IS A VOTE, NOT A DATA POINT.
//
// The fit is two numbers over hundreds of detections, and a tracker's
// beats land within a few milliseconds where a human's land within a few
// tens. Least squares weights by 1/σ², so a tap carries something like a
// sixteenth of a detection's weight: twenty taps against six hundred
// detections would move the grid by nothing measurable. Feeding taps into
// `fit_beats` is arithmetic theatre.
//
// What taps ARE good at is the failure the models actually have. A seed
// does not miss by 8 ms; it hears half-time, or hears the offbeat, or two
// seeds hear one thing and the third hears another. Those are CATEGORICAL
// errors, and a human tapping along settles them at once. So the taps
// never move a grid — they choose between the grids already on the table:
// every seed, at every metrical level `Reading` can express.
//
// The latency is measured and then THROWN AWAY. Taps arrive late (motor
// plus output latency) by an unknown constant, and if that constant were
// allowed to move `phase`, the user's reaction time would be rendered
// into `warped.wav`, every clip cut from it would be late forever, and —
// because the output contract is `phase + n × period` with nothing to
// compare against — nothing downstream could ever notice.

/// Below this a tap sequence is not evidence: the resultant of a few
/// random times is high by luck alone (R ≈ 1/√n).
pub const MIN_TAPS: usize = 8;
/// How consistent the taps must be WITH THEMSELVES before they are
/// allowed an opinion about anything else.
pub const TAP_SELF_R_MIN: f64 = 0.70;
/// Concentration a candidate must reach to be chosen at all.
pub const TAP_MATCH_MIN: f64 = 0.55;
/// Metrical levels offered to the taps, as `Reading::factor`. A 2:1
/// misread is the whole failure mode; deeper relatives are not a thing
/// the trackers do.
pub const TAP_LEVELS: [f64; 3] = [0.5, 1.0, 2.0];
/// Width of the level weight in octaves: ±3 % tapping scores ~1, a
/// half-time tap scores ~0.
const TAP_LEVEL_SIGMA: f64 = 0.18;
/// A lag longer than this is not a human's latency any more, so the
/// choice is reported with that caveat rather than quietly trusted.
pub const TAP_LAG_IMPLAUSIBLE_SECS: f64 = 0.12;

const TAU: f64 = std::f64::consts::TAU;

/// How well a tap sequence sits on one grid.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TapAlignment {
    /// Circular concentration (mean resultant length), 0..=1. Invariant
    /// to the unknown latency, which is exactly why it is the measure.
    pub concentration: f64,
    /// Mean lag behind the grid line, wrapped into ±half a period. The
    /// user's body, not the track's phase.
    pub offset_secs: f64,
}

/// Concentration and mean lag of `taps` against the line
/// `phase + n × period`.
pub fn tap_alignment(taps: &[f64], period: f64, phase: f64) -> TapAlignment {
    if taps.is_empty() || !(period.is_finite() && period > 0.0) {
        return TapAlignment {
            concentration: 0.0,
            offset_secs: 0.0,
        };
    }
    let (sx, sy) = taps.iter().fold((0.0, 0.0), |(x, y), t| {
        let angle = TAU * ((t - phase) / period).rem_euclid(1.0);
        (x + angle.cos(), y + angle.sin())
    });
    let n = taps.len() as f64;
    TapAlignment {
        concentration: (sx * sx + sy * sy).sqrt() / n,
        offset_secs: sy.atan2(sx) / TAU * period,
    }
}

/// What a tap sequence turned out to be worth.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TapOutcome {
    /// Fewer than [`MIN_TAPS`].
    TooFew,
    /// The taps do not agree with themselves.
    Uneven,
    /// Consistent taps that fit none of the candidates — the user is
    /// hearing something no seed heard, which is news, not an error.
    NoMatch,
    /// The taps pick a seed and a reading.
    Chose,
}

/// The taps' answer: which seed, read how, and every number behind it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TapVerdict {
    pub outcome: TapOutcome,
    pub taps: usize,
    /// Tempo of the tapping itself, from the median gap.
    pub tap_bpm: f64,
    /// Concentration of the taps against their own median-gap grid.
    pub self_concentration: f64,
    /// Chosen seed, empty unless [`TapOutcome::Chose`].
    pub seed: String,
    pub reading: Reading,
    /// Concentration against the chosen candidate.
    pub concentration: f64,
    /// Measured tap latency — REPORTED, never applied to the grid.
    pub offset_secs: f64,
    /// Tap gap over the chosen candidate's period: 1 is tapping every
    /// beat, 4 is tapping bars at a candidate whose beat is four times
    /// as fast.
    pub level_ratio: f64,
    /// One line, for the modal to show verbatim.
    pub detail: String,
}

impl TapVerdict {
    fn refused(outcome: TapOutcome, taps: usize, tap_bpm: f64, self_r: f64, detail: &str) -> Self {
        TapVerdict {
            outcome,
            taps,
            tap_bpm,
            self_concentration: self_r,
            seed: String::new(),
            reading: Reading::default(),
            concentration: 0.0,
            offset_secs: 0.0,
            level_ratio: 0.0,
            detail: detail.to_string(),
        }
    }
}

/// The tempo of the tapping itself, and how steadily it was kept.
///
/// The period comes from a least-squares fit over the whole sequence, not
/// the median gap: a median is a local statistic, and judging twenty taps
/// against a line drawn from the first one and a typical gap accumulates
/// the error of every gap before it — a hand 2 % fast reads as having no
/// pulse at all by the twentieth tap. [`fit_beats`] is the same line the
/// detections get.
fn tap_pulse(taps: &[f64]) -> Option<(f64, f64)> {
    let fit = fit_beats(taps)?;
    let r = tap_alignment(taps, fit.period, fit.phase).concentration;
    Some((fit.period, r))
}

/// How much a candidate period is penalised for not being what the user
/// was tapping. Gaussian in octaves, so ×2 and ÷2 are punished equally.
fn level_weight(ratio: f64) -> f64 {
    if !(ratio.is_finite() && ratio > 0.0) {
        return 0.0;
    }
    let octaves = ratio.log2();
    (-(octaves * octaves) / (2.0 * TAP_LEVEL_SIGMA * TAP_LEVEL_SIGMA)).exp()
}

/// One grid the taps were scored against: a seed's fit under one
/// [`TAP_LEVELS`] reading (with the half-beat phase already decided by
/// the measured lag).
struct TapCandidate {
    seed: String,
    reading: Reading,
    concentration: f64,
    offset_secs: f64,
    level_ratio: f64,
}

/// What one pass over every candidate found.
struct TapScan {
    /// The best scorer, with its score.
    best: Option<(f64, TapCandidate)>,
    /// Raw closest (concentration, ratio) — when nothing scores, the
    /// argmax of a field of zeroes says nothing, and the candidate the
    /// taps actually LAND on, at the wrong rate, is what explains why.
    closest: Option<(f64, f64)>,
}

/// Score every (seed × level) candidate against `taps`.
///
/// The half-beat phase is decided by the measured lag — the one place
/// the latency is USED rather than discarded, because a lag past a
/// quarter period is not a late tap, it is a tap on the line in between.
fn scan_candidates(runs: &[(String, Vec<f64>)], taps: &[f64], tap_period: f64) -> TapScan {
    let mut best: Option<(f64, TapCandidate)> = None;
    let mut closest: Option<(f64, f64)> = None;
    for (seed, beats) in runs {
        let Some(base) = fit_beats(beats) else {
            continue;
        };
        for factor in TAP_LEVELS {
            let level = apply_reading(
                &base,
                Reading {
                    factor,
                    half_shift: false,
                },
            );
            let (period, phase) = (level.period, level.phase);
            if !(period.is_finite() && period > 0.0) {
                continue;
            }
            let on = tap_alignment(taps, period, phase);
            // Half a period away is the offbeat, not a slow hand.
            let half_shift = on.offset_secs.abs() > period / 4.0;
            let offset = if half_shift {
                let shifted = tap_alignment(taps, period, phase + period / 2.0);
                shifted.offset_secs
            } else {
                on.offset_secs
            };
            let ratio = tap_period / period;
            if closest.is_none_or(|(r, _)| on.concentration > r) {
                closest = Some((on.concentration, ratio));
            }
            let score = on.concentration * level_weight(ratio);
            // A tie is two candidates describing the SAME grid — a seed
            // that heard the pulse, and another that heard half of it and
            // is being doubled back. Prefer the one that needs no
            // correction: it is the reading whose detections are really
            // there, and the one whose ÷2/×2 buttons will then read as
            // untouched.
            if best.as_ref().is_some_and(|(b, c)| {
                *b > score + 1e-9 || (*b >= score - 1e-9 && !corrected(&c.reading))
            }) {
                continue;
            }
            best = Some((
                score,
                TapCandidate {
                    seed: seed.clone(),
                    reading: Reading { factor, half_shift },
                    concentration: on.concentration,
                    offset_secs: offset,
                    level_ratio: ratio,
                },
            ));
        }
    }
    TapScan { best, closest }
}

/// Choose the grid the taps agree with, among every seed at every
/// metrical level (§3.8a).
///
/// Nothing here fits anything to the taps: `runs` are the detections, the
/// candidates are their fits under each [`TAP_LEVELS`] reading, and the
/// taps only say which one they land on.
pub fn reconcile_taps(runs: &[(String, Vec<f64>)], taps: &[f64]) -> TapVerdict {
    let mut taps: Vec<f64> = taps.iter().copied().filter(|t| t.is_finite()).collect();
    taps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = taps.len();
    if n < MIN_TAPS {
        return TapVerdict::refused(
            TapOutcome::TooFew,
            n,
            0.0,
            0.0,
            &format!("{n} taps — keep going, {MIN_TAPS} is the least that means anything"),
        );
    }
    let Some((tap_period, self_r)) = tap_pulse(&taps) else {
        return TapVerdict::refused(TapOutcome::Uneven, n, 0.0, 0.0, "those taps had no tempo");
    };
    let tap_bpm = 60.0 / tap_period;
    // Self-consistency FIRST: taps that disagree with themselves must not
    // be able to overrule three models that agree.
    if self_r < TAP_SELF_R_MIN {
        return TapVerdict::refused(
            TapOutcome::Uneven,
            n,
            tap_bpm,
            self_r,
            "those taps were too uneven to read — nothing changed",
        );
    }

    let TapScan { best, closest } = scan_candidates(runs, &taps, tap_period);
    let Some((score, c)) = best else {
        return TapVerdict::refused(
            TapOutcome::NoMatch,
            n,
            tap_bpm,
            self_r,
            "no seed produced a grid to compare those taps against",
        );
    };
    if score < TAP_MATCH_MIN {
        let mut refusal = TapVerdict::refused(TapOutcome::NoMatch, n, tap_bpm, self_r, "");
        // The ratio worth reporting belongs to the grid the taps LAND on,
        // not to whichever candidate won a contest between near-zeroes.
        let (concentration, ratio) = closest.unwrap_or((0.0, c.level_ratio));
        refusal.concentration = concentration;
        refusal.level_ratio = ratio;
        refusal.detail = no_match_detail(concentration, ratio, tap_bpm);
        return refusal;
    }
    let mut verdict = TapVerdict {
        outcome: TapOutcome::Chose,
        taps: n,
        tap_bpm,
        self_concentration: self_r,
        seed: c.seed,
        reading: c.reading,
        concentration: c.concentration,
        offset_secs: c.offset_secs,
        level_ratio: c.level_ratio,
        detail: String::new(),
    };
    verdict.detail = chose_detail(&verdict);
    verdict
}

/// The Clip page's chooser (PRD §9): the taps BOUND a detection region
/// they were deliberately played over, so — unlike [`reconcile_taps`] —
/// there is no minimum count and no self-consistency gate: even two taps
/// choose whichever seed and reading they land closest to. Returns the
/// chosen seed and its fit with the reading applied, or None when no
/// seed produced a grid at all.
pub fn choose_tapped_fit(runs: &[(String, Vec<f64>)], taps: &[f64]) -> Option<(String, Fit)> {
    let mut taps: Vec<f64> = taps.iter().copied().filter(|t| t.is_finite()).collect();
    taps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if taps.len() < 2 {
        return None;
    }
    // Too few taps for a least-squares pulse still have a rate: the mean
    // gap (which is all `tapGrid` averages on the other side).
    let tap_period = tap_pulse(&taps)
        .map(|(p, _)| p)
        .unwrap_or((taps[taps.len() - 1] - taps[0]) / (taps.len() - 1) as f64);
    if !(tap_period.is_finite() && tap_period > 0.0) {
        return None;
    }
    let (_, c) = scan_candidates(runs, &taps, tap_period).best?;
    let beats = &runs.iter().find(|(s, _)| *s == c.seed)?.1;
    Some((c.seed, apply_reading(&fit_beats(beats)?, c.reading)))
}

/// Did this reading correct the fit to reach the taps?
fn corrected(r: &Reading) -> bool {
    (r.factor - 1.0).abs() > 1e-9 || r.half_shift
}

/// Why consistent taps matched nothing.
///
/// Taps that sit ON a grid but run at a whole multiple of it are the
/// commonest case by far — someone counting bars, or every other beat —
/// and saying so is worth more than any score. Anything else is a real
/// disagreement, which is news about the material rather than a mistake.
fn no_match_detail(concentration: f64, ratio: f64, tap_bpm: f64) -> String {
    let every = ratio.round();
    if concentration > TAP_MATCH_MIN && ratio > 1.5 && (ratio - every).abs() < 0.15 * every {
        return format!(
            "those taps landed on the beat but ran one per {every:.0} — Beatify counts beats, \
             not bars, so tap every beat"
        );
    }
    format!(
        "your taps ({tap_bpm:.1} BPM) match none of the readings — the seeds may all be hearing \
         this differently from you; try tapping a steadier stretch, or re-run on a smaller region"
    )
}

fn chose_detail(v: &TapVerdict) -> String {
    let level = if v.reading.factor > 1.0 {
        " ×2"
    } else if v.reading.factor < 1.0 {
        " ÷2"
    } else {
        ""
    };
    let shift = if v.reading.half_shift {
        " · shifted half a beat onto the pulse you tapped"
    } else {
        ""
    };
    let lag = format!(
        " · your taps run {:.0} ms {} (not applied)",
        v.offset_secs.abs() * 1000.0,
        if v.offset_secs >= 0.0 {
            "late"
        } else {
            "early"
        },
    );
    let caveat = if v.offset_secs.abs() > TAP_LAG_IMPLAUSIBLE_SECS {
        " — far enough that the beat you meant is a guess"
    } else {
        ""
    };
    format!(
        "{} taps at {:.1} BPM chose seed {}{}{}{}{}",
        v.taps, v.tap_bpm, v.seed, level, shift, lag, caveat
    )
}

/// Group scattered times into spans, joining anything closer than `gap`.
fn merge_spans(times: &[f64], gap: f64) -> Vec<[f64; 2]> {
    let mut spans: Vec<[f64; 2]> = Vec::new();
    for &t in times {
        match spans.last_mut() {
            Some(last) if t - last[1] <= gap => last[1] = t,
            _ => spans.push([t, t]),
        }
    }
    spans
}

// ---------------------------------------------------------------------------
// Warp strength, anchors and meters (§3.6)
// ---------------------------------------------------------------------------

/// Anchor spacing for a slider position (MOD-12). `None` is the far-left
/// no-warp case (MOD-17): a straight grid through a drifting song.
pub fn anchor_stride(strength: f64) -> Option<usize> {
    let s = strength.clamp(0.0, 1.0);
    if s <= 0.02 {
        return None;
    }
    let exp = (MAX_STRIDE as f64).log2() * (1.0 - s);
    let stride = exp.exp2().round() as usize;
    Some(stride.clamp(MIN_STRIDE, MAX_STRIDE))
}

/// Local least-squares estimate of the detected beat time at index `n` —
/// the smooth tempo curve of ANL-9, evaluated where an anchor is wanted.
fn local_time(beats: &[FittedBeat], n: f64, window: f64) -> Option<f64> {
    let near: Vec<FittedBeat> = beats
        .iter()
        .copied()
        .filter(|b| (b.index - n).abs() <= window)
        .collect();
    if near.len() < 2 {
        // Too sparse for a local fit: fall back to the nearest detection.
        return beats
            .iter()
            .min_by(|a, b| {
                (a.index - n)
                    .abs()
                    .partial_cmp(&(b.index - n).abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|b| b.time);
    }
    let (phase, period) = lsq(&near)?;
    Some(phase + n * period)
}

/// One anchor of the warp: where a beat index really is, and where the
/// constant-tempo grid wants it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Anchor {
    pub index: f64,
    pub src: f64,
    pub dst: f64,
}

/// Place anchors every `stride` beats over `[first, last]` (ANL-9/9a).
/// `dst` is measured in the OUTPUT timeline: `head_pad + (n - first) ×
/// period`.
pub fn anchors(fit: &Fit, first: f64, last: f64, stride: usize, head_pad: f64) -> Vec<Anchor> {
    let stride = stride.max(1) as f64;
    // Half-width of each anchor's local fit. Roughly the anchor spacing:
    // wider averages away the drift the anchors exist to follow, narrower
    // stops averaging away detection noise (ANL-9's 1/√k vs k² tradeoff).
    let window = (stride / 2.0).max(1.5);
    let mut out: Vec<Anchor> = Vec::new();
    let mut n = first;
    loop {
        let at = n.min(last);
        if let Some(src) = local_time(&fit.beats, at, window) {
            out.push(Anchor {
                index: at,
                src,
                dst: head_pad + (at - first) * fit.period,
            });
        }
        if at >= last {
            break;
        }
        n += stride;
    }
    // Keep the map strictly increasing: a non-monotonic anchor pair would
    // ask the renderer to run time backwards.
    out.dedup_by(|b, a| b.src <= a.src);
    out
}

/// What the two competing meters say for a given anchor density (MOD-13).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    pub worst_flam_ms: f64,
    pub peak_stretch_pct: f64,
    pub rms_ms: f64,
    pub in_band_pct: f64,
}

impl Quality {
    pub fn passes(&self) -> bool {
        self.worst_flam_ms < FLAM_GREEN_MS && self.peak_stretch_pct < STRETCH_GREEN_PCT
    }
}

/// Per-beat residual after warping, in the output timeline (the error
/// strip of §3.4, and the input to every meter).
pub fn warped_residuals(fit: &Fit, anchors: &[Anchor], first: f64, head_pad: f64) -> Vec<f64> {
    let map = crate::beatify::warp::WarpMap::from_anchors(anchors);
    fit.beats
        .iter()
        .filter(|b| b.index >= first)
        .map(|b| {
            let target = head_pad + (b.index - first) * fit.period;
            map.map_time(b.time) - target
        })
        .collect()
}

/// Meters for one anchor set — pure arithmetic, milliseconds of maths
/// (MOD-A22).
pub fn quality(fit: &Fit, anchors: &[Anchor], first: f64, head_pad: f64) -> Quality {
    let residuals = warped_residuals(fit, anchors, first, head_pad);
    if residuals.is_empty() {
        return Quality {
            worst_flam_ms: 0.0,
            peak_stretch_pct: 0.0,
            rms_ms: 0.0,
            in_band_pct: 100.0,
        };
    }
    let lo = residuals.iter().cloned().fold(f64::INFINITY, f64::min);
    let hi = residuals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let rms = (residuals.iter().map(|r| r * r).sum::<f64>() / residuals.len() as f64).sqrt();
    let in_band = residuals.iter().filter(|r| r.abs() <= IN_BAND_SECS).count() as f64
        / residuals.len() as f64;
    let mut peak_stretch = 0.0f64;
    for w in anchors.windows(2) {
        let (src, dst) = (w[1].src - w[0].src, w[1].dst - w[0].dst);
        if src > 0.0 {
            peak_stretch = peak_stretch.max((dst / src - 1.0).abs());
        }
    }
    Quality {
        worst_flam_ms: (hi - lo) * 1000.0,
        peak_stretch_pct: peak_stretch * 100.0,
        rms_ms: rms * 1000.0,
        in_band_pct: in_band * 100.0,
    }
}

/// One sample of the load-time sweep (MOD-15).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepPoint {
    pub strength: f64,
    /// Anchor spacing in beats; 0 means "no warp".
    pub stride: usize,
    pub quality: Quality,
}

/// The recommended zone plus the default the slider lands on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sweep {
    pub points: Vec<SweepPoint>,
    /// Shaded zone on the slider track: `[lo, hi]` strengths where both
    /// meters pass. Empty when nothing passes.
    pub zone: Option<[f64; 2]>,
    /// Where the slider starts — the zone's LEFT edge (least intervention
    /// that passes; §6 open question 3).
    pub default_strength: f64,
}

pub const SWEEP_STEPS: usize = 21;

/// Sweep the slider range and find where both meters pass (MOD-15).
pub fn sweep(fit: &Fit, first: f64, last: f64, head_pad: f64) -> Sweep {
    let mut points = Vec::with_capacity(SWEEP_STEPS);
    for i in 0..SWEEP_STEPS {
        let strength = i as f64 / (SWEEP_STEPS - 1) as f64;
        let stride = anchor_stride(strength);
        let q = match stride {
            None => quality(
                fit,
                &no_warp_anchors(fit, first, last, head_pad),
                first,
                head_pad,
            ),
            Some(k) => quality(
                fit,
                &anchors(fit, first, last, k, head_pad),
                first,
                head_pad,
            ),
        };
        points.push(SweepPoint {
            strength,
            stride: stride.unwrap_or(0),
            quality: q,
        });
    }
    let passing: Vec<f64> = points
        .iter()
        .filter(|p| p.quality.passes())
        .map(|p| p.strength)
        .collect();
    let zone = match (passing.first(), passing.last()) {
        (Some(lo), Some(hi)) => Some([*lo, *hi]),
        _ => None,
    };
    // Left edge of the zone (conservative); no zone means push right and
    // let the verdict say the material fought back.
    let default_strength = zone.map(|z| z[0]).unwrap_or(1.0);
    Sweep {
        points,
        zone,
        default_strength,
    }
}

/// The no-warp case (MOD-17): the whole span is one segment mapped by the
/// fitted line, so the audio is untouched apart from the trim.
pub fn no_warp_anchors(fit: &Fit, first: f64, last: f64, head_pad: f64) -> Vec<Anchor> {
    vec![
        Anchor {
            index: first,
            src: fit.line(first),
            dst: head_pad,
        },
        Anchor {
            index: last,
            src: fit.line(last),
            dst: head_pad + (last - first) * fit.period,
        },
    ]
}

/// Anchors for a slider position: `None` stride is the no-warp case.
pub fn anchors_for_strength(
    fit: &Fit,
    first: f64,
    last: f64,
    head_pad: f64,
    strength: f64,
) -> Vec<Anchor> {
    match anchor_stride(strength) {
        None => no_warp_anchors(fit, first, last, head_pad),
        Some(k) => anchors(fit, first, last, k, head_pad),
    }
}

// ---------------------------------------------------------------------------
// Drift spans (§3.3)
// ---------------------------------------------------------------------------

/// A stretch of source audio whose tempo departs from the target (MOD-3):
/// the evidence that warping is doing something.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftSpan {
    /// Source seconds.
    pub start_secs: f64,
    pub end_secs: f64,
    /// Local tempo minus target tempo, BPM (signed: + is pushing).
    pub delta_bpm: f64,
}

/// Tempo departure smaller than this is not worth labelling.
pub const DRIFT_MIN_BPM: f64 = 0.5;
/// Beats per drift measurement window.
pub const DRIFT_WINDOW_BEATS: usize = 8;

/// Measure local tempo in windows and report where it leaves the target.
pub fn drift_spans(fit: &Fit, first: f64, last: f64) -> Vec<DriftSpan> {
    let target_bpm = 60.0 / fit.period;
    let step = DRIFT_WINDOW_BEATS as f64;
    let mut spans: Vec<DriftSpan> = Vec::new();
    let mut n = first;
    while n + step <= last {
        let (a, b) = (n, n + step);
        let (Some(ta), Some(tb)) = (
            local_time(&fit.beats, a, step / 2.0),
            local_time(&fit.beats, b, step / 2.0),
        ) else {
            break;
        };
        let span_secs = tb - ta;
        if span_secs > 0.0 {
            let local_bpm = 60.0 * step / span_secs;
            let delta = local_bpm - target_bpm;
            if delta.abs() >= DRIFT_MIN_BPM {
                match spans.last_mut() {
                    // Merge neighbours that drift the same way.
                    Some(prev)
                        if (prev.end_secs - ta).abs() < 1e-6
                            && prev.delta_bpm.signum() == delta.signum() =>
                    {
                        prev.end_secs = tb;
                        prev.delta_bpm = (prev.delta_bpm + delta) / 2.0;
                    }
                    _ => spans.push(DriftSpan {
                        start_secs: ta,
                        end_secs: tb,
                        delta_bpm: delta,
                    }),
                }
            }
        }
        n += step;
    }
    spans
}

// ---------------------------------------------------------------------------
// Lead-in (§3.7)
// ---------------------------------------------------------------------------

/// Short-window RMS over a mono mix, prepared once so that many beats can
/// be probed cheaply.
///
/// Both users of this — the lead-in measurement (MOD-18) and the cut
/// point inspector (§3.5) — have to agree about where an attack begins,
/// or the inspector would draw the attack somewhere other than where the
/// number says it is. Sharing the scan is what makes that structural.
pub struct OnsetScan<'a> {
    mono: &'a [f32],
    sr: f64,
    win: usize,
    prefix: Vec<f64>,
}

impl<'a> OnsetScan<'a> {
    pub fn new(mono: &'a [f32], sample_rate: u32) -> Option<Self> {
        let sr = sample_rate as f64;
        let win = (0.003 * sr) as usize;
        if win < 4 || mono.len() < 4 * win {
            return None;
        }
        let mut prefix = vec![0.0f64; mono.len() + 1];
        for (i, &s) in mono.iter().enumerate() {
            prefix[i + 1] = prefix[i] + (s as f64) * (s as f64);
        }
        Some(Self {
            mono,
            sr,
            win,
            prefix,
        })
    }

    fn rms(&self, i: usize) -> f64 {
        let a = i.min(self.mono.len() - self.win);
        ((self.prefix[a + self.win] - self.prefix[a]) / self.win as f64).sqrt()
    }

    /// Absolute time of the steepest energy rise within [`ATTACK_RADIUS`]
    /// of `t`, or `None` when nothing in there rises — a held note or a
    /// rest has no attack, and reporting one at the line would be a lie
    /// the inspector then draws.
    pub fn attack_near(&self, t: f64) -> Option<f64> {
        let radius = (ATTACK_RADIUS * self.sr) as usize;
        let center = (t * self.sr) as usize;
        if center <= radius || center + radius + self.win >= self.mono.len() {
            return None;
        }
        let step = (self.win / 2).max(1);
        let mut best = (f64::NEG_INFINITY, center);
        let mut i = center - radius;
        while i + step <= center + radius {
            let d = self.rms(i + step) - self.rms(i);
            if d > best.0 {
                best = (d, i + step);
            }
            i += step;
        }
        (best.0 > 0.0).then(|| best.1 as f64 / self.sr)
    }
}

/// Measure the lead-in (MOD-18): the median offset between the grid line
/// and the actual transient onset, plus a small safety pad. One global
/// value, because uniformity is what keeps cuts sync-safe (MOD-19).
///
/// The measurement is bounded by [`ATTACK_RADIUS`], not by
/// [`LEAD_IN_MAX`]: what a track's attacks do is a fact about the audio,
/// while the maximum is only how far the user may then push it.
pub fn measure_lead_in(mono: &[f32], sample_rate: u32, beats: &[f64]) -> f64 {
    let Some(scan) = OnsetScan::new(mono, sample_rate) else {
        return LEAD_IN_PAD;
    };
    let mut offsets: Vec<f64> = beats
        .iter()
        .filter_map(|&t| scan.attack_near(t).map(|a| a - t))
        .collect();
    if offsets.len() < 4 {
        return LEAD_IN_PAD;
    }
    offsets.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = offsets[offsets.len() / 2];
    (median.abs() + LEAD_IN_PAD).clamp(0.0, LEAD_IN_MAX)
}

/// Per-beat confidence (0..=1) from the shared onset envelope.
///
/// ANL-4 asks for `Audio2Frames` activations; those only exist when
/// `beat_this` is installed, and the only consumer is the density band at
/// the closest zoom levels (TV-5). Deriving confidence from the onset
/// envelope instead gives the same shaped signal for BOTH trackers, so the
/// UI never has to care which one ran.
pub fn beat_confidence(mono: &[f32], sample_rate: u32, beats: &[f64]) -> Vec<f32> {
    let env = crate::tempo::onset_envelope(mono, sample_rate);
    if env.flux.is_empty() {
        return vec![0.0; beats.len()];
    }
    let peak = env.flux.iter().cloned().fold(0.0f32, f32::max).max(1e-9);
    beats
        .iter()
        .map(|&t| {
            let frame = env.secs_frame(t).round();
            if frame < 0.0 || frame >= env.flux.len() as f64 {
                return 0.0;
            }
            (env.flux[frame as usize] / peak).clamp(0.0, 1.0)
        })
        .collect()
}
