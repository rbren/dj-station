//! Programmatic import: content-hash, probe metadata, insert into the DB,
//! queue for (future) analysis. Used by the watch folder, provider
//! downloads, and (later) drag-and-drop.

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

use crate::db::{Library, Track};
use crate::LicenseInfo;

/// Audio file extensions auto-imported by the watch folder (PRD §8.1).
pub const AUDIO_EXTENSIONS: &[&str] = &["mp3", "m4a", "aac", "flac", "wav", "aiff", "aif"];

pub fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

#[derive(Debug, Clone, Default)]
pub struct ImportOptions {
    /// Where the file came from: "local", "watch", or a provider id.
    pub source: String,
    /// Provider-side track id / URL, if any.
    pub source_ref: String,
    pub license: LicenseInfo,
    /// Metadata overrides (else probed tags / filename).
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ImportOutcome {
    Added(Track),
    /// Identical content (by hash) already in the library.
    Duplicate(Track),
}

impl ImportOutcome {
    pub fn track(&self) -> &Track {
        match self {
            ImportOutcome::Added(t) | ImportOutcome::Duplicate(t) => t,
        }
    }
}

pub fn content_hash(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)
        .with_context(|| format!("opening {} for hashing", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Debug, Default)]
struct Probed {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration_secs: Option<f64>,
    sample_rate: Option<i64>,
    channels: Option<i64>,
}

/// Best-effort metadata probe via symphonia; failures are non-fatal.
fn probe(path: &Path) -> Probed {
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::{MetadataOptions, StandardTagKey};
    use symphonia::core::probe::Hint;

    let mut out = Probed::default();
    let Ok(file) = std::fs::File::open(path) else {
        return out;
    };
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let Ok(mut probed) = symphonia::default::get_probe().format(
        &hint,
        mss,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    ) else {
        return out;
    };

    let mut apply_tags = |rev: &symphonia::core::meta::MetadataRevision| {
        for tag in rev.tags() {
            match tag.std_key {
                Some(StandardTagKey::TrackTitle) => out.title = Some(tag.value.to_string()),
                Some(StandardTagKey::Artist) => out.artist = Some(tag.value.to_string()),
                Some(StandardTagKey::Album) => out.album = Some(tag.value.to_string()),
                _ => {}
            }
        }
    };
    if let Some(rev) = probed.metadata.get().as_ref().and_then(|m| m.current()) {
        apply_tags(rev);
    }
    if let Some(rev) = probed.format.metadata().current() {
        apply_tags(rev);
    }

    if let Some(track) = probed.format.default_track() {
        let params = &track.codec_params;
        out.sample_rate = params.sample_rate.map(|r| r as i64);
        out.channels = params.channels.map(|c| c.count() as i64);
        if let (Some(n_frames), Some(rate)) = (params.n_frames, params.sample_rate) {
            if rate > 0 {
                out.duration_secs = Some(n_frames as f64 / rate as f64);
            }
        }
    }
    out
}

impl Library {
    /// Import an audio file into the library. The file stays where it is
    /// (the library stores its path); identical content (by hash) is
    /// deduplicated. New tracks are queued for analysis.
    ///
    /// Importing a path the user had deleted is a deliberate change of
    /// mind, so it clears that deletion (the watch folder never reaches
    /// here for one — it skips deleted paths itself).
    pub fn import_file(&self, path: &Path, opts: ImportOptions) -> Result<ImportOutcome> {
        let path = path
            .canonicalize()
            .with_context(|| format!("resolving {}", path.display()))?;
        self.clear_deleted_file(&path)?;
        let hash = content_hash(&path)?;
        if let Some(existing) = self.track_by_hash(&hash)? {
            return Ok(ImportOutcome::Duplicate(existing));
        }
        let probed = probe(&path);
        let fallback_title = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "untitled".into());
        let format = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let source = if opts.source.is_empty() {
            "local".to_string()
        } else {
            opts.source
        };
        let track = self.insert_track(
            &opts.title.or(probed.title).unwrap_or(fallback_title),
            &opts.artist.or(probed.artist).unwrap_or_default(),
            &opts.album.or(probed.album).unwrap_or_default(),
            &path,
            &hash,
            &format,
            probed.duration_secs,
            probed.sample_rate,
            probed.channels,
            &source,
            &opts.source_ref,
            &opts.license,
        )?;
        Ok(ImportOutcome::Added(track))
    }
}
