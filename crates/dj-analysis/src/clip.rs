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
//! 2. **EQ** ([`ClipEq`]): fixed 3-band tone control (low shelf / mid
//!    bell / high shelf), bypassed exactly at 0 dB.
//! 3. **Level automation** ([`LevelPoint`]): a breakpoint envelope in dB
//!    over the *output* timeline — fades in/out are just endpoints.
//!
//! Sources may differ in sample rate and channel count: the render runs at
//! the first source's rate with the widest channel count, resampling other
//! sources linearly and duplicating mono into every output channel.

use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;
use std::path::Path;

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

/// Fixed 3-band tone control. Every band is an exact pass-through at 0 dB.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ClipEq {
    pub low_db: f64,
    pub mid_db: f64,
    pub high_db: f64,
}

impl ClipEq {
    pub const LOW_HZ: f64 = 200.0;
    pub const MID_HZ: f64 = 1000.0;
    pub const MID_Q: f64 = 0.9;
    pub const HIGH_HZ: f64 = 4000.0;

    pub fn is_flat(&self) -> bool {
        self.low_db == 0.0 && self.mid_db == 0.0 && self.high_db == 0.0
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
}

impl Default for ClipProgram {
    fn default() -> Self {
        ClipProgram {
            regions: Vec::new(),
            eq: ClipEq::default(),
            level: Vec::new(),
            crossfade_ms: DEFAULT_CROSSFADE_MS,
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

    /// RBJ low/high shelf (S = 1).
    fn shelf(freq: f64, gain_db: f64, sr: f64, high: bool) -> Biquad {
        let a = 10f64.powf(gain_db / 40.0);
        let w0 = 2.0 * PI * freq / sr;
        let (sin_w0, cos_w0) = (w0.sin(), w0.cos());
        let alpha = sin_w0 / 2.0 * 2f64.sqrt();
        let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
        if high {
            Biquad::new(
                a * ((a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0),
                a * ((a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha),
                (a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha,
                2.0 * ((a - 1.0) - (a + 1.0) * cos_w0),
                (a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha,
            )
        } else {
            Biquad::new(
                a * ((a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0),
                a * ((a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha),
                (a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha,
                -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0),
                (a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha,
            )
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
        let mut bands: Vec<Biquad> = Vec::new();
        if eq.low_db != 0.0 {
            bands.push(Biquad::shelf(ClipEq::LOW_HZ, eq.low_db, sr, false));
        }
        if eq.mid_db != 0.0 {
            bands.push(Biquad::peaking(
                ClipEq::MID_HZ,
                eq.mid_db,
                ClipEq::MID_Q,
                sr,
            ));
        }
        if eq.high_db != 0.0 {
            bands.push(Biquad::shelf(ClipEq::HIGH_HZ, eq.high_db, sr, true));
        }
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
    Ok(AudioData {
        channels,
        sample_rate,
    })
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
    total
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
