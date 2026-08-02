//! Shared helpers for dj-library integration tests.
#![allow(dead_code)]

use std::path::Path;

/// Write a small mono 16-bit WAV (deterministic sine) — a real audio file
/// symphonia can probe. `freq` varies the content (and thus the hash).
pub fn write_test_wav(path: &Path, freq: f32, seconds: f32) {
    let sample_rate = 8_000u32;
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    let n = (seconds * sample_rate as f32) as u32;
    for i in 0..n {
        let t = i as f32 / sample_rate as f32;
        let x = (2.0 * std::f32::consts::PI * freq * t).sin() * 0.5;
        writer.write_sample((x * i16::MAX as f32) as i16).unwrap();
    }
    writer.finalize().unwrap();
}
