//! Feed-forward stereo compressor with a soft knee and a sidechain input.
//!
//! Levels are referenced to the modular audio nominal of 5 V = 0 dBFS, so
//! `threshold` reads in familiar dBFS. The detector is a peak follower on
//! `max(|L|, |R|)`; patching `sidechain` replaces it (classic ducking).
//! Attack/release smooth the gain reduction in the dB domain, which keeps
//! the timing independent of programme level.
//!
//! `gr` outputs the current gain reduction as a positive CV, 0.5 V per dB
//! (0 V = no reduction, 10 V = 20 dB), so it can drive other modules.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_L: usize = 0;
const IN_R: usize = 1;
const IN_SIDECHAIN: usize = 2;
const IN_THRESHOLD: usize = 3;
const IN_RATIO: usize = 4;
const IN_ATTACK: usize = 5;
const IN_RELEASE: usize = 6;
const IN_KNEE: usize = 7;
const IN_MAKEUP: usize = 8;

/// Volts at 0 dBFS (PRD §4: audio outputs are nominally ±5).
const FULL_SCALE: f32 = 5.0;
/// Detector floor, dB — quieter than this is treated as silence.
const FLOOR_DB: f32 = -120.0;
/// Volts per dB on the gain-reduction output.
const GR_VOLTS_PER_DB: f32 = 0.5;

#[inline]
fn to_db(x: f32) -> f32 {
    if x > 1e-9 {
        20.0 * (x / FULL_SCALE).log10()
    } else {
        FLOOR_DB
    }
}

#[inline]
fn from_db(db: f32) -> f32 {
    (10.0f32).powf(db / 20.0)
}

/// One-pole coefficient for a time constant in seconds.
#[inline]
fn time_coeff(secs: f32, sample_rate: f32) -> f32 {
    1.0 - (-1.0 / (secs.max(1e-5) * sample_rate)).exp()
}

pub struct Compressor {
    sample_rate: f32,
    /// Current gain reduction in dB (>= 0).
    reduction_db: f32,
}

impl Module for Compressor {
    const N_INPUTS: usize = 9;
    const N_OUTPUTS: usize = 3;

    fn new(ctx: &InitCtx) -> Self {
        Compressor {
            sample_rate: ctx.sample_rate,
            reduction_db: 0.0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        let threshold = io.inputs[IN_THRESHOLD][0].clamp(-90.0, 12.0);
        let ratio = io.inputs[IN_RATIO][0].clamp(1.0, 100.0);
        let attack = time_coeff(io.inputs[IN_ATTACK][0], self.sample_rate);
        let release = time_coeff(io.inputs[IN_RELEASE][0], self.sample_rate);
        let knee = io.inputs[IN_KNEE][0].clamp(0.0, 48.0);
        let makeup = from_db(io.inputs[IN_MAKEUP][0].clamp(-24.0, 48.0));
        let external_sc = io.connected_inputs.is_connected(IN_SIDECHAIN);

        for s in 0..n {
            let l = io.inputs[IN_L][s];
            let r = io.inputs[IN_R][s];
            let detector = if external_sc {
                io.inputs[IN_SIDECHAIN][s].abs()
            } else {
                l.abs().max(r.abs())
            };
            let level_db = to_db(detector);

            // Static curve: soft knee of width `knee` centred on threshold.
            let over = level_db - threshold;
            let target_db = if knee > 0.0 && over > -0.5 * knee && over < 0.5 * knee {
                let t = over + 0.5 * knee;
                (1.0 / ratio - 1.0) * t * t / (2.0 * knee)
            } else if over >= 0.5 * knee {
                (1.0 / ratio - 1.0) * over
            } else {
                0.0
            };
            // `target_db` is <= 0; track it as positive reduction.
            let target = -target_db;
            let coeff = if target > self.reduction_db {
                attack
            } else {
                release
            };
            self.reduction_db += coeff * (target - self.reduction_db);

            let gain = from_db(-self.reduction_db) * makeup;
            io.outputs[0][s] = l * gain;
            io.outputs[1][s] = r * gain;
            io.outputs[2][s] = (self.reduction_db * GR_VOLTS_PER_DB).clamp(0.0, 10.0);
        }
    }
}

export_module!(Compressor);
