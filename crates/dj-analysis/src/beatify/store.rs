//! The beatify PROJECT store (PRD §3.11).
//!
//! A project is a TEMPO and the material beatified onto it. Its seeds are
//! whole source tracks, each rendered constant-tempo; the first one to
//! arrive sets the project's BPM and every later one is conformed to it,
//! so anything cut from any of them layers with anything cut from the
//! others. That is the point of the whole tab, and it is why the tempo
//! belongs to the project rather than to a track:
//!
//! ```text
//! <data_dir>/beatify/<project-id>/
//!     project.json       ← id, name, bpm, the seed list
//!     seeds/<seed-id>/
//!         meta.json      ← the §5 payload (the record) for that seed
//!         warped.wav     ← constant-tempo render, at the project's tempo
//!         stems/         ← stems pulled through this seed's warp map
//!     clips.json         ← clips cut in this project (see beatify_clip.rs)
//! ```
//!
//! TWO OLDER LAYOUTS ARE READ, AND NEITHER IS REWRITTEN. [`Project`]
//! version 0 is a project from when one project meant one track:
//! `meta.json` and `warped.wav` sat at the project root and there was no
//! seed list. Those are adopted as a ONE-SEED project whose seed directory
//! IS the project root ([`Seed::dir`] empty), which is why nothing has to
//! be moved for old work to open. Older still are the pre-project
//! directories named by the source's content hash (MOD-A28); [`project`]
//! synthesises an envelope for those from `meta.json` alone. Minted ids
//! are `p<n>`, which cannot collide with a 16-digit hex hash.
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
pub const SEEDS_DIR_NAME: &str = "seeds";
pub const STEMS_DIR_NAME: &str = "stems";
/// Hash prefix length used for legacy directory names (MOD-A28).
pub const HASH_LEN: usize = 16;

/// One source track beatified into a project.
///
/// It carries the tempo it was PLAYED at as well as the ratio it is
/// played back at, because those are different facts and the user is
/// owed both: "recorded at 122.4, running 4.6% fast to sit at 128" is a
/// sentence the UI has to be able to write.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seed {
    pub id: String,
    /// What to call it — the track's title unless renamed.
    pub name: String,
    /// The library row it came from. Local and re-assignable, so
    /// `source_hash` is the durable handle and this is the fast path.
    pub track_id: i64,
    pub source_hash: String,
    /// Where its artifacts live, RELATIVE to the project directory:
    /// `seeds/<id>` for anything written since seeds existed, empty for
    /// the one seed of an adopted single-track project.
    #[serde(default)]
    pub dir: String,
    /// The tempo of the performance, before conforming.
    pub source_bpm: f64,
    /// Playback ratio that puts it on the project's grid: 1.0 when it was
    /// the seed that set the tempo, >1 when it had to speed up.
    #[serde(default = "one")]
    pub speed: f64,
}

fn one() -> f64 {
    1.0
}

impl Seed {
    /// Percent faster (or slower) than it was played, for display.
    pub fn speed_pct(&self) -> f64 {
        (self.speed - 1.0) * 100.0
    }
}

/// What a project is, apart from its audio: its tempo, its seeds and what
/// the user calls it. Each seed's record stays in its own `meta.json`,
/// unchanged, because that is also the sidecar format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// The tempo every seed is rendered to. `None` until the first seed
    /// lands: a project can exist with nothing in it — that is how one is
    /// started — and an empty project has no tempo to speak of.
    #[serde(default)]
    pub bpm: Option<f64>,
    #[serde(default)]
    pub seeds: Vec<Seed>,
    /// Unix seconds; what the project list is sorted by.
    pub updated: u64,
    /// Which generation of the layout this envelope describes. 0 is a
    /// pre-seeds project — one track, artifacts at the root — and is
    /// adopted on read rather than migrated.
    #[serde(default)]
    pub version: u32,
    /// A pre-seeds envelope named the one track it was cut from. Read so
    /// an adopted project knows which library row its seed came from;
    /// seeds carry their own now, so nothing writes it any more.
    #[serde(default, rename = "trackId", skip_serializing_if = "is_zero")]
    pub legacy_track_id: i64,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

impl Project {
    pub const VERSION: u32 = 1;

    pub fn new(id: String, name: String) -> Project {
        Project {
            id,
            name,
            bpm: None,
            seeds: Vec::new(),
            updated: now_secs(),
            version: Project::VERSION,
            legacy_track_id: 0,
        }
    }

    pub fn seed(&self, seed_id: &str) -> Option<&Seed> {
        self.seeds.iter().find(|s| s.id == seed_id)
    }

    /// Seconds per beat at the project's tempo, if it has one.
    pub fn period(&self) -> Option<f64> {
        self.bpm.filter(|b| *b > 0.0).map(|b| 60.0 / b)
    }

    /// An id no seed of this project is using.
    pub fn new_seed_id(&self) -> String {
        let mut n = self.seeds.len() + 1;
        loop {
            let id = format!("s{n}");
            if !self.seeds.iter().any(|s| s.id == id) {
                return id;
            }
            n += 1;
        }
    }
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

/// Where a seed's artifacts live. An adopted single-track project keeps
/// its seed at the project root, which is what an empty `dir` means.
pub fn seed_dir(data_dir: &Path, project_id: &str, seed: &Seed) -> PathBuf {
    let root = project_dir(data_dir, project_id);
    if seed.dir.is_empty() {
        root
    } else {
        root.join(&seed.dir)
    }
}

/// The `dir` a newly minted seed gets.
pub fn seed_dir_name(seed_id: &str) -> String {
    format!("{SEEDS_DIR_NAME}/{seed_id}")
}

pub fn seed_meta_path(data_dir: &Path, project_id: &str, seed: &Seed) -> PathBuf {
    seed_dir(data_dir, project_id, seed).join(META_NAME)
}

pub fn seed_warped_path(data_dir: &Path, project_id: &str, seed: &Seed) -> PathBuf {
    seed_dir(data_dir, project_id, seed).join(WARPED_NAME)
}

/// Stems pulled through a seed's own warp map, cached per seed.
pub fn seed_stems_dir(data_dir: &Path, project_id: &str, seed: &Seed) -> PathBuf {
    seed_dir(data_dir, project_id, seed).join(STEMS_DIR_NAME)
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

/// Write one seed's artifacts and the project envelope. The caller has
/// already put the seed in `project.seeds`; this files what it points at.
pub fn save_seed(
    data_dir: &Path,
    project: &Project,
    seed: &Seed,
    record: &BeatifyRecord,
    warped: &AudioData,
) -> Result<PathBuf> {
    let dir = save_seed_render(data_dir, &project.id, seed, record, warped)?;
    save_project(data_dir, project)?;
    // MOD-A29: convenience copy, never load-bearing.
    let _ = write_json(&sidecar_path(Path::new(&record.source)), record);
    Ok(dir)
}

/// Replace a seed's render and record in place — what a tempo change
/// writes, since nothing about the seed list changes with it.
pub fn save_seed_render(
    data_dir: &Path,
    project_id: &str,
    seed: &Seed,
    record: &BeatifyRecord,
    warped: &AudioData,
) -> Result<PathBuf> {
    let dir = seed_dir(data_dir, project_id, seed);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let wav = dir.join(WARPED_NAME);
    std::fs::write(&wav, crate::clip::wav16_bytes(warped))
        .with_context(|| format!("writing {}", wav.display()))?;
    write_json(&dir.join(META_NAME), record)?;
    // Stems were pulled through the OLD map onto the OLD grid. They are a
    // cache, so dropping them is enough: they re-render on demand.
    let stems = dir.join(STEMS_DIR_NAME);
    if stems.is_dir() {
        let _ = std::fs::remove_dir_all(&stems);
    }
    Ok(dir)
}

/// Update the envelope alone — a rename, a tempo, a touch of `updated`.
///
/// What is WRITTEN is always the current layout, whatever generation the
/// value was read from: an adopted project that is edited stops needing
/// to be adopted, and its seed keeps pointing at the files where they
/// already are.
pub fn save_project(data_dir: &Path, project: &Project) -> Result<()> {
    let dir = project_dir(data_dir, &project.id);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let current = Project {
        version: Project::VERSION,
        ..project.clone()
    };
    write_json(&dir.join(PROJECT_NAME), &current)
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

/// Load one seed's record.
pub fn load_seed(data_dir: &Path, project_id: &str, seed: &Seed) -> Result<Option<BeatifyRecord>> {
    read_json(&seed_meta_path(data_dir, project_id, seed))
}

/// Load the record at a project's ROOT: the single-track layout, and the
/// only thing a directory that was never given an envelope has.
pub fn load(data_dir: &Path, project_id: &str) -> Result<Option<BeatifyRecord>> {
    read_json(&meta_path(data_dir, project_id))
}

/// Load a project's envelope, adopting whatever older layout it turns out
/// to be written in.
pub fn project(data_dir: &Path, project_id: &str) -> Result<Option<Project>> {
    if let Some(found) = read_json::<Project>(&project_path(data_dir, project_id))? {
        // A seed list is a seed list whatever version stamped it: only an
        // envelope that has never had one needs adopting.
        if found.version >= Project::VERSION || !found.seeds.is_empty() {
            return Ok(Some(found));
        }
        // A pre-seeds envelope: everything it says is still true, it
        // simply never listed the one seed it has.
        let Some(record) = load(data_dir, project_id)? else {
            return Ok(Some(found));
        };
        return Ok(Some(adopt_seed(found, &record)));
    }
    let Some(record) = load(data_dir, project_id)? else {
        return Ok(None);
    };
    Ok(Some(adopt(data_dir, project_id, &record)))
}

/// The one seed a single-track project always had: its artifacts are at
/// the project root, and the project's tempo is the tempo it was rendered
/// at. Read-only — nothing is written back, so an old project that is
/// merely LOOKED at keeps its shape on disk.
fn adopt_seed(project: Project, record: &BeatifyRecord) -> Project {
    let seed = Seed {
        id: "s1".into(),
        name: project.name.clone(),
        track_id: project.legacy_track_id,
        source_hash: record.source_hash.clone(),
        dir: String::new(),
        source_bpm: record.grid.bpm,
        speed: 1.0,
    };
    Project {
        bpm: Some(record.grid.bpm),
        seeds: vec![seed],
        ..project
    }
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
    let project = Project {
        id: project_id.to_string(),
        name,
        bpm: None,
        seeds: Vec::new(),
        updated,
        version: 0,
        legacy_track_id: 0,
    };
    adopt_seed(project, record)
}

/// Every project in the store, newest first. Directories with neither an
/// envelope nor a record are not projects and are ignored.
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

/// Drop ONE seed's artifacts. The project keeps everything else it has,
/// including clips that referred to the seed — those are placements, and
/// what they have lost is audio, not their arithmetic.
pub fn remove_seed(data_dir: &Path, project_id: &str, seed: &Seed) -> Result<()> {
    // The root IS the project for an adopted seed, and deleting it there
    // would take the project with it, so only its two files go.
    if seed.dir.is_empty() {
        for name in [META_NAME, WARPED_NAME] {
            let path = project_dir(data_dir, project_id).join(name);
            if path.exists() {
                std::fs::remove_file(&path)
                    .with_context(|| format!("removing {}", path.display()))?;
            }
        }
        return Ok(());
    }
    let dir = seed_dir(data_dir, project_id, seed);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).with_context(|| format!("removing {}", dir.display()))?;
    }
    Ok(())
}
