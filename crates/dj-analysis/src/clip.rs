//! Offline clip editing (the app's Clip page, PRD §9): assemble a new
//! track out of spans of existing library tracks.
//!
//! A [`ClipProgram`] is a pure, serializable description of an edit —
//! nothing here touches the RT thread, the engine, or the library DB. The
//! renderer is deterministic (same inputs, byte-identical output), which
//! is what the golden-audio case in `tests/clip_edit.rs` pins.
//!
//! Signal flow, in order:
//!
//! 1. **Assemble** ([`ClipRegion`]): each region names a span of one
//!    source, optionally reversed, with a static trim gain. Cutting a
//!    piece out is "two regions that skip it"; splicing is "regions from
//!    different sources in a row". Neighbouring regions are joined with a
//!    short equal-power crossfade so edits never click.
//! 2. **EQ** ([`ClipEq`]): parametric peaking bells in series — the same
//!    RBJ filters as the rack's EQ module — bypassed exactly at 0 dB.
//! 3. **Level automation** ([`LevelPoint`]): a breakpoint envelope in dB
//!    over the *output* timeline — fades in/out are just endpoints.
//! 4. **Beat warp** (`warp`): anchor pairs `[from, to]` on the output
//!    timeline, applied last through the Beatify WSOLA stretch
//!    ([`crate::beatify::warp`]) — how tapped beats become an even grid.
//!    Outside the anchors the audio is untouched (identity slope).
//!    `warp_smoothing` eases the stretch WITHIN each anchor pair
//!    ([`smooth_warp`]) so the rate does not step at the anchors.
//!
//! Sources may differ in sample rate and channel count: the render runs at
//! the first source's rate with the widest channel count, resampling other
//! sources linearly and duplicating mono into every output channel.

use anyhow::{anyhow, ensure, Result};
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;
use std::path::Path;

use crate::beatify::{self, detect::BeatTracker, grid as beat_fit};
use crate::decode::AudioData;

/// Default equal-power join between adjacent regions (declick).
pub const DEFAULT_CROSSFADE_MS: f64 = 5.0;

/// Level automation floor: points at or below this are silence.
pub const SILENCE_DB: f64 = -60.0;

/// A span of one source in the assembled clip.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ClipRegion {
    /// Index into the sources passed to [`render_clip`].
    pub source: usize,
    pub start_secs: f64,
    pub end_secs: f64,
    /// Play this span backwards.
    pub reverse: bool,
    /// Static trim for this span, in dB.
    pub gain_db: f64,
}

impl ClipRegion {
    pub fn duration_secs(&self) -> f64 {
        (self.end_secs - self.start_secs).max(0.0)
    }
}

/// One parametric EQ band: an RBJ peaking bell, exact pass-through at
/// 0 dB. Same filter (and clamps) as the rack's 4-band EQ module.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ClipEqBand {
    pub freq_hz: f64,
    pub gain_db: f64,
    pub q: f64,
}

impl Default for ClipEqBand {
    fn default() -> Self {
        ClipEqBand {
            freq_hz: 1000.0,
            gain_db: 0.0,
            q: 1.0,
        }
    }
}

impl ClipEqBand {
    pub const MIN_HZ: f64 = 20.0;
    pub const MIN_Q: f64 = 0.2;
    pub const MAX_Q: f64 = 12.0;
}

/// Parametric tone control: peaking bells in series (the Clip page uses
/// four, mirroring the EQ module's UI, but any count renders).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ClipEq {
    pub bands: Vec<ClipEqBand>,
}

impl ClipEq {
    pub fn is_flat(&self) -> bool {
        self.bands.iter().all(|b| b.gain_db == 0.0)
    }
}

/// One breakpoint of the output-timeline level envelope.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LevelPoint {
    pub time_secs: f64,
    pub gain_db: f64,
}

/// A complete, serializable clip edit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ClipProgram {
    pub regions: Vec<ClipRegion>,
    pub eq: ClipEq,
    /// Level automation breakpoints (unsorted input is fine). Empty means
    /// unity gain throughout.
    pub level: Vec<LevelPoint>,
    /// Equal-power crossfade at region joins, in milliseconds.
    pub crossfade_ms: f64,
    /// Beat-tap time warp: `[from, to]` anchor pairs on the OUTPUT
    /// timeline, strictly increasing in both axes, identity outside the
    /// anchored span. Empty means no stretch at all (every clip saved
    /// before taps existed).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warp: Vec<[f64; 2]>,
    /// How much the stretch is EASED inside each anchor pair, 0..=1 (see
    /// [`smooth_warp`]). 0 is a rectangular rate per section — the rate
    /// steps at every anchor, which is what clicks; 1 stretches only in
    /// the middle of a section and not at all at its edges. The anchors
    /// themselves never move.
    #[serde(default)]
    pub warp_smoothing: f64,
    /// The beat grid the taps built, carried with the edit (the renderer
    /// never reads it — the frontend quantizes selections against it and
    /// undo has to move it with the warp it belongs to).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beat_grid: Option<BeatGrid>,
}

/// A tapped-out beat grid on the output timeline. `period`/`phase` are
/// the IDEAL grid the taps averaged to; `times` are where the beats
/// actually sound — inside a stretch-correction section the beats keep
/// their tapped feel (flam) instead of being warped onto the ideal grid,
/// and the grid covers only the tapped (plus explicitly extended) span.
/// Mirrors the frontend's `ClipGrid`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BeatGrid {
    pub bpm: f64,
    pub period: f64,
    pub phase: f64,
    pub beats: usize,
    pub times: Vec<f64>,
    /// Indices into `times` of beats marked as a "one" (the downbeat),
    /// tapped with left shift. Empty — and absent on disk — for every
    /// grid whose taps marked none, which is a normal state: a beat clip
    /// need not know where its one is.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ones: Vec<usize>,
}

impl Default for BeatGrid {
    fn default() -> Self {
        BeatGrid {
            bpm: 0.0,
            period: 0.0,
            phase: 0.0,
            beats: 0,
            times: Vec::new(),
            ones: Vec::new(),
        }
    }
}

impl Default for ClipProgram {
    fn default() -> Self {
        ClipProgram {
            regions: Vec::new(),
            eq: ClipEq::default(),
            level: Vec::new(),
            crossfade_ms: DEFAULT_CROSSFADE_MS,
            warp: Vec::new(),
            warp_smoothing: 0.0,
            beat_grid: None,
        }
    }
}

fn db_to_gain(db: f64) -> f64 {
    if db <= SILENCE_DB {
        0.0
    } else {
        10f64.powf(db / 20.0)
    }
}

/// Pull one region's material out of its source, resampled to `sr` and
/// widened to `n_ch` channels, reversed and trimmed as configured.
fn region_material(src: &AudioData, region: &ClipRegion, sr: u32, n_ch: usize) -> Vec<Vec<f32>> {
    let src_frames = src.frames();
    let src_sr = src.sample_rate as f64;
    let first = (region.start_secs.max(0.0) * src_sr).round() as usize;
    let last = (region.end_secs.max(0.0) * src_sr).round() as usize;
    let first = first.min(src_frames);
    let last = last.min(src_frames);
    if last <= first {
        return vec![Vec::new(); n_ch];
    }
    let span = last - first;
    let ratio = src_sr / sr as f64;
    let out_len = if src.sample_rate == sr {
        span
    } else {
        ((span as f64 / ratio).round() as usize).max(1)
    };
    let gain = db_to_gain(region.gain_db) as f32;
    let src_ch = src.channels.len();

    (0..n_ch)
        .map(|c| {
            let chan = &src.channels[c.min(src_ch.saturating_sub(1))];
            (0..out_len)
                .map(|i| {
                    let j = if region.reverse { out_len - 1 - i } else { i };
                    let x = if src.sample_rate == sr {
                        chan[first + j]
                    } else {
                        // Linear interpolation; the tested path (library
                        // tracks share a rate) is the exact one above.
                        let pos = j as f64 * ratio;
                        let k = pos.floor() as usize;
                        let frac = (pos - k as f64) as f32;
                        let a = chan[(first + k).min(last - 1)];
                        let b = chan[(first + k + 1).min(last - 1)];
                        a + (b - a) * frac
                    };
                    x * gain
                })
                .collect()
        })
        .collect()
}

/// Splice region material together with equal-power crossfades.
fn splice(pieces: Vec<Vec<Vec<f32>>>, n_ch: usize, crossfade_frames: usize) -> Vec<Vec<f32>> {
    let mut out: Vec<Vec<f32>> = vec![Vec::new(); n_ch];
    for piece in pieces {
        let piece_len = piece.first().map(|c| c.len()).unwrap_or(0);
        if piece_len == 0 {
            continue;
        }
        let have = out[0].len();
        let xf = crossfade_frames.min(have / 2).min(piece_len / 2);
        if xf > 0 {
            let base = have - xf;
            for k in 0..xf {
                let t = (k as f64 + 0.5) / xf as f64;
                let fade_out = (t * PI / 2.0).cos() as f32;
                let fade_in = (t * PI / 2.0).sin() as f32;
                for c in 0..n_ch {
                    out[c][base + k] = out[c][base + k] * fade_out + piece[c][k] * fade_in;
                }
            }
        }
        for c in 0..n_ch {
            out[c].extend_from_slice(&piece[c][xf..]);
        }
    }
    out
}

/// Direct Form II transposed biquad, f64 state (offline: accuracy over
/// speed, and determinism across platforms).
#[derive(Debug, Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    fn new(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Biquad {
        Biquad {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    /// RBJ peaking bell.
    fn peaking(freq: f64, gain_db: f64, q: f64, sr: f64) -> Biquad {
        let a = 10f64.powf(gain_db / 40.0);
        let w0 = 2.0 * PI * freq / sr;
        let alpha = w0.sin() / (2.0 * q);
        Biquad::new(
            1.0 + alpha * a,
            -2.0 * w0.cos(),
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * w0.cos(),
            1.0 - alpha / a,
        )
    }

    fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

fn apply_eq(channels: &mut [Vec<f32>], eq: &ClipEq, sr: u32) {
    if eq.is_flat() {
        return;
    }
    let sr = sr as f64;
    for chan in channels.iter_mut() {
        // Series peaking bells, clamped like the EQ module's DSP so the
        // plotted response is what actually renders.
        let mut bands: Vec<Biquad> = eq
            .bands
            .iter()
            .filter(|b| b.gain_db != 0.0)
            .map(|b| {
                Biquad::peaking(
                    b.freq_hz.clamp(ClipEqBand::MIN_HZ, 0.45 * sr),
                    b.gain_db,
                    b.q.clamp(ClipEqBand::MIN_Q, ClipEqBand::MAX_Q),
                    sr,
                )
            })
            .collect();
        for s in chan.iter_mut() {
            let mut x = *s as f64;
            for b in bands.iter_mut() {
                x = b.process(x);
            }
            *s = x as f32;
        }
    }
}

/// Envelope value (dB) at `t`, holding the first/last point outside the
/// breakpoint range. `points` must be sorted by time.
fn level_db_at(points: &[LevelPoint], t: f64) -> f64 {
    match points {
        [] => 0.0,
        [only] => only.gain_db,
        _ => {
            if t <= points[0].time_secs {
                return points[0].gain_db;
            }
            let last = points[points.len() - 1];
            if t >= last.time_secs {
                return last.gain_db;
            }
            let i = points.partition_point(|p| p.time_secs <= t).max(1);
            let (a, b) = (points[i - 1], points[i]);
            let span = b.time_secs - a.time_secs;
            if span <= 0.0 {
                return b.gain_db;
            }
            let frac = (t - a.time_secs) / span;
            a.gain_db + (b.gain_db - a.gain_db) * frac
        }
    }
}

fn apply_level(channels: &mut [Vec<f32>], level: &[LevelPoint], sr: u32) {
    if level.is_empty() {
        return;
    }
    let mut points = level.to_vec();
    points.sort_by(|a, b| a.time_secs.partial_cmp(&b.time_secs).unwrap());
    let frames = channels.first().map(|c| c.len()).unwrap_or(0);
    for i in 0..frames {
        let g = db_to_gain(level_db_at(&points, i as f64 / sr as f64)) as f32;
        for chan in channels.iter_mut() {
            chan[i] *= g;
        }
    }
}

/// Render a clip program against its decoded sources.
///
/// `sources[i]` backs every region whose `source` is `i`. Offline and
/// deterministic; runs on a worker thread, never the RT thread.
pub fn render_clip(sources: &[&AudioData], program: &ClipProgram) -> Result<AudioData> {
    ensure!(!sources.is_empty(), "clip render: no sources");
    ensure!(!program.regions.is_empty(), "clip render: no regions");
    let sample_rate = sources[0].sample_rate;
    ensure!(sample_rate > 0, "clip render: source has no sample rate");
    let n_ch = sources
        .iter()
        .map(|s| s.channels.len())
        .max()
        .unwrap_or(1)
        .max(1);

    let mut pieces = Vec::with_capacity(program.regions.len());
    for region in &program.regions {
        let src = sources
            .get(region.source)
            .ok_or_else(|| anyhow::anyhow!("clip render: unknown source {}", region.source))?;
        ensure!(
            !src.channels.is_empty() && src.frames() > 0,
            "clip render: source {} is empty",
            region.source
        );
        pieces.push(region_material(src, region, sample_rate, n_ch));
    }

    let crossfade_frames = ((program.crossfade_ms.max(0.0) / 1000.0) * sample_rate as f64) as usize;
    let mut channels = splice(pieces, n_ch, crossfade_frames);
    ensure!(
        !channels[0].is_empty(),
        "clip render: the edit is empty (all regions are zero-length)"
    );
    apply_eq(&mut channels, &program.eq, sample_rate);
    apply_level(&mut channels, &program.level, sample_rate);
    apply_warp(
        AudioData {
            channels,
            sample_rate,
        },
        &program.warp,
        program.warp_smoothing,
    )
}

/// Sub-segments an eased section is approximated with. The map stays
/// piecewise linear (that is all the WSOLA renderer reads), so the ease
/// is a staircase — fine enough that its steps are far below the one it
/// replaces.
const SMOOTH_STEPS: usize = 12;

/// A section whose eased rate would dip this far below a standstill is
/// stretching absurdly (taps half a section apart); its ease is capped
/// rather than letting the map run backwards.
const MIN_EASED_RATE: f64 = 0.1;

/// Ease the stretch inside every anchor pair, `smoothing` in 0..=1.
///
/// A section's rate is constant otherwise, so it STEPS at each anchor —
/// the audible click the Clip page's smoothing control exists to soften.
/// Here the rate follows a raised cosine over the section instead:
/// `rate(u) = 1 + e·((1−s) + s·(1 − cos 2πu))` where `e = ratio − 1`.
/// Its mean over the section is `ratio` whatever `s` is, so the anchors
/// land EXACTLY where they did (the section's duration is preserved to
/// the last sample); at `s = 1` the edges are unstretched and all of the
/// correction happens mid-section, which makes the rate continuous
/// across the anchor. `s = 0` returns the anchors untouched.
///
/// TS twin: `smoothWarp` in `app/src/clip.ts`.
pub fn smooth_warp(warp: &[[f64; 2]], smoothing: f64) -> Vec<[f64; 2]> {
    let smoothing = smoothing.clamp(0.0, 1.0);
    if smoothing <= 0.0 || warp.len() < 2 {
        return warp.to_vec();
    }
    let mut out: Vec<[f64; 2]> = Vec::with_capacity(warp.len() * SMOOTH_STEPS);
    out.push(warp[0]);
    for w in warp.windows(2) {
        let (lx, ly) = (w[1][0] - w[0][0], w[1][1] - w[0][1]);
        let e = if lx > 0.0 { ly / lx - 1.0 } else { 0.0 };
        if lx > 1e-6 && ly > 1e-6 && e != 0.0 {
            let s = if e < 0.0 {
                smoothing.min(((1.0 - MIN_EASED_RATE) / -e - 1.0).max(0.0))
            } else {
                smoothing
            };
            for k in 1..SMOOTH_STEPS {
                let u = k as f64 / SMOOTH_STEPS as f64;
                let x = w[0][0] + lx * u;
                let y = w[0][1] + lx * (u + e * (u - s * (2.0 * PI * u).sin() / (2.0 * PI)));
                let prev = out[out.len() - 1];
                if x > prev[0] && y > prev[1] {
                    out.push([x, y]);
                }
            }
        }
        out.push(w[1]);
    }
    out
}

/// The warp anchors as a [`WarpMap`]: eased inside each section by
/// `smoothing`, then guarded on both sides with slope-1 points so
/// everything outside the tapped span stays exactly where it is (the map
/// extrapolates its END SEGMENTS' slopes otherwise).
fn warp_map(warp: &[[f64; 2]], smoothing: f64) -> Result<Option<crate::beatify::WarpMap>> {
    if warp.len() < 2 {
        ensure!(warp.is_empty(), "clip render: a warp needs two anchors");
        return Ok(None);
    }
    for w in warp.windows(2) {
        ensure!(
            w[1][0] > w[0][0] && w[1][1] > w[0][1],
            "clip render: warp anchors must increase in both axes"
        );
    }
    let eased = smooth_warp(warp, smoothing);
    let (first, last) = (eased[0], eased[eased.len() - 1]);
    let mut points = Vec::with_capacity(eased.len() + 2);
    points.push((first[0] - 1.0, first[1] - 1.0));
    points.extend(eased.iter().map(|p| (p[0], p[1])));
    points.push((last[0] + 1.0, last[1] + 1.0));
    Ok(Some(crate::beatify::WarpMap { points }))
}

/// Stretch the rendered output through the tap warp. A missing or
/// identity map is a sample-exact pass-through.
fn apply_warp(audio: AudioData, warp: &[[f64; 2]], smoothing: f64) -> Result<AudioData> {
    let Some(map) = warp_map(warp, smoothing)? else {
        return Ok(audio);
    };
    if map.is_identity() {
        return Ok(audio);
    }
    let out_secs = map.map_time(audio.duration_secs());
    Ok(crate::beatify::warp::render(&audio, &map, out_secs))
}

/// Where the warp puts an output time. Identity for the empty (or
/// malformed) warp, so plain programs cost nothing. TS twin: `warpTime`
/// in `app/src/clip.ts`.
pub fn warp_time_secs(warp: &[[f64; 2]], secs: f64, smoothing: f64) -> f64 {
    match warp_map(warp, smoothing) {
        Ok(Some(map)) => map.map_time(secs),
        _ => secs,
    }
}

/// Output length of a program without rendering it (region durations minus
/// the crossfade overlaps).
pub fn program_duration_secs(program: &ClipProgram) -> f64 {
    let xf = program.crossfade_ms.max(0.0) / 1000.0;
    let mut total = 0.0;
    let mut prev: Option<f64> = None;
    for r in &program.regions {
        let d = r.duration_secs();
        if d <= 0.0 {
            continue;
        }
        if let Some(prev_len) = prev {
            total -= xf.min(prev_len / 2.0).min(d / 2.0);
        }
        total += d;
        prev = Some(d);
    }
    warp_time_secs(&program.warp, total, program.warp_smoothing)
}

/// Cut a rendered span to EXACTLY `beats` whole beats at `bpm`: a
/// fractional tail is filled with silence, and an overhang (sample
/// rounding, or the flam a tapped grid keeps between its anchors) is
/// trimmed — the count is the caller's, decided where the selection was
/// made, so the clip saved is the clip the save row showed. A count more
/// than a beat away from the audio is a mismatched call, not a request.
pub fn pad_to_beats(audio: &AudioData, bpm: f64, beats: usize) -> Result<AudioData> {
    ensure!(
        bpm.is_finite() && bpm > 0.0,
        "beat clip: a positive BPM is required"
    );
    ensure!(beats > 0, "beat clip: at least one beat is required");
    ensure!(audio.frames() > 0, "beat clip: nothing to save there");
    let beats_f = audio.duration_secs() * bpm / 60.0;
    ensure!(
        (beats as f64 - beats_f).abs() < 1.0 + 1e-9,
        "beat clip: {beats} beats asked of a span that is {beats_f:.2} beats at {bpm:.1} BPM"
    );
    let target = (beats as f64 * 60.0 / bpm * audio.sample_rate as f64).round() as usize;
    Ok(AudioData {
        channels: audio
            .channels
            .iter()
            .map(|c| {
                let mut c = c.clone();
                c.resize(target, 0.0);
                c
            })
            .collect(),
        sample_rate: audio.sample_rate,
    })
}

/// One seed's hearing of a tapped span: what the Clip page's seed picker
/// lists, and what it builds the grid from when a seed is chosen by hand.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TappedSeed {
    /// Checkpoint ("final0"…, or "dsp" for the fallback tracker).
    pub seed: String,
    /// Tempo of this seed's fit, reading applied.
    pub bpm: f64,
    /// Its ACTUAL beat times over the tapped span, output seconds —
    /// detections where it has them, the fitted line where a beat went
    /// undetected.
    pub times: Vec<f64>,
    /// How well the taps land on it (0..=1) — the ranking, best first.
    pub fit: f64,
}

/// What running the tracker over a tapped span heard: the beat times the
/// Clip page stretches instead of the raw taps.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TappedBeats {
    /// Checkpoint the taps chose ("final0"…, or "dsp" for the fallback).
    pub seed: String,
    /// Tempo of the chosen fit, reading applied.
    pub bpm: f64,
    /// The chosen seed's ACTUAL beat times over the tapped span, output
    /// seconds — detections where it has them, the fitted line where a
    /// beat went undetected.
    pub times: Vec<f64>,
    /// Which tracker produced the runs ("beat_this/…" or "dsp").
    pub tracker: String,
    /// Every seed that heard two beats or more over the span, best fit
    /// first — the chosen one (above) is the head. The taps AUTOSELECT,
    /// they do not decide: the Clip page lets another be picked.
    pub seeds: Vec<TappedSeed>,
}

/// The Clip page's beat grid, measured rather than averaged (PRD §9):
/// run the tracker over the span the right-shift taps covered, let the
/// taps choose among its seeds' readings
/// ([`beat_fit::choose_tapped_fit`]), and hand back that seed's actual
/// beat times over the span. Downstream those times go through the SAME
/// stretch rules raw taps do — the taps only bound the region and pick
/// the hearing.
pub fn beats_from_taps(
    audio: &AudioData,
    tracker: &dyn BeatTracker,
    taps: &[f64],
) -> Result<TappedBeats> {
    let mut taps: Vec<f64> = taps.iter().copied().filter(|t| t.is_finite()).collect();
    taps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    ensure!(
        taps.len() >= 2,
        "beat taps: two taps are the least a span needs"
    );
    let (first, last) = (taps[0], taps[taps.len() - 1]);
    ensure!(last > first, "beat taps: those taps cover no time");
    // One tap-gap of margin each side: a beat under the first tap (taps
    // run LATE by the hand's latency) must not fall off the region edge.
    let gap = (last - first) / (taps.len() - 1) as f64;
    let dur = audio.duration_secs();
    let region = ((first - gap).max(0.0), (last + gap).min(dur));
    let analysis = beatify::analyze(audio, tracker, Some(region), Default::default())
        .map_err(|e| anyhow!("measuring the tapped span: {e}"))?;
    let runs: Vec<(String, Vec<f64>)> = analysis
        .runs
        .iter()
        .map(|r| (r.seed.clone(), r.beats.clone()))
        .collect();
    let fits = beat_fit::tapped_fits(&runs, &taps);
    ensure!(
        !fits.is_empty(),
        "no seed produced a grid over the tapped span"
    );
    // Every seed's hearing travels, so overruling the choice costs no
    // second measurement — a seed with fewer than two beats over the span
    // is no grid at all and never appears.
    let seeds: Vec<TappedSeed> = fits
        .into_iter()
        .filter_map(|f| {
            let times = fit_beat_times(&f.fit, first, last, dur);
            (times.len() >= 2).then(|| TappedSeed {
                seed: f.seed,
                bpm: f.fit.bpm(),
                times,
                fit: f.score,
            })
        })
        .collect();
    let chosen = seeds
        .first()
        .ok_or_else(|| anyhow!("the tapped span holds fewer than two detected beats"))?;
    Ok(TappedBeats {
        seed: chosen.seed.clone(),
        bpm: chosen.bpm,
        times: chosen.times.clone(),
        tracker: analysis.tracker,
        seeds,
    })
}

/// The fit's actual beat times covering `[from, to]`: one per whole grid
/// index between the lines nearest each end — a detection's own time
/// where the fit kept one, the fitted line where the beat went
/// undetected (or was dropped by a half-time reading).
fn fit_beat_times(fit: &beat_fit::Fit, from: f64, to: f64, dur: f64) -> Vec<f64> {
    if !(fit.period.is_finite() && fit.period > 0.0) {
        return Vec::new();
    }
    let n0 = ((from - fit.phase) / fit.period).round() as i64;
    let n1 = ((to - fit.phase) / fit.period).round() as i64;
    let mut out: Vec<f64> = Vec::new();
    for n in n0..=n1 {
        let t = fit
            .beats
            .iter()
            .find(|b| (b.index - n as f64).abs() < 0.25)
            .map(|b| b.time)
            .unwrap_or_else(|| fit.line(n as f64));
        let t = t.clamp(0.0, dur);
        if out.last().is_none_or(|&prev| t > prev + 1e-6) {
            out.push(t);
        }
    }
    out
}

/// Waveform overview peaks (0..=1), `buckets` values — same law as the
/// deck's `deck_waveform` so both waveforms look alike.
pub fn peaks(audio: &AudioData, buckets: usize) -> Vec<f32> {
    let frames = audio.frames();
    if frames == 0 || buckets == 0 || audio.channels.is_empty() {
        return Vec::new();
    }
    let buckets = buckets.min(frames);
    let per = frames as f64 / buckets as f64;
    (0..buckets)
        .map(|b| {
            let start = (b as f64 * per) as usize;
            let end = (((b + 1) as f64 * per) as usize).min(frames);
            let mut p = 0.0f32;
            for i in start..end {
                let mut s = audio.channels[0][i].abs();
                if audio.channels.len() > 1 {
                    s = s.max(audio.channels[1][i].abs());
                }
                p = p.max(s);
            }
            p
        })
        .collect()
}

/// A time slice of decoded audio (the editor's audition window).
pub fn slice(audio: &AudioData, start_secs: f64, secs: f64) -> AudioData {
    let frames = audio.frames();
    let sr = audio.sample_rate as f64;
    let first = ((start_secs.max(0.0) * sr) as usize).min(frames);
    let last = (first + (secs.max(0.0) * sr) as usize).min(frames);
    AudioData {
        channels: audio
            .channels
            .iter()
            .map(|c| c[first..last].to_vec())
            .collect(),
        sample_rate: audio.sample_rate,
    }
}

/// Encode as a 16-bit PCM WAV in memory (the Clip page auditions a render
/// by streaming these bytes into the webview; nothing writes them to disk).
pub fn wav16_bytes(audio: &AudioData) -> Vec<u8> {
    let n_ch = audio.channels.len().max(1) as u16;
    let frames = audio.frames();
    let bytes_per_sample = 2u32;
    let data_len = frames as u32 * n_ch as u32 * bytes_per_sample;
    let byte_rate = audio.sample_rate * n_ch as u32 * bytes_per_sample;
    let block_align = n_ch * bytes_per_sample as u16;

    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&n_ch.to_le_bytes());
    out.extend_from_slice(&audio.sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for i in 0..frames {
        for c in &audio.channels {
            let s = (c[i].clamp(-1.0, 1.0) * 32767.0).round() as i16;
            out.extend_from_slice(&s.to_le_bytes());
        }
    }
    out
}

/// Where rendered clips land: `<data_dir>/clips/`.
pub fn clips_dir(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("clips")
}

/// Write a rendered clip as 16-bit FLAC (same encoder as the stem cache).
pub fn write_clip(path: &Path, audio: &AudioData) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::stems::write_flac(path, audio)
}

// ---------------------------------------------------------------------------
// Beat clips: the Clip page's saved output
// ---------------------------------------------------------------------------
//
// A BEAT CLIP is a rendered span cut to a whole number of beats at a
// known tempo — what the rack's Beat Clip module (and so the Decks) can
// play on a clock, exactly like a Beatify clip. The store is one FLAC +
// one meta JSON per clip under `<data_dir>/beat-clips/`, ids minted
// `b<n>` — a sibling of `clips/` and the Beatify store.

/// A library track a beat clip was cut from, named by the ONE id of a
/// track that nothing can change: the hash of its audio
/// (`dj_library::content_hash`, the same handle a Beatify seed keeps).
/// A row id is re-assigned on re-import and a title/artist is the user's
/// to edit — a clip that stored either would go stale the moment it did.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatClipSource {
    /// Content hash of the source track's audio.
    pub track_hash: String,
    /// Which parts of it ([`crate::STEM_NAMES`] order); empty = the whole
    /// mix.
    #[serde(default)]
    pub stems: Vec<String>,
}

/// How a beat clip was cut: everything needed to open it in the Clip
/// page again. The `program`'s regions carry the SOURCE TIMESTAMPS (in
/// and out of each source), the beat grid its beat positions and the
/// warp its stretching; `sources` says which library track each region
/// index means.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatClipEdit {
    /// Indexed by [`ClipRegion::source`].
    pub sources: Vec<BeatClipSource>,
    pub program: ClipProgram,
    /// The span of the rendered program that was filed, in output
    /// seconds.
    pub start_secs: f64,
    pub end_secs: f64,
}

/// One saved beat clip, as filed beside its audio. camelCase on disk,
/// like Beatify's records — one convention per feature family.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatClipMeta {
    pub id: String,
    /// A beat clip wears ONE label. Anything else it used to carry (the
    /// source track's title) was folded in here by
    /// [`migrate_beat_clips`].
    pub name: String,
    /// Tempo of the (perfectly even) beat grid the audio was cut on.
    pub bpm: f64,
    /// Whole beats the clip holds — the last one silence-padded when the
    /// saved span was fractional.
    pub beats: usize,
    /// Audio file name, next to this meta.
    pub file: String,
    /// Which parts of its sources it is made of ([`crate::STEM_NAMES`]
    /// order) — the tags the pickers show.
    #[serde(default)]
    pub stems: Vec<String>,
    /// The edit behind the audio. `None` for clips filed before it was
    /// kept: a beat clip whose sources are unknown is a normal state,
    /// not a broken record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit: Option<BeatClipEdit>,
    /// BLEED, in milliseconds: material kept from OUTSIDE the loop so its
    /// seam has continuity. The left bleed is the audio before the clip's
    /// start (overlaid over its END, so a pass anticipates the next one);
    /// the right bleed is the audio after its end (overlaid over its
    /// START, so a pass carries the last one's tail). Neither is mixed
    /// into the loop — it is the player that lays them over it, which is
    /// what lets the first pass drop the right one and the last pass the
    /// left. 0 (and no bleed file) for a clip saved without any.
    #[serde(default)]
    pub left_bleed_ms: f64,
    #[serde(default)]
    pub right_bleed_ms: f64,
    /// LEGACY: the source track's title, filed as a second label beside
    /// the clip's own name. Read so it can be folded into `name`, never
    /// written.
    #[serde(default, rename = "sourceTitle", skip_serializing)]
    pub legacy_source_title: String,
}

impl BeatClipMeta {
    /// Fold a legacy second label into the one name a clip has now.
    /// Returns whether anything moved.
    fn adopt_legacy_name(&mut self) -> bool {
        let extra = std::mem::take(&mut self.legacy_source_title);
        let extra = extra.trim();
        if extra.is_empty() {
            return false;
        }
        self.name = if self.name.trim().is_empty() {
            extra.to_string()
        } else {
            format!("{} · {extra}", self.name)
        };
        true
    }
}

/// A beat clip's bleed as audio: the spans either side of the loop, as
/// they were rendered. Empty on both sides is the ordinary clip.
#[derive(Debug, Clone, Default)]
pub struct BleedAudio {
    /// From before the loop's start — overlaid over its END.
    pub left: Option<AudioData>,
    /// From after the loop's end — overlaid over its START.
    pub right: Option<AudioData>,
}

/// Where a bleed's audio is filed: beside the loop, named after it, so a
/// clip is still one id and its bleed cannot be mistaken for a loop.
fn bleed_file(clip_id: &str, left: bool) -> String {
    format!("{clip_id}-bleed-{}.flac", if left { "l" } else { "r" })
}

fn bleed_ms(audio: &Option<AudioData>) -> f64 {
    audio
        .as_ref()
        .map(|a| a.duration_secs() * 1000.0)
        .unwrap_or(0.0)
}

/// Where beat clips land: `<data_dir>/beat-clips/`.
pub fn beat_clips_dir(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("beat-clips")
}

/// Every record file in the store, with the path it was read from.
fn beat_clip_files(data_dir: &Path) -> Vec<(std::path::PathBuf, BeatClipMeta)> {
    let Ok(entries) = std::fs::read_dir(beat_clips_dir(data_dir)) else {
        return Vec::new();
    };
    let mut out: Vec<(std::path::PathBuf, BeatClipMeta)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|path| {
            let text = std::fs::read_to_string(&path).ok()?;
            let meta: BeatClipMeta = serde_json::from_str(&text).ok()?;
            Some((path, meta))
        })
        .collect();
    out.sort_by_key(|(_, c)| c.id.trim_start_matches('b').parse::<u64>().unwrap_or(0));
    out
}

/// Every saved beat clip, oldest first (by minted id number). A store
/// that does not exist yet is simply empty. A record still carrying the
/// legacy second label reads back with it folded into its name, whether
/// or not [`migrate_beat_clips`] has rewritten it yet.
pub fn read_beat_clips(data_dir: &Path) -> Vec<BeatClipMeta> {
    beat_clip_files(data_dir)
        .into_iter()
        .map(|(_, mut meta)| {
            meta.adopt_legacy_name();
            meta
        })
        .collect()
}

/// Fold every legacy second label into its clip's name, on disk. Runs
/// once at startup; a clip already migrated (or filed since) is left
/// alone, so it is idempotent and cheap. Returns how many were rewritten.
pub fn migrate_beat_clips(data_dir: &Path) -> usize {
    let mut migrated = 0;
    for (path, mut meta) in beat_clip_files(data_dir) {
        if !meta.adopt_legacy_name() {
            continue;
        }
        let Ok(json) = serde_json::to_string_pretty(&meta) else {
            continue;
        };
        // Best effort: a store that cannot be written still READS
        // migrated (see `read_beat_clips`), so nothing is lost either way.
        if std::fs::write(&path, json).is_ok() {
            migrated += 1;
        }
    }
    migrated
}

/// A beat clip's record, its loop and the bleed that goes over the seam,
/// for whatever is about to play it. A bleed file that has gone missing
/// costs the overlay, never the clip.
pub fn load_beat_clip(
    data_dir: &Path,
    clip_id: &str,
) -> Result<(BeatClipMeta, AudioData, BleedAudio)> {
    let meta = read_beat_clips(data_dir)
        .into_iter()
        .find(|c| c.id == clip_id)
        .ok_or_else(|| anyhow::anyhow!("no saved beat clip {clip_id}"))?;
    let dir = beat_clips_dir(data_dir);
    let audio = crate::decode_audio(&dir.join(&meta.file))
        .map_err(|e| anyhow::anyhow!("reading beat clip {}: {e}", meta.name))?;
    let side = |ms: f64, left: bool| {
        (ms > 0.0)
            .then(|| crate::decode_audio(&dir.join(bleed_file(&meta.id, left))).ok())
            .flatten()
    };
    let bleed = BleedAudio {
        left: side(meta.left_bleed_ms, true),
        right: side(meta.right_bleed_ms, false),
    };
    Ok((meta, audio, bleed))
}

/// File a rendered span as a beat clip: cut it to exactly `beats` whole
/// beats at `bpm` ([`pad_to_beats`]), mint the next `b<n>` id and write
/// audio + meta.
/// `edit` is how it was cut ([`BeatClipEdit`]) — kept so the clip can be
/// opened again, and so it points at its sources by id rather than by a
/// copy of their titles. The `bleed` spans are filed BESIDE the loop,
/// never into it — the loop is exactly the beats that were selected, and
/// the milliseconds recorded are the ones actually written, so a bleed
/// the track was too short to give is smaller rather than wrong.
// Every argument is a field of the record being written; a struct would
// only move the list.
#[allow(clippy::too_many_arguments)]
pub fn save_beat_clip(
    data_dir: &Path,
    name: &str,
    audio: &AudioData,
    bpm: f64,
    beats: usize,
    stems: Vec<String>,
    edit: Option<BeatClipEdit>,
    bleed: &BleedAudio,
) -> Result<BeatClipMeta> {
    let name = name.trim();
    ensure!(!name.is_empty(), "beat clip: it needs a name");
    let padded = pad_to_beats(audio, bpm, beats)?;
    let dir = beat_clips_dir(data_dir);
    std::fs::create_dir_all(&dir)?;
    let next = read_beat_clips(data_dir)
        .iter()
        .filter_map(|c| c.id.trim_start_matches('b').parse::<u64>().ok())
        .max()
        .unwrap_or(0)
        + 1;
    let meta = BeatClipMeta {
        id: format!("b{next}"),
        name: name.to_string(),
        bpm,
        beats,
        file: format!("b{next}.flac"),
        stems,
        edit,
        left_bleed_ms: bleed_ms(&bleed.left),
        right_bleed_ms: bleed_ms(&bleed.right),
        legacy_source_title: String::new(),
    };
    write_clip(&dir.join(&meta.file), &padded)?;
    for (side, audio) in [(true, &bleed.left), (false, &bleed.right)] {
        if let Some(audio) = audio.as_ref().filter(|a| a.frames() > 0) {
            write_clip(&dir.join(bleed_file(&meta.id, side)), audio)?;
        }
    }
    std::fs::write(
        dir.join(format!("b{next}.json")),
        serde_json::to_string_pretty(&meta)?,
    )?;
    Ok(meta)
}

/// Delete a beat clip: its record and its audio. Unknown ids are an
/// error — the caller is acting on a list, and a row that is not there
/// means the list is stale.
pub fn delete_beat_clip(data_dir: &Path, clip_id: &str) -> Result<BeatClipMeta> {
    let (path, meta) = beat_clip_files(data_dir)
        .into_iter()
        .find(|(_, c)| c.id == clip_id)
        .ok_or_else(|| anyhow!("no saved beat clip {clip_id}"))?;
    // The audio first: a record with no file left is a clip that plays
    // nothing, where a file with no record is simply unreachable.
    if let Some(dir) = path.parent() {
        let audio = dir.join(&meta.file);
        if audio.is_file() {
            std::fs::remove_file(&audio)?;
        }
    }
    std::fs::remove_file(&path)?;
    Ok(meta)
}
