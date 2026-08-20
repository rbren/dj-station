//! Where dj-station keeps its state (PRD §3).
//!
//! Everything persistent — the library DB, `patches/`, `autosave/`,
//! `downloads/`, the stem cache — lives under ONE directory: `custom/` in
//! the repo checkout the app was launched from (the directory holding
//! `run.sh`), so saves travel with the repo. `DJ_STATION_DATA_DIR`
//! overrides the location outright (`DJ_STATION_DATA` is honored as the
//! legacy spelling); when no checkout can be found (a packaged bundle),
//! the fallback is `custom/` under the current directory.
//!
//! The first run in the new location COPIES whatever the pre-`custom/`
//! platform data dir holds (never moves, never deletes) and drops a
//! [`MIGRATION_MARKER`] file. The marker — plus a presence check on the
//! target — makes the migration idempotent: later launches never re-copy
//! over state that has moved on.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Preferred override for the data directory.
pub const DATA_DIR_ENV: &str = "DJ_STATION_DATA_DIR";
/// Legacy spelling of [`DATA_DIR_ENV`], still honored.
pub const LEGACY_DATA_DIR_ENV: &str = "DJ_STATION_DATA";
/// Directory name inside the repo checkout.
pub const DATA_DIR_NAME: &str = "custom";
/// Written into the data dir once the legacy-data check has run.
pub const MIGRATION_MARKER: &str = ".migrated";

/// The single data directory: env override, else `<repo>/custom`, else
/// `custom/` under the current directory.
pub fn default_data_dir() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    resolve_data_dir(env_override().as_deref(), repo_root().as_deref(), &cwd)
}

/// Pure resolution law behind [`default_data_dir`].
pub fn resolve_data_dir(env_dir: Option<&str>, repo_root: Option<&Path>, cwd: &Path) -> PathBuf {
    if let Some(dir) = env_dir.map(str::trim).filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    repo_root.unwrap_or(cwd).join(DATA_DIR_NAME)
}

/// Where state lived before `custom/`: the platform data dir.
pub fn legacy_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("dj-station")
}

fn env_override() -> Option<String> {
    [DATA_DIR_ENV, LEGACY_DATA_DIR_ENV]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|v| !v.trim().is_empty()))
}

/// The repo checkout the app runs from: searched upward from the current
/// directory, then from the executable's location (`cargo run` and
/// `./run.sh` differ in which one hits).
pub fn repo_root() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok();
    let exe = std::env::current_exe().ok();
    cwd.as_deref()
        .and_then(find_repo_root)
        .or_else(|| exe.as_deref().and_then(find_repo_root))
}

/// First ancestor of `start` (inclusive) that is a git checkout holding
/// `run.sh`.
pub fn find_repo_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|dir| dir.join("run.sh").is_file() && dir.join(".git").exists())
        .map(Path::to_path_buf)
}

/// What [`migrate_legacy_data`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Migration {
    /// The marker was already there: the check ran on an earlier launch.
    AlreadyMigrated,
    /// No legacy directory to copy from (or it *is* the data dir).
    NothingToMigrate,
    /// The data dir already holds state; left untouched.
    TargetNotEmpty,
    /// Copied `files` files out of the legacy directory.
    Copied { files: usize },
}

/// Create the data dir, copying legacy state into it on the first run.
/// Returns the directory so callers can hand it straight to
/// [`crate::Library::open`].
pub fn init_data_dir() -> Result<PathBuf> {
    let dir = default_data_dir();
    let outcome = migrate_legacy_data(&legacy_data_dir(), &dir)?;
    if let Migration::Copied { files } = outcome {
        eprintln!(
            "[dj-data] copied {files} file(s) from {} into {}",
            legacy_data_dir().display(),
            dir.display()
        );
    }
    Ok(dir)
}

/// Copy `legacy` into `data_dir` once, then never again.
///
/// Idempotent by marker file and by presence check, and non-destructive in
/// both directions: the legacy tree is only read, and existing files in
/// `data_dir` are never overwritten.
pub fn migrate_legacy_data(legacy: &Path, data_dir: &Path) -> Result<Migration> {
    std::fs::create_dir_all(data_dir)
        .with_context(|| format!("creating data dir {}", data_dir.display()))?;
    if data_dir.join(MIGRATION_MARKER).exists() {
        return Ok(Migration::AlreadyMigrated);
    }
    let same = same_dir(legacy, data_dir);
    let outcome = if same || !legacy.is_dir() {
        Migration::NothingToMigrate
    } else if has_state(data_dir)? {
        Migration::TargetNotEmpty
    } else {
        Migration::Copied {
            files: copy_tree(legacy, data_dir)?,
        }
    };
    write_marker(data_dir, legacy, &outcome)?;
    Ok(outcome)
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(b)
}

/// Does the data dir hold anything beyond bookkeeping (`.gitignore`, the
/// marker) that a copy could clobber?
fn has_state(dir: &Path) -> Result<bool> {
    for entry in std::fs::read_dir(dir)? {
        let name = entry?.file_name();
        if name != MIGRATION_MARKER && name != ".gitignore" {
            return Ok(true);
        }
    }
    Ok(false)
}

fn write_marker(data_dir: &Path, legacy: &Path, outcome: &Migration) -> Result<()> {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let note = format!(
        "dj-station data migration\nsource: {}\noutcome: {outcome:?}\nunix_time: {secs}\n",
        legacy.display()
    );
    std::fs::write(data_dir.join(MIGRATION_MARKER), note)
        .with_context(|| format!("writing {} marker", data_dir.display()))
}

/// Recursive copy that skips destinations that already exist. Returns the
/// number of files written.
fn copy_tree(from: &Path, to: &Path) -> Result<usize> {
    std::fs::create_dir_all(to).with_context(|| format!("creating {}", to.display()))?;
    let mut copied = 0;
    for entry in std::fs::read_dir(from).with_context(|| format!("reading {}", from.display()))? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copied += copy_tree(&src, &dst)?;
        } else if !dst.exists() {
            std::fs::copy(&src, &dst)
                .with_context(|| format!("copying {} to {}", src.display(), dst.display()))?;
            copied += 1;
        }
    }
    Ok(copied)
}
