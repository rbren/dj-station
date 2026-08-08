//! E2E golden audio cases for the Clock & Sequencing modules.
//!
//! Two serialized patches cover the batch: a clocked step-sequencer voice
//! and a euclidean/turing/trigger-sequencer rhythm patch. See
//! `tests/common/e2e.rs` for the harness and the regeneration flow.

mod common;

use common::e2e::{check_case, regen, write_events, EventsFile};
use dj_engine::{Engine, EngineConfig};

/// Put a stepped knob exactly on a detent (`set_knob_value`'s inverse
/// search converges on the boundary between two steps).
fn set_stepped(e: &mut Engine, module: &str, jack: &str, value: f32) {
    let node = e.nodes.iter().find(|n| n.instance_id == module).unwrap();
    let decl = node
        .manifest
        .inputs
        .iter()
        .find(|i| i.id == jack)
        .unwrap_or_else(|| panic!("no jack {jack}"));
    let cfg = decl.knob.clone().unwrap();
    let steps = cfg.steps.unwrap() as f32;
    let idx = ((value - cfg.min) / (cfg.max - cfg.min) * (steps - 1.0)).round();
    e.set_knob_position(module, jack, idx / (steps - 1.0))
        .unwrap();
}

fn mono_engine() -> Engine {
    Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        common::registry(),
    )
    .unwrap()
}

/// Clock -> step sequencer -> (osc pitch, ADSR gate) -> VCA -> out.
fn regen_clock_step_seq() {
    let dir = common::e2e::case_dir("seq-clock-step");
    let mut e = mono_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("seq", "com.dj.step_seq").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("adsr1", "com.dj.adsr").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    e.set_knob_value("clk", "bpm", 240.0).unwrap(); // 4 steps per second
    e.connect("clk", "clock", "seq", "clock").unwrap();
    e.connect("clk", "bar", "seq", "reset").unwrap();

    set_stepped(&mut e, "seq", "length", 4.0);
    for (i, v) in [0.0f32, 0.25, 0.5833, 0.4167].iter().enumerate() {
        e.set_knob_value("seq", &format!("cv{}", i + 1), *v)
            .unwrap();
    }
    set_stepped(&mut e, "seq", "ratchet3", 2.0);
    e.set_knob_value("seq", "glide", 0.05).unwrap();

    e.connect("seq", "cv", "osc1", "pitch").unwrap();
    e.connect("seq", "gate", "adsr1", "gate").unwrap();
    set_stepped(&mut e, "osc1", "waveform", 1.0); // saw
    e.set_knob_value("adsr1", "attack", 0.005).unwrap();
    e.set_knob_value("adsr1", "decay", 0.06).unwrap();
    e.set_knob_value("adsr1", "sustain", 0.35).unwrap();
    e.set_knob_value("adsr1", "release", 0.05).unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("adsr1", "env", "vca1", "cv").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-seq-clock-step")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(1.5));
}

/// Clock x4 -> euclidean + turing + trigger sequencer, two voices.
fn regen_euclid_turing() {
    let dir = common::e2e::case_dir("seq-euclid-turing");
    let mut e = mono_engine();
    e.add_module("clk", "com.dj.clock").unwrap();
    e.add_module("euc", "com.dj.euclid").unwrap();
    e.add_module("trn", "com.dj.turing").unwrap();
    e.add_module("trg", "com.dj.trig_seq").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("adsr1", "com.dj.adsr").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("osc2", "com.dj.oscillator").unwrap();
    e.add_module("adsr2", "com.dj.adsr").unwrap();
    e.add_module("vca2", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    // 150 BPM x4 = one step every 0.1 s, shared by all three sequencers.
    e.set_knob_value("clk", "bpm", 150.0).unwrap();
    e.connect("clk", "mul4", "euc", "clock").unwrap();
    e.connect("clk", "mul4", "trn", "clock").unwrap();
    e.connect("clk", "mul4", "trg", "clock").unwrap();
    e.connect("clk", "bar", "euc", "reset").unwrap();
    e.connect("clk", "bar", "trg", "reset").unwrap();

    // Lead: E(5,8) gates an ADSR, pitch from the quantized shift register.
    set_stepped(&mut e, "euc", "steps1", 8.0);
    set_stepped(&mut e, "euc", "fill1", 5.0);
    set_stepped(&mut e, "euc", "fill2", 0.0);
    set_stepped(&mut e, "euc", "fill3", 0.0);
    set_stepped(&mut e, "euc", "fill4", 0.0);
    e.set_knob_position("trn", "prob", 0.62).unwrap(); // mostly locked
    set_stepped(&mut e, "trn", "length", 8.0);
    e.set_knob_value("trn", "range", 2.0).unwrap();
    set_stepped(&mut e, "trn", "scale", 5.0); // major pentatonic
    set_stepped(&mut e, "trn", "root", 0.0);
    e.connect("trn", "quant", "osc1", "pitch").unwrap();
    e.connect("euc", "ch1", "adsr1", "gate").unwrap();
    set_stepped(&mut e, "osc1", "waveform", 3.0); // triangle
    e.set_knob_value("adsr1", "attack", 0.004).unwrap();
    e.set_knob_value("adsr1", "decay", 0.05).unwrap();
    e.set_knob_value("adsr1", "sustain", 0.25).unwrap();
    e.set_knob_value("adsr1", "release", 0.04).unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("adsr1", "env", "vca1", "cv").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();

    // Bass: trigger track 1 (0b0001000100010001, 8 steps long) on a square
    // two octaves down.
    e.set_knob_value("trg", "pat1", 4369.0).unwrap();
    set_stepped(&mut e, "trg", "len1", 8.0);
    e.connect("trg", "trig1", "adsr2", "gate").unwrap();
    set_stepped(&mut e, "osc2", "waveform", 2.0); // square
    e.set_knob_value("osc2", "pitch", -2.0).unwrap();
    e.set_knob_value("adsr2", "attack", 0.002).unwrap();
    e.set_knob_value("adsr2", "decay", 0.12).unwrap();
    e.set_knob_value("adsr2", "sustain", 0.0).unwrap();
    e.set_knob_value("adsr2", "release", 0.02).unwrap();
    e.connect("osc2", "audio", "vca2", "in").unwrap();
    e.connect("adsr2", "env", "vca2", "cv").unwrap();
    e.connect("vca2", "out", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-seq-euclid-turing")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(1.6));
}

#[test]
fn e2e_seq_clock_step() {
    if regen() {
        regen_clock_step_seq();
    }
    check_case("seq-clock-step");
}

#[test]
fn e2e_seq_euclid_turing() {
    if regen() {
        regen_euclid_turing();
    }
    check_case("seq-euclid-turing");
}
