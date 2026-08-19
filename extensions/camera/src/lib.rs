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
//! The DSP side is empty — no jacks at all. The module exists purely to
//! host the panel UI (and the hand-tracking feed it produces).

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

pub struct Camera;

impl Module for Camera {
    const N_INPUTS: usize = 0;
    const N_OUTPUTS: usize = 0;

    fn new(_ctx: &InitCtx) -> Self {
        Camera
    }

    fn process(&mut self, _io: &mut ProcessIo) {}
}

export_module!(Camera);
