//! Optional real-network smoke tests.
//!
//! - Keyless APIs (iTunes Search, Internet Archive) run by default but
//!   soft-skip on any network failure so CI stays deterministic; the
//!   authoritative CI coverage is the mock-server suite in `providers.rs`.
//! - Freesound/Jamendo real-network tests are gated on their env keys
//!   (`FREESOUND_API_KEY`, `JAMENDO_CLIENT_ID`) and skip when absent.

use dj_library::providers::{FreesoundProvider, ItunesProvider, JamendoProvider};
use dj_library::{AcquisitionProvider, Query};

macro_rules! skip_on_network_error {
    ($res:expr, $what:expr) => {
        match $res {
            Ok(v) => v,
            Err(e) => {
                eprintln!("SKIP {}: network unavailable or API error: {e:#}", $what);
                return;
            }
        }
    };
}

#[test]
fn itunes_real_search_smoke() {
    let provider = ItunesProvider::new();
    let results = skip_on_network_error!(
        provider.search(&Query::new("daft punk")),
        "itunes_real_search_smoke"
    );
    if results.is_empty() {
        eprintln!("SKIP itunes_real_search_smoke: empty result set");
        return;
    }
    let r = &results[0];
    assert_eq!(r.provider, "itunes");
    assert_eq!(r.license.kind, "commercial");
    assert!(r
        .deep_link_url
        .as_deref()
        .unwrap_or("")
        .contains("apple.com"));
    assert!(r.preview_url.is_some(), "iTunes results carry 30s previews");
}

#[test]
fn internet_archive_real_search_smoke() {
    use dj_library::providers::InternetArchiveProvider;
    let provider = InternetArchiveProvider::new();
    let results = skip_on_network_error!(
        provider.search(&Query::new("grateful dead 1977 cornell")),
        "internet_archive_real_search_smoke"
    );
    if results.is_empty() {
        eprintln!("SKIP internet_archive_real_search_smoke: empty result set");
        return;
    }
    assert_eq!(results[0].provider, "internet_archive");
    assert!(!results[0].id.is_empty());
}

#[test]
fn freesound_real_search_smoke_gated_on_key() {
    // CI passes secrets through unconditionally, so an unconfigured secret
    // arrives as an empty string — treat that the same as unset.
    let key = match std::env::var("FREESOUND_API_KEY") {
        Ok(k) if !k.trim().is_empty() => k,
        _ => {
            eprintln!("SKIP freesound_real_search_smoke: FREESOUND_API_KEY not set");
            return;
        }
    };
    let provider = FreesoundProvider::new(&key);
    let results = skip_on_network_error!(
        provider.search(&Query::new("amen break")),
        "freesound_real_search_smoke"
    );
    assert!(!results.is_empty());
    assert_eq!(results[0].provider, "freesound");
    assert!(results[0].download_url.is_some());
}

/// Real YouTube search through a real `yt-dlp`. Gated on `DJ_YTDLP_SMOKE`
/// (unset/empty ⇒ skip) so CI never depends on the binary or the network;
/// the offline coverage is `youtube.rs` (fixtures + fake binary).
#[test]
fn youtube_real_search_smoke_gated_on_env() {
    use dj_library::providers::YoutubeProvider;

    match std::env::var("DJ_YTDLP_SMOKE") {
        Ok(v) if !v.trim().is_empty() => {}
        _ => {
            eprintln!("SKIP youtube_real_search_smoke: DJ_YTDLP_SMOKE not set");
            return;
        }
    }
    let provider = YoutubeProvider::new();
    let mut query = Query::new("amen break");
    query.limit = 3;
    let results = skip_on_network_error!(provider.search(&query), "youtube_real_search_smoke");
    if results.is_empty() {
        eprintln!("SKIP youtube_real_search_smoke: empty result set");
        return;
    }
    let r = &results[0];
    assert_eq!(r.provider, "youtube");
    assert!(!r.title.is_empty());
    assert!(r
        .deep_link_url
        .as_deref()
        .unwrap_or("")
        .contains("youtube.com/watch"));
    assert!(r.artwork_url.is_some(), "results carry a thumbnail");
}

#[test]
fn jamendo_real_search_smoke_gated_on_key() {
    let id = match std::env::var("JAMENDO_CLIENT_ID") {
        Ok(i) if !i.trim().is_empty() => i,
        _ => {
            eprintln!("SKIP jamendo_real_search_smoke: JAMENDO_CLIENT_ID not set");
            return;
        }
    };
    let provider = JamendoProvider::new(&id);
    let results = skip_on_network_error!(
        provider.search(&Query::new("electronic")),
        "jamendo_real_search_smoke"
    );
    assert!(!results.is_empty());
    assert_eq!(results[0].provider, "jamendo");
    assert!(results[0].download_url.is_some());
}
