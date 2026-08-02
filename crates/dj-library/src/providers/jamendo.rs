//! Jamendo provider (PRD §8.3): full CC-licensed songs from independent
//! artists, with direct MP3 download endpoints. Free API key via
//! `JAMENDO_CLIENT_ID`.

use anyhow::{anyhow, Result};

use super::{get_json, json_f64, json_str, Acquire, AcquisitionProvider, Query, TrackResult};
use crate::LicenseInfo;

pub const DEFAULT_BASE_URL: &str = "https://api.jamendo.com";

pub struct JamendoProvider {
    base_url: String,
    client_id: String,
}

impl JamendoProvider {
    pub fn new(client_id: &str) -> Self {
        Self::with_base_url(client_id, DEFAULT_BASE_URL)
    }

    /// Point at a different base URL (mock server in tests).
    pub fn with_base_url(client_id: &str, base_url: &str) -> Self {
        JamendoProvider {
            base_url: base_url.trim_end_matches('/').to_string(),
            client_id: client_id.to_string(),
        }
    }
}

impl AcquisitionProvider for JamendoProvider {
    fn id(&self) -> &'static str {
        "jamendo"
    }

    fn name(&self) -> &'static str {
        "Jamendo"
    }

    fn search(&self, q: &Query) -> Result<Vec<TrackResult>> {
        let url = format!("{}/v3.0/tracks/", self.base_url);
        let limit = q.limit.to_string();
        let body = get_json(
            &url,
            &[
                ("client_id", self.client_id.as_str()),
                ("format", "json"),
                ("search", q.text.as_str()),
                ("limit", limit.as_str()),
                ("audioformat", "mp32"),
                ("include", "licenses"),
            ],
        )?;
        let results = body["results"].as_array().cloned().unwrap_or_default();
        Ok(results
            .iter()
            .map(|r| {
                let artist = json_str(r, "artist_name");
                let title = json_str(r, "name");
                let license_url = json_str(r, "license_ccurl");
                let attribution = format!("\"{title}\" by {artist} (jamendo.com)");
                TrackResult {
                    provider: self.id().into(),
                    id: json_str(r, "id"),
                    title,
                    artist,
                    album: json_str(r, "album_name"),
                    duration_secs: json_f64(r, "duration"),
                    preview_url: r["audio"].as_str().map(String::from),
                    artwork_url: r["image"].as_str().map(String::from),
                    license: LicenseInfo::from_cc_url(&license_url, &attribution),
                    download_url: r["audiodownload"].as_str().map(String::from),
                    deep_link_url: r["shareurl"].as_str().map(String::from),
                }
            })
            .collect())
    }

    fn acquire(&self, t: &TrackResult) -> Result<Acquire> {
        let url = t
            .download_url
            .clone()
            .ok_or_else(|| anyhow!("jamendo result {:?} has no download URL", t.id))?;
        Ok(Acquire::Download {
            url,
            headers: vec![],
            filename: format!("jamendo-{}-{}.mp3", t.id, t.title),
        })
    }
}
