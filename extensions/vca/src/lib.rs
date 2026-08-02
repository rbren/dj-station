//! VCA module: `out = in * gain`, where the `cv` input in [0, 10]
//! maps linearly to gain [0, 1] (unity at 10).

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_SIGNAL: usize = 0;
const IN_CV: usize = 1;

pub struct Vca;

impl Module for Vca {
    const N_INPUTS: usize = 2;
    const N_OUTPUTS: usize = 1;

    fn new(_ctx: &InitCtx) -> Self {
        Vca
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        for s in 0..n {
            let gain = (io.inputs[IN_CV][s] * 0.1).clamp(0.0, 1.0);
            io.outputs[0][s] = io.inputs[IN_SIGNAL][s] * gain;
        }
    }
}

export_module!(Vca);
