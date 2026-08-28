//! E2E golden audio for module bypass: the flag is saved in the patch, so
//! this case proves it survives serialization AND that a bypassed module
//! contributes nothing of its own — the render is the live filter's output
//! copied to both of the bypassed resonator's outputs.
//!
//! Regenerate with `./scripts/regen-goldens.sh`.

use crate::common::e2e::{check_case, regen, write_events, EventsFile};
use dj_engine::{Engine, EngineConfig};

/// Saw -> filter (live) -> resonator (BYPASSED, one input feeding a
/// stereo pair) -> out L/R.
fn regen_bypass_resonator() {
    let dir = crate::common::e2e::case_dir("bypass-resonator-thru");
    let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("flt", "com.dj.filter").unwrap();
    e.add_module("res", "com.dj.resonator").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "flt", "in").unwrap();
    e.connect("flt", "lp", "res", "in").unwrap();
    e.connect("res", "out_l", "out1", "l").unwrap();
    e.connect("res", "out_r", "out1", "r").unwrap();
    e.set_knob_value("osc1", "pitch", -1.0).unwrap();
    e.set_knob_value("osc1", "waveform", 1.0).unwrap(); // saw
    e.set_knob_value("flt", "cutoff", 0.0).unwrap();
    e.set_knob_value("flt", "res", 0.5).unwrap();
    // Settings the resonator would be audible with, if it ran at all.
    e.set_knob_value("res", "structure", 0.6).unwrap();
    e.set_knob_value("res", "brightness", 0.7).unwrap();
    e.set_knob_value("res", "mix", 1.0).unwrap();
    e.set_bypass("res", true).unwrap();
    e.save_patch(&dir.join("patch"), "e2e-bypass-resonator-thru")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.5));
}

#[test]
fn e2e_bypass_resonator_thru() {
    if regen() {
        regen_bypass_resonator();
    }
    check_case("bypass-resonator-thru");
}
