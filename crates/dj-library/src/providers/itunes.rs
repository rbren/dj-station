//! iTunes Search API provider (PRD §8.3): keyless commercial catalog with
//! 30 s previews; acquisition is a deep link to the store page (the watch
//! folder catches the purchased download).

use anyhow::{anyhow, Result};

use super::{
    get_json, json_f64, json_str, Acquire, AcquireKind, AcquisitionProvider, Query, TrackResult,
};
use crate::LicenseInfo;

pub const DEFAULT_BASE_URL: &str = "https://itunes.apple.com";

pub struct ItunesProvider {
    base_url: String,
}

impl ItunesProvider {
    pub fn new() -> Self {
        Self::with_base_url(DEFAULT_BASE_URL)
    }

    /// Point at a different base URL (mock server in tests).
    pub fn with_base_url(base_url: &str) -> Self {
        ItunesProvider {
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }
}

impl Default for ItunesProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl AcquisitionProvider for ItunesProvider {
    fn id(&self) -> &'static str {
        "itunes"
    }

    fn name(&self) -> &'static str {
        "iTunes Store"
    }

    fn search(&self, q: &Query) -> Result<Vec<TrackResult>> {
        let url = format!("{}/search", self.base_url);
        let limit = q.limit.to_string();
        let body = get_json(
            &url,
            &[
                ("term", q.text.as_str()),
                ("media", "music"),
                ("entity", "song"),
                ("limit", limit.as_str()),
            ],
        )?;
        let results = body["results"].as_array().cloned().unwrap_or_default();
        Ok(results
            .iter()
            .map(|r| TrackResult {
                provider: self.id().into(),
                acquire_kind: AcquireKind::DeepLink,
                id: json_str(r, "trackId"),
                title: json_str(r, "trackName"),
                artist: json_str(r, "artistName"),
                album: json_str(r, "collectionName"),
                duration_secs: json_f64(r, "trackTimeMillis").map(|ms| ms / 1000.0),
                preview_url: r["previewUrl"].as_str().map(String::from),
                artwork_url: r["artworkUrl100"].as_str().map(String::from),
                license: LicenseInfo::commercial(),
                download_url: None,
                deep_link_url: r["trackViewUrl"].as_str().map(String::from),
            })
            .collect())
    }

    fn acquire(&self, t: &TrackResult) -> Result<Acquire> {
        let url = t
            .deep_link_url
            .clone()
            .ok_or_else(|| anyhow!("iTunes result {:?} has no store URL", t.id))?;
        Ok(Acquire::DeepLink { url })
    }
}
