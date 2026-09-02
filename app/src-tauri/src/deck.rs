//! DJ Deck IPC (M2). DJ Deck (M2). The library DB is the canonical store for cues/loops/
//! beatgrids (PRD §7): every set is written through to the library, and
//! loading a track (or a patch) re-applies the stored metadata.

use dj_engine::deck::DeckStatus;
use dj_engine::Engine;
use dj_library::Track;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::State;

use crate::{engine_lock, err, patch_edit, AppState, CmdError, CmdResult, EditKey};

/// Library row id for the track loaded in a deck, if it's a library track.
pub(crate) fn deck_library_track(state: &AppState, engine: &Engine, instance: &str) -> Option<Track> {
    let path = engine.deck_track(instance).ok()??;
    state.library.track_by_path(Path::new(&path)).ok()?
}

/// Re-apply a track's library metadata (beatgrid, cues, first saved loop)
/// to a deck. Used after deck_load and after patch load.
pub(crate) fn apply_deck_metadata(state: &AppState, engine: &mut Engine, instance: &str) -> CmdResult<()> {
    let Some(track) = deck_library_track(state, engine, instance) else {
        return Ok(());
    };
    if let Some(grid) = state.library.track_beatgrid(track.id).map_err(err)? {
        engine
            .deck_set_beatgrid(instance, grid.bpm, grid.anchor_secs)
            .map_err(err)?;
    }
    for cue in state.library.track_cues(track.id).map_err(err)? {
        engine
            .deck_set_cue(instance, cue.slot as usize, Some(cue.position_secs))
            .map_err(err)?;
    }
    if let Some(l) = state.library.track_loops(track.id).map_err(err)?.first() {
        engine
            .deck_set_loop(instance, l.start_secs, l.end_secs)
            .map_err(err)?;
    }
    // Cached stems (M3, keyed by content hash) auto-load with the track.
    // Best-effort: a missing/failed stem cache must not break deck load.
    let dir = dj_analysis::stems_dir(state.library.data_dir(), &track.content_hash);
    if dj_analysis::stems_cached(&dir) {
        if let Err(e) = engine.deck_load_stems(instance, &dj_analysis::stem_paths(&dir)) {
            eprintln!("[dj-analysis] loading stems for {instance}: {e:#}");
        }
    }
    Ok(())
}

/// Analysis queue snapshot for the Library view (M3).
#[derive(Serialize)]
pub(crate) struct AnalysisQueueSnapshot {
    /// Track currently being analyzed, if any.
    current: Option<i64>,
    /// Track ids still waiting (queue order).
    queued: Vec<i64>,
    /// Track counts by analysis status.
    counts: BTreeMap<String, usize>,
    /// Tracks whose beat/key analysis is over but whose stems are still
    /// separating. The Library keeps calling these "analyzing" and will
    /// not open the Clip editor for them: half a track's material is
    /// still missing until its stems land.
    stems_pending: Vec<i64>,
}

#[tauri::command]
pub(crate) fn analysis_status(state: State<AppState>) -> CmdResult<AnalysisQueueSnapshot> {
    let current = state.analysis.current_track();
    let queued: Vec<i64> = state
        .library
        .analysis_queue()
        .map_err(err)?
        .into_iter()
        .map(|t| t.id)
        .filter(|id| Some(*id) != current)
        .collect();
    let separating: HashSet<i64> = state.auto_stems.pending_tracks().into_iter().collect();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut stems_pending = Vec::new();
    for t in state.library.tracks().map_err(err)? {
        // Only tracks the DB already calls "done" go in, so the two ways
        // of being unfinished never count the same track twice.
        if t.analysis_status == "done" && separating.contains(&t.id) {
            stems_pending.push(t.id);
        }
        *counts.entry(t.analysis_status).or_default() += 1;
    }
    Ok(AnalysisQueueSnapshot {
        current,
        queued,
        counts,
        stems_pending,
    })
}

/// Queue (or re-queue) analysis for a track; the background worker picks
/// it up. Stems already cached for the same content are reused.
#[tauri::command]
pub(crate) fn analyze_track(state: State<AppState>, track_id: i64) -> CmdResult<()> {
    state.library.requeue_analysis(track_id).map_err(err)
}

/// Load the cached stems for the deck's current track (e.g. after
/// analysis finished while the track was already loaded).
#[tauri::command]
pub(crate) fn deck_load_stems(state: State<AppState>, instance: String) -> CmdResult<bool> {
    let mut engine = engine_lock(&state)?;
    let Some(track) = deck_library_track(&state, &engine, &instance) else {
        return Ok(false);
    };
    let dir = dj_analysis::stems_dir(state.library.data_dir(), &track.content_hash);
    if !dj_analysis::stems_cached(&dir) {
        return Ok(false);
    }
    engine
        .deck_load_stems(&instance, &dj_analysis::stem_paths(&dir))
        .map_err(err)?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn deck_clear_stems(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.deck_clear_stems(&instance).map_err(err)
}

/// Write the deck's current beatgrid through to the library.
pub(crate) fn persist_deck_grid(state: &AppState, engine: &Engine, instance: &str) -> CmdResult<()> {
    if let (Some(track), Ok(Some((bpm, anchor)))) = (
        deck_library_track(state, engine, instance),
        engine.deck_beatgrid(instance),
    ) {
        state
            .library
            .set_track_beatgrid(track.id, bpm, anchor)
            .map_err(err)?;
    }
    Ok(())
}

/// Load a library track into a deck and re-apply its DJ metadata.
#[tauri::command]
pub(crate) fn deck_load(state: State<AppState>, instance: String, track_id: i64) -> CmdResult<()> {
    let track = state.library.track(track_id).map_err(err)?;
    let mut engine = patch_edit(&state, EditKey::Track(&instance))?;
    engine
        .deck_load(&instance, &PathBuf::from(track.file_path))
        .map_err(err)?;
    apply_deck_metadata(&state, &mut engine, &instance)
}

#[tauri::command]
pub(crate) fn deck_status(state: State<AppState>, instance: String) -> CmdResult<DeckStatus> {
    let engine = engine_lock(&state)?;
    engine.deck_status(&instance).map_err(err)
}

/// Waveform overview peaks (0..=1), `buckets` values.
#[tauri::command]
pub(crate) fn deck_waveform(state: State<AppState>, instance: String, buckets: usize) -> CmdResult<Vec<f32>> {
    let engine = engine_lock(&state)?;
    engine
        .deck_waveform(&instance, buckets.min(20_000))
        .map_err(err)
}

#[tauri::command]
pub(crate) fn deck_seek(state: State<AppState>, instance: String, position: f64) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.deck_seek(&instance, position).map_err(err)
}

/// Set (Some) or clear (None) a hot cue; written through to the library.
#[tauri::command]
pub(crate) fn deck_set_cue(
    state: State<AppState>,
    instance: String,
    slot: usize,
    position: Option<f64>,
) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine
        .deck_set_cue(&instance, slot, position)
        .map_err(err)?;
    if let Some(track) = deck_library_track(&state, &engine, &instance) {
        match position {
            Some(pos) => state
                .library
                .set_track_cue(track.id, slot as u8, pos, "")
                .map_err(err)?,
            None => state
                .library
                .clear_track_cue(track.id, slot as u8)
                .map_err(err)?,
        }
    }
    Ok(())
}

/// Set the active loop region (transient until saved).
#[tauri::command]
pub(crate) fn deck_set_loop(state: State<AppState>, instance: String, start: f64, end: f64) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.deck_set_loop(&instance, start, end).map_err(err)
}

#[tauri::command]
pub(crate) fn deck_loop_enable(state: State<AppState>, instance: String, enabled: bool) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.deck_loop_enable(&instance, enabled).map_err(err)
}

#[tauri::command]
pub(crate) fn deck_loop_halve(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.deck_loop_halve(&instance).map_err(err)
}

#[tauri::command]
pub(crate) fn deck_loop_double(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.deck_loop_double(&instance).map_err(err)
}

/// Save the current loop region as a named library loop for the track.
#[tauri::command]
pub(crate) fn deck_save_loop(state: State<AppState>, instance: String, name: String) -> CmdResult<i64> {
    let engine = engine_lock(&state)?;
    let status = engine.deck_status(&instance).map_err(err)?;
    let (Some(start), Some(end)) = (status.loop_start_secs, status.loop_end_secs) else {
        return Err(CmdError::invalid("no loop region set"));
    };
    let track = deck_library_track(&state, &engine, &instance)
        .ok_or_else(|| CmdError::not_found("deck track is not in the library"))?;
    state
        .library
        .add_track_loop(track.id, &name, start, end)
        .map_err(err)
}

/// Saved loops for the deck's current track.
#[tauri::command]
pub(crate) fn deck_saved_loops(
    state: State<AppState>,
    instance: String,
) -> CmdResult<Vec<dj_library::SavedLoop>> {
    let engine = engine_lock(&state)?;
    match deck_library_track(&state, &engine, &instance) {
        Some(track) => state.library.track_loops(track.id).map_err(err),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub(crate) fn deck_set_beatgrid(
    state: State<AppState>,
    instance: String,
    bpm: f64,
    anchor: f64,
) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine
        .deck_set_beatgrid(&instance, bpm, anchor)
        .map_err(err)?;
    persist_deck_grid(&state, &engine, &instance)
}

/// Tap tempo at the live playhead; the resulting grid persists.
#[tauri::command]
pub(crate) fn deck_tap_tempo(state: State<AppState>, instance: String) -> CmdResult<Option<(f64, f64)>> {
    let mut engine = engine_lock(&state)?;
    let grid = engine.deck_tap_tempo(&instance).map_err(err)?;
    persist_deck_grid(&state, &engine, &instance)?;
    Ok(grid)
}

/// Nudge the beatgrid anchor by `delta` seconds.
#[tauri::command]
pub(crate) fn deck_nudge_beatgrid(state: State<AppState>, instance: String, delta: f64) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.deck_nudge_beatgrid(&instance, delta).map_err(err)?;
    persist_deck_grid(&state, &engine, &instance)
}

/// Re-anchor the beatgrid at the current playhead.
#[tauri::command]
pub(crate) fn deck_anchor_here(state: State<AppState>, instance: String) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.deck_anchor_here(&instance).map_err(err)?;
    persist_deck_grid(&state, &engine, &instance)
}

/// Beat-sync a deck to another deck (None clears sync).
#[tauri::command]
pub(crate) fn deck_sync(state: State<AppState>, instance: String, master: Option<String>) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    engine.deck_sync(&instance, master.as_deref()).map_err(err)
}
