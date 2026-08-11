//! E2E golden audio case for the Camera module.
//!
//! The camera's video feed is pure app-layer (getUserMedia in the panel
//! UI, ephemeral enablement — nothing camera-related persists in the
//! patch), so on the DSP side the module is a buffered pass-through:
//! this case puts it inline between an oscillator and a VCA and asserts
//! the audio is unchanged by its presence. It also proves the module
//! round-trips through patch save/load like any other node.

use crate::common::e2e::{check_case, regen, write_events, EventsFile};
use dj_engine::{Engine, EngineConfig};

fn regen_camera_thru() {
    let dir = crate::common::e2e::case_dir("camera-thru-voice");
    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();

    // Osc -> camera (inline pass-through) -> VCA (half gain) -> out.
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("cam1", "com.dj.camera").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "cam1", "in").unwrap();
    e.connect("cam1", "thru", "vca1", "in").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();
    e.set_knob_position("vca1", "cv", 0.5).unwrap();

    e.save_patch(&dir.join("patch"), "e2e-camera-thru-voice")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.5));
}

#[test]
fn e2e_camera_thru_voice() {
    if regen() {
        regen_camera_thru();
    }
    check_case("camera-thru-voice");
}
