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
//!
//! Sources are [`ClipSourceRef`]s — a library track, or one **isolated
//! stem** of it. Stems come from the cache that
//! [`StemJobs`](dj_analysis::StemJobs) fills on its own threads
//! (`htdemucs_ft` runs for minutes); the clip commands only ever *read*
//! separated FLACs, so nothing here blocks on a model.

use dj_analysis::clip::{self, ClipProgram};
use dj_analysis::AudioData;
use dj_library::{ImportOptions, ImportOutcome, Track};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::State;

use crate::{err, AppState, CmdError, CmdResult};

/// One thing the editor can cut from: a library track, or a chosen set of
/// its stems mixed together ("vocals + drums", "everything but the
/// bass"). The set is part of the identity, so "the vocals of track 7"
/// and "track 7" are different sources.
///
/// An EMPTY set means the full mix, and that is also how every stem
/// switched on is sent: the track's own file is exact and needs no
/// separation, where re-summing four stems is neither.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
pub struct ClipSourceRef {
    pub track_id: i64,
    /// Empty = the full mix; otherwise [`STEM_NAMES`] entries.
    #[serde(default)]
    pub stems: Vec<String>,
}

impl ClipSourceRef {
    /// Indices into [`STEM_NAMES`], in that order and without repeats, or
    /// an error naming the valid choices. The full mix yields an empty
    /// vec.
    fn stem_indices(&self) -> CmdResult<Vec<usize>> {
        let mut indices = Vec::new();
        for name in self.stems.iter().filter(|s| !s.is_empty()) {
            let i = dj_analysis::STEM_NAMES
                .iter()
                .position(|s| s == name)
                .ok_or_else(|| {
                    CmdError::invalid(format!(
                        "clip: unknown stem {name:?} (expected one of {})",
                        dj_analysis::STEM_NAMES.join(", ")
                    ))
                })?;
            if !indices.contains(&i) {
                indices.push(i);
            }
        }
        indices.sort_unstable();
        Ok(indices)
    }

    /// The same source with its stems validated and put in a canonical
    /// order, so `{drums, vocals}` and `{vocals, drums}` are one cache
    /// entry and one `source_ref`.
    fn normalized(&self) -> CmdResult<ClipSourceRef> {
        let indices = self.stem_indices()?;
        Ok(ClipSourceRef {
            track_id: self.track_id,
            stems: indices
                .iter()
                .map(|i| dj_analysis::STEM_NAMES[*i].to_string())
                .collect(),
        })
    }
}

/// Decoded sources for the Clip page, keyed by [`ClipSourceRef`]. Bounded
/// so a long editing session can't pin every track ever opened in memory.
#[derive(Default)]
pub struct ClipCache {
    entries: Mutex<Vec<(ClipSourceRef, Arc<AudioData>)>>,
}

const MAX_CACHED_SOURCES: usize = 4;

impl ClipCache {
    fn get(&self, key: &ClipSourceRef) -> Option<Arc<AudioData>> {
        let entries = self.entries.lock().ok()?;
        entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, a)| Arc::clone(a))
    }

    fn put(&self, key: ClipSourceRef, audio: Arc<AudioData>) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|(k, _)| *k != key);
            entries.push((key, audio));
            let overflow = entries.len().saturating_sub(MAX_CACHED_SOURCES);
            entries.drain(..overflow);
        }
    }
}

/// Decode a source — a library track, or one of its cached stems — using
/// (and filling) the cache.
///
/// A stem source reads the FLAC that separation already wrote; it never
/// runs separation itself, because that takes minutes and belongs on a
/// [`StemJobs`](dj_analysis::StemJobs) thread (see `clip_stem_separate`).
fn source_audio(state: &AppState, source: &ClipSourceRef) -> CmdResult<Arc<AudioData>> {
    let source = source.normalized()?;
    if let Some(audio) = state.clips.get(&source) {
        return Ok(audio);
    }
    let track = state.library.track(source.track_id).map_err(err)?;
    let indices = source.stem_indices()?;
    let audio = if indices.is_empty() {
        decode(&std::path::PathBuf::from(&track.file_path), &track.title)?
    } else {
        let paths = state.stems.cached_paths(source.track_id).ok_or_else(|| {
            CmdError::invalid(format!(
                "clip: {} has no {} stems yet — separate it first",
                track.title,
                state.stems.backend()
            ))
        })?;
        let parts = indices
            .iter()
            .map(|i| decode(&paths[*i], &track.title))
            .collect::<CmdResult<Vec<_>>>()?;
        let refs: Vec<&AudioData> = parts.iter().map(|a| a.as_ref()).collect();
        Arc::new(dj_analysis::mix_stems(&refs).map_err(|e| err(e.to_string()))?)
    };
    state.clips.put(source, Arc::clone(&audio));
    Ok(audio)
}

fn decode(path: &std::path::Path, title: &str) -> CmdResult<Arc<AudioData>> {
    dj_analysis::decode_audio(path)
        .map(Arc::new)
        .map_err(|e| err(format!("decoding {title}: {e}")))
}

/// An edit as the UI sends it: `program` regions index into `sources`,
/// which keeps `dj-analysis` free of library types.
#[derive(Debug, Deserialize)]
pub struct ClipRequest {
    sources: Vec<ClipSourceRef>,
    program: ClipProgram,
}

impl ClipRequest {
    fn decode(&self, state: &AppState) -> CmdResult<Vec<Arc<AudioData>>> {
        if self.sources.is_empty() {
            return Err(CmdError::invalid("clip: no source tracks"));
        }
        self.sources
            .iter()
            .map(|source| source_audio(state, source))
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
    /// Which stems this lane is, echoed back (canonically ordered) so the
    /// UI can label it. Empty = the full mix.
    stems: Vec<String>,
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

/// Decode a library track (or one of its separated stems) for editing and
/// return its waveform overview.
#[tauri::command(async)]
pub fn clip_load_source(
    state: State<AppState>,
    track_id: i64,
    stems: Vec<String>,
    buckets: usize,
) -> CmdResult<ClipSource> {
    let track = state.library.track(track_id).map_err(err)?;
    let source = ClipSourceRef { track_id, stems }.normalized()?;
    let audio = source_audio(&state, &source)?;
    Ok(ClipSource {
        track_id,
        stems: source.stems,
        title: track.title,
        artist: track.artist,
        duration_secs: audio.duration_secs(),
        sample_rate: audio.sample_rate,
        channels: audio.channels.len(),
        peaks: clip::peaks(&audio, buckets.min(MAX_BUCKETS)),
    })
}

/// What the Clip page needs to render its stem controls: which backend is
/// configured, whether its tooling is actually installed, and the stem
/// names. `available: false` is a normal state, not an error — the UI
/// shows the reason and disables the isolate action.
#[derive(Debug, Serialize)]
pub struct ClipStemBackend {
    /// Separator id — the model name for demucs, e.g. `htdemucs_ft`.
    backend: String,
    available: bool,
    /// Install hint / failure reason when `available` is false.
    detail: Option<String>,
    stems: Vec<String>,
}

/// Separation state for one track under the configured backend.
#[derive(Debug, Serialize)]
pub struct ClipStemStatus {
    track_id: i64,
    backend: String,
    /// Stems are on disk and can be loaded as sources right now.
    cached: bool,
    /// A separation for this track is running.
    running: bool,
}

/// Is the stem backend usable on this machine? Probing spawns the tool, so
/// this is `async` (off the UI thread) like every other clip command.
#[tauri::command(async)]
pub fn clip_stem_backend(state: State<AppState>) -> ClipStemBackend {
    let detail = state.stem_separator.probe().err().map(|e| format!("{e:#}"));
    ClipStemBackend {
        backend: state.stems.backend().to_string(),
        available: detail.is_none(),
        detail,
        stems: dj_analysis::STEM_NAMES.iter().map(|s| s.to_string()).collect(),
    }
}

/// Whether `track_id` already has stems for the configured backend.
#[tauri::command(async)]
pub fn clip_stem_status(state: State<AppState>, track_id: i64) -> ClipStemStatus {
    ClipStemStatus {
        track_id,
        backend: state.stems.backend().to_string(),
        cached: state.stems.cached(track_id),
        running: state
            .stems
            .jobs()
            .iter()
            .any(|j| j.track_id == track_id && j.is_running()),
    }
}

/// Start separating `track_id` in the background, returning the job id.
/// Returns immediately: `htdemucs_ft` runs for minutes, so the UI polls
/// `clip_stem_jobs` instead of waiting. A cached track finishes instantly.
#[tauri::command(async)]
pub fn clip_stem_separate(state: State<AppState>, track_id: i64) -> CmdResult<u64> {
    // Fail loudly here rather than spawning a job that cannot succeed.
    state
        .stem_separator
        .probe()
        .map_err(|e| CmdError::invalid(format!("{e:#}")))?;
    state.library.track(track_id).map_err(err)?;
    Ok(state.stems.start(track_id))
}

/// Abandon the separation running for `track_id`, killing the work in
/// flight. Returns whether there was one. Nothing is cached, so the
/// track can simply be separated again.
#[tauri::command(async)]
pub fn clip_stem_cancel(state: State<AppState>, track_id: i64) -> bool {
    state.stems.cancel_track(track_id)
}

/// Snapshot of separation jobs (the Clip page polls this for progress).
#[tauri::command(async)]
pub fn clip_stem_jobs(state: State<AppState>) -> Vec<dj_analysis::StemJob> {
    state.stems.jobs()
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
    // and license, and records the tracks (and stems) it was cut from.
    let first = state
        .library
        .track(request.sources[0].track_id)
        .map_err(err)?;
    let source_ref = request
        .sources
        .iter()
        .map(|s| {
            let s = s.normalized()?;
            Ok(if s.stems.is_empty() {
                s.track_id.to_string()
            } else {
                format!("{}:{}", s.track_id, s.stems.join("+"))
            })
        })
        .collect::<CmdResult<Vec<_>>>()?
        .into_iter()
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
