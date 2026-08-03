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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PatchHeader {
    pub block_size: usize,
    pub format: String,
    pub master_channels: usize,
    pub name: String,
    pub sample_rate: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModuleFile {
    pub ext: String,
    #[serde(default)]
    pub knobs: BTreeMap<String, KnobState>,
    #[serde(default)]
    pub params: BTreeMap<String, f32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub midi_mappings: Vec<MidiMappingInfo>,
    /// Track path loaded into a Playback/Deck node (absolute;
    /// library-managed). Deck cues/loops/beatgrids are *not* stored here —
    /// they are track metadata in the library DB (PRD §7) and get
    /// re-applied by the app layer after load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track: Option<String>,
    /// Deck instance this deck is beat-synced to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct WireEntry {
    pub from_jack: String,
    pub to: String,
    pub to_jack: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireFile {
    pub wires: Vec<WireEntry>,
}

/// A complete patch as an in-memory document — exactly what `save_patch`
/// writes to disk. Cheap to clone/compare; used for undo/redo snapshots.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PatchDoc {
    pub header: PatchHeader,
    /// One entry per module instance, keyed by instance id.
    pub modules: BTreeMap<String, ModuleFile>,
    /// One wire bundle per source instance.
    pub wires: BTreeMap<String, WireFile>,
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
    /// Capture the full patch state as an in-memory document (the same
    /// content `save_patch` writes to disk).
    pub fn snapshot(&self, name: &str) -> PatchDoc {
        let header = PatchHeader {
            block_size: self.config.block_size,
            format: PATCH_FORMAT.into(),
            master_channels: self.config.master_channels,
            name: name.into(),
            sample_rate: self.config.sample_rate,
        };
        let mut modules = BTreeMap::new();
        for (node_idx, info) in self.nodes.iter().enumerate() {
            let mut knobs = BTreeMap::new();
            for (jack, state) in info.manifest.inputs.iter().zip(&info.knobs) {
                knobs.insert(jack.id.clone(), state.clone());
            }
            modules.insert(
                info.instance_id.clone(),
                ModuleFile {
                    ext: info.ext_id.clone(),
                    knobs,
                    params: info.params.clone(),
                    midi_mappings: info.midi_mappings.clone(),
                    track: info.track_path.clone(),
                    sync_to: self.deck_sync_to_by_node(node_idx),
                },
            );
        }
        let wires = self
            .wire_entries()
            .into_iter()
            .map(|(source, mut entries)| {
                entries.sort();
                (source, WireFile { wires: entries })
            })
            .collect();
        PatchDoc {
            header,
            modules,
            wires,
        }
    }

    /// Save the current patch to `dir` as a directory tree.
    pub fn save_patch(&self, dir: &Path, name: &str) -> Result<()> {
        let doc = self.snapshot(name);
        std::fs::create_dir_all(dir.join("modules"))?;
        std::fs::create_dir_all(dir.join("wires"))?;
        write_if_changed(&dir.join("patch.json"), &to_pretty(&doc.header)?)?;

        let mut keep_modules = BTreeSet::new();
        let mut keep_wires = BTreeSet::new();

        for (instance_id, mf) in &doc.modules {
            let fname = format!("{instance_id}.json");
            write_if_changed(&dir.join("modules").join(&fname), &to_pretty(mf)?)?;
            keep_modules.insert(fname);
        }

        for (source, wf) in &doc.wires {
            let fname = format!("{source}.json");
            write_if_changed(&dir.join("wires").join(&fname), &to_pretty(wf)?)?;
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

    /// Build a fresh engine from an in-memory patch document.
    pub fn from_doc(doc: &PatchDoc, registry: ExtensionRegistry) -> Result<Engine> {
        anyhow::ensure!(
            doc.header.format == PATCH_FORMAT,
            "unsupported patch format"
        );
        let config = EngineConfig {
            sample_rate: doc.header.sample_rate,
            block_size: doc.header.block_size,
            master_channels: doc.header.master_channels,
        };
        let mut engine = Engine::new(config, registry)?;

        // Modules in BTreeMap (instance id) order for determinism. Deck sync
        // targets are applied after every module exists (the master deck may
        // sort after its follower).
        let mut deferred_syncs: Vec<(String, String)> = Vec::new();
        for (instance_id, mf) in &doc.modules {
            engine.add_module(instance_id, &mf.ext)?;
            for m in &mf.midi_mappings {
                engine.add_midi_mapping(instance_id, &m.kind, m.num, &m.name)?;
            }
            if let Some(track) = &mf.track {
                if mf.ext == crate::deck::DECK_ID {
                    engine.deck_load(instance_id, Path::new(track))?;
                } else {
                    engine.playback_load(instance_id, Path::new(track))?;
                }
            }
            if let Some(sync_to) = &mf.sync_to {
                deferred_syncs.push((instance_id.clone(), sync_to.clone()));
            }
            for (param, value) in &mf.params {
                engine.set_param(instance_id, param, *value)?;
            }
            for (jack, state) in &mf.knobs {
                engine.restore_knob(instance_id, jack, state.clone())?;
            }
        }
        for (instance, master) in &deferred_syncs {
            engine.deck_sync(instance, Some(master))?;
        }

        for (source, wf) in &doc.wires {
            for w in &wf.wires {
                engine.connect(source, &w.from_jack, &w.to, &w.to_jack)?;
            }
        }
        Ok(engine)
    }

    /// Load a patch directory into a fresh engine.
    pub fn load_patch(dir: &Path, registry: ExtensionRegistry) -> Result<Engine> {
        let header: PatchHeader =
            serde_json::from_str(&std::fs::read_to_string(dir.join("patch.json"))?)
                .context("reading patch.json")?;

        let mut modules = BTreeMap::new();
        for entry in std::fs::read_dir(dir.join("modules"))? {
            let path = entry?.path();
            if path.extension().map(|x| x == "json").unwrap_or(false) {
                let instance_id = path.file_stem().unwrap().to_string_lossy().to_string();
                let mf: ModuleFile = serde_json::from_str(&std::fs::read_to_string(&path)?)
                    .with_context(|| format!("reading {}", path.display()))?;
                modules.insert(instance_id, mf);
            }
        }

        let mut wires = BTreeMap::new();
        let wires_dir = dir.join("wires");
        if wires_dir.is_dir() {
            for entry in std::fs::read_dir(&wires_dir)? {
                let path = entry?.path();
                if path.extension().map(|x| x == "json").unwrap_or(false) {
                    let source = path.file_stem().unwrap().to_string_lossy().to_string();
                    let wf: WireFile = serde_json::from_str(&std::fs::read_to_string(&path)?)
                        .with_context(|| format!("reading {}", path.display()))?;
                    wires.insert(source, wf);
                }
            }
        }

        Engine::from_doc(
            &PatchDoc {
                header,
                modules,
                wires,
            },
            registry,
        )
    }
}
