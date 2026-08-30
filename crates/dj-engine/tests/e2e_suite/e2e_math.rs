//! E2E golden audio case for the Math module (PRD §10.1).
//!
//! `utilities-math-intervals`: a sine LFO into the Math module's `x`, one
//! expression — `(x * 0.3).sin() + i as f32 * 0.25` — read by two of its
//! eight outputs, so two oscillators wobble in parallel a minor third
//! apart. The expression rides in the serialized patch, which is what
//! makes this the round-trip test with ears: the golden can only match if
//! the saved text compiled back to the same program.

use crate::common::e2e::{check_case, regen, write_events, EventsFile};
use dj_engine::{Engine, EngineConfig};

fn regen_math_intervals() {
    let dir = crate::common::e2e::case_dir("utilities-math-intervals");
    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();
    e.add_module("lfo", "com.dj.oscillator").unwrap();
    e.add_module("m", "builtin.math").unwrap();
    e.add_module("voice1", "com.dj.oscillator").unwrap();
    e.add_module("voice2", "com.dj.oscillator").unwrap();
    e.add_module("mix", "com.dj.mixer4").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    // ~8 Hz sine into x; the expression folds it through sin() and offsets
    // each output by a quarter of an octave (three semitones).
    e.set_knob_value("lfo", "pitch", -5.0).unwrap();
    e.connect("lfo", "audio", "m", "x").unwrap();
    e.math_set_expr("m", "(x * 0.3).sin() + i as f32 * 0.25")
        .unwrap();

    e.connect("m", "out0", "voice1", "pitch").unwrap();
    e.connect("m", "out3", "voice2", "pitch").unwrap();
    e.connect("voice1", "audio", "mix", "in1_l").unwrap();
    e.connect("voice2", "audio", "mix", "in2_l").unwrap();
    e.set_knob_value("mix", "lvl1", 7.0).unwrap();
    e.set_knob_value("mix", "lvl2", 7.0).unwrap();
    e.set_knob_value("mix", "master", 5.0).unwrap();
    e.connect("mix", "out_l", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-utilities-math-intervals")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.5));
}

#[test]
fn e2e_math_intervals() {
    if regen() {
        regen_math_intervals();
    }
    check_case("utilities-math-intervals");
}
