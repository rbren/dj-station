//! ONNX-Runtime-backed hand landmark detection (`--features onnx`).
//!
//! Loads a MediaPipe-Hands-class landmark model from a configurable path
//! (`DJ_GESTURE_ONNX_MODEL`, or [`OnnxHandDetector::load`]) and selects
//! the execution provider per platform, per PRD §8.2 conventions:
//!
//! - **macOS**: CoreML EP (Apple-Silicon acceleration), CPU fallback.
//! - **elsewhere** (incl. this Linux dev sandbox / CI): CPU EP.
//!
//! Model contract (matches the common MediaPipe hand-landmark "full"
//! export): input `image: f32[1, 3, S, S]` (square RGB, 0..1, channels
//! first; `S` read from the model input shape, typically 224), outputs
//! `landmarks: f32[1, 63]` (21 × (x, y, z) in input-square pixels),
//! `score: f32[1, 1]` (hand presence), `handedness: f32[1, 1]`
//! (> 0.5 = right hand). Single-hand contract; a palm-detection stage for
//! multi-hand crops is follow-up work alongside real weights.
//!
//! This path is **plumbing-complete but not the tested default**: no model
//! weights ship with the repo, so the smoke test skips itself when
//! `DJ_GESTURE_ONNX_MODEL` is unset/empty (CI injects unconfigured secrets
//! as "") and everything else runs on the deterministic
//! [`crate::MarkerDetector`] behind the same [`HandDetector`] trait.

use anyhow::{anyhow, Result};
use std::path::Path;

use crate::detect::{Detection, Hand, HandDetector, Point};
use crate::frame::Frame;
use crate::landmark::{Handedness, N_LANDMARKS};

/// Environment variable naming the ONNX model file. Empty = unset.
pub const MODEL_ENV: &str = "DJ_GESTURE_ONNX_MODEL";

/// Minimum presence score for a detection to be reported.
const SCORE_THRESHOLD: f32 = 0.5;

pub struct OnnxHandDetector {
    session: ort::session::Session,
    /// Model input square side (e.g. 224).
    input_size: usize,
}

impl OnnxHandDetector {
    /// Build from `DJ_GESTURE_ONNX_MODEL`; `Ok(None)` when unset or empty.
    pub fn from_env() -> Result<Option<Self>> {
        match std::env::var(MODEL_ENV) {
            Ok(path) if !path.trim().is_empty() => Ok(Some(Self::load(Path::new(&path))?)),
            _ => Ok(None),
        }
    }

    /// Load a model file, selecting the execution provider per platform.
    pub fn load(model: &Path) -> Result<Self> {
        anyhow::ensure!(model.is_file(), "no ONNX model at {}", model.display());
        let builder =
            ort::session::Session::builder().map_err(|e| anyhow!("ONNX session builder: {e}"))?;
        let builder = builder
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
            .map_err(|e| anyhow!("setting optimization level: {e}"))?;

        #[cfg(target_os = "macos")]
        let builder = builder
            .with_execution_providers([ort::ep::CoreML::default().build()])
            .map_err(|e| anyhow!("registering CoreML EP: {e}"))?;
        #[cfg(not(target_os = "macos"))]
        let builder = builder
            .with_execution_providers([ort::ep::CPU::default().build()])
            .map_err(|e| anyhow!("registering CPU EP: {e}"))?;

        let mut builder = builder;
        let session = builder
            .commit_from_file(model)
            .map_err(|e| anyhow!("loading ONNX model {}: {e}", model.display()))?;

        // Read the input square side from the model (fall back to 224 for
        // dynamic shapes).
        let input_size = session
            .inputs()
            .first()
            .and_then(|i| i.dtype().tensor_shape())
            .and_then(|shape| shape.last().copied())
            .filter(|&d| d > 0)
            .map(|d| d as usize)
            .unwrap_or(224);

        Ok(OnnxHandDetector {
            session,
            input_size,
        })
    }

    /// Letterbox-resize an RGB frame to the model's square input,
    /// channels-first, 0..1. Returns the tensor data plus the scale/offset
    /// mapping model pixels back to normalized frame coordinates.
    fn preprocess(&self, frame: &Frame) -> (Vec<f32>, f32, f32, f32) {
        let s = self.input_size;
        let (w, h) = (frame.width as usize, frame.height as usize);
        let scale = (s as f32 / w as f32).min(s as f32 / h as f32);
        let (sw, sh) = ((w as f32 * scale) as usize, (h as f32 * scale) as usize);
        let (ox, oy) = ((s - sw) / 2, (s - sh) / 2);
        let mut data = vec![0.0f32; 3 * s * s];
        for y in 0..sh {
            let sy = ((y as f32 + 0.5) / scale) as usize;
            for x in 0..sw {
                let sx = ((x as f32 + 0.5) / scale) as usize;
                let src = (sy.min(h - 1) * w + sx.min(w - 1)) * 3;
                let dst = (y + oy) * s + (x + ox);
                for c in 0..3 {
                    data[c * s * s + dst] = frame.rgb[src + c] as f32 / 255.0;
                }
            }
        }
        (data, scale, ox as f32, oy as f32)
    }
}

impl HandDetector for OnnxHandDetector {
    fn detect(&mut self, frame: &Frame) -> Result<Detection> {
        let s = self.input_size;
        let (data, scale, ox, oy) = self.preprocess(frame);
        let input = ort::value::Tensor::from_array(([1usize, 3, s, s], data))
            .map_err(|e| anyhow!("building input tensor: {e}"))?;
        let outputs = self
            .session
            .run(ort::inputs![input])
            .map_err(|e| anyhow!("ONNX inference: {e}"))?;

        let (_, landmarks) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| anyhow!("extracting landmarks tensor: {e}"))?;
        anyhow::ensure!(
            landmarks.len() >= N_LANDMARKS * 3,
            "unexpected landmarks tensor length {}",
            landmarks.len()
        );
        let score = (outputs.len() > 1)
            .then(|| outputs[1].try_extract_tensor::<f32>().ok())
            .flatten()
            .and_then(|(_, d)| d.first().copied())
            .unwrap_or(1.0);
        if score < SCORE_THRESHOLD {
            return Ok(Detection::default());
        }
        let handedness = (outputs.len() > 2)
            .then(|| outputs[2].try_extract_tensor::<f32>().ok())
            .flatten()
            .and_then(|(_, d)| d.first().copied())
            .map(|v| {
                if v > 0.5 {
                    Handedness::Right
                } else {
                    Handedness::Left
                }
            })
            .unwrap_or(Handedness::Right);

        let mut points = [Point { x: 0.0, y: 0.0 }; N_LANDMARKS];
        for (i, p) in points.iter_mut().enumerate() {
            // Model pixels -> letterboxed frame pixels -> normalized.
            let x = (landmarks[i * 3] - ox) / scale;
            let y = (landmarks[i * 3 + 1] - oy) / scale;
            *p = Point {
                x: (x / frame.width.max(1) as f32).clamp(0.0, 1.0),
                y: (y / frame.height.max(1) as f32).clamp(0.0, 1.0),
            };
        }
        Ok(Detection {
            hands: vec![Hand { handedness, points }],
        })
    }
}
