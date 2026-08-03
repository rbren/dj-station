//! Native Gain module (`native-1` escape hatch sample): the exact same DSP
//! as the WASM VCA — `out = in * gain`, `gain` input in [0, 10] maps
//! linearly to [0, 1] — so the conformance suite can assert the native and
//! WASM backends produce identical audio.
//!
//! Native modules are unsandboxed, trusted code; `process` follows the RT
//! rules (no allocation/blocking/syscalls) on the honor system.

use dj_module_sdk::{export_native_module, InitCtx, Module, ProcessIo};

const IN_SIGNAL: usize = 0;
const IN_GAIN: usize = 1;

pub struct GainNative {
    /// Extra multiplier settable via param 0 (exercises on_param + state
    /// save/load across the C ABI).
    boost: f32,
}

impl Module for GainNative {
    const N_INPUTS: usize = 2;
    const N_OUTPUTS: usize = 1;

    fn new(_ctx: &InitCtx) -> Self {
        GainNative { boost: 1.0 }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        for s in 0..n {
            let gain = (io.inputs[IN_GAIN][s] * 0.1).clamp(0.0, 1.0);
            io.outputs[0][s] = io.inputs[IN_SIGNAL][s] * gain * self.boost;
        }
    }

    fn on_param(&mut self, index: u32, value: f32) {
        if index == 0 {
            self.boost = value;
        }
    }

    fn save_state(&self) -> Vec<u8> {
        self.boost.to_le_bytes().to_vec()
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 4 {
            self.boost = f32::from_le_bytes(bytes[..4].try_into().unwrap());
        }
    }
}

export_native_module!(GainNative);
