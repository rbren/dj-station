//! The cut point inspector (PRD §3.5) — a high-zoom look at where a cut
//! actually lands relative to the attack it is supposed to clear.
//!
//! Beats sampled across the whole song are drawn on top of each other in
//! persistence style (MOD-8). Two things become visible that no number
//! conveys: whether the warp has pulled the attacks into one line (MOD-9,
//! the traces converge as strength rises), and whether the lead-in starts
//! the cut BEFORE the attack begins (MOD-10/11) — which is the only way
//! to see that a millisecond figure is doing its job.
//!
//! Traces are taken from the SOURCE audio at the position the warp maps
//! each grid line back to. No render is involved (MOD-A22): the window is
//! a hundred milliseconds wide, over which the stretch rate is constant
//! to within a fraction of a sample, so the source neighbourhood IS what
//! the warped beat will look like.

use crate::beatify::grid::OnsetScan;
use crate::beatify::Analysis;
use crate::decode::AudioData;

/// The window drawn around the grid line (MOD-8), seconds. `SCOPE_PRE`
/// is where the caller starts; it may ask for more when the cut reaches
/// back further than the window shows, up to `SCOPE_PRE_MAX`.
pub const SCOPE_PRE: f64 = 0.040;
pub const SCOPE_PRE_MAX: f64 = 0.400;
pub const SCOPE_POST: f64 = 0.070;
/// How many beats are sampled across the song (MOD-8).
pub const SCOPE_TRACES: usize = 12;

/// One beat's worth of the inspector.
#[derive(Debug, Clone, PartialEq)]
pub struct Trace {
    /// Which beat of the output grid this is.
    pub beat: usize,
    /// Peak-reduced samples across the window, `points` of them, −1..=1.
    /// Two values per point (min, max) would draw a filled envelope; the
    /// inspector wants a LINE per trace, so this is the signed peak.
    pub samples: Vec<f32>,
    /// Where the attack begins, seconds relative to the grid line, or
    /// `None` where nothing rises inside the window (a held note, a
    /// rest). Negative means the transient starts before the line, which
    /// is the usual case and the whole reason a lead-in exists.
    pub attack: Option<f64>,
}

/// What the inspector draws, plus the three numbers under it (MOD-11).
#[derive(Debug, Clone, PartialEq)]
pub struct Scope {
    pub pre_secs: f64,
    pub post_secs: f64,
    pub traces: Vec<Trace>,
    /// Median attack lead: how far before the grid line the attacks
    /// begin, seconds. Positive means "starts early", which is what a
    /// cut has to reach back over.
    pub attack_lead: f64,
    /// Horizontal smear across the traces, seconds — the flam number in
    /// the units the user is looking at.
    pub spread: f64,
}

impl Scope {
    /// How much room a lead-in leaves in front of the attack (MOD-11).
    /// Negative means the cut lands INSIDE the attack and will chop it.
    pub fn clearance(&self, lead_in: f64) -> f64 {
        lead_in - self.attack_lead
    }
}

/// Sample `SCOPE_TRACES` beats across the grid and read the source audio
/// around each one, as the warp at `strength` places it.
pub fn scope(
    audio: &AudioData,
    analysis: &Analysis,
    strength: f64,
    points: usize,
    pre_secs: f64,
) -> Scope {
    let points = points.clamp(2, 4096);
    let pre = pre_secs.clamp(SCOPE_PRE, SCOPE_PRE_MAX);
    let map = analysis.map_at(strength);
    let mono = audio.mono_mix();
    let sr = audio.sample_rate as f64;
    let grid = analysis.grid;

    let scan = OnsetScan::new(&mono, audio.sample_rate);
    let mut traces = Vec::new();
    for beat in sampled_beats(grid.beats) {
        let line = map.source_time(grid.beat_time(beat as f64));
        let start = line - pre;
        let end = line + SCOPE_POST;
        if start < 0.0 || end * sr >= mono.len() as f64 {
            continue;
        }
        // The attack is found by the same scan the lead-in was measured
        // with, so the band drawn under the traces and the number beside
        // the slider cannot disagree.
        let attack = scan.as_ref().and_then(|s| s.attack_near(line));
        traces.push(Trace {
            beat,
            samples: reduce(&mono, sr, start, end, points),
            attack: attack.map(|t| t - line),
        });
    }

    let mut offsets: Vec<f64> = traces.iter().filter_map(|t| t.attack).collect();
    offsets.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let attack_lead = match offsets.len() {
        0 => 0.0,
        n => -offsets[n / 2],
    };
    let spread = match (offsets.first(), offsets.last()) {
        (Some(lo), Some(hi)) => hi - lo,
        _ => 0.0,
    };
    Scope {
        pre_secs: pre,
        post_secs: SCOPE_POST,
        traces,
        attack_lead,
        spread,
    }
}

/// Beats spread evenly across the track — the point of the inspector is
/// that it compares the START of the song with the END (MOD-8), which a
/// window onto one beat cannot do.
fn sampled_beats(beats: usize) -> Vec<usize> {
    if beats == 0 {
        return Vec::new();
    }
    let want = SCOPE_TRACES.min(beats);
    (0..want)
        .map(|i| {
            if want == 1 {
                0
            } else {
                (i * (beats - 1)) / (want - 1)
            }
        })
        .collect()
}

/// Peak-reduce `start..end` into `points` values, keeping the sample of
/// largest magnitude in each bucket so a transient survives the squeeze.
fn reduce(mono: &[f32], sr: f64, start: f64, end: f64, points: usize) -> Vec<f32> {
    let first = (start * sr).max(0.0) as usize;
    let last = ((end * sr) as usize).min(mono.len());
    let span = last.saturating_sub(first);
    if span == 0 {
        return vec![0.0; points];
    }
    (0..points)
        .map(|i| {
            let a = first + (i * span) / points;
            let b = (first + ((i + 1) * span) / points).max(a + 1).min(last);
            mono[a..b]
                .iter()
                .copied()
                .fold(0.0f32, |acc, s| if s.abs() > acc.abs() { s } else { acc })
        })
        .collect()
}
