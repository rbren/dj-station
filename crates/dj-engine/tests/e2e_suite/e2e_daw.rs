//! E2E golden audio case for the DAW bottom bar: an audio-track clip and a
//! continuous CV-track clip drive a voice from the serialized patch.
//!
//! Clips are carried in the `events.json` sidecar (`daw_clips`, imported at
//! render time) like deck tracks — the patch persists only track defs and
//! wires. The saved patch's tracks therefore carry no clip paths.

use crate::common::e2e::{
    check_case, regen, write_case_tone, write_events, DawClipSpec, EventsFile,
};
use dj_engine::{Engine, EngineConfig};
use std::path::Path;

/// Deterministic CV ramp WAV (mono float, engine rate): a 2 s swell.
fn write_case_ramp(path: &Path, seconds: f64) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 48_000,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let n = (seconds * 48_000.0) as u64;
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..n {
        w.write_sample((i as f64 / n as f64) as f32).unwrap();
    }
    w.finalize().unwrap();
}

/// DAW audio track (440 Hz tone clip) -> VCA gained by the DAW's
/// continuous track (a CV swell clip) -> audio out.
fn regen_daw_tracks() {
    let dir = crate::common::e2e::case_dir("daw-tracks");
    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    e.daw_add_track("tone", "audio", false).unwrap(); // t0
    e.daw_add_track("swell", "continuous", false).unwrap(); // t1
    e.connect("daw", "t0", "vca1", "in").unwrap();
    e.connect("daw", "t1", "vca1", "cv").unwrap();
    // The wired CV input blends against a closed knob baseline.
    e.set_knob_value("vca1", "cv", 0.0).unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "daw-tracks").unwrap();
    write_case_tone(&dir.join("tone.wav"), 440.0, 1.5);
    write_case_ramp(&dir.join("swell.wav"), 2.0);
    write_events(
        &dir,
        &EventsFile {
            daw_clips: vec![
                DawClipSpec {
                    track: 0,
                    file: "tone.wav".into(),
                },
                DawClipSpec {
                    track: 1,
                    file: "swell.wav".into(),
                },
            ],
            ..EventsFile::seconds(2.0)
        },
    );
}

#[test]
fn daw_tracks_case() {
    if regen() {
        regen_daw_tracks();
    }
    check_case("daw-tracks");
}

/// DAW MIDI track: a two-note beat-grid melody at 150 BPM drives an
/// oscillator (pitch jack, 1 V/oct) gated through a VCA (gate jack).
/// Notes live in the serialized patch itself — the sidecar only starts
/// the transport (`daw_play`).
fn regen_daw_midi() {
    use dj_engine::daw::DawNote;
    let dir = crate::common::e2e::case_dir("daw-midi");
    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    e.daw_set_bpm(150.0).unwrap();
    e.daw_add_track("keys", "midi", false).unwrap(); // t0 pitch, t1 gate
    e.daw_add_note(
        0,
        DawNote {
            beat: 0.0,
            len: 1.0,
            pitch: 60,
            velocity: 1.0,
        },
    )
    .unwrap();
    e.daw_add_note(
        0,
        DawNote {
            beat: 2.0,
            len: 1.0,
            pitch: 67,
            velocity: 0.5,
        },
    )
    .unwrap();

    e.connect("daw", "t0", "osc1", "pitch").unwrap();
    e.connect("daw", "t1", "vca1", "cv").unwrap();
    e.set_knob_value("vca1", "cv", 0.0).unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "daw-midi").unwrap();
    write_events(
        &dir,
        &EventsFile {
            daw_play: true,
            ..EventsFile::seconds(2.0)
        },
    );
}

#[test]
fn daw_midi_case() {
    if regen() {
        regen_daw_midi();
    }
    check_case("daw-midi");
}

/// DAW clock output: the once-per-beat transport pulse (5 ms, 10 V) at
/// 100 BPM gates a tone through a VCA — audible ticks every 0.6 s.
fn regen_daw_clock() {
    let dir = crate::common::e2e::case_dir("daw-clock");
    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();

    e.daw_set_bpm(100.0).unwrap();
    e.connect("daw", "clock", "vca1", "cv").unwrap();
    e.set_knob_value("vca1", "cv", 0.0).unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();

    e.save_patch(&dir.join("patch"), "daw-clock").unwrap();
    write_events(
        &dir,
        &EventsFile {
            daw_play: true,
            ..EventsFile::seconds(2.0)
        },
    );
}

#[test]
fn daw_clock_case() {
    if regen() {
        regen_daw_clock();
    }
    check_case("daw-clock");
}
