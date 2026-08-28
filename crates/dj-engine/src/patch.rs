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

use crate::beat_clip::BeatClipRef;
use crate::choreo::ChoreoState;
use crate::decks::DecksState;
use crate::engine::{Engine, EngineConfig, MidiMappingInfo};
use crate::knob::KnobState;
use crate::macros::{MacroDef, MacroInstance, MacroLibrary};
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
    /// User-typed display name (caps/spaces preserved). The map key is its
    /// normalized form ([`crate::engine::normalize_module_name`]); absent
    /// when the module displays as its instance id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub knobs: BTreeMap<String, KnobState>,
    #[serde(default)]
    pub params: BTreeMap<String, f32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub midi_mappings: Vec<MidiMappingInfo>,
    /// LED feedback mappings on a MIDI node (input jacks -> note/CC out).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub midi_led_mappings: Vec<MidiMappingInfo>,
    /// Choreography timeline (beats + tracks; round-trips through
    /// save/load, jack slots included so wires stay valid).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choreo: Option<ChoreoState>,
    /// A Decks bank's eight slots: which clip each plays, its level, tone
    /// controls, mute/solo and its place on the bank's grid. Like a Beat
    /// Clip's binding, the clips' AUDIO is not here — the app layer
    /// re-assembles it after a load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decks: Option<DecksState>,
    /// Track path loaded into a Playback/Deck node (absolute;
    /// library-managed). Deck cues/loops/beatgrids are *not* stored here —
    /// they are track metadata in the library DB (PRD §7) and get
    /// re-applied by the app layer after load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track: Option<String>,
    /// Which Beatify clip a Beat Clip node plays. The clip's AUDIO is not
    /// persisted (a clip is placements, re-assembled on demand) — the app
    /// layer loads it after a patch load, like deck metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip: Option<BeatClipRef>,
    /// Deck instance this deck is beat-synced to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_to: Option<String>,
    /// Module bypassed: the manifest's bypass routes copy input to output
    /// and the DSP does not run. Omitted when off, so a patch saved before
    /// bypass existed — and every module that is not bypassed — is
    /// byte-identical to what it was.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bypassed: bool,
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

/// One macro instance's private definition, saved as
/// `macros/<instance>.json` inside the patch tree.
///
/// `def` is the copy the instance was adopted with — the "defaults" that
/// *reset to defaults* restores and that survive edits to the global base.
/// `state` is the instance's current subgraph (internal knobs, params,
/// wires, names) when it has drifted from `def`; absent means "unmodified".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MacroInstanceFile {
    pub def: MacroDef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<MacroDef>,
}

impl MacroInstanceFile {
    /// What the instance actually runs: its live state, or the adopted
    /// copy when it has none.
    pub fn effective(&self) -> &MacroDef {
        self.state.as_ref().unwrap_or(&self.def)
    }
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
    /// Per-INSTANCE macro definitions, keyed by instance id: every macro
    /// instance carries its own copy, so a patch is self-contained and
    /// never changes when a global base does (PRD §6).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub macros: BTreeMap<String, MacroInstanceFile>,
    /// Rack layout: node instance id (macro members' `/`-prefixed ids
    /// included) -> unzoomed rack position. Pure UI passthrough
    /// ([`crate::engine::NodeInfo::position`]); saved as `layout.json`
    /// only when non-empty so pre-layout patches stay byte-identical.
    /// Riding in the snapshot is what makes moves/deletes undoable with
    /// layout intact.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub layout: BTreeMap<String, (f32, f32)>,
}

pub(crate) fn to_pretty(value: &impl Serialize) -> Result<String> {
    let mut s = serde_json::to_string_pretty(value)?;
    s.push('\n');
    Ok(s)
}

/// Write only if content differs (keeps diffs and mtimes minimal).
pub(crate) fn write_if_changed(path: &Path, content: &str) -> Result<bool> {
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
        self.macros.remove(instance);
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
        // Layout entries for the module (or, for a macro instance, its
        // `/`-prefixed members) go with it.
        let member_prefix = format!("{instance}/");
        self.layout
            .retain(|id, _| id != instance && !id.starts_with(&member_prefix));
        true
    }

    /// Copy: extract `selection` as a standalone clipboard document. Keeps
    /// wires INTERNAL to the selection (both ends selected) and drops
    /// everything referencing modules outside it (external wires, external
    /// deck sync targets). Macro definitions used by selected instances are
    /// carried along so the clipboard pastes into other patches.
    pub fn extract_selection(&self, selection: &[String]) -> PatchDoc {
        let selected: BTreeSet<&str> = selection.iter().map(String::as_str).collect();
        let mut modules = BTreeMap::new();
        for (id, mf) in &self.modules {
            if !selected.contains(id.as_str()) {
                continue;
            }
            let mut mf = mf.clone();
            if let Some(sync) = &mf.sync_to {
                if !selected.contains(sync.as_str()) {
                    mf.sync_to = None;
                }
            }
            modules.insert(id.clone(), mf);
        }
        let mut wires = BTreeMap::new();
        for (src, wf) in &self.wires {
            if !modules.contains_key(src) {
                continue;
            }
            let internal: Vec<WireEntry> = wf
                .wires
                .iter()
                .filter(|w| modules.contains_key(&w.to))
                .cloned()
                .collect();
            if !internal.is_empty() {
                wires.insert(src.clone(), WireFile { wires: internal });
            }
        }
        let macros = self
            .macros
            .iter()
            .filter(|(instance_id, _)| modules.contains_key(*instance_id))
            .map(|(instance_id, file)| (instance_id.clone(), file.clone()))
            .collect();
        PatchDoc {
            header: self.header.clone(),
            modules,
            wires,
            macros,
            // The clipboard carries no rack layout: pasted copies get fresh
            // ids and the frontend lays them out at the paste point.
            layout: BTreeMap::new(),
        }
    }

    /// Paste: merge `clipboard` (an [`extract_selection`] result) into this
    /// document under fresh instance ids, remapping the clipboard's internal
    /// wires and sync targets to the new names. Returns old id -> new id.
    pub fn paste(&mut self, clipboard: &PatchDoc) -> BTreeMap<String, String> {
        let mut renames: BTreeMap<String, String> = BTreeMap::new();
        for old in clipboard.modules.keys() {
            let base = old.trim_end_matches(|c: char| c.is_ascii_digit());
            let base = if base.is_empty() { "mod" } else { base };
            let fresh = (1..)
                .map(|n| format!("{base}{n}"))
                .find(|c| !self.modules.contains_key(c) && !renames.values().any(|v| v == c))
                .unwrap();
            renames.insert(old.clone(), fresh);
        }
        // Each pasted instance brings its own copy of the definition along
        // under its fresh id.
        for (old, file) in &clipboard.macros {
            self.macros.insert(renames[old].clone(), file.clone());
        }
        for (old, mf) in &clipboard.modules {
            let mut mf = mf.clone();
            mf.sync_to = mf.sync_to.and_then(|s| renames.get(&s).cloned());
            // The copy gets a fresh id; carrying the display name over
            // would break its normalized-form == id invariant.
            mf.name = None;
            self.modules.insert(renames[old].clone(), mf);
        }
        for (src, wf) in &clipboard.wires {
            let entries: Vec<WireEntry> = wf
                .wires
                .iter()
                .filter_map(|w| {
                    Some(WireEntry {
                        from_jack: w.from_jack.clone(),
                        to: renames.get(&w.to)?.clone(),
                        to_jack: w.to_jack.clone(),
                    })
                })
                .collect();
            if let Some(new_src) = renames.get(src) {
                self.wires
                    .insert(new_src.clone(), WireFile { wires: entries });
            }
        }
        renames
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
            // Macro-internal nodes ride in their instance's own entry
            // (`PatchDoc::macros`), not in the patch's module list.
            if info.instance_id.contains('/') {
                continue;
            }
            modules.insert(info.instance_id.clone(), self.module_file(node_idx, info));
        }
        // Macro instances persist as a reference (the macro id) plus their
        // promoted knob/param state; the definition itself is a per-instance
        // copy in `macros`.
        for (iid, mi) in self.macro_instances() {
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
                    name: mi.display_name.clone(),
                    knobs,
                    params,
                    midi_mappings: Vec::new(),
                    midi_led_mappings: Vec::new(),
                    choreo: None,
                    decks: None,
                    track: None,
                    clip: None,
                    sync_to: None,
                    bypassed: false,
                },
            );
        }
        // Per-instance definitions: the adopted copy plus, when the
        // instance has drifted from it, its current internal state.
        let macros = self
            .macro_instances()
            .iter()
            .map(|(iid, mi)| {
                let live = self.instance_state(iid, mi);
                let state = (live != mi.def).then_some(live);
                (
                    iid.clone(),
                    MacroInstanceFile {
                        def: mi.def.clone(),
                        state,
                    },
                )
            })
            .collect();
        let wires = self
            .wire_entries()
            .into_iter()
            .map(|(source, mut entries)| {
                entries.sort();
                (source, WireFile { wires: entries })
            })
            .collect();
        // Rack layout: every placed node, macro members included (their
        // `/`-prefixed ids are how a macro-delete undo restores the whole
        // group's arrangement).
        let layout = self
            .nodes
            .iter()
            .filter_map(|n| n.position.map(|p| (n.instance_id.clone(), p)))
            .collect();
        PatchDoc {
            header,
            modules,
            wires,
            macros,
            layout,
        }
    }

    /// One node's persisted control state.
    fn module_file(&self, node_idx: usize, info: &crate::engine::NodeInfo) -> ModuleFile {
        let mut knobs = BTreeMap::new();
        for (jack, state) in info.manifest.inputs.iter().zip(&info.knobs) {
            knobs.insert(jack.id.clone(), state.clone());
        }
        ModuleFile {
            ext: info.ext_id.clone(),
            name: info.display_name.clone(),
            knobs,
            params: info.params.clone(),
            midi_mappings: info.midi_mappings.clone(),
            midi_led_mappings: info.midi_led_mappings.clone(),
            choreo: info.choreo.clone(),
            decks: self.decks_state(&info.instance_id).ok(),
            track: info.track_path.clone(),
            clip: info.clip.clone(),
            sync_to: self.deck_sync_to_by_node(node_idx),
            bypassed: info.bypassed,
        }
    }

    /// One macro instance's CURRENT subgraph as a definition: its internal
    /// modules (knobs, params, mappings, display names) and the wires
    /// between them, under ids relative to the instance.
    ///
    /// Interface and saved positions come from the adopted copy: the
    /// interface only changes by re-collapsing, and member layout is UI
    /// state that rides in `PatchDoc::layout` (it reaches a definition only
    /// through an explicit *save macro*).
    fn instance_state(&self, instance_id: &str, mi: &MacroInstance) -> MacroDef {
        let prefix = format!("{instance_id}/");
        let mut modules = BTreeMap::new();
        for (node_idx, info) in self.nodes.iter_slots() {
            let Some(inner) = info.instance_id.strip_prefix(&prefix) else {
                continue;
            };
            let mut mf = self.module_file(node_idx, info);
            mf.sync_to = mf
                .sync_to
                .and_then(|s| s.strip_prefix(&prefix).map(str::to_string));
            modules.insert(inner.to_string(), mf);
        }
        // Internal wires come straight off the graph: `wire_entries` hides
        // them precisely because they belong to a definition.
        let mut wires: BTreeMap<String, WireFile> = BTreeMap::new();
        for w in self.wire_specs() {
            let (Some(src), Some(dst)) = (
                self.nodes[w.from_node].instance_id.strip_prefix(&prefix),
                self.nodes[w.to_node].instance_id.strip_prefix(&prefix),
            ) else {
                continue;
            };
            wires
                .entry(src.to_string())
                .or_insert_with(|| WireFile { wires: Vec::new() })
                .wires
                .push(WireEntry {
                    from_jack: self.output_jack_name(w.from_node, w.from_jack),
                    to: dst.to_string(),
                    to_jack: self.input_jack_name(w.to_node, w.to_jack),
                });
        }
        for wf in wires.values_mut() {
            wf.wires.sort();
        }
        MacroDef {
            id: mi.def.id.clone(),
            name: mi.def.name.clone(),
            modules,
            wires,
            interface: mi.def.interface.clone(),
            positions: mi.def.positions.clone(),
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

        // Per-instance macro definitions (only when the patch uses macros).
        if !doc.macros.is_empty() {
            std::fs::create_dir_all(dir.join("macros"))?;
        }
        for (instance_id, file) in &doc.macros {
            let fname = format!("{instance_id}.json");
            write_if_changed(&dir.join("macros").join(&fname), &to_pretty(file)?)?;
            keep_macros.insert(fname);
        }

        // Rack layout (UI passthrough): one small file, only when any node
        // has a recorded position — pre-layout patches stay untouched.
        let layout_path = dir.join("layout.json");
        if doc.layout.is_empty() {
            if layout_path.exists() {
                std::fs::remove_file(&layout_path)?;
            }
        } else {
            write_if_changed(&layout_path, &to_pretty(&doc.layout)?)?;
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

    /// Build a fresh engine from a patch document, seeding the BASE macro
    /// library from `macros` (the global store). The bases only feed the
    /// picker and *pull latest*: every instance expands from its own copy
    /// in the document, so the patch sounds exactly as it was saved
    /// whatever the store now holds.
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

        // Modules in BTreeMap (instance id) order for determinism. Deck sync
        // targets are applied after every module exists (the master deck may
        // sort after its follower).
        let mut deferred_syncs: Vec<(String, String)> = Vec::new();
        for (instance_id, mf) in &doc.modules {
            engine.add_module_from_file(
                instance_id,
                mf,
                doc.macros.get(instance_id),
                &mut deferred_syncs,
            )?;
        }
        for (instance, master) in &deferred_syncs {
            engine.deck_sync(instance, Some(master))?;
        }

        for (source, wf) in &doc.wires {
            for w in &wf.wires {
                // A wire referencing a jack a newer module manifest no longer
                // has must not brick the whole patch: drop it and warn.
                if let Err(e) = engine.connect(source, &w.from_jack, &w.to, &w.to_jack) {
                    engine.load_warnings.push(format!(
                        "dropped wire {source}:{} -> {}:{} ({e})",
                        w.from_jack, w.to, w.to_jack
                    ));
                }
            }
        }
        engine.apply_layout(doc);
        Ok(engine)
    }

    /// Bring every node's rack position to the doc's layout (clearing
    /// positions the doc doesn't know). Pure control-side bookkeeping.
    fn apply_layout(&mut self, doc: &PatchDoc) {
        for info in self.nodes.iter_mut() {
            info.position = doc.layout.get(&info.instance_id).copied();
        }
    }

    /// Load a saved track path into whichever track-playing module the
    /// node is. Patches persist only the path — an Audio node's tempo
    /// rides along in its saved knobs, deck grids/cues/loops come from the
    /// library, both re-applied by the caller/app layer after load.
    pub(crate) fn load_module_track(
        &mut self,
        instance_id: &str,
        kind: Option<crate::builtin::BuiltinKind>,
        track: &str,
    ) -> Result<()> {
        match kind {
            Some(crate::builtin::BuiltinKind::Deck) => {
                self.deck_load(instance_id, Path::new(track))
            }
            Some(crate::builtin::BuiltinKind::Audio) => {
                self.audio_load(instance_id, Path::new(track), None)
            }
            _ => self.playback_load(instance_id, Path::new(track)),
        }
    }

    /// Add one module instance from its patch entry, restoring mappings,
    /// track, params and knobs. Deck sync targets are pushed
    /// onto `deferred_syncs` (applied once every module exists).
    fn add_module_from_file(
        &mut self,
        instance_id: &str,
        mf: &ModuleFile,
        macro_file: Option<&MacroInstanceFile>,
        deferred_syncs: &mut Vec<(String, String)>,
    ) -> Result<()> {
        match macro_file {
            // A macro instance expands from its own copy, never from the
            // base of the same id.
            Some(file) => self.adopt_macro(instance_id, file)?,
            None => self.add_module(instance_id, &mf.ext)?,
        }
        if mf.name.is_some() {
            self.set_display_name(instance_id, mf.name.clone())?;
        }
        for m in &mf.midi_mappings {
            self.add_midi_mapping(instance_id, m.kind, m.num, &m.name)?;
        }
        for m in &mf.midi_led_mappings {
            self.add_midi_led_mapping(instance_id, m.kind, m.num, &m.name)?;
        }
        if let Some(c) = &mf.choreo {
            self.choreo_set_state(instance_id, c.clone())?;
        }
        if let Some(d) = &mf.decks {
            self.decks_set_state(instance_id, d.clone())?;
        }
        if let Some(track) = &mf.track {
            let kind = crate::builtin::BuiltinKind::from_ext_id(&mf.ext);
            self.load_module_track(instance_id, kind, track)?;
        }
        if mf.clip.is_some() {
            self.beat_clip_bind(instance_id, mf.clip.clone())?;
        }
        if let Some(sync_to) = &mf.sync_to {
            deferred_syncs.push((instance_id.to_string(), sync_to.clone()));
        }
        if mf.bypassed {
            // A module whose newer manifest dropped its bypass routes just
            // comes back live — worth a warning, never a failed load.
            if let Err(e) = self.set_bypass(instance_id, true) {
                self.load_warnings
                    .push(format!("{instance_id}: dropped saved bypass ({e})"));
            }
        }
        for (param, value) in &mf.params {
            // A param the module no longer declares: skip it, but warn —
            // params are user-visible mode state (keylock, stem gains).
            if self.set_param(instance_id, param, *value).is_err() {
                self.load_warnings
                    .push(format!("{instance_id}: dropped saved param {param:?}"));
            }
        }
        for (jack, state) in &mf.knobs {
            // A knob entry for a jack the module no longer has is just
            // stale persisted state with nothing user-visible attached
            // (dropped wires warn separately) — skip it silently.
            let _ = self.restore_knob(instance_id, jack, state.clone());
        }
        Ok(())
    }

    /// Morph the LIVE engine into `doc` by diffing, instead of rebuilding:
    /// modules present in both keep their graph slot, module (DSP) state and
    /// telemetry windows — only what actually differs is touched. This is
    /// the undo/redo/structural-edit restore path; loading a patch into a
    /// fresh engine is [`Engine::from_doc`].
    ///
    /// Works while running (edits land at block boundaries; audio never
    /// stops) or stopped. The doc's header must match the engine's config —
    /// undo history never changes it.
    ///
    /// Returns the instance ids that were (re)created from scratch (missing
    /// from the live engine, or whose shape changed) — their fresh state may
    /// need app-layer re-application (deck metadata, stems).
    pub fn apply_doc(&mut self, doc: &PatchDoc) -> Result<Vec<String>> {
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
        // Which top-level instances must be (re)created: missing, different
        // ext, a macro instance whose definition changed, or a track that
        // can't be un-loaded in place.
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
                    if !self.module_matches_shape(id, mf, doc.macros.get(id)) {
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
                self.add_module_from_file(
                    instance_id,
                    mf,
                    doc.macros.get(instance_id),
                    &mut deferred_syncs,
                )?;
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

        // Rack layout last, when every node (recreated macro members
        // included) exists — this is what moves modules back on undo.
        self.apply_layout(doc);
        Ok(created)
    }

    fn has_instance(&self, id: &str) -> bool {
        self.macro_instances().contains_key(id) || self.nodes.iter().any(|n| n.instance_id == id)
    }

    /// Can `id` be morphed into `mf` in place? Same ext, an unchanged macro
    /// definition (adopted copy AND live internals — internal edits are
    /// invisible to the module/wire diff, so they re-expand), and no track
    /// unload (tracks can be replaced, not removed).
    fn module_matches_shape(
        &self,
        id: &str,
        mf: &ModuleFile,
        macro_file: Option<&MacroInstanceFile>,
    ) -> bool {
        if let Some(mi) = self.macro_instances().get(id) {
            let Some(file) = macro_file else {
                return false;
            };
            return mi.macro_id == mf.ext
                && file.def == mi.def
                && *file.effective() == self.instance_state(id, mi);
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
        // Display name (covers undo/redo of renames; ids that changed
        // recreate the module upstream, keys being the ids).
        self.set_display_name(instance_id, mf.name.clone())?;

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

            // Choreography timeline: replace wholesale when it differs
            // (cheap — compile is linear in beats x tracks).
            if let Some(c) = &mf.choreo {
                let node = self.node_idx(instance_id)?;
                if self.nodes[node].choreo.as_ref() != Some(c) {
                    self.choreo_set_state(instance_id, c.clone())?;
                }
            }

            // Track (replace only; unload forces recreate upstream).
            let node = self.node_idx(instance_id)?;
            if let Some(track) = &mf.track {
                if self.nodes[node].track_path.as_deref() != Some(track.as_str()) {
                    let kind = self.nodes[node].builtin_kind();
                    self.load_module_track(instance_id, kind, track)?;
                }
            }

            // Decks bank (slots, mix, grid). Replaced wholesale when it
            // differs; the clips' audio is the app layer's to re-assemble,
            // and `decks_pending` reports what it owes.
            if let Some(d) = &mf.decks {
                if self.decks_state(instance_id).ok().as_ref() != Some(d) {
                    self.decks_set_state(instance_id, d.clone())?;
                }
            }

            // Beat Clip binding (the audio behind it is the app layer's
            // to re-assemble — `beat_clip_pending` reports it afterwards).
            if self.nodes[node].builtin_kind() == Some(crate::builtin::BuiltinKind::BeatClip)
                && self.nodes[node].clip != mf.clip
            {
                self.beat_clip_bind(instance_id, mf.clip.clone())?;
            }

            // Bypass (undo/redo of the title-bar toggle). Guarded like the
            // load path: a manifest that dropped its routes leaves the
            // module live rather than failing the whole apply.
            if self.nodes[node].bypassed != mf.bypassed && self.nodes[node].is_bypassable() {
                self.set_bypass(instance_id, mf.bypassed)?;
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

    /// Load a patch directory into a fresh engine. Patches are
    /// self-contained — each macro instance expands from its own copy — so
    /// no macro store is needed; [`Engine::from_doc_with_macros`] seeds the
    /// bases too, for the picker and *pull latest*.
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
                    let instance_id = path.file_stem().unwrap().to_string_lossy().to_string();
                    let file: MacroInstanceFile =
                        serde_json::from_str(&std::fs::read_to_string(&path)?)
                            .with_context(|| format!("reading {}", path.display()))?;
                    macros.insert(instance_id, file);
                }
            }
        }

        let layout_path = dir.join("layout.json");
        let layout = if layout_path.is_file() {
            serde_json::from_str(&std::fs::read_to_string(&layout_path)?)
                .context("reading layout.json")?
        } else {
            BTreeMap::new()
        };

        Ok(PatchDoc {
            header,
            modules,
            wires,
            macros,
            layout,
        })
    }
}
