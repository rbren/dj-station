//! Signal plumbing: buffered mult, merge (sum) and split (1-to-N switch).
//!
//! - **Mult**: two independent 4-way buffered mults. Bank B is normalled to
//!   bank A's input: with nothing patched into `b_in` the two banks chain
//!   and the module is a single 8-way mult. Patching `b_in` breaks the
//!   normal (classic Eurorack switched-jack behaviour, here via
//!   `io.connected_inputs`).
//! - **Merge**: sums the *patched* merge inputs. Unpatched jacks are
//!   ignored rather than contributing their (zero) constant, so merging
//!   offsets stays exact and an empty merge section is silent.
//! - **Split**: routes `split_in` to one of four outputs chosen by
//!   `split_sel`; the other three sit at 0 V.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const WAYS: usize = 4;
const IN_A: usize = 0;
const IN_B: usize = 1;
const IN_MERGE: usize = 2;
const IN_SPLIT: usize = 6;
const IN_SPLIT_SEL: usize = 7;

const OUT_A: usize = 0;
const OUT_B: usize = 4;
const OUT_MERGE: usize = 8;
const OUT_SPLIT: usize = 9;

const RAIL: f32 = 10.0;

pub struct Mult;

impl Module for Mult {
    const N_INPUTS: usize = 8;
    const N_OUTPUTS: usize = 13;

    fn new(_ctx: &InitCtx) -> Self {
        Mult
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        let b_patched = io.connected_inputs.is_connected(IN_B);
        let b_src = if b_patched { IN_B } else { IN_A };

        for way in 0..WAYS {
            for s in 0..n {
                io.outputs[OUT_A + way][s] = io.inputs[IN_A][s];
            }
            for s in 0..n {
                io.outputs[OUT_B + way][s] = io.inputs[b_src][s];
            }
        }

        for s in 0..n {
            io.outputs[OUT_MERGE][s] = 0.0;
        }
        for j in 0..WAYS {
            if !io.connected_inputs.is_connected(IN_MERGE + j) {
                continue;
            }
            for s in 0..n {
                io.outputs[OUT_MERGE][s] += io.inputs[IN_MERGE + j][s];
            }
        }
        for s in 0..n {
            io.outputs[OUT_MERGE][s] = io.outputs[OUT_MERGE][s].clamp(-RAIL, RAIL);
        }

        for way in 0..WAYS {
            for s in 0..n {
                let sel = (io.inputs[IN_SPLIT_SEL][s]
                    .round()
                    .clamp(0.0, (WAYS - 1) as f32)) as usize;
                io.outputs[OUT_SPLIT + way][s] = if sel == way {
                    io.inputs[IN_SPLIT][s]
                } else {
                    0.0
                };
            }
        }
    }
}

export_module!(Mult);
