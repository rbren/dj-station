//! ONNX stem-separator smoke test (`--features onnx`).
//!
//! Same gating pattern as the provider smoke tests: the test skips itself
//! when `DJ_STEMS_ONNX_MODEL` is unset or empty (CI injects unconfigured
//! secrets as ""). Point it at an htdemucs-class export matching the
//! contract in `src/onnx.rs` (`f32[1,2,N] -> f32[1,4,2,N]`) to exercise
//! the real runtime path (CPU EP here; CoreML EP on macOS).

#![cfg(feature = "onnx")]

use dj_analysis::onnx::{OnnxSeparator, MODEL_ENV};
use dj_analysis::{AudioData, StemSeparator};

#[test]
fn onnx_separator_smoke() {
    let Some(sep) = OnnxSeparator::from_env().expect("model configured but failed to load") else {
        eprintln!("skipping: {MODEL_ENV} unset/empty");
        return;
    };
    let sr = 44_100u32;
    let n = sr as usize; // 1 s
    let audio = AudioData {
        channels: vec![
            (0..n)
                .map(|i| (2.0 * std::f32::consts::PI * 220.0 * i as f32 / sr as f32).sin() * 0.5)
                .collect(),
            (0..n)
                .map(|i| (2.0 * std::f32::consts::PI * 330.0 * i as f32 / sr as f32).sin() * 0.5)
                .collect(),
        ],
        sample_rate: sr,
    };
    let stems = sep.separate(&audio).expect("inference failed");
    for stem in &stems.0 {
        assert_eq!(stem.channels.len(), 2);
        assert_eq!(stem.frames(), n);
    }
}
