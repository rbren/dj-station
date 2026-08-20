//! Macro modules (PRD §6): collapse a selection of nodes+wires into a
//! reusable module. A macro is **pure data** — a saved subgraph plus an
//! interface mapping (which internal jacks/params are promoted) — stored in
//! the user library with a stable ID and a version.
//!
//! - Instantiating a macro by ID *expands* its subgraph into the engine
//!   graph; internal nodes are named `<instance>/<internal>` (the `/`
//!   separator is reserved — top-level instance ids may not contain it).
//! - Instances reference the macro by ID. Editing a macro's internals
//!   (`Engine::update_macro`) re-expands every instance in memory; patches
//!   record the version they were saved with plus an embedded copy of the
//!   definition, so a version mismatch at load can be resolved as *update*
//!   (use the library version) or *fork* (keep the patch's copy under a new
//!   ID) — see [`crate::patch::PatchDoc::macro_conflicts`].
//! - Macros nest arbitrarily: an internal module's `ext` may itself be a
//!   macro ID.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::patch::{ModuleFile, WireFile};

/// A promoted jack: `id` is the macro's external jack name; `node`/`jack`
/// identify the internal jack (if `node` is a nested macro instance, `jack`
/// is one of *its* external jack names).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MacroJack {
    pub id: String,
    pub node: String,
    pub jack: String,
}

/// A promoted param, same shape as [`MacroJack`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MacroParam {
    pub id: String,
    pub node: String,
    pub param: String,
}

/// Which internal jacks/params are promoted to the macro's interface.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct MacroInterface {
    #[serde(default)]
    pub inputs: Vec<MacroJack>,
    #[serde(default)]
    pub outputs: Vec<MacroJack>,
    #[serde(default)]
    pub params: Vec<MacroParam>,
}

/// A macro module definition: saved subgraph + interface mapping.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MacroDef {
    /// Stable ID (e.g. `"macro.my-rig"`). Also what instances reference.
    pub id: String,
    pub name: String,
    /// Bumped on every edit; patches record the version they saved with.
    pub version: u32,
    /// Internal subgraph, keyed by internal instance id.
    pub modules: BTreeMap<String, ModuleFile>,
    /// Internal wires, one bundle per internal source instance.
    #[serde(default)]
    pub wires: BTreeMap<String, WireFile>,
    pub interface: MacroInterface,
    /// Saved rack positions of the internal modules, keyed by internal
    /// instance id, relative to the group's top-left corner. Pure UI
    /// passthrough (the engine never computes on it); empty for macros
    /// saved before positions were recorded.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub positions: BTreeMap<String, (f32, f32)>,
}

/// An in-memory collection of macro definitions (the engine-side view of
/// the user library's macro store; the app persists defs to SQLite).
#[derive(Debug, Clone, Default)]
pub struct MacroLibrary {
    pub defs: BTreeMap<String, MacroDef>,
}

impl MacroLibrary {
    pub fn register(&mut self, def: MacroDef) {
        self.defs.insert(def.id.clone(), def);
    }

    pub fn get(&self, id: &str) -> Option<&MacroDef> {
        self.defs.get(id)
    }

    pub fn list(&self) -> Vec<&MacroDef> {
        self.defs.values().collect()
    }
}

/// Control-side state of one expanded macro instance. External jacks are
/// stored fully resolved to concrete engine nodes (nesting flattened at
/// expansion time), so wiring/knob/param access is a plain lookup.
#[derive(Debug, Clone)]
pub struct MacroInstance {
    pub macro_id: String,
    pub version: u32,
    /// User-facing name as typed; same invariant as
    /// [`crate::engine::NodeInfo::display_name`].
    pub display_name: Option<String>,
    /// (external jack id, concrete node instance id, concrete jack id)
    pub inputs: Vec<(String, String, String)>,
    pub outputs: Vec<(String, String, String)>,
    /// (external param id, concrete node instance id, concrete param id)
    pub params: Vec<(String, String, String)>,
}

/// A macro version mismatch found when loading a patch against a library.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacroConflict {
    pub macro_id: String,
    /// Version embedded in the patch.
    pub patch_version: u32,
    /// Version currently in the library.
    pub library_version: u32,
}

/// How to resolve a [`MacroConflict`] (the "prompt" of PRD §6 — the UI
/// surfaces a dialog; this is the logic behind its two buttons).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MacroResolution {
    /// Use the library's (newer) definition; instances adopt it.
    UpdateToLibrary,
    /// Keep the patch's saved definition, registered under a new ID.
    Fork { new_id: String },
}
