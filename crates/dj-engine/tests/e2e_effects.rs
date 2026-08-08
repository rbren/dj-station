//! E2E golden audio cases for the Effects and Analysis modules.
//!
//! Three serialized patches cover the seven modules of the batch; the
//! harness (`tests/common/e2e.rs`) renders each patch offline and compares
//! it against `tests/e2e/goldens/<case>.wav`. Regenerate with
//! `REGEN_GOLDENS=1 cargo test -p dj-engine --release --test e2e_effects`.

mod common;

use common::e2e::{check_case, regen, write_events, EventsFile};
use dj_engine::{Engine, EngineConfig};

fn mono_engine() -> Engine {
    let config = EngineConfig {
        master_channels: 1,
        ..EngineConfig::default()
    };
    Engine::new(config, common::registry()).unwrap()
}

/// Saw -> delay (ping-pong, filtered feedback) -> reverb -> out.
fn regen_delay_reverb() {
    let dir = common::e2e::case_dir("fx-delay-reverb");
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("dly", "com.dj.delay").unwrap();
    e.add_module("rev", "com.dj.reverb").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "dly", "in_l").unwrap();
    e.connect("osc1", "audio", "dly", "in_r").unwrap();
    e.connect("dly", "out_l", "rev", "in_l").unwrap();
    e.connect("dly", "out_r", "rev", "in_r").unwrap();
    e.connect("rev", "out_l", "out1", "l").unwrap();
    e.set_knob_value("osc1", "pitch", -1.0).unwrap();
    e.set_knob_value("osc1", "waveform", 1.0).unwrap();
    e.set_knob_value("dly", "time", 0.125).unwrap();
    e.set_knob_value("dly", "feedback", 0.55).unwrap();
    e.set_knob_value("dly", "lowpass", 4000.0).unwrap();
    e.set_knob_value("dly", "mix", 0.5).unwrap();
    e.set_knob_position("dly", "pingpong", 1.0).unwrap();
    e.set_knob_value("rev", "size", 0.8).unwrap();
    e.set_knob_value("rev", "decay", 0.7).unwrap();
    e.set_knob_value("rev", "damping", 0.4).unwrap();
    e.set_knob_value("rev", "mix", 0.4).unwrap();
    e.save_patch(&dir.join("patch"), "e2e-fx-delay-reverb")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.75));
}

/// Sine -> modulation FX (chorus) -> compressor -> scope thru -> out.
fn regen_modfx_comp_scope() {
    let dir = common::e2e::case_dir("fx-modfx-comp-scope");
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("fx", "com.dj.modfx").unwrap();
    e.add_module("comp", "com.dj.compressor").unwrap();
    e.add_module("scope", "com.dj.scope").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "fx", "in_l").unwrap();
    e.connect("osc1", "audio", "fx", "in_r").unwrap();
    e.connect("fx", "out_l", "comp", "in_l").unwrap();
    e.connect("fx", "out_r", "comp", "in_r").unwrap();
    e.connect("comp", "out_l", "scope", "in").unwrap();
    e.connect("scope", "thru", "out1", "l").unwrap();
    e.set_knob_value("osc1", "waveform", 3.0).unwrap(); // triangle
    e.set_knob_value("fx", "mode", 0.0).unwrap(); // chorus
    e.set_knob_value("fx", "rate", 3.0).unwrap();
    e.set_knob_value("fx", "depth", 0.7).unwrap();
    e.set_knob_value("fx", "spread", 1.0).unwrap();
    e.set_knob_value("fx", "mix", 0.5).unwrap();
    e.set_knob_value("comp", "threshold", -18.0).unwrap();
    e.set_knob_value("comp", "ratio", 6.0).unwrap();
    e.set_knob_value("comp", "attack", 0.005).unwrap();
    e.set_knob_value("comp", "release", 0.12).unwrap();
    e.set_knob_value("comp", "makeup", 6.0).unwrap();
    e.save_patch(&dir.join("patch"), "e2e-fx-modfx-comp-scope")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.5));
}

/// Square -> granular -> resonator (modal, externally excited) -> out.
fn regen_granular_resonator() {
    let dir = common::e2e::case_dir("fx-granular-resonator");
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("gran", "com.dj.granular").unwrap();
    e.add_module("res", "com.dj.resonator").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "gran", "in_l").unwrap();
    e.connect("osc1", "audio", "gran", "in_r").unwrap();
    e.connect("gran", "out_l", "res", "in").unwrap();
    e.connect("res", "out_l", "out1", "l").unwrap();
    e.set_knob_value("osc1", "pitch", -2.0).unwrap();
    e.set_knob_value("osc1", "waveform", 2.0).unwrap();
    e.set_knob_value("gran", "density", 24.0).unwrap();
    e.set_knob_value("gran", "size", 0.06).unwrap();
    e.set_knob_value("gran", "position", 0.1).unwrap();
    e.set_knob_value("gran", "pitch", 0.5).unwrap();
    e.set_knob_value("gran", "texture", 0.4).unwrap();
    e.set_knob_value("gran", "spread", 0.6).unwrap();
    e.set_knob_value("gran", "mix", 1.0).unwrap();
    e.set_knob_value("res", "pitch", 0.0).unwrap();
    e.set_knob_value("res", "structure", 0.4).unwrap();
    e.set_knob_value("res", "brightness", 0.6).unwrap();
    e.set_knob_value("res", "damping", 0.5).unwrap();
    e.set_knob_value("res", "mix", 0.8).unwrap();
    e.save_patch(&dir.join("patch"), "e2e-fx-granular-resonator")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.75));
}

#[test]
fn e2e_fx_delay_reverb() {
    if regen() {
        regen_delay_reverb();
    }
    check_case("fx-delay-reverb");
}

#[test]
fn e2e_fx_modfx_comp_scope() {
    if regen() {
        regen_modfx_comp_scope();
    }
    check_case("fx-modfx-comp-scope");
}

#[test]
fn e2e_fx_granular_resonator() {
    if regen() {
        regen_granular_resonator();
    }
    check_case("fx-granular-resonator");
}
