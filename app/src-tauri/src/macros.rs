//! Macro IPC and the global macro store (PRD §6): groupings for the
//! rack's bounding-box overlay, collapse/break, per-instance definition
//! pull/save/reset, publishing, and the one-shot startup migration.

use dj_engine::{
    Engine, MacroDef, MacroInterface, MacroJack, MacroLibrary, MacroStore, MACROS_DIR_NAME,
};
use dj_library::Library;
use serde::Serialize;
use std::collections::BTreeMap;
use tauri::State;

use crate::{
    engine_lock, err, patch_edit, patches_dir, record_edit, with_stopped, AppState, CmdError,
    CmdResult, EditKey,
};

#[derive(Serialize)]
pub(crate) struct MacroGroup {
    /// Top-level macro instance id (the UI's bounding-box label anchor).
    instance: String,
    macro_id: String,
    name: String,
    /// Concrete engine nodes expanded under this instance (nested macros
    /// flattened) — the members of the bounding box.
    members: Vec<String>,
}

/// Macro instance groupings for the rack's bounding-box overlay. Only
/// top-level instances are reported; nested macros are part of their
/// owner's box.
#[tauri::command]
pub(crate) fn macro_groups(state: State<AppState>) -> CmdResult<Vec<MacroGroup>> {
    let engine = engine_lock(&state)?;
    Ok(engine
        .macro_instances()
        .iter()
        .filter(|(iid, _)| !iid.contains('/'))
        .map(|(iid, mi)| {
            let prefix = format!("{iid}/");
            MacroGroup {
                instance: iid.clone(),
                macro_id: mi.macro_id.clone(),
                name: engine
                    .macros
                    .get(&mi.macro_id)
                    .map(|d| d.name.clone())
                    .unwrap_or_else(|| mi.macro_id.clone()),
                members: engine
                    .nodes
                    .iter()
                    .filter(|n| n.instance_id.starts_with(&prefix))
                    .map(|n| n.instance_id.clone())
                    .collect(),
            }
        })
        .collect())
}

/// Right-click "Break Macro": the instance's expanded internal modules
/// become ordinary top-level modules in place (wires, DSP state and
/// positions survive); the macro definition stays in the library. Returns
/// old id -> new id so the frontend can remap positions.
#[tauri::command]
pub(crate) fn break_macro(state: State<AppState>, instance: String) -> CmdResult<BTreeMap<String, String>> {
    let mut engine = patch_edit(&state, EditKey::BreakMacro(&instance))?;
    engine.break_macro(&instance).map_err(err)
}

/// Saved definition layout for a macro: relative rack positions for the
/// concrete nodes a fresh instance expands to (empty for macros saved
/// before positions were recorded).
#[tauri::command]
pub(crate) fn macro_layout(
    state: State<AppState>,
    macro_id: String,
) -> CmdResult<BTreeMap<String, (f32, f32)>> {
    let engine = engine_lock(&state)?;
    engine.macro_layout(&macro_id).map_err(err)
}

/// What a fresh instance of a macro expands to, for the module picker's
/// composite thumbnail: concrete internal nodes with their manifests,
/// definition-saved knobs and relative positions.
#[tauri::command]
pub(crate) fn macro_preview(
    state: State<AppState>,
    macro_id: String,
) -> CmdResult<Vec<dj_engine::MacroPreviewNode>> {
    let engine = engine_lock(&state)?;
    engine.macro_preview(&macro_id).map_err(err)
}

/// The global macro store: `<data_dir>/macros/`, a sibling of `patches/`.
pub(crate) fn macro_store() -> MacroStore {
    MacroStore::new(dj_library::default_data_dir().join(MACROS_DIR_NAME))
}

/// Every published macro, as an engine-side `MacroLibrary`. A store that
/// cannot be read is logged and treated as empty — a broken definition
/// file must not stop the app from opening a patch.
pub(crate) fn store_macro_library() -> MacroLibrary {
    match macro_store().load() {
        Ok(lib) => lib,
        Err(e) => {
            eprintln!("[dj-macros] loading the macro store failed: {e:#}");
            MacroLibrary::default()
        }
    }
}

pub(crate) fn persist_macro(def: &MacroDef) -> CmdResult<()> {
    macro_store().save(def).map_err(err)
}

/// One-shot migration to the global macro store, run at startup: patches
/// that embedded one shared definition per macro id get per-instance
/// copies, and macros left in the retired `macros` DB table move into the
/// store. Idempotent, and never fatal — a failure just leaves the old
/// state in place.
pub(crate) fn migrate_macros_to_store(library: &Library) {
    let store = macro_store();
    match library.legacy_macros() {
        Ok(rows) => {
            let mut moved = 0;
            for row in &rows {
                match serde_json::from_str::<MacroDef>(&row.definition) {
                    Ok(def) => match store.save(&def) {
                        Ok(()) => moved += 1,
                        Err(e) => eprintln!("[dj-macros] storing {}: {e:#}", row.id),
                    },
                    Err(e) => eprintln!("[dj-macros] bad stored definition for {}: {e}", row.id),
                }
            }
            if moved == rows.len() && !rows.is_empty() {
                if let Err(e) = library.drop_legacy_macros() {
                    eprintln!("[dj-macros] dropping the legacy macros table: {e:#}");
                } else {
                    println!("[dj-macros] moved {moved} macro(s) out of the library DB");
                }
            }
        }
        Err(e) => eprintln!("[dj-macros] reading the legacy macros table: {e:#}"),
    }
    match store.import_patch_macros(&patches_dir()) {
        Ok(report) if report.is_empty() => {}
        Ok(report) => println!(
            "[dj-macros] migrated {} patch instance(s) to per-instance copies; \
             published {} macro(s) ({} duplicate definition(s) collapsed)",
            report.instances.len(),
            report.bases.len(),
            report.deduped
        ),
        Err(e) => eprintln!("[dj-macros] migrating patch macros: {e:#}"),
    }
}

#[derive(Serialize)]
pub(crate) struct MacroInfo {
    id: String,
    name: String,
}

/// Macros available for instantiation (the global store, PRD §6).
#[tauri::command]
pub(crate) fn list_macros(state: State<AppState>) -> CmdResult<Vec<MacroInfo>> {
    let engine = engine_lock(&state)?;
    Ok(engine
        .macros
        .list()
        .into_iter()
        .map(|d| MacroInfo {
            id: d.id.clone(),
            name: d.name.clone(),
        })
        .collect())
}

/// Auto-derived macro interface for a rack selection: boundary wires are
/// promoted (required for a valid collapse); every other input jack of a
/// selected module that isn't wired inside the selection is promoted too,
/// so instances keep their knobs. External ids prefer the bare jack id and
/// fall back to `<node>_<jack>` on collision.
pub(crate) fn auto_interface(engine: &Engine, selection: &[String]) -> MacroInterface {
    let sel: std::collections::BTreeSet<&str> = selection.iter().map(|s| s.as_str()).collect();
    let doc = engine.snapshot("collapse");
    let mut interface = MacroInterface::default();
    let mut in_ids = std::collections::BTreeSet::new();
    let mut out_ids = std::collections::BTreeSet::new();
    let mut internally_wired = std::collections::BTreeSet::new();

    let promote_in = |interface: &mut MacroInterface,
                      ids: &mut std::collections::BTreeSet<String>,
                      node: &str,
                      jack: &str| {
        if interface
            .inputs
            .iter()
            .any(|j| j.node == node && j.jack == jack)
        {
            return;
        }
        let id = if ids.insert(jack.to_string()) {
            jack.to_string()
        } else {
            let id = format!("{node}_{jack}");
            ids.insert(id.clone());
            id
        };
        interface.inputs.push(MacroJack {
            id,
            node: node.to_string(),
            jack: jack.to_string(),
        });
    };
    let promote_out = |interface: &mut MacroInterface,
                       ids: &mut std::collections::BTreeSet<String>,
                       node: &str,
                       jack: &str| {
        if interface
            .outputs
            .iter()
            .any(|j| j.node == node && j.jack == jack)
        {
            return;
        }
        let id = if ids.insert(jack.to_string()) {
            jack.to_string()
        } else {
            let id = format!("{node}_{jack}");
            ids.insert(id.clone());
            id
        };
        interface.outputs.push(MacroJack {
            id,
            node: node.to_string(),
            jack: jack.to_string(),
        });
    };

    // Boundary wires first — these promotions are mandatory.
    for (src, wf) in &doc.wires {
        for w in &wf.wires {
            let src_in = sel.contains(src.as_str());
            let dst_in = sel.contains(w.to.as_str());
            if src_in && dst_in {
                internally_wired.insert((w.to.clone(), w.to_jack.clone()));
            } else if dst_in {
                promote_in(&mut interface, &mut in_ids, &w.to, &w.to_jack);
            } else if src_in {
                promote_out(&mut interface, &mut out_ids, src, &w.from_jack);
            }
        }
    }
    // Remaining jacks of the selected modules (macro instances included —
    // macros nest, so a selected macro's external jacks promote the same
    // way as a plain module's).
    for id in selection {
        let (inputs, outputs): (Vec<String>, Vec<String>) =
            if let Some(n) = engine.nodes.iter().find(|n| &n.instance_id == id) {
                (
                    n.manifest.inputs.iter().map(|j| j.id.clone()).collect(),
                    n.manifest.outputs.iter().map(|o| o.id.clone()).collect(),
                )
            } else if let Some(m) = engine
                .macro_instances()
                .get(id)
                .and_then(|mi| engine.macro_manifest(&mi.macro_id))
            {
                (
                    m.inputs.iter().map(|j| j.id.clone()).collect(),
                    m.outputs.iter().map(|o| o.id.clone()).collect(),
                )
            } else {
                continue;
            };
        for jack in inputs {
            if !internally_wired.contains(&(id.clone(), jack.clone())) {
                promote_in(&mut interface, &mut in_ids, id, &jack);
            }
        }
        for jack in outputs {
            promote_out(&mut interface, &mut out_ids, id, &jack);
        }
    }
    interface
}

/// Collapse the selected rack modules into a new macro (PRD §6). Returns
/// the new instance's id; the definition lands in the user library DB.
/// `positions` carries each selected module's rack position so the
/// definition remembers the arrangement (stored relative to the group's
/// top-left corner).
///
/// The outcome is either the new instance id, or — when a macro with the
/// same name already exists and `overwrite` wasn't set — the existing
/// definition's info so the UI can ask before clobbering it.
#[derive(Serialize)]
pub(crate) struct CollapseOutcome {
    instance: Option<String>,
    conflict: Option<MacroInfo>,
}

#[tauri::command]
pub(crate) fn collapse_macro(
    state: State<AppState>,
    selection: Vec<String>,
    name: String,
    positions: Option<BTreeMap<String, (f32, f32)>>,
    overwrite: Option<bool>,
) -> CmdResult<CollapseOutcome> {
    if selection.is_empty() {
        return Err(CmdError::invalid("empty selection"));
    }
    let mut engine = engine_lock(&state)?;
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    // Same name ⇒ same id (the id IS the name's slug): saving under an
    // existing name means overwriting that macro, which needs the caller's
    // explicit consent. Checked before record_edit so a declined overwrite
    // leaves no phantom undo entry.
    let macro_id = format!("macro.{slug}");
    let existing = engine.macros.get(&macro_id).cloned();
    if let Some(old) = &existing {
        if overwrite != Some(true) {
            return Ok(CollapseOutcome {
                instance: None,
                conflict: Some(MacroInfo {
                    id: old.id.clone(),
                    name: old.name.clone(),
                }),
            });
        }
    }
    record_edit(&state, &engine, &EditKey::CollapseMacro);
    let taken: std::collections::BTreeSet<String> = engine
        .nodes
        .iter()
        .map(|nd| nd.instance_id.clone())
        .collect();
    let mut instance = slug.clone();
    let mut k = 2;
    while taken.contains(&instance) {
        instance = format!("{slug}-{k}");
        k += 1;
    }
    let interface = auto_interface(&engine, &selection);
    let sel_refs: Vec<&str> = selection.iter().map(|s| s.as_str()).collect();
    let mut def = with_stopped(&mut engine, |e| {
        if existing.is_some() {
            e.recollapse_macro(&sel_refs, &instance, &macro_id, &name, interface)
                .map_err(err)
        } else {
            e.collapse_to_macro(&sel_refs, &instance, &macro_id, &name, interface)
                .map_err(err)
        }
    })?;
    // Remember the arrangement: positions normalized to the group's
    // top-left corner so a fresh instance lays out the same shape anywhere.
    if let Some(positions) = positions {
        let x0 = positions
            .values()
            .map(|p| p.0)
            .fold(f32::INFINITY, f32::min);
        let y0 = positions
            .values()
            .map(|p| p.1)
            .fold(f32::INFINITY, f32::min);
        let rel: BTreeMap<String, (f32, f32)> = positions
            .into_iter()
            .filter(|(id, _)| def.modules.contains_key(id))
            .map(|(id, (x, y))| (id, (x - x0, y - y0)))
            .collect();
        if !rel.is_empty() {
            def = engine.set_macro_positions(&macro_id, rel).map_err(err)?;
        }
    }
    persist_macro(&def)?;
    Ok(CollapseOutcome {
        instance: Some(instance),
        conflict: None,
    })
}

/// *Pull latest* on one macro instance: replace its private copy of the
/// definition with the current published one and re-expand it. DESTRUCTIVE
/// — every edit made inside this instance is discarded — so the UI warns
/// first. Returns the wires the new interface could not keep (empty when
/// the instance already matched the base, which is a no-op).
#[tauri::command]
pub(crate) fn pull_macro_instance(state: State<AppState>, instance: String) -> CmdResult<Vec<String>> {
    let mut engine = patch_edit(&state, EditKey::PullMacro(&instance))?;
    let mut warnings = Vec::new();
    with_stopped(&mut engine, |e| {
        warnings = e.pull_macro_instance(&instance).map_err(err)?;
        Ok(())
    })?;
    for w in &warnings {
        eprintln!("[dj-macros] pull {instance}: {w}");
    }
    Ok(warnings)
}

/// *Save macro*: publish this instance's current state as the macro's new
/// definition. Other instances keep what they have until they pull.
/// Returns false when nothing had changed.
#[tauri::command]
pub(crate) fn save_macro_instance(state: State<AppState>, instance: String) -> CmdResult<bool> {
    let mut engine = engine_lock(&state)?;
    let Some(def) = engine.save_macro_instance(&instance).map_err(err)? else {
        return Ok(false);
    };
    persist_macro(&def)?;
    Ok(true)
}

/// *Reset to defaults*: discard local edits inside one instance, back to
/// the copy of the definition it was adopted with. Undoable.
#[tauri::command]
pub(crate) fn reset_macro_instance(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ResetMacro(&instance))?;
    with_stopped(&mut engine, |e| {
        e.reset_macro_instance(&instance).map_err(err)
    })
}

/// Rename a published macro (stable id, display name only). Library
/// state, not patch state (so not undoable, like [`delete_macro`]):
/// instances keep their own copies, so this only retitles the base.
#[tauri::command]
pub(crate) fn rename_macro(state: State<AppState>, macro_id: String, name: String) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    let def = engine.rename_macro(&macro_id, &name).map_err(err)?;
    persist_macro(&def)
}

/// Delete a macro from the global store. Refused while any rack instance
/// still uses it (break or delete the instances first) — a live instance
/// with no base couldn't re-publish or be pulled again. Not undoable: the
/// definition is library state, not patch state (like DJ metadata).
#[tauri::command]
pub(crate) fn delete_macro(state: State<AppState>, macro_id: String) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    if let Some(mi) = engine
        .macro_instances()
        .iter()
        .find(|(_, mi)| mi.macro_id == macro_id)
    {
        return Err(CmdError::invalid(format!(
            "macro is in use by instance {:?} — break or delete it first",
            mi.0
        )));
    }
    engine
        .unregister_macro(&macro_id)
        .ok_or_else(|| CmdError::invalid(format!("unknown macro {macro_id:?}")))?;
    macro_store().remove(&macro_id).map_err(err)?;
    Ok(())
}
