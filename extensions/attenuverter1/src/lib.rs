//! Single attenuverter/offset channel: `out = in * atten + offset`.
//!
//! The one-column sibling of the 8-channel `attenuverter` module, with the
//! same deliberately boring calibration:
//! - `atten` spans -1..+1 with the knob centre at exactly 0 (signal muted),
//!   fully clockwise at +1 (unity, the default) and fully
//!   counter-clockwise at -1 (inverted unity).
//! - `offset` spans -10..+10 V with the knob centre at exactly 0 V.
//!
//! Both controls are ordinary jacks, so either can be driven by a wire and
//! the channel becomes a ring modulator (`atten`) or a summer (`offset`).
//! The result is clamped to the ±10 V rails.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const RAIL: f32 = 10.0;

pub struct Attenuverter1;

impl Module for Attenuverter1 {
    const N_INPUTS: usize = 3;
    const N_OUTPUTS: usize = 1;

    fn new(_ctx: &InitCtx) -> Self {
        Attenuverter1
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        for s in 0..n {
            let signal = io.inputs[0][s];
            let atten = io.inputs[1][s].clamp(-1.0, 1.0);
            let offset = io.inputs[2][s].clamp(-RAIL, RAIL);
            io.outputs[0][s] = (signal * atten + offset).clamp(-RAIL, RAIL);
        }
    }
}

export_module!(Attenuverter1);
