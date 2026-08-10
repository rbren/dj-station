//! 6-channel DC-coupled mixer.
//!
//! Each channel is `in * level`, where `level` is a bipolar attenuverter
//! (-1..+1, centre = off, fully clockwise = unity, fully counter-clockwise
//! = inverted unity). Level CV goes straight into the `lvl` jack — a wire
//! adds to the fader baseline.
//!
//! The sum is scaled by the master level and clamped to the ±10 V rails.
//! `out` is the unity sum, `inv` its exact inverse. No AC coupling: the
//! module mixes CV and offsets as faithfully as audio.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const CHANNELS: usize = 6;
const IN_MASTER: usize = CHANNELS * 2;
const RAIL: f32 = 10.0;

pub struct Mixer;

impl Module for Mixer {
    const N_INPUTS: usize = CHANNELS * 2 + 1;
    const N_OUTPUTS: usize = 2;

    fn new(_ctx: &InitCtx) -> Self {
        Mixer
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        for s in 0..n {
            let mut sum = 0.0f32;
            for ch in 0..CHANNELS {
                let signal = io.inputs[ch * 2][s];
                let level = io.inputs[ch * 2 + 1][s].clamp(-1.0, 1.0);
                sum += signal * level;
            }
            let master = (io.inputs[IN_MASTER][s] * 0.1).clamp(0.0, 1.0);
            let out = (sum * master).clamp(-RAIL, RAIL);
            io.outputs[0][s] = out;
            io.outputs[1][s] = -out;
        }
    }
}

export_module!(Mixer);
