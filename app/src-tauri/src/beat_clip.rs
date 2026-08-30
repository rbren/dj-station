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
    /// Which parts of a track it is made of, `STEM_NAMES` order — all
    /// four for a clip cut from whole mixes, and empty for an empty clip.
    pub stems: Vec<String>,
}

/// Every clip in every Beatify project, newest project first (the order
/// `store::list` sorts them in), then the Clip tab's beat clips — same
/// rows, same load path, a different store behind them.
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
                stems: clip.stems,
            });
        }
    }
    for meta in dj_analysis::clip::read_beat_clips(data_dir) {
        out.push(BeatClipEntry {
            project_id: crate::clip::BEAT_CLIPS_PROJECT.into(),
            project_name: crate::clip::BEAT_CLIPS_PROJECT_NAME.into(),
            clip_id: meta.id,
            name: meta.name,
            bpm: meta.bpm,
            beats: meta.beats.max(1),
            stems: meta.stems,
        });
    }
    Ok(out)
}

/// Assemble a clip and hand it to a Beat Clip module, binding the module
/// to it and naming the module after it. Undoable under the same key as
/// loading a track into a deck or the Audio module: it is the same act.
/// Returns the instance id the module ended up with — the rename gives it
/// a new one, and the frontend's rack layout is keyed by id.
#[tauri::command(async)]
pub fn beat_clip_load(
    state: State<AppState>,
    instance: String,
    project_id: String,
    clip_id: String,
) -> CmdResult<String> {
    // Assemble BEFORE taking the engine lock: this decodes and mixes.
    let rendered = render_clip(&state, &project_id, &clip_id)?;
    let clip = BeatClipRef {
        project: project_id,
        clip: clip_id,
        name: rendered.name.clone(),
        project_name: rendered.project_name.clone(),
        stems: rendered.stems.clone(),
    };
    let mut engine = patch_edit(&state, EditKey::Track(&instance))?;
    engine
        .beat_clip_load(&instance, Some(clip), track_data(&rendered), rendered.bpm)
        .map_err(err)?;
    Ok(name_after_clip(&mut engine, &instance, &rendered.name))
}

/// A clip module wears the clip's name ("chorus stack", not "beatclip1"):
/// the clip IS the module. The same clip can be imported twice, so a name
/// already in the rack gets numbered; a name with nothing usable in it
/// (the engine normalizes to instance ids) leaves the module as it is.
fn name_after_clip(engine: &mut Engine, instance: &str, clip_name: &str) -> String {
    if dj_engine::normalize_module_name(clip_name).is_empty() {
        return instance.to_string();
    }
    for n in 1..100 {
        let candidate = if n == 1 {
            clip_name.to_string()
        } else {
            format!("{clip_name} {n}")
        };
        if let Ok(id) = engine.rename_module(instance, &candidate) {
            return id;
        }
    }
    instance.to_string()
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
                // Re-read the display fields off the clip as it now
                // stands: a patch saved before clips said what they hold
                // carries no stems, and re-cutting one can change them.
                let clip = BeatClipRef {
                    name: rendered.name.clone(),
                    project_name: rendered.project_name.clone(),
                    stems: rendered.stems.clone(),
                    ..clip
                };
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
