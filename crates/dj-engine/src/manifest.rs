//! Extension manifest (`manifest.json`) parsing — PRD §5.1.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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
    /// How this module passes signal through when BYPASSED: output jack id
    /// -> the input jack id its samples are copied from. Declaring any
    /// route is what makes a module bypassable (an audio in -> audio out
    /// module always should); a stereo pair is two routes, and one input
    /// may feed several outputs. Outputs with no route fall silent while
    /// bypassed — a bypassed module's DSP does not run at all.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub bypass: BTreeMap<String, String>,
    /// Built-in presets: named sets of input-jack VALUES the user can
    /// recall from the module's right-click menu. Data, not code — any
    /// module can declare them, and applying one only moves knobs (see
    /// [`crate::Engine::apply_preset`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub presets: Vec<PresetDecl>,
}

/// One named preset: input jack id -> the value that jack should read.
/// Jacks the preset leaves out keep whatever the user set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetDecl {
    pub name: String,
    #[serde(default)]
    pub values: BTreeMap<String, f32>,
}

impl Manifest {
    /// Whether the module offers a bypass toggle (it declared routes).
    pub fn is_bypassable(&self) -> bool {
        !self.bypass.is_empty()
    }

    /// A preset by name (exact match).
    pub fn preset(&self, name: &str) -> Option<&PresetDecl> {
        self.presets.iter().find(|p| p.name == name)
    }

    /// [`Manifest::bypass`] resolved to jack indices: per output jack, the
    /// input jack it copies while bypassed. Empty for a module that is not
    /// bypassable; routes naming jacks the manifest lacks are dropped
    /// (validated at load time — [`Extension::load`]).
    pub fn bypass_routes(&self) -> Vec<Option<usize>> {
        if !self.is_bypassable() {
            return Vec::new();
        }
        self.outputs
            .iter()
            .map(|o| {
                let from = self.bypass.get(&o.id)?;
                self.inputs.iter().position(|i| &i.id == from)
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JackDecl {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub default: f32,
    /// Audio pass-through jack: values only ever arrive by wire, so the UI
    /// renders a plain jack — no manual knob, no CV/attenuverter settings.
    /// Purely presentational; the engine still treats it as a normal input.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub audio: bool,
    /// The UI may read a window of RAW SAMPLES from this jack
    /// (`crate::capture`), because drawing it is the module's whole point
    /// — the Scope's `in`. Costs one fixed ring per instance, so it is
    /// opt-in per jack and never implied by `audio`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub capture: bool,
    #[serde(default)]
    pub knob: Option<KnobConfig>,
    /// How the jack's value reads to a human (unit / mapping / step labels).
    /// None = raw Volts. Pure display metadata — never touches the DSP.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<DisplaySpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputDecl {
    pub id: String,
    pub name: String,
    /// Display unit/mapping for the output's telemetry value; None = Volts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<DisplaySpec>,
}

/// Display mapping for a jack value (PRD §7.2): a unit suffix, an optional
/// value transform, and optional per-step labels for stepped inputs. The
/// engine only carries this to the UI; all formatting happens app-side
/// (app/src/display.ts) so the raw engine value is never changed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DisplaySpec {
    /// Unit suffix ("Hz", "s", "dB", ...). None = "V"; "" = unitless.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    /// Transform from raw engine value to displayed number (identity when
    /// None — the raw value already IS the displayed quantity).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map: Option<DisplayMap>,
    /// Labels for stepped inputs, index = step (["custom", "major", ...]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DisplayMap {
    /// displayed = base * 2^value — 1 V/oct pitch CV; `base` defaults to
    /// middle C, matching the SDK's `pitch_to_hz`.
    VoltPerOctave {
        #[serde(default = "default_pitch_base")]
        base: f32,
    },
}

/// Middle C (C4) — `dj_module_sdk::pitch_to_hz(0.0)`.
pub fn default_pitch_base() -> f32 {
    261.626
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
        for (out, input) in &manifest.bypass {
            anyhow::ensure!(
                manifest.outputs.iter().any(|o| &o.id == out),
                "bypass route names unknown output {out:?} in {}",
                manifest_path.display()
            );
            anyhow::ensure!(
                manifest.inputs.iter().any(|i| &i.id == input),
                "bypass route names unknown input {input:?} in {}",
                manifest_path.display()
            );
        }
        for preset in &manifest.presets {
            for jack in preset.values.keys() {
                anyhow::ensure!(
                    manifest.inputs.iter().any(|i| &i.id == jack),
                    "preset {:?} names unknown input {jack:?} in {}",
                    preset.name,
                    manifest_path.display()
                );
            }
        }
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
