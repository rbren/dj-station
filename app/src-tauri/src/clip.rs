//! Clip page IPC (PRD §9): edit library tracks into BEAT CLIPS the decks
//! can load like any Beatify clip.
//!
//! The editor is a pure control-plane feature — it never touches the
//! engine or the RT thread. Commands decode library tracks (cached here so
//! scrubbing an edit doesn't re-decode), render a
//! [`ClipProgram`](dj_analysis::clip::ClipProgram) with `dj-analysis`, and
//! save a beat-quantized span of the result into the beat-clip store
//! below; the sources are never rewritten.
//!
//! Every command is `async` so the (multi-second) decode/render runs on
//! Tauri's worker pool instead of blocking the UI thread.
//!
//! Sources are [`ClipSourceRef`]s — a library track, or a chosen set of
//! its **stems**. Stems come from the cache that the auto-stem service
//! ([`AutoStemService`](dj_analysis::AutoStemService)) fills on its own
//! thread; the clip commands only ever *read* separated FLACs, so nothing
//! here blocks on a model — and nothing here starts one either.

use dj_analysis::clip::{self, ClipProgram};
use dj_analysis::{AudioData, TrackStems};
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
///
/// Beside the decodes it memoizes ONE rendered program: preview windows,
/// the waveform peaks, tempo detection and the save all render the SAME
/// edit, and once the program carries a tap warp each render is seconds
/// of WSOLA — re-doing it per playback window is exactly the "press play,
/// wait two seconds" jam.
#[derive(Default)]
pub struct ClipCache {
    entries: Mutex<Vec<(ClipSourceRef, Arc<AudioData>)>>,
    /// The last render, keyed by the request (sans `beat_grid`, which
    /// never touches the audio).
    rendered: Mutex<Option<(String, Arc<AudioData>)>>,
    /// Held across a render so a concurrent command WAITS for the render
    /// in flight and then reuses it, instead of duplicating the work.
    render_gate: Mutex<()>,
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

    /// Drop every decode of a track. SQLite hands the next import the
    /// rowid a delete freed, so a kept entry would answer for a different
    /// track's audio. The render memo goes too: its key names track ids.
    pub(crate) fn forget(&self, track_id: i64) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|(k, _)| k.track_id != track_id);
        }
        if let Ok(mut rendered) = self.rendered.lock() {
            *rendered = None;
        }
    }

    fn put(&self, key: ClipSourceRef, audio: Arc<AudioData>) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|(k, _)| *k != key);
            entries.push((key, audio));
            let overflow = entries.len().saturating_sub(MAX_CACHED_SOURCES);
            entries.drain(..overflow);
        }
    }

    fn render_hit(&self, key: &str) -> Option<Arc<AudioData>> {
        let rendered = self.rendered.lock().ok()?;
        rendered
            .as_ref()
            .filter(|(k, _)| k == key)
            .map(|(_, a)| Arc::clone(a))
    }

    fn keep_render(&self, key: String, audio: Arc<AudioData>) {
        if let Ok(mut rendered) = self.rendered.lock() {
            *rendered = Some((key, audio));
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

    /// What identifies a render: the sources and the program, minus the
    /// beat grid — the grid never touches the audio, so extending it (or
    /// moving its beats) must not throw the memoized render away.
    fn render_key(&self) -> CmdResult<String> {
        let mut program = self.program.clone();
        program.beat_grid = None;
        serde_json::to_string(&(&self.sources, &program))
            .map_err(|e| err(format!("clip: {e}")))
    }

    /// Render the edit, through the [`ClipCache`] memo. The gate makes a
    /// concurrent identical request (preview window during detection,
    /// say) wait and reuse instead of rendering twice.
    fn render(&self, state: &AppState) -> CmdResult<Arc<AudioData>> {
        let key = self.render_key()?;
        if let Some(hit) = state.clips.render_hit(&key) {
            return Ok(hit);
        }
        let _gate = state.clips.render_gate.lock();
        if let Some(hit) = state.clips.render_hit(&key) {
            return Ok(hit);
        }
        let sources = self.decode(state)?;
        let refs: Vec<&AudioData> = sources.iter().map(|a| a.as_ref()).collect();
        let out = clip::render_clip(&refs, &self.program)
            .map(Arc::new)
            .map_err(|e| CmdError::invalid(e.to_string()))?;
        state.clips.keep_render(key, Arc::clone(&out));
        Ok(out)
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

/// Where one track's stems stand. Nobody asks for a separation any more:
/// the service does every download on its own, so all the UI can do is
/// say whether they are here yet — and, when they are never coming, why.
#[derive(Debug, Serialize)]
pub struct ClipStemStatus {
    track_id: i64,
    backend: String,
    /// `ready` | `loading` | `failed` | `unavailable`.
    state: &'static str,
    /// What the separation is doing, while it is this track's turn.
    stage: Option<String>,
    /// Why there will be no stems (missing tooling, repeated failure,
    /// automatic separation switched off).
    detail: Option<String>,
    /// Tracks still waiting for stems, this one included.
    pending: usize,
}

/// What the stem backend is, and whether it can run here.
///
/// The answer comes from the auto-stem service's own probe rather than a
/// fresh one: probing spawns the tool, and the page asks every time it
/// mounts.
#[tauri::command(async)]
pub fn clip_stem_backend(state: State<AppState>) -> ClipStemBackend {
    let status = state.auto_stems.status();
    ClipStemBackend {
        backend: status.backend,
        available: status.detail.is_none(),
        detail: status.detail,
        stems: dj_analysis::STEM_NAMES.iter().map(|s| s.to_string()).collect(),
    }
}

/// Where `track_id`'s stems stand — and, in passing, a note that somebody
/// is waiting on them.
///
/// Asking IS the request: the backfill works through a whole library, and
/// a track the editor has open should not wait behind a hundred others.
/// There is no separate "separate this track" command to press, forget or
/// call twice.
#[tauri::command(async)]
pub fn clip_stem_status(state: State<AppState>, track_id: i64) -> ClipStemStatus {
    state.auto_stems.want(track_id);
    let (stem_state, stage, detail) = match state.auto_stems.track_stems(track_id) {
        TrackStems::Ready => ("ready", None, None),
        TrackStems::Loading { stage } => ("loading", stage, None),
        TrackStems::Failed { detail } => ("failed", None, Some(detail)),
        TrackStems::Unavailable { detail } => ("unavailable", None, Some(detail)),
    };
    let service = state.auto_stems.status();
    ClipStemStatus {
        track_id,
        backend: service.backend,
        state: stem_state,
        stage,
        detail,
        pending: service.pending,
    }
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

// ---------------------------------------------------------------------------
// Beat clips: the Clip tab's saved output
// ---------------------------------------------------------------------------
//
// A BEAT CLIP is a rendered span of the edit cut to a whole number of
// beats — the thing the Decks (and the module picker's Clips tab) can
// load exactly like a Beatify clip. The store itself lives in
// `dj_analysis::clip` (`<data_dir>/beat-clips/`); it is surfaced through
// the SAME doors Beatify clips use: appended to `beat_clip_list` under
// the reserved project id [`BEAT_CLIPS_PROJECT`], and
// `beatify_clip::render_clip` routes that id here — so `beat_clip_load`,
// patch-load hydration and copy/paste need no second code path.

/// Reserved "project" id beat clips are listed under. Beatify mints
/// project ids as `p<n>` (legacy: source-hash directory names), so this
/// can never collide with a real project.
pub const BEAT_CLIPS_PROJECT: &str = "beat-clips";
/// Where the pickers say a beat clip came from when it does not say
/// itself — clips saved before they carried a source-track title.
pub const BEAT_CLIPS_PROJECT_NAME: &str = "Clip tab";

/// The title a beat clip shows where a Beatify clip shows its project
/// name: the source track it was cut from, as saved (and edited) on the
/// Clip page, falling back to [`BEAT_CLIPS_PROJECT_NAME`] for clips
/// saved before the field existed.
pub fn beat_clip_source_name(meta: &clip::BeatClipMeta) -> String {
    if meta.source_title.is_empty() {
        BEAT_CLIPS_PROJECT_NAME.into()
    } else {
        meta.source_title.clone()
    }
}

/// Tempo of a span of the edit, measured: what the save row shows when
/// the selection was never tapped. Runs the Beatify tracker (`beat_this`
/// when installed, the DSP fallback otherwise) over the rendered output.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipBeats {
    pub bpm: f64,
    /// Beats the span covers at that tempo — fractional until the save
    /// pads the last one with silence.
    pub beats: f64,
    /// Which tracker actually produced the beats.
    pub tracker: String,
}

#[tauri::command(async)]
pub fn clip_detect_beats(
    state: State<AppState>,
    request: ClipRequest,
    start_secs: f64,
    end_secs: f64,
) -> CmdResult<ClipBeats> {
    let rendered = request.render(&state)?;
    let (a, b) = span_of(&rendered, start_secs, end_secs)?;
    let tracker = dj_analysis::beatify::detect::default_tracker();
    let analysis =
        dj_analysis::beatify::analyze(&rendered, tracker.as_ref(), Some((a, b)), Default::default())
            .map_err(|e| CmdError::invalid(format!("clip: {e}")))?;
    let bpm = analysis.grid.bpm;
    Ok(ClipBeats {
        bpm,
        beats: (b - a) * bpm / 60.0,
        tracker: analysis.tracker,
    })
}

/// What the tracker heard over a tapped span (`clip_tap_beats`). Empty
/// `times` is the graceful refusal: nothing fit, `detail` says why, and
/// the UI falls back to the taps themselves.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipTapBeats {
    /// The chosen seed's actual beat times over the tapped span.
    pub times: Vec<f64>,
    pub bpm: f64,
    /// Which seed the taps chose.
    pub seed: String,
    /// Which tracker produced the runs.
    pub tracker: String,
    /// One line for the status row, either way.
    pub detail: String,
}

/// The measured beat grid for a run of right-shift taps (PRD §9): the
/// Beatify tracker runs over the span the taps covered, the taps choose
/// the seed (and metrical reading) that best fits them, and the chosen
/// seed's beat times come back for the UI to stretch by the same rules
/// raw taps use. Refusals are an answer, not an error — the taps still
/// make a grid on their own.
#[tauri::command(async)]
pub fn clip_tap_beats(
    state: State<AppState>,
    request: ClipRequest,
    taps: Vec<f64>,
) -> CmdResult<ClipTapBeats> {
    let rendered = request.render(&state)?;
    let tracker = dj_analysis::beatify::detect::default_tracker();
    match clip::beats_from_taps(&rendered, tracker.as_ref(), &taps) {
        Ok(heard) => Ok(ClipTapBeats {
            detail: format!(
                "{} heard {} beats at {:.1} BPM over the tapped span (seed {})",
                heard.tracker,
                heard.times.len(),
                heard.bpm,
                heard.seed,
            ),
            times: heard.times,
            bpm: heard.bpm,
            seed: heard.seed,
            tracker: heard.tracker,
        }),
        Err(e) => Ok(ClipTapBeats {
            times: Vec::new(),
            bpm: 0.0,
            seed: String::new(),
            tracker: String::new(),
            detail: e.to_string(),
        }),
    }
}

fn span_of(rendered: &AudioData, start_secs: f64, end_secs: f64) -> CmdResult<(f64, f64)> {
    let dur = rendered.duration_secs();
    let a = start_secs.max(0.0).min(dur);
    let b = end_secs.max(0.0).min(dur);
    if b - a <= 0.0 {
        return Err(CmdError::invalid("clip: nothing selected to save"));
    }
    Ok((a, b))
}

/// Render the selected span to `<data_dir>/beat-clips/`, cut to exactly
/// `beats` whole beats at `bpm` — the numbers the save row showed, so
/// selecting two beats files two (a fractional tail is silence-filled,
/// an overhang trimmed). The saved clip loads into the decks exactly
/// like a Beatify clip (see `beat_clip.rs`). `source_title` is the
/// second name filed with it — the track it was cut from, as shown (and
/// edited) in the save row — which the decks display where a Beatify
/// clip shows its project name.
#[tauri::command(async)]
// The arguments ARE the IPC surface: each one is a field the save row
// sends by name, so bundling them into a struct would only move the list.
#[allow(clippy::too_many_arguments)]
pub fn clip_save_beat_clip(
    state: State<AppState>,
    request: ClipRequest,
    title: String,
    source_title: String,
    start_secs: f64,
    end_secs: f64,
    bpm: f64,
    beats: usize,
) -> CmdResult<clip::BeatClipMeta> {
    let rendered = request.render(&state)?;
    let (a, b) = span_of(&rendered, start_secs, end_secs)?;
    let span = clip::slice(&rendered, a, b - a);

    // What the clip is made of, for the tags every picker shows. An
    // empty stem set is the whole mix, so it folds to all four.
    let stems = dj_analysis::stem_union(
        &request
            .sources
            .iter()
            .map(|s| s.normalized().map(|s| s.stems))
            .collect::<CmdResult<Vec<_>>>()?,
    );

    clip::save_beat_clip(
        state.library.data_dir(),
        &title,
        &source_title,
        &span,
        bpm,
        beats,
        stems,
    )
    .map_err(|e| CmdError::invalid(format!("clip: {e}")))
}
