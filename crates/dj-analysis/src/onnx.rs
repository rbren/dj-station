//! ONNX-Runtime-backed stem separation (`--features onnx`).
//!
//! Loads an htdemucs-class waveform-to-stems model from a configurable
//! path (`DJ_STEMS_ONNX_MODEL`, or [`OnnxSeparator::load`]) and selects
//! the execution provider per platform, per PRD §8.2:
//!
//! - **macOS**: CoreML EP (Apple-Silicon acceleration), CPU fallback.
//! - **elsewhere** (incl. this Linux dev sandbox / CI): CPU EP.
//!
//! Model contract (matches an end-to-end hybrid-demucs export): input
//! `waveform: f32[1, 2, N]` (stereo, mono duplicated), output
//! `stems: f32[1, 4, 2, N]` in [`crate::stems::STEM_NAMES`] order
//! (vocals/drums/bass/other). A real htdemucs export whose graph embeds
//! its own STFT front-end satisfies this contract directly; exports that
//! expect external pre/post-processing need a matching wrapper added here.
//!
//! This path is **plumbing-complete but not the tested default**: no model
//! weights ship with the repo (multi-GB), so the smoke test skips itself
//! when `DJ_STEMS_ONNX_MODEL` is unset/empty (same pattern as the provider
//! smoke tests) and everything else runs on the DSP fallback separator.

use anyhow::{anyhow, Result};
use std::path::Path;

use crate::decode::AudioData;
use crate::stems::{StemSeparator, Stems, N_STEMS};

/// Environment variable naming the ONNX model file. Empty = unset (CI
/// injects unconfigured secrets as "").
pub const MODEL_ENV: &str = "DJ_STEMS_ONNX_MODEL";

/// Model inference chunk length (seconds); chunks are processed
/// back-to-back (htdemucs-style overlap-blend is a follow-up alongside
/// real weights).
const CHUNK_SECS: f64 = 30.0;

pub struct OnnxSeparator {
    session: std::sync::Mutex<ort::session::Session>,
}

impl OnnxSeparator {
    /// Build from `DJ_STEMS_ONNX_MODEL`; `Ok(None)` when unset or empty.
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

        // Per-platform execution provider (PRD §8.2): CoreML on macOS,
        // CPU elsewhere. `ort` falls back to CPU when an EP is
        // unavailable at runtime.
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
        Ok(OnnxSeparator {
            session: std::sync::Mutex::new(session),
        })
    }
}

impl StemSeparator for OnnxSeparator {
    fn id(&self) -> &str {
        "onnx"
    }

    fn separate(&self, audio: &AudioData) -> Result<Stems> {
        let n = audio.frames();
        anyhow::ensure!(n > 0, "empty audio");
        let left = &audio.channels[0];
        let right = audio.channels.get(1).unwrap_or(&audio.channels[0]);

        let mut out: [AudioData; N_STEMS] = std::array::from_fn(|_| AudioData {
            channels: vec![Vec::with_capacity(n), Vec::with_capacity(n)],
            sample_rate: audio.sample_rate,
        });

        let chunk = ((CHUNK_SECS * audio.sample_rate as f64) as usize).max(1);
        let mut session = self.session.lock().unwrap();
        let mut start = 0usize;
        while start < n {
            let end = (start + chunk).min(n);
            let len = end - start;
            let mut interleaved = vec![0.0f32; 2 * len];
            interleaved[..len].copy_from_slice(&left[start..end]);
            interleaved[len..].copy_from_slice(&right[start..end]);
            let input = ort::value::Tensor::from_array(([1usize, 2, len], interleaved))
                .map_err(|e| anyhow!("building input tensor: {e}"))?;
            let outputs = session
                .run(ort::inputs![input])
                .map_err(|e| anyhow!("ONNX inference: {e}"))?;
            let (shape, data) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|e| anyhow!("extracting stems tensor: {e}"))?;
            let dims: &[i64] = shape;
            anyhow::ensure!(
                dims == [1, N_STEMS as i64, 2, len as i64],
                "unexpected model output shape {dims:?} (want [1, 4, 2, {len}])"
            );
            for (s, stem) in out.iter_mut().enumerate() {
                for ch in 0..2 {
                    let base = (s * 2 + ch) * len;
                    stem.channels[ch].extend_from_slice(&data[base..base + len]);
                }
            }
            start = end;
        }
        Ok(Stems(out))
    }
}
