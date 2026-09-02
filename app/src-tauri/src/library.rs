//! Library + acquisition IPC (M1): the track library, provider search
//! and downloads, watch folders, and the Playback/Audio modules' track
//! loading — everything the Library page and the track-playing panels
//! call.

use dj_engine::audio::AudioStatus;
use dj_library::{ProviderInfo, Query, Track, TrackResult};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::{engine_lock, err, patch_edit, AppState, CmdError, CmdResult, EditKey};

#[tauri::command]
pub(crate) fn library_tracks(state: State<AppState>) -> CmdResult<Vec<Track>> {
    state.library.tracks().map_err(err)
}

#[tauri::command]
pub(crate) fn library_search(state: State<AppState>, text: String) -> CmdResult<Vec<Track>> {
    state.library.search(&text).map_err(err)
}

/// Enabled acquisition providers with their UI filter specs (per-store
/// search tabs).
#[tauri::command]
pub(crate) fn providers(state: State<AppState>) -> CmdResult<Vec<ProviderInfo>> {
    Ok(state.hub.providers_info())
}

/// Search one store, with that store's filter selections. Runs on a
/// worker thread (`async`): a provider search is a network round-trip, and
/// the YouTube one spawns yt-dlp — neither may block the main thread.
#[tauri::command(async)]
pub(crate) fn search_provider(
    state: State<AppState>,
    provider: String,
    text: String,
    filters: BTreeMap<String, String>,
) -> CmdResult<Vec<TrackResult>> {
    let mut q = Query::new(&text);
    q.filters = filters;
    state.hub.search_provider(&provider, &q).map_err(err)
}

#[tauri::command]
pub(crate) fn import_track(state: State<AppState>, path: String) -> CmdResult<Track> {
    state
        .library
        .import_file(&PathBuf::from(path), dj_library::ImportOptions::default())
        .map(|o| o.track().clone())
        .map_err(err)
}

/// Rename a track (Library page): title and artist only — everything
/// else about the row is derived from the file or the analysis.
#[tauri::command]
pub(crate) fn set_track_names(
    state: State<AppState>,
    track_id: i64,
    title: String,
    artist: String,
) -> CmdResult<Track> {
    state
        .library
        .set_track_names(track_id, &title, &artist)
        .map_err(err)
}

/// Delete a track and everything the app derived from it: the row with
/// its DJ metadata (cues, loops, beatgrid, tags, crate membership), the
/// stem cache keyed by its content, the Clip page's decoded copy, and the
/// audio file itself when the app owns it (a provider download or a
/// rendered clip — a file in the user's own folders always stays).
///
/// It does NOT chase the references pointing AT the track: a beat clip's
/// source and a saved patch's deck each name a track that may already be
/// gone, and each degrades on its own (a clip keeps its audio and says
/// its source is unknown, a patch load warns and comes up without the
/// track).
#[tauri::command]
pub(crate) fn delete_track(state: State<AppState>, track_id: i64) -> CmdResult<dj_library::DeletedTrack> {
    // A separation in flight would write stems back into the cache we are
    // about to remove, so stop it before the row goes.
    state.stems.cancel_track(track_id);
    let deleted = state.library.delete_track(track_id).map_err(err)?;
    state.clips.forget(track_id);
    let hash = &deleted.track.content_hash;
    if let Err(e) = dj_analysis::remove_stems(state.library.data_dir(), hash) {
        eprintln!("[dj-analysis] removing stems for {hash}: {e:#}");
    }
    Ok(deleted)
}

#[derive(Serialize)]
pub(crate) struct RekordboxImportSummary {
    imported: usize,
    duplicates: usize,
}

/// Import a rekordbox XML export (M4, PRD §8.1): tracks, beatgrids, hot
/// cues, and loops land in the library DB; existing tracks (by path) skip.
#[tauri::command]
pub(crate) fn import_rekordbox(state: State<AppState>, path: String) -> CmdResult<RekordboxImportSummary> {
    let report = state
        .library
        .import_rekordbox_xml(Path::new(&path))
        .map_err(err)?;
    Ok(RekordboxImportSummary {
        imported: report.imported.len(),
        duplicates: report.duplicates.len(),
    })
}

/// Start acquiring a result in the background and return the job id. The
/// transfer never runs on this thread: yt-dlp fetches take seconds to
/// minutes, and even HTTP downloads would stall the window.
#[tauri::command]
pub(crate) fn start_download(state: State<AppState>, result: TrackResult) -> CmdResult<u64> {
    Ok(state.downloads.start(result))
}

/// Snapshot of running/recent download jobs (polled by the library view).
#[tauri::command]
pub(crate) fn download_jobs(state: State<AppState>) -> CmdResult<Vec<dj_library::DownloadJob>> {
    Ok(state.downloads.jobs())
}

/// Deep-link acquisition: resolves the store URL, opens it in the system
/// browser, and returns it (M1: iTunes purchases land via the watch folder).
#[tauri::command]
pub(crate) fn open_store_page(state: State<AppState>, result: TrackResult) -> CmdResult<String> {
    state
        .hub
        .open_deep_link(&result, |url| {
            open::that_detached(url).map_err(anyhow::Error::from)
        })
        .map_err(err)
}

/// Open a web URL in the system's default browser (never in the app's
/// webview). Restricted to http(s) so IPC can't be used to launch
/// arbitrary local files/schemes.
#[tauri::command]
pub(crate) fn open_external(url: String) -> CmdResult<()> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(CmdError::invalid(format!(
            "refusing to open non-http(s) URL: {url}"
        )));
    }
    open::that_detached(&url).map_err(err)
}

#[tauri::command]
pub(crate) fn add_watch_folder(state: State<AppState>, path: String) -> CmdResult<()> {
    state
        .library
        .add_watch_folder(&PathBuf::from(path))
        .map_err(err)
}

#[tauri::command]
pub(crate) fn watch_folders(state: State<AppState>) -> CmdResult<Vec<String>> {
    Ok(state
        .library
        .watch_folders()
        .map_err(err)?
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

/// Load a library track into a Playback module instance.
#[tauri::command]
pub(crate) fn playback_load(state: State<AppState>, instance: String, track_id: i64) -> CmdResult<()> {
    let track = state.library.track(track_id).map_err(err)?;
    let mut engine = patch_edit(&state, EditKey::Track(&instance))?;
    engine
        .playback_load(&instance, &PathBuf::from(track.file_path))
        .map_err(err)
}

/// Load a library track into an Audio module instance. The track's tempo
/// comes from the library (canonical, like deck beatgrids): the module
/// adopts it on the BPM input and resets speed to 1x.
#[tauri::command]
pub(crate) fn audio_load(state: State<AppState>, instance: String, track_id: i64) -> CmdResult<()> {
    let track = state.library.track(track_id).map_err(err)?;
    let mut engine = patch_edit(&state, EditKey::Track(&instance))?;
    engine
        .audio_load(&instance, &PathBuf::from(track.file_path), track.bpm)
        .map_err(err)
}

/// Track + transport + tempo snapshot for the Audio module panel.
#[tauri::command]
pub(crate) fn audio_status(
    state: State<AppState>,
    instance: String,
) -> CmdResult<AudioStatus> {
    let engine = engine_lock(&state)?;
    engine.audio_status(&instance).map_err(err)
}

/// Waveform overview peaks (0..=1) of an Audio module's track.
#[tauri::command]
pub(crate) fn audio_waveform(state: State<AppState>, instance: String, buckets: usize) -> CmdResult<Vec<f32>> {
    let engine = engine_lock(&state)?;
    engine
        .audio_waveform(&instance, buckets.min(20_000))
        .map_err(err)
}
