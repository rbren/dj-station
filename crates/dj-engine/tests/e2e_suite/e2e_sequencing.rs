//! E2E golden audio cases for the Clock & Sequencing modules.
//!
//! Two serialized patches cover the batch: a clocked step-sequencer voice
//! and a euclidean/turing/trigger-sequencer rhythm patch. See
//! `tests/common/e2e.rs` for the harness and the regeneration flow.

use crate::common::add_clock;
use crate::common::e2e::{check_case, regen, write_events, EventsFile};
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
        crate::common::registry(),
    )
    .unwrap()
}

/// Clock -> step sequencer -> (osc pitch, ADSR gate) -> VCA -> out.
fn regen_clock_step_seq() {
    let dir = crate::common::e2e::case_dir("seq-clock-step");
    let mut e = mono_engine();
    add_clock(&mut e, "clk", 4.0); // 4 steps per second
    e.add_module("bar", "com.dj.clock_mult").unwrap();
    e.add_module("seq", "com.dj.step_seq").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("adsr1", "com.dj.adsr").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    // A second multiplier divides the clock by 4 for the bar reset.
    e.connect("clk", "out", "bar", "clock").unwrap();
    e.set_knob_value("bar", "mult", 0.25).unwrap();
    e.connect("clk", "out", "seq", "clock").unwrap();
    e.connect("bar", "out", "seq", "reset").unwrap();

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
    // Wired inputs add to the knob baseline; close the gain knob so the
    // envelope alone opens the VCA.
    e.set_knob_value("vca1", "cv", 0.0).unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-seq-clock-step")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(1.5));
}

/// Clock x4 -> euclidean + turing + trigger sequencer, two voices.
fn regen_euclid_turing() {
    let dir = crate::common::e2e::case_dir("seq-euclid-turing");
    let mut e = mono_engine();
    add_clock(&mut e, "clk", 10.0);
    e.add_module("bar", "com.dj.clock_mult").unwrap();
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

    // 10 Hz = one step every 0.1 s, shared by all three sequencers, and a
    // /16 divider off the same clock for the 1.6 s bar reset.
    e.connect("clk", "out", "euc", "clock").unwrap();
    e.connect("clk", "out", "trn", "clock").unwrap();
    e.connect("clk", "out", "trg", "clock").unwrap();
    e.connect("clk", "out", "bar", "clock").unwrap();
    e.set_knob_value("bar", "mult", 1.0 / 16.0).unwrap();
    e.connect("bar", "out", "euc", "reset").unwrap();
    e.connect("bar", "out", "trg", "reset").unwrap();

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
    // Wired inputs add to the knob baseline; close the gain knob so the
    // envelope alone opens the VCA.
    e.set_knob_value("vca1", "cv", 0.0).unwrap();
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
    e.set_knob_value("vca2", "cv", 0.0).unwrap();
    e.connect("vca2", "out", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-seq-euclid-turing")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(1.6));
}

/// Clock -> grid sequencer, both modes: a scale-mode row melody into an
/// oscillator pitch and a gate-mode row driving an ADSR, plus the
/// step sequencer's combined cvgate output on a second voice.
fn regen_grid_seq() {
    let dir = crate::common::e2e::case_dir("seq-grid-cvgate");
    let mut e = mono_engine();
    add_clock(&mut e, "clk", 4.0);
    e.add_module("bar", "com.dj.clock_mult").unwrap();
    e.add_module("grid", "com.dj.grid_seq").unwrap();
    e.add_module("gridm", "com.dj.grid_seq").unwrap();
    e.add_module("seq", "com.dj.step_seq").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("adsr1", "com.dj.adsr").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("osc2", "com.dj.oscillator").unwrap();
    e.add_module("vca2", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    // 4 Hz = 4 columns per second, shared by all three sequencers, with a
    // /4 divider off the same clock for the one-second bar reset.
    e.connect("clk", "out", "bar", "clock").unwrap();
    e.set_knob_value("bar", "mult", 0.25).unwrap();
    for m in ["grid", "gridm", "seq"] {
        e.connect("clk", "out", m, "clock").unwrap();
        e.connect("bar", "out", m, "reset").unwrap();
    }

    // Gate-mode grid: row 1 every 4th column at a 7 V level -> ADSR gate,
    // with a x3 ratchet on column 5 (bitplanes: A=0, B=1 -> 1+0+2 = 3),
    // which retriggers the envelope inside the 1.6 s render.
    e.set_knob_value("grid", "row1", 0b0001_0001_0001_0001 as f32)
        .unwrap();
    e.set_knob_value("grid", "ratb1", 0b0001_0000 as f32)
        .unwrap();
    e.set_knob_value("grid", "level", 7.0).unwrap();

    // Scale-mode grid: rows 1/3/5 arpeggiate across columns; the row
    // outputs merge on the oscillator pitch (one row on per column).
    set_stepped(&mut e, "gridm", "mode", 1.0);
    e.set_knob_value("gridm", "row1", 0b0001_0001_0001_0001 as f32)
        .unwrap();
    e.set_knob_value("gridm", "row3", 0b0100_0100_0100_0100 as f32)
        .unwrap();
    e.set_knob_value("gridm", "row5", 0b0010_1010_0010_1010 as f32)
        .unwrap();
    e.connect("gridm", "out1", "osc1", "pitch").unwrap();
    e.connect("gridm", "out3", "osc1", "pitch").unwrap();
    e.connect("gridm", "out5", "osc1", "pitch").unwrap();
    e.connect("grid", "out1", "adsr1", "gate").unwrap();
    set_stepped(&mut e, "osc1", "waveform", 3.0); // triangle
    e.set_knob_value("adsr1", "attack", 0.004).unwrap();
    e.set_knob_value("adsr1", "decay", 0.07).unwrap();
    e.set_knob_value("adsr1", "sustain", 0.3).unwrap();
    e.set_knob_value("adsr1", "release", 0.05).unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("adsr1", "env", "vca1", "cv").unwrap();
    e.set_knob_value("vca1", "cv", 0.0).unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();

    // Second voice: the step sequencer's cvgate (CV while the gate is
    // high, 0 V otherwise) drives a VCA directly — one wire, no envelope.
    set_stepped(&mut e, "seq", "length", 4.0);
    for (i, (cv, gate)) in [(2.0f32, true), (0.0, false), (4.0, true), (6.0, true)]
        .iter()
        .enumerate()
    {
        e.set_knob_value("seq", &format!("cv{}", i + 1), *cv)
            .unwrap();
        // Gates are switch knobs: position 0/1 = off/on.
        e.set_knob_position("seq", &format!("gate{}", i + 1), *gate as i32 as f32)
            .unwrap();
    }
    set_stepped(&mut e, "osc2", "waveform", 2.0); // square
    e.set_knob_value("osc2", "pitch", -1.0).unwrap();
    e.connect("osc2", "audio", "vca2", "in").unwrap();
    e.connect("seq", "cvgate", "vca2", "cv").unwrap();
    e.set_knob_value("vca2", "cv", 0.0).unwrap();
    e.connect("vca2", "out", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-seq-grid-cvgate")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(1.5));
}

/// Two clock multipliers on a continuous ratio: one at x3 tracking the
/// master clock, one with nothing patched into its clock input (free-running
/// at 2 Hz) set to an exact two thirds, each gating its own voice.
fn regen_clock_mult() {
    let dir = crate::common::e2e::case_dir("seq-clock-mult");
    let mut e = mono_engine();
    add_clock(&mut e, "clk", 2.0);
    e.add_module("cm1", "com.dj.clock_mult").unwrap();
    e.add_module("cm2", "com.dj.clock_mult").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("adsr1", "com.dj.adsr").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("osc2", "com.dj.oscillator").unwrap();
    e.add_module("adsr2", "com.dj.adsr").unwrap();
    e.add_module("vca2", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    // Lead: 2 Hz (a beat every 0.5 s) times 3 = a triplet grid, with the
    // two extra pulses per beat predicted between the clock's edges.
    e.connect("clk", "out", "cm1", "clock").unwrap();
    e.set_knob_value("cm1", "mult", 3.0).unwrap();
    e.connect("cm1", "out", "adsr1", "gate").unwrap();
    set_stepped(&mut e, "osc1", "waveform", 3.0); // triangle
    e.set_knob_value("adsr1", "attack", 0.004).unwrap();
    e.set_knob_value("adsr1", "decay", 0.05).unwrap();
    e.set_knob_value("adsr1", "sustain", 0.25).unwrap();
    e.set_knob_value("adsr1", "release", 0.03).unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("adsr1", "env", "vca1", "cv").unwrap();
    // Wired inputs add to the knob baseline; close the gain knob so the
    // envelope alone opens the VCA.
    e.set_knob_value("vca1", "cv", 0.0).unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();

    // Bass: cm2's clock jack stays unpatched, so it free-runs at 2 Hz on
    // its own, and 0.667 on the knob is snapped to an exact two thirds --
    // 4 pulses every 3 s, in step with the lead's triplets.
    e.set_knob_value("cm2", "mult", 0.667).unwrap();
    e.connect("cm2", "out", "adsr2", "gate").unwrap();
    set_stepped(&mut e, "osc2", "waveform", 2.0); // square
    e.set_knob_value("osc2", "pitch", -2.0).unwrap();
    e.set_knob_value("adsr2", "attack", 0.002).unwrap();
    e.set_knob_value("adsr2", "decay", 0.15).unwrap();
    e.set_knob_value("adsr2", "sustain", 0.0).unwrap();
    e.set_knob_value("adsr2", "release", 0.02).unwrap();
    e.connect("osc2", "audio", "vca2", "in").unwrap();
    e.connect("adsr2", "env", "vca2", "cv").unwrap();
    e.set_knob_value("vca2", "cv", 0.0).unwrap();
    e.connect("vca2", "out", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-seq-clock-mult")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(1.5));
}

/// Two Poisson Clocks: one slaved to a 16 Hz master clock at
/// k = 1 (an exact Poisson process at the clock's rate), one free-running
/// on its knob at k = 16 (nearly regular), each gating its own voice.
fn regen_poisson() {
    let dir = crate::common::e2e::case_dir("seq-poisson-gamma");
    let mut e = mono_engine();
    add_clock(&mut e, "clk", 16.0);
    e.add_module("pz1", "com.dj.poisson").unwrap();
    e.add_module("pz2", "com.dj.poisson").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("adsr1", "com.dj.adsr").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("osc2", "com.dj.oscillator").unwrap();
    e.add_module("adsr2", "com.dj.adsr").unwrap();
    e.add_module("vca2", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    // Lead: 16 pulses per second, so the clocked Poisson scatters ~16
    // events per second around that grid without landing on it. Its own
    // rate knob is parked low to prove the clock wins.
    e.connect("clk", "out", "pz1", "clock").unwrap();
    e.set_knob_value("pz1", "rate", 0.5).unwrap();
    e.set_knob_value("pz1", "density", 1.0).unwrap();
    e.connect("pz1", "out", "adsr1", "gate").unwrap();
    set_stepped(&mut e, "osc1", "waveform", 3.0); // triangle
    e.set_knob_value("adsr1", "attack", 0.003).unwrap();
    e.set_knob_value("adsr1", "decay", 0.04).unwrap();
    e.set_knob_value("adsr1", "sustain", 0.2).unwrap();
    e.set_knob_value("adsr1", "release", 0.03).unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("adsr1", "env", "vca1", "cv").unwrap();
    // Wired inputs add to the knob baseline; close the gain knob so the
    // envelope alone opens the VCA.
    e.set_knob_value("vca1", "cv", 0.0).unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();

    // Bass: nothing in pz2's clock jack, so it free-runs on its rate knob
    // at 6 Hz, and k = 16 tightens the intervals to a CV of 0.25 — a
    // clock that breathes rather than one that swings.
    e.set_knob_value("pz2", "rate", 6.0).unwrap();
    e.set_knob_value("pz2", "density", 16.0).unwrap();
    e.connect("pz2", "out", "adsr2", "gate").unwrap();
    set_stepped(&mut e, "osc2", "waveform", 2.0); // square
    e.set_knob_value("osc2", "pitch", -2.0).unwrap();
    e.set_knob_value("adsr2", "attack", 0.002).unwrap();
    e.set_knob_value("adsr2", "decay", 0.1).unwrap();
    e.set_knob_value("adsr2", "sustain", 0.0).unwrap();
    e.set_knob_value("adsr2", "release", 0.02).unwrap();
    e.connect("osc2", "audio", "vca2", "in").unwrap();
    e.connect("adsr2", "env", "vca2", "cv").unwrap();
    e.set_knob_value("vca2", "cv", 0.0).unwrap();
    e.connect("vca2", "out", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-seq-poisson-gamma")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(1.5));
}

#[test]
fn e2e_seq_clock_step() {
    if regen() {
        regen_clock_step_seq();
    }
    check_case("seq-clock-step");
}

#[test]
fn e2e_seq_grid_cvgate() {
    if regen() {
        regen_grid_seq();
    }
    check_case("seq-grid-cvgate");
}

#[test]
fn e2e_seq_euclid_turing() {
    if regen() {
        regen_euclid_turing();
    }
    check_case("seq-euclid-turing");
}

#[test]
fn e2e_seq_clock_mult() {
    if regen() {
        regen_clock_mult();
    }
    check_case("seq-clock-mult");
}

#[test]
fn e2e_seq_poisson_gamma() {
    if regen() {
        regen_poisson();
    }
    check_case("seq-poisson-gamma");
}
