//! Clip page IPC (PRD §9): edit library tracks into new library tracks.
//!
//! The editor is a pure control-plane feature — it never touches the
//! engine or the RT thread. Commands decode library tracks (cached here so
//! scrubbing an edit doesn't re-decode), render a
//! [`ClipProgram`](dj_analysis::clip::ClipProgram) with `dj-analysis`, and
//! import the result as a NEW library track; the sources are never
//! rewritten.
//!
//! Every command is `async` so the (multi-second) decode/render runs on
//! Tauri's worker pool instead of blocking the UI thread.

use dj_analysis::clip::{self, ClipProgram};
use dj_analysis::AudioData;
use dj_library::{ImportOptions, ImportOutcome, Track};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::State;

use crate::{err, AppState, CmdError, CmdResult};

/// Decoded sources for the Clip page, keyed by library track id. Bounded
/// so a long editing session can't pin every track ever opened in memory.
#[derive(Default)]
pub struct ClipCache {
    entries: Mutex<Vec<(i64, Arc<AudioData>)>>,
}

const MAX_CACHED_SOURCES: usize = 4;

impl ClipCache {
    fn get(&self, track_id: i64) -> Option<Arc<AudioData>> {
        let entries = self.entries.lock().ok()?;
        entries
            .iter()
            .find(|(id, _)| *id == track_id)
            .map(|(_, a)| Arc::clone(a))
    }

    fn put(&self, track_id: i64, audio: Arc<AudioData>) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|(id, _)| *id != track_id);
            entries.push((track_id, audio));
            let overflow = entries.len().saturating_sub(MAX_CACHED_SOURCES);
            entries.drain(..overflow);
        }
    }
}

/// Decode a library track, using (and filling) the cache.
fn source_audio(state: &AppState, track_id: i64) -> CmdResult<Arc<AudioData>> {
    if let Some(audio) = state.clips.get(track_id) {
        return Ok(audio);
    }
    let track = state.library.track(track_id).map_err(err)?;
    let audio = Arc::new(
        dj_analysis::decode_audio(std::path::Path::new(&track.file_path))
            .map_err(|e| err(format!("decoding {}: {e}", track.title)))?,
    );
    state.clips.put(track_id, Arc::clone(&audio));
    Ok(audio)
}

/// An edit as the UI sends it: `program` regions index into `sources`
/// (library track ids), which keeps `dj-analysis` free of library types.
#[derive(Debug, Deserialize)]
pub struct ClipRequest {
    sources: Vec<i64>,
    program: ClipProgram,
}

impl ClipRequest {
    fn decode(&self, state: &AppState) -> CmdResult<Vec<Arc<AudioData>>> {
        if self.sources.is_empty() {
            return Err(CmdError::invalid("clip: no source tracks"));
        }
        self.sources
            .iter()
            .map(|id| source_audio(state, *id))
            .collect()
    }

    fn render(&self, state: &AppState) -> CmdResult<AudioData> {
        let sources = self.decode(state)?;
        let refs: Vec<&AudioData> = sources.iter().map(|a| a.as_ref()).collect();
        clip::render_clip(&refs, &self.program).map_err(|e| CmdError::invalid(e.to_string()))
    }
}

/// One loaded source track: what the editor needs to draw and cut it.
#[derive(Debug, Serialize)]
pub struct ClipSource {
    track_id: i64,
    title: String,
    artist: String,
    duration_secs: f64,
    sample_rate: u32,
    channels: usize,
    peaks: Vec<f32>,
}

/// The rendered edit, described for the editor's output waveform.
#[derive(Debug, Serialize)]
pub struct ClipRender {
    duration_secs: f64,
    sample_rate: u32,
    channels: usize,
    peaks: Vec<f32>,
}

const MAX_BUCKETS: usize = 20_000;
/// Audition window cap: preview bytes cross the IPC boundary in one piece.
const MAX_PREVIEW_SECS: f64 = 60.0;

/// Decode a library track for editing and return its waveform overview.
#[tauri::command(async)]
pub fn clip_load_source(
    state: State<AppState>,
    track_id: i64,
    buckets: usize,
) -> CmdResult<ClipSource> {
    let track = state.library.track(track_id).map_err(err)?;
    let audio = source_audio(&state, track_id)?;
    Ok(ClipSource {
        track_id,
        title: track.title,
        artist: track.artist,
        duration_secs: audio.duration_secs(),
        sample_rate: audio.sample_rate,
        channels: audio.channels.len(),
        peaks: clip::peaks(&audio, buckets.min(MAX_BUCKETS)),
    })
}

/// Render the edit and return its waveform overview (no file is written).
#[tauri::command(async)]
pub fn clip_render_preview(
    state: State<AppState>,
    request: ClipRequest,
    buckets: usize,
) -> CmdResult<ClipRender> {
    let rendered = request.render(&state)?;
    Ok(ClipRender {
        duration_secs: rendered.duration_secs(),
        sample_rate: rendered.sample_rate,
        channels: rendered.channels.len(),
        peaks: clip::peaks(&rendered, buckets.min(MAX_BUCKETS)),
    })
}

/// Audition a window of the edit: 16-bit WAV bytes the webview plays back
/// from a blob URL (raw IPC response, never JSON-encoded samples).
#[tauri::command(async)]
pub fn clip_preview_audio(
    state: State<AppState>,
    request: ClipRequest,
    start_secs: f64,
    secs: f64,
) -> CmdResult<tauri::ipc::Response> {
    let rendered = request.render(&state)?;
    let window = clip::slice(&rendered, start_secs, secs.min(MAX_PREVIEW_SECS));
    if window.frames() == 0 {
        return Err(CmdError::invalid("clip: nothing to preview at that point"));
    }
    Ok(tauri::ipc::Response::new(clip::wav16_bytes(&window)))
}

/// Render the edit to `<data_dir>/clips/` and import it as a NEW library
/// track (the sources are left untouched). Analysis is queued by the
/// import, so BPM/key land like any other track.
#[tauri::command(async)]
pub fn clip_save(state: State<AppState>, request: ClipRequest, title: String) -> CmdResult<Track> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(CmdError::invalid("clip: the new track needs a name"));
    }
    let rendered = request.render(&state)?;

    let dir = clip::clips_dir(state.library.data_dir());
    let name = dj_library::providers::sanitize_filename(&title);
    let path = dj_library::providers::unique_path(&dir.join(format!("{name}.flac")));
    clip::write_clip(&path, &rendered).map_err(err)?;

    // A clip is a derivative work: it inherits the first source's artist
    // and license, and records the tracks it was cut from.
    let first = state.library.track(request.sources[0]).map_err(err)?;
    let source_ref = request
        .sources
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let outcome = state
        .library
        .import_file(
            &path,
            ImportOptions {
                source: "clip".into(),
                source_ref,
                license: first.license,
                title: Some(title),
                artist: Some(first.artist),
                album: Some("Clips".into()),
            },
        )
        .map_err(err)?;
    if let ImportOutcome::Duplicate(_) = &outcome {
        // Byte-identical to a clip already in the library; drop the copy.
        let _ = std::fs::remove_file(&path);
    }
    Ok(outcome.track().clone())
}
