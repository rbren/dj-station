//! Playback module tests (PRD M1 acceptance):
//! - offline render of a known test file matches the source (null test),
//! - `speed = +1` doubles the playback rate (duration + pitch analysis),
//! - output routed through a VCA attenuates correctly,
//! - track + gate state persist through patch save/load.

mod common;

use dj_engine::{Engine, EngineConfig};
use std::path::{Path, PathBuf};

const SR: u32 = 48_000;

/// Deterministic 16-bit WAV: `freq` Hz sine at half amplitude.
fn write_wav(path: &Path, freq: f32, seconds: f32, channels: u16) -> Vec<f32> {
    let spec = hound::WavSpec {
        channels,
        sample_rate: SR,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    let n = (seconds * SR as f32) as u32;
    let mut mono = Vec::with_capacity(n as usize);
    for i in 0..n {
        let t = i as f32 / SR as f32;
        let x = (2.0 * std::f32::consts::PI * freq * t).sin() * 0.5;
        let q = (x * i16::MAX as f32) as i16;
        for _ in 0..channels {
            writer.write_sample(q).unwrap();
        }
        // What symphonia will decode: i16 scaled by 1/32768.
        mono.push(q as f32 / 32768.0);
    }
    writer.finalize().unwrap();
    mono
}

/// Playback -> Audio Out (ch1), mono master, gate held high from frame 0.
fn playback_engine(track: &Path) -> Engine {
    let config = EngineConfig {
        master_channels: 1,
        ..EngineConfig::default()
    };
    let mut e = Engine::new(config, common::registry()).unwrap();
    e.add_module("play1", "builtin.playback").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("play1", "audio_l", "out1", "l").unwrap();
    e.set_knob_position("play1", "play_gate", 1.0).unwrap(); // gate = 10
    e.set_knob_position("play1", "speed", 0.5).unwrap(); // exactly 0.0
    e.playback_load("play1", track).unwrap();
    e
}

/// The module library sidebar lists `registry.all_manifests()`; Playback
/// (the deck) must be instantiable from it like any other module.
#[test]
fn playback_is_listed_in_all_manifests() {
    let registry = common::registry();
    let ids: Vec<String> = registry
        .all_manifests()
        .iter()
        .map(|m| m.id.clone())
        .collect();
    assert!(
        ids.contains(&"builtin.playback".to_string()),
        "builtin.playback missing from module list: {ids:?}"
    );
}

fn zero_crossings(signal: &[f32]) -> usize {
    signal
        .windows(2)
        .filter(|w| (w[0] >= 0.0) != (w[1] >= 0.0))
        .count()
}

#[test]
fn null_test_render_matches_source_file() {
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("tone.wav");
    let source = write_wav(&wav, 440.0, 0.5, 1);

    let mut e = playback_engine(&wav);
    let rendered = e.render_offline(source.len()).unwrap();
    // Engine units are [-10, 10]; the module scales file samples by 10.
    for (i, (&s, &r)) in source.iter().zip(&rendered[0]).enumerate() {
        let out = r / 10.0;
        assert!(
            (s - out).abs() <= 1e-6,
            "sample {i}: source {s} vs rendered {out}"
        );
    }
    // And the track ends cleanly: rendering past the end is silence.
    let tail = e.render_offline(4_800).unwrap();
    assert!(tail[0].iter().all(|&x| x == 0.0), "no silence after end");
}

#[test]
fn stereo_file_routes_left_and_right() {
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("stereo.wav");
    let source = write_wav(&wav, 330.0, 0.25, 2);

    let config = EngineConfig::default(); // stereo master
    let mut e = Engine::new(config, common::registry()).unwrap();
    e.add_module("play1", "builtin.playback").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("play1", "audio_l", "out1", "l").unwrap();
    e.connect("play1", "audio_r", "out1", "r").unwrap();
    e.set_knob_position("play1", "play_gate", 1.0).unwrap();
    e.set_knob_position("play1", "speed", 0.5).unwrap();
    e.playback_load("play1", &wav).unwrap();

    let rendered = e.render_offline(source.len()).unwrap();
    for (ch, chan) in rendered.iter().enumerate().take(2) {
        for (i, (&s, &r)) in source.iter().zip(chan).enumerate() {
            assert!((s - r / 10.0).abs() <= 1e-6, "ch{ch} sample {i}");
        }
    }
}

#[test]
fn speed_plus_one_doubles_playback_rate() {
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("tone.wav");
    // 1.0 s of 440 Hz.
    let source = write_wav(&wav, 440.0, 1.0, 1);

    let mut e = playback_engine(&wav);
    // Knob is linear [-2, 2]: position 0.75 -> exactly +1.0 (double rate).
    e.set_knob_position("play1", "speed", 0.75).unwrap();
    let rendered = e.render_offline(source.len()).unwrap();
    let out = &rendered[0];

    // Duration: the 1.0 s track finishes in ~0.5 s.
    let active = &out[..(0.45 * SR as f32) as usize];
    let silent = &out[(0.55 * SR as f32) as usize..];
    assert!(
        active.iter().any(|&x| x.abs() > 1.0),
        "audio missing in first half"
    );
    assert!(
        silent.iter().all(|&x| x == 0.0),
        "audio still playing after 0.55 s — rate not doubled"
    );

    // Pitch analysis: 440 Hz played at 2x reads as 880 Hz.
    let window = &out[..(0.4 * SR as f32) as usize];
    let measured_hz = zero_crossings(window) as f32 / 2.0 / 0.4;
    assert!(
        (measured_hz - 880.0).abs() < 10.0,
        "expected ~880 Hz, measured {measured_hz} Hz"
    );

    // Control: at speed 0 the same window reads ~440 Hz.
    let mut e2 = playback_engine(&wav);
    let rendered2 = e2.render_offline(source.len()).unwrap();
    let window2 = &rendered2[0][..(0.4 * SR as f32) as usize];
    let control_hz = zero_crossings(window2) as f32 / 2.0 / 0.4;
    assert!(
        (control_hz - 440.0).abs() < 10.0,
        "control: expected ~440 Hz, measured {control_hz} Hz"
    );
}

#[test]
fn output_through_vca_attenuates_correctly() {
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("tone.wav");
    let source = write_wav(&wav, 220.0, 0.25, 1);

    // Direct render for reference.
    let mut direct = playback_engine(&wav);
    let reference = direct.render_offline(source.len()).unwrap();

    // Playback -> VCA (gain 0.5 via cv knob) -> Audio Out.
    let config = EngineConfig {
        master_channels: 1,
        ..EngineConfig::default()
    };
    let mut e = Engine::new(config, common::registry()).unwrap();
    e.add_module("play1", "builtin.playback").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("play1", "audio_l", "vca1", "in").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();
    e.set_knob_position("play1", "play_gate", 1.0).unwrap();
    e.set_knob_position("play1", "speed", 0.5).unwrap();
    e.set_knob_position("vca1", "cv", 0.5).unwrap(); // gain 0.5
    e.playback_load("play1", &wav).unwrap();
    let attenuated = e.render_offline(source.len()).unwrap();

    let mut max_in = 0.0f32;
    for (i, (&r, &a)) in reference[0].iter().zip(&attenuated[0]).enumerate() {
        assert!(
            (a - r * 0.5).abs() <= 1e-4,
            "sample {i}: vca output {a} != 0.5 * {r}"
        );
        max_in = max_in.max(r.abs());
    }
    assert!(max_in > 4.0, "reference render too quiet to be meaningful");
}

#[test]
fn gate_low_is_silent_and_pause_resumes() {
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("tone.wav");
    let source = write_wav(&wav, 440.0, 0.5, 1);

    // Gate at default (0) -> silence even with a track loaded.
    let config = EngineConfig {
        master_channels: 1,
        ..EngineConfig::default()
    };
    let mut e = Engine::new(config, common::registry()).unwrap();
    e.add_module("play1", "builtin.playback").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("play1", "audio_l", "out1", "l").unwrap();
    e.set_knob_position("play1", "speed", 0.5).unwrap();
    e.playback_load("play1", &wav).unwrap();
    let silent = e.render_offline(9_600).unwrap();
    assert!(
        silent[0].iter().all(|&x| x == 0.0),
        "gate low must be silent"
    );

    // Raise the gate: playback resumes from the held position (start).
    e.set_knob_position("play1", "play_gate", 1.0).unwrap();
    let playing = e.render_offline(9_600).unwrap();
    for (i, (&s, &r)) in source.iter().zip(&playing[0]).enumerate().take(9_600) {
        assert!((s - r / 10.0).abs() <= 1e-6, "sample {i} after resume");
    }
}

#[test]
fn loop_param_wraps_instead_of_stopping() {
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("short.wav");
    let source = write_wav(&wav, 440.0, 0.1, 1); // 4800 frames

    let mut e = playback_engine(&wav);
    e.set_param("play1", "loop", 1.0).unwrap();
    let rendered = e.render_offline(source.len() * 3).unwrap();
    // Third pass still has signal.
    let third = &rendered[0][source.len() * 2..];
    assert!(
        third.iter().any(|&x| x.abs() > 1.0),
        "loop mode stopped after one pass"
    );
}

#[test]
fn track_and_state_persist_through_patch_save_load() {
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("tone.wav");
    let source = write_wav(&wav, 440.0, 0.5, 1);
    let patch_dir: PathBuf = tmp.path().join("patch");

    let e = playback_engine(&wav);
    assert_eq!(
        e.playback_track("play1").unwrap().as_deref(),
        Some(wav.to_string_lossy().as_ref())
    );
    e.save_patch(&patch_dir, "playback-persist").unwrap();
    drop(e);

    // Reload: the track reference is restored and renders identically.
    let mut e2 = Engine::load_patch(&patch_dir, common::registry()).unwrap();
    assert_eq!(
        e2.playback_track("play1").unwrap().as_deref(),
        Some(wav.to_string_lossy().as_ref())
    );
    let rendered = e2.render_offline(source.len()).unwrap();
    for (i, (&s, &r)) in source.iter().zip(&rendered[0]).enumerate() {
        assert!((s - r / 10.0).abs() <= 1e-6, "sample {i} after reload");
    }
}
