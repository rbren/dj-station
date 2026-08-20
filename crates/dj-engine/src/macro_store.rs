//! The global macro store: `<data_dir>/macros/<macro id>.json`, a sibling
//! of `patches/`.
//!
//! Macros are global objects (PRD §6): one file per macro, one current
//! definition per id — the **base**. There is no version history; saving a
//! macro just updates its file. Patches do not need this directory to
//! play: every instance owns a copy of the definition it adopted (see
//! [`crate::macros`]), so the store is where macros are *published* and
//! *picked up*, nothing more.
//!
//! Patches written before the store existed embedded definitions under
//! `<patch>/macros/<macro id>.json`, one shared copy per id.
//! [`MacroStore::import_patch_macros`] migrates them in place: the newest
//! definition found for each id seeds the base, and every patch is
//! rewritten to the per-instance layout, so nothing is lost and no patch
//! changes how it sounds.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::macros::{MacroDef, MacroLibrary};
use crate::patch::{to_pretty, write_if_changed, MacroInstanceFile, ModuleFile};

/// Directory name of the store under the data dir.
pub const MACROS_DIR_NAME: &str = "macros";

/// A directory of base macro definitions.
#[derive(Debug, Clone)]
pub struct MacroStore {
    dir: PathBuf,
}

/// What [`MacroStore::import_patch_macros`] did, for logging.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MacroImport {
    /// Base ids created in the store.
    pub bases: Vec<String>,
    /// `(patch name, instance id)` for every instance that got its own copy.
    pub instances: Vec<(String, String)>,
    /// Embedded definitions that collapsed onto an id already accounted
    /// for — the same macro carried by several patches, or one already in
    /// the store.
    pub deduped: usize,
}

impl MacroImport {
    pub fn is_empty(&self) -> bool {
        self.bases.is_empty() && self.instances.is_empty()
    }
}

impl MacroStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        MacroStore { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Every base definition. A missing store directory reads as empty.
    pub fn load(&self) -> Result<MacroLibrary> {
        let mut lib = MacroLibrary::default();
        if !self.dir.is_dir() {
            return Ok(lib);
        }
        for entry in std::fs::read_dir(&self.dir)
            .with_context(|| format!("reading macro store {}", self.dir.display()))?
        {
            let path = entry?.path();
            if path.extension().map(|x| x == "json").unwrap_or(false) {
                let def: MacroDef = serde_json::from_str(&std::fs::read_to_string(&path)?)
                    .with_context(|| format!("reading {}", path.display()))?;
                lib.register(def);
            }
        }
        Ok(lib)
    }

    /// Publish a definition as the current base for its id.
    pub fn save(&self, def: &MacroDef) -> Result<()> {
        std::fs::create_dir_all(&self.dir)
            .with_context(|| format!("creating macro store {}", self.dir.display()))?;
        write_if_changed(&self.path_of(&def.id)?, &to_pretty(def)?)?;
        Ok(())
    }

    /// Delete a base. Returns false when there was no file. Instances that
    /// adopted it keep their copies and go on working.
    pub fn remove(&self, id: &str) -> Result<bool> {
        let path = self.path_of(id)?;
        if !path.is_file() {
            return Ok(false);
        }
        std::fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
        Ok(true)
    }

    fn path_of(&self, id: &str) -> Result<PathBuf> {
        anyhow::ensure!(
            !id.is_empty()
                && !id.starts_with('.')
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')),
            "macro id {id:?} is not a valid file name"
        );
        Ok(self.dir.join(format!("{id}.json")))
    }

    /// Migrate patches written in the pre-store layout (one embedded
    /// definition per macro id) to the current one (one copy per instance,
    /// bases in the store). Idempotent: patches already in the new layout
    /// are left alone, so this can run on every launch.
    pub fn import_patch_macros(&self, patches_dir: &Path) -> Result<MacroImport> {
        let mut report = MacroImport::default();
        let Ok(entries) = std::fs::read_dir(patches_dir) else {
            return Ok(report);
        };
        let mut patches: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.join("patch.json").is_file())
            .collect();
        patches.sort();

        // Every patch gets its module files normalized (which drops the
        // retired `macro_version` key); only those with an embedded
        // definition dir need the macro migration proper.
        let mut legacy: Vec<LegacyPatch> = Vec::new();
        for patch in patches {
            let types = module_types(&patch)?;
            let defs = legacy_defs(&patch)?;
            if !defs.is_empty() {
                legacy.push((patch, defs, types));
            }
        }
        if legacy.is_empty() {
            return Ok(report);
        }

        // The newest definition of each id seeds the base; an id already in
        // the store keeps what is there. Every other embedded copy of that
        // id is a duplicate — patches keep them as their instances' copies,
        // but the store holds one object per id.
        let newest = newest_by_id(&legacy);
        let embedded: usize = legacy.iter().map(|(_, defs, _)| defs.len()).sum();
        report.deduped = embedded - newest.len();
        let bases = self.load()?;
        for (id, def) in newest {
            if bases.get(&id).is_some() {
                report.deduped += 1;
                continue;
            }
            self.save(&def)?;
            report.bases.push(id);
        }

        for (patch, defs, types) in &legacy {
            let name = patch.file_name().unwrap_or_default().to_string_lossy();
            let mut files: BTreeMap<String, MacroInstanceFile> = BTreeMap::new();
            for (instance_id, ext) in types {
                let Some(legacy) = defs.get(ext) else {
                    continue;
                };
                files.insert(
                    instance_id.clone(),
                    MacroInstanceFile {
                        def: legacy.def.clone(),
                        state: None,
                    },
                );
                report
                    .instances
                    .push((name.to_string(), instance_id.clone()));
            }
            rewrite_macros_dir(patch, &files)?;
        }
        Ok(report)
    }
}

/// One patch to migrate: its directory, the definitions it embedded keyed
/// by macro id, and its instance ids keyed to the module type they use.
type LegacyPatch = (
    PathBuf,
    BTreeMap<String, LegacyDef>,
    BTreeMap<String, String>,
);

/// A definition read from a pre-store patch tree, with the version counter
/// that used to order edits (kept only to pick the newest at migration).
struct LegacyDef {
    def: MacroDef,
    version: u32,
}

#[derive(Deserialize)]
struct LegacyVersion {
    #[serde(default)]
    version: u32,
}

/// Definitions embedded per macro id in one patch tree, keyed by macro id.
/// A tree already in the per-instance layout yields nothing: its files are
/// keyed by instance id and wrap the definition in a `def` field.
fn legacy_defs(patch: &Path) -> Result<BTreeMap<String, LegacyDef>> {
    let dir = patch.join(MACROS_DIR_NAME);
    if !dir.is_dir() {
        return Ok(BTreeMap::new());
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
        .collect();
    files.sort();
    let mut out = BTreeMap::new();
    for path in files {
        let text = std::fs::read_to_string(&path)?;
        if serde_json::from_str::<MacroInstanceFile>(&text).is_ok() {
            continue; // already migrated
        }
        let def: MacroDef =
            serde_json::from_str(&text).with_context(|| format!("reading {}", path.display()))?;
        let version = serde_json::from_str::<LegacyVersion>(&text)
            .map(|v| v.version)
            .unwrap_or(0);
        out.insert(def.id.clone(), LegacyDef { def, version });
    }
    Ok(out)
}

/// The newest definition found for each id across all patches (highest old
/// version counter; ties go to the first patch in sorted order).
fn newest_by_id(legacy: &[LegacyPatch]) -> BTreeMap<String, MacroDef> {
    let mut best: BTreeMap<String, (u32, MacroDef)> = BTreeMap::new();
    for (_, defs, _) in legacy {
        for (id, found) in defs {
            if best
                .get(id)
                .map(|(v, _)| found.version > *v)
                .unwrap_or(true)
            {
                best.insert(id.clone(), (found.version, found.def.clone()));
            }
        }
    }
    best.into_iter().map(|(id, (_, def))| (id, def)).collect()
}

/// The module type of every instance in a patch tree, read straight off
/// `modules/<instance>.json` — the document as a whole cannot be parsed
/// until its macros dir is migrated. Files still carrying the retired
/// `macro_version` key are rewritten without it.
fn module_types(patch: &Path) -> Result<BTreeMap<String, String>> {
    let dir = patch.join("modules");
    let mut out = BTreeMap::new();
    for entry in std::fs::read_dir(&dir).with_context(|| format!("reading {}", dir.display()))? {
        let path = entry?.path();
        if path.extension().map(|x| x != "json").unwrap_or(true) {
            continue;
        }
        let instance = path.file_stem().unwrap_or_default().to_string_lossy();
        let text = std::fs::read_to_string(&path)?;
        let mf: ModuleFile =
            serde_json::from_str(&text).with_context(|| format!("reading {}", path.display()))?;
        if text.contains("\"macro_version\"") {
            write_if_changed(&path, &to_pretty(&mf)?)?;
        }
        out.insert(instance.to_string(), mf.ext);
    }
    Ok(out)
}

/// Replace a patch's `macros/` directory with per-instance files (the old
/// per-id ones are simply not written back).
fn rewrite_macros_dir(patch: &Path, files: &BTreeMap<String, MacroInstanceFile>) -> Result<()> {
    let dir = patch.join(MACROS_DIR_NAME);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).with_context(|| format!("removing {}", dir.display()))?;
    }
    if files.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(&dir)?;
    for (instance_id, file) in files {
        write_if_changed(&dir.join(format!("{instance_id}.json")), &to_pretty(file)?)?;
    }
    Ok(())
}
