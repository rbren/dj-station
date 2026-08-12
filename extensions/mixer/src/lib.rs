//! 6-channel stereo mixer.
//!
//! Each channel is a stereo pair (`in{n}_l` / `in{n}_r`) with a level
//! fader and a pan/balance control. An unwired right input is normalled
//! to the left one, so a mono source patched into L alone pans across
//! the stereo field. `lvl` is unipolar (0..10, 10 = unity); `pan` is
//! ±10 V full scale (negative = left) with the classic balance law: the
//! favoured side stays at unity, the other fades linearly.
//!
//! The stereo sum is scaled by the master level and clamped to the
//! ±10 V rails. DC-coupled: mixes CV and offsets as faithfully as audio.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const CHANNELS: usize = 6;
/// Per-channel input stride: in_l, in_r, lvl, pan.
const STRIDE: usize = 4;
const IN_MASTER: usize = CHANNELS * STRIDE;
const RAIL: f32 = 10.0;

pub struct Mixer;

impl Module for Mixer {
    const N_INPUTS: usize = CHANNELS * STRIDE + 1;
    const N_OUTPUTS: usize = 2;

    fn new(_ctx: &InitCtx) -> Self {
        Mixer
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        for s in 0..n {
            let mut sum_l = 0.0f32;
            let mut sum_r = 0.0f32;
            for ch in 0..CHANNELS {
                let base = ch * STRIDE;
                let in_l = io.inputs[base][s];
                // R normalled to L when unwired (mono source pans).
                let in_r = if io.connected_inputs.is_connected(base + 1) {
                    io.inputs[base + 1][s]
                } else {
                    in_l
                };
                let lvl = (io.inputs[base + 2][s] * 0.1).clamp(0.0, 1.0);
                let pan = (io.inputs[base + 3][s] * 0.1).clamp(-1.0, 1.0);
                // Balance law: centre = unity both sides, panning fades
                // the opposite side only.
                let gain_l = (1.0 - pan).min(1.0);
                let gain_r = (1.0 + pan).min(1.0);
                sum_l += in_l * lvl * gain_l;
                sum_r += in_r * lvl * gain_r;
            }
            let master = (io.inputs[IN_MASTER][s] * 0.1).clamp(0.0, 1.0);
            io.outputs[0][s] = (sum_l * master).clamp(-RAIL, RAIL);
            io.outputs[1][s] = (sum_r * master).clamp(-RAIL, RAIL);
        }
    }
}

export_module!(Mixer);
