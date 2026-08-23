//! Audio module (`builtin.audio`) tests:
//! - plays a library track (null test against the source file),
//! - loading a track adopts its BPM and resets speed to 1x,
//! - BPM and speed are one tempo in two units: moving either moves the
//!   other, and the audio really runs at the new rate,
//! - the clock output triggers once per beat at the BPM input's tempo,
//! - track and tempo survive patch save/load.

use dj_engine::{Engine, EngineConfig};
use std::path::{Path, PathBuf};

const SR: u32 = 48_000;

/// Deterministic 16-bit mono WAV: `freq` Hz sine at half amplitude.
/// Returns the samples symphonia will decode back.
fn write_wav(path: &Path, freq: f32, seconds: f32) -> Vec<f32> {
    let spec = hound::WavSpec {
        channels: 1,
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
        writer.write_sample(q).unwrap();
        mono.push(q as f32 / 32768.0);
    }
    writer.finalize().unwrap();
    mono
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

/// Audio -> Audio Out (ch1), playing, with `track` loaded at `bpm`.
fn audio_engine(track: &Path, bpm: Option<f64>) -> Engine {
    let mut e = mono_engine();
    e.add_module("audio1", "builtin.audio").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("audio1", "audio_l", "out1", "l").unwrap();
    e.set_knob_position("audio1", "play", 1.0).unwrap();
    e.audio_load("audio1", track, bpm).unwrap();
    e
}

fn zero_crossings(signal: &[f32]) -> usize {
    signal
        .windows(2)
        .filter(|w| (w[0] >= 0.0) != (w[1] >= 0.0))
        .count()
}

/// Sample indices where a trigger output goes high (a pulse already high
/// at index 0 counts: a clock restart fires on that very sample).
fn pulse_frames(signal: &[f32]) -> Vec<usize> {
    let mut out = Vec::new();
    if signal.first().is_some_and(|&x| x >= 5.0) {
        out.push(0);
    }
    for (i, w) in signal.windows(2).enumerate() {
        if w[0] < 5.0 && w[1] >= 5.0 {
            out.push(i + 1);
        }
    }
    out
}

/// Mean spacing between clock triggers, in samples.
fn beat_samples(signal: &[f32]) -> f64 {
    let at = pulse_frames(signal);
    assert!(at.len() >= 3, "too few clock triggers: {at:?}");
    (at[at.len() - 1] - at[0]) as f64 / (at.len() - 1) as f64
}

/// The module library sidebar lists `registry.all_manifests()`; Audio has
/// to be addable from it like any other module.
#[test]
fn audio_is_listed_in_all_manifests() {
    let ids: Vec<String> = crate::common::registry()
        .all_manifests()
        .iter()
        .map(|m| m.id.clone())
        .collect();
    assert!(
        ids.contains(&"builtin.audio".to_string()),
        "builtin.audio missing from module list: {ids:?}"
    );
}

#[test]
fn plays_the_loaded_track_and_stops_at_its_end() {
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("tone.wav");
    let source = write_wav(&wav, 440.0, 0.5);

    let mut e = audio_engine(&wav, Some(120.0));
    let rendered = e.render_offline(source.len()).unwrap();
    // Engine units are [-10, 10]; the module scales file samples by 10.
    for (i, (&s, &r)) in source.iter().zip(&rendered[0]).enumerate() {
        assert!(
            (s - r / 10.0).abs() <= 1e-5,
            "sample {i}: source {s} vs rendered {}",
            r / 10.0
        );
    }
    let tail = e.render_offline(4_800).unwrap();
    assert!(
        tail[0].iter().all(|&x| x == 0.0),
        "no silence after the end"
    );
}

#[test]
fn play_input_low_is_silent() {
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("tone.wav");
    write_wav(&wav, 440.0, 0.5);

    let mut e = audio_engine(&wav, Some(120.0));
    e.set_knob_position("audio1", "play", 0.0).unwrap();
    let out = e.render_offline(9_600).unwrap();
    assert!(out[0].iter().all(|&x| x == 0.0), "paused must be silent");
}

#[test]
fn loading_a_track_adopts_its_bpm_at_one_x() {
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("tone.wav");
    write_wav(&wav, 440.0, 0.2);

    let mut e = mono_engine();
    e.add_module("audio1", "builtin.audio").unwrap();
    // A fresh module sits at the default tempo, 1x.
    let st = e.audio_status("audio1").unwrap();
    assert!((st.bpm - 120.0).abs() < 1e-3, "default BPM {}", st.bpm);
    assert!((st.speed - 1.0).abs() < 1e-4, "default speed {}", st.speed);

    // Drive the tempo off 1x, then load a track the library knows: the
    // BPM input takes the track's tempo and speed goes back to 1x.
    e.set_knob_value("audio1", "bpm", 150.0).unwrap();
    assert!((e.audio_status("audio1").unwrap().speed - 1.25).abs() < 1e-3);
    e.audio_load("audio1", &wav, Some(128.0)).unwrap();
    let st = e.audio_status("audio1").unwrap();
    assert!((st.bpm - 128.0).abs() < 1e-3, "BPM after load {}", st.bpm);
    assert!(
        (st.speed - 1.0).abs() < 1e-4,
        "speed after load {}",
        st.speed
    );
    assert_eq!(
        e.audio_track("audio1").unwrap().as_deref(),
        Some(wav.to_string_lossy().as_ref())
    );

    // A track whose tempo the library doesn't know keeps the BPM input
    // where it is (that value becomes this track's tempo at 1x).
    e.set_knob_value("audio1", "speed", 2.0).unwrap();
    e.audio_load("audio1", &wav, None).unwrap();
    let st = e.audio_status("audio1").unwrap();
    assert!((st.bpm - 256.0).abs() < 1e-2, "BPM after load {}", st.bpm);
    assert!(
        (st.speed - 1.0).abs() < 1e-4,
        "speed after load {}",
        st.speed
    );
}

#[test]
fn bpm_and_speed_move_together() {
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("tone.wav");
    write_wav(&wav, 440.0, 0.2);

    let mut e = audio_engine(&wav, Some(100.0));
    // BPM -> speed.
    e.set_knob_value("audio1", "bpm", 200.0).unwrap();
    let st = e.audio_status("audio1").unwrap();
    assert!(
        (st.speed - 2.0).abs() < 1e-3,
        "speed {} for 200 BPM",
        st.speed
    );
    // ... and back down.
    e.set_knob_value("audio1", "bpm", 50.0).unwrap();
    assert!((e.audio_status("audio1").unwrap().speed - 0.5).abs() < 1e-3);
    // speed -> BPM.
    e.set_knob_value("audio1", "speed", 1.5).unwrap();
    let st = e.audio_status("audio1").unwrap();
    assert!((st.bpm - 150.0).abs() < 1e-2, "BPM {} at 1.5x", st.bpm);
    // Positional sets (what a knob drag does) link the same way.
    e.set_knob_position("audio1", "speed", 0.5).unwrap(); // exactly 1x
    let st = e.audio_status("audio1").unwrap();
    assert!((st.speed - 1.0).abs() < 1e-6);
    assert!((st.bpm - 100.0).abs() < 1e-2, "BPM {} back at 1x", st.bpm);

    // Other modules' knobs are untouched by any of this.
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.set_knob_value("vca1", "cv", 5.0).unwrap();
}

#[test]
fn raising_bpm_speeds_the_audio_up() {
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("tone.wav");
    let source = write_wav(&wav, 440.0, 1.0);

    // 100 BPM track at 200 BPM = double speed: 880 Hz, done in ~0.5 s.
    let mut e = audio_engine(&wav, Some(100.0));
    e.set_knob_value("audio1", "bpm", 200.0).unwrap();
    let out = e.render_offline(source.len()).unwrap().remove(0);

    let window = &out[..(0.4 * SR as f32) as usize];
    let measured = zero_crossings(window) as f32 / 2.0 / 0.4;
    assert!(
        (measured - 880.0).abs() < 10.0,
        "expected ~880 Hz at 2x, measured {measured} Hz"
    );
    let silent = &out[(0.55 * SR as f32) as usize..];
    assert!(
        silent.iter().all(|&x| x == 0.0),
        "the 1 s track should be over by 0.55 s at 2x"
    );
}

#[test]
fn clock_triggers_once_per_beat_at_the_bpm_input() {
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("tone.wav");
    write_wav(&wav, 440.0, 0.2);

    let mut e = mono_engine();
    e.add_module("audio1", "builtin.audio").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("audio1", "clock", "out1", "l").unwrap();

    // 120 BPM = one trigger every half second — and it keeps time with
    // no track loaded and nothing playing.
    let out = e.render_offline(4 * SR as usize).unwrap().remove(0);
    let beat = beat_samples(&out);
    assert!(
        (beat - 24_000.0).abs() < 2.0,
        "120 BPM beat = {beat} samples"
    );

    // The clock follows the BPM input.
    e.set_knob_value("audio1", "bpm", 240.0).unwrap();
    let out = e.render_offline(4 * SR as usize).unwrap().remove(0);
    let beat = beat_samples(&out);
    assert!(
        (beat - 12_000.0).abs() < 2.0,
        "240 BPM beat = {beat} samples"
    );

    // Moving the speed input moves the clock with it (they are one tempo),
    // and a freshly loaded track puts the clock on beat one.
    e.audio_load("audio1", &wav, Some(120.0)).unwrap();
    e.set_knob_value("audio1", "speed", 2.0).unwrap();
    let out = e.render_offline(4 * SR as usize).unwrap().remove(0);
    assert_eq!(
        pulse_frames(&out).first(),
        Some(&0),
        "the clock restarts with the loaded track"
    );
    let beat = beat_samples(&out);
    assert!(
        (beat - 12_000.0).abs() < 2.0,
        "120 BPM track at 2x = 240 BPM clock, beat = {beat} samples"
    );
}

#[test]
fn track_and_tempo_persist_through_patch_save_load() {
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("tone.wav");
    write_wav(&wav, 440.0, 0.2);
    let patch_dir: PathBuf = tmp.path().join("patch");

    let mut e = audio_engine(&wav, Some(128.0));
    e.set_knob_value("audio1", "bpm", 160.0).unwrap(); // 1.25x
    e.save_patch(&patch_dir, "audio-persist").unwrap();
    drop(e);

    let mut e2 = Engine::load_patch(&patch_dir, crate::common::registry()).unwrap();
    let st = e2.audio_status("audio1").unwrap();
    assert_eq!(st.track.as_deref(), Some(wav.to_string_lossy().as_ref()));
    assert!((st.bpm - 160.0).abs() < 1e-2, "BPM after reload {}", st.bpm);
    assert!(
        (st.speed - 1.25).abs() < 1e-3,
        "speed after reload {}",
        st.speed
    );

    // The pair still knows the track's 1x tempo (128 BPM) after the round
    // trip: halving the BPM input halves the speed from there.
    e2.set_knob_value("audio1", "bpm", 80.0).unwrap();
    let st = e2.audio_status("audio1").unwrap();
    assert!(
        (st.speed - 0.625).abs() < 1e-3,
        "speed {} for 80 BPM on a 128 BPM track",
        st.speed
    );
}
