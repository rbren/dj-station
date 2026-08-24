//! The beatify PROJECT store (PRD §3.11).
//!
//! A project is one beatified take on one source track: the grid, the
//! constant-tempo render and the clips cut from them. A track can have as
//! many as the user likes — two projects of the same song may be beatified
//! at different strengths, or hold entirely different clips — so the
//! directory is keyed by PROJECT ID, not by the source:
//!
//! ```text
//! <data_dir>/beatify/<project-id>/
//!     project.json   ← id, name, which track it came from
//!     meta.json      ← the §5 payload (the record)
//!     warped.wav     ← constant-tempo render
//!     clips.json     ← clips cut in this project (see beatify_clip.rs)
//!     stems/         ← stems pulled through this project's warp map
//! ```
//!
//! Projects made before this store existed were keyed by the CONTENT HASH
//! of the source (MOD-A28), one per track. Those directories are still
//! valid projects — their id is simply the hash prefix that named them —
//! and [`list`] ADOPTS them, synthesising the envelope from `meta.json`.
//! Nothing is moved or rewritten, so nobody loses work; minted ids are
//! `p<n>`, which cannot collide with a 16-digit hex hash.
//!
//! A sidecar next to the source (`boys.beatify.json`, MOD-A29) is written
//! best-effort for portability; the store is authoritative and the sidecar
//! is re-derivable, so a read-only source directory is not an error.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::beatify::BeatifyRecord;
use crate::decode::AudioData;

pub const BEATIFY_DIR_NAME: &str = "beatify";
pub const META_NAME: &str = "meta.json";
pub const WARPED_NAME: &str = "warped.wav";
pub const PROJECT_NAME: &str = "project.json";
/// Hash prefix length used for legacy directory names (MOD-A28).
pub const HASH_LEN: usize = 16;

/// What a project is, apart from its audio: which track it was cut from
/// and what the user calls it. The record itself stays in `meta.json`,
/// unchanged, because that is also the sidecar format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// The library row it was made from. Local and re-assignable, so
    /// `source_hash` is the durable handle and this is the fast path.
    pub track_id: i64,
    pub source_hash: String,
    /// Unix seconds; what the project list is sorted by.
    pub updated: u64,
}

pub fn beatify_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(BEATIFY_DIR_NAME)
}

pub fn short_hash(hash: &str) -> String {
    hash.chars().take(HASH_LEN).collect()
}

/// Everything one project owns lives in one directory.
pub fn project_dir(data_dir: &Path, project_id: &str) -> PathBuf {
    beatify_dir(data_dir).join(project_id)
}

pub fn meta_path(data_dir: &Path, project_id: &str) -> PathBuf {
    project_dir(data_dir, project_id).join(META_NAME)
}

pub fn warped_path(data_dir: &Path, project_id: &str) -> PathBuf {
    project_dir(data_dir, project_id).join(WARPED_NAME)
}

pub fn project_path(data_dir: &Path, project_id: &str) -> PathBuf {
    project_dir(data_dir, project_id).join(PROJECT_NAME)
}

/// `boys.wav` → `boys.beatify.json`, next to the source.
pub fn sidecar_path(source: &Path) -> PathBuf {
    source.with_extension("beatify.json")
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// An id no existing project is using. `p<n>` never looks like a legacy
/// hash directory, so old and new can share one parent.
pub fn new_id(existing: &[Project]) -> String {
    let mut n = existing.len() + 1;
    loop {
        let id = format!("p{n}");
        if !existing.iter().any(|p| p.id == id) {
            return id;
        }
        n += 1;
    }
}

/// Write the two artifacts plus the envelope and the sidecar. Returns the
/// project directory.
pub fn save(
    data_dir: &Path,
    project: &Project,
    record: &BeatifyRecord,
    warped: &AudioData,
) -> Result<PathBuf> {
    let dir = project_dir(data_dir, &project.id);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let wav = dir.join(WARPED_NAME);
    std::fs::write(&wav, crate::clip::wav16_bytes(warped))
        .with_context(|| format!("writing {}", wav.display()))?;
    write_json(&dir.join(META_NAME), record)?;
    write_json(&dir.join(PROJECT_NAME), project)?;
    // MOD-A29: convenience copy, never load-bearing.
    let _ = write_json(&sidecar_path(Path::new(&record.source)), record);
    Ok(dir)
}

/// Update the envelope alone — a rename, or a touch of `updated`.
pub fn save_project(data_dir: &Path, project: &Project) -> Result<()> {
    let dir = project_dir(data_dir, &project.id);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    write_json(&dir.join(PROJECT_NAME), project)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let json = serde_json::to_string_pretty(value)?;
    std::fs::write(path, json).with_context(|| format!("writing {}", path.display()))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>> {
    if !path.exists() {
        return Ok(None);
    }
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let value =
        serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
    Ok(Some(value))
}

/// Load a project's record. `None` when there is no such project.
pub fn load(data_dir: &Path, project_id: &str) -> Result<Option<BeatifyRecord>> {
    read_json(&meta_path(data_dir, project_id))
}

/// Load a project's envelope, adopting a legacy hash-keyed directory if
/// that is what it turns out to be.
pub fn project(data_dir: &Path, project_id: &str) -> Result<Option<Project>> {
    if let Some(found) = read_json::<Project>(&project_path(data_dir, project_id))? {
        return Ok(Some(found));
    }
    let Some(record) = load(data_dir, project_id)? else {
        return Ok(None);
    };
    Ok(Some(adopt(data_dir, project_id, &record)))
}

/// The envelope a pre-projects directory implies: its name is the hash
/// prefix, and `meta.json` knows the rest.
fn adopt(data_dir: &Path, project_id: &str, record: &BeatifyRecord) -> Project {
    let name = Path::new(&record.source)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(project_id)
        .to_string();
    let updated = std::fs::metadata(meta_path(data_dir, project_id))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Project {
        id: project_id.to_string(),
        name,
        track_id: 0,
        source_hash: record.source_hash.clone(),
        updated,
    }
}

/// Every project in the store, newest first. Directories without a
/// `meta.json` are not projects and are ignored.
pub fn list(data_dir: &Path) -> Result<Vec<Project>> {
    let root = beatify_dir(data_dir);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&root).with_context(|| format!("reading {}", root.display()))? {
        let entry = entry?;
        if !entry.path().is_dir() {
            continue;
        }
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if let Some(found) = project(data_dir, &id)? {
            out.push(found);
        }
    }
    out.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

/// Drop a project, artifacts and all. Missing projects are not an error.
pub fn remove(data_dir: &Path, project_id: &str) -> Result<()> {
    let dir = project_dir(data_dir, project_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).with_context(|| format!("removing {}", dir.display()))?;
    }
    Ok(())
}
