//! Acquisition provider tests against local mock HTTP servers (mockito),
//! exercising the real client code paths: search fan-out, source/license
//! tagging, preview URL resolution, direct download into the library, and
//! iTunes deep-link dispatch.
//!
//! Real-network variants live in `real_network.rs`.

mod common;

use dj_library::providers::{
    FreesoundProvider, InternetArchiveProvider, ItunesProvider, JamendoProvider,
};
use dj_library::{
    Acquire, AcquireKind, AcquisitionHub, AcquisitionProvider, Library, ProviderInfo, Query,
    TrackResult,
};
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// Mock fixtures
// ---------------------------------------------------------------------------

fn itunes_search_body() -> String {
    serde_json::json!({
        "resultCount": 2,
        "results": [
            {
                "trackId": 1_440_764_401_u64,
                "trackName": "Harder, Better, Faster, Stronger",
                "artistName": "Daft Punk",
                "collectionName": "Discovery",
                "trackTimeMillis": 224_693,
                "previewUrl": "PREVIEW_URL",
                "artworkUrl100": "https://example.com/art.jpg",
                "trackViewUrl": "https://music.apple.com/us/album/harder-better-faster-stronger/1440764111?i=1440764401&uo=4"
            },
            {
                "trackId": 2u64,
                "trackName": "One More Time",
                "artistName": "Daft Punk",
                "collectionName": "Discovery",
                "trackTimeMillis": 320_357,
                "previewUrl": "PREVIEW_URL",
                "artworkUrl100": "https://example.com/art2.jpg",
                "trackViewUrl": "https://music.apple.com/us/album/one-more-time/1?i=2"
            }
        ]
    })
    .to_string()
}

fn freesound_search_body(base: &str) -> String {
    serde_json::json!({
        "count": 1,
        "results": [{
            "id": 123456,
            "name": "amen break 174bpm",
            "username": "breaks4days",
            "license": "https://creativecommons.org/licenses/by/4.0/",
            "duration": 1.38,
            "previews": {
                "preview-hq-mp3": format!("{base}/data/previews/123/123456_1-hq.mp3")
            },
            "download": format!("{base}/apiv2/sounds/123456/download/"),
            "images": { "waveform_m": format!("{base}/data/waveform.png") }
        }]
    })
    .to_string()
}

fn jamendo_search_body(base: &str) -> String {
    serde_json::json!({
        "headers": { "status": "success", "code": 0, "results_count": 1 },
        "results": [{
            "id": "168",
            "name": "J'm'e FPM",
            "artist_name": "TriFace",
            "album_name": "Premiers Jets",
            "duration": 183,
            "license_ccurl": "http://creativecommons.org/licenses/by-nc-sa/3.0/",
            "audio": format!("{base}/track/168/mp32/"),
            "audiodownload": format!("{base}/download/track/168/mp32/"),
            "shareurl": "https://www.jamendo.com/track/168",
            "image": format!("{base}/img/168.jpg")
        }]
    })
    .to_string()
}

fn ia_search_body() -> String {
    serde_json::json!({
        "response": {
            "numFound": 1,
            "docs": [{
                "identifier": "gd1977-05-08",
                "title": "Grateful Dead Live at Barton Hall",
                "creator": "Grateful Dead",
                "licenseurl": "https://creativecommons.org/publicdomain/zero/1.0/"
            }]
        }
    })
    .to_string()
}

fn ia_metadata_body() -> String {
    serde_json::json!({
        "files": [
            { "name": "gd77-05-08.txt", "format": "Text" },
            { "name": "gd77-05-08d1t01.flac", "format": "Flac" },
            { "name": "gd77-05-08d1t01.mp3", "format": "VBR MP3" }
        ]
    })
    .to_string()
}

/// Bytes served as the "MP3" download (content only needs to be stable;
/// import metadata probing is best-effort).
const FAKE_MP3: &[u8] = b"ID3FAKE-MP3-BYTES-FOR-TESTING-0123456789";

// ---------------------------------------------------------------------------
// iTunes: search tags + preview resolution + deep link (M1 acceptance #2/#4)
// ---------------------------------------------------------------------------

#[test]
fn itunes_search_results_carry_source_license_and_resolvable_preview() {
    let mut server = mockito::Server::new();
    let preview_url = format!("{}/preview/track1.m4a", server.url());
    let _search = server
        .mock("GET", "/search")
        .match_query(mockito::Matcher::AllOf(vec![
            mockito::Matcher::UrlEncoded("term".into(), "daft punk".into()),
            mockito::Matcher::UrlEncoded("media".into(), "music".into()),
            mockito::Matcher::UrlEncoded("entity".into(), "song".into()),
        ]))
        .with_header("content-type", "application/json")
        .with_body(itunes_search_body().replace("PREVIEW_URL", &preview_url))
        .create();
    let _preview = server
        .mock("GET", "/preview/track1.m4a")
        .with_header("content-type", "audio/mp4")
        .with_body(b"fake-aac-preview".as_slice())
        .expect_at_least(1)
        .create();

    let provider = ItunesProvider::with_base_url(&server.url());
    let results = provider.search(&Query::new("daft punk")).unwrap();
    assert_eq!(results.len(), 2);
    let r = &results[0];
    assert_eq!(r.provider, "itunes");
    assert_eq!(r.title, "Harder, Better, Faster, Stronger");
    assert_eq!(r.artist, "Daft Punk");
    assert_eq!(r.license.kind, "commercial", "results carry a license tag");
    assert_eq!(r.acquire_kind, AcquireKind::DeepLink);
    assert!((r.duration_secs.unwrap() - 224.693).abs() < 1e-6);

    // Preview URL resolves (fetch it from the mock server).
    let resp = ureq::get(r.preview_url.as_ref().unwrap()).call().unwrap();
    assert_eq!(resp.status(), 200);
    _preview.assert();
}

#[test]
fn itunes_result_dispatches_deep_link_to_the_store_url() {
    let mut server = mockito::Server::new();
    let _search = server
        .mock("GET", "/search")
        .match_query(mockito::Matcher::Any)
        .with_header("content-type", "application/json")
        .with_body(itunes_search_body())
        .create();

    let hub = AcquisitionHub::new(vec![Box::new(ItunesProvider::with_base_url(&server.url()))]);
    let results = hub.search(&Query::new("daft punk")).results;
    let track = &results[0];

    // The [A] criterion: correct store URL construction + dispatch (no real
    // browser in headless CI — the dispatcher records what it would open).
    let opened: Mutex<Vec<String>> = Mutex::new(vec![]);
    let url = hub
        .open_deep_link(track, |u| {
            opened.lock().unwrap().push(u.to_string());
            Ok(())
        })
        .unwrap();
    assert_eq!(
        url,
        "https://music.apple.com/us/album/harder-better-faster-stronger/1440764111?i=1440764401&uo=4"
    );
    assert_eq!(
        opened.lock().unwrap().as_slice(),
        std::slice::from_ref(&url)
    );

    // And it is a DeepLink, not a direct download.
    assert!(matches!(
        hub.acquire(track).unwrap(),
        Acquire::DeepLink { .. }
    ));
}

// ---------------------------------------------------------------------------
// Freesound: search + authenticated download into the library (M1 #3)
// ---------------------------------------------------------------------------

#[test]
fn freesound_result_downloads_directly_into_the_library() {
    let mut server = mockito::Server::new();
    let _search = server
        .mock("GET", "/apiv2/search/text/")
        .match_query(mockito::Matcher::AllOf(vec![
            mockito::Matcher::UrlEncoded("query".into(), "amen break".into()),
            mockito::Matcher::UrlEncoded("token".into(), "test-key".into()),
        ]))
        .with_header("content-type", "application/json")
        .with_body(freesound_search_body(&server.url()))
        .create();
    let download = server
        .mock("GET", "/data/previews/123/123456_1-hq.mp3")
        // The real client sends token auth on downloads.
        .match_header("Authorization", "Token test-key")
        .with_header("content-type", "audio/mpeg")
        .with_body(FAKE_MP3)
        .create();

    let tmp = tempfile::tempdir().unwrap();
    let lib = Library::open(&tmp.path().join("data")).unwrap();
    let hub = AcquisitionHub::new(vec![Box::new(FreesoundProvider::with_base_url(
        "test-key",
        &server.url(),
    ))]);

    let results = hub.search(&Query::new("amen break")).results;
    assert_eq!(results.len(), 1);
    let r = &results[0];
    assert_eq!(r.provider, "freesound");
    assert_eq!(r.license.kind, "cc-by");
    assert!(r.license.attribution.contains("breaks4days"));

    let track = hub.download_to_library(&lib, r).unwrap();
    download.assert();
    assert_eq!(track.source, "freesound");
    assert_eq!(track.source_ref, "123456");
    assert_eq!(track.license.kind, "cc-by");
    assert_eq!(track.title, "amen break 174bpm");
    // The file physically landed in the library's downloads dir.
    let path = std::path::PathBuf::from(&track.file_path);
    assert!(path.starts_with(lib.downloads_dir().canonicalize().unwrap()));
    assert_eq!(std::fs::read(&path).unwrap(), FAKE_MP3);
    // And persists in the DB.
    assert_eq!(lib.tracks().unwrap().len(), 1);
}

// ---------------------------------------------------------------------------
// Jamendo: search + download into the library (M1 #3)
// ---------------------------------------------------------------------------

#[test]
fn jamendo_result_downloads_directly_into_the_library() {
    let mut server = mockito::Server::new();
    let _search = server
        .mock("GET", "/v3.0/tracks/")
        .match_query(mockito::Matcher::AllOf(vec![
            mockito::Matcher::UrlEncoded("client_id".into(), "test-client".into()),
            mockito::Matcher::UrlEncoded("search".into(), "triface".into()),
        ]))
        .with_header("content-type", "application/json")
        .with_body(jamendo_search_body(&server.url()))
        .create();
    let download = server
        .mock("GET", "/download/track/168/mp32/")
        .with_header("content-type", "audio/mpeg")
        .with_body(FAKE_MP3)
        .create();

    let tmp = tempfile::tempdir().unwrap();
    let lib = Library::open(&tmp.path().join("data")).unwrap();
    let hub = AcquisitionHub::new(vec![Box::new(JamendoProvider::with_base_url(
        "test-client",
        &server.url(),
    ))]);

    let results = hub.search(&Query::new("triface")).results;
    assert_eq!(results.len(), 1);
    let r = &results[0];
    assert_eq!(r.provider, "jamendo");
    assert_eq!(r.license.kind, "cc-by-nc-sa");

    let track = hub.download_to_library(&lib, r).unwrap();
    download.assert();
    assert_eq!(track.source, "jamendo");
    assert_eq!(track.title, "J'm'e FPM");
    assert_eq!(track.artist, "TriFace");
    assert_eq!(track.license.kind, "cc-by-nc-sa");
    assert_eq!(lib.tracks().unwrap().len(), 1);
}

// ---------------------------------------------------------------------------
// Internet Archive: search + metadata-resolved download
// ---------------------------------------------------------------------------

#[test]
fn internet_archive_resolves_best_audio_file_and_downloads() {
    let mut server = mockito::Server::new();
    let _search = server
        .mock("GET", "/advancedsearch.php")
        // IA searches are always restricted to Creative Commons material.
        .match_query(mockito::Matcher::UrlEncoded(
            "q".into(),
            "(grateful dead 1977) AND mediatype:(audio) AND licenseurl:(*creativecommons.org*)"
                .into(),
        ))
        .with_header("content-type", "application/json")
        .with_body(ia_search_body())
        .create();
    let _meta = server
        .mock("GET", "/metadata/gd1977-05-08")
        .with_header("content-type", "application/json")
        .with_body(ia_metadata_body())
        .create();
    let download = server
        .mock("GET", "/download/gd1977-05-08/gd77-05-08d1t01.mp3")
        .with_header("content-type", "audio/mpeg")
        .with_body(FAKE_MP3)
        .create();

    let tmp = tempfile::tempdir().unwrap();
    let lib = Library::open(&tmp.path().join("data")).unwrap();
    let hub = AcquisitionHub::new(vec![Box::new(InternetArchiveProvider::with_base_url(
        &server.url(),
    ))]);

    let results = hub.search(&Query::new("grateful dead 1977")).results;
    assert_eq!(results.len(), 1);
    let r = &results[0];
    assert_eq!(r.provider, "internet_archive");
    assert_eq!(r.license.kind, "cc0");
    // IA's download URL is only resolved at acquire time, so the result
    // must still declare itself a Download (the UI branches on this — a
    // deep-link/"store" action would fail for IA).
    assert_eq!(r.acquire_kind, AcquireKind::Download);
    assert!(r.download_url.is_none());

    // acquire() picks the MP3 over FLAC/Text via the metadata API.
    match hub.acquire(r).unwrap() {
        Acquire::Download { url, filename, .. } => {
            assert!(url.ends_with("/download/gd1977-05-08/gd77-05-08d1t01.mp3"));
            assert_eq!(filename, "gd77-05-08d1t01.mp3");
        }
        other => panic!("expected Download, got {other:?}"),
    }

    let track = hub.download_to_library(&lib, r).unwrap();
    download.assert();
    assert_eq!(track.source, "internet_archive");
    assert_eq!(track.license.kind, "cc0");
}

// ---------------------------------------------------------------------------
// Unified fan-out (M1 acceptance #2)
// ---------------------------------------------------------------------------

#[test]
fn unified_search_fans_out_across_enabled_providers_and_isolates_failures() {
    let mut itunes_srv = mockito::Server::new();
    let mut freesound_srv = mockito::Server::new();
    let mut jamendo_srv = mockito::Server::new();
    let mut ia_srv = mockito::Server::new();

    let _m1 = itunes_srv
        .mock("GET", "/search")
        .match_query(mockito::Matcher::Any)
        .with_body(itunes_search_body())
        .create();
    let _m2 = freesound_srv
        .mock("GET", "/apiv2/search/text/")
        .match_query(mockito::Matcher::Any)
        .with_body(freesound_search_body(&freesound_srv.url()))
        .create();
    let _m3 = jamendo_srv
        .mock("GET", "/v3.0/tracks/")
        .match_query(mockito::Matcher::Any)
        .with_body(jamendo_search_body(&jamendo_srv.url()))
        .create();
    // Internet Archive is down: its failure must not break the fan-out.
    let _m4 = ia_srv
        .mock("GET", "/advancedsearch.php")
        .match_query(mockito::Matcher::Any)
        .with_status(500)
        .create();

    let hub = AcquisitionHub::new(vec![
        Box::new(ItunesProvider::with_base_url(&itunes_srv.url())),
        Box::new(FreesoundProvider::with_base_url("k", &freesound_srv.url())),
        Box::new(JamendoProvider::with_base_url("c", &jamendo_srv.url())),
        Box::new(InternetArchiveProvider::with_base_url(&ia_srv.url())),
    ]);
    assert_eq!(
        hub.provider_ids(),
        vec!["itunes", "freesound", "jamendo", "internet_archive"]
    );

    let outcome = hub.search(&Query::new("anything"));
    // Every result is tagged by source and license.
    let sources: std::collections::BTreeSet<&str> = outcome
        .results
        .iter()
        .map(|r| r.provider.as_str())
        .collect();
    assert_eq!(
        sources,
        ["freesound", "itunes", "jamendo"].into_iter().collect()
    );
    for r in &outcome.results {
        assert!(!r.license.kind.is_empty(), "missing license tag on {r:?}");
    }
    // The failing provider is reported, not fatal.
    assert_eq!(outcome.errors.len(), 1);
    assert_eq!(outcome.errors[0].0, "internet_archive");
}

#[test]
fn hub_from_env_enables_keyed_providers_only_with_keys() {
    // Note: mutates process env; keep assertions self-contained.
    std::env::remove_var("FREESOUND_API_KEY");
    std::env::remove_var("JAMENDO_CLIENT_ID");
    let hub = AcquisitionHub::from_env();
    // YouTube is keyless (yt-dlp), so it is always in the list — a missing
    // binary is reported when the user searches, not by hiding the tab.
    assert_eq!(
        hub.provider_ids(),
        vec!["itunes", "internet_archive", "youtube"]
    );

    std::env::set_var("FREESOUND_API_KEY", "k");
    std::env::set_var("JAMENDO_CLIENT_ID", "c");
    let hub = AcquisitionHub::from_env();
    assert_eq!(
        hub.provider_ids(),
        vec![
            "itunes",
            "internet_archive",
            "youtube",
            "freesound",
            "jamendo"
        ]
    );
    std::env::remove_var("FREESOUND_API_KEY");
    std::env::remove_var("JAMENDO_CLIENT_ID");
}

// ---------------------------------------------------------------------------
// Background download jobs (progress off the caller's thread)
// ---------------------------------------------------------------------------

#[test]
fn http_downloads_run_as_background_jobs_with_progress() {
    let mut server = mockito::Server::new();
    let _search = server
        .mock("GET", "/v3.0/tracks/")
        .match_query(mockito::Matcher::Any)
        .with_body(jamendo_search_body(&server.url()))
        .create();
    let _download = server
        .mock("GET", "/download/track/168/mp32/")
        .with_body(FAKE_MP3)
        .create();

    let tmp = tempfile::tempdir().unwrap();
    let lib = std::sync::Arc::new(Library::open(&tmp.path().join("data")).unwrap());
    let hub = std::sync::Arc::new(AcquisitionHub::new(vec![Box::new(
        JamendoProvider::with_base_url("c", &server.url()),
    )]));
    let manager = dj_library::DownloadManager::new(lib.clone(), hub.clone());

    let result = hub.search(&Query::new("triface")).results.remove(0);
    let id = manager.start(result);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let job = loop {
        let job = manager
            .jobs()
            .into_iter()
            .find(|j| j.id == id)
            .expect("job exists");
        if !job.is_running() {
            break job;
        }
        assert!(std::time::Instant::now() < deadline, "job never finished");
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    assert_eq!(
        job.state,
        dj_library::DownloadState::Done,
        "{:?}",
        job.error
    );
    // Content-Length is known, so the HTTP fetch reports real fractions.
    assert_eq!(job.fraction, Some(1.0));
    assert_eq!(job.title, "J'm'e FPM");
    assert_eq!(job.track_id, Some(lib.tracks().unwrap()[0].id));
}

// ---------------------------------------------------------------------------
// Download dedup: same content twice -> one library row
// ---------------------------------------------------------------------------

#[test]
fn downloading_the_same_content_twice_deduplicates() {
    let mut server = mockito::Server::new();
    let _search = server
        .mock("GET", "/v3.0/tracks/")
        .match_query(mockito::Matcher::Any)
        .with_body(jamendo_search_body(&server.url()))
        .create();
    let _download = server
        .mock("GET", "/download/track/168/mp32/")
        .with_body(FAKE_MP3)
        .expect_at_least(2)
        .create();

    let tmp = tempfile::tempdir().unwrap();
    let lib = Library::open(&tmp.path().join("data")).unwrap();
    let hub = AcquisitionHub::new(vec![Box::new(JamendoProvider::with_base_url(
        "c",
        &server.url(),
    ))]);
    let r: TrackResult = hub.search(&Query::new("x")).results[0].clone();
    let first = hub.download_to_library(&lib, &r).unwrap();
    let second = hub.download_to_library(&lib, &r).unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(lib.tracks().unwrap().len(), 1);
    // The duplicate file itself was cleaned up.
    let files: Vec<_> = std::fs::read_dir(lib.downloads_dir())
        .unwrap()
        .filter_map(|e| e.ok())
        .collect();
    assert_eq!(files.len(), 1, "duplicate download not cleaned up");
}

// ---------------------------------------------------------------------------
// Provider filters: declared UI specs + mapping onto each store's API params
// ---------------------------------------------------------------------------

fn filter_ids(p: &ProviderInfo) -> Vec<&str> {
    p.filters.iter().map(|f| f.id.as_str()).collect()
}

#[test]
fn providers_declare_ui_filters_and_kinds() {
    let hub = AcquisitionHub::new(vec![
        Box::new(ItunesProvider::new()),
        Box::new(InternetArchiveProvider::new()),
        Box::new(FreesoundProvider::new("k")),
        Box::new(JamendoProvider::new("c")),
        Box::new(dj_library::providers::YoutubeProvider::new()),
    ]);
    let info = hub.providers_info();
    let by_id = |id: &str| info.iter().find(|p| p.id == id).unwrap();

    let itunes = by_id("itunes");
    assert_eq!(itunes.acquire_kind, AcquireKind::DeepLink);
    assert_eq!(filter_ids(itunes), ["country", "explicit"]);

    let ia = by_id("internet_archive");
    assert_eq!(ia.acquire_kind, AcquireKind::Download);
    assert_eq!(filter_ids(ia), ["collection", "sort"]);

    assert_eq!(
        filter_ids(by_id("freesound")),
        ["license", "max_duration", "sort"]
    );
    assert_eq!(
        filter_ids(by_id("jamendo")),
        ["order", "vocalinstrumental", "speed"]
    );

    let youtube = by_id("youtube");
    assert_eq!(youtube.acquire_kind, AcquireKind::Download);
    assert_eq!(filter_ids(youtube), ["sort", "length"]);

    // Every filter is select-style with the "any" default first, so the UI
    // can render them blindly.
    for p in &info {
        for f in &p.filters {
            assert!(!f.label.is_empty());
            assert!(f.options.len() >= 2, "{}:{} needs choices", p.id, f.id);
            assert_eq!(f.options[0].value, "", "{}:{} default first", p.id, f.id);
        }
    }
}

#[test]
fn filter_selections_map_to_store_api_params() {
    use mockito::Matcher::{AllOf, UrlEncoded};
    let mut server = mockito::Server::new();

    // iTunes: storefront country + explicit toggle.
    let itunes = server
        .mock("GET", "/search")
        .match_query(AllOf(vec![
            UrlEncoded("term".into(), "daft punk".into()),
            UrlEncoded("country".into(), "gb".into()),
            UrlEncoded("explicit".into(), "No".into()),
        ]))
        .with_body(r#"{"resultCount":0,"results":[]}"#)
        .create();
    ItunesProvider::with_base_url(&server.url())
        .search(
            &Query::new("daft punk")
                .with_filter("country", "gb")
                .with_filter("explicit", "No"),
        )
        .unwrap();
    itunes.assert();

    // Internet Archive: collection joins the CC-restricted query; sort is
    // passed through.
    let ia = server
        .mock("GET", "/advancedsearch.php")
        .match_query(AllOf(vec![
            UrlEncoded(
                "q".into(),
                "(dub) AND mediatype:(audio) AND licenseurl:(*creativecommons.org*) \
                 AND collection:(etree)"
                    .into(),
            ),
            UrlEncoded("sort[]".into(), "downloads desc".into()),
        ]))
        .with_body(r#"{"response":{"numFound":0,"docs":[]}}"#)
        .create();
    InternetArchiveProvider::with_base_url(&server.url())
        .search(
            &Query::new("dub")
                .with_filter("collection", "etree")
                .with_filter("sort", "downloads desc"),
        )
        .unwrap();
    ia.assert();

    // Freesound: license + max duration become Solr filter clauses; sort is
    // a plain param.
    let freesound = server
        .mock("GET", "/apiv2/search/text/")
        .match_query(AllOf(vec![
            UrlEncoded(
                "filter".into(),
                "license:\"Creative Commons 0\" duration:[0 TO 30]".into(),
            ),
            UrlEncoded("sort".into(), "downloads_desc".into()),
        ]))
        .with_body(r#"{"count":0,"results":[]}"#)
        .create();
    FreesoundProvider::with_base_url("test-key", &server.url())
        .search(
            &Query::new("kick")
                .with_filter("license", "Creative Commons 0")
                .with_filter("max_duration", "30")
                .with_filter("sort", "downloads_desc"),
        )
        .unwrap();
    freesound.assert();

    // Jamendo: order / vocals / tempo pass through directly.
    let jamendo = server
        .mock("GET", "/v3.0/tracks/")
        .match_query(AllOf(vec![
            UrlEncoded("order".into(), "releasedate_desc".into()),
            UrlEncoded("vocalinstrumental".into(), "instrumental".into()),
            UrlEncoded("speed".into(), "high".into()),
        ]))
        .with_body(r#"{"headers":{},"results":[]}"#)
        .create();
    JamendoProvider::with_base_url("test-client", &server.url())
        .search(
            &Query::new("techno")
                .with_filter("order", "releasedate_desc")
                .with_filter("vocalinstrumental", "instrumental")
                .with_filter("speed", "high"),
        )
        .unwrap();
    jamendo.assert();
}

#[test]
fn search_provider_targets_a_single_store() {
    let mut server = mockito::Server::new();
    let itunes_mock = server
        .mock("GET", "/search")
        .match_query(mockito::Matcher::Any)
        .with_body(itunes_search_body())
        .create();
    // No IA mock: hitting IA here would fail the search.
    let hub = AcquisitionHub::new(vec![
        Box::new(ItunesProvider::with_base_url(&server.url())),
        Box::new(InternetArchiveProvider::with_base_url(&server.url())),
    ]);

    let results = hub
        .search_provider("itunes", &Query::new("daft punk"))
        .unwrap();
    assert_eq!(results.len(), 2);
    assert!(results.iter().all(|r| r.provider == "itunes"));
    itunes_mock.assert();

    assert!(hub
        .search_provider("musopen", &Query::new("x"))
        .unwrap_err()
        .to_string()
        .contains("not enabled"));
}
