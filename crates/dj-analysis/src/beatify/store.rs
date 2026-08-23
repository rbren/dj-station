//! The beatified-track store (PRD §3.11).
//!
//! Records are keyed by the CONTENT HASH of the source audio, not its path
//! (MOD-A28) — files get renamed and moved, hashes don't — and live under
//! the app's one data directory:
//!
//! ```text
//! <data_dir>/beatify/<sha256[:16]>/
//!     meta.json      ← the §5 payload
//!     warped.wav     ← constant-tempo render
//! ```
//!
//! A sidecar next to the source (`boys.beatify.json`, MOD-A29) is written
//! best-effort for portability; the hash-keyed store is authoritative and
//! the sidecar is re-derivable, so a read-only source directory is not an
//! error.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

use crate::beatify::BeatifyRecord;
use crate::decode::AudioData;

pub const BEATIFY_DIR_NAME: &str = "beatify";
pub const META_NAME: &str = "meta.json";
pub const WARPED_NAME: &str = "warped.wav";
/// Hash prefix length used for the directory name (MOD-A28).
pub const HASH_LEN: usize = 16;

pub fn beatify_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(BEATIFY_DIR_NAME)
}

pub fn short_hash(hash: &str) -> String {
    hash.chars().take(HASH_LEN).collect()
}

pub fn record_dir(data_dir: &Path, hash: &str) -> PathBuf {
    beatify_dir(data_dir).join(short_hash(hash))
}

pub fn meta_path(data_dir: &Path, hash: &str) -> PathBuf {
    record_dir(data_dir, hash).join(META_NAME)
}

pub fn warped_path(data_dir: &Path, hash: &str) -> PathBuf {
    record_dir(data_dir, hash).join(WARPED_NAME)
}

/// `boys.wav` → `boys.beatify.json`, next to the source.
pub fn sidecar_path(source: &Path) -> PathBuf {
    source.with_extension("beatify.json")
}

/// Write the two artifacts plus the sidecar. Returns the record directory.
pub fn save(
    data_dir: &Path,
    hash: &str,
    record: &BeatifyRecord,
    warped: &AudioData,
) -> Result<PathBuf> {
    let dir = record_dir(data_dir, hash);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let wav = dir.join(WARPED_NAME);
    std::fs::write(&wav, crate::clip::wav16_bytes(warped))
        .with_context(|| format!("writing {}", wav.display()))?;
    write_meta(&dir.join(META_NAME), record)?;
    // MOD-A29: convenience copy, never load-bearing.
    let _ = write_meta(&sidecar_path(Path::new(&record.source)), record);
    Ok(dir)
}

fn write_meta(path: &Path, record: &BeatifyRecord) -> Result<()> {
    let json = serde_json::to_string_pretty(record)?;
    std::fs::write(path, json).with_context(|| format!("writing {}", path.display()))
}

/// Load a record by source hash. `None` when the track was never
/// beatified (MOD-A31: that is what sends the user to the modal).
pub fn load(data_dir: &Path, hash: &str) -> Result<Option<BeatifyRecord>> {
    let path = meta_path(data_dir, hash);
    if !path.exists() {
        return Ok(None);
    }
    let text =
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let record: BeatifyRecord =
        serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
    Ok(Some(record))
}

/// Drop a record (both artifacts). Missing records are not an error.
pub fn remove(data_dir: &Path, hash: &str) -> Result<()> {
    let dir = record_dir(data_dir, hash);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).with_context(|| format!("removing {}", dir.display()))?;
    }
    Ok(())
}
