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

    /// Remove a macro definition from the engine's library. Plain removal —
    /// callers deleting a user-library macro must first ensure no rack
    /// instance still references it (a saved patch would silently lose the
    /// instance's embedded definition); the overwrite-by-recollapse flow
    /// removes and immediately re-registers under the same id instead.
    pub fn unregister_macro(&mut self, macro_id: &str) -> Option<MacroDef> {
        self.macros.unregister(macro_id)
    }

    /// Rename a macro definition (stable id, display name only). Bumps the
    /// version — the name is part of the definition patches embed, so old
    /// patches resolve the change through the usual update-vs-fork prompt —
    /// and stamps live instances with the new version (nothing structural
    /// changed). Returns the updated definition for persisting.
    pub fn rename_macro(&mut self, macro_id: &str, new_name: &str) -> Result<MacroDef> {
        let new_name = new_name.trim();
        anyhow::ensure!(!new_name.is_empty(), "macro name must not be empty");
        let mut def = self
            .macros
            .get(macro_id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown macro {macro_id:?}"))?;
        def.name = new_name.to_string();
        def.version += 1;
        for mi in self.macro_instances.values_mut() {
            if mi.macro_id == macro_id {
                mi.version = def.version;
            }
        }
        self.macros.register(def.clone());
        Ok(def)
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
                    audio: false,
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
        })
    }

    /// Everything a UI needs to draw a thumbnail of what a fresh instance
    /// of `macro_id` expands to: each concrete internal node's type,
    /// manifest, definition-saved knob states and saved relative position
    /// (nested macros flattened with their entry's offset, like
    /// [`Self::macro_layout`]; `None` position when the definition saved
    /// none). Purely a read of the definition — no instantiation. Knob
    /// states are each level's own saved values; an outer definition's
    /// overrides of a *nested* macro's promoted jacks are not resolved
    /// down (invisible at thumbnail scale, and instantiation handles them
    /// properly via `expand_macro_def`).
    pub fn macro_preview(&self, macro_id: &str) -> Result<Vec<MacroPreviewNode>> {
        let def = self
            .macros
            .get(macro_id)
            .ok_or_else(|| anyhow!("unknown macro {macro_id:?}"))?;
        let mut out = Vec::new();
        self.collect_macro_preview(def, "", Some((0.0, 0.0)), &mut out)?;
        Ok(out)
    }

    fn collect_macro_preview(
        &self,
        def: &MacroDef,
        prefix: &str,
        offset: Option<(f32, f32)>,
        out: &mut Vec<MacroPreviewNode>,
    ) -> Result<()> {
        for (inner, mf) in &def.modules {
            let id = if prefix.is_empty() {
                inner.clone()
            } else {
                format!("{prefix}/{inner}")
            };
            // A node is only placeable when every level down to it saved a
            // position (same rule as macro_layout).
            let pos = match (offset, def.positions.get(inner)) {
                (Some((ox, oy)), Some(&(x, y))) => Some((ox + x, oy + y)),
                _ => None,
            };
            if let Some(inner_def) = self.macros.get(&mf.ext) {
                self.collect_macro_preview(inner_def, &id, pos, out)?;
            } else {
                let manifest = self
                    .registry
                    .manifest(&mf.ext)
                    .ok_or_else(|| anyhow!("unknown module type {:?} in macro", mf.ext))?;
                out.push(MacroPreviewNode {
                    id,
                    ext: mf.ext.clone(),
                    manifest,
                    knobs: mf.knobs.clone(),
                    position: pos,
                });
            }
        }
        Ok(())
    }

    /// The knob state a fresh instantiation of `def` would give an internal
    /// jack: the state saved in the definition (recursing through nested
    /// macros), or `None` when the definition saved nothing for it (the
    /// concrete jack's manifest default applies).
    pub(crate) fn macro_default_knob(
        &self,
        def: &MacroDef,
        node: &str,
        jack: &str,
    ) -> Option<KnobState> {
        let mf = def.modules.get(node)?;
        if let Some(saved) = mf.knobs.get(jack) {
            return Some(saved.clone());
        }
        let inner = self.macros.get(&mf.ext)?;
        let ij = inner.interface.inputs.iter().find(|j| j.id == jack)?;
        self.macro_default_knob(inner, &ij.node, &ij.jack)
    }

    /// Reset a macro instance's expanded internal nodes to the state a
    /// fresh instantiation of `def` would give them: manifest defaults with
    /// the definition's saved params/knobs applied on top (mirroring
    /// `expand_macro_def`). Non-structural — wiring and mappings stay.
    pub(super) fn reset_macro_state(&mut self, prefix: &str, def: &MacroDef) -> Result<()> {
        for (inner, mf) in &def.modules {
            let full = format!("{prefix}/{inner}");
            if let Some(inner_def) = self.macros.get(&mf.ext).cloned() {
                self.reset_macro_state(&full, &inner_def)?;
            } else {
                self.reset_node_to_manifest(&full)?;
            }
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
                display_name: None,
                inputs,
                outputs,
                params,
            },
        );
        Ok(())
    }

    /// Collapse a selection onto an EXISTING macro id, replacing its
    /// definition (the "save over macro 'X'?" flow). The new definition
    /// keeps the stable id, takes `name`, and bumps the version past the
    /// old one; every other live instance of the macro re-expands to the
    /// new definition (update semantics, PRD §6 — per-instance promoted
    /// state survives only for interface jacks the new definition still
    /// has). Returns the definition for persisting.
    pub fn recollapse_macro(
        &mut self,
        selection: &[&str],
        new_instance_id: &str,
        macro_id: &str,
        name: &str,
        interface: MacroInterface,
    ) -> Result<MacroDef> {
        let old = self
            .macros
            .get(macro_id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown macro {macro_id:?}"))?;
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
        def.version = old.version + 1;
        self.macros.register(def.clone());
        // Re-point the fresh instance and re-expand every other instance of
        // the macro from the new definition.
        let mut doc = self.snapshot("overwrite-macro");
        for mf in doc.modules.values_mut() {
            if mf.ext == scratch || mf.ext == macro_id {
                mf.ext = macro_id.to_string();
                mf.macro_version = Some(def.version);
            }
        }
        doc.macros.clear(); // rebuild carries self.macros
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
                gesture: None,
                choreo: None,
                track: None,
                sync_to: None,
                macro_version: Some(1),
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
        let new_doc = crate::patch::PatchDoc {
            header: doc.header.clone(),
            modules: new_modules,
            wires: new_wires,
            macros: BTreeMap::new(), // rebuild carries self.macros
            layout,
        };
        self.rebuild(&new_doc)?;
        Ok(def)
    }

    /// Record the saved rack positions of a macro's internal modules
    /// (UI passthrough metadata — no version bump, instances unaffected).
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

    /// Saved positions for every concrete node a fresh instance of
    /// `macro_id` would expand to, keyed by the id path relative to the
    /// instance (nested macros flattened, offset by the nested entry's own
    /// position). Modules the definition has no position for are omitted
    /// (the UI's placement fixup finds them a spot).
    pub fn macro_layout(&self, macro_id: &str) -> Result<BTreeMap<String, (f32, f32)>> {
        let def = self
            .macros
            .get(macro_id)
            .ok_or_else(|| anyhow!("unknown macro {macro_id:?}"))?;
        let mut out = BTreeMap::new();
        for (inner, mf) in &def.modules {
            let Some(&(x, y)) = def.positions.get(inner) else {
                continue;
            };
            if self.macros.get(&mf.ext).is_some() {
                for (sub, (sx, sy)) in self.macro_layout(&mf.ext)? {
                    out.insert(format!("{inner}/{sub}"), (x + sx, y + sy));
                }
            } else {
                out.insert(inner.clone(), (x, y));
            }
        }
        Ok(out)
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
