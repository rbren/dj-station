//! E2E golden audio cases for the Utilities modules (PRD §10.1).
//!
//! Serialized patches covering the batch:
//! - `utilities-quantized-voice`: LFO -> attenuverter -> quantizer ->
//!   oscillator -> mixer, i.e. a pentatonic arpeggio driven by a saw sweep.
//! - `utilities-logic-switch`: a square clock distributed by the mult,
//!   converted to triggers by the logic module, clocking the sequential
//!   switch that selects between attenuverter-generated pitches.
//! - `utilities-mixer-stereo-pan`: two oscillators panned apart on the
//!   stereo mixer (one modulated by an LFO wired into the pan jack),
//!   rendered to a stereo master.
//! - `utilities-attenuverter1-vibrato`: a sine LFO tamed by the
//!   single-channel attenuverter (small atten, offset carrying the base
//!   pitch) into an oscillator's pitch — a vibrato around E4.
//!
//! The shared harness lives in `tests/common/e2e.rs`.

use crate::common::e2e::{check_case, regen, write_events, EventsFile};
use dj_engine::{Engine, EngineConfig};

fn mono_engine() -> Engine {
    Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap()
}

fn regen_quantized_voice() {
    let dir = crate::common::e2e::case_dir("utilities-quantized-voice");
    let mut e = mono_engine();
    e.add_module("lfo", "com.dj.oscillator").unwrap();
    e.add_module("att", "com.dj.attenuverter").unwrap();
    e.add_module("quant", "com.dj.quantizer").unwrap();
    e.add_module("voice", "com.dj.oscillator").unwrap();
    e.add_module("mix", "com.dj.mixer").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    // Saw LFO at ~8 Hz, attenuated to a two-octave sweep.
    e.set_knob_position("lfo", "waveform", 1.0 / 3.0).unwrap();
    e.set_knob_value("lfo", "pitch", -5.0).unwrap();
    e.connect("lfo", "audio", "att", "in1").unwrap();
    e.set_knob_value("att", "atten1", 0.2).unwrap();

    // Quantized to a pentatonic major scale rooted at C.
    e.connect("att", "out1", "quant", "in").unwrap();
    e.set_knob_position("quant", "scale", 4.0 / 9.0).unwrap();
    e.connect("quant", "out", "voice", "pitch").unwrap();

    // Voice through the mixer at half master level.
    e.connect("voice", "audio", "mix", "in1_l").unwrap();
    e.set_knob_value("mix", "lvl1", 10.0).unwrap();
    e.set_knob_value("mix", "master", 5.0).unwrap();
    e.connect("mix", "out_l", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-utilities-quantized-voice")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.5));
}

fn regen_logic_switch() {
    let dir = crate::common::e2e::case_dir("utilities-logic-switch");
    let mut e = mono_engine();
    e.add_module("clk", "com.dj.oscillator").unwrap();
    e.add_module("mult", "com.dj.mult").unwrap();
    e.add_module("lg", "com.dj.logic").unwrap();
    e.add_module("pitches", "com.dj.attenuverter").unwrap();
    e.add_module("sw", "com.dj.seq_switch").unwrap();
    e.add_module("voice", "com.dj.oscillator").unwrap();
    e.add_module("mix", "com.dj.mixer").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    // Square clock at ~16 Hz, distributed through the buffered mult.
    e.set_knob_position("clk", "waveform", 2.0 / 3.0).unwrap();
    e.set_knob_value("clk", "pitch", -4.0).unwrap();
    e.connect("clk", "audio", "mult", "a_in").unwrap();

    // Gate to trigger: 10 ms pulses clock the switch.
    e.connect("mult", "a1", "lg", "g2t_in").unwrap();
    e.set_knob_value("lg", "trig_ms", 10.0).unwrap();
    e.connect("lg", "trig", "sw", "clock").unwrap();

    // Four pitches (C4, E4, G4, A4 in 1V/oct) as attenuverter offsets.
    for (ch, semitones) in [0.0f32, 4.0, 7.0, 9.0].iter().enumerate() {
        e.set_knob_value("pitches", &format!("offset{}", ch + 1), semitones / 12.0)
            .unwrap();
        e.connect(
            "pitches",
            &format!("out{}", ch + 1),
            "sw",
            &format!("i{}", ch + 1),
        )
        .unwrap();
    }
    e.set_knob_position("sw", "steps", 2.0 / 6.0).unwrap(); // 4 steps
    e.connect("sw", "out", "voice", "pitch").unwrap();

    e.connect("voice", "audio", "mix", "in1_l").unwrap();
    e.set_knob_value("mix", "lvl1", 10.0).unwrap();
    e.set_knob_value("mix", "master", 5.0).unwrap();
    e.connect("mix", "out_l", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-utilities-logic-switch")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.5));
}

fn regen_mixer_stereo_pan() {
    let dir = crate::common::e2e::case_dir("utilities-mixer-stereo-pan");
    let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("osc2", "com.dj.oscillator").unwrap();
    e.add_module("lfo", "com.dj.oscillator").unwrap();
    e.add_module("mix", "com.dj.mixer").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    // Voice 1 (C4) panned half left; voice 2 (G4) auto-panned by a slow
    // sine LFO riding the pan jack on top of a centred knob.
    e.connect("osc1", "audio", "mix", "in1_l").unwrap();
    e.set_knob_value("mix", "lvl1", 10.0).unwrap();
    e.set_knob_value("mix", "pan1", -5.0).unwrap();

    e.set_knob_value("osc2", "pitch", 7.0 / 12.0).unwrap();
    e.connect("osc2", "audio", "mix", "in2_l").unwrap();
    e.set_knob_value("mix", "lvl2", 10.0).unwrap();
    e.set_knob_value("lfo", "pitch", -7.0).unwrap();
    e.connect("lfo", "audio", "mix", "pan2").unwrap();

    e.set_knob_value("mix", "master", 5.0).unwrap();
    e.connect("mix", "out_l", "out1", "l").unwrap();
    e.connect("mix", "out_r", "out1", "r").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-utilities-mixer-stereo-pan")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.5));
}

fn regen_attenuverter1_vibrato() {
    let dir = crate::common::e2e::case_dir("utilities-attenuverter1-vibrato");
    let mut e = mono_engine();
    e.add_module("lfo", "com.dj.oscillator").unwrap();
    e.add_module("att", "com.dj.attenuverter1").unwrap();
    e.add_module("voice", "com.dj.oscillator").unwrap();
    e.add_module("mix", "com.dj.mixer").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    // Sine LFO at ~6 Hz, shrunk to a subtle vibrato depth; the offset
    // carries the base pitch (E4 in 1V/oct).
    e.set_knob_value("lfo", "pitch", -5.4).unwrap();
    e.connect("lfo", "audio", "att", "in").unwrap();
    e.set_knob_value("att", "atten", 0.02).unwrap();
    e.set_knob_value("att", "offset", 4.0 / 12.0).unwrap();
    e.connect("att", "out", "voice", "pitch").unwrap();

    e.connect("voice", "audio", "mix", "in1_l").unwrap();
    e.set_knob_value("mix", "lvl1", 10.0).unwrap();
    e.set_knob_value("mix", "master", 5.0).unwrap();
    e.connect("mix", "out_l", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-utilities-attenuverter1-vibrato")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.5));
}

#[test]
fn e2e_utilities_quantized_voice() {
    if regen() {
        regen_quantized_voice();
    }
    check_case("utilities-quantized-voice");
}

#[test]
fn e2e_utilities_logic_switch() {
    if regen() {
        regen_logic_switch();
    }
    check_case("utilities-logic-switch");
}

#[test]
fn e2e_utilities_mixer_stereo_pan() {
    if regen() {
        regen_mixer_stereo_pan();
    }
    check_case("utilities-mixer-stereo-pan");
}

#[test]
fn e2e_utilities_attenuverter1_vibrato() {
    if regen() {
        regen_attenuverter1_vibrato();
    }
    check_case("utilities-attenuverter1-vibrato");
}
