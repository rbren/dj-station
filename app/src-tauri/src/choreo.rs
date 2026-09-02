//! Choreography module IPC: the timeline panel's poll and its edits —
//! beats, tracks (add/remove/rename/move), lane data and note settings.

use dj_engine::KnobStyle;
use tauri::State;

use crate::{engine_lock, err, patch_edit, AppState, CmdError, CmdResult, EditKey};

/// Everything the choreography panel needs per poll: the timeline plus
/// the live playhead beat.
#[derive(serde::Serialize)]
pub(crate) struct ChoreoStatus {
    beats: usize,
    tracks: Vec<dj_engine::ChoreoTrack>,
    playhead: i64,
}

#[tauri::command]
pub(crate) fn choreo_status(state: State<AppState>, instance: String) -> CmdResult<ChoreoStatus> {
    let engine = engine_lock(&state)?;
    let st = engine.choreo(&instance).map_err(err)?;
    Ok(ChoreoStatus {
        beats: st.beats,
        tracks: st.tracks.clone(),
        playhead: engine.choreo_playhead(&instance).map_err(err)?,
    })
}

#[tauri::command]
pub(crate) fn choreo_set_beats(state: State<AppState>, instance: String, beats: usize) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoBeats(&instance))?;
    engine.choreo_set_beats(&instance, beats).map_err(err)
}

/// Add a track ("boolean" | "continuous" | "note"); it materializes as
/// one (or two, for note tracks) output jacks.
#[tauri::command]
pub(crate) fn choreo_add_track(
    state: State<AppState>,
    instance: String,
    name: String,
    kind: String,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoTrackAdd(&instance, &name))?;
    engine
        .choreo_add_track(&instance, &name, &kind)
        .map(|_| ())
        .map_err(err)
}

/// Remove a track. Wires from its jack(s) are disconnected first
/// (restoring auto wire-style knobs), which needs the engine stopped.
#[tauri::command]
pub(crate) fn choreo_remove_track(state: State<AppState>, instance: String, track: usize) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoTrackRemove(&instance, track))?;
    let jacks: Vec<String> = {
        let st = engine.choreo(&instance).map_err(err)?;
        let t = st
            .tracks
            .get(track)
            .ok_or_else(|| CmdError::not_found(format!("no track {track}")))?;
        (t.jack..t.jack + t.data.jack_count())
            .map(|j| format!("t{j}"))
            .collect()
    };
    let doomed: Vec<(String, String, String)> = engine
        .wire_specs()
        .iter()
        .filter(|w| {
            engine.nodes[w.from_node].instance_id == instance
                && jacks.contains(&engine.output_jack_name(w.from_node, w.from_jack))
        })
        .map(|w| {
            (
                engine.output_jack_name(w.from_node, w.from_jack),
                engine.nodes[w.to_node].instance_id.clone(),
                engine.nodes[w.to_node].manifest.inputs[w.to_jack]
                    .id
                    .clone(),
            )
        })
        .collect();
    if doomed.is_empty() {
        return engine.choreo_remove_track(&instance, track).map_err(err);
    }
    for (from_jack, to_instance, to_jack) in &doomed {
        engine
            .disconnect(&instance, from_jack, to_instance, to_jack)
            .map_err(err)?;
        if let Ok(k) = engine.knob_state(to_instance, to_jack) {
            if k.config
                .as_ref()
                .is_some_and(|c| c.style == KnobStyle::Wire)
            {
                engine
                    .set_knob_config(to_instance, to_jack, None)
                    .map_err(err)?;
            }
        }
    }
    engine.choreo_remove_track(&instance, track).map_err(err)
}

#[tauri::command]
pub(crate) fn choreo_rename_track(
    state: State<AppState>,
    instance: String,
    track: usize,
    name: String,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoTrackRename(&instance, track))?;
    engine
        .choreo_rename_track(&instance, track, &name)
        .map_err(err)
}

/// Reorder tracks (display order only; jacks stay with their tracks).
#[tauri::command]
pub(crate) fn choreo_move_track(
    state: State<AppState>,
    instance: String,
    from: usize,
    to: usize,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoTrackMove(&instance))?;
    engine.choreo_move_track(&instance, from, to).map_err(err)
}

#[tauri::command]
pub(crate) fn choreo_set_bool(
    state: State<AppState>,
    instance: String,
    track: usize,
    beat: usize,
    on: bool,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoData(&instance, track))?;
    engine
        .choreo_set_bool(&instance, track, beat, on)
        .map_err(err)
}

/// Write a run of continuous values from `start` (drag paints batch).
#[tauri::command]
pub(crate) fn choreo_set_values(
    state: State<AppState>,
    instance: String,
    track: usize,
    start: usize,
    values: Vec<f32>,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoData(&instance, track))?;
    engine
        .choreo_set_values(&instance, track, start, &values)
        .map_err(err)
}

/// Set or clear the note at a beat (`degree`/`velocity` together; None
/// clears).
#[tauri::command]
pub(crate) fn choreo_set_note(
    state: State<AppState>,
    instance: String,
    track: usize,
    beat: usize,
    note: Option<dj_engine::NoteStep>,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoData(&instance, track))?;
    engine
        .choreo_set_note(&instance, track, beat, note)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn choreo_set_note_settings(
    state: State<AppState>,
    instance: String,
    track: usize,
    octaves: u8,
    scale: String,
    base_note: u8,
) -> CmdResult<()> {
    let mut engine = patch_edit(&state, EditKey::ChoreoTrackSettings(&instance, track))?;
    engine
        .choreo_set_note_settings(&instance, track, octaves, &scale, base_note)
        .map_err(err)
}
