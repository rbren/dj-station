//! E2E golden audio cases for the QWERTY module (computer-keyboard gates).
//!
//! `qwerty-adsr-envelope`: space bar gates an ADSR envelope on a VCA —
//! the qwerty analogue of the midi-adsr-envelope case: press at 0 s,
//! release at 0.5 s, so the render carries the attack/sustain then the
//! release tail.
//!
//! `qwerty-note-gate-voice`: the mono-synth pairing of the shared `note`
//! pitch CV and the any-key `gate` — overlapping key presses move the
//! oscillator pitch while the gate stays high across the legato overlap
//! and only falls (into the release tail) once every key is up.

use crate::common::e2e::{check_case, regen, write_events, EventsFile, QwertyEventSpec};
use dj_engine::{Engine, EngineConfig};

fn regen_qwerty_adsr() {
    let dir = crate::common::e2e::case_dir("qwerty-adsr-envelope");

    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();
    e.add_module("kb1", "builtin.qwerty").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("adsr1", "com.dj.adsr").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("kb1", "space", "adsr1", "gate").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("adsr1", "env", "vca1", "cv").unwrap();
    // Wired inputs add to the knob baseline; zero the cv knob so the
    // envelope alone drives the amplitude.
    e.set_knob_value("vca1", "cv", 0.0).unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();
    e.save_patch(&dir.join("patch"), "e2e-qwerty-adsr-envelope")
        .unwrap();
    write_events(
        &dir,
        &EventsFile {
            seconds: 1.0,
            qwerty: vec![
                QwertyEventSpec {
                    instance: "kb1".into(),
                    frame: 0,
                    key: "space".into(),
                    down: true,
                },
                QwertyEventSpec {
                    instance: "kb1".into(),
                    frame: 24_000,
                    key: "space".into(),
                    down: false,
                },
            ],
            ..EventsFile::default()
        },
    );
}

#[test]
fn e2e_qwerty_adsr_envelope() {
    if regen() {
        regen_qwerty_adsr();
    }
    check_case("qwerty-adsr-envelope");
}

fn regen_qwerty_note_gate_voice() {
    let dir = crate::common::e2e::case_dir("qwerty-note-gate-voice");

    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();
    e.add_module("kb1", "builtin.qwerty").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("adsr1", "com.dj.adsr").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("kb1", "note", "osc1", "pitch").unwrap();
    e.connect("kb1", "gate", "adsr1", "gate").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("adsr1", "env", "vca1", "cv").unwrap();
    e.set_knob_value("vca1", "cv", 0.0).unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();
    e.save_patch(&dir.join("patch"), "e2e-qwerty-note-gate-voice")
        .unwrap();

    // Legato z -> v overlap, then both released: the gate must stay high
    // through the overlap (pitch jumps, no retrigger) and only fall into
    // the release tail after the last key comes up.
    let key = |frame: u64, key: &str, down: bool| QwertyEventSpec {
        instance: "kb1".into(),
        frame,
        key: key.into(),
        down,
    };
    write_events(
        &dir,
        &EventsFile {
            seconds: 1.0,
            qwerty: vec![
                key(0, "z", true),
                key(14_400, "v", true),
                key(19_200, "z", false),
                key(28_800, "v", false),
            ],
            ..EventsFile::default()
        },
    );
}

#[test]
fn e2e_qwerty_note_gate_voice() {
    if regen() {
        regen_qwerty_note_gate_voice();
    }
    check_case("qwerty-note-gate-voice");
}
