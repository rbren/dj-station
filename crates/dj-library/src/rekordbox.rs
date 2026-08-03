//! rekordbox XML import (PRD §8.1, M4).
//!
//! Parses a rekordbox `DJ_PLAYLISTS` XML export and imports its collection
//! into the library DB: track metadata (title/artist/album/BPM/key),
//! beatgrids (`TEMPO`), hot cues and memory cues (`POSITION_MARK Type=0`)
//! and loops (`POSITION_MARK Type=4`).
//!
//! Pragmatics:
//! - Files referenced by the export usually live on another machine; when
//!   the audio file exists locally the normal content-hashed import path is
//!   used (deduplicated), otherwise the track row is created from the XML
//!   metadata alone with a location-derived placeholder hash.
//! - Hot cues map to library cue slots 0..=7 by their `Num`; memory cues
//!   (`Num="-1"`) are ignored (the library has no memory-cue concept).
//! - The first `TEMPO` entry becomes the beatgrid (bpm + anchor); later
//!   tempo changes are ignored (the deck beatgrid model is single-tempo).

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};

use crate::db::{Library, Track};
use crate::import::ImportOptions;
use crate::ImportOutcome;

/// One `<TRACK>` from the export, in library units.
#[derive(Debug, Clone, PartialEq)]
pub struct RekordboxTrack {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Decoded local file path from `Location`.
    pub location: PathBuf,
    pub format: String,
    pub duration_secs: Option<f64>,
    pub sample_rate: Option<i64>,
    pub bpm: Option<f64>,
    /// `Tonality` attribute as-is (e.g. "8A", "Am").
    pub key: Option<String>,
    /// First TEMPO entry: (bpm, anchor_secs).
    pub beatgrid: Option<(f64, f64)>,
    /// Hot cues: (slot 0..=7, position_secs).
    pub cues: Vec<(u8, f64)>,
    /// Loops: (name, start_secs, end_secs).
    pub loops: Vec<(String, f64, f64)>,
}

/// Result of importing an export file.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct RekordboxReport {
    /// Track ids created or updated, in collection order.
    pub imported: Vec<i64>,
    /// Locations skipped because the track was already in the library.
    pub duplicates: Vec<PathBuf>,
}

/// Decode a rekordbox `Location` URL (`file://localhost/Users/x/a%20b.mp3`)
/// to a filesystem path.
fn decode_location(loc: &str) -> Result<PathBuf> {
    let rest = loc
        .strip_prefix("file://localhost")
        .or_else(|| loc.strip_prefix("file://"))
        .ok_or_else(|| anyhow!("unsupported Location {loc:?}"))?;
    // Percent-decode (UTF-8).
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])?;
            out.push(
                u8::from_str_radix(hex, 16).with_context(|| format!("bad escape in {loc:?}"))?,
            );
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Ok(PathBuf::from(String::from_utf8(out)?))
}

/// Parse a rekordbox XML export into track records.
pub fn parse_rekordbox_xml(xml: &str) -> Result<Vec<RekordboxTrack>> {
    let doc = roxmltree::Document::parse(xml).context("parsing rekordbox XML")?;
    let root = doc.root_element();
    anyhow::ensure!(
        root.has_tag_name("DJ_PLAYLISTS"),
        "not a rekordbox export (root element {:?})",
        root.tag_name().name()
    );
    let collection = root
        .children()
        .find(|n| n.has_tag_name("COLLECTION"))
        .ok_or_else(|| anyhow!("no COLLECTION element"))?;

    let mut tracks = Vec::new();
    for t in collection.children().filter(|n| n.has_tag_name("TRACK")) {
        let attr = |name: &str| t.attribute(name).unwrap_or("").to_string();
        let location = decode_location(
            t.attribute("Location")
                .ok_or_else(|| anyhow!("TRACK without Location"))?,
        )?;
        let format = location
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let bpm = t
            .attribute("AverageBpm")
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|b| *b > 0.0);
        let key = t
            .attribute("Tonality")
            .map(str::to_string)
            .filter(|k| !k.is_empty());
        let duration_secs = t.attribute("TotalTime").and_then(|v| v.parse::<f64>().ok());
        let sample_rate = t
            .attribute("SampleRate")
            .and_then(|v| v.parse::<f64>().ok())
            .map(|r| r as i64);

        let beatgrid = t
            .children()
            .find(|n| n.has_tag_name("TEMPO"))
            .and_then(|tempo| {
                let bpm = tempo.attribute("Bpm")?.parse::<f64>().ok()?;
                let anchor = tempo
                    .attribute("Inizio")
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(0.0);
                (bpm > 0.0).then_some((bpm, anchor))
            });

        let mut cues = Vec::new();
        let mut loops = Vec::new();
        for m in t.children().filter(|n| n.has_tag_name("POSITION_MARK")) {
            let mark_type = m.attribute("Type").unwrap_or("0");
            let start = m
                .attribute("Start")
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(0.0);
            match mark_type {
                "0" => {
                    // Cue: hot cues carry Num 0..=7; memory cues are -1.
                    if let Some(num) = m
                        .attribute("Num")
                        .and_then(|v| v.parse::<i32>().ok())
                        .filter(|n| (0..=7).contains(n))
                    {
                        cues.push((num as u8, start));
                    }
                }
                "4" => {
                    if let Some(end) = m.attribute("End").and_then(|v| v.parse::<f64>().ok()) {
                        if end > start {
                            loops.push((m.attribute("Name").unwrap_or("").to_string(), start, end));
                        }
                    }
                }
                _ => {}
            }
        }

        tracks.push(RekordboxTrack {
            title: attr("Name"),
            artist: attr("Artist"),
            album: attr("Album"),
            location,
            format,
            duration_secs,
            sample_rate,
            bpm,
            key,
            beatgrid,
            cues,
            loops,
        });
    }
    Ok(tracks)
}

impl Library {
    /// Import a rekordbox XML export: tracks, beatgrids, cues and loops
    /// land in the library DB. Tracks already present (by path or content
    /// hash) are skipped.
    pub fn import_rekordbox_xml(&self, xml_path: &Path) -> Result<RekordboxReport> {
        let xml = std::fs::read_to_string(xml_path)
            .with_context(|| format!("reading {}", xml_path.display()))?;
        let tracks = parse_rekordbox_xml(&xml)?;
        let mut report = RekordboxReport::default();
        for rb in &tracks {
            if self.track_by_path(&rb.location)?.is_some() {
                report.duplicates.push(rb.location.clone());
                continue;
            }
            let track = self.insert_rekordbox_track(rb)?;
            let Some(track) = track else {
                report.duplicates.push(rb.location.clone());
                continue;
            };
            if let Some(bpm) = rb.bpm {
                self.set_track_analysis(track.id, bpm, rb.key.as_deref().unwrap_or(""))?;
            }
            if let Some((bpm, anchor)) = rb.beatgrid {
                self.set_track_beatgrid(track.id, bpm, anchor)?;
            }
            for &(slot, pos) in &rb.cues {
                self.set_track_cue(track.id, slot, pos, "")?;
            }
            for (name, start, end) in &rb.loops {
                self.add_track_loop(track.id, name, *start, *end)?;
            }
            report.imported.push(track.id);
        }
        Ok(report)
    }

    /// Track row for one rekordbox entry. Prefers the real (content-hashed)
    /// import when the file exists locally; falls back to XML metadata with
    /// a location-derived hash when it does not. Returns `None` when the
    /// content-hash path reports a duplicate.
    fn insert_rekordbox_track(&self, rb: &RekordboxTrack) -> Result<Option<Track>> {
        if rb.location.is_file() {
            let opts = ImportOptions {
                title: Some(rb.title.clone()).filter(|s| !s.is_empty()),
                artist: Some(rb.artist.clone()).filter(|s| !s.is_empty()),
                album: Some(rb.album.clone()).filter(|s| !s.is_empty()),
                source: "rekordbox".into(),
                ..ImportOptions::default()
            };
            return match self.import_file(&rb.location, opts)? {
                ImportOutcome::Added(t) => Ok(Some(t)),
                ImportOutcome::Duplicate(_) => Ok(None),
            };
        }
        let placeholder_hash = format!("rekordbox:{}", rb.location.display());
        if self.track_by_hash(&placeholder_hash)?.is_some() {
            return Ok(None);
        }
        let title = if rb.title.is_empty() {
            rb.location
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "untitled".into())
        } else {
            rb.title.clone()
        };
        let track = self.insert_track(
            &title,
            &rb.artist,
            &rb.album,
            &rb.location,
            &placeholder_hash,
            &rb.format,
            rb.duration_secs,
            rb.sample_rate,
            None,
            "rekordbox",
            "",
            &crate::LicenseInfo::default(),
        )?;
        Ok(Some(track))
    }
}
