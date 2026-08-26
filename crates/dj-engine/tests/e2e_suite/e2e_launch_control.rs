//! E2E golden audio case for the Launch Control XL module.
//!
//! `launchcontrol-fader-button`: column 1's fader rides an oscillator's
//! level while its Track Focus button gates an ADSR on a second VCA — one
//! case covering both control kinds the surface produces (continuous CC
//! knobs/faders and momentary note buttons).
//!
//! The surface messages come from the sidecar's `launch_control` section
//! and go in through `launchcontrol_inject`, the synthetic seam: the
//! golden renders identically with no controller attached, which is the
//! only way CI ever runs it.

use crate::common::e2e::{check_case, regen, write_events, EventsFile, LaunchControlEventSpec};
use dj_engine::{Engine, EngineConfig};

fn regen_launchcontrol_fader_button() {
    let dir = crate::common::e2e::case_dir("launchcontrol-fader-button");

    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();
    e.add_module("lcxl1", dj_engine::LAUNCH_CONTROL_ID).unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("adsr1", "com.dj.adsr").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("vca2", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("lcxl1", "c1_fader", "vca1", "cv").unwrap();
    e.connect("lcxl1", "c1_focus", "adsr1", "gate").unwrap();
    e.connect("vca1", "out", "vca2", "in").unwrap();
    e.connect("adsr1", "env", "vca2", "cv").unwrap();
    e.connect("vca2", "out", "out1", "l").unwrap();
    // Wired inputs add to the knob baseline; zero both gain knobs so the
    // fader and the envelope alone shape the level.
    e.set_knob_value("vca1", "cv", 0.0).unwrap();
    e.set_knob_value("vca2", "cv", 0.0).unwrap();
    e.save_patch(&dir.join("patch"), "e2e-launchcontrol-fader-button")
        .unwrap();

    let msg = |frame: u64, data: [u8; 3]| LaunchControlEventSpec {
        instance: "lcxl1".into(),
        frame,
        data,
    };
    write_events(
        &dir,
        &EventsFile {
            seconds: 1.0,
            launch_control: vec![
                // Fader at a third, button pressed (envelope attacks).
                msg(0, [0xB8, 77, 40]),
                msg(0, [0x98, 41, 127]),
                // Fader swept to full mid-note.
                msg(12_000, [0xB8, 77, 127]),
                // Button released: the release tail plays under a fader
                // that keeps moving, so both paths are audible.
                msg(24_000, [0x88, 41, 0]),
                msg(27_000, [0xB8, 77, 64]),
            ],
            ..EventsFile::default()
        },
    );
}

#[test]
fn e2e_launchcontrol_fader_button() {
    if regen() {
        regen_launchcontrol_fader_button();
    }
    check_case("launchcontrol-fader-button");
}

/// `launchcontrol-override-fader`: the same fader, wired the way the APP
/// wires it — `auto_wire_style_on_connect` puts a surface wire into
/// Override, so the fader IS the VCA's gain. The gain knob is saved wide
/// open on purpose: were the mode ever to fall back to CV, the patch
/// would render at full level throughout instead of following the fader.
fn regen_launchcontrol_override_fader() {
    let dir = crate::common::e2e::case_dir("launchcontrol-override-fader");

    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();
    e.add_module("lcxl1", dj_engine::LAUNCH_CONTROL_ID).unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("lcxl1", "c1_fader", "vca1", "cv").unwrap();
    e.auto_wire_style_on_connect("lcxl1", "c1_fader", "vca1", "cv")
        .unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();
    e.set_knob_value("vca1", "cv", 10.0).unwrap();
    e.save_patch(&dir.join("patch"), "e2e-launchcontrol-override-fader")
        .unwrap();

    let msg = |frame: u64, data: [u8; 3]| LaunchControlEventSpec {
        instance: "lcxl1".into(),
        frame,
        data,
    };
    write_events(
        &dir,
        &EventsFile {
            seconds: 0.5,
            launch_control: vec![
                // Silent until the fader moves: an override jack reads the
                // wire, not the knob it is drawn over.
                msg(4_000, [0xB8, 77, 32]),
                msg(10_000, [0xB8, 77, 96]),
                msg(16_000, [0xB8, 77, 0]),
            ],
            ..EventsFile::default()
        },
    );
}

#[test]
fn e2e_launchcontrol_override_fader() {
    if regen() {
        regen_launchcontrol_override_fader();
    }
    check_case("launchcontrol-override-fader");
}
