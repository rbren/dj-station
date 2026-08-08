//! Noise: four coloured noise outputs plus a sampled random voltage.
//!
//! - `white` — uniform white noise, ±5.
//! - `pink` — -3 dB/oct, Paul Kellet's refined filter cascade.
//! - `red` — -6 dB/oct, white integrated with a 20 Hz leak (so it cannot
//!   wander off into DC).
//! - `blue` — the first difference of white (+6 dB/oct, the bright
//!   counterpart to red; "blue" is the usual panel label).
//! - `random` — a sample-and-hold voltage in ±5 that steps on every rising
//!   edge of `clock`. With nothing patched into `clock` it free-runs at the
//!   `rate` knob (0.05..50 Hz).
//!
//! The generator is a fixed-seed xorshift32, so a patch renders identically
//! every time (PRD §10.1 goldens depend on it). All colours are derived
//! from the same white sample, which keeps them phase-coherent and costs
//! one PRNG step per frame.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const AMPLITUDE: f32 = 5.0;
const SEED: u32 = 0x1234_5678;

/// Gains chosen so every colour lands near 2 V RMS with peaks inside the
/// nominal ±10 (measured against the white reference).
const PINK_GAIN: f32 = 0.22;
const RED_GAIN: f32 = 14.0;
const BLUE_GAIN: f32 = 0.5;
/// One-pole leak for the red integrator (~20 Hz at 48 kHz).
const RED_LEAK: f32 = 0.0026;

const IN_CLOCK: usize = 0;
const IN_RATE: usize = 1;

const OUT_WHITE: usize = 0;
const OUT_PINK: usize = 1;
const OUT_RED: usize = 2;
const OUT_BLUE: usize = 3;
const OUT_RANDOM: usize = 4;

pub struct Noise {
    sample_rate: f32,
    rng: u32,
    pink: [f32; 7],
    red: f32,
    last_white: f32,
    sample_hold: f32,
    clock_phase: f32,
    last_clock: f32,
}

impl Noise {
    #[inline]
    fn next_u32(&mut self) -> u32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        x
    }

    /// Uniform white in [-1, 1].
    #[inline]
    fn white(&mut self) -> f32 {
        self.next_u32() as f32 * (2.0 / 4_294_967_295.0) - 1.0
    }

    /// Paul Kellet's refined pink filter (-3 dB/oct from ~10 Hz up).
    #[inline]
    fn pink(&mut self, w: f32) -> f32 {
        let b = &mut self.pink;
        b[0] = 0.99886 * b[0] + w * 0.0555179;
        b[1] = 0.99332 * b[1] + w * 0.0750759;
        b[2] = 0.96900 * b[2] + w * 0.153_852;
        b[3] = 0.86650 * b[3] + w * 0.3104856;
        b[4] = 0.55000 * b[4] + w * 0.5329522;
        b[5] = -0.7616 * b[5] - w * 0.0168980;
        let out = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362;
        b[6] = w * 0.115926;
        out
    }
}

impl Module for Noise {
    const N_INPUTS: usize = 2;
    const N_OUTPUTS: usize = 5;

    fn new(ctx: &InitCtx) -> Self {
        let mut n = Noise {
            sample_rate: ctx.sample_rate.max(1.0),
            rng: SEED,
            pink: [0.0; 7],
            red: 0.0,
            last_white: 0.0,
            sample_hold: 0.0,
            clock_phase: 0.0,
            last_clock: 0.0,
        };
        n.sample_hold = n.white();
        n
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let clocked = io.connected_inputs.is_connected(IN_CLOCK);
        let n = io.outputs[0].len();
        for s in 0..n {
            let w = self.white();
            let pink = self.pink(w);
            self.red = self.red * (1.0 - RED_LEAK) + w * RED_LEAK;
            let blue = BLUE_GAIN * (w - self.last_white);
            self.last_white = w;

            // Sample & hold: external clock edges when patched, otherwise
            // the internal rate knob.
            let step = if clocked {
                let c = io.inputs[IN_CLOCK][s];
                let edge = c >= 1.0 && self.last_clock < 1.0;
                self.last_clock = c;
                edge
            } else {
                let rate = io.inputs[IN_RATE][s].clamp(0.0, 1_000.0);
                self.clock_phase += rate / self.sample_rate;
                if self.clock_phase >= 1.0 {
                    self.clock_phase -= self.clock_phase.floor();
                    true
                } else {
                    false
                }
            };
            if step {
                self.sample_hold = self.white();
            }

            io.outputs[OUT_WHITE][s] = AMPLITUDE * w;
            io.outputs[OUT_PINK][s] = AMPLITUDE * PINK_GAIN * pink;
            io.outputs[OUT_RED][s] = AMPLITUDE * RED_GAIN * self.red;
            io.outputs[OUT_BLUE][s] = AMPLITUDE * blue;
            io.outputs[OUT_RANDOM][s] = AMPLITUDE * self.sample_hold;
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(12);
        out.extend_from_slice(&self.rng.to_le_bytes());
        out.extend_from_slice(&self.sample_hold.to_le_bytes());
        out.extend_from_slice(&self.clock_phase.to_le_bytes());
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 12 {
            // xorshift is stuck at zero, so a zero seed is never valid.
            let rng = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
            self.rng = if rng == 0 { SEED } else { rng };
            self.sample_hold = f32::from_le_bytes(bytes[4..8].try_into().unwrap());
            self.clock_phase = f32::from_le_bytes(bytes[8..12].try_into().unwrap());
        }
    }
}

export_module!(Noise);
