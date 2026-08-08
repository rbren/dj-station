//! 8 independent attenuverter/offset channels: `out = in * atten + offset`.
//!
//! Calibration is exact and deliberately boring:
//! - `atten` spans -1..+1 with the knob centre at exactly 0 (signal muted),
//!   fully clockwise at +1 (unity, the default) and fully
//!   counter-clockwise at -1 (inverted unity).
//! - `offset` spans -10..+10 V with the knob centre at exactly 0 V.
//!
//! Both controls are ordinary jacks, so either can be driven by a wire and
//! the channel becomes a ring modulator (`atten`) or a summer (`offset`).
//! The result is clamped to the ±10 V rails.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const CHANNELS: usize = 8;
const RAIL: f32 = 10.0;

pub struct Attenuverter;

impl Module for Attenuverter {
    const N_INPUTS: usize = CHANNELS * 3;
    const N_OUTPUTS: usize = CHANNELS;

    fn new(_ctx: &InitCtx) -> Self {
        Attenuverter
    }

    fn process(&mut self, io: &mut ProcessIo) {
        for ch in 0..CHANNELS {
            let n = io.outputs[ch].len();
            for s in 0..n {
                let signal = io.inputs[ch * 3][s];
                let atten = io.inputs[ch * 3 + 1][s].clamp(-1.0, 1.0);
                let offset = io.inputs[ch * 3 + 2][s].clamp(-RAIL, RAIL);
                io.outputs[ch][s] = (signal * atten + offset).clamp(-RAIL, RAIL);
            }
        }
    }
}

export_module!(Attenuverter);
