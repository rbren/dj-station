//! Camera — a live webcam monitor for the rack.
//!
//! The video feed is pure app-layer: the module's custom panel UI
//! (`ui-src/CameraUI.tsx`) opens the webcam with `getUserMedia` and renders
//! a `<video>` element. Nothing about the camera ever touches the RT
//! thread, and camera enablement is deliberately ephemeral app state (not
//! persisted in the patch): whether a camera exists — and whether the user
//! wants it on — is a property of the machine and the moment, not of the
//! patch.
//!
//! The DSP side is a buffered pass-through (`in` -> `thru`), so the panel
//! can sit inline in a signal chain like the scope does without altering
//! the audio.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

pub struct Camera;

impl Module for Camera {
    const N_INPUTS: usize = 1;
    const N_OUTPUTS: usize = 1;

    fn new(_ctx: &InitCtx) -> Self {
        Camera
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        for s in 0..n {
            io.outputs[0][s] = io.inputs[0][s];
        }
    }
}

export_module!(Camera);
