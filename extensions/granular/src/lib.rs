//! Clouds-style granular processor.
//!
//! Incoming audio is recorded into a 4 s stereo circular buffer (allocated
//! once). Grains are launched from a fixed pool of 32 voices at `density`
//! grains/second (plus one per `trig` rising edge), each reading the buffer
//! from `position` seconds behind the write head at a playback rate of
//! 2^`pitch` (1V/oct transposition) through a Tukey window whose taper is
//! set by `texture` (smooth Hann at 0, nearly rectangular at 1).
//!
//! `spread` randomizes grain start position and stereo placement from a
//! seeded xorshift32 — deterministic, never the OS RNG. `freeze` stops
//! recording so the buffer becomes a frozen sound to scrub through, and
//! `feedback` re-records the granular output.
//!
//! Nothing allocates in `process`: the pool is fixed and inactive grains
//! are simply skipped.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_L: usize = 0;
const IN_R: usize = 1;
const IN_DENSITY: usize = 2;
const IN_SIZE: usize = 3;
const IN_POSITION: usize = 4;
const IN_PITCH: usize = 5;
const IN_TEXTURE: usize = 6;
const IN_SPREAD: usize = 7;
const IN_FEEDBACK: usize = 8;
const IN_FREEZE: usize = 9;
const IN_TRIG: usize = 10;
const IN_MIX: usize = 11;

const BUFFER_SECS: f32 = 4.0;
const MAX_GRAINS: usize = 32;
/// Soft-clip ceiling for the recorded (feedback) signal, in volts.
const CEILING: f32 = 8.0;

#[inline]
fn soft_clip(x: f32) -> f32 {
    if x.is_finite() {
        CEILING * (x / CEILING).tanh()
    } else {
        0.0
    }
}

/// Deterministic xorshift32 (PRD §5: modules must not use the OS RNG).
struct Rng(u32);

impl Rng {
    #[inline]
    fn next_f32(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x >> 8) as f32 / 16_777_216.0
    }
}

#[derive(Clone, Copy)]
struct Grain {
    active: bool,
    /// Fractional read position in the circular buffer.
    pos: f32,
    rate: f32,
    /// Window progress, 0..1.
    phase: f32,
    phase_inc: f32,
    /// Tukey taper fraction (1 = Hann, small = nearly rectangular).
    taper: f32,
    gain_l: f32,
    gain_r: f32,
}

impl Grain {
    const SILENT: Grain = Grain {
        active: false,
        pos: 0.0,
        rate: 1.0,
        phase: 0.0,
        phase_inc: 0.0,
        taper: 1.0,
        gain_l: 0.0,
        gain_r: 0.0,
    };

    /// Tukey window value at the grain's current phase.
    #[inline]
    fn window(&self) -> f32 {
        let edge = 0.5 * self.taper;
        let p = self.phase;
        if p < edge {
            0.5 * (1.0 - (core::f32::consts::PI * p / edge).cos())
        } else if p > 1.0 - edge {
            0.5 * (1.0 - (core::f32::consts::PI * (1.0 - p) / edge).cos())
        } else {
            1.0
        }
    }
}

pub struct Granular {
    sample_rate: f32,
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    mask: usize,
    write: usize,
    grains: [Grain; MAX_GRAINS],
    rng: Rng,
    spawn_acc: f32,
    last_trig: f32,
    fb_l: f32,
    fb_r: f32,
}

impl Granular {
    #[inline]
    fn read(buf: &[f32], mask: usize, pos: f32) -> f32 {
        let i = pos as usize & mask;
        let j = (i + 1) & mask;
        let f = pos - pos.floor();
        buf[i] + (buf[j] - buf[i]) * f
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn(
        &mut self,
        size_samples: f32,
        position: f32,
        rate: f32,
        taper: f32,
        spread: f32,
        span: f32,
    ) {
        let Some(slot) = self.grains.iter().position(|g| !g.active) else {
            return;
        };
        let jitter = spread * span * 0.25 * (self.rng.next_f32() - 0.5);
        let pan = 0.5 + spread * (self.rng.next_f32() - 0.5);
        let back = position * span + size_samples * rate + jitter;
        let len = self.buf_l.len() as f32;
        let mut pos = self.write as f32 - back;
        while pos < 0.0 {
            pos += len;
        }
        self.grains[slot] = Grain {
            active: true,
            pos,
            rate,
            phase: 0.0,
            phase_inc: 1.0 / size_samples.max(8.0),
            taper,
            gain_l: (pan * core::f32::consts::FRAC_PI_2).cos(),
            gain_r: (pan * core::f32::consts::FRAC_PI_2).sin(),
        };
    }
}

impl Module for Granular {
    const N_INPUTS: usize = 12;
    const N_OUTPUTS: usize = 2;

    fn new(ctx: &InitCtx) -> Self {
        let len = ((BUFFER_SECS * ctx.sample_rate) as usize + 4).next_power_of_two();
        Granular {
            sample_rate: ctx.sample_rate,
            buf_l: vec![0.0; len],
            buf_r: vec![0.0; len],
            mask: len - 1,
            write: 0,
            grains: [Grain::SILENT; MAX_GRAINS],
            rng: Rng(0x1234_5678),
            spawn_acc: 0.0,
            last_trig: 0.0,
            fb_l: 0.0,
            fb_r: 0.0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        let density = io.inputs[IN_DENSITY][0].clamp(0.01, 200.0);
        let size = io.inputs[IN_SIZE][0].clamp(0.002, 1.0);
        let position = io.inputs[IN_POSITION][0].clamp(0.0, 1.0);
        let pitch = io.inputs[IN_PITCH][0].clamp(-4.0, 4.0);
        let texture = io.inputs[IN_TEXTURE][0].clamp(0.0, 1.0);
        let spread = io.inputs[IN_SPREAD][0].clamp(0.0, 1.0);
        let feedback = io.inputs[IN_FEEDBACK][0].clamp(0.0, 0.95);
        let frozen = io.inputs[IN_FREEZE][0] >= 0.5;
        let mix = io.inputs[IN_MIX][0].clamp(0.0, 1.0);

        let rate = (2.0f32).powf(pitch);
        let size_samples = size * self.sample_rate;
        let taper = (1.0 - texture).clamp(0.1, 1.0);
        // Usable scrub span: everything except the newest grain's worth.
        let span = (self.buf_l.len() as f32 - size_samples * rate - 4.0).max(1.0);
        let spawn_inc = density / self.sample_rate;
        // Overlapping grains add up; compensate for the expected overlap.
        let norm = 1.0 / (density * size).max(1.0).sqrt();

        for s in 0..n {
            let in_l = io.inputs[IN_L][s];
            let in_r = io.inputs[IN_R][s];
            if !frozen {
                self.write = (self.write + 1) & self.mask;
                self.buf_l[self.write] = soft_clip(in_l + feedback * self.fb_l);
                self.buf_r[self.write] = soft_clip(in_r + feedback * self.fb_r);
            }

            self.spawn_acc += spawn_inc;
            while self.spawn_acc >= 1.0 {
                self.spawn_acc -= 1.0;
                self.spawn(size_samples, position, rate, taper, spread, span);
            }
            let trig = io.inputs[IN_TRIG][s];
            if trig >= 1.0 && self.last_trig < 1.0 {
                self.spawn(size_samples, position, rate, taper, spread, span);
            }
            self.last_trig = trig;

            let (mut wet_l, mut wet_r) = (0.0f32, 0.0f32);
            let len = self.buf_l.len() as f32;
            for g in self.grains.iter_mut() {
                if !g.active {
                    continue;
                }
                let w = g.window();
                wet_l += w * g.gain_l * Self::read(&self.buf_l, self.mask, g.pos);
                wet_r += w * g.gain_r * Self::read(&self.buf_r, self.mask, g.pos);
                g.pos += g.rate;
                if g.pos >= len {
                    g.pos -= len;
                }
                g.phase += g.phase_inc;
                if g.phase >= 1.0 {
                    g.active = false;
                }
            }
            // Dense settings can stack many grains in phase; the same
            // saturator that guards the feedback path caps the sum.
            wet_l = soft_clip(wet_l * norm);
            wet_r = soft_clip(wet_r * norm);
            self.fb_l = wet_l;
            self.fb_r = wet_r;

            io.outputs[0][s] = in_l * (1.0 - mix) + wet_l * mix;
            io.outputs[1][s] = in_r * (1.0 - mix) + wet_r * mix;
        }
    }

    fn save_state(&self) -> Vec<u8> {
        // The audio buffer is transient, but the grain scheduler is not:
        // keeping the PRNG and spawn phase keeps renders reproducible
        // across a hot reload.
        let mut out = Vec::with_capacity(8);
        out.extend_from_slice(&self.rng.0.to_le_bytes());
        out.extend_from_slice(&self.spawn_acc.to_le_bytes());
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 8 {
            self.rng.0 = u32::from_le_bytes(bytes[0..4].try_into().unwrap()).max(1);
            self.spawn_acc = f32::from_le_bytes(bytes[4..8].try_into().unwrap());
        }
    }
}

export_module!(Granular);
