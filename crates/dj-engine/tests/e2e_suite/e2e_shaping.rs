//! E2E golden audio cases for the Shaping / Modulation module batch
//! (PRD §10.1). The harness lives in `tests/common/e2e.rs`; these cases
//! belong to this file and are regenerated only from here.

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

/// A full west-coast-ish shaping chain: saw -> wavefolder -> resonant
/// ladder filter -> dual VCA (with the channel-2 mix normalling in use).
fn regen_shaping_chain() {
    let dir = crate::common::e2e::case_dir("shaping-fold-ladder");
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("ws1", "com.dj.waveshaper").unwrap();
    e.add_module("flt1", "com.dj.filter").unwrap();
    e.add_module("vca1", "com.dj.vca_dual").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    e.set_knob_value("osc1", "waveform", 1.0).unwrap(); // saw
    e.set_knob_value("osc1", "pitch", -1.0).unwrap(); // C3

    e.connect("osc1", "audio", "ws1", "in").unwrap();
    e.set_knob_position("ws1", "mode", 0.0).unwrap(); // fold
    e.set_knob_value("ws1", "drive", 4.0).unwrap();
    e.set_knob_value("ws1", "bias", 1.0).unwrap();
    e.set_knob_value("ws1", "level", 1.8).unwrap();

    e.connect("ws1", "out", "flt1", "in").unwrap();
    e.set_knob_position("flt1", "topology", 0.5).unwrap(); // ladder
    e.set_knob_value("flt1", "cutoff", 1.5).unwrap();
    e.set_knob_value("flt1", "res", 0.6).unwrap();
    e.set_knob_value("flt1", "drive", 1.5).unwrap();

    // Channel 1 through the VCA well below unity (the resonant ladder is
    // loud); In 2 is unpatched, so Out 2 carries the mix bus.
    e.connect("flt1", "lp", "vca1", "in1").unwrap();
    e.set_knob_value("vca1", "cv1", 2.5).unwrap();
    e.connect("vca1", "out2", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-shaping-fold-ladder")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.5));
}

/// The modulation trio driving a voice: an LFO clock fires a Function
/// envelope on the VCA and clocks a Sample & Hold whose random voltage
/// steps the oscillator's pitch. The filter tracks the same envelope.
fn regen_modulation_voice() {
    let dir = crate::common::e2e::case_dir("mod-function-sh-voice");
    let mut e = mono_engine();
    e.add_module("clk", "com.dj.lfo").unwrap();
    e.add_module("sh1", "com.dj.sample_hold").unwrap();
    e.add_module("fn1", "com.dj.function").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("flt1", "com.dj.filter").unwrap();
    e.add_module("vca1", "com.dj.vca_dual").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    // 8 Hz pulse clock.
    e.set_knob_position("clk", "shape", 4.0 / 6.0).unwrap();
    e.set_knob_value("clk", "rate", 8.0).unwrap();

    // Random pitch: internal noise, sampled on every clock, gently slewed.
    e.connect("clk", "uni", "sh1", "trig").unwrap();
    e.set_knob_value("sh1", "slew", 0.004).unwrap();
    e.connect("sh1", "out", "osc1", "pitch").unwrap();
    e.set_knob_atten_offset("osc1", "pitch", 0.2, 0.0).unwrap();

    // Percussive envelope with an exponential-ish fall.
    e.connect("clk", "uni", "fn1", "trig").unwrap();
    e.set_knob_value("fn1", "rise", 0.004).unwrap();
    e.set_knob_value("fn1", "fall", 0.09).unwrap();
    e.set_knob_value("fn1", "curve", 0.6).unwrap();

    e.connect("osc1", "audio", "flt1", "in").unwrap();
    e.set_knob_position("flt1", "topology", 1.0).unwrap(); // OTA
    e.set_knob_value("flt1", "cutoff", 0.5).unwrap();
    e.set_knob_value("flt1", "res", 0.55).unwrap();
    e.connect("fn1", "out", "flt1", "cutoff").unwrap();
    e.set_knob_atten_offset("flt1", "cutoff", 0.25, 0.0)
        .unwrap();

    e.connect("flt1", "lp", "vca1", "in1").unwrap();
    e.connect("fn1", "out", "vca1", "cv1").unwrap();
    // Wired inputs add to the knob baseline; close the level knob so the
    // envelope alone opens the VCA.
    e.set_knob_value("vca1", "cv1", 0.0).unwrap();
    e.set_knob_position("vca1", "resp1", 1.0).unwrap(); // exponential VCA
    e.connect("vca1", "out1", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-mod-function-sh-voice")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.6));
}

/// The 4-band parametric EQ carving a saw: a low-shelf-ish wide boost, a
/// narrow mid cut, a presence bump and a high notch, all four bands live.
fn regen_eq_carve() {
    let dir = crate::common::e2e::case_dir("shaping-eq-carve");
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("eq1", "com.dj.eq").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    e.set_knob_value("osc1", "waveform", 1.0).unwrap(); // saw
    e.set_knob_value("osc1", "pitch", -2.0).unwrap(); // C2

    e.connect("osc1", "audio", "eq1", "in").unwrap();
    // Band 1: broad low boost around 110 Hz.
    e.set_knob_value("eq1", "freq1", -1.25).unwrap();
    e.set_knob_value("eq1", "gain1", 6.0).unwrap();
    e.set_knob_value("eq1", "q1", 0.7).unwrap();
    // Band 2: narrow cut near 520 Hz.
    e.set_knob_value("eq1", "freq2", 1.0).unwrap();
    e.set_knob_value("eq1", "gain2", -12.0).unwrap();
    e.set_knob_value("eq1", "q2", 6.0).unwrap();
    // Band 3: presence bump near 2.1 kHz.
    e.set_knob_value("eq1", "freq3", 3.0).unwrap();
    e.set_knob_value("eq1", "gain3", 4.5).unwrap();
    e.set_knob_value("eq1", "q3", 1.5).unwrap();
    // Band 4: deep notch near 8.4 kHz.
    e.set_knob_value("eq1", "freq4", 5.0).unwrap();
    e.set_knob_value("eq1", "gain4", -15.0).unwrap();
    e.set_knob_value("eq1", "q4", 8.0).unwrap();

    e.connect("eq1", "out", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-shaping-eq-carve")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.5));
}

/// A saw drone through the comb filter, its tuning swept by an LFO: the
/// resonant (feedback) mode at high feedback, so the teeth are audible as
/// pitch rather than as colour.
fn regen_comb_sweep() {
    let dir = crate::common::e2e::case_dir("shaping-comb-sweep");
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("lfo1", "com.dj.lfo").unwrap();
    e.add_module("cmb", "com.dj.comb").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    e.set_knob_value("osc1", "waveform", 1.0).unwrap(); // saw
    e.set_knob_value("osc1", "pitch", -2.0).unwrap(); // C2

    e.connect("osc1", "audio", "cmb", "in").unwrap();
    e.connect("lfo1", "bi", "cmb", "tune").unwrap();
    e.set_knob_value("lfo1", "rate", 1.5).unwrap();
    e.set_knob_atten_offset("cmb", "tune", 0.35, 0.0).unwrap();
    e.set_knob_value("cmb", "tune", 1.0).unwrap();
    e.set_knob_value("cmb", "feedback", 0.85).unwrap();
    e.set_knob_value("cmb", "damping", 4000.0).unwrap();
    e.set_knob_value("cmb", "mix", 0.9).unwrap();

    e.connect("cmb", "out", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-shaping-comb-sweep")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.75));
}

/// The band pass isolating a swept band out of a saw, four poles deep, so
/// the golden pins the cascade and the unity-peak law together.
fn regen_bandpass_sweep() {
    let dir = crate::common::e2e::case_dir("shaping-bandpass-sweep");
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("lfo1", "com.dj.lfo").unwrap();
    e.add_module("bp1", "com.dj.bandpass").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    e.set_knob_value("osc1", "waveform", 1.0).unwrap(); // saw
    e.set_knob_value("osc1", "pitch", -1.0).unwrap(); // C3

    e.connect("osc1", "audio", "bp1", "in").unwrap();
    e.connect("lfo1", "bi", "bp1", "freq").unwrap();
    e.set_knob_value("lfo1", "rate", 2.0).unwrap();
    e.set_knob_atten_offset("bp1", "freq", 0.5, 0.0).unwrap();
    e.set_knob_value("bp1", "freq", 2.0).unwrap();
    e.set_knob_value("bp1", "q", 8.0).unwrap();
    e.set_knob_value("bp1", "slope", 1.0).unwrap(); // 24 dB/oct
    e.set_knob_value("bp1", "mix", 1.0).unwrap();

    e.connect("bp1", "out", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-shaping-bandpass-sweep")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.6));
}

#[test]
fn e2e_shaping_fold_ladder() {
    if regen() {
        regen_shaping_chain();
    }
    check_case("shaping-fold-ladder");
}

#[test]
fn e2e_shaping_eq_carve() {
    if regen() {
        regen_eq_carve();
    }
    check_case("shaping-eq-carve");
}

#[test]
fn e2e_mod_function_sh_voice() {
    if regen() {
        regen_modulation_voice();
    }
    check_case("mod-function-sh-voice");
}

#[test]
fn e2e_shaping_comb_sweep() {
    if regen() {
        regen_comb_sweep();
    }
    check_case("shaping-comb-sweep");
}

#[test]
fn e2e_shaping_bandpass_sweep() {
    if regen() {
        regen_bandpass_sweep();
    }
    check_case("shaping-bandpass-sweep");
}
