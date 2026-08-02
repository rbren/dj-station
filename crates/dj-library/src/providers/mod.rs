//! Acquisition provider framework (PRD §8.3).
//!
//! One trait, many sources: unified search fans out across enabled
//! providers; results are tagged by source and license. `Download`
//! providers pull the file straight into the library; `DeepLink` providers
//! open the store page (the watch folder catches the purchase).
//!
//! v1 providers: iTunes Search (deep link, keyless), Freesound (download,
//! `FREESOUND_API_KEY`), Jamendo (download, `JAMENDO_CLIENT_ID`), Internet
//! Archive (download, keyless). Musopen is a documented fast-follow (its
//! API requires manually-approved accounts).

pub mod freesound;
pub mod internet_archive;
pub mod itunes;
pub mod jamendo;

pub use freesound::FreesoundProvider;
pub use internet_archive::InternetArchiveProvider;
pub use itunes::ItunesProvider;
pub use jamendo::JamendoProvider;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::Write;

use crate::db::{Library, Track};
use crate::import::{ImportOptions, ImportOutcome};
use crate::LicenseInfo;

pub const ENV_FREESOUND_KEY: &str = "FREESOUND_API_KEY";
pub const ENV_JAMENDO_ID: &str = "JAMENDO_CLIENT_ID";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Query {
    pub text: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    10
}

impl Query {
    pub fn new(text: &str) -> Self {
        Query {
            text: text.into(),
            limit: default_limit(),
        }
    }
}

/// One search hit, tagged by source provider and license.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackResult {
    /// Provider id ("itunes", "freesound", "jamendo", "internet_archive").
    pub provider: String,
    /// Provider-side track/item id.
    pub id: String,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub duration_secs: Option<f64>,
    #[serde(default)]
    pub preview_url: Option<String>,
    #[serde(default)]
    pub artwork_url: Option<String>,
    pub license: LicenseInfo,
    /// Direct-download URL (Download providers).
    #[serde(default)]
    pub download_url: Option<String>,
    /// Store page URL (DeepLink providers).
    #[serde(default)]
    pub deep_link_url: Option<String>,
}

/// How a result is acquired: pulled straight into the library, or a store
/// page opened in the browser (watch folder catches the purchase).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Acquire {
    Download {
        url: String,
        /// Extra request headers (e.g. Freesound token auth).
        headers: Vec<(String, String)>,
        /// Suggested destination filename.
        filename: String,
    },
    DeepLink {
        url: String,
    },
}

pub trait AcquisitionProvider: Send + Sync {
    fn id(&self) -> &'static str;
    /// Human-readable name for the UI.
    fn name(&self) -> &'static str;
    fn search(&self, q: &Query) -> Result<Vec<TrackResult>>;
    fn acquire(&self, t: &TrackResult) -> Result<Acquire>;
    fn license(&self, t: &TrackResult) -> LicenseInfo {
        t.license.clone()
    }
}

/// Per-provider fan-out outcome: results, plus any provider errors (a slow
/// or failing provider must not break the others).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchOutcome {
    pub results: Vec<TrackResult>,
    /// (provider id, error message) for providers that failed.
    pub errors: Vec<(String, String)>,
}

/// The unified search / acquisition hub.
pub struct AcquisitionHub {
    providers: Vec<Box<dyn AcquisitionProvider>>,
}

impl AcquisitionHub {
    pub fn new(providers: Vec<Box<dyn AcquisitionProvider>>) -> Self {
        AcquisitionHub { providers }
    }

    /// Build from the environment: keyless providers (iTunes, Internet
    /// Archive) are always enabled; Freesound/Jamendo when their env keys
    /// are present.
    pub fn from_env() -> Self {
        let mut providers: Vec<Box<dyn AcquisitionProvider>> = vec![
            Box::new(ItunesProvider::new()),
            Box::new(InternetArchiveProvider::new()),
        ];
        if let Ok(key) = std::env::var(ENV_FREESOUND_KEY) {
            if !key.is_empty() {
                providers.push(Box::new(FreesoundProvider::new(&key)));
            }
        }
        if let Ok(id) = std::env::var(ENV_JAMENDO_ID) {
            if !id.is_empty() {
                providers.push(Box::new(JamendoProvider::new(&id)));
            }
        }
        AcquisitionHub::new(providers)
    }

    pub fn provider_ids(&self) -> Vec<&'static str> {
        self.providers.iter().map(|p| p.id()).collect()
    }

    fn provider(&self, id: &str) -> Result<&dyn AcquisitionProvider> {
        self.providers
            .iter()
            .find(|p| p.id() == id)
            .map(|p| p.as_ref())
            .ok_or_else(|| anyhow!("provider {id:?} not enabled"))
    }

    /// Fan out the query across all enabled providers in parallel. Provider
    /// failures are collected, not fatal.
    pub fn search(&self, q: &Query) -> SearchOutcome {
        let mut outcome = SearchOutcome {
            results: Vec::new(),
            errors: Vec::new(),
        };
        std::thread::scope(|scope| {
            let handles: Vec<_> = self
                .providers
                .iter()
                .map(|p| scope.spawn(move || (p.id(), p.search(q))))
                .collect();
            for handle in handles {
                let (id, res) = handle.join().expect("provider search panicked");
                match res {
                    Ok(results) => outcome.results.extend(results),
                    Err(e) => outcome.errors.push((id.to_string(), format!("{e:#}"))),
                }
            }
        });
        outcome
    }

    pub fn acquire(&self, t: &TrackResult) -> Result<Acquire> {
        self.provider(&t.provider)?.acquire(t)
    }

    /// Download a `Download` result into the library's downloads dir and
    /// import it with the provider's source + license tags.
    pub fn download_to_library(&self, library: &Library, t: &TrackResult) -> Result<Track> {
        let provider = self.provider(&t.provider)?;
        let (url, headers, filename) = match provider.acquire(t)? {
            Acquire::Download {
                url,
                headers,
                filename,
            } => (url, headers, filename),
            Acquire::DeepLink { .. } => {
                bail!(
                    "provider {:?} is deep-link only; use open_deep_link",
                    t.provider
                )
            }
        };
        let dir = library.downloads_dir();
        std::fs::create_dir_all(&dir)?;
        let dest = unique_path(&dir.join(sanitize_filename(&filename)));
        let tmp = dest.with_extension("part");

        let mut req = ureq::get(&url);
        for (k, v) in &headers {
            req = req.set(k, v);
        }
        let resp = req.call().with_context(|| format!("GET {url}"))?;
        let mut reader = resp.into_reader();
        let mut file = std::fs::File::create(&tmp)?;
        std::io::copy(&mut reader, &mut file).with_context(|| format!("downloading {url}"))?;
        file.flush()?;
        drop(file);
        std::fs::rename(&tmp, &dest)?;

        let outcome = library.import_file(
            &dest,
            ImportOptions {
                source: t.provider.clone(),
                source_ref: t.id.clone(),
                license: provider.license(t),
                title: Some(t.title.clone()),
                artist: Some(t.artist.clone()),
                album: Some(t.album.clone()),
            },
        )?;
        if let ImportOutcome::Duplicate(_) = &outcome {
            // Same content was already in the library; drop the extra copy.
            let _ = std::fs::remove_file(&dest);
        }
        Ok(outcome.track().clone())
    }

    /// Resolve a `DeepLink` result to its store URL and hand it to
    /// `dispatch` (the shell opens a browser; tests record the URL).
    pub fn open_deep_link(
        &self,
        t: &TrackResult,
        dispatch: impl FnOnce(&str) -> Result<()>,
    ) -> Result<String> {
        match self.provider(&t.provider)?.acquire(t)? {
            Acquire::DeepLink { url } => {
                dispatch(&url)?;
                Ok(url)
            }
            Acquire::Download { .. } => {
                bail!(
                    "provider {:?} downloads directly; use download_to_library",
                    t.provider
                )
            }
        }
    }
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.');
    if trimmed.is_empty() {
        "download".into()
    } else {
        trimmed.to_string()
    }
}

fn unique_path(path: &std::path::Path) -> std::path::PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let dir = path.parent().unwrap_or(std::path::Path::new("."));
    for i in 1.. {
        let cand = dir.join(format!("{stem}-{i}{ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    unreachable!()
}

/// Shared helper: GET a URL with query params and parse the JSON body.
pub(crate) fn get_json(url: &str, params: &[(&str, &str)]) -> Result<serde_json::Value> {
    let mut req = ureq::get(url).set("User-Agent", "dj-station/0.1");
    for (k, v) in params {
        req = req.query(k, v);
    }
    let resp = req.call().with_context(|| format!("GET {url}"))?;
    resp.into_json().with_context(|| format!("parsing {url}"))
}

/// JSON access helpers shared by the provider implementations.
pub(crate) fn json_str(v: &serde_json::Value, key: &str) -> String {
    match &v[key] {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Array(a) => a
            .iter()
            .filter_map(|x| x.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        _ => String::new(),
    }
}

pub(crate) fn json_f64(v: &serde_json::Value, key: &str) -> Option<f64> {
    v[key].as_f64()
}
