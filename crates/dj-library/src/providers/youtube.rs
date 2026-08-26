//! YouTube provider (PRD §8.3 extension): search videos and pull their
//! audio into the library.
//!
//! Keyless by design — instead of the Data API (quota + API key) this
//! drives the external `yt-dlp` binary:
//!
//! - search: `yt-dlp --dump-json --flat-playlist "ytsearch<N>:<text>"`,
//!   one JSON object per line (title, channel, duration, thumbnails);
//! - fetch: `yt-dlp -f bestaudio[ext=m4a]/…` into a staging dir, then the
//!   single produced file is moved into the library's downloads dir and
//!   imported like any other acquisition. An audio-only m4a/mp3 stream is
//!   requested on purpose: no transcoding, so **ffmpeg is not required**.
//!
//! `yt-dlp` is an optional runtime dependency: when it is missing every
//! call fails with an install hint instead of panicking (the tab stays
//! visible, see `AcquisitionHub::from_env`). Point `DJ_YTDLP_BIN` at a
//! specific binary to override the default (`/usr/local/bin/yt-dlp_macos`).
//!
//! Nothing here is on the RT thread, and the shell runs both search and
//! download off the UI thread (see the app's `DownloadManager`).

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::{
    json_str, sanitize_filename, unique_path, Acquire, AcquireKind, AcquisitionProvider,
    FetchProgress, FilterSpec, ProgressFn, Query, TrackResult,
};
use crate::LicenseInfo;

/// Override the `yt-dlp` binary (name on `PATH` or absolute path).
pub const ENV_YTDLP_BIN: &str = "DJ_YTDLP_BIN";
/// Extra whitespace-separated yt-dlp flags, added to every invocation.
/// The escape hatch for machine-specific needs — most usefully
/// `--cookies-from-browser firefox` when YouTube demands a sign-in.
pub const ENV_YTDLP_ARGS: &str = "DJ_YTDLP_ARGS";
pub const DEFAULT_BIN: &str = "/usr/local/bin/yt-dlp_macos";

/// Audio-only format preference: m4a/mp3 first so the file imports
/// straight away (symphonia) and no ffmpeg post-processing is needed.
const FORMAT: &str = "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best";

/// Socket timeout handed to yt-dlp, in seconds.
const SOCKET_TIMEOUT: &str = "20";

pub struct YoutubeProvider {
    bin: String,
    extra_args: Vec<String>,
}

impl YoutubeProvider {
    pub fn new() -> Self {
        let bin = std::env::var(ENV_YTDLP_BIN)
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_BIN.to_string());
        YoutubeProvider {
            bin,
            extra_args: parse_extra_args(&std::env::var(ENV_YTDLP_ARGS).unwrap_or_default()),
        }
    }

    /// Point at a specific binary (tests use a fake yt-dlp script).
    pub fn with_bin(bin: &str) -> Self {
        YoutubeProvider {
            bin: bin.into(),
            extra_args: Vec::new(),
        }
    }

    fn run(&self, args: &[&str]) -> Result<String> {
        let out = Command::new(&self.bin)
            .args(&self.extra_args)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| self.spawn_error(e))?;
        // With --ignore-errors yt-dlp exits non-zero when individual
        // entries fail; partial stdout is still usable.
        if !out.status.success() && out.stdout.is_empty() {
            bail!("{}", tool_failure(&self.bin, &out.stderr, out.status));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    fn spawn_error(&self, e: std::io::Error) -> anyhow::Error {
        if e.kind() == std::io::ErrorKind::NotFound {
            anyhow!(
                "`{}` not found — install yt-dlp (https://github.com/yt-dlp/yt-dlp) \
                 or set {ENV_YTDLP_BIN} to its path",
                self.bin
            )
        } else {
            anyhow::Error::new(e).context(format!("running {}", self.bin))
        }
    }
}

impl Default for YoutubeProvider {
    fn default() -> Self {
        Self::new()
    }
}

fn tool_failure(bin: &str, stderr: &[u8], status: std::process::ExitStatus) -> String {
    let text = String::from_utf8_lossy(stderr);
    let detail = text
        .lines()
        .rfind(|l| !l.trim().is_empty())
        .unwrap_or("no output");
    format!("{bin} failed ({status}): {detail}")
}

/// Split `DJ_YTDLP_ARGS` into argv entries (whitespace-separated; quoting
/// is deliberately not supported — this is a flag escape hatch, not a
/// shell).
pub fn parse_extra_args(spec: &str) -> Vec<String> {
    spec.split_whitespace().map(str::to_string).collect()
}

pub fn watch_url(id: &str) -> String {
    format!("https://www.youtube.com/watch?v={id}")
}

/// Parse one `--dump-json --flat-playlist` line into a result. Non-JSON
/// lines (yt-dlp status chatter) and non-downloadable entries (live /
/// upcoming streams) yield `None`.
pub fn parse_search_line(line: &str) -> Result<Option<TrackResult>> {
    let line = line.trim();
    if !line.starts_with('{') {
        return Ok(None);
    }
    let entry: Value = serde_json::from_str(line).context("parsing yt-dlp JSON output")?;
    Ok(entry_to_result(&entry))
}

fn entry_to_result(entry: &Value) -> Option<TrackResult> {
    let id = entry["id"].as_str().unwrap_or_default().to_string();
    if id.is_empty() {
        return None;
    }
    match entry["live_status"].as_str() {
        // Live and scheduled items are not fetchable audio files.
        Some("is_live") | Some("is_upcoming") | Some("post_live") => return None,
        _ => {}
    }
    let title = json_str(entry, "title");
    let channel = ["channel", "uploader", "playlist_channel", "uploader_id"]
        .iter()
        .map(|k| json_str(entry, k))
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    let url = watch_url(&id);
    let attribution = format!("\"{title}\" by {channel} ({url})");
    TrackResult {
        provider: "youtube".into(),
        acquire_kind: AcquireKind::Download,
        id: id.clone(),
        title,
        artist: channel,
        album: String::new(),
        duration_secs: entry["duration"].as_f64().filter(|d| *d > 0.0),
        preview_url: Some(url.clone()),
        artwork_url: Some(thumbnail(entry, &id)),
        // YouTube uploads are all-rights-reserved unless the uploader says
        // otherwise, and the flat search JSON does not carry the video's
        // license — never claim more than "unverified" here.
        license: LicenseInfo {
            kind: "unknown".into(),
            name: "Unverified — check the video's terms before using it".into(),
            url: url.clone(),
            attribution,
        },
        download_url: None, // yt-dlp resolves the stream at fetch time
        deep_link_url: Some(url),
    }
    .into()
}

/// Pick a reasonably sized thumbnail (widest up to 640 px), falling back to
/// YouTube's stable per-video still.
fn thumbnail(entry: &Value, id: &str) -> String {
    let best = entry["thumbnails"]
        .as_array()
        .map(|thumbs| {
            let mut usable: Vec<(i64, &str)> = thumbs
                .iter()
                .filter_map(|t| Some((t["width"].as_i64().unwrap_or(0), t["url"].as_str()?)))
                .filter(|(w, _)| *w <= 640)
                .collect();
            usable.sort_by_key(|(w, _)| *w);
            usable.last().map(|(_, url)| url.to_string())
        })
        .unwrap_or_default();
    best.or_else(|| entry["thumbnail"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"))
}

/// Parse a `--newline` progress line from a running download.
pub fn parse_progress_line(line: &str) -> Option<FetchProgress> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("[download]") {
        let rest = rest.trim_start();
        if let Some(percent) = rest
            .split_whitespace()
            .next()
            .and_then(|w| w.strip_suffix('%'))
            .and_then(|w| w.parse::<f64>().ok())
        {
            return Some(FetchProgress::downloading(percent / 100.0));
        }
        if rest.starts_with("Destination:") {
            return Some(FetchProgress::downloading(0.0));
        }
        return None;
    }
    if line.starts_with("[ExtractAudio]") || line.starts_with("[Merger]") {
        return Some(FetchProgress::stage("converting"));
    }
    None
}

/// The single media file yt-dlp left in the staging dir (partials skipped).
fn staged_file(dir: &Path) -> Result<PathBuf> {
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !path.is_file() || ext == "part" || ext == "ytdl" {
            continue;
        }
        let size = path.metadata().map(|m| m.len()).unwrap_or(0);
        if best.as_ref().is_none_or(|(b, _)| size > *b) {
            best = Some((size, path));
        }
    }
    best.map(|(_, path)| path)
        .ok_or_else(|| anyhow!("yt-dlp produced no audio file"))
}

impl AcquisitionProvider for YoutubeProvider {
    fn id(&self) -> &'static str {
        "youtube"
    }

    fn name(&self) -> &'static str {
        "YouTube"
    }

    fn acquire_kind(&self) -> AcquireKind {
        AcquireKind::Download
    }

    fn filters(&self) -> Vec<FilterSpec> {
        vec![
            FilterSpec::new(
                "sort",
                "Sort by",
                &[("", "Relevance"), ("date", "Upload date")],
            ),
            FilterSpec::new(
                "length",
                "Length",
                &[
                    ("", "Any length"),
                    ("short", "Under 4 min"),
                    ("medium", "4–20 min"),
                    ("long", "Over 20 min"),
                ],
            ),
        ]
    }

    fn search(&self, q: &Query) -> Result<Vec<TrackResult>> {
        let text = q.text.trim();
        if text.is_empty() {
            return Ok(Vec::new());
        }
        // `ytsearchdate` is yt-dlp's newest-first search entry point.
        let prefix = match q.filter("sort") {
            Some("date") => "ytsearchdate",
            _ => "ytsearch",
        };
        let spec = format!("{prefix}{}:{text}", q.limit.clamp(1, 50));
        let stdout = self.run(&[
            "--dump-json",
            "--flat-playlist",
            "--no-warnings",
            "--ignore-errors",
            "--no-colors",
            "--socket-timeout",
            SOCKET_TIMEOUT,
            "--",
            &spec,
        ])?;
        let length = q.filter("length").unwrap_or("");
        let mut results = Vec::new();
        for line in stdout.lines() {
            let Some(result) = parse_search_line(line)? else {
                continue;
            };
            if length_matches(length, result.duration_secs) {
                results.push(result);
            }
        }
        Ok(results)
    }

    fn acquire(&self, t: &TrackResult) -> Result<Acquire> {
        Ok(Acquire::External {
            url: watch_url(&t.id),
        })
    }

    fn fetch(&self, t: &TrackResult, dir: &Path, progress: ProgressFn) -> Result<PathBuf> {
        let url = watch_url(&t.id);
        // Stage in a private subdir: yt-dlp names the file from the video
        // metadata, so the finished file is simply whatever landed there.
        let staging = unique_path(&dir.join(format!(".yt-{}", sanitize_filename(&t.id))));
        std::fs::create_dir_all(&staging)?;
        let result = self.run_download(&url, &staging, progress);
        let moved = result.and_then(|_| {
            let file = staged_file(&staging)?;
            let name = file
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| format!("{}.m4a", t.id));
            let dest = unique_path(&dir.join(sanitize_filename(&name)));
            std::fs::rename(&file, &dest)
                .with_context(|| format!("moving {} to {}", file.display(), dest.display()))?;
            Ok(dest)
        });
        let _ = std::fs::remove_dir_all(&staging);
        moved
    }
}

impl YoutubeProvider {
    fn run_download(&self, url: &str, staging: &Path, progress: ProgressFn) -> Result<()> {
        progress(FetchProgress::stage("starting yt-dlp"));
        let mut child = Command::new(&self.bin)
            .args(&self.extra_args)
            .args([
                "-f",
                FORMAT,
                "--no-playlist",
                "--newline",
                "--no-colors",
                "--no-warnings",
                "--socket-timeout",
                SOCKET_TIMEOUT,
                "-P",
                &staging.to_string_lossy(),
                "-o",
                "%(title)s [%(id)s].%(ext)s",
                "--",
                url,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| self.spawn_error(e))?;

        // stderr is drained on its own thread so a chatty yt-dlp can never
        // fill the pipe and deadlock the progress reader.
        let stderr = child.stderr.take().expect("piped stderr");
        let errors = std::thread::spawn(move || {
            let mut text = String::new();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                text.push_str(&line);
                text.push('\n');
            }
            text
        });
        let stdout = child.stdout.take().expect("piped stdout");
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(update) = parse_progress_line(&line) {
                progress(update);
            }
        }
        let status = child.wait()?;
        let stderr = errors.join().unwrap_or_default();
        if !status.success() {
            bail!("{}", tool_failure(&self.bin, stderr.as_bytes(), status));
        }
        Ok(())
    }
}

/// Client-side duration filter (the search endpoint has no length filter).
/// Entries of unknown length only pass the "any" selection.
fn length_matches(length: &str, duration: Option<f64>) -> bool {
    match length {
        "short" => duration.is_some_and(|d| d < 240.0),
        "medium" => duration.is_some_and(|d| (240.0..=1200.0).contains(&d)),
        "long" => duration.is_some_and(|d| d > 1200.0),
        _ => true,
    }
}
