//! Macro modules (PRD §6) — split out of the old monolithic engine.rs; methods on [`Engine`] only.

use super::*;

impl Engine {
    // ------------------------------------------------------------------
    // Macro modules (PRD §6)
    // ------------------------------------------------------------------

    /// Register (or replace) a macro definition in the engine's library
    /// view. Does not touch existing instances — see [`Self::update_macro`].
    pub fn register_macro(&mut self, def: MacroDef) {
        self.macros.register(def);
    }

    /// Expanded macro instances (nested ones use `/`-prefixed ids).
    pub fn macro_instances(&self) -> &BTreeMap<String, MacroInstance> {
        &self.macro_instances
    }

    /// A synthesized manifest for a macro (external interface as jacks) —
    /// lets UIs render macro instances like any other module panel.
    pub fn macro_manifest(&self, macro_id: &str) -> Option<Manifest> {
        let def = self.macros.get(macro_id)?;
        Some(Manifest {
            id: def.id.clone(),
            name: def.name.clone(),
            version: def.version.to_string(),
            abi: "macro-1".into(),
            category: crate::manifest::categories::MACROS.into(),
            inputs: def
                .interface
                .inputs
                .iter()
                .map(|j| crate::manifest::JackDecl {
                    id: j.id.clone(),
                    name: j.id.clone(),
                    default: 0.0,
                    knob: None,
                })
                .collect(),
            outputs: def
                .interface
                .outputs
                .iter()
                .map(|j| crate::manifest::OutputDecl {
                    id: j.id.clone(),
                    name: j.id.clone(),
                })
                .collect(),
            params: def
                .interface
                .params
                .iter()
                .map(|p| crate::manifest::ParamDecl {
                    id: p.id.clone(),
                    name: p.id.clone(),
                    param_type: "float".into(),
                    default: serde_json::Value::Null,
                    min: None,
                    max: None,
                })
                .collect(),
            ui: None,
            latency_samples: 0,
        })
    }

    pub(super) fn resolve_param(&self, id: &str, param: &str) -> Result<(String, String)> {
        if let Some(mi) = self.macro_instances.get(id) {
            let (_, node, p) = mi
                .params
                .iter()
                .find(|(e, _, _)| e == param)
                .ok_or_else(|| anyhow!("no param {param:?} on macro instance {id:?}"))?;
            return Ok((node.clone(), p.clone()));
        }
        Ok((id.to_string(), param.to_string()))
    }

    /// Expand a macro definition as instance `instance_id`. Only valid
    /// while stopped (structural edit, like `add_module`).
    pub(super) fn instantiate_macro(&mut self, instance_id: &str, macro_id: &str) -> Result<()> {
        anyhow::ensure!(
            !self.node_by_id.contains_key(instance_id)
                && !self.macro_instances.contains_key(instance_id),
            "duplicate instance id {instance_id:?}"
        );
        let def = self
            .macros
            .get(macro_id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown macro {macro_id:?}"))?;
        self.expand_macro_def(instance_id, &def)
    }

    fn expand_macro_def(&mut self, prefix: &str, def: &MacroDef) -> Result<()> {
        // 1. Internal modules (nested macros recurse; their instances are
        //    registered before any state referencing them is applied).
        let mut deferred_syncs: Vec<(String, String)> = Vec::new();
        for (inner, mf) in &def.modules {
            let full = format!("{prefix}/{inner}");
            if self.macros.get(&mf.ext).is_some() {
                self.instantiate_macro(&full, &mf.ext)?;
            } else {
                self.add_plain_module(&full, &mf.ext)?;
            }
            for m in &mf.midi_mappings {
                self.add_midi_mapping(&full, m.kind, m.num, &m.name)?;
            }
            for m in &mf.midi_led_mappings {
                self.add_midi_led_mapping(&full, m.kind, m.num, &m.name)?;
            }
            if let Some(g) = &mf.gesture {
                self.gesture_set_mode(&full, &g.mode)?;
                self.gesture_set_wheels(&full, g.wheels)?;
                for m in &g.mappings {
                    self.restore_gesture_mapping(&full, m)?;
                }
            }
            if let Some(track) = &mf.track {
                if BuiltinKind::from_ext_id(&mf.ext) == Some(BuiltinKind::Deck) {
                    self.deck_load(&full, std::path::Path::new(track))?;
                } else {
                    self.playback_load(&full, std::path::Path::new(track))?;
                }
            }
            if let Some(sync_to) = &mf.sync_to {
                deferred_syncs.push((full.clone(), format!("{prefix}/{sync_to}")));
            }
            for (param, value) in &mf.params {
                self.set_param(&full, param, *value)?;
            }
            for (jack, state) in &mf.knobs {
                self.restore_knob(&full, jack, state.clone())?;
            }
        }
        for (inst, master) in &deferred_syncs {
            self.deck_sync(inst, Some(master))?;
        }

        // 2. Internal wires.
        for (src, wf) in &def.wires {
            for w in &wf.wires {
                self.connect(
                    &format!("{prefix}/{src}"),
                    &w.from_jack,
                    &format!("{prefix}/{}", w.to),
                    &w.to_jack,
                )?;
            }
        }

        // 3. Resolve the external interface to concrete nodes (through
        //    nested macro instances, which are registered by now).
        let mut inputs = Vec::new();
        for j in &def.interface.inputs {
            let (n, jj) = self.resolve_in_jack(&format!("{prefix}/{}", j.node), &j.jack)?;
            let node = self.node_idx(&n)?;
            self.jack_index(node, &jj)?;
            inputs.push((j.id.clone(), n, jj));
        }
        let mut outputs = Vec::new();
        for j in &def.interface.outputs {
            let (n, jj) = self.resolve_out_jack(&format!("{prefix}/{}", j.node), &j.jack)?;
            let node = self.node_idx(&n)?;
            self.out_jack_index(node, &jj)?;
            outputs.push((j.id.clone(), n, jj));
        }
        let mut params = Vec::new();
        for p in &def.interface.params {
            let (n, pp) = self.resolve_param(&format!("{prefix}/{}", p.node), &p.param)?;
            let node = self.node_idx(&n)?;
            anyhow::ensure!(
                self.nodes[node].manifest.params.iter().any(|d| d.id == pp),
                "no param {pp:?} on {n:?}"
            );
            params.push((p.id.clone(), n, pp));
        }
        self.macro_instances.insert(
            prefix.to_string(),
            MacroInstance {
                macro_id: def.id.clone(),
                version: def.version,
                inputs,
                outputs,
                params,
            },
        );
        Ok(())
    }

    /// Collapse a selection of top-level instances into a new macro
    /// (PRD §6 `graph.collapse`). The selection is replaced by one instance
    /// (`new_instance_id`) of the freshly registered macro; boundary wires
    /// must pass through promoted interface jacks. Returns the definition
    /// (version 1) so callers can persist it to the library store.
    pub fn collapse_to_macro(
        &mut self,
        selection: &[&str],
        new_instance_id: &str,
        macro_id: &str,
        name: &str,
        interface: MacroInterface,
    ) -> Result<MacroDef> {
        self.core_mut()?; // structural edit: engine must be stopped
        anyhow::ensure!(!selection.is_empty(), "empty selection");
        anyhow::ensure!(
            !new_instance_id.contains('/'),
            "instance ids may not contain '/'"
        );
        anyhow::ensure!(
            self.macros.get(macro_id).is_none(),
            "macro id {macro_id:?} already exists"
        );
        let sel: std::collections::BTreeSet<String> =
            selection.iter().map(|s| s.to_string()).collect();
        for id in &sel {
            anyhow::ensure!(!id.contains('/'), "cannot collapse internal node {id:?}");
            anyhow::ensure!(
                self.node_by_id.contains_key(id) || self.macro_instances.contains_key(id),
                "no instance {id:?}"
            );
        }
        for j in &interface.inputs {
            anyhow::ensure!(
                sel.contains(&j.node),
                "promoted input {}: node not in selection",
                j.id
            );
            self.resolve_in_jack(&j.node, &j.jack)
                .and_then(|(n, jj)| self.in_jack_indices(&n, &jj))?;
        }
        for j in &interface.outputs {
            anyhow::ensure!(
                sel.contains(&j.node),
                "promoted output {}: node not in selection",
                j.id
            );
            let (n, jj) = self.resolve_out_jack(&j.node, &j.jack)?;
            let node = self.node_idx(&n)?;
            self.out_jack_index(node, &jj)?;
        }
        for p in &interface.params {
            anyhow::ensure!(
                sel.contains(&p.node),
                "promoted param {}: node not in selection",
                p.id
            );
        }

        let doc = self.snapshot("collapse");

        // Definition: selected modules + wires fully inside the selection.
        let mut def_modules = BTreeMap::new();
        for id in &sel {
            let mut mf = doc
                .modules
                .get(id)
                .cloned()
                .ok_or_else(|| anyhow!("no module entry for {id:?}"))?;
            // Track paths inside macros stay; deck sync partners must be
            // inside the selection to survive.
            if let Some(s) = &mf.sync_to {
                if !sel.contains(s) {
                    mf.sync_to = None;
                }
            }
            def_modules.insert(id.clone(), mf);
        }
        let mut def_wires: BTreeMap<String, crate::patch::WireFile> = BTreeMap::new();
        let mut new_wires: BTreeMap<String, crate::patch::WireFile> = BTreeMap::new();
        for (src, wf) in &doc.wires {
            for w in &wf.wires {
                let src_in = sel.contains(src);
                let dst_in = sel.contains(&w.to);
                match (src_in, dst_in) {
                    (true, true) => def_wires
                        .entry(src.clone())
                        .or_insert_with(|| crate::patch::WireFile { wires: Vec::new() })
                        .wires
                        .push(w.clone()),
                    (false, false) => new_wires
                        .entry(src.clone())
                        .or_insert_with(|| crate::patch::WireFile { wires: Vec::new() })
                        .wires
                        .push(w.clone()),
                    (false, true) => {
                        let ext = interface
                            .inputs
                            .iter()
                            .find(|j| j.node == w.to && j.jack == w.to_jack)
                            .ok_or_else(|| {
                                anyhow!(
                                    "boundary wire into {}.{} does not use a promoted input jack",
                                    w.to,
                                    w.to_jack
                                )
                            })?;
                        new_wires
                            .entry(src.clone())
                            .or_insert_with(|| crate::patch::WireFile { wires: Vec::new() })
                            .wires
                            .push(crate::patch::WireEntry {
                                from_jack: w.from_jack.clone(),
                                to: new_instance_id.to_string(),
                                to_jack: ext.id.clone(),
                            });
                    }
                    (true, false) => {
                        let ext = interface
                            .outputs
                            .iter()
                            .find(|j| j.node == *src && j.jack == w.from_jack)
                            .ok_or_else(|| {
                                anyhow!(
                                    "boundary wire out of {}.{} does not use a promoted output jack",
                                    src,
                                    w.from_jack
                                )
                            })?;
                        new_wires
                            .entry(new_instance_id.to_string())
                            .or_insert_with(|| crate::patch::WireFile { wires: Vec::new() })
                            .wires
                            .push(crate::patch::WireEntry {
                                from_jack: ext.id.clone(),
                                to: w.to.clone(),
                                to_jack: w.to_jack.clone(),
                            });
                    }
                }
            }
        }

        let def = MacroDef {
            id: macro_id.to_string(),
            name: name.to_string(),
            version: 1,
            modules: def_modules,
            wires: def_wires,
            interface,
        };
        self.macros.register(def.clone());

        // Instance-level state: promoted knobs/params carry their current
        // values (identical to the def right now; per-instance from here).
        let mut knobs = BTreeMap::new();
        for j in &def.interface.inputs {
            let (n, jj) = self.resolve_in_jack(&j.node, &j.jack)?;
            knobs.insert(j.id.clone(), self.knob_state(&n, &jj)?);
        }
        let mut params = BTreeMap::new();
        for p in &def.interface.params {
            let (n, pp) = self.resolve_param(&p.node, &p.param)?;
            let node = self.node_idx(&n)?;
            if let Some(v) = self.nodes[node].params.get(&pp) {
                params.insert(p.id.clone(), *v);
            }
        }

        let mut new_modules = doc.modules.clone();
        for id in &sel {
            new_modules.remove(id);
        }
        new_modules.insert(
            new_instance_id.to_string(),
            crate::patch::ModuleFile {
                ext: macro_id.to_string(),
                knobs,
                params,
                midi_mappings: Vec::new(),
                midi_led_mappings: Vec::new(),
                gesture: None,
                track: None,
                sync_to: None,
                macro_version: Some(1),
            },
        );
        let new_doc = crate::patch::PatchDoc {
            header: doc.header.clone(),
            modules: new_modules,
            wires: new_wires,
            macros: BTreeMap::new(), // rebuild carries self.macros
        };
        self.rebuild(&new_doc)?;
        Ok(def)
    }

    /// Replace a macro's definition and re-expand every instance in memory
    /// (PRD §6: editing a macro's internals edits every instance). The
    /// engine must be stopped (structural edit).
    pub fn update_macro(&mut self, def: MacroDef) -> Result<()> {
        self.core_mut()?;
        anyhow::ensure!(
            self.macros.get(&def.id).is_some(),
            "unknown macro {:?}",
            def.id
        );
        self.macros.register(def);
        let doc = self.snapshot("update-macro");
        self.rebuild(&doc)
    }

    /// Rebuild this engine from a patch document, carrying over the full
    /// registered macro library. Used by structural macro edits.
    fn rebuild(&mut self, doc: &crate::patch::PatchDoc) -> Result<()> {
        let mut new =
            Engine::from_doc_with_macros(doc, self.registry.clone(), self.macros.clone())?;
        std::mem::swap(self, &mut new);
        // `new` (the old engine) is dropped here: watcher stopped, backends
        // already stopped (structural edits require a stopped engine).
        Ok(())
    }
}
