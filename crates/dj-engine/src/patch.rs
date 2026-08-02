//! Patch persistence as a directory tree of small JSON files (PRD §12.3).
//!
//! Layout:
//! ```text
//! mypatch/
//!   patch.json                 # engine config + format version
//!   modules/<instance>.json    # one file per module instance
//!   wires/<instance>.json      # one wire bundle per source module
//! ```
//!
//! Files are formatted deterministically (fixed field order, BTreeMaps,
//! 2-space pretty JSON, trailing newline) and only rewritten when their
//! content changes, so moving one knob and re-saving touches exactly the
//! one module file.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::engine::{Engine, EngineConfig, MidiMappingInfo};
use crate::knob::KnobState;
use crate::registry::ExtensionRegistry;

pub const PATCH_FORMAT: &str = "djpatch-1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchHeader {
    pub block_size: usize,
    pub format: String,
    pub master_channels: usize,
    pub name: String,
    pub sample_rate: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleFile {
    pub ext: String,
    #[serde(default)]
    pub knobs: BTreeMap<String, KnobState>,
    #[serde(default)]
    pub params: BTreeMap<String, f32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub midi_mappings: Vec<MidiMappingInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct WireEntry {
    pub from_jack: String,
    pub to: String,
    pub to_jack: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireFile {
    pub wires: Vec<WireEntry>,
}

fn to_pretty(value: &impl Serialize) -> Result<String> {
    let mut s = serde_json::to_string_pretty(value)?;
    s.push('\n');
    Ok(s)
}

/// Write only if content differs (keeps diffs and mtimes minimal).
fn write_if_changed(path: &Path, content: &str) -> Result<bool> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == content {
            return Ok(false);
        }
    }
    std::fs::write(path, content)?;
    Ok(true)
}

impl Engine {
    /// Save the current patch to `dir` as a directory tree.
    pub fn save_patch(&self, dir: &Path, name: &str) -> Result<()> {
        std::fs::create_dir_all(dir.join("modules"))?;
        std::fs::create_dir_all(dir.join("wires"))?;

        let header = PatchHeader {
            block_size: self.config.block_size,
            format: PATCH_FORMAT.into(),
            master_channels: self.config.master_channels,
            name: name.into(),
            sample_rate: self.config.sample_rate,
        };
        write_if_changed(&dir.join("patch.json"), &to_pretty(&header)?)?;

        let mut keep_modules = BTreeSet::new();
        let mut keep_wires = BTreeSet::new();

        for info in &self.nodes {
            let mut knobs = BTreeMap::new();
            for (jack, state) in info.manifest.inputs.iter().zip(&info.knobs) {
                knobs.insert(jack.id.clone(), state.clone());
            }
            let mf = ModuleFile {
                ext: info.ext_id.clone(),
                knobs,
                params: info.params.clone(),
                midi_mappings: info.midi_mappings.clone(),
            };
            let fname = format!("{}.json", info.instance_id);
            write_if_changed(&dir.join("modules").join(&fname), &to_pretty(&mf)?)?;
            keep_modules.insert(fname);
        }

        // One wire bundle per source node.
        let wires = self.wire_entries();
        for (source, mut entries) in wires {
            entries.sort();
            let wf = WireFile { wires: entries };
            let fname = format!("{source}.json");
            write_if_changed(&dir.join("wires").join(&fname), &to_pretty(&wf)?)?;
            keep_wires.insert(fname);
        }

        // Remove files for deleted modules/wires.
        for (sub, keep) in [("modules", &keep_modules), ("wires", &keep_wires)] {
            for entry in std::fs::read_dir(dir.join(sub))? {
                let entry = entry?;
                let fname = entry.file_name().to_string_lossy().to_string();
                if fname.ends_with(".json") && !keep.contains(&fname) {
                    std::fs::remove_file(entry.path())?;
                }
            }
        }
        Ok(())
    }

    /// Collect wires grouped by source instance, with jack names resolved.
    fn wire_entries(&self) -> BTreeMap<String, Vec<WireEntry>> {
        let mut map: BTreeMap<String, Vec<WireEntry>> = BTreeMap::new();
        let specs = self.wire_specs();
        for w in specs {
            let from = &self.nodes[w.from_node];
            let to = &self.nodes[w.to_node];
            let from_jack = self.output_jack_name(w.from_node, w.from_jack);
            let to_jack = to.manifest.inputs[w.to_jack].id.clone();
            map.entry(from.instance_id.clone())
                .or_default()
                .push(WireEntry {
                    from_jack,
                    to: to.instance_id.clone(),
                    to_jack,
                });
        }
        map
    }

    /// Load a patch directory into a fresh engine.
    pub fn load_patch(dir: &Path, registry: ExtensionRegistry) -> Result<Engine> {
        let header: PatchHeader =
            serde_json::from_str(&std::fs::read_to_string(dir.join("patch.json"))?)
                .context("reading patch.json")?;
        anyhow::ensure!(header.format == PATCH_FORMAT, "unsupported patch format");
        let config = EngineConfig {
            sample_rate: header.sample_rate,
            block_size: header.block_size,
            master_channels: header.master_channels,
        };
        let mut engine = Engine::new(config, registry)?;

        // Modules, sorted by filename for determinism.
        let mut module_files: Vec<_> = std::fs::read_dir(dir.join("modules"))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
            .collect();
        module_files.sort();
        for path in &module_files {
            let instance_id = path.file_stem().unwrap().to_string_lossy().to_string();
            let mf: ModuleFile = serde_json::from_str(&std::fs::read_to_string(path)?)
                .with_context(|| format!("reading {}", path.display()))?;
            engine.add_module(&instance_id, &mf.ext)?;
            for m in &mf.midi_mappings {
                engine.add_midi_mapping(&instance_id, &m.kind, m.num, &m.name)?;
            }
            for (param, value) in &mf.params {
                engine.set_param(&instance_id, param, *value)?;
            }
            for (jack, state) in &mf.knobs {
                engine.restore_knob(&instance_id, jack, state.clone())?;
            }
        }

        // Wires.
        let wires_dir = dir.join("wires");
        if wires_dir.is_dir() {
            let mut wire_files: Vec<_> = std::fs::read_dir(&wires_dir)?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
                .collect();
            wire_files.sort();
            for path in &wire_files {
                let source = path.file_stem().unwrap().to_string_lossy().to_string();
                let wf: WireFile = serde_json::from_str(&std::fs::read_to_string(path)?)
                    .with_context(|| format!("reading {}", path.display()))?;
                for w in &wf.wires {
                    engine.connect(&source, &w.from_jack, &w.to, &w.to_jack)?;
                }
            }
        }
        Ok(engine)
    }
}
