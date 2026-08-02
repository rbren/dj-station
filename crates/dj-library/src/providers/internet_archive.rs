//! Internet Archive provider (PRD §8.3): live concert recordings (etree),
//! 78s, and public-domain audio via the open JSON APIs — no key required.
//!
//! Search uses `advancedsearch.php`; acquisition resolves the item's file
//! list via the metadata API and downloads the best audio file (MP3
//! preferred, then FLAC/other audio).

use anyhow::{anyhow, Result};

use super::{get_json, json_str, Acquire, AcquireKind, AcquisitionProvider, Query, TrackResult};
use crate::LicenseInfo;

pub const DEFAULT_BASE_URL: &str = "https://archive.org";

pub struct InternetArchiveProvider {
    base_url: String,
}

impl InternetArchiveProvider {
    pub fn new() -> Self {
        Self::with_base_url(DEFAULT_BASE_URL)
    }

    /// Point at a different base URL (mock server in tests).
    pub fn with_base_url(base_url: &str) -> Self {
        InternetArchiveProvider {
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }
}

impl Default for InternetArchiveProvider {
    fn default() -> Self {
        Self::new()
    }
}

fn is_audio_format(format: &str) -> bool {
    let f = format.to_lowercase();
    f.contains("mp3") || f.contains("flac") || f.contains("ogg") || f.contains("wave")
}

fn format_rank(format: &str) -> u32 {
    let f = format.to_lowercase();
    if f.contains("mp3") {
        0
    } else if f.contains("flac") {
        1
    } else {
        2
    }
}

impl AcquisitionProvider for InternetArchiveProvider {
    fn id(&self) -> &'static str {
        "internet_archive"
    }

    fn name(&self) -> &'static str {
        "Internet Archive"
    }

    fn search(&self, q: &Query) -> Result<Vec<TrackResult>> {
        let url = format!("{}/advancedsearch.php", self.base_url);
        let query = format!("({}) AND mediatype:(audio)", q.text);
        let rows = q.limit.to_string();
        let body = get_json(
            &url,
            &[
                ("q", query.as_str()),
                ("fl[]", "identifier"),
                ("fl[]", "title"),
                ("fl[]", "creator"),
                ("fl[]", "licenseurl"),
                ("rows", rows.as_str()),
                ("output", "json"),
            ],
        )?;
        let docs = body["response"]["docs"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        Ok(docs
            .iter()
            .map(|d| {
                let identifier = json_str(d, "identifier");
                let creator = json_str(d, "creator");
                let title = json_str(d, "title");
                let license_url = json_str(d, "licenseurl");
                let attribution = format!("\"{title}\" by {creator} (archive.org/{identifier})");
                let license = if license_url.is_empty() {
                    // The Live Music Archive hosts taper-friendly material
                    // without explicit license URLs; keep it unknown.
                    LicenseInfo::default()
                } else {
                    LicenseInfo::from_cc_url(&license_url, &attribution)
                };
                TrackResult {
                    provider: self.id().into(),
                    acquire_kind: AcquireKind::Download,
                    id: identifier.clone(),
                    title,
                    artist: creator,
                    album: String::new(),
                    duration_secs: None,
                    preview_url: Some(format!("{}/details/{identifier}", self.base_url)),
                    artwork_url: Some(format!("{}/services/img/{identifier}", self.base_url)),
                    license,
                    download_url: None, // resolved by acquire() via the metadata API
                    deep_link_url: Some(format!("{}/details/{identifier}", self.base_url)),
                }
            })
            .collect())
    }

    fn acquire(&self, t: &TrackResult) -> Result<Acquire> {
        let meta = get_json(&format!("{}/metadata/{}", self.base_url, t.id), &[])?;
        let files = meta["files"].as_array().cloned().unwrap_or_default();
        let mut candidates: Vec<(u32, String)> = files
            .iter()
            .filter(|f| is_audio_format(&json_str(f, "format")))
            .map(|f| (format_rank(&json_str(f, "format")), json_str(f, "name")))
            .filter(|(_, name)| !name.is_empty())
            .collect();
        candidates.sort();
        let (_, name) = candidates
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("item {:?} has no audio files", t.id))?;
        let filename = name.rsplit('/').next().unwrap_or(&name).to_string();
        Ok(Acquire::Download {
            url: format!("{}/download/{}/{}", self.base_url, t.id, name),
            headers: vec![],
            filename,
        })
    }
}
