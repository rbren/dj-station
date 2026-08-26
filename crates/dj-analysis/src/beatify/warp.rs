//! Time warping: pull the detected beats onto the grid (PRD §2.3).
//!
//! [`WarpMap`] is the anchor list as a piecewise-linear source↔output
//! mapping; [`render`] resamples the audio through it.
//!
//! **Stretch engine.** The PRD names Rubber Band (R3). That is a C++
//! library and a build-time dependency the workspace does not carry, so
//! the shipped engine is a WSOLA (waveform-similarity overlap-add) stretch
//! implemented here: pitch-preserving by construction (ANL-11 — nothing is
//! ever resampled), deterministic, and therefore golden-testable offline.
//! Corrections are ~1–2 % (ANL-10), where WSOLA is transparent. Swapping
//! in Rubber Band later means implementing one function; the seam is
//! [`render`], the same shape as the DSP-vs-ONNX stem separator split.
//!
//! Identity maps (the no-warp slider position, MOD-17) short-circuit to a
//! sample-exact copy: no overlap-add runs when nothing is being bent.

use crate::beatify::grid::Anchor;
use crate::decode::AudioData;

/// Analysis/synthesis window and search radius, in seconds. 46 ms is long
/// enough to keep bass intact and short enough that a transient lands in
/// one window.
const WIN_SECS: f64 = 0.046;
const SEARCH_SECS: f64 = 0.010;
/// Coarse correlation step (samples) before a fine ±3 refinement.
const COARSE: usize = 4;
/// Below this, a segment ratio counts as "not stretched at all".
const IDENTITY_EPS: f64 = 1e-6;

/// Piecewise-linear map between source seconds and output seconds. Points
/// are strictly increasing in both axes; outside them the end segments'
/// slopes extrapolate, which is what gives the beat of head/tail padding
/// (MOD-A14) real audio to sit in.
#[derive(Debug, Clone, PartialEq)]
pub struct WarpMap {
    pub points: Vec<(f64, f64)>,
}

impl WarpMap {
    pub fn from_anchors(anchors: &[Anchor]) -> Self {
        WarpMap {
            points: anchors.iter().map(|a| (a.src, a.dst)).collect(),
        }
    }

    /// A pure time shift: source `offset` becomes output 0.
    pub fn shift(offset: f64) -> Self {
        WarpMap {
            points: vec![(offset, 0.0), (offset + 1.0, 1.0)],
        }
    }

    pub fn pairs(&self) -> Vec<[f64; 2]> {
        self.points.iter().map(|(s, d)| [*s, *d]).collect()
    }

    /// Is every segment unstretched (a plain trim)?
    pub fn is_identity(&self) -> bool {
        self.points.windows(2).all(|w| {
            let (src, dst) = (w[1].0 - w[0].0, w[1].1 - w[0].1);
            src > 0.0 && (dst / src - 1.0).abs() < IDENTITY_EPS
        })
    }

    pub fn map_time(&self, src: f64) -> f64 {
        interp(&self.points, src, |p| p.0, |p| p.1)
    }

    pub fn source_time(&self, dst: f64) -> f64 {
        interp(&self.points, dst, |p| p.1, |p| p.0)
    }

    /// Local source-seconds per output-second at an output time.
    pub fn rate_at(&self, dst: f64) -> f64 {
        let pts = &self.points;
        if pts.len() < 2 {
            return 1.0;
        }
        let i = segment(pts, dst, |p| p.1);
        let (a, b) = (pts[i], pts[i + 1]);
        let span = b.1 - a.1;
        if span <= 0.0 {
            1.0
        } else {
            (b.0 - a.0) / span
        }
    }
}

/// Index of the segment containing `x` (clamped to the ends).
fn segment(points: &[(f64, f64)], x: f64, key: fn(&(f64, f64)) -> f64) -> usize {
    let last = points.len() - 2;
    for i in 0..=last {
        if x < key(&points[i + 1]) {
            return i;
        }
    }
    last
}

fn interp(
    points: &[(f64, f64)],
    x: f64,
    key: fn(&(f64, f64)) -> f64,
    val: fn(&(f64, f64)) -> f64,
) -> f64 {
    match points.len() {
        0 => x,
        1 => x - key(&points[0]) + val(&points[0]),
        _ => {
            let i = segment(points, x, key);
            let (a, b) = (points[i], points[i + 1]);
            let span = key(&b) - key(&a);
            if span <= 0.0 {
                val(&a)
            } else {
                val(&a) + (val(&b) - val(&a)) * (x - key(&a)) / span
            }
        }
    }
}

/// Render `out_secs` of output audio by pulling `audio` through `map`.
///
/// Source positions outside the file read as silence, so the one beat of
/// padding at each end always exists even at the very start of a file
/// (MOD-A14).
pub fn render(audio: &AudioData, map: &WarpMap, out_secs: f64) -> AudioData {
    let sr = audio.sample_rate as f64;
    let out_len = ((out_secs.max(0.0)) * sr).round() as usize;
    let n_ch = audio.channels.len().max(1);
    if out_len == 0 || audio.frames() == 0 {
        return AudioData {
            channels: vec![Vec::new(); n_ch],
            sample_rate: audio.sample_rate,
        };
    }
    if map.is_identity() {
        return copy_shifted(audio, map, out_len);
    }
    wsola(audio, map, out_len)
}

/// Unstretched path: the output is the source, shifted (and zero-padded
/// where the source does not reach).
fn copy_shifted(audio: &AudioData, map: &WarpMap, out_len: usize) -> AudioData {
    let sr = audio.sample_rate as f64;
    let offset = (map.source_time(0.0) * sr).round() as i64;
    let frames = audio.frames() as i64;
    let channels = audio
        .channels
        .iter()
        .map(|c| {
            (0..out_len as i64)
                .map(|i| {
                    let j = i + offset;
                    if j >= 0 && j < frames {
                        c[j as usize]
                    } else {
                        0.0
                    }
                })
                .collect()
        })
        .collect();
    AudioData {
        channels,
        sample_rate: audio.sample_rate,
    }
}

/// WSOLA: for every output window, take the source window the map asks
/// for, slide it within a small search radius to whichever position
/// correlates best with what has already been written, and overlap-add it
/// under a Hann window (hop = win/2 is COLA, so unity gain).
fn wsola(audio: &AudioData, map: &WarpMap, out_len: usize) -> AudioData {
    let sr = audio.sample_rate as f64;
    let win = (((WIN_SECS * sr) as usize) | 1) + 1; // even
    let hop = win / 2;
    let search = (SEARCH_SECS * sr) as usize;
    let n_ch = audio.channels.len().max(1);
    let mono = audio.mono_mix();
    let window: Vec<f32> = (0..win)
        .map(|i| {
            let x = std::f64::consts::PI * i as f64 / win as f64;
            (x.sin() * x.sin()) as f32
        })
        .collect();

    // The first window is written one hop BEFORE output zero, so the
    // overlap-add has already reached unity gain by the time the kept part
    // of the buffer starts — otherwise every render (and every audition
    // window, MOD-A23) would open with a half-window fade.
    let lead = hop;
    let mut out: Vec<Vec<f32>> = vec![vec![0.0f32; out_len + win + lead]; n_ch];
    let mut out_mono = vec![0.0f32; out_len + win + lead];

    let mut pos = 0usize;
    while pos < out_len + lead {
        let want = map.source_time((pos as f64 - lead as f64) / sr) * sr;
        let ideal = want.round() as i64;
        let offset = if pos == 0 {
            0
        } else {
            best_offset(&mono, &out_mono, ideal, pos, hop, search)
        };
        let start = ideal + offset;
        for (ch, buf) in out.iter_mut().enumerate() {
            let src = &audio.channels[ch.min(audio.channels.len() - 1)];
            add_window(buf, pos, src, start, &window);
        }
        add_window(&mut out_mono, pos, &mono, start, &window);
        pos += hop;
    }

    for buf in out.iter_mut() {
        buf.drain(..lead);
        buf.truncate(out_len);
    }
    AudioData {
        channels: out,
        sample_rate: audio.sample_rate,
    }
}

fn add_window(dst: &mut [f32], at: usize, src: &[f32], start: i64, window: &[f32]) {
    for (i, w) in window.iter().enumerate() {
        let j = start + i as i64;
        if j < 0 || j as usize >= src.len() {
            continue;
        }
        dst[at + i] += src[j as usize] * w;
    }
}

/// How strongly a candidate offset is penalized for straying from where
/// the map asked for it, in cosine-similarity units at the full search
/// radius. Quasi-periodic material (a click track, a kick pattern)
/// correlates almost as well one period away, and taking that alignment
/// would move the transient off its grid line — the one thing Beatify
/// exists to prevent. Tuned on the drifting-click test: the measured beat
/// spread in the rendered audio falls from 10.6 ms (penalty 1) to 5.0 ms
/// (penalty 8) with no measurable loss of tonal energy at the ~1–3 %
/// ratios this renderer ever sees.
const OFFSET_PENALTY: f64 = 8.0;

/// Search offset (samples) whose source segment best matches the tail the
/// previous window already wrote — the "waveform similarity" of WSOLA.
fn best_offset(
    mono: &[f32],
    out_mono: &[f32],
    ideal: i64,
    pos: usize,
    overlap: usize,
    search: usize,
) -> i64 {
    let target = &out_mono[pos..pos + overlap];
    let target_norm = target
        .iter()
        .map(|t| (*t as f64) * (*t as f64))
        .sum::<f64>()
        .sqrt();
    let score = |off: i64| -> f64 {
        let similarity = correlate(mono, target, ideal + off) / (target_norm + 1e-9);
        let strayed = off as f64 / search.max(1) as f64;
        similarity - OFFSET_PENALTY * strayed * strayed
    };
    let mut best = 0i64;
    let mut best_score = f64::NEG_INFINITY;
    let mut coarse = -(search as i64);
    while coarse <= search as i64 {
        let s = score(coarse);
        if s > best_score {
            best_score = s;
            best = coarse;
        }
        coarse += COARSE as i64;
    }
    for fine in (best - COARSE as i64 + 1)..(best + COARSE as i64) {
        let s = score(fine);
        if s > best_score {
            best_score = s;
            best = fine;
        }
    }
    best
}

/// Cross-correlation of `target` against the source at `start`, normalized
/// by the source segment's energy.
fn correlate(src: &[f32], target: &[f32], start: i64) -> f64 {
    let mut dot = 0.0f64;
    let mut energy = 0.0f64;
    for (i, t) in target.iter().enumerate() {
        let j = start + i as i64;
        let s = if j >= 0 && (j as usize) < src.len() {
            src[j as usize] as f64
        } else {
            0.0
        };
        dot += s * *t as f64;
        energy += s * s;
    }
    dot / (energy.sqrt() + 1e-9)
}
