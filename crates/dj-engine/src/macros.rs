//! Macro modules (PRD §6): collapse a selection of nodes+wires into a
//! reusable module. A macro is **pure data** — a saved subgraph plus an
//! interface mapping (which internal jacks/params are promoted).
//!
//! Definitions live in two places, and the split is the whole design:
//!
//! - The **base** is the global object in the macro store
//!   (`<data_dir>/macros/<id>.json`, a sibling of `patches/` — see
//!   [`crate::macro_store`]). There is exactly one current base per id; it
//!   has no version history, it just gets updated.
//! - Every **instance** owns a private **copy** of the definition it was
//!   adopted with ([`MacroInstance::def`]), persisted inside the patch. A
//!   patch therefore never changes because someone edited the base, and one
//!   patch can hold several instances of the same id adopted at different
//!   times.
//!
//! Three explicit verbs move definitions between the two (`Engine::`
//! `pull_macro_instance` / `save_macro_instance` / `reset_macro_instance`):
//! *pull latest* replaces the instance's copy with the base (destructive —
//! the UI warns), *save macro* publishes the instance's current state as
//! the new base, and *reset to defaults* discards live edits back to the
//! adopted copy. Each is a no-op when the two sides already agree.
//!
//! Instantiating a macro *expands* its subgraph into the engine graph;
//! internal nodes are named `<instance>/<internal>` (the `/` separator is
//! reserved — top-level instance ids may not contain it). Macros do NOT
//! nest: a definition whose internal module is itself a macro is rejected.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::knob::KnobState;
use crate::manifest::Manifest;
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
///
/// Definitions carry no version counter: the base is simply the current
/// one, and instances hold their own copy (see the module docs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MacroDef {
    /// Stable ID (e.g. `"macro.my-rig"`). Also what instances reference.
    pub id: String,
    pub name: String,
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

/// One internal node of a macro definition, as a UI thumbnail sees it
/// (see `Engine::macro_preview`): id relative to a would-be instance,
/// position relative to the group's top-left corner (`None` when the
/// definition saved none).
#[derive(Debug, Clone, Serialize)]
pub struct MacroPreviewNode {
    pub id: String,
    pub ext: String,
    pub manifest: Manifest,
    pub knobs: BTreeMap<String, KnobState>,
    pub position: Option<(f32, f32)>,
}

/// The base definitions: the engine-side view of the global macro store
/// (`<data_dir>/macros/`), one current definition per id. This is what the
/// module picker offers and what *pull latest* / *save macro* read and
/// write; it is NOT what live instances run (they own their copies).
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

    pub fn unregister(&mut self, id: &str) -> Option<MacroDef> {
        self.defs.remove(id)
    }

    pub fn list(&self) -> Vec<&MacroDef> {
        self.defs.values().collect()
    }
}

/// Control-side state of one expanded macro instance. External jacks are
/// stored fully resolved to concrete engine nodes, so wiring/knob/param
/// access is a plain lookup.
#[derive(Debug, Clone)]
pub struct MacroInstance {
    /// Base id this instance was adopted from (`def.id`). The base may have
    /// moved on, or be gone entirely — the instance runs `def` regardless.
    pub macro_id: String,
    /// The instance's own copy of the definition: what it was adopted with,
    /// what *reset to defaults* restores, and what patches persist.
    pub def: MacroDef,
    /// User-facing name as typed; same invariant as
    /// [`crate::engine::NodeInfo::display_name`].
    pub display_name: Option<String>,
    /// (external jack id, concrete node instance id, concrete jack id)
    pub inputs: Vec<(String, String, String)>,
    pub outputs: Vec<(String, String, String)>,
    /// (external param id, concrete node instance id, concrete param id)
    pub params: Vec<(String, String, String)>,
}
