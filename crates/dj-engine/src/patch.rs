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
use crate::gesture::GestureState;
use crate::knob::KnobState;
use crate::macros::{MacroConflict, MacroDef, MacroLibrary, MacroResolution};
use crate::registry::ExtensionRegistry;

pub const PATCH_FORMAT: &str = "djpatch-1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PatchHeader {
    pub block_size: usize,
    pub format: String,
    pub master_channels: usize,
    pub name: String,
    pub sample_rate: f32,
    /// Engine version that wrote the patch (informational; the `format`
    /// field is what gates compatibility).
    #[serde(default)]
    pub version: String,
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
    /// LED feedback mappings on a MIDI node (input jacks -> note/CC out).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub midi_led_mappings: Vec<MidiMappingInfo>,
    /// Gesture module state (PRD §7.3): mode selection, wheel layout, and
    /// mappings, all of which round-trip through save/load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gesture: Option<GestureState>,
    /// Track path loaded into a Playback/Deck node (absolute;
    /// library-managed). Deck cues/loops/beatgrids are *not* stored here —
    /// they are track metadata in the library DB (PRD §7) and get
    /// re-applied by the app layer after load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track: Option<String>,
    /// Deck instance this deck is beat-synced to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_to: Option<String>,
    /// For macro instances (`ext` is a macro id): the macro version this
    /// entry was saved with. Version mismatches against the library are
    /// surfaced by [`PatchDoc::macro_conflicts`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub macro_version: Option<u32>,
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
    /// Embedded copies of every macro definition used by this patch (the
    /// patch's "lockfile"; enables fork-on-version-mismatch, PRD §6).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub macros: BTreeMap<String, MacroDef>,
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

impl PatchDoc {
    /// Remove a module instance and every wire touching it from the
    /// DOCUMENT. Returns false when the instance does not exist. Live
    /// engines use [`Engine::remove_module`] (incremental); this is for
    /// editing serialized patches.
    pub fn remove_module(&mut self, instance: &str) -> bool {
        if self.modules.remove(instance).is_none() {
            return false;
        }
        self.wires.remove(instance);
        for wf in self.wires.values_mut() {
            wf.wires.retain(|w| w.to != instance);
        }
        self.wires.retain(|_, wf| !wf.wires.is_empty());
        for m in self.modules.values_mut() {
            if m.sync_to.as_deref() == Some(instance) {
                m.sync_to = None;
            }
        }
        true
    }
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
            version: env!("CARGO_PKG_VERSION").into(),
        };
        let mut modules = BTreeMap::new();
        for (node_idx, info) in self.nodes.iter_slots() {
            // Macro-internal nodes are part of the macro definition, not
            // the patch document.
            if info.instance_id.contains('/') {
                continue;
            }
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
                    midi_led_mappings: info.midi_led_mappings.clone(),
                    gesture: info.gesture.as_ref().map(|g| GestureState {
                        mode: g.active_mode().to_string(),
                        wheels: *g.wheels(),
                        mappings: self.gesture_mappings(&info.instance_id).unwrap_or_default(),
                    }),
                    track: info.track_path.clone(),
                    sync_to: self.deck_sync_to_by_node(node_idx),
                    macro_version: None,
                },
            );
        }
        // Top-level macro instances persist as references (macro id +
        // version) plus their promoted knob/param state.
        for (iid, mi) in self.macro_instances() {
            if iid.contains('/') {
                continue;
            }
            let mut knobs = BTreeMap::new();
            for (ext, node, jack) in &mi.inputs {
                if let Ok(state) = self.knob_state(node, jack) {
                    knobs.insert(ext.clone(), state);
                }
            }
            let mut params = BTreeMap::new();
            for (ext, node, param) in &mi.params {
                if let Some(info) = self.nodes.iter().find(|n| &n.instance_id == node) {
                    if let Some(v) = info.params.get(param) {
                        params.insert(ext.clone(), *v);
                    }
                }
            }
            modules.insert(
                iid.clone(),
                ModuleFile {
                    ext: mi.macro_id.clone(),
                    knobs,
                    params,
                    midi_mappings: Vec::new(),
                    midi_led_mappings: Vec::new(),
                    gesture: None,
                    track: None,
                    sync_to: None,
                    macro_version: Some(mi.version),
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
        // Embed the definitions of every macro in use (nested included —
        // nested instances appear in macro_instances too).
        let mut macros = BTreeMap::new();
        for mi in self.macro_instances().values() {
            if let Some(def) = self.macros.get(&mi.macro_id) {
                macros.insert(def.id.clone(), def.clone());
            }
        }
        PatchDoc {
            header,
            modules,
            wires,
            macros,
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
        let mut keep_macros = BTreeSet::new();

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

        // Embedded macro definitions (only when the patch uses macros).
        if !doc.macros.is_empty() {
            std::fs::create_dir_all(dir.join("macros"))?;
        }
        for (macro_id, def) in &doc.macros {
            let fname = format!("{macro_id}.json");
            write_if_changed(&dir.join("macros").join(&fname), &to_pretty(def)?)?;
            keep_macros.insert(fname);
        }

        // Remove files for deleted modules/wires/macros.
        for (sub, keep) in [
            ("modules", &keep_modules),
            ("wires", &keep_wires),
            ("macros", &keep_macros),
        ] {
            let sub_dir = dir.join(sub);
            if !sub_dir.is_dir() {
                continue;
            }
            for entry in std::fs::read_dir(sub_dir)? {
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
    /// Macro-aware: wires fully inside one macro instance are part of its
    /// definition (skipped); wires crossing a macro boundary are rewritten
    /// to the instance's external jack names.
    fn wire_entries(&self) -> BTreeMap<String, Vec<WireEntry>> {
        fn top_owner(id: &str) -> &str {
            id.split('/').next().unwrap_or(id)
        }
        let mut map: BTreeMap<String, Vec<WireEntry>> = BTreeMap::new();
        let specs = self.wire_specs();
        for w in specs {
            let from = &self.nodes[w.from_node];
            let to = &self.nodes[w.to_node];
            let from_internal = from.instance_id.contains('/');
            let to_internal = to.instance_id.contains('/');
            let from_owner = top_owner(&from.instance_id);
            let to_owner = top_owner(&to.instance_id);
            if (from_internal || to_internal) && from_owner == to_owner {
                // Internal to one macro instance: part of the definition.
                continue;
            }
            // Resolve each endpoint to (owner instance, persisted jack name).
            let (src, from_jack) = if from_internal {
                let jack_name = self.output_jack_name(w.from_node, w.from_jack);
                let Some(ext) = self.macro_instances().get(from_owner).and_then(|mi| {
                    mi.outputs
                        .iter()
                        .find(|(_, n, j)| n == &from.instance_id && j == &jack_name)
                        .map(|(e, _, _)| e.clone())
                }) else {
                    continue; // not promoted: unreachable via public API
                };
                (from_owner.to_string(), ext)
            } else {
                (
                    from.instance_id.clone(),
                    self.output_jack_name(w.from_node, w.from_jack),
                )
            };
            let (dst, to_jack) = if to_internal {
                let jack_name = self.input_jack_name(w.to_node, w.to_jack);
                let Some(ext) = self.macro_instances().get(to_owner).and_then(|mi| {
                    mi.inputs
                        .iter()
                        .find(|(_, n, j)| n == &to.instance_id && j == &jack_name)
                        .map(|(e, _, _)| e.clone())
                }) else {
                    continue;
                };
                (to_owner.to_string(), ext)
            } else {
                (
                    to.instance_id.clone(),
                    self.input_jack_name(w.to_node, w.to_jack),
                )
            };
            map.entry(src).or_default().push(WireEntry {
                from_jack,
                to: dst,
                to_jack,
            });
        }
        map
    }

    /// Build a fresh engine from an in-memory patch document.
    pub fn from_doc(doc: &PatchDoc, registry: ExtensionRegistry) -> Result<Engine> {
        Engine::from_doc_with_macros(doc, registry, MacroLibrary::default())
    }

    /// Build a fresh engine from a patch document, seeding the engine's
    /// macro library from `macros` (typically the user library store).
    /// Definitions embedded in the document win over the seeded library so
    /// the patch loads exactly as saved; run
    /// [`PatchDoc::macro_conflicts`]/[`PatchDoc::resolve_macro_conflict`]
    /// first to apply an update-vs-fork decision.
    pub fn from_doc_with_macros(
        doc: &PatchDoc,
        registry: ExtensionRegistry,
        macros: MacroLibrary,
    ) -> Result<Engine> {
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
        engine.macros = macros;
        for def in doc.macros.values() {
            engine.macros.register(def.clone());
        }

        // Modules in BTreeMap (instance id) order for determinism. Deck sync
        // targets are applied after every module exists (the master deck may
        // sort after its follower).
        let mut deferred_syncs: Vec<(String, String)> = Vec::new();
        for (instance_id, mf) in &doc.modules {
            engine.add_module_from_file(instance_id, mf, &mut deferred_syncs)?;
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

    /// Add one module instance from its patch entry, restoring mappings,
    /// gesture state, track, params and knobs. Deck sync targets are pushed
    /// onto `deferred_syncs` (applied once every module exists).
    fn add_module_from_file(
        &mut self,
        instance_id: &str,
        mf: &ModuleFile,
        deferred_syncs: &mut Vec<(String, String)>,
    ) -> Result<()> {
        self.add_module(instance_id, &mf.ext)?;
        for m in &mf.midi_mappings {
            self.add_midi_mapping(instance_id, m.kind, m.num, &m.name)?;
        }
        for m in &mf.midi_led_mappings {
            self.add_midi_led_mapping(instance_id, m.kind, m.num, &m.name)?;
        }
        if let Some(g) = &mf.gesture {
            self.gesture_set_mode(instance_id, &g.mode)?;
            self.gesture_set_wheels(instance_id, g.wheels)?;
            for m in &g.mappings {
                self.restore_gesture_mapping(instance_id, m)?;
            }
        }
        if let Some(track) = &mf.track {
            if crate::builtin::BuiltinKind::from_ext_id(&mf.ext)
                == Some(crate::builtin::BuiltinKind::Deck)
            {
                self.deck_load(instance_id, Path::new(track))?;
            } else {
                self.playback_load(instance_id, Path::new(track))?;
            }
        }
        if let Some(sync_to) = &mf.sync_to {
            deferred_syncs.push((instance_id.to_string(), sync_to.clone()));
        }
        for (param, value) in &mf.params {
            self.set_param(instance_id, param, *value)?;
        }
        for (jack, state) in &mf.knobs {
            self.restore_knob(instance_id, jack, state.clone())?;
        }
        Ok(())
    }

    /// Morph the LIVE engine into `doc` by diffing, instead of rebuilding:
    /// modules present in both keep their graph slot, module (DSP) state and
    /// telemetry windows — only what actually differs is touched. This is
    /// the undo/redo/structural-edit restore path; loading a patch into a
    /// fresh engine is [`Engine::from_doc`].
    ///
    /// The engine must be stopped (structural edit). The doc's header must
    /// match the engine's config — undo history never changes it.
    ///
    /// Returns the instance ids that were (re)created from scratch (missing
    /// from the live engine, or whose shape changed) — their fresh state may
    /// need app-layer re-application (deck metadata, stems).
    pub fn apply_doc(&mut self, doc: &PatchDoc) -> Result<Vec<String>> {
        self.core_mut()?; // must be stopped
        anyhow::ensure!(
            doc.header.format == PATCH_FORMAT,
            "unsupported patch format"
        );
        anyhow::ensure!(
            doc.header.sample_rate == self.config.sample_rate
                && doc.header.block_size == self.config.block_size
                && doc.header.master_channels == self.config.master_channels,
            "apply_doc cannot change the engine config (load a fresh patch instead)"
        );
        for def in doc.macros.values() {
            self.macros.register(def.clone());
        }

        // Which top-level instances must be (re)created: missing, different
        // ext, macro version bump, or a track that can't be un-loaded
        // in place.
        let current: Vec<String> = self
            .nodes
            .iter()
            .map(|n| n.instance_id.clone())
            .filter(|id| !id.contains('/'))
            .chain(
                self.macro_instances()
                    .keys()
                    .filter(|id| !id.contains('/'))
                    .cloned(),
            )
            .collect();
        let mut recreate: Vec<String> = Vec::new();
        for id in &current {
            match doc.modules.get(id) {
                None => recreate.push(id.clone()),
                Some(mf) => {
                    if !self.module_matches_shape(id, mf) {
                        recreate.push(id.clone());
                    }
                }
            }
        }
        for id in &recreate {
            self.remove_module(id)?;
        }

        // Diff kept modules in place; collect new ones.
        let mut created: Vec<String> = Vec::new();
        let mut deferred_syncs: Vec<(String, String)> = Vec::new();
        for (instance_id, mf) in &doc.modules {
            if recreate.iter().any(|r| r == instance_id) || (!self.has_instance(instance_id)) {
                self.add_module_from_file(instance_id, mf, &mut deferred_syncs)?;
                created.push(instance_id.clone());
            } else {
                self.diff_module_in_place(instance_id, mf, &mut deferred_syncs)?;
            }
        }

        // Wire diff by persisted names (jack indices may have changed when
        // mappings were rebuilt).
        let want: BTreeSet<(String, WireEntry)> = doc
            .wires
            .iter()
            .flat_map(|(src, wf)| wf.wires.iter().map(move |w| (src.clone(), w.clone())))
            .collect();
        let have: BTreeSet<(String, WireEntry)> = self
            .wire_entries()
            .into_iter()
            .flat_map(|(src, ws)| ws.into_iter().map(move |w| (src.clone(), w)))
            .collect();
        for (src, w) in have.difference(&want) {
            self.disconnect(src, &w.from_jack, &w.to, &w.to_jack)?;
        }
        for (src, w) in want.difference(&have) {
            self.connect(src, &w.from_jack, &w.to, &w.to_jack)?;
        }

        // Deck sync state for every kept deck (adds queued theirs above).
        for (instance, master) in &deferred_syncs {
            self.deck_sync(instance, Some(master))?;
        }
        Ok(created)
    }

    fn has_instance(&self, id: &str) -> bool {
        self.macro_instances().contains_key(id) || self.nodes.iter().any(|n| n.instance_id == id)
    }

    /// Can `id` be morphed into `mf` in place? Same ext, same macro
    /// version, and no track unload (tracks can be replaced, not removed).
    fn module_matches_shape(&self, id: &str, mf: &ModuleFile) -> bool {
        if let Some(mi) = self.macro_instances().get(id) {
            return mi.macro_id == mf.ext && Some(mi.version) == mf.macro_version;
        }
        let Some(info) = self.nodes.iter().find(|n| n.instance_id == id) else {
            return false;
        };
        if info.ext_id != mf.ext {
            return false;
        }
        if info.track_path.is_some() && mf.track.is_none() {
            return false;
        }
        true
    }

    /// Bring one kept module's control state to `mf`, touching only what
    /// differs. DSP state (sequencer position, LFO phase, …) and telemetry
    /// stay live throughout.
    fn diff_module_in_place(
        &mut self,
        instance_id: &str,
        mf: &ModuleFile,
        deferred_syncs: &mut Vec<(String, String)>,
    ) -> Result<()> {
        // MIDI mappings: rebuilt wholesale when the set differs (jack
        // allocation is order-dependent; wires re-resolve by name later).
        if self.macro_instances().get(instance_id).is_none() {
            let node = self.node_idx(instance_id)?;
            let cur: Vec<(String, crate::builtin::MidiMapKind, u8)> = self.nodes[node]
                .midi_mappings
                .iter()
                .map(|m| (m.name.clone(), m.kind, m.num))
                .collect();
            let want: Vec<(String, crate::builtin::MidiMapKind, u8)> = mf
                .midi_mappings
                .iter()
                .map(|m| (m.name.clone(), m.kind, m.num))
                .collect();
            if cur != want {
                for (name, _, _) in &cur {
                    self.remove_midi_mapping(instance_id, name)?;
                }
                for m in &mf.midi_mappings {
                    self.add_midi_mapping(instance_id, m.kind, m.num, &m.name)?;
                }
            }
            let cur: Vec<(String, crate::builtin::MidiMapKind, u8)> = self.nodes[node]
                .midi_led_mappings
                .iter()
                .map(|m| (m.name.clone(), m.kind, m.num))
                .collect();
            let want: Vec<(String, crate::builtin::MidiMapKind, u8)> = mf
                .midi_led_mappings
                .iter()
                .map(|m| (m.name.clone(), m.kind, m.num))
                .collect();
            if cur != want {
                for (name, _, _) in &cur {
                    self.remove_midi_led_mapping(instance_id, name)?;
                }
                for m in &mf.midi_led_mappings {
                    self.add_midi_led_mapping(instance_id, m.kind, m.num, &m.name)?;
                }
            }

            // Gesture state (mode, wheels, mappings).
            if let Some(g) = &mf.gesture {
                if self.nodes[node].gesture.is_some() {
                    let p = self.nodes[node].gesture.as_ref().unwrap();
                    if p.active_mode() != g.mode {
                        self.gesture_set_mode(instance_id, &g.mode)?;
                    }
                    let node = self.node_idx(instance_id)?;
                    if *self.nodes[node].gesture.as_ref().unwrap().wheels() != g.wheels {
                        self.gesture_set_wheels(instance_id, g.wheels)?;
                    }
                    let cur = self.gesture_mappings(instance_id)?;
                    if cur != g.mappings {
                        for m in &cur {
                            self.remove_gesture_mapping(instance_id, &m.name)?;
                        }
                        for m in &g.mappings {
                            self.restore_gesture_mapping(instance_id, m)?;
                        }
                    }
                }
            }

            // Track (replace only; unload forces recreate upstream).
            let node = self.node_idx(instance_id)?;
            if let Some(track) = &mf.track {
                if self.nodes[node].track_path.as_deref() != Some(track.as_str()) {
                    if self.nodes[node].is_deck() {
                        self.deck_load(instance_id, Path::new(track))?;
                    } else {
                        self.playback_load(instance_id, Path::new(track))?;
                    }
                }
            }

            // Deck sync partner.
            if self.nodes[node].is_deck() && self.deck_sync_to(instance_id)? != mf.sync_to {
                match &mf.sync_to {
                    Some(master) => deferred_syncs.push((instance_id.to_string(), master.clone())),
                    None => self.deck_sync(instance_id, None)?,
                }
            }
        }

        // Params and knobs (macro externals resolve through the instance).
        for (param, value) in &mf.params {
            let (rid, rparam) = self.resolve_param(instance_id, param)?;
            let node = self.node_idx(&rid)?;
            if self.nodes[node].params.get(&rparam) != Some(value) {
                self.set_param(instance_id, param, *value)?;
            }
        }
        for (jack, state) in &mf.knobs {
            if &self.knob_state(instance_id, jack)? != state {
                self.restore_knob(instance_id, jack, state.clone())?;
            }
        }
        Ok(())
    }

    /// Load a patch directory into a fresh engine (macros expand from the
    /// definitions embedded in the patch). For update-vs-fork prompting
    /// against a library, use [`PatchDoc::read`] + `macro_conflicts` +
    /// `resolve_macro_conflict` + [`Engine::from_doc_with_macros`].
    pub fn load_patch(dir: &Path, registry: ExtensionRegistry) -> Result<Engine> {
        Engine::from_doc(&PatchDoc::read(dir)?, registry)
    }
}

impl PatchDoc {
    /// Read a patch directory into an in-memory document.
    pub fn read(dir: &Path) -> Result<PatchDoc> {
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

        let mut macros = BTreeMap::new();
        let macros_dir = dir.join("macros");
        if macros_dir.is_dir() {
            for entry in std::fs::read_dir(&macros_dir)? {
                let path = entry?.path();
                if path.extension().map(|x| x == "json").unwrap_or(false) {
                    let def: MacroDef = serde_json::from_str(&std::fs::read_to_string(&path)?)
                        .with_context(|| format!("reading {}", path.display()))?;
                    macros.insert(def.id.clone(), def);
                }
            }
        }

        Ok(PatchDoc {
            header,
            modules,
            wires,
            macros,
        })
    }

    /// Version mismatches between this patch's embedded macro definitions
    /// and a library (PRD §6: prompt update-or-fork at load).
    pub fn macro_conflicts(&self, lib: &MacroLibrary) -> Vec<MacroConflict> {
        self.macros
            .values()
            .filter_map(|d| {
                lib.get(&d.id).and_then(|l| {
                    (l.version != d.version).then(|| MacroConflict {
                        macro_id: d.id.clone(),
                        patch_version: d.version,
                        library_version: l.version,
                    })
                })
            })
            .collect()
    }

    /// Apply an update-vs-fork decision for one conflicted macro. This is
    /// the logic behind the UI prompt's two buttons:
    ///
    /// - [`MacroResolution::UpdateToLibrary`]: the patch adopts the
    ///   library's definition (instances re-expand with the new version).
    /// - [`MacroResolution::Fork`]: the patch's embedded definition is
    ///   registered in the library under a new id (version 1) and every
    ///   reference in the patch (including nested ones inside other
    ///   embedded macros) is rewritten to the fork.
    pub fn resolve_macro_conflict(
        &mut self,
        macro_id: &str,
        resolution: &MacroResolution,
        lib: &mut MacroLibrary,
    ) -> Result<()> {
        match resolution {
            MacroResolution::UpdateToLibrary => {
                let def = lib
                    .get(macro_id)
                    .ok_or_else(|| anyhow::anyhow!("macro {macro_id:?} not in library"))?
                    .clone();
                let version = def.version;
                self.macros.insert(macro_id.to_string(), def);
                for mf in self.modules.values_mut() {
                    if mf.ext == macro_id {
                        mf.macro_version = Some(version);
                    }
                }
            }
            MacroResolution::Fork { new_id } => {
                anyhow::ensure!(
                    lib.get(new_id).is_none() && !self.macros.contains_key(new_id),
                    "macro id {new_id:?} already exists"
                );
                let mut def = self
                    .macros
                    .remove(macro_id)
                    .ok_or_else(|| anyhow::anyhow!("macro {macro_id:?} not in patch"))?;
                def.id = new_id.clone();
                def.version = 1;
                def.name = format!("{} (fork)", def.name);
                lib.register(def.clone());
                self.macros.insert(new_id.clone(), def);
                for mf in self.modules.values_mut() {
                    if mf.ext == macro_id {
                        mf.ext = new_id.clone();
                        mf.macro_version = Some(1);
                    }
                }
                // Nested references inside other embedded definitions keep
                // the patch's saved sound by pointing at the fork too.
                for def in self.macros.values_mut() {
                    for mf in def.modules.values_mut() {
                        if mf.ext == macro_id {
                            mf.ext = new_id.clone();
                            mf.macro_version = Some(1);
                        }
                    }
                }
            }
        }
        Ok(())
    }
}
