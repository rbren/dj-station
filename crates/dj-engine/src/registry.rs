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
                    && dir.join("dsp.wasm").exists()
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
        match ext_id {
            builtin::AUDIO_OUT_ID => Some(builtin::audio_out_manifest()),
            builtin::MIDI_ID => Some(builtin::midi_manifest()),
            crate::playback::PLAYBACK_ID => Some(crate::playback::playback_manifest()),
            _ => self.extensions.get(ext_id).map(|e| e.manifest.clone()),
        }
    }

    pub fn extension(&self, ext_id: &str) -> Option<&Extension> {
        self.extensions.get(ext_id)
    }

    /// Manifests of every module type that can be instantiated: built-ins
    /// first, then discovered extensions (sorted by id).
    pub fn all_manifests(&self) -> Vec<Manifest> {
        let mut out = vec![builtin::audio_out_manifest(), builtin::midi_manifest()];
        out.extend(self.extensions.values().map(|e| e.manifest.clone()));
        out
    }
}
