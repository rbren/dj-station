//! Beat Clip module IPC: which Beatify clips can be imported into the
//! rack, and putting one inside a `builtin.beat_clip` module.
//!
//! A clip is placements, not audio (see [`crate::beatify_clip`]), so what
//! the patch keeps is the BINDING — project id + clip id — and the samples
//! are assembled here, on demand: when the user imports one from the
//! module picker, and again after a patch load or an undo that brought a
//! module back ([`hydrate`]). That is the deck-metadata pattern: the
//! engine holds what it plays, the app layer knows where it came from.
//!
//! Assembling decodes and mixes seconds of audio, so the commands are
//! `async` — a sync command runs on the main thread and would freeze the
//! window.

use dj_engine::beat_clip::BeatClipRef;
use dj_engine::playback::TrackData;
use dj_engine::Engine;
use serde::Serialize;
use tauri::State;

use crate::beatify_clip::{render_clip, RenderedClip};
use crate::{engine_lock, err, patch_edit, AppState, CmdResult, EditKey};

/// One clip offered in the module picker's Clips tab.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatClipEntry {
    pub project_id: String,
    pub project_name: String,
    pub clip_id: String,
    pub name: String,
    /// The project's tempo — a clip is laid out on its grid.
    pub bpm: f64,
    /// Clip length in beats (trailing silence included).
    pub beats: usize,
}

/// Every clip in every Beatify project, newest project first (the order
/// `store::list` sorts them in).
#[tauri::command(async)]
pub fn beat_clip_list(state: State<AppState>) -> CmdResult<Vec<BeatClipEntry>> {
    let data_dir = state.library.data_dir();
    let mut out = Vec::new();
    for project in dj_analysis::beatify::store::list(data_dir).map_err(err)? {
        // 0 for a project with no seed in it yet: it has no tempo, and a
        // clip cut on no grid is not one the picker can promise anything
        // about.
        let bpm = project.bpm.unwrap_or(0.0);
        for clip in crate::beatify_clip::project_clips(&state, &project.id)? {
            out.push(BeatClipEntry {
                project_id: project.id.clone(),
                project_name: project.name.clone(),
                clip_id: clip.id,
                name: clip.name,
                bpm,
                beats: clip.columns.max(1),
            });
        }
    }
    Ok(out)
}

/// Assemble a clip and hand it to a Beat Clip module, binding the module
/// to it. Undoable under the same key as loading a track into a deck or
/// the Audio module: it is the same act.
#[tauri::command(async)]
pub fn beat_clip_load(
    state: State<AppState>,
    instance: String,
    project_id: String,
    clip_id: String,
) -> CmdResult<()> {
    // Assemble BEFORE taking the engine lock: this decodes and mixes.
    let rendered = render_clip(&state, &project_id, &clip_id)?;
    let clip = BeatClipRef {
        project: project_id,
        clip: clip_id,
        name: rendered.name.clone(),
    };
    let mut engine = patch_edit(&state, EditKey::Track(&instance))?;
    engine
        .beat_clip_load(&instance, Some(clip), track_data(&rendered), rendered.bpm)
        .map_err(err)
}

/// Clip + transport snapshot for the Beat Clip module panel.
#[tauri::command]
pub fn beat_clip_status(
    state: State<AppState>,
    instance: String,
) -> CmdResult<dj_engine::beat_clip::BeatClipStatus> {
    let engine = engine_lock(&state)?;
    engine.beat_clip_status(&instance).map_err(err)
}

fn track_data(rendered: &RenderedClip) -> TrackData {
    TrackData {
        channels: rendered.audio.channels.clone(),
        sample_rate: rendered.audio.sample_rate as f32,
    }
}

/// Re-assemble every Beat Clip module that knows which clip it plays but
/// has no audio behind it — after a patch load, or an undo/redo that
/// recreated one. A clip whose project has been deleted leaves its module
/// silent (and says so in the log): losing the source should cost the
/// sound, never the patch.
pub fn hydrate(state: &AppState, engine: &mut Engine) {
    for (instance, clip) in engine.beat_clip_pending() {
        match render_clip(state, &clip.project, &clip.clip) {
            Ok(rendered) => {
                let audio = track_data(&rendered);
                let bpm = rendered.bpm;
                if let Err(e) = engine.beat_clip_load(&instance, Some(clip), audio, bpm) {
                    eprintln!("[dj-audio] loading a clip into {instance}: {e:#}");
                }
            }
            Err(e) => eprintln!(
                "[dj-audio] {instance} plays clip {}/{}, which cannot be assembled: {e}",
                clip.project, clip.clip
            ),
        }
    }
}
