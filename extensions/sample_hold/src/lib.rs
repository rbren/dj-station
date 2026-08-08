//! Sample & hold / track & hold with a built-in noise source.
//!
//! * `mode = 0` — **sample & hold**: every rising edge on `trig` grabs one
//!   sample of the input and holds it until the next edge.
//! * `mode = 1` — **track & hold**: the output follows the input while
//!   `trig` is high and freezes when it goes low.
//!
//! The white noise generator is always running on the `noise` output and
//! is **normalled to the signal input**: with nothing patched to `in`, the
//! module is the classic clocked random-voltage source, and patching `in`
//! disconnects the noise from the sampler (it stays available on its own
//! jack). Noise comes from a fixed-seed xorshift32, so a patch renders the
//! same random sequence every time.
//!
//! `slew` glides the output towards each new value with a one-pole lag of
//! that time constant (0 = instant steps). In track & hold it doubles as a
//! lag processor on the tracked signal.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_SIGNAL: usize = 0;
const IN_TRIG: usize = 1;
const IN_MODE: usize = 2;
const IN_SLEW: usize = 3;

const OUT_MAIN: usize = 0;
const OUT_NOISE: usize = 1;

const AMPLITUDE: f32 = 5.0;
const SEED: u32 = 0x1D0F_5A17;
/// Below this the glide is treated as instant.
const MIN_SLEW: f32 = 1e-5;

pub struct SampleHold {
    sample_rate: f32,
    rng: u32,
    /// Most recently captured value and the (possibly slewed) output.
    target: f32,
    level: f32,
    last_trig: f32,
}

impl SampleHold {
    #[inline]
    fn noise(&mut self) -> f32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        AMPLITUDE * ((x >> 8) as f32 / 8_388_608.0 - 1.0)
    }
}

impl Module for SampleHold {
    const N_INPUTS: usize = 4;
    const N_OUTPUTS: usize = 2;

    fn new(ctx: &InitCtx) -> Self {
        SampleHold {
            sample_rate: ctx.sample_rate,
            rng: SEED,
            target: 0.0,
            level: 0.0,
            last_trig: 0.0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        let patched = io.connected_inputs.is_connected(IN_SIGNAL);
        for s in 0..n {
            let noise = self.noise();
            let source = if patched {
                io.inputs[IN_SIGNAL][s]
            } else {
                noise
            };
            let trig = io.inputs[IN_TRIG][s];
            let track = io.inputs[IN_MODE][s] >= 0.5;

            if track {
                if trig >= 1.0 {
                    self.target = source;
                }
            } else if trig >= 1.0 && self.last_trig < 1.0 {
                self.target = source;
            }
            self.last_trig = trig;

            let slew = io.inputs[IN_SLEW][s].max(0.0);
            if slew <= MIN_SLEW {
                self.level = self.target;
            } else {
                let coef = 1.0 - (-1.0 / (slew * self.sample_rate)).exp();
                self.level += (self.target - self.level) * coef;
            }

            io.outputs[OUT_MAIN][s] = self.level;
            io.outputs[OUT_NOISE][s] = noise;
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(12);
        out.extend_from_slice(&self.rng.to_le_bytes());
        out.extend_from_slice(&self.target.to_le_bytes());
        out.extend_from_slice(&self.level.to_le_bytes());
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 12 {
            self.rng = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
            self.target = f32::from_le_bytes(bytes[4..8].try_into().unwrap());
            self.level = f32::from_le_bytes(bytes[8..12].try_into().unwrap());
        }
    }
}

export_module!(SampleHold);
