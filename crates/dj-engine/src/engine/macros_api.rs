//! Macro modules (PRD §6) — split out of the old monolithic engine.rs; methods on [`Engine`] only.

use super::*;

impl Engine {
    // ------------------------------------------------------------------
    // Macro modules (PRD §6)
    // ------------------------------------------------------------------

    /// Register (or replace) a base definition in the engine's view of the
    /// macro store. Never touches live instances: they run their own copies
    /// until someone pulls (see [`Self::pull_macro_instance`]).
    pub fn register_macro(&mut self, def: MacroDef) {
        self.macros.register(def);
    }

    /// Remove a base definition from the engine's view of the store. Live
    /// instances keep working — their copy is in the patch — they just have
    /// nothing left to pull from.
    pub fn unregister_macro(&mut self, macro_id: &str) -> Option<MacroDef> {
        self.macros.unregister(macro_id)
    }

    /// Rename a base definition (stable id, display name only). Existing
    /// instances keep the name they adopted. Returns the updated definition
    /// for persisting to the store.
    pub fn rename_macro(&mut self, macro_id: &str, new_name: &str) -> Result<MacroDef> {
        let new_name = new_name.trim();
        anyhow::ensure!(!new_name.is_empty(), "macro name must not be empty");
        let mut def = self
            .macros
            .get(macro_id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown macro {macro_id:?}"))?;
        def.name = new_name.to_string();
        self.macros.register(def.clone());
        Ok(def)
    }

    /// Expanded macro instances, keyed by instance id.
    pub fn macro_instances(&self) -> &BTreeMap<String, MacroInstance> {
        &self.macro_instances
    }

    /// A synthesized manifest for a base definition (external interface as
    /// jacks) — lets UIs render macros like any other module panel.
    pub fn macro_manifest(&self, macro_id: &str) -> Option<Manifest> {
        Some(Self::manifest_for_def(self.macros.get(macro_id)?))
    }

    /// The same, for one live instance: its own copy's interface, which may
    /// differ from the base's by now.
    pub fn macro_instance_manifest(&self, instance_id: &str) -> Option<Manifest> {
        Some(Self::manifest_for_def(
            &self.macro_instances.get(instance_id)?.def,
        ))
    }

    fn manifest_for_def(def: &MacroDef) -> Manifest {
        Manifest {
            id: def.id.clone(),
            name: def.name.clone(),
            version: String::new(),
            abi: "macro-1".into(),
            category: crate::manifest::categories::MACROS.into(),
            deprecated: false,
            inputs: def
                .interface
                .inputs
                .iter()
                .map(|j| crate::manifest::JackDecl {
                    id: j.id.clone(),
                    name: j.id.clone(),
                    default: 0.0,
                    audio: false,
                    capture: false,
                    knob: None,
                    display: None,
                })
                .collect(),
            outputs: def
                .interface
                .outputs
                .iter()
                .map(|j| crate::manifest::OutputDecl {
                    id: j.id.clone(),
                    name: j.id.clone(),
                    display: None,
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
            bypass: Default::default(),
            presets: Default::default(),
        }
    }

    /// Everything a UI needs to draw a thumbnail of what a fresh instance
    /// of `macro_id` expands to: each internal node's type, manifest,
    /// definition-saved knob states and saved relative position (`None`
    /// when the definition saved none). Purely a read of the base
    /// definition — no instantiation.
    pub fn macro_preview(&self, macro_id: &str) -> Result<Vec<MacroPreviewNode>> {
        let def = self
            .macros
            .get(macro_id)
            .ok_or_else(|| anyhow!("unknown macro {macro_id:?}"))?;
        def.modules
            .iter()
            .map(|(inner, mf)| {
                Ok(MacroPreviewNode {
                    id: inner.clone(),
                    ext: mf.ext.clone(),
                    manifest: self
                        .registry
                        .manifest(&mf.ext)
                        .ok_or_else(|| anyhow!("unknown module type {:?} in macro", mf.ext))?,
                    knobs: mf.knobs.clone(),
                    position: def.positions.get(inner).copied(),
                })
            })
            .collect()
    }

    /// The knob state a fresh instantiation of `def` would give an internal
    /// jack, or `None` when the definition saved nothing for it (the
    /// concrete jack's manifest default applies).
    pub(crate) fn macro_default_knob(
        &self,
        def: &MacroDef,
        node: &str,
        jack: &str,
    ) -> Option<KnobState> {
        def.modules.get(node)?.knobs.get(jack).cloned()
    }

    /// Reset a macro instance's expanded internal nodes to the state a
    /// fresh instantiation of `def` would give them: manifest defaults with
    /// the definition's saved params/knobs applied on top (mirroring
    /// `expand_macro_def`). Non-structural — wiring and mappings stay.
    pub(super) fn reset_macro_state(&mut self, prefix: &str, def: &MacroDef) -> Result<()> {
        for (inner, mf) in &def.modules {
            let full = format!("{prefix}/{inner}");
            self.reset_node_to_manifest(&full)?;
            for (param, value) in &mf.params {
                self.set_param(&full, param, *value)?;
            }
            for (jack, state) in &mf.knobs {
                self.restore_knob(&full, jack, state.clone())?;
            }
        }
        Ok(())
    }

    pub(crate) fn resolve_param(&self, id: &str, param: &str) -> Result<(String, String)> {
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

    /// Adopt the current base definition of `macro_id` as a new instance:
    /// the instance gets its own copy, unaffected by later edits to the
    /// base. Only valid while stopped (structural edit, like `add_module`).
    pub(super) fn instantiate_macro(&mut self, instance_id: &str, macro_id: &str) -> Result<()> {
        let def = self
            .macros
            .get(macro_id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown macro {macro_id:?}"))?;
        self.adopt_macro(
            instance_id,
            &crate::patch::MacroInstanceFile { def, state: None },
        )
    }

    /// Expand one instance from its own copy: `file.def` becomes the
    /// instance's adopted baseline (what *reset to defaults* restores) and
    /// `file.effective()` — its live state, when it has drifted — is what
    /// actually goes into the graph.
    pub(crate) fn adopt_macro(
        &mut self,
        instance_id: &str,
        file: &crate::patch::MacroInstanceFile,
    ) -> Result<()> {
        anyhow::ensure!(
            !self.node_by_id.contains_key(instance_id)
                && !self.macro_instances.contains_key(instance_id),
            "duplicate instance id {instance_id:?}"
        );
        anyhow::ensure!(
            !instance_id.contains('/'),
            "macro instances may not nest ({instance_id:?})"
        );
        self.ensure_no_nesting(&file.def)?;
        self.ensure_no_nesting(file.effective())?;
        self.expand_macro_def(instance_id, file.effective(), file.def.clone())
    }

    /// Macros are flat: an internal module may not itself be a macro.
    fn ensure_no_nesting(&self, def: &MacroDef) -> Result<()> {
        for (inner, mf) in &def.modules {
            anyhow::ensure!(
                self.macros.get(&mf.ext).is_none() && self.registry.manifest(&mf.ext).is_some(),
                "macro {:?} nests macro {:?} as {inner:?} — macros may not nest",
                def.id,
                mf.ext
            );
        }
        Ok(())
    }

    fn expand_macro_def(&mut self, prefix: &str, def: &MacroDef, adopted: MacroDef) -> Result<()> {
        // 1. Internal modules.
        let mut deferred_syncs: Vec<(String, String)> = Vec::new();
        for (inner, mf) in &def.modules {
            let full = format!("{prefix}/{inner}");
            self.add_plain_module(&full, &mf.ext)?;
            if mf.name.is_some() {
                self.set_display_name(&full, mf.name.clone())?;
            }
            for m in &mf.midi_mappings {
                self.add_midi_mapping(&full, m.kind, m.num, &m.name)?;
            }
            for m in &mf.midi_led_mappings {
                self.add_midi_led_mapping(&full, m.kind, m.num, &m.name)?;
            }
            if let Some(c) = &mf.choreo {
                self.choreo_set_state(&full, c.clone())?;
            }
            if let Some(track) = &mf.track {
                self.load_module_track(&full, BuiltinKind::from_ext_id(&mf.ext), track)?;
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

        // 3. Resolve the external interface to concrete nodes.
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
                macro_id: adopted.id.clone(),
                def: adopted,
                display_name: None,
                inputs,
                outputs,
                params,
            },
        );
        Ok(())
    }

    /// Collapse a selection onto an EXISTING macro id, replacing its base
    /// definition (the "save over macro 'X'?" flow). The new instance
    /// adopts the new definition; every OTHER live instance keeps the copy
    /// it was adopted with until it pulls. Returns the definition for
    /// persisting to the store.
    pub fn recollapse_macro(
        &mut self,
        selection: &[&str],
        new_instance_id: &str,
        macro_id: &str,
        name: &str,
        interface: MacroInterface,
    ) -> Result<MacroDef> {
        anyhow::ensure!(
            self.macros.get(macro_id).is_some(),
            "unknown macro {macro_id:?}"
        );
        // Collapse under a scratch id (collapse_to_macro refuses existing
        // ids), then rewrite to the real id. The scratch id never persists:
        // it lives only inside this call's intermediate engine state.
        let scratch = format!("{macro_id}\u{1f}overwrite");
        anyhow::ensure!(
            self.macros.get(&scratch).is_none(),
            "scratch id in use — retry"
        );
        let mut def =
            self.collapse_to_macro(selection, new_instance_id, &scratch, name, interface)?;
        self.macros.unregister(&scratch);
        def.id = macro_id.to_string();
        self.macros.register(def.clone());
        let mut doc = self.snapshot("overwrite-macro");
        if let Some(mf) = doc.modules.get_mut(new_instance_id) {
            mf.ext = macro_id.to_string();
        }
        if let Some(file) = doc.macros.get_mut(new_instance_id) {
            file.def = def.clone();
            file.state = None;
        }
        self.rebuild(&doc)?;
        Ok(def)
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
                !self.macro_instances.contains_key(id),
                "cannot collapse macro instance {id:?} — macros may not nest \
                 (break it apart first)"
            );
            anyhow::ensure!(self.node_by_id.contains_key(id), "no instance {id:?}");
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
            // A definition is workspace-neutral: the tag lives on the
            // INSTANCE (its members' NodeInfo), never in the adopted copy.
            mf.workspace = crate::engine::Workspace::default();
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
            modules: def_modules,
            wires: def_wires,
            interface,
            positions: BTreeMap::new(),
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
                name: None,
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
                // The instance stays in the room its members were in
                // (they must all share one — the UI only selects within
                // a workspace).
                workspace: sel
                    .first()
                    .and_then(|id| self.module_workspace(id).ok())
                    .unwrap_or_default(),
            },
        );
        // Rack layout survives the rebuild: collapsed members keep their
        // absolute spots under their new `/`-prefixed ids.
        let mut layout = doc.layout.clone();
        for id in &sel {
            if let Some(p) = layout.remove(id) {
                layout.insert(format!("{new_instance_id}/{id}"), p);
            }
        }
        // The fresh instance adopts the definition it was just made from;
        // definitions of untouched instances ride along unchanged.
        let mut new_macros = doc.macros.clone();
        new_macros.insert(
            new_instance_id.to_string(),
            crate::patch::MacroInstanceFile {
                def: def.clone(),
                state: None,
            },
        );
        let new_doc = crate::patch::PatchDoc {
            header: doc.header.clone(),
            modules: new_modules,
            wires: new_wires,
            macros: new_macros,
            layout,
        };
        self.rebuild(&new_doc)?;
        Ok(def)
    }

    /// Record the saved rack positions of a base definition's internal
    /// modules (UI passthrough metadata; instances unaffected).
    pub fn set_macro_positions(
        &mut self,
        macro_id: &str,
        positions: BTreeMap<String, (f32, f32)>,
    ) -> Result<MacroDef> {
        let def = self
            .macros
            .defs
            .get_mut(macro_id)
            .ok_or_else(|| anyhow!("unknown macro {macro_id:?}"))?;
        def.positions = positions;
        Ok(def.clone())
    }

    /// Saved positions for every node a fresh instance of `macro_id` would
    /// expand to, keyed by the id relative to the instance. Modules the
    /// definition has no position for are omitted (the UI's placement fixup
    /// finds them a spot).
    pub fn macro_layout(&self, macro_id: &str) -> Result<BTreeMap<String, (f32, f32)>> {
        let def = self
            .macros
            .get(macro_id)
            .ok_or_else(|| anyhow!("unknown macro {macro_id:?}"))?;
        Ok(def
            .modules
            .keys()
            .filter_map(|inner| Some((inner.clone(), *def.positions.get(inner)?)))
            .collect())
    }

    /// Break a macro instance apart (the UI's right-click "Break Macro"):
    /// its expanded internal nodes stay in the graph exactly as they are —
    /// same slots, same DSP state, same wires — but become ordinary
    /// top-level modules (direct nested macro instances become top-level
    /// macro instances). Pure control-side renaming: no RT interaction, so
    /// the engine may keep running. Returns old id -> new id for every
    /// renamed node and nested instance.
    pub fn break_macro(&mut self, instance_id: &str) -> Result<BTreeMap<String, String>> {
        anyhow::ensure!(
            !instance_id.contains('/'),
            "cannot break nested macro instance {instance_id:?}"
        );
        anyhow::ensure!(
            self.macro_instances.contains_key(instance_id),
            "no macro instance {instance_id:?}"
        );
        let prefix = format!("{instance_id}/");

        // Fresh top-level names for the direct children, avoiding every
        // existing top-level id (the broken instance's own name frees up).
        let mut taken: std::collections::BTreeSet<String> = self
            .node_by_id
            .keys()
            .chain(self.macro_instances.keys())
            .filter(|id| !id.contains('/') && id.as_str() != instance_id)
            .cloned()
            .collect();
        let mut seg_renames: BTreeMap<String, String> = BTreeMap::new();
        let segments: std::collections::BTreeSet<String> = self
            .node_by_id
            .keys()
            .chain(self.macro_instances.keys())
            .filter_map(|id| id.strip_prefix(&prefix))
            .map(|rest| rest.split('/').next().unwrap().to_string())
            .collect();
        for seg in segments {
            let fresh = std::iter::once(seg.clone())
                .chain((2..).map(|n| format!("{seg}{n}")))
                .find(|c| !taken.contains(c))
                .unwrap();
            taken.insert(fresh.clone());
            seg_renames.insert(seg, fresh);
        }
        let rename = |id: &str| -> Option<String> {
            let rest = id.strip_prefix(&prefix)?;
            let (seg, tail) = match rest.split_once('/') {
                Some((s, t)) => (s, Some(t)),
                None => (rest, None),
            };
            let fresh = &seg_renames[seg];
            Some(match tail {
                Some(t) => format!("{fresh}/{t}"),
                None => fresh.clone(),
            })
        };

        let mut renames: BTreeMap<String, String> = BTreeMap::new();

        // Node table: keys and NodeInfo ids (slots untouched — wires and
        // every slot-keyed side table stay valid).
        let node_ids: Vec<String> = self
            .node_by_id
            .keys()
            .filter(|id| id.starts_with(&prefix))
            .cloned()
            .collect();
        for old in node_ids {
            let new_id = rename(&old).unwrap();
            let slot = self.node_by_id.remove(&old).unwrap();
            self.nodes[slot].instance_id = new_id.clone();
            self.node_by_id.insert(new_id.clone(), slot);
            renames.insert(old, new_id);
        }
        // Deck sync partners are stored as instance ids.
        for ctl in self.decks.values_mut() {
            if let Some(sync) = &ctl.sync_to {
                if let Some(new_id) = rename(sync) {
                    ctl.sync_to = Some(new_id);
                }
            }
        }
        // Nested macro instances lift to top level; their resolved jack
        // tables point at concrete (renamed) nodes.
        let instances = std::mem::take(&mut self.macro_instances);
        for (id, mut mi) in instances {
            if id == instance_id {
                continue; // the broken instance itself dissolves
            }
            let new_key = match rename(&id) {
                Some(new_key) => {
                    renames.insert(id, new_key.clone());
                    new_key
                }
                None => id, // unrelated instance: untouched
            };
            for (_, node, _) in mi
                .inputs
                .iter_mut()
                .chain(mi.outputs.iter_mut())
                .chain(mi.params.iter_mut())
            {
                if let Some(new_node) = rename(node) {
                    *node = new_node;
                }
            }
            self.macro_instances.insert(new_key, mi);
        }
        Ok(renames)
    }

    /// One instance's current internal state as a definition — what *save
    /// macro* would publish and what the UI compares to decide whether the
    /// verbs are no-ops.
    pub fn macro_instance_state(&self, instance_id: &str) -> Result<MacroDef> {
        let mut def = self.snapshot("macro-state");
        def.macros
            .remove(instance_id)
            .map(|file| file.state.unwrap_or(file.def))
            .ok_or_else(|| anyhow!("no macro instance {instance_id:?}"))
    }

    /// *Pull latest*: replace one instance's copy with the current base and
    /// re-expand it. DESTRUCTIVE — every edit made inside the instance is
    /// discarded, and wires into external jacks the new definition no
    /// longer has are dropped (returned as load warnings, so callers can
    /// surface them). No-op when the instance already matches the base.
    /// The engine must be stopped (structural edit).
    pub fn pull_macro_instance(&mut self, instance_id: &str) -> Result<Vec<String>> {
        self.core_mut()?;
        let mi = self
            .macro_instances
            .get(instance_id)
            .ok_or_else(|| anyhow!("no macro instance {instance_id:?}"))?;
        let base = self
            .macros
            .get(&mi.macro_id)
            .cloned()
            .ok_or_else(|| anyhow!("macro {:?} is not in the store", mi.macro_id))?;
        let mut doc = self.snapshot("pull-macro");
        let file = doc
            .macros
            .get_mut(instance_id)
            .ok_or_else(|| anyhow!("no macro instance {instance_id:?}"))?;
        if file.def == base && file.state.is_none() {
            return Ok(Vec::new());
        }
        file.def = base;
        file.state = None;
        reset_promoted_state(&mut doc, instance_id);
        self.rebuild(&doc)?;
        Ok(self.load_warnings.clone())
    }

    /// *Save macro*: publish one instance's current state (internal knobs,
    /// params, wires, names — plus the members' current relative layout as
    /// the definition's saved positions) as the new base. The instance
    /// itself becomes clean: its copy IS the published definition, so
    /// *reset to defaults* now returns here. Returns the definition to
    /// persist to the store, or `None` when nothing changed.
    pub fn save_macro_instance(&mut self, instance_id: &str) -> Result<Option<MacroDef>> {
        let mut def = self.macro_instance_state(instance_id)?;
        def.positions = self.instance_relative_layout(instance_id);
        if self.macros.get(&def.id) == Some(&def) {
            return Ok(None);
        }
        self.macros.register(def.clone());
        let mi = self
            .macro_instances
            .get_mut(instance_id)
            .ok_or_else(|| anyhow!("no macro instance {instance_id:?}"))?;
        mi.def = def.clone();
        Ok(Some(def))
    }

    /// *Reset to defaults*: discard everything edited inside one instance
    /// since it was adopted, back to ITS copy of the definition (not the
    /// base, and not the internal modules' own manifest defaults). No-op
    /// when the instance has not drifted. The engine must be stopped
    /// (structural edit: internal wiring is restored too).
    pub fn reset_macro_instance(&mut self, instance_id: &str) -> Result<()> {
        self.core_mut()?;
        let mut doc = self.snapshot("reset-macro");
        let before = doc.clone();
        doc.macros
            .get_mut(instance_id)
            .ok_or_else(|| anyhow!("no macro instance {instance_id:?}"))?
            .state = None;
        reset_promoted_state(&mut doc, instance_id);
        if doc == before {
            return Ok(());
        }
        self.rebuild(&doc)
    }

    /// Members' rack positions relative to the group's top-left corner, for
    /// the definition's `positions` (empty unless every member is placed).
    fn instance_relative_layout(&self, instance_id: &str) -> BTreeMap<String, (f32, f32)> {
        let prefix = format!("{instance_id}/");
        let placed: Vec<(&str, (f32, f32))> = self
            .nodes
            .iter()
            .filter_map(|n| Some((n.instance_id.strip_prefix(&prefix)?, n.position?)))
            .collect();
        let members = self
            .nodes
            .iter()
            .filter(|n| n.instance_id.starts_with(&prefix))
            .count();
        if placed.is_empty() || placed.len() != members {
            return BTreeMap::new();
        }
        let ox = placed.iter().map(|(_, p)| p.0).fold(f32::MAX, f32::min);
        let oy = placed.iter().map(|(_, p)| p.1).fold(f32::MAX, f32::min);
        placed
            .into_iter()
            .map(|(id, (x, y))| (id.to_string(), (x - ox, y - oy)))
            .collect()
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

/// Put an instance's promoted knobs/params (its module entry, which the
/// load path applies ON TOP of the expansion) back to what its definition
/// saves for them, so *pull* and *reset* also undo twiddles made from the
/// outside of the macro.
fn reset_promoted_state(doc: &mut crate::patch::PatchDoc, instance_id: &str) {
    let Some(def) = doc.macros.get(instance_id).map(|f| f.effective().clone()) else {
        return;
    };
    let Some(mf) = doc.modules.get_mut(instance_id) else {
        return;
    };
    mf.knobs = def
        .interface
        .inputs
        .iter()
        .filter_map(|j| {
            let state = def.modules.get(&j.node)?.knobs.get(&j.jack)?;
            Some((j.id.clone(), state.clone()))
        })
        .collect();
    mf.params = def
        .interface
        .params
        .iter()
        .filter_map(|p| {
            let value = def.modules.get(&p.node)?.params.get(&p.param)?;
            Some((p.id.clone(), *value))
        })
        .collect();
}
