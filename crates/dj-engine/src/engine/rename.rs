//! Module renaming: user-typed display names ("Wobble LFO") normalized
//! into instance ids ("wobble_lfo"). The normalized form is what patches,
//! wires and every programmatic surface use; the typed form is kept for
//! display only. Renames are control-side metadata edits — wires reference
//! graph slots, so nothing structural moves.

use super::*;

/// Normalize a user-typed module name into an instance id: lowercase ASCII
/// alphanumerics, every run of other characters collapsed to one `_`
/// (leading/trailing runs dropped). `"Wobble LFO!"` -> `"wobble_lfo"`.
pub fn normalize_module_name(name: &str) -> String {
    let mut out = String::new();
    let mut pending_sep = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_sep && !out.is_empty() {
                out.push('_');
            }
            pending_sep = false;
            out.push(c.to_ascii_lowercase());
        } else {
            pending_sep = true;
        }
    }
    out
}

impl Engine {
    /// Rename a top-level module (plain node or macro instance). The typed
    /// `name` is kept for display; its normalized form becomes the new
    /// instance id, returned on success. Fails WITHOUT side effects when
    /// the name has no usable characters or its normalized form collides
    /// with another instance's id.
    pub fn rename_module(&mut self, instance_id: &str, name: &str) -> Result<String> {
        anyhow::ensure!(
            !instance_id.contains('/'),
            "cannot rename macro-internal node {instance_id:?}"
        );
        let display = name.trim();
        let new_id = normalize_module_name(display);
        anyhow::ensure!(
            !new_id.is_empty(),
            "module name {display:?} has no usable characters (need letters or digits)"
        );
        let is_macro = self.macro_instances.contains_key(instance_id);
        anyhow::ensure!(
            is_macro || self.node_by_id.contains_key(instance_id),
            "no such module instance: {instance_id}"
        );
        if new_id != instance_id {
            anyhow::ensure!(
                !self.node_by_id.contains_key(&new_id)
                    && !self.macro_instances.contains_key(&new_id),
                "a module named {new_id:?} already exists"
            );
        }
        // Store the typed form only when it differs from the id (the id
        // alone displays identically otherwise).
        let display_name = (display != new_id).then(|| display.to_string());
        if is_macro {
            self.rename_macro_instance(instance_id, &new_id, display_name);
        } else {
            self.rename_node(instance_id, &new_id, display_name);
        }
        Ok(new_id)
    }

    /// Restore a persisted display name (load and undo/redo diff paths;
    /// the patch key is already the normalized id, so nothing else
    /// changes).
    pub(crate) fn set_display_name(
        &mut self,
        instance_id: &str,
        name: Option<String>,
    ) -> Result<()> {
        if let Some(mi) = self.macro_instances.get_mut(instance_id) {
            mi.display_name = name;
            return Ok(());
        }
        let node = self.node_idx(instance_id)?;
        self.nodes[node].display_name = name;
        Ok(())
    }

    fn rename_node(&mut self, old_id: &str, new_id: &str, display_name: Option<String>) {
        let slot = self.node_by_id.remove(old_id).expect("renamed node exists");
        self.node_by_id.insert(new_id.to_string(), slot);
        self.nodes[slot].instance_id = new_id.to_string();
        self.nodes[slot].display_name = display_name;
        for ctl in self.decks.values_mut() {
            if ctl.sync_to.as_deref() == Some(old_id) {
                ctl.sync_to = Some(new_id.to_string());
            }
        }
    }

    fn rename_macro_instance(&mut self, old_id: &str, new_id: &str, display_name: Option<String>) {
        let old_prefix = format!("{old_id}/");
        let remap = |id: &str| -> Option<String> {
            if id == old_id {
                Some(new_id.to_string())
            } else {
                id.strip_prefix(&old_prefix)
                    .map(|rest| format!("{new_id}/{rest}"))
            }
        };
        // Concrete internal nodes carry the instance prefix in their ids.
        let moved: Vec<(String, String)> = self
            .node_by_id
            .keys()
            .filter_map(|id| remap(id).map(|n| (id.clone(), n)))
            .collect();
        for (old, new) in &moved {
            let slot = self.node_by_id.remove(old).expect("moved node exists");
            self.node_by_id.insert(new.clone(), slot);
            self.nodes[slot].instance_id = new.clone();
        }
        // Instance records (this one plus nested), including their resolved
        // internal node references.
        let insts = std::mem::take(&mut self.macro_instances);
        self.macro_instances = insts
            .into_iter()
            .map(|(id, mut mi)| {
                let id = remap(&id).unwrap_or(id);
                for (_, node, _) in mi
                    .inputs
                    .iter_mut()
                    .chain(mi.outputs.iter_mut())
                    .chain(mi.params.iter_mut())
                {
                    if let Some(n) = remap(node) {
                        *node = n;
                    }
                }
                (id, mi)
            })
            .collect();
        if let Some(mi) = self.macro_instances.get_mut(new_id) {
            mi.display_name = display_name;
        }
        // Deck sync targets may reference the instance or its internals.
        for ctl in self.decks.values_mut() {
            if let Some(t) = ctl.sync_to.as_deref().and_then(remap) {
                ctl.sync_to = Some(t);
            }
        }
    }
}
