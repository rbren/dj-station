//! dj-station sound library (Milestone M1, PRD §8).
//!
//! - SQLite track database: file paths, content hashes, DJ metadata
//!   placeholders, tags, crates/playlists, license info (§8.1).
//! - Programmatic import (content-hashed, symphonia-probed metadata, the
//!   artist credit taken back out of the title) and watch-folder
//!   auto-import for new audio files.
//! - Acquisition provider framework (§8.3): iTunes Search (deep link),
//!   Freesound + Jamendo (download, keys from env), Internet Archive
//!   (download, keyless), YouTube (download via the external `yt-dlp`
//!   binary, keyless). Unified fan-out search; per-track license storage.
//! - Background download jobs so slow acquisitions report progress off
//!   the caller's thread.

pub mod db;
pub mod downloads;
pub mod import;
pub mod naming;
pub mod paths;
pub mod providers;
pub mod rekordbox;
pub mod watch;

pub use db::{Beatgrid, CuePoint, DeletedTrack, Library, MacroRecord, SavedLoop, Track};
pub use downloads::{DownloadJob, DownloadManager, DownloadState};
pub use import::{ImportOptions, ImportOutcome, AUDIO_EXTENSIONS};
pub use naming::{strip_artist, strip_noise, tidy_title};
pub use paths::{default_data_dir, init_data_dir, legacy_data_dir, migrate_legacy_data, Migration};
pub use providers::{
    Acquire, AcquireKind, AcquisitionHub, AcquisitionProvider, FetchProgress, FilterOption,
    FilterSpec, ProviderInfo, Query, TrackResult,
};
pub use rekordbox::{parse_rekordbox_xml, RekordboxReport, RekordboxTrack};
pub use watch::{start_watcher, WatchHandle};

use serde::{Deserialize, Serialize};

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
