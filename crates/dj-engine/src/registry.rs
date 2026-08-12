//! Extension discovery: scans folders for `manifest.json` + `dsp.wasm`.

use anyhow::Result;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::builtin;
use crate::manifest::{Extension, Manifest};

#[derive(Debug, Clone)]
pub struct ExtensionRegistry {
    pub search_paths: Vec<PathBuf>,
    pub extensions: BTreeMap<String, Extension>,
}

impl ExtensionRegistry {
    pub fn discover<P: AsRef<Path>>(search_paths: &[P]) -> Result<Self> {
        let mut reg = ExtensionRegistry {
            search_paths: search_paths
                .iter()
                .map(|p| p.as_ref().to_path_buf())
                .collect(),
            extensions: BTreeMap::new(),
        };
        reg.rescan()?;
        Ok(reg)
    }

    pub fn rescan(&mut self) -> Result<()> {
        self.extensions.clear();
        for base in &self.search_paths {
            if !base.is_dir() {
                continue;
            }
            let mut entries: Vec<_> = std::fs::read_dir(base)?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .collect();
            entries.sort();
            for dir in entries {
                if dir.is_dir()
                    && dir.join("manifest.json").exists()
                    && crate::manifest::find_dsp(&dir).is_some()
                {
                    match Extension::load(&dir) {
                        Ok(ext) => {
                            self.extensions.insert(ext.manifest.id.clone(), ext);
                        }
                        Err(e) => eprintln!("skipping extension {}: {e:#}", dir.display()),
                    }
                }
            }
        }
        Ok(())
    }

    /// Manifest for an extension or built-in module.
    pub fn manifest(&self, ext_id: &str) -> Option<Manifest> {
        match builtin::BuiltinKind::from_ext_id(ext_id) {
            Some(kind) => Some(kind.manifest()),
            None => self.extensions.get(ext_id).map(|e| e.manifest.clone()),
        }
    }

    pub fn extension(&self, ext_id: &str) -> Option<&Extension> {
        self.extensions.get(ext_id)
    }

    /// Manifests of every module type that can be instantiated (built-ins
    /// plus discovered extensions), grouped by category in display order
    /// and alphabetical by name within a category.
    pub fn all_manifests(&self) -> Vec<Manifest> {
        let mut out = vec![
            builtin::audio_out_manifest(),
            builtin::midi_manifest(),
            crate::qwerty::qwerty_manifest(),
            crate::playback::playback_manifest(),
            crate::deck::deck_manifest(),
            crate::mixer::crossfader_manifest(),
            crate::gesture::gesture_manifest(),
            crate::hands::hands_manifest(),
        ];
        out.extend(self.extensions.values().map(|e| e.manifest.clone()));
        out.sort_by(|a, b| {
            crate::manifest::categories::rank(&a.category)
                .cmp(&crate::manifest::categories::rank(&b.category))
                .then_with(|| a.category.cmp(&b.category))
                .then_with(|| a.name.cmp(&b.name))
        });
        out
    }
}
