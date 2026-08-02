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
    let Ok(key) = std::env::var("FREESOUND_API_KEY") else {
        eprintln!("SKIP freesound_real_search_smoke: FREESOUND_API_KEY not set");
        return;
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

#[test]
fn jamendo_real_search_smoke_gated_on_key() {
    let Ok(id) = std::env::var("JAMENDO_CLIENT_ID") else {
        eprintln!("SKIP jamendo_real_search_smoke: JAMENDO_CLIENT_ID not set");
        return;
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
