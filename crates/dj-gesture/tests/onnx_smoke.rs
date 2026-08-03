//! ONNX hand-landmark detector smoke test (`--features onnx`).
//!
//! Same gating pattern as the analysis/provider smoke tests: skips itself
//! when `DJ_GESTURE_ONNX_MODEL` is unset or empty (CI injects unconfigured
//! secrets as ""). Point it at a MediaPipe-Hands-class landmark export
//! matching the contract in `src/onnx.rs` (`f32[1,3,S,S]` -> landmarks
//! `f32[1,63]` + score + handedness) to exercise the real runtime path
//! (CPU EP here; CoreML EP on macOS).

#![cfg(feature = "onnx")]

use dj_gesture::onnx::{OnnxHandDetector, MODEL_ENV};
use dj_gesture::{Frame, HandDetector};

#[test]
fn onnx_hand_detector_smoke() {
    let Some(mut det) = OnnxHandDetector::from_env().expect("model configured but failed to load")
    else {
        eprintln!("skipping: {MODEL_ENV} unset/empty");
        return;
    };
    // A flat gray frame: asserts the pre/post-processing plumbing runs;
    // real accuracy needs real hands + real weights (macOS/M4 hardware).
    let frame = Frame {
        width: 640,
        height: 480,
        rgb: vec![128; 640 * 480 * 3],
    };
    let detection = det.detect(&frame).expect("inference failed");
    for hand in &detection.hands {
        for p in &hand.points {
            assert!((0.0..=1.0).contains(&p.x) && (0.0..=1.0).contains(&p.y));
        }
    }
}
