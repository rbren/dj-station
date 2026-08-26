//! Granular time-stretch: play audio faster or slower WITHOUT moving its
//! pitch. The ONE implementation behind the deck's keylock and the Beat
//! Clip module, so there is a single place where grain length, the WSOLA
//! search and the overlap law are decided.
//!
//! Two voices, Hann-windowed overlap-add at 50 % hop (exact
//! constant-overlap-add, so unity rate is transparent). The caller keeps a
//! VIRTUAL playhead that moves at the stretched rate; grains read the
//! audio at its NATURAL rate, which is what leaves the pitch alone. Each
//! new grain is WSOLA-aligned — of the starts within ±[`SEARCH_SECS`] of
//! the virtual position, take the one whose audio best continues the grain
//! already playing — so grain joins stay phase-coherent instead of combing.
//!
//! RT-safe: the window table and correlation scratch are allocated at
//! construction, and every call does bounded work with no allocation.

/// Grain length in seconds (two-voice Hann OLA, 50 % hop).
pub const GRAIN_SECS: f64 = 0.040;
/// Candidate grain starts are searched within ± this window around the
/// ideal (virtual-timeline) position...
pub const SEARCH_SECS: f64 = 0.004;
/// ...maximizing cross-correlation with the natural continuation of the
/// previous grain over this many seconds.
pub const CORR_SECS: f64 = 0.005;

/// One voice's tap for the current output sample: where to read the source
/// and how much of it belongs in the sum.
#[derive(Debug, Clone, Copy)]
pub struct Tap {
    /// Source position in frames (fractional — interpolate).
    pub pos: f64,
    /// Hann window weight for this sample of the grain.
    pub gain: f32,
}

/// Grain scheduler + WSOLA aligner. Owns no audio: the caller reads its
/// own channels (a track, a stem set) at the positions [`Self::tick`]
/// hands back, so the same grains can drive several correlated sources.
pub struct GrainStretch {
    window: Vec<f32>,
    grain_len: usize,
    hop: usize,
    /// Source frame each voice's grain started at.
    voice_start: [f64; 2],
    /// Output samples into the grain (`== grain_len`: idle).
    voice_off: [usize; 2],
    hop_phase: usize,
    next_voice: usize,
    /// Preallocated WSOLA scratch: the previous grain's natural
    /// continuation, sampled from channel 0.
    corr_ref: Vec<f32>,
    search_radius: usize,
}

impl GrainStretch {
    pub fn new(engine_rate: f32) -> Self {
        let rate = engine_rate as f64;
        let grain_len = ((rate * GRAIN_SECS) as usize).max(64) & !1;
        let window: Vec<f32> = (0..grain_len)
            .map(|n| {
                let x = n as f64 / grain_len as f64;
                (0.5 - 0.5 * (2.0 * std::f64::consts::PI * x).cos()) as f32
            })
            .collect();
        GrainStretch {
            window,
            grain_len,
            hop: grain_len / 2,
            voice_start: [0.0; 2],
            voice_off: [grain_len; 2],
            hop_phase: 0,
            next_voice: 0,
            corr_ref: vec![0.0; (rate * CORR_SECS) as usize],
            search_radius: (rate * SEARCH_SECS) as usize,
        }
    }

    /// Drop every grain in flight: the next tick starts a fresh one at the
    /// playhead. For discontinuities that must NOT be crossfaded (a load,
    /// a seek, a cue jump) — an ordinary tempo change needs none, the
    /// alignment search absorbs it.
    pub fn reset(&mut self) {
        self.voice_off = [self.grain_len; 2];
        self.hop_phase = 0;
        self.next_voice = 0;
    }

    /// Advance one output sample and report where the live voices are
    /// reading. `pos` is the virtual playhead in source frames and `step`
    /// the natural read increment per output sample (source rate / engine
    /// rate, negated to play backwards); `ch0` is the channel the
    /// alignment correlates on — the same one every call, so grains stay
    /// coherent.
    pub fn tick(&mut self, pos: f64, step: f64, ch0: &[f32]) -> [Option<Tap>; 2] {
        // A grain is due every hop OUTPUT samples; the stretch is entirely
        // in how far `pos` has travelled since the last one.
        if self.hop_phase == 0 {
            let v = self.next_voice;
            let other = 1 - v;
            let start = if self.voice_off[other] < self.grain_len {
                let natural = self.voice_start[other] + self.voice_off[other] as f64 * step;
                self.align(pos, natural, step, ch0)
            } else {
                pos
            };
            self.voice_start[v] = start;
            self.voice_off[v] = 0;
            self.next_voice = other;
        }
        self.hop_phase += 1;
        if self.hop_phase >= self.hop {
            self.hop_phase = 0;
        }

        let mut taps = [None, None];
        for (v, tap) in taps.iter_mut().enumerate() {
            let off = self.voice_off[v];
            if off < self.grain_len {
                *tap = Some(Tap {
                    pos: self.voice_start[v] + off as f64 * step,
                    gain: self.window[off],
                });
                self.voice_off[v] = off + 1;
            }
        }
        taps
    }

    /// WSOLA alignment: the start within ±`search_radius` of `target`
    /// whose content best matches the natural continuation of the grain
    /// already playing. Bounded work, no allocation.
    fn align(&mut self, target: f64, natural: f64, step: f64, ch0: &[f32]) -> f64 {
        if ch0.is_empty() {
            return target;
        }
        for (k, r) in self.corr_ref.iter_mut().enumerate() {
            *r = sample_at(ch0, natural + k as f64 * step);
        }
        let mut best_d = 0i64;
        let mut best_score = f32::NEG_INFINITY;
        let radius = self.search_radius as i64;
        for d in -radius..=radius {
            let cand = target + d as f64;
            let mut score = 0.0f32;
            for (k, &r) in self.corr_ref.iter().enumerate() {
                score += r * sample_at(ch0, cand + k as f64 * step);
            }
            if score > best_score {
                best_score = score;
                best_d = d;
            }
        }
        target + best_d as f64
    }
}

/// Linearly interpolated read; silence outside the buffer.
#[inline]
pub fn sample_at(chan: &[f32], pos: f64) -> f32 {
    if pos < 0.0 {
        return 0.0;
    }
    let i0 = pos as usize;
    if i0 >= chan.len() {
        return 0.0;
    }
    let frac = (pos - i0 as f64) as f32;
    if frac == 0.0 || i0 + 1 >= chan.len() {
        chan[i0]
    } else {
        chan[i0] * (1.0 - frac) + chan[i0 + 1] * frac
    }
}
