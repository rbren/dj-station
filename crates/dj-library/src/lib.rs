//! dj-station sound library (Milestone M1, PRD §8).
//!
//! - SQLite track database: file paths, content hashes, DJ metadata
//!   placeholders, tags, crates/playlists, license info (§8.1).
//! - Programmatic import (content-hashed, symphonia-probed metadata) and
//!   watch-folder auto-import for new audio files.
//! - Acquisition provider framework (§8.3): iTunes Search (deep link),
//!   Freesound + Jamendo (download, keys from env), Internet Archive
//!   (download, keyless). Unified fan-out search; per-track license storage.

pub mod db;
pub mod import;
pub mod providers;
pub mod watch;

pub use db::{Library, Track};
pub use import::{ImportOptions, ImportOutcome, AUDIO_EXTENSIONS};
pub use providers::{
    Acquire, AcquireKind, AcquisitionHub, AcquisitionProvider, FilterOption, FilterSpec,
    ProviderInfo, Query, TrackResult,
};
pub use watch::{start_watcher, WatchHandle};

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Per-track license info (PRD §8.3): stored in the library, shown in the
/// browser. `kind` is a coarse machine-readable class ("cc-by", "cc-by-sa",
/// "cc-by-nc", "cc0", "public-domain", "commercial", "unknown", ...).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LicenseInfo {
    pub kind: String,
    pub name: String,
    pub url: String,
    pub attribution: String,
}

impl Default for LicenseInfo {
    fn default() -> Self {
        LicenseInfo {
            kind: "unknown".into(),
            name: String::new(),
            url: String::new(),
            attribution: String::new(),
        }
    }
}

impl LicenseInfo {
    pub fn commercial() -> Self {
        LicenseInfo {
            kind: "commercial".into(),
            name: "All rights reserved (commercial)".into(),
            url: String::new(),
            attribution: String::new(),
        }
    }

    /// Classify a Creative Commons / public-domain license URL (as returned
    /// by Freesound, Jamendo, and the Internet Archive).
    pub fn from_cc_url(url: &str, attribution: &str) -> Self {
        let lower = url.to_lowercase();
        let (kind, name) = if lower.contains("publicdomain/zero") || lower.contains("/zero/") {
            ("cc0", "CC0 1.0 (public domain dedication)")
        } else if lower.contains("publicdomain/mark") {
            ("public-domain", "Public Domain Mark")
        } else if lower.contains("licenses/by-nc-sa") {
            ("cc-by-nc-sa", "CC BY-NC-SA")
        } else if lower.contains("licenses/by-nc-nd") {
            ("cc-by-nc-nd", "CC BY-NC-ND")
        } else if lower.contains("licenses/by-nc") {
            ("cc-by-nc", "CC BY-NC")
        } else if lower.contains("licenses/by-sa") {
            ("cc-by-sa", "CC BY-SA")
        } else if lower.contains("licenses/by-nd") {
            ("cc-by-nd", "CC BY-ND")
        } else if lower.contains("licenses/by") || lower.contains("sampling+") {
            ("cc-by", "CC BY")
        } else if lower.is_empty() {
            ("unknown", "")
        } else {
            ("other", "See license URL")
        };
        LicenseInfo {
            kind: kind.into(),
            name: name.into(),
            url: url.into(),
            attribution: attribution.into(),
        }
    }
}

/// The single per-user data directory (PRD §3). Override with
/// `DJ_STATION_DATA`; defaults to the platform data dir + `dj-station`.
pub fn default_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("DJ_STATION_DATA") {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("dj-station")
}
