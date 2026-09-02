//! Beat Clip module IPC: which saved beat clips can be imported into the
//! rack, and putting one inside a `builtin.beat_clip` module.
//!
//! What the patch keeps is the BINDING — the store id + the clip id — and
//! the samples are loaded here, on demand: when the user imports one from
//! the module picker, and again after a patch load or an undo that
//! brought a module back ([`hydrate`]). That is the deck-metadata
//! pattern: the engine holds what it plays, the app layer knows where it
//! came from.
//!
//! Loading decodes seconds of audio, so the commands are `async` — a sync
//! command runs on the main thread and would freeze the window.

use dj_analysis::AudioData;
use dj_engine::beat_clip::BeatClipRef;
use dj_engine::playback::{ClipAudio, ClipBleed, TrackData};
use dj_engine::Engine;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

use crate::{engine_lock, err, patch_edit, AppState, CmdError, CmdResult, EditKey};

/// A library track a clip was cut from, as a row can show it: the
/// POINTER — the hash of the track's audio, which nothing can change —
/// plus the names that hash answers to today. `title: None` is a normal
/// state: the source was never recorded, or the track has since been
/// deleted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatClipSourceInfo {
    pub track_hash: String,
    pub title: Option<String>,
    pub artist: Option<String>,
}

/// One clip offered in the module picker's Clips tab, and listed on the
/// Library page's Beat Clips tab.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatClipEntry {
    pub clip_id: String,
    pub name: String,
    /// The tempo the clip's beats are laid out at.
    pub bpm: f64,
    /// Clip length in beats (trailing silence included).
    pub beats: usize,
    /// Which parts of a track it is made of, `STEM_NAMES` order — all
    /// four for a clip cut from whole mixes, and empty for an empty clip.
    pub stems: Vec<String>,
    /// Can it be opened in the Clip page again? Only a clip filed with
    /// its edit can (`BeatClipMeta.edit`); the older ones are audio and
    /// a name.
    pub editable: bool,
    /// Which of its own beats its grid marks as ONES (downbeats),
    /// ascending — what a surface lines the clip up by. Empty for a clip
    /// whose grid marks none, and for one filed before the edit was kept.
    pub ones: Vec<u32>,
    /// The tracks it points at, resolved against the library as it now
    /// stands. Empty when the clip records no source at all.
    pub sources: Vec<BeatClipSourceInfo>,
    /// How far the clip's files have been rewritten
    /// ([`dj_analysis::clip::beat_clip_rev`]). A clip EDITED keeps its
    /// id, so this is what tells a surface holding the clip's decoded
    /// audio that what it holds is last time's clip.
    pub rev: String,
}

/// What a source hash answers to today. A track that is gone answers with
/// the hash and no names: a clip outlives its source.
fn source_info(state: &AppState, track_hash: &str) -> BeatClipSourceInfo {
    let found = state.library.track_by_hash(track_hash).ok().flatten();
    BeatClipSourceInfo {
        track_hash: track_hash.to_string(),
        title: found.as_ref().map(|t| t.title.clone()),
        artist: found.map(|t| t.artist),
    }
}

/// Which beats a clip's own grid marks as ones. The grid a clip keeps is
/// already cut to the clip (`BeatGrid::cut_to`), so its indices count the
/// clip's beats; a clip filed without its edit, or tapped without marking
/// a one, simply has none.
fn clip_ones(meta: &dj_analysis::clip::BeatClipMeta) -> Vec<u32> {
    meta.edit
        .as_ref()
        .and_then(|edit| edit.program.beat_grid.as_ref())
        .map(|grid| grid.ones.iter().map(|&one| one as u32).collect())
        .unwrap_or_default()
}

/// Every saved beat clip, oldest first — the one store, the one list.
#[tauri::command(async)]
pub fn beat_clip_list(state: State<AppState>) -> CmdResult<Vec<BeatClipEntry>> {
    let data_dir = state.library.data_dir();
    Ok(dj_analysis::clip::read_beat_clips(data_dir)
        .into_iter()
        .map(|meta| {
            let sources = meta
                .edit
                .iter()
                .flat_map(|edit| edit.sources.iter())
                .map(|source| source_info(&state, &source.track_hash))
                .collect();
            let ones = clip_ones(&meta);
            let rev = dj_analysis::clip::beat_clip_rev(data_dir, &meta.id);
            BeatClipEntry {
                clip_id: meta.id,
                name: meta.name,
                bpm: meta.bpm,
                beats: meta.beats.max(1),
                stems: meta.stems,
                // A clip filed before the edit was kept says nothing about
                // where it came from, and cannot be opened again.
                editable: meta.edit.is_some(),
                ones,
                sources,
                rev,
            }
        })
        .collect())
}

/// Delete a saved clip and answer with the list as it now stands. Modules
/// already playing it keep their audio — a Beat Clip module holds
/// samples, not a file handle — but nothing can load it again.
#[tauri::command(async)]
pub fn beat_clip_delete(state: State<AppState>, clip_id: String) -> CmdResult<Vec<BeatClipEntry>> {
    dj_analysis::clip::delete_beat_clip(state.library.data_dir(), &clip_id)
        .map_err(|e| CmdError::invalid(format!("clip: {e}")))?;
    beat_clip_list(state)
}

/// A saved beat clip, loaded: what the rack's Beat Clip module (and a
/// deck) plays, and the tempo it is laid out at.
pub struct RenderedClip {
    pub audio: AudioData,
    /// Material from OUTSIDE the loop that the player lays over its seam
    /// (the Clip page's bleed controls); empty for a clip saved without.
    pub bleed: dj_analysis::clip::BleedAudio,
    pub bpm: f64,
    pub name: String,
    /// Which store it came from — what a deck shows beside the clip's own
    /// name.
    pub project_name: String,
    /// What it is made of, for the module that ends up playing it.
    pub stems: Vec<String>,
    /// Which of its beats its grid marks as ONES — what a deck lines the
    /// clip up by. Empty for a clip whose grid marks none (and for one
    /// filed before the edit was kept).
    pub ones: Vec<u32>,
}

impl RenderedClip {
    /// The samples as a player takes them (`Engine::beat_clip_load`,
    /// `Engine::decks_load`): the loop, and the bleed that goes over its
    /// seam.
    pub fn clip_audio(&self) -> ClipAudio {
        let track = |a: &AudioData| {
            Arc::new(TrackData {
                channels: a.channels.clone(),
                sample_rate: a.sample_rate as f32,
            })
        };
        ClipAudio {
            track: track(&self.audio),
            bleed: ClipBleed {
                left: self.bleed.left.as_ref().map(track),
                right: self.bleed.right.as_ref().map(track),
            },
        }
    }
}

/// Load a saved clip out of the store. A binding whose clip is not there
/// any more (deleted, or filed by a store this build no longer has) is an
/// error the caller reports without losing anything else.
pub fn render_clip(state: &AppState, clip_id: &str) -> CmdResult<RenderedClip> {
    let (meta, audio, bleed) = dj_analysis::clip::load_beat_clip(state.library.data_dir(), clip_id)
        .map_err(|e| CmdError::invalid(format!("clip: {e}")))?;
    let ones = clip_ones(&meta);
    Ok(RenderedClip {
        audio,
        bleed,
        bpm: meta.bpm,
        project_name: crate::clip::BEAT_CLIPS_PROJECT_NAME.into(),
        name: meta.name,
        stems: meta.stems,
        ones,
    })
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
    clip_id: String,
) -> CmdResult<String> {
    // Load BEFORE taking the engine lock: this decodes seconds of audio.
    let rendered = render_clip(&state, &clip_id)?;
    let clip = BeatClipRef {
        project: crate::clip::BEAT_CLIPS_PROJECT.into(),
        clip: clip_id,
        name: rendered.name.clone(),
        project_name: rendered.project_name.clone(),
        stems: rendered.stems.clone(),
        ones: rendered.ones.clone(),
    };
    let mut engine = patch_edit(&state, EditKey::Track(&instance))?;
    engine
        .beat_clip_load(&instance, Some(clip), rendered.clip_audio(), rendered.bpm)
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

/// A saved clip's LOOP as WAV bytes, for a surface that plays clips in
/// the webview rather than through the engine (the Grid page schedules
/// them itself, the way the Clip page auditions a render). The bleed
/// stays out of these bytes — it is overlaid where it is heard, never
/// baked into the loop — and is asked for a side at a time through
/// [`beat_clip_bleed`].
///
/// `bpm` RE-TIMES the clip to that tempo before handing it over, and it
/// does so by WSOLA (`beats::warp`), the same stretcher the Clip page's
/// warp uses — NOT by resampling. Playing a 120 bpm clip at 1.5× rate to
/// make it 180 would take its pitch up a fifth with it; a grid whose
/// master tempo transposes every clip on it is not a grid anyone can
/// write music on. The webview then plays what comes back at rate 1.0.
///
/// `fx` asks for the clip THROUGH a Grid track's effects rack instead:
/// the row's `TrackFx` JSON, rendered offline by `dj_engine::track_fx`
/// AFTER the stretch (so it processes exactly the samples the dry path
/// plays, and the webview's Wetness knob can crossfade the two buffers
/// sample-for-sample).
#[tauri::command(async)]
pub fn beat_clip_audio(
    state: State<AppState>,
    clip_id: String,
    bpm: Option<f64>,
    fx: Option<String>,
) -> CmdResult<tauri::ipc::Response> {
    let (meta, audio, _) = dj_analysis::clip::load_beat_clip(state.library.data_dir(), &clip_id)
        .map_err(|e| CmdError::invalid(format!("clip: {e}")))?;
    let audio = match bpm {
        Some(bpm) if bpm > 0.0 && meta.bpm > 0.0 => stretch_to_bpm(&audio, meta.bpm, bpm),
        _ => audio,
    };
    let audio = match fx.as_deref() {
        None | Some("") => audio,
        Some(json) => {
            let spec = dj_engine::track_fx::TrackFxSpec::from_json(json)
                .map_err(|e| CmdError::invalid(format!("fx: {e}")))?;
            let registry = state.engine.lock().unwrap().registry.clone();
            let tempo = bpm.filter(|b| *b > 0.0).unwrap_or(meta.bpm);
            let channels = dj_engine::track_fx::render_track_fx_clip(
                registry,
                &spec,
                &audio.channels,
                audio.sample_rate as f32,
                tempo,
            )
            .map_err(|e| CmdError::invalid(format!("fx render: {e}")))?;
            AudioData {
                channels,
                sample_rate: audio.sample_rate,
            }
        }
    };
    Ok(tauri::ipc::Response::new(dj_analysis::clip::wav16_bytes(
        &audio,
    )))
}

/// One side of a saved clip's BLEED as WAV bytes, for the same webview
/// player. `"right"` is the material that FOLLOWED the clip in its track
/// and `"left"` what ran into it — the two halves of
/// `playback::ClipBleed`, handed over apart from the loop because they
/// are summed where they are heard: over the seam by a looping player,
/// either side of the copy by a timeline (the Grid page). A side the
/// clip was saved without answers with no bytes at all.
///
/// `bpm` re-times it with the SAME stretch the loop gets, so a bleed
/// still meets the seam it belongs to once the grid's tempo has moved.
#[tauri::command(async)]
pub fn beat_clip_bleed(
    state: State<AppState>,
    clip_id: String,
    side: String,
    bpm: Option<f64>,
) -> CmdResult<tauri::ipc::Response> {
    let (meta, _, bleed) = dj_analysis::clip::load_beat_clip(state.library.data_dir(), &clip_id)
        .map_err(|e| CmdError::invalid(format!("clip: {e}")))?;
    let audio = match side.as_str() {
        "left" => bleed.left,
        "right" => bleed.right,
        _ => return Err(CmdError::invalid(format!("bleed side: {side:?}"))),
    };
    let Some(audio) = audio else {
        return Ok(tauri::ipc::Response::new(Vec::<u8>::new()));
    };
    let audio = match bpm {
        Some(bpm) if bpm > 0.0 && meta.bpm > 0.0 => stretch_to_bpm(&audio, meta.bpm, bpm),
        _ => audio,
    };
    Ok(tauri::ipc::Response::new(dj_analysis::clip::wav16_bytes(
        &audio,
    )))
}

/// A clip's waveform, as one peak per BEAT-fraction: `buckets` samples
/// of its shape, for a surface that draws the clip inside the cells it
/// occupies (the Grid page). Peaks rather than audio because that is all
/// a drawing needs, and a grid can hold a great many clips.
#[tauri::command(async)]
pub fn beat_clip_peaks(state: State<AppState>, clip_id: String, buckets: usize) -> CmdResult<Vec<f32>> {
    let (_, audio, _) = dj_analysis::clip::load_beat_clip(state.library.data_dir(), &clip_id)
        .map_err(|e| CmdError::invalid(format!("clip: {e}")))?;
    Ok(dj_analysis::clip::peaks(&audio, buckets.clamp(1, 4096)))
}

/// Saved Grid arrangements: `grids/<name>.json` beside the patches. An
/// arrangement is JSON the frontend owns end to end (`GridDocument`) —
/// the backend only files it, because nothing here plays it: the grid is
/// scheduled in the webview.
fn grids_dir() -> std::path::PathBuf {
    dj_library::default_data_dir().join("grids")
}

/// The same rule patch names follow, so a grid cannot name a path.
fn valid_grid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'))
}

#[tauri::command(async)]
pub fn grid_save(name: String, doc: String) -> CmdResult<()> {
    let name = name.trim().to_string();
    if !valid_grid_name(&name) {
        return Err(CmdError::invalid(format!("invalid grid name: {name:?}")));
    }
    let dir = grids_dir();
    std::fs::create_dir_all(&dir).map_err(err)?;
    std::fs::write(dir.join(format!("{name}.json")), doc).map_err(err)?;
    Ok(())
}

#[tauri::command(async)]
pub fn grid_load(name: String) -> CmdResult<String> {
    if !valid_grid_name(&name) {
        return Err(CmdError::invalid(format!("invalid grid name: {name:?}")));
    }
    std::fs::read_to_string(grids_dir().join(format!("{name}.json"))).map_err(err)
}

#[tauri::command(async)]
pub fn grid_list() -> CmdResult<Vec<String>> {
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(grids_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    names.push(stem.to_string());
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

/// Re-time `audio` from `from_bpm` to `to_bpm`, keeping its pitch. The
/// map is a single linear segment — one constant ratio over the whole
/// clip — so the beats stay evenly spaced; WSOLA does the rest.
fn stretch_to_bpm(audio: &AudioData, from_bpm: f64, to_bpm: f64) -> AudioData {
    let ratio = from_bpm / to_bpm;
    // A ratio this close to 1 is below what WSOLA would change anyway,
    // and re-rendering it would only cost the clip a round trip through
    // the overlap-add.
    if (ratio - 1.0).abs() < 1e-4 {
        return audio.clone();
    }
    let src_secs = audio.duration_secs();
    let out_secs = src_secs * ratio;
    let map = dj_analysis::beats::WarpMap {
        points: vec![(0.0, 0.0), (src_secs, out_secs)],
    };
    dj_analysis::beats::warp::render(audio, &map, out_secs)
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

/// Re-load every Beat Clip module that knows which clip it plays but has
/// no audio behind it — after a patch load, or an undo/redo that
/// recreated one. A clip that has been deleted leaves its module silent
/// (and says so in the log): losing the source should cost the sound,
/// never the patch.
pub fn hydrate(state: &AppState, engine: &mut Engine) {
    for (instance, clip) in engine.beat_clip_pending() {
        match render_clip(state, &clip.clip) {
            Ok(rendered) => {
                let audio = rendered.clip_audio();
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
