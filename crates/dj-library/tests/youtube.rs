//! YouTube provider tests. No network and no real `yt-dlp`: the parsing
//! is pinned against a recorded `--dump-json --flat-playlist` fixture, and
//! the search/download/import plumbing runs against a fake yt-dlp script
//! that prints the fixture and copies a WAV into the staging dir.
//!
//! The real-network/real-binary smoke test lives in `real_network.rs` and
//! gates on `DJ_YTDLP_SMOKE`.

mod common;

use dj_library::providers::youtube::{
    parse_extra_args, parse_progress_line, parse_search_line, YoutubeProvider,
};
use dj_library::{
    AcquireKind, AcquisitionHub, AcquisitionProvider, DownloadManager, DownloadState, Library,
    Query,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const FIXTURE: &str = include_str!("fixtures/youtube_search.jsonl");

fn fixture_results() -> Vec<dj_library::TrackResult> {
    FIXTURE
        .lines()
        .filter_map(|line| parse_search_line(line).unwrap())
        .collect()
}

// ---------------------------------------------------------------------------
// Parsing (fixtures)
// ---------------------------------------------------------------------------

#[test]
fn search_json_maps_to_track_results() {
    let results = fixture_results();
    // The live-stream entry is dropped: it is not a fetchable audio file.
    assert_eq!(results.len(), 3, "live entries are filtered out");

    let first = &results[0];
    assert_eq!(first.provider, "youtube");
    assert_eq!(first.acquire_kind, AcquireKind::Download);
    assert_eq!(first.id, "dQw4w9WgXcQ");
    assert_eq!(first.title, "Amen Break - 174 BPM Loop");
    assert_eq!(first.artist, "Breaks 4 Days");
    assert_eq!(first.duration_secs, Some(213.0));
    assert_eq!(
        first.deep_link_url.as_deref(),
        Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    );
    // Thumbnails: widest one up to 640 px (never the 1280 px still).
    assert_eq!(
        first.artwork_url.as_deref(),
        Some("https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg")
    );
    // YouTube uploads carry no machine-readable license in search output.
    assert_eq!(first.license.kind, "unknown");
    assert!(first.license.attribution.contains("Breaks 4 Days"));
    assert!(first.download_url.is_none(), "yt-dlp resolves the stream");

    // No `channel` key: the uploader name stands in, and the thumbnail
    // falls back to YouTube's stable per-video still.
    let long = &results[1];
    assert_eq!(long.artist, "Warehouse Sessions");
    assert_eq!(
        long.artwork_url.as_deref(),
        Some("https://i.ytimg.com/vi/longMix0001/hqdefault.jpg")
    );
}

#[test]
fn non_json_chatter_lines_are_ignored() {
    assert!(
        parse_search_line("[youtube:search] Extracting URL: ytsearch5:amen")
            .unwrap()
            .is_none()
    );
    assert!(parse_search_line("").unwrap().is_none());
    assert!(parse_search_line("{\"title\": \"no id\"}")
        .unwrap()
        .is_none());
    assert!(parse_search_line("{not json").is_err());
}

#[test]
fn progress_lines_parse_into_fractions_and_stages() {
    let p = parse_progress_line("[download]  45.5% of    3.55MiB at  1.23MiB/s ETA 00:03").unwrap();
    assert_eq!(p.fraction, Some(0.455));
    assert_eq!(p.stage, "downloading");

    let done = parse_progress_line("[download] 100% of 3.55MiB in 00:00:01 at 2.5MiB/s").unwrap();
    assert_eq!(done.fraction, Some(1.0));

    let start = parse_progress_line("[download] Destination: /tmp/x/Track [id].m4a").unwrap();
    assert_eq!(start.fraction, Some(0.0));

    assert_eq!(
        parse_progress_line("[ExtractAudio] Destination: /tmp/x/Track.mp3")
            .unwrap()
            .stage,
        "converting"
    );
    assert!(parse_progress_line("[youtube] abc: Downloading webpage").is_none());
    assert!(parse_progress_line("[download] Resuming download at byte 100").is_none());
}

#[test]
fn extra_args_split_on_whitespace() {
    assert_eq!(
        parse_extra_args("  --cookies-from-browser firefox  "),
        ["--cookies-from-browser", "firefox"]
    );
    assert!(parse_extra_args("").is_empty());
}

// ---------------------------------------------------------------------------
// Graceful degradation when yt-dlp is missing
// ---------------------------------------------------------------------------

#[test]
fn missing_binary_reports_an_install_hint() {
    let provider = YoutubeProvider::with_bin("dj-station-definitely-no-such-yt-dlp");
    let err = provider.search(&Query::new("amen break")).unwrap_err();
    let msg = format!("{err:#}");
    assert!(msg.contains("not found"), "{msg}");
    assert!(msg.contains("yt-dlp"), "{msg}");
    assert!(msg.contains("DJ_YTDLP_BIN"), "{msg}");
}

#[test]
fn failed_downloads_surface_on_the_job_without_killing_the_manager() {
    let tmp = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::open(&tmp.path().join("data")).unwrap());
    let hub = Arc::new(AcquisitionHub::new(vec![Box::new(
        YoutubeProvider::with_bin("dj-station-definitely-no-such-yt-dlp"),
    )]));
    let manager = DownloadManager::new(Arc::clone(&library), hub);

    let mut result = fixture_results().remove(0);
    result.title = "Broken".into();
    let id = manager.start(result);
    let job = wait_for_job(&manager, id);
    assert_eq!(job.state, DownloadState::Failed);
    assert!(job.error.unwrap().contains("yt-dlp"));
    assert!(library.tracks().unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// Full plumbing against a fake yt-dlp binary
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn fake_ytdlp(dir: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let fixture = dir.join("search.jsonl");
    std::fs::write(&fixture, FIXTURE).unwrap();
    let wav = dir.join("source.wav");
    common::write_test_wav(&wav, 440.0, 0.5);

    let script = dir.join("fake-yt-dlp");
    std::fs::write(
        &script,
        format!(
            r#"#!/bin/sh
# Fake yt-dlp: dumps the recorded search fixture, or "downloads" a WAV.
for arg in "$@"; do
  if [ "$arg" = "--dump-json" ]; then
    cat '{fixture}'
    exit 0
  fi
done
dir=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-P" ]; then dir="$arg"; fi
  prev="$arg"
done
echo "[youtube] shortClip01: Downloading webpage"
echo "warning: fake tool chatter on stderr" >&2
echo "[download] Destination: $dir/Vinyl Scratch Sample [shortClip01].m4a"
echo "[download]  45.5% of    1.00MiB at    1.00MiB/s ETA 00:01"
: > "$dir/Vinyl Scratch Sample [shortClip01].m4a.part"
cp '{wav}' "$dir/Vinyl Scratch Sample [shortClip01].wav"
echo "[download] 100% of    1.00MiB in 00:00:01 at 1.00MiB/s"
"#,
            fixture = fixture.display(),
            wav = wav.display(),
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

#[cfg(unix)]
#[test]
fn search_shells_out_to_the_binary_and_applies_the_length_filter() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = YoutubeProvider::with_bin(&fake_ytdlp(tmp.path()).to_string_lossy());

    let all = provider.search(&Query::new("amen break")).unwrap();
    assert_eq!(all.len(), 3);

    let short = provider
        .search(&Query::new("amen break").with_filter("length", "short"))
        .unwrap();
    assert_eq!(short.len(), 2, "under 4 minutes: 213 s and 42 s");

    let long = provider
        .search(&Query::new("amen break").with_filter("length", "long"))
        .unwrap();
    assert_eq!(long.len(), 1);
    assert_eq!(long[0].id, "longMix0001");

    // Empty queries never spawn the tool.
    assert!(provider.search(&Query::new("   ")).unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn downloading_a_result_imports_it_as_an_ordinary_library_track() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = fake_ytdlp(tmp.path());
    let library = Arc::new(Library::open(&tmp.path().join("data")).unwrap());
    let hub = Arc::new(AcquisitionHub::new(vec![Box::new(
        YoutubeProvider::with_bin(&bin.to_string_lossy()),
    )]));
    let manager = DownloadManager::new(Arc::clone(&library), Arc::clone(&hub));

    let results = hub
        .search_provider("youtube", &Query::new("scratch"))
        .unwrap();
    let result = results
        .iter()
        .find(|r| r.id == "shortClip01")
        .expect("fixture entry");

    let id = manager.start(result.clone());
    let job = wait_for_job(&manager, id);
    assert_eq!(job.state, DownloadState::Done, "error: {:?}", job.error);
    assert_eq!(job.fraction, Some(1.0));
    assert_eq!(job.provider, "youtube");
    assert_eq!(job.result_id, "shortClip01");

    let tracks = library.tracks().unwrap();
    assert_eq!(tracks.len(), 1);
    let track = &tracks[0];
    assert_eq!(job.track_id, Some(track.id));
    assert_eq!(track.source, "youtube");
    assert_eq!(track.source_ref, "shortClip01");
    assert_eq!(track.title, "Vinyl Scratch Sample");
    assert_eq!(track.artist, "Turntable Lab");
    assert_eq!(track.license.kind, "unknown");
    // Analyzable/loadable like any other track: real audio in the
    // library's downloads dir, queued for analysis.
    assert_eq!(track.analysis_status, "queued");
    assert!(track.duration_secs.unwrap() > 0.0);
    let path = PathBuf::from(&track.file_path);
    assert!(path.starts_with(library.downloads_dir().canonicalize().unwrap()));
    assert!(path.exists());

    // The staging dir (and yt-dlp's `.part` leftovers) are cleaned up.
    let leftovers: Vec<_> = std::fs::read_dir(library.downloads_dir())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with(".yt-") || name.ends_with(".part"))
        .collect();
    assert!(leftovers.is_empty(), "left behind: {leftovers:?}");
}

fn wait_for_job(manager: &DownloadManager, id: u64) -> dj_library::DownloadJob {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let job = manager
            .jobs()
            .into_iter()
            .find(|j| j.id == id)
            .expect("job exists");
        if !job.is_running() {
            return job;
        }
        assert!(Instant::now() < deadline, "download job never finished");
        std::thread::sleep(Duration::from_millis(20));
    }
}
