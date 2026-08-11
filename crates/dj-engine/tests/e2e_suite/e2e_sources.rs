//! E2E golden-audio cases for the Sources module batch (PRD §10.1).
//!
//! Two patches cover the four modules:
//! - `sources-vco-wavetable`: an LFO VCO modulating a second VCO's pulse
//!   width and a wavetable's morph position, both voices summed to master.
//! - `sources-drum-noise`: MIDI-triggered drum voice with the noise
//!   module's sampled random voltage detuning the hat, plus pink noise
//!   through a VCA.
//!
//! The harness lives in `tests/common/e2e.rs`; regenerate with
//! `REGEN_GOLDENS=1 cargo test -p dj-engine --release --test e2e_sources`.

use crate::common::e2e::{case_dir, check_case, regen, write_events, EventsFile, MidiEventSpec};
use dj_engine::{Engine, EngineConfig, MidiMapKind};

const SR: f32 = 48_000.0;

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

fn regen_vco_wavetable() {
    let dir = case_dir("sources-vco-wavetable");
    let mut e = mono_engine();
    e.add_module("lfo", "com.dj.vco").unwrap();
    e.add_module("vco1", "com.dj.vco").unwrap();
    e.add_module("wt1", "com.dj.wavetable").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    // Slowest the pitch knob goes (~8 Hz): a sub-audio wobble source.
    e.set_knob_position("lfo", "pitch", 0.0).unwrap();
    e.connect("lfo", "tri", "vco1", "pwm").unwrap();
    e.connect("lfo", "tri", "wt1", "pos").unwrap();
    // Attenuvert the LFO into each destination's useful range. `pos` is a
    // 0..1 knob: with the positional blend, offset +0.5 centres the travel
    // and full atten lets the ±5 V triangle sweep the whole table.
    e.set_knob_atten_offset("vco1", "pwm", 0.6, 0.0).unwrap();
    e.set_knob_atten_offset("wt1", "pos", 1.0, 0.5).unwrap();

    e.set_knob_value("vco1", "pitch", -1.0).unwrap(); // C3
    e.set_knob_value("wt1", "pitch", 1.0).unwrap(); // C5
    e.set_knob_value("wt1", "fine", 0.15).unwrap();

    e.connect("vco1", "pulse", "out1", "l").unwrap();
    e.connect("wt1", "audio", "out1", "l").unwrap();
    e.set_knob_atten_offset("out1", "l", 0.45, 0.0).unwrap();

    e.save_patch(&dir.join("patch"), "e2e-sources-vco-wavetable")
        .unwrap();
    write_events(&dir, &EventsFile::seconds(0.5));
}

fn regen_drum_noise() {
    let dir = case_dir("sources-drum-noise");
    let mut e = mono_engine();
    e.add_module("midi1", "builtin.midi").unwrap();
    e.add_module("drum1", "com.dj.drum").unwrap();
    e.add_module("noise1", "com.dj.noise").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    for (note, name, jack) in [
        (36u8, "kick", "kick_trig"),
        (38, "snare", "snare_trig"),
        (42, "hat", "hat_trig"),
    ] {
        e.add_midi_mapping("midi1", MidiMapKind::Note, note, name)
            .unwrap();
        e.connect("midi1", name, "drum1", jack).unwrap();
    }
    e.set_knob_value("drum1", "kick_decay", 0.35).unwrap();
    e.set_knob_value("drum1", "kick_tone", 0.7).unwrap();
    e.set_knob_value("drum1", "snare_decay", 0.18).unwrap();
    e.set_knob_value("drum1", "hat_decay", 0.05).unwrap();

    // Sampled random voltage detunes the hat, one new value per step.
    e.set_knob_value("noise1", "rate", 8.0).unwrap();
    e.connect("noise1", "random", "drum1", "hat_tune").unwrap();
    e.set_knob_atten_offset("drum1", "hat_tune", 0.15, 0.0)
        .unwrap();

    // Pink noise bed under the kit.
    e.connect("noise1", "pink", "vca1", "in").unwrap();
    e.set_knob_value("vca1", "cv", 1.5).unwrap();

    e.connect("drum1", "mix", "out1", "l").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-sources-drum-noise")
        .unwrap();

    // Half a second of a straight 120 BPM pattern.
    let mut midi = Vec::new();
    let mut note = |n: u8, on: f32, len: f32| {
        midi.push(MidiEventSpec {
            instance: "midi1".into(),
            frame: (on * SR) as u64,
            data: [0x90, n, 100],
        });
        midi.push(MidiEventSpec {
            instance: "midi1".into(),
            frame: ((on + len) * SR) as u64,
            data: [0x80, n, 0],
        });
    };
    for i in 0..4 {
        note(42, 0.01 + i as f32 * 0.125, 0.02); // hats on every eighth
    }
    note(36, 0.01, 0.04); // kick on 1
    note(38, 0.25, 0.04); // snare on 2
    note(36, 0.375, 0.04); // kick pickup
    write_events(
        &dir,
        &EventsFile {
            seconds: 0.5,
            midi,
            ..EventsFile::default()
        },
    );
}

#[test]
fn e2e_sources_vco_wavetable() {
    if regen() {
        regen_vco_wavetable();
    }
    check_case("sources-vco-wavetable");
}

#[test]
fn e2e_sources_drum_noise() {
    if regen() {
        regen_drum_noise();
    }
    check_case("sources-drum-noise");
}
