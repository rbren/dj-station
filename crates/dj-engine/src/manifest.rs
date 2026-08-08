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
    /// Library grouping shown in the UI; see [`categories`].
    #[serde(default = "default_category")]
    pub category: String,
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

/// Canonical library categories, in display order. A manifest may name any
/// string; unknown ones sort last under their own heading.
pub mod categories {
    pub const SOURCES: &str = "Sources";
    pub const SHAPING: &str = "Shaping";
    pub const MODULATION: &str = "Modulation";
    pub const UTILITIES: &str = "Utilities";
    pub const SEQUENCING: &str = "Clock & Sequencing";
    pub const EFFECTS: &str = "Effects";
    pub const ANALYSIS: &str = "Analysis & I/O";
    pub const DJ: &str = "DJ";
    pub const MACROS: &str = "Macros";

    pub const ORDER: [&str; 9] = [
        SOURCES, SHAPING, MODULATION, UTILITIES, SEQUENCING, EFFECTS, ANALYSIS, DJ, MACROS,
    ];

    /// Position of `name` in [`ORDER`]; unknown categories sort after all
    /// known ones.
    pub fn rank(name: &str) -> usize {
        ORDER.iter().position(|c| *c == name).unwrap_or(ORDER.len())
    }
}

fn default_category() -> String {
    categories::UTILITIES.into()
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

/// File names a `native-1` extension's dylib may use (`dsp.dylib` per the
/// PRD; the platform-native suffixes are accepted so one extension tree
/// works across macOS/Linux/Windows).
pub const NATIVE_DSP_NAMES: [&str; 3] = ["dsp.dylib", "dsp.so", "dsp.dll"];

/// Locate the DSP artifact for `dir`, if any (wasm or native dylib).
pub fn find_dsp(dir: &Path) -> Option<PathBuf> {
    let wasm = dir.join("dsp.wasm");
    if wasm.exists() {
        return Some(wasm);
    }
    NATIVE_DSP_NAMES
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.exists())
}

impl Extension {
    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        let manifest_path = dir.join("manifest.json");
        let text = std::fs::read_to_string(&manifest_path)?;
        let manifest: Manifest = serde_json::from_str(&text)?;
        anyhow::ensure!(
            manifest.inputs.len() <= 64 && manifest.outputs.len() <= 64,
            "at most 64 inputs/outputs supported"
        );
        let dsp_path = match manifest.abi.as_str() {
            "wasm-1" => {
                let p = dir.join("dsp.wasm");
                anyhow::ensure!(p.exists(), "missing {}", p.display());
                p
            }
            "native-1" => NATIVE_DSP_NAMES
                .iter()
                .map(|n| dir.join(n))
                .find(|p| p.exists())
                .ok_or_else(|| {
                    anyhow::anyhow!("missing dsp.dylib/dsp.so/dsp.dll in {}", dir.display())
                })?,
            other => anyhow::bail!("unsupported abi {other:?} in {}", manifest_path.display()),
        };
        Ok(Extension {
            manifest,
            dir: dir.to_path_buf(),
            dsp_path,
        })
    }
}
