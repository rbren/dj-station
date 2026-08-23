//! Stem separation (PRD §8.2, M3): vocals / drums / bass / other.
//!
//! [`StemSeparator`] is the pluggable interface. Two implementations:
//!
//! - [`BandSeparator`] (this module): a deterministic pure-DSP fallback
//!   that always works offline. Harmonic/percussive separation (HPSS via
//!   median filtering of the spectrogram along time vs. frequency) yields
//!   the drum stem; the harmonic part is split by frequency band and
//!   stereo-center dominance into bass (low band), vocals (center-panned
//!   mid band) and other (everything else). All masks form a partition of
//!   unity per time-frequency bin, so the four stems sum to the original
//!   signal exactly (energy conservation) and the ISTFT is the only
//!   source of (tiny) reconstruction error.
//! - `OnnxSeparator` (`src/onnx.rs`, `--features onnx`): htdemucs-class
//!   model via ONNX Runtime, CoreML execution provider on macOS / CPU
//!   elsewhere. Production quality arrives by dropping in real weights;
//!   the fallback keeps every feature testable without them.
//!
//! Stems are cached as FLAC under `<data_dir>/stems/<content_hash>/`
//! (PRD §8.2: per-track content-hashed caching, FLAC in app storage).

use anyhow::{Context, Result};
use rustfft::num_complex::Complex;
use std::path::{Path, PathBuf};
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::decode::AudioData;
use crate::stft::Stft;

/// Stem order used everywhere (jacks, files, gains).
pub const STEM_NAMES: [&str; 4] = ["vocals", "drums", "bass", "other"];
pub const N_STEMS: usize = 4;

/// Separated stems, same sample rate / length as the input, ordered per
/// [`STEM_NAMES`].
pub struct Stems(pub [AudioData; N_STEMS]);

/// A stem separation backend. Implementations must be deterministic for a
/// given input and preserve length/sample rate.
pub trait StemSeparator: Send + Sync {
    /// Short id that keys the stem cache ("band", "onnx", "htdemucs_ft").
    /// Model-backed separators return the model name so two models never
    /// share a cache directory (see [`stems_dir_for`]).
    fn id(&self) -> &str;
    fn separate(&self, audio: &AudioData) -> Result<Stems>;

    /// Separate, giving up early if `cancel` fires.
    ///
    /// The default ignores the token, which is right for the in-process
    /// separators: they are seconds of CPU, so the caller simply throws
    /// the result away. A separator that shells out to a tool for minutes
    /// must override this and hand its child process to the token — a
    /// flag alone cannot stop another process.
    fn separate_cancellable(&self, audio: &AudioData, _cancel: &CancelToken) -> Result<Stems> {
        self.separate(audio)
    }
}

/// A stop signal for one separation, plus the child process (if any) that
/// is doing the work. Cancelling kills that child: a demucs run is
/// minutes of another program's time and nothing inside it is watching a
/// flag of ours.
#[derive(Debug, Default)]
pub struct CancelToken {
    stopped: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ask the separation to stop, killing the running child if there is
    /// one. Safe to call from any thread, and safe to call twice.
    pub fn cancel(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(child) = self.child.lock().expect("cancel token poisoned").as_mut() {
            let _ = child.kill();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Put `child` under this token's control. A token cancelled before
    /// the spawn kills it immediately, so a cancel can never be lost in
    /// the gap between the two.
    pub fn adopt(&self, child: Child) {
        let mut slot = self.child.lock().expect("cancel token poisoned");
        *slot = Some(child);
        if self.is_cancelled() {
            if let Some(child) = slot.as_mut() {
                let _ = child.kill();
            }
        }
    }

    /// Wait for the adopted child, returning how it exited.
    ///
    /// Polls rather than blocking in `wait`: the child has to stay
    /// reachable for [`cancel`](Self::cancel) the whole time it runs, and
    /// a blocking wait would either hold the lock (deadlocking the cancel)
    /// or take the child out of reach of it. A separation is minutes
    /// long, so a 25 ms tick costs nothing.
    pub fn wait_child(&self) -> std::io::Result<Option<ExitStatus>> {
        loop {
            {
                let mut slot = self.child.lock().expect("cancel token poisoned");
                let Some(child) = slot.as_mut() else {
                    return Ok(None);
                };
                if let Some(status) = child.try_wait()? {
                    *slot = None;
                    return Ok(Some(status));
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
}

// ---------------------------------------------------------------------------
// DSP fallback separator
// ---------------------------------------------------------------------------

const WIN: usize = 2048;
const HOP: usize = 512;
/// Median filter extents: ~180 ms along time (harmonic), ~400 Hz along
/// frequency (percussive) at 48 kHz.
const MED_TIME: usize = 17;
const MED_FREQ: usize = 17;
/// Bass band: full below, cosine rolloff to zero at the upper edge.
const BASS_LO_HZ: f64 = 150.0;
const BASS_HI_HZ: f64 = 300.0;
/// Vocal band (within the harmonic residual above the bass band).
const VOX_LO_HZ: f64 = 200.0;
const VOX_LO_FULL_HZ: f64 = 350.0;
const VOX_HI_FULL_HZ: f64 = 3500.0;
const VOX_HI_HZ: f64 = 6000.0;
/// Chunked processing bound (seconds) so long tracks don't hold full
/// spectrograms in memory. Chunks carry an analysis margin and stitch
/// sample-exactly.
const CHUNK_SECS: f64 = 20.0;

#[derive(Debug, Default, Clone, Copy)]
pub struct BandSeparator;

impl StemSeparator for BandSeparator {
    fn id(&self) -> &str {
        "band"
    }

    fn separate(&self, audio: &AudioData) -> Result<Stems> {
        let n = audio.frames();
        let n_ch = audio.channels.len();
        anyhow::ensure!(n_ch >= 1 && n > 0, "empty audio");
        let sr = audio.sample_rate;

        let mut out: [AudioData; N_STEMS] = std::array::from_fn(|_| AudioData {
            channels: vec![Vec::with_capacity(n); n_ch],
            sample_rate: sr,
        });

        let chunk = ((CHUNK_SECS * sr as f64) as usize).max(WIN * 4);
        let margin = MED_TIME / 2 * HOP + WIN;
        let mut start = 0usize;
        while start < n {
            let end = (start + chunk).min(n);
            let lo = start.saturating_sub(margin);
            let hi = (end + margin).min(n);
            let seg: Vec<&[f32]> = audio.channels.iter().map(|c| &c[lo..hi]).collect();
            let stems = separate_segment(&seg, sr);
            for (s, stem) in stems.into_iter().enumerate() {
                for (ch, data) in stem.into_iter().enumerate() {
                    out[s].channels[ch].extend_from_slice(&data[start - lo..end - lo]);
                }
            }
            start = end;
        }
        Ok(Stems(out))
    }
}

/// Separate one segment (all channels): returns `[stem][channel] -> samples`
/// of the segment's full length.
fn separate_segment(channels: &[&[f32]], sample_rate: u32) -> Vec<Vec<Vec<f32>>> {
    let n = channels[0].len();
    let stft = Stft::new(WIN, HOP);
    // Pad both ends so WOLA reconstructs the segment interior exactly.
    let padded: Vec<Vec<f32>> = channels
        .iter()
        .map(|c| {
            let mut p = vec![0.0f32; WIN];
            p.extend_from_slice(c);
            p.extend(std::iter::repeat_n(0.0f32, WIN));
            p
        })
        .collect();
    let specs: Vec<Vec<Vec<Complex<f32>>>> = padded.iter().map(|p| stft.forward(p)).collect();
    let n_frames = specs[0].len();
    let bins = stft.bins();

    // Channel-averaged magnitudes for HPSS.
    let mut mag = vec![vec![0.0f32; bins]; n_frames];
    for (t, row) in mag.iter_mut().enumerate() {
        for (k, m) in row.iter_mut().enumerate() {
            let mut s = 0.0f32;
            for spec in &specs {
                s += spec[t][k].norm();
            }
            *m = s / specs.len() as f32;
        }
    }
    let harm = median_time(&mag, MED_TIME);
    let perc = median_freq(&mag, MED_FREQ);

    // Precompute frequency-band weights per bin.
    let bass_w: Vec<f32> = (0..bins)
        .map(|k| band_low(stft.bin_hz(k, sample_rate)) as f32)
        .collect();
    let vox_w: Vec<f32> = (0..bins)
        .map(|k| band_vocal(stft.bin_hz(k, sample_rate)) as f32)
        .collect();

    // Masked spectrograms per stem per channel.
    let n_ch = channels.len();
    let mut masked: Vec<Vec<Vec<Vec<Complex<f32>>>>> =
        vec![vec![vec![vec![Complex::new(0.0, 0.0); bins]; n_frames]; n_ch]; crate::stems::N_STEMS];
    for t in 0..n_frames {
        for k in 0..bins {
            let h2 = harm[t][k] * harm[t][k];
            let p2 = perc[t][k] * perc[t][k];
            let p_mask = if h2 + p2 > 1e-12 { p2 / (h2 + p2) } else { 0.0 };
            let h_mask = 1.0 - p_mask;

            // Stereo-center dominance (mono => 1): vocals live mid.
            let center = if n_ch >= 2 {
                let l = specs[0][t][k];
                let r = specs[1][t][k];
                let mid = (l + r).norm_sqr() * 0.25;
                let side = (l - r).norm_sqr() * 0.25;
                if mid + side > 1e-12 {
                    mid / (mid + side)
                } else {
                    1.0
                }
            } else {
                1.0
            };

            let b = bass_w[k];
            let v = vox_w[k] * center;
            // Partition of unity: drums + bass + vocals + other = 1.
            let m_drums = p_mask;
            let m_bass = h_mask * b;
            let m_vocals = h_mask * (1.0 - b) * v;
            let m_other = h_mask * (1.0 - b) * (1.0 - v);
            let masks = [m_vocals, m_drums, m_bass, m_other];
            for ch in 0..n_ch {
                let bin = specs[ch][t][k];
                for (s, &m) in masks.iter().enumerate() {
                    masked[s][ch][t][k] = bin * m;
                }
            }
        }
    }

    masked
        .into_iter()
        .map(|per_ch| {
            per_ch
                .into_iter()
                .map(|frames| {
                    let full = stft.inverse(&frames, n + 2 * WIN);
                    full[WIN..WIN + n].to_vec()
                })
                .collect()
        })
        .collect()
}

fn band_low(f: f64) -> f64 {
    ramp_down(f, BASS_LO_HZ, BASS_HI_HZ)
}

fn band_vocal(f: f64) -> f64 {
    ramp_up(f, VOX_LO_HZ, VOX_LO_FULL_HZ) * ramp_down(f, VOX_HI_FULL_HZ, VOX_HI_HZ)
}

/// 1 below `lo`, raised-cosine to 0 at `hi`.
fn ramp_down(f: f64, lo: f64, hi: f64) -> f64 {
    if f <= lo {
        1.0
    } else if f >= hi {
        0.0
    } else {
        0.5 + 0.5 * (std::f64::consts::PI * (f - lo) / (hi - lo)).cos()
    }
}

/// 0 below `lo`, raised-cosine to 1 at `hi`.
fn ramp_up(f: f64, lo: f64, hi: f64) -> f64 {
    1.0 - ramp_down(f, lo, hi)
}

/// Median along the time axis (harmonic enhancement).
fn median_time(mag: &[Vec<f32>], len: usize) -> Vec<Vec<f32>> {
    let n_frames = mag.len();
    let bins = mag[0].len();
    let half = len / 2;
    let mut out = vec![vec![0.0f32; bins]; n_frames];
    let mut scratch = Vec::with_capacity(len);
    for k in 0..bins {
        for (t, row) in out.iter_mut().enumerate() {
            let lo = t.saturating_sub(half);
            let hi = (t + half + 1).min(n_frames);
            scratch.clear();
            scratch.extend((lo..hi).map(|i| mag[i][k]));
            row[k] = median(&mut scratch);
        }
    }
    out
}

/// Median along the frequency axis (percussive enhancement).
fn median_freq(mag: &[Vec<f32>], len: usize) -> Vec<Vec<f32>> {
    let n_frames = mag.len();
    let bins = mag[0].len();
    let half = len / 2;
    let mut out = vec![vec![0.0f32; bins]; n_frames];
    let mut scratch = Vec::with_capacity(len);
    for (row_in, row_out) in mag.iter().zip(out.iter_mut()) {
        for (k, o) in row_out.iter_mut().enumerate() {
            let lo = k.saturating_sub(half);
            let hi = (k + half + 1).min(bins);
            scratch.clear();
            scratch.extend_from_slice(&row_in[lo..hi]);
            *o = median(&mut scratch);
        }
    }
    out
}

fn median(v: &mut [f32]) -> f32 {
    let mid = v.len() / 2;
    *v.select_nth_unstable_by(mid, |a, b| a.partial_cmp(b).unwrap())
        .1
}

// ---------------------------------------------------------------------------
// FLAC storage + content-hash cache (PRD §8.2)
// ---------------------------------------------------------------------------

/// Where a track's stems live: `<data_dir>/stems/<content_hash>/`.
///
/// This is the DSP fallback's (and the deck's) cache. Model-backed
/// backends qualify it further — see [`stems_dir_for`].
pub fn stems_dir(data_dir: &Path, content_hash: &str) -> PathBuf {
    data_dir.join("stems").join(content_hash)
}

/// The default (DSP) separator id, whose stems live unqualified in
/// [`stems_dir`] so the deck's auto-load path never moves.
pub const DEFAULT_SEPARATOR_ID: &str = "band";

/// Where one *backend's* stems live. The DSP fallback keeps the flat
/// `<data_dir>/stems/<hash>/` layout; every other backend gets its own
/// subdirectory `<data_dir>/stems/<hash>/<separator id>/`, so asking for
/// `htdemucs_ft` can never be served the DSP stems that the import-time
/// analysis pass already wrote (and vice versa).
pub fn stems_dir_for(data_dir: &Path, content_hash: &str, separator_id: &str) -> PathBuf {
    let base = stems_dir(data_dir, content_hash);
    if separator_id == DEFAULT_SEPARATOR_ID {
        base
    } else {
        base.join(separator_id)
    }
}

/// The four stem FLAC paths inside a stems directory, [`STEM_NAMES`] order.
pub fn stem_paths(dir: &Path) -> [PathBuf; N_STEMS] {
    std::array::from_fn(|i| dir.join(format!("{}.flac", STEM_NAMES[i])))
}

/// True when all four stems are cached.
pub fn stems_cached(dir: &Path) -> bool {
    stem_paths(dir).iter().all(|p| p.is_file())
}

/// Compute-if-missing stem cache: returns `true` if stems were computed,
/// `false` on a cache hit (nothing recomputed, per-track caching keyed by
/// the content hash embedded in `dir`).
pub fn ensure_stems(dir: &Path, audio: &AudioData, separator: &dyn StemSeparator) -> Result<bool> {
    ensure_stems_cancellable(dir, audio, separator, &CancelToken::new())
}

/// [`ensure_stems`], abandonable through `cancel`. A cancelled run writes
/// nothing: a half-filled cache directory would be indistinguishable from
/// a real one on the next look.
pub fn ensure_stems_cancellable(
    dir: &Path,
    audio: &AudioData,
    separator: &dyn StemSeparator,
    cancel: &CancelToken,
) -> Result<bool> {
    if stems_cached(dir) {
        return Ok(false);
    }
    let stems = separator.separate_cancellable(audio, cancel)?;
    if cancel.is_cancelled() {
        return Ok(false);
    }
    write_stems(dir, &stems)?;
    Ok(true)
}

/// Write the four stems as 16-bit FLAC (via a tmp-file rename so a
/// half-written cache never looks complete).
pub fn write_stems(dir: &Path, stems: &Stems) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let paths = stem_paths(dir);
    for (audio, path) in stems.0.iter().zip(&paths) {
        let tmp = path.with_extension("flac.tmp");
        write_flac(&tmp, audio)?;
        std::fs::rename(&tmp, path)
            .with_context(|| format!("finalizing stem {}", path.display()))?;
    }
    Ok(())
}

/// Encode audio as 16-bit FLAC (the stem cache and rendered clips).
pub(crate) fn write_flac(path: &Path, audio: &AudioData) -> Result<()> {
    use flacenc::bitsink::ByteSink;
    use flacenc::component::BitRepr;
    use flacenc::error::Verify;

    let n_ch = audio.channels.len();
    let frames = audio.frames();
    let mut interleaved = Vec::with_capacity(frames * n_ch);
    for i in 0..frames {
        for c in &audio.channels {
            let s = (c[i].clamp(-1.0, 1.0) * 32767.0).round() as i32;
            interleaved.push(s);
        }
    }
    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|(_, e)| anyhow::anyhow!("flac encoder config: {e:?}"))?;
    let source = flacenc::source::MemSource::from_samples(
        &interleaved,
        n_ch,
        16,
        audio.sample_rate as usize,
    );
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| anyhow::anyhow!("flac encode: {e:?}"))?;
    let mut sink = ByteSink::new();
    stream
        .write(&mut sink)
        .map_err(|e| anyhow::anyhow!("flac write: {e:?}"))?;
    std::fs::write(path, sink.as_slice()).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}
