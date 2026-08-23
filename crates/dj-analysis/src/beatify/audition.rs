//! Auditioning helpers for the import modal (PRD §3.9).
//!
//! Both of these render a couple of seconds at a time (MOD-A23) — the full
//! warp only ever runs on Save.

use crate::beatify::Analysis;
use crate::decode::AudioData;

/// Metronome click: a short decaying tone, loud enough to hear over the
/// music and short enough to place precisely.
const CLICK_HZ: f64 = 2000.0;
const CLICK_DECAY: f64 = 0.004;
const CLICK_SECS: f64 = 0.030;

/// Mix a metronome onto `audio` at `times` (seconds into `audio`), MOD-27.
pub fn mix_click(audio: &mut AudioData, times: &[f64], level: f32) {
    let sr = audio.sample_rate as f64;
    let len = (CLICK_SECS * sr) as usize;
    let frames = audio.frames();
    for &t in times {
        if t < 0.0 {
            continue;
        }
        let start = (t * sr) as usize;
        for j in 0..len {
            let i = start + j;
            if i >= frames {
                break;
            }
            let x = j as f64 / sr;
            let s = ((2.0 * std::f64::consts::PI * CLICK_HZ * x).sin() * (-x / CLICK_DECAY).exp())
                as f32
                * level;
            for ch in audio.channels.iter_mut() {
                ch[i] = (ch[i] + s).clamp(-1.0, 1.0);
            }
        }
    }
}

/// Beats of each take in the sync check, and how many times it loops.
pub const SYNC_BEATS: usize = 4;
pub const SYNC_REPEATS: usize = 4;

/// The acceptance test as a button (MOD-28): layer `SYNC_BEATS` beats from
/// two far-apart parts of the warped track and loop them. Clean means
/// commit; flam means the warp is wrong.
pub fn sync_check(audio: &AudioData, analysis: &Analysis, strength: f64) -> AudioData {
    let grid = analysis.grid;
    let take_secs = SYNC_BEATS as f64 * grid.period;
    let first = grid.beat_time(0.0);
    let last_beat = grid.beats.saturating_sub(SYNC_BEATS + 1) as f64;
    let last = grid.beat_time(last_beat.max(0.0));

    let a = crate::beatify::render_window(audio, analysis, strength, first, take_secs);
    let b = crate::beatify::render_window(audio, analysis, strength, last, take_secs);
    let n_ch = a.channels.len().max(1);
    let frames = a.frames().min(b.frames());
    let mut channels = vec![Vec::with_capacity(frames * SYNC_REPEATS); n_ch];
    for _ in 0..SYNC_REPEATS {
        for (c, out) in channels.iter_mut().enumerate() {
            for i in 0..frames {
                let x = a.channels[c.min(a.channels.len() - 1)][i]
                    + b.channels[c.min(b.channels.len() - 1)][i];
                out.push((x * 0.5).clamp(-1.0, 1.0));
            }
        }
    }
    AudioData {
        channels,
        sample_rate: audio.sample_rate,
    }
}
