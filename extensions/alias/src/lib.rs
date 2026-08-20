//! Alias — a nameable one-in/one-out pass-through.
//!
//! The whole point is the title bar: rename the panel (module renaming,
//! `engine/rename.rs`) and drop it inline to label a signal or mark a
//! patch point. The DSP copies `in` to `out` bit-identically — no gain,
//! no clamp, no state — exactly like the scope's `thru` jack, so an alias
//! can sit anywhere in a chain without changing the audio.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

pub struct Alias;

impl Module for Alias {
    const N_INPUTS: usize = 1;
    const N_OUTPUTS: usize = 1;

    fn new(_ctx: &InitCtx) -> Self {
        Alias
    }

    fn process(&mut self, io: &mut ProcessIo) {
        io.outputs[0].copy_from_slice(io.inputs[0]);
    }
}

export_module!(Alias);
