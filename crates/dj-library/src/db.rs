//! SQLite library database (PRD §8.1): tracks, file paths, analysis
//! placeholders, DJ metadata, tags, crates/playlists, license info.

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::LicenseInfo;

pub const DB_FILE: &str = "library.sqlite";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS tracks (
    id              INTEGER PRIMARY KEY,
    title           TEXT NOT NULL,
    artist          TEXT NOT NULL DEFAULT '',
    album           TEXT NOT NULL DEFAULT '',
    file_path       TEXT NOT NULL,
    content_hash    TEXT NOT NULL UNIQUE,
    format          TEXT NOT NULL DEFAULT '',
    duration_secs   REAL,
    sample_rate     INTEGER,
    channels        INTEGER,
    source          TEXT NOT NULL DEFAULT 'local',
    source_ref      TEXT NOT NULL DEFAULT '',
    license_kind    TEXT NOT NULL DEFAULT 'unknown',
    license_name    TEXT NOT NULL DEFAULT '',
    license_url     TEXT NOT NULL DEFAULT '',
    attribution     TEXT NOT NULL DEFAULT '',
    analysis_status TEXT NOT NULL DEFAULT 'queued',
    bpm             REAL,
    musical_key     TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_path ON tracks(file_path);

CREATE TABLE IF NOT EXISTS tags (
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    tag      TEXT NOT NULL,
    UNIQUE(track_id, tag)
);

CREATE TABLE IF NOT EXISTS crates (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS crate_tracks (
    crate_id INTEGER NOT NULL REFERENCES crates(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    UNIQUE(crate_id, track_id)
);

CREATE TABLE IF NOT EXISTS watch_folders (
    id   INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS track_cues (
    track_id      INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    slot          INTEGER NOT NULL,
    position_secs REAL NOT NULL,
    label         TEXT NOT NULL DEFAULT '',
    UNIQUE(track_id, slot)
);

CREATE TABLE IF NOT EXISTS track_loops (
    id         INTEGER PRIMARY KEY,
    track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    name       TEXT NOT NULL DEFAULT '',
    start_secs REAL NOT NULL,
    end_secs   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS track_beatgrids (
    track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    bpm         REAL NOT NULL,
    anchor_secs REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS macros (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    version    INTEGER NOT NULL,
    definition TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
";

/// A library track row. `bpm`/`musical_key`/`analysis_status` are the
/// analysis placeholders filled by the M3 pipeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub id: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub file_path: String,
    pub content_hash: String,
    pub format: String,
    pub duration_secs: Option<f64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub source: String,
    pub source_ref: String,
    pub license: LicenseInfo,
    pub analysis_status: String,
    pub bpm: Option<f64>,
    pub musical_key: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn track_from_row(row: &Row) -> rusqlite::Result<Track> {
    Ok(Track {
        id: row.get("id")?,
        title: row.get("title")?,
        artist: row.get("artist")?,
        album: row.get("album")?,
        file_path: row.get("file_path")?,
        content_hash: row.get("content_hash")?,
        format: row.get("format")?,
        duration_secs: row.get("duration_secs")?,
        sample_rate: row.get("sample_rate")?,
        channels: row.get("channels")?,
        source: row.get("source")?,
        source_ref: row.get("source_ref")?,
        license: LicenseInfo {
            kind: row.get("license_kind")?,
            name: row.get("license_name")?,
            url: row.get("license_url")?,
            attribution: row.get("attribution")?,
        },
        analysis_status: row.get("analysis_status")?,
        bpm: row.get("bpm")?,
        musical_key: row.get("musical_key")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const TRACK_COLS: &str = "id, title, artist, album, file_path, content_hash, format, \
    duration_secs, sample_rate, channels, source, source_ref, license_kind, license_name, \
    license_url, attribution, analysis_status, bpm, musical_key, created_at, updated_at";

/// The library: one SQLite DB under the user data directory.
///
/// Thread-safe (internal mutex) so it can be shared behind an `Arc` between
/// the watch-folder thread, provider downloads, and the UI/IPC layer.
pub struct Library {
    conn: Mutex<Connection>,
    data_dir: PathBuf,
}

impl Library {
    /// Open (creating if needed) the library at `data_dir/library.sqlite`.
    pub fn open(data_dir: &Path) -> Result<Library> {
        std::fs::create_dir_all(data_dir)
            .with_context(|| format!("creating data dir {}", data_dir.display()))?;
        let conn = Connection::open(data_dir.join(DB_FILE))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Library {
            conn: Mutex::new(conn),
            data_dir: data_dir.to_path_buf(),
        })
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Where provider downloads land (created on demand).
    pub fn downloads_dir(&self) -> PathBuf {
        self.data_dir.join("downloads")
    }

    pub(crate) fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.conn.lock().map_err(|_| anyhow!("library poisoned"))?;
        f(&conn)
    }

    // ------------------------------------------------------------------
    // Tracks
    // ------------------------------------------------------------------

    pub fn track(&self, id: i64) -> Result<Track> {
        self.with_conn(|c| {
            c.query_row(
                &format!("SELECT {TRACK_COLS} FROM tracks WHERE id = ?1"),
                params![id],
                track_from_row,
            )
            .with_context(|| format!("no track {id}"))
        })
    }

    pub fn track_by_hash(&self, content_hash: &str) -> Result<Option<Track>> {
        self.with_conn(|c| {
            Ok(c.query_row(
                &format!("SELECT {TRACK_COLS} FROM tracks WHERE content_hash = ?1"),
                params![content_hash],
                track_from_row,
            )
            .optional()?)
        })
    }

    pub fn track_by_path(&self, path: &Path) -> Result<Option<Track>> {
        self.with_conn(|c| {
            Ok(c.query_row(
                &format!("SELECT {TRACK_COLS} FROM tracks WHERE file_path = ?1"),
                params![path.to_string_lossy()],
                track_from_row,
            )
            .optional()?)
        })
    }

    pub fn tracks(&self) -> Result<Vec<Track>> {
        self.with_conn(|c| {
            let mut stmt =
                c.prepare(&format!("SELECT {TRACK_COLS} FROM tracks ORDER BY id DESC"))?;
            let rows = stmt.query_map([], track_from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Case-insensitive substring search over title/artist/album/tags.
    pub fn search(&self, text: &str) -> Result<Vec<Track>> {
        let like = format!("%{}%", text.replace('%', "\\%").replace('_', "\\_"));
        self.with_conn(|c| {
            let mut stmt = c.prepare(&format!(
                "SELECT DISTINCT {TRACK_COLS} FROM tracks \
                 LEFT JOIN tags ON tags.track_id = tracks.id \
                 WHERE title LIKE ?1 ESCAPE '\\' OR artist LIKE ?1 ESCAPE '\\' \
                    OR album LIKE ?1 ESCAPE '\\' OR tag LIKE ?1 ESCAPE '\\' \
                 ORDER BY id DESC"
            ))?;
            let rows = stmt.query_map(params![like], track_from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn insert_track(
        &self,
        title: &str,
        artist: &str,
        album: &str,
        file_path: &Path,
        content_hash: &str,
        format: &str,
        duration_secs: Option<f64>,
        sample_rate: Option<i64>,
        channels: Option<i64>,
        source: &str,
        source_ref: &str,
        license: &LicenseInfo,
    ) -> Result<Track> {
        let id = self.with_conn(|c| {
            c.execute(
                "INSERT INTO tracks (title, artist, album, file_path, content_hash, format, \
                 duration_secs, sample_rate, channels, source, source_ref, license_kind, \
                 license_name, license_url, attribution, analysis_status, created_at, updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'queued', \
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![
                    title,
                    artist,
                    album,
                    file_path.to_string_lossy(),
                    content_hash,
                    format,
                    duration_secs,
                    sample_rate,
                    channels,
                    source,
                    source_ref,
                    license.kind,
                    license.name,
                    license.url,
                    license.attribution,
                ],
            )?;
            Ok(c.last_insert_rowid())
        })?;
        self.track(id)
    }

    /// Write BPM + musical key from the analysis pipeline (M3).
    pub fn set_track_analysis(&self, track_id: i64, bpm: f64, musical_key: &str) -> Result<()> {
        anyhow::ensure!(bpm > 0.0, "bpm must be positive");
        self.with_conn(|c| {
            c.execute(
                "UPDATE tracks SET bpm = ?2, musical_key = ?3, \
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
                params![track_id, bpm, musical_key],
            )?;
            Ok(())
        })
    }

    /// Re-queue a track for analysis (explicit re-run from the UI).
    pub fn requeue_analysis(&self, track_id: i64) -> Result<()> {
        self.set_analysis_status(track_id, "queued")
    }

    pub fn set_analysis_status(&self, track_id: i64, status: &str) -> Result<()> {
        self.with_conn(|c| {
            c.execute(
                "UPDATE tracks SET analysis_status = ?2, \
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
                params![track_id, status],
            )?;
            Ok(())
        })
    }

    /// Tracks queued for (future, M3) analysis, oldest first.
    pub fn analysis_queue(&self) -> Result<Vec<Track>> {
        self.with_conn(|c| {
            let mut stmt = c.prepare(&format!(
                "SELECT {TRACK_COLS} FROM tracks WHERE analysis_status = 'queued' ORDER BY id"
            ))?;
            let rows = stmt.query_map([], track_from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    // ------------------------------------------------------------------
    // Tags
    // ------------------------------------------------------------------

    pub fn add_tag(&self, track_id: i64, tag: &str) -> Result<()> {
        self.with_conn(|c| {
            c.execute(
                "INSERT OR IGNORE INTO tags (track_id, tag) VALUES (?1, ?2)",
                params![track_id, tag],
            )?;
            Ok(())
        })
    }

    pub fn tags(&self, track_id: i64) -> Result<Vec<String>> {
        self.with_conn(|c| {
            let mut stmt = c.prepare("SELECT tag FROM tags WHERE track_id = ?1 ORDER BY tag")?;
            let rows = stmt.query_map(params![track_id], |r| r.get(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    // ------------------------------------------------------------------
    // Crates (playlists)
    // ------------------------------------------------------------------

    pub fn create_crate(&self, name: &str) -> Result<i64> {
        self.with_conn(|c| {
            c.execute(
                "INSERT OR IGNORE INTO crates (name) VALUES (?1)",
                params![name],
            )?;
            Ok(c.query_row(
                "SELECT id FROM crates WHERE name = ?1",
                params![name],
                |r| r.get(0),
            )?)
        })
    }

    pub fn crates(&self) -> Result<Vec<(i64, String)>> {
        self.with_conn(|c| {
            let mut stmt = c.prepare("SELECT id, name FROM crates ORDER BY name")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    pub fn add_to_crate(&self, crate_id: i64, track_id: i64) -> Result<()> {
        self.with_conn(|c| {
            c.execute(
                "INSERT OR IGNORE INTO crate_tracks (crate_id, track_id, position) \
                 VALUES (?1, ?2, \
                 (SELECT COALESCE(MAX(position), -1) + 1 FROM crate_tracks WHERE crate_id = ?1))",
                params![crate_id, track_id],
            )?;
            Ok(())
        })
    }

    pub fn crate_tracks(&self, crate_id: i64) -> Result<Vec<Track>> {
        self.with_conn(|c| {
            let mut stmt = c.prepare(&format!(
                "SELECT {TRACK_COLS} FROM tracks \
                 JOIN crate_tracks ct ON ct.track_id = tracks.id \
                 WHERE ct.crate_id = ?1 ORDER BY ct.position"
            ))?;
            let rows = stmt.query_map(params![crate_id], track_from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    // ------------------------------------------------------------------
    // Watch folders
    // ------------------------------------------------------------------

    pub fn add_watch_folder(&self, path: &Path) -> Result<()> {
        self.with_conn(|c| {
            c.execute(
                "INSERT OR IGNORE INTO watch_folders (path) VALUES (?1)",
                params![path.to_string_lossy()],
            )?;
            Ok(())
        })
    }

    pub fn remove_watch_folder(&self, path: &Path) -> Result<()> {
        self.with_conn(|c| {
            c.execute(
                "DELETE FROM watch_folders WHERE path = ?1",
                params![path.to_string_lossy()],
            )?;
            Ok(())
        })
    }

    pub fn watch_folders(&self) -> Result<Vec<PathBuf>> {
        self.with_conn(|c| {
            let mut stmt = c.prepare("SELECT path FROM watch_folders ORDER BY id")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .map(PathBuf::from)
                .collect())
        })
    }

    // ------------------------------------------------------------------
    // DJ metadata (M2): hot cues, saved loops, beatgrids. Stored per track
    // so they survive across patches (PRD §7).
    // ------------------------------------------------------------------

    /// Set (or replace) a hot cue in `slot` (0..=7).
    pub fn set_track_cue(
        &self,
        track_id: i64,
        slot: u8,
        position_secs: f64,
        label: &str,
    ) -> Result<()> {
        anyhow::ensure!(slot < 8, "cue slot must be 0..=7, got {slot}");
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO track_cues (track_id, slot, position_secs, label) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(track_id, slot) DO UPDATE \
                 SET position_secs = ?3, label = ?4",
                params![track_id, slot, position_secs, label],
            )?;
            Ok(())
        })
    }

    pub fn clear_track_cue(&self, track_id: i64, slot: u8) -> Result<()> {
        self.with_conn(|c| {
            c.execute(
                "DELETE FROM track_cues WHERE track_id = ?1 AND slot = ?2",
                params![track_id, slot],
            )?;
            Ok(())
        })
    }

    pub fn track_cues(&self, track_id: i64) -> Result<Vec<CuePoint>> {
        self.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT slot, position_secs, label FROM track_cues \
                 WHERE track_id = ?1 ORDER BY slot",
            )?;
            let rows = stmt.query_map(params![track_id], |r| {
                Ok(CuePoint {
                    slot: r.get(0)?,
                    position_secs: r.get(1)?,
                    label: r.get(2)?,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Save a loop for a track; returns the loop id.
    pub fn add_track_loop(
        &self,
        track_id: i64,
        name: &str,
        start_secs: f64,
        end_secs: f64,
    ) -> Result<i64> {
        anyhow::ensure!(end_secs > start_secs, "loop end must be after start");
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO track_loops (track_id, name, start_secs, end_secs) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![track_id, name, start_secs, end_secs],
            )?;
            Ok(c.last_insert_rowid())
        })
    }

    pub fn update_track_loop(&self, loop_id: i64, start_secs: f64, end_secs: f64) -> Result<()> {
        anyhow::ensure!(end_secs > start_secs, "loop end must be after start");
        self.with_conn(|c| {
            c.execute(
                "UPDATE track_loops SET start_secs = ?2, end_secs = ?3 WHERE id = ?1",
                params![loop_id, start_secs, end_secs],
            )?;
            Ok(())
        })
    }

    pub fn delete_track_loop(&self, loop_id: i64) -> Result<()> {
        self.with_conn(|c| {
            c.execute("DELETE FROM track_loops WHERE id = ?1", params![loop_id])?;
            Ok(())
        })
    }

    pub fn track_loops(&self, track_id: i64) -> Result<Vec<SavedLoop>> {
        self.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id, name, start_secs, end_secs FROM track_loops \
                 WHERE track_id = ?1 ORDER BY start_secs, id",
            )?;
            let rows = stmt.query_map(params![track_id], |r| {
                Ok(SavedLoop {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    start_secs: r.get(2)?,
                    end_secs: r.get(3)?,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Set (or replace) the manual beatgrid for a track.
    pub fn set_track_beatgrid(&self, track_id: i64, bpm: f64, anchor_secs: f64) -> Result<()> {
        anyhow::ensure!(bpm > 0.0, "bpm must be positive");
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO track_beatgrids (track_id, bpm, anchor_secs) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(track_id) DO UPDATE SET bpm = ?2, anchor_secs = ?3",
                params![track_id, bpm, anchor_secs],
            )?;
            Ok(())
        })
    }

    pub fn track_beatgrid(&self, track_id: i64) -> Result<Option<Beatgrid>> {
        self.with_conn(|c| {
            Ok(c.query_row(
                "SELECT bpm, anchor_secs FROM track_beatgrids WHERE track_id = ?1",
                params![track_id],
                |r| {
                    Ok(Beatgrid {
                        bpm: r.get(0)?,
                        anchor_secs: r.get(1)?,
                    })
                },
            )
            .optional()?)
        })
    }

    // ------------------------------------------------------------------
    // Macro modules (M4, PRD §6): the library is the canonical store for
    // macro definitions — stable ID, version, and the definition itself
    // as engine-format JSON (the engine's `MacroDef`).
    // ------------------------------------------------------------------

    /// Insert or update a macro definition.
    pub fn save_macro(&self, record: &MacroRecord) -> Result<()> {
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO macros (id, name, version, definition, updated_at)
                 VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    version = excluded.version,
                    definition = excluded.definition,
                    updated_at = excluded.updated_at",
                params![record.id, record.name, record.version, record.definition],
            )?;
            Ok(())
        })
    }

    pub fn macro_by_id(&self, id: &str) -> Result<Option<MacroRecord>> {
        self.with_conn(|c| {
            Ok(c.query_row(
                "SELECT id, name, version, definition FROM macros WHERE id = ?1",
                params![id],
                macro_from_row,
            )
            .optional()?)
        })
    }

    /// All stored macros, sorted by id.
    pub fn macros(&self) -> Result<Vec<MacroRecord>> {
        self.with_conn(|c| {
            let mut stmt =
                c.prepare("SELECT id, name, version, definition FROM macros ORDER BY id")?;
            let rows = stmt.query_map([], macro_from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    pub fn delete_macro(&self, id: &str) -> Result<()> {
        self.with_conn(|c| {
            c.execute("DELETE FROM macros WHERE id = ?1", params![id])?;
            Ok(())
        })
    }
}

/// A stored macro module (PRD §6/§8.1). `definition` is the engine's
/// `MacroDef` serialized as JSON — the library treats it as opaque.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MacroRecord {
    pub id: String,
    pub name: String,
    pub version: i64,
    pub definition: String,
}

fn macro_from_row(row: &Row) -> rusqlite::Result<MacroRecord> {
    Ok(MacroRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        version: row.get(2)?,
        definition: row.get(3)?,
    })
}

/// A hot cue point (slot 0..=7) on a track.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CuePoint {
    pub slot: u8,
    pub position_secs: f64,
    pub label: String,
}

/// A saved loop region on a track.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedLoop {
    pub id: i64,
    pub name: String,
    pub start_secs: f64,
    pub end_secs: f64,
}

/// A manual beatgrid: constant tempo anchored at a downbeat.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Beatgrid {
    pub bpm: f64,
    pub anchor_secs: f64,
}
