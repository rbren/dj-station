//! Freesound provider (PRD §8.3): samples / field recordings / loops under
//! CC licenses. Token auth (`FREESOUND_API_KEY`, a free API key).
//!
//! Downloads use the HQ MP3 preview rendition: full-quality originals
//! require the interactive OAuth2 flow, which is a documented fast-follow;
//! the preview is a complete, DJ-usable MP3 of the whole sound and is
//! served with the same token auth as the search API.

use anyhow::{anyhow, Result};

use super::{json_f64, json_str, Acquire, AcquisitionProvider, Query, TrackResult};
use crate::LicenseInfo;

pub const DEFAULT_BASE_URL: &str = "https://freesound.org";

pub struct FreesoundProvider {
    base_url: String,
    api_key: String,
}

impl FreesoundProvider {
    pub fn new(api_key: &str) -> Self {
        Self::with_base_url(api_key, DEFAULT_BASE_URL)
    }

    /// Point at a different base URL (mock server in tests).
    pub fn with_base_url(api_key: &str, base_url: &str) -> Self {
        FreesoundProvider {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
        }
    }

    fn auth_headers(&self) -> Vec<(String, String)> {
        vec![("Authorization".into(), format!("Token {}", self.api_key))]
    }
}

impl AcquisitionProvider for FreesoundProvider {
    fn id(&self) -> &'static str {
        "freesound"
    }

    fn name(&self) -> &'static str {
        "Freesound"
    }

    fn search(&self, q: &Query) -> Result<Vec<TrackResult>> {
        let url = format!("{}/apiv2/search/text/", self.base_url);
        let limit = q.limit.to_string();
        let mut req = ureq::get(&url)
            .set("User-Agent", "dj-station/0.1")
            .set("Authorization", &format!("Token {}", self.api_key))
            .query("query", &q.text)
            .query("page_size", &limit)
            .query(
                "fields",
                "id,name,username,license,duration,previews,download,images",
            );
        req = req.query("token", &self.api_key);
        let body: serde_json::Value = req
            .call()
            .map_err(|e| anyhow!("GET {url}: {e}"))?
            .into_json()?;
        let results = body["results"].as_array().cloned().unwrap_or_default();
        Ok(results
            .iter()
            .map(|r| {
                let username = json_str(r, "username");
                let license_url = json_str(r, "license");
                let attribution = format!(
                    "\"{}\" by {} (freesound.org)",
                    json_str(r, "name"),
                    username
                );
                TrackResult {
                    provider: self.id().into(),
                    id: json_str(r, "id"),
                    title: json_str(r, "name"),
                    artist: username,
                    album: String::new(),
                    duration_secs: json_f64(r, "duration"),
                    preview_url: r["previews"]["preview-hq-mp3"].as_str().map(String::from),
                    artwork_url: r["images"]["waveform_m"].as_str().map(String::from),
                    license: LicenseInfo::from_cc_url(&license_url, &attribution),
                    download_url: r["previews"]["preview-hq-mp3"].as_str().map(String::from),
                    deep_link_url: None,
                }
            })
            .collect())
    }

    fn acquire(&self, t: &TrackResult) -> Result<Acquire> {
        let url = t
            .download_url
            .clone()
            .ok_or_else(|| anyhow!("freesound result {:?} has no download URL", t.id))?;
        Ok(Acquire::Download {
            url,
            headers: self.auth_headers(),
            filename: format!("freesound-{}-{}.mp3", t.id, t.title),
        })
    }
}
