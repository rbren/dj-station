//! Dual VCA. Two independent DC-coupled amplifiers with a per-channel
//! linear/exponential response switch, an output offset, and a normalled
//! mix bus.
//!
//! * `out = in * gain(cv) + offset`, evaluated per sample. Nothing is
//!   AC-coupled, so a channel works just as well as a CV attenuator /
//!   offset generator as it does on audio.
//! * `resp = 0` — linear: `gain = cv / 10`, unity at +10 V.
//! * `resp = 1` — exponential: an ≈ 40 dB audio taper that still reaches
//!   exactly zero at 0 V, so a closed VCA is silent.
//! * Normalled chain (Quad-VCA style): with **In 2 unpatched**, channel 1's
//!   output is summed into Out 2, which makes the pair a two-into-one
//!   mixer without extra wiring. Patch In 2 and Out 2 carries channel 2
//!   alone.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_1: usize = 0;
const CV_1: usize = 1;
const RESP_1: usize = 2;
const OFFSET_1: usize = 3;
const IN_2: usize = 4;
const CV_2: usize = 5;
const RESP_2: usize = 6;
const OFFSET_2: usize = 7;

/// Steepness of the exponential taper (`exp(K) - 1` normalizes it to 1.0
/// at full CV); K = 5 is about 43 dB from the top of the range.
const EXP_K: f32 = 5.0;

pub struct VcaDual {
    exp_norm: f32,
}

impl VcaDual {
    #[inline]
    fn gain(&self, cv: f32, exponential: bool) -> f32 {
        let x = (cv * 0.1).clamp(0.0, 1.0);
        if exponential {
            ((EXP_K * x).exp() - 1.0) * self.exp_norm
        } else {
            x
        }
    }
}

impl Module for VcaDual {
    const N_INPUTS: usize = 8;
    const N_OUTPUTS: usize = 2;

    fn new(_ctx: &InitCtx) -> Self {
        VcaDual {
            exp_norm: 1.0 / (EXP_K.exp() - 1.0),
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        let normalled = !io.connected_inputs.is_connected(IN_2);
        for s in 0..n {
            let exp1 = io.inputs[RESP_1][s] >= 0.5;
            let exp2 = io.inputs[RESP_2][s] >= 0.5;
            let out1 =
                io.inputs[IN_1][s] * self.gain(io.inputs[CV_1][s], exp1) + io.inputs[OFFSET_1][s];
            let mut out2 =
                io.inputs[IN_2][s] * self.gain(io.inputs[CV_2][s], exp2) + io.inputs[OFFSET_2][s];
            if normalled {
                out2 += out1;
            }
            io.outputs[0][s] = out1;
            io.outputs[1][s] = out2;
        }
    }
}

export_module!(VcaDual);
