//! Acquisition provider framework (PRD §8.3).
//!
//! One trait, many sources: unified search fans out across enabled
//! providers; results are tagged by source and license. `Download`
//! providers pull the file straight into the library; `DeepLink` providers
//! open the store page (the watch folder catches the purchase).
//!
//! v1 providers: iTunes Search (deep link, keyless), Freesound (download,
//! `FREESOUND_API_KEY`), Jamendo (download, `JAMENDO_CLIENT_ID`), Internet
//! Archive (download, keyless), YouTube (download via the external
//! `yt-dlp` binary, keyless). Musopen is a documented fast-follow (its
//! API requires manually-approved accounts).

pub mod freesound;
pub mod internet_archive;
pub mod itunes;
pub mod jamendo;
pub mod youtube;

pub use freesound::FreesoundProvider;
pub use internet_archive::InternetArchiveProvider;
pub use itunes::ItunesProvider;
pub use jamendo::JamendoProvider;
pub use youtube::YoutubeProvider;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

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
    /// Provider-specific filter selections, keyed by `FilterSpec::id`.
    /// Empty string means "any" (the filter's default).
    #[serde(default)]
    pub filters: BTreeMap<String, String>,
}

fn default_limit() -> usize {
    10
}

impl Query {
    pub fn new(text: &str) -> Self {
        Query {
            text: text.into(),
            limit: default_limit(),
            filters: BTreeMap::new(),
        }
    }

    pub fn with_filter(mut self, id: &str, value: &str) -> Self {
        self.filters.insert(id.into(), value.into());
        self
    }

    /// Selected value for a filter, if set and non-empty.
    pub fn filter(&self, id: &str) -> Option<&str> {
        self.filters
            .get(id)
            .map(|s| s.as_str())
            .filter(|s| !s.is_empty())
    }
}

/// One choice in a select-style provider filter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilterOption {
    /// Value sent back in `Query::filters` ("" = any/default).
    pub value: String,
    pub label: String,
}

/// A select-style filter a provider supports; the UI renders one dropdown
/// per spec. The first option is always the default ("any").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilterSpec {
    pub id: String,
    pub label: String,
    pub options: Vec<FilterOption>,
}

impl FilterSpec {
    pub fn new(id: &str, label: &str, options: &[(&str, &str)]) -> Self {
        FilterSpec {
            id: id.into(),
            label: label.into(),
            options: options
                .iter()
                .map(|(value, label)| FilterOption {
                    value: (*value).into(),
                    label: (*label).into(),
                })
                .collect(),
        }
    }
}

/// UI-facing description of an enabled provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub acquire_kind: AcquireKind,
    pub filters: Vec<FilterSpec>,
}

/// How a provider's results are acquired. Explicit on every result so the
/// UI never has to guess from URL presence (e.g. Internet Archive is a
/// Download provider whose download URL is only resolved at acquire time).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcquireKind {
    Download,
    DeepLink,
}

/// One search hit, tagged by source provider and license.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackResult {
    /// Provider id ("itunes", "freesound", "jamendo", "internet_archive").
    pub provider: String,
    /// How this result is acquired (Download vs DeepLink).
    pub acquire_kind: AcquireKind,
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
    /// The media cannot be fetched with a plain HTTP GET — the provider
    /// owns the transfer via [`AcquisitionProvider::fetch`] (YouTube, which
    /// shells out to `yt-dlp`). `url` is the human-facing source page.
    External {
        url: String,
    },
}

/// Progress of one in-flight fetch, reported to the caller's callback.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FetchProgress {
    /// Completed fraction (0..1) when the total size is known.
    pub fraction: Option<f64>,
    /// Coarse stage label for the UI ("downloading", "converting", …).
    pub stage: String,
}

impl FetchProgress {
    pub fn stage(stage: &str) -> Self {
        FetchProgress {
            fraction: None,
            stage: stage.into(),
        }
    }

    pub fn downloading(fraction: f64) -> Self {
        FetchProgress {
            fraction: Some(fraction.clamp(0.0, 1.0)),
            stage: "downloading".into(),
        }
    }
}

/// Callback a provider calls as a fetch advances. Progress reporting is
/// best-effort: a provider may only ever report stages.
pub type ProgressFn<'a> = &'a mut dyn FnMut(FetchProgress);

pub trait AcquisitionProvider: Send + Sync {
    fn id(&self) -> &'static str;
    /// Human-readable name for the UI.
    fn name(&self) -> &'static str;
    /// How this provider's results are acquired.
    fn acquire_kind(&self) -> AcquireKind;
    /// Select-style filters this provider supports (empty by default).
    fn filters(&self) -> Vec<FilterSpec> {
        Vec::new()
    }
    fn search(&self, q: &Query) -> Result<Vec<TrackResult>>;
    fn acquire(&self, t: &TrackResult) -> Result<Acquire>;
    fn license(&self, t: &TrackResult) -> LicenseInfo {
        t.license.clone()
    }

    /// Pull a result's media into `dir` and return the file written.
    ///
    /// The default is a plain HTTP GET of `acquire()`'s `Download` URL;
    /// providers whose media needs an external tool (YouTube/yt-dlp)
    /// override this. Callers get progress through `progress`.
    fn fetch(&self, t: &TrackResult, dir: &Path, progress: ProgressFn) -> Result<PathBuf> {
        let (url, headers, filename) = match self.acquire(t)? {
            Acquire::Download {
                url,
                headers,
                filename,
            } => (url, headers, filename),
            Acquire::DeepLink { .. } => {
                bail!(
                    "provider {:?} is deep-link only; use open_deep_link",
                    self.id()
                )
            }
            Acquire::External { .. } => bail!(
                "provider {:?} needs an external fetcher but does not implement one",
                self.id()
            ),
        };
        let dest = unique_path(&dir.join(sanitize_filename(&filename)));
        let tmp = dest.with_extension("part");

        progress(FetchProgress::stage("connecting"));
        let mut req = ureq::get(&url);
        for (k, v) in &headers {
            req = req.set(k, v);
        }
        let resp = req.call().with_context(|| format!("GET {url}"))?;
        let total: Option<u64> = resp.header("Content-Length").and_then(|v| v.parse().ok());
        let mut reader = resp.into_reader();
        let mut file = std::fs::File::create(&tmp)?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut done: u64 = 0;
        loop {
            let n = reader
                .read(&mut buf)
                .with_context(|| format!("downloading {url}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])?;
            done += n as u64;
            match total {
                Some(total) if total > 0 => {
                    progress(FetchProgress::downloading(done as f64 / total as f64))
                }
                _ => progress(FetchProgress::stage("downloading")),
            }
        }
        file.flush()?;
        drop(file);
        std::fs::rename(&tmp, &dest)?;
        Ok(dest)
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
    /// Archive, YouTube) are always enabled; Freesound/Jamendo when their
    /// env keys are present. YouTube stays enabled even without `yt-dlp`
    /// installed — its searches then fail with an install hint instead of
    /// the tab silently disappearing.
    pub fn from_env() -> Self {
        let mut providers: Vec<Box<dyn AcquisitionProvider>> = vec![
            Box::new(ItunesProvider::new()),
            Box::new(InternetArchiveProvider::new()),
            Box::new(YoutubeProvider::new()),
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

    /// UI-facing descriptions (id, name, acquisition kind, filters) of all
    /// enabled providers, in fan-out order.
    pub fn providers_info(&self) -> Vec<ProviderInfo> {
        self.providers
            .iter()
            .map(|p| ProviderInfo {
                id: p.id().into(),
                name: p.name().into(),
                acquire_kind: p.acquire_kind(),
                filters: p.filters(),
            })
            .collect()
    }

    /// Search a single enabled provider (per-store search).
    pub fn search_provider(&self, id: &str, q: &Query) -> Result<Vec<TrackResult>> {
        self.provider(id)?.search(q)
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
        self.download_to_library_with_progress(library, t, &mut |_| {})
    }

    /// `download_to_library` with progress reporting — used by the
    /// background [`crate::downloads::DownloadManager`] so slow fetches
    /// (yt-dlp) can drive a UI.
    pub fn download_to_library_with_progress(
        &self,
        library: &Library,
        t: &TrackResult,
        progress: ProgressFn,
    ) -> Result<Track> {
        let provider = self.provider(&t.provider)?;
        let dir = library.downloads_dir();
        std::fs::create_dir_all(&dir)?;
        let dest = provider.fetch(t, &dir, progress)?;

        progress(FetchProgress::stage("importing"));
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
            Acquire::Download { .. } | Acquire::External { .. } => {
                bail!(
                    "provider {:?} downloads directly; use download_to_library",
                    t.provider
                )
            }
        }
    }
}

/// Make `name` safe to use as a file name (also used by the app's clip
/// renderer when it names a rendered clip after its title).
pub fn sanitize_filename(name: &str) -> String {
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

/// `path`, or the first free `<stem>-<n>` variant next to it — so writing
/// a new file never clobbers an existing one.
pub fn unique_path(path: &Path) -> PathBuf {
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
    let dir = path.parent().unwrap_or(Path::new("."));
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
