//! Extension manifest (`manifest.json`) parsing — PRD §5.1.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::knob::KnobConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    /// "wasm-1" | "native-1"
    pub abi: String,
    #[serde(default)]
    pub inputs: Vec<JackDecl>,
    #[serde(default)]
    pub outputs: Vec<OutputDecl>,
    #[serde(default)]
    pub params: Vec<ParamDecl>,
    #[serde(default)]
    pub ui: Option<String>,
    #[serde(default)]
    pub latency_samples: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JackDecl {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub default: f32,
    #[serde(default)]
    pub knob: Option<KnobConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputDecl {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamDecl {
    pub id: String,
    pub name: String,
    #[serde(rename = "type", default = "default_param_type")]
    pub param_type: String,
    #[serde(default)]
    pub default: serde_json::Value,
    #[serde(default)]
    pub min: Option<f32>,
    #[serde(default)]
    pub max: Option<f32>,
}

fn default_param_type() -> String {
    "float".into()
}

impl ParamDecl {
    /// Params cross the ABI as f32 (toggles as 0.0/1.0).
    pub fn default_f32(&self) -> f32 {
        match &self.default {
            serde_json::Value::Bool(true) => 1.0,
            serde_json::Value::Bool(false) => 0.0,
            serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0) as f32,
            _ => 0.0,
        }
    }
}

/// A discovered extension: manifest + on-disk location.
#[derive(Debug, Clone)]
pub struct Extension {
    pub manifest: Manifest,
    pub dir: PathBuf,
    pub dsp_path: PathBuf,
}

impl Extension {
    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        let manifest_path = dir.join("manifest.json");
        let text = std::fs::read_to_string(&manifest_path)?;
        let manifest: Manifest = serde_json::from_str(&text)?;
        anyhow::ensure!(
            manifest.abi == "wasm-1",
            "unsupported abi {:?} in {}",
            manifest.abi,
            manifest_path.display()
        );
        anyhow::ensure!(
            manifest.inputs.len() <= 64 && manifest.outputs.len() <= 64,
            "at most 64 inputs/outputs supported"
        );
        let dsp_path = dir.join("dsp.wasm");
        anyhow::ensure!(dsp_path.exists(), "missing {}", dsp_path.display());
        Ok(Extension {
            manifest,
            dir: dir.to_path_buf(),
            dsp_path,
        })
    }
}
