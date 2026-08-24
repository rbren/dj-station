//! The Beatify clip builder's IPC: what can be cut up, and what the
//! cuttings sound like.
//!
//! A beatified track brings ONE grid with it, and everything here hangs
//! off that: the seed render, its stems and any clip built out of them all
//! share beat times, so assembling a clip is arithmetic (see
//! [`dj_analysis::beatify::build`]) rather than another stretch.
//!
//! Sources resolve lazily and cache on DISK, not in memory:
//!
//! * `seed` is the warped render Save already wrote;
//! * a `stem` is the separated FLAC pulled through the SAME warp map the
//!   seed was rendered with — without that it would drift against the
//!   grid within a bar — cached next to the record as `stems/<name>.wav`;
//! * a `clip` is assembled on demand from its placements.
//!
//! Nothing here touches the engine or the RT thread, and every command is
//! `async`: warping a stem is a multi-second job the first time.

use dj_analysis::beatify::{build, store, BeatifyRecord, Grid, WarpMap};
use dj_analysis::AudioData;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

use crate::{err, AppState, CmdError, CmdResult};

/// Same cap as the rest of Beatify: preview bytes cross IPC in one piece.
const MAX_PREVIEW_SECS: f64 = 120.0;
const MAX_BUCKETS: usize = 20_000;
/// A clip made of clips made of clips is a mistake, not a feature.
const MAX_DEPTH: usize = 4;
const CLIPS_NAME: &str = "clips.json";

/// Which audio a run of beats was cut from.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClipSourceRef {
    /// The beatified render of the track itself.
    Seed,
    Stem { name: String },
    Clip { id: String },
}

impl ClipSourceRef {
    fn key(&self) -> String {
        match self {
            ClipSourceRef::Seed => "seed".into(),
            ClipSourceRef::Stem { name } => format!("stem:{name}"),
            ClipSourceRef::Clip { id } => format!("clip:{id}"),
        }
    }
}

/// One run of beats, placed once. The field names are the frontend's
/// model verbatim (`app/src/beatifyClip.ts`) so a draft crosses IPC as it
/// stands.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipPlacement {
    pub id: String,
    pub row: usize,
    pub col: usize,
    pub beats: usize,
    pub source: ClipSourceRef,
    pub source_beat: usize,
}

/// A clip, saved or still being dragged around.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipDraft {
    pub name: String,
    pub rows: usize,
    pub columns: usize,
    pub placements: Vec<ClipPlacement>,
}

impl ClipDraft {
    /// Beats up to the end of the last thing in it.
    fn used_columns(&self) -> usize {
        self.placements
            .iter()
            .map(|p| p.col + p.beats)
            .max()
            .unwrap_or(0)
    }

    /// How long the clip IS: the length it was set to, trailing silence
    /// and all, never shorter than the material in it and never zero.
    fn length_columns(&self) -> usize {
        self.columns.max(self.used_columns()).max(1)
    }
}

/// A clip on disk. Same shape plus the id it is filed under.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedClip {
    pub id: String,
    pub name: String,
    pub rows: usize,
    pub columns: usize,
    pub placements: Vec<ClipPlacement>,
}

/// What the left-hand list shows for one source.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSourceInfo {
    pub source: ClipSourceRef,
    pub label: String,
    /// False when the audio is not there yet (stems not separated).
    pub available: bool,
    /// Why not, and what to do about it — shown in the list.
    pub hint: Option<String>,
}

/// The left-hand list: the seed, its stems, and everything built so far.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSources {
    pub sources: Vec<ClipSourceInfo>,
    pub clips: Vec<SavedClip>,
    pub grid: GridInfo,
}

/// The grid every source on the page shares.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridInfo {
    pub bpm: f64,
    pub period: f64,
    pub phase: f64,
    pub beats: usize,
}

impl From<&Grid> for GridInfo {
    fn from(g: &Grid) -> Self {
        GridInfo {
            bpm: g.bpm,
            period: g.period,
            phase: g.phase,
            beats: g.beats,
        }
    }
}

/// A source opened for the timeline: what to draw and how long it is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSourceAudio {
    pub source: ClipSourceRef,
    pub label: String,
    pub duration_secs: f64,
    pub sample_rate: u32,
    pub channels: usize,
    pub beats: usize,
    pub peaks: Vec<f32>,
}

// ---------------------------------------------------------------------------
// Resolving sources
// ---------------------------------------------------------------------------

/// Everything a request needs to turn a source into samples, including a
/// cache so a draft that uses the seed twenty times decodes it once.
struct Resolver<'a> {
    state: &'a AppState,
    track_id: i64,
    hash: String,
    record: BeatifyRecord,
    clips: Vec<SavedClip>,
    cache: HashMap<String, Arc<AudioData>>,
}

impl<'a> Resolver<'a> {
    fn new(state: &'a AppState, track_id: i64) -> CmdResult<Self> {
        let track = state.library.track(track_id).map_err(err)?;
        let record = store::load(state.library.data_dir(), &track.content_hash)
            .map_err(err)?
            .ok_or_else(|| {
                CmdError::invalid(format!(
                    "beatify: {} has not been beatified yet — open it first",
                    track.title
                ))
            })?;
        let clips = read_clips(state, &track.content_hash)?;
        Ok(Resolver {
            state,
            track_id,
            hash: track.content_hash,
            record,
            clips,
            cache: HashMap::new(),
        })
    }

    fn grid(&self) -> &Grid {
        &self.record.grid
    }

    fn audio(&mut self, source: &ClipSourceRef, depth: usize) -> CmdResult<Arc<AudioData>> {
        if depth > MAX_DEPTH {
            return Err(CmdError::invalid(
                "beatify: this clip is built out of itself",
            ));
        }
        let key = source.key();
        if let Some(hit) = self.cache.get(&key) {
            return Ok(Arc::clone(hit));
        }
        let audio = match source {
            ClipSourceRef::Seed => self.seed()?,
            ClipSourceRef::Stem { name } => self.stem(name)?,
            ClipSourceRef::Clip { id } => {
                let clip = self
                    .clips
                    .iter()
                    .find(|c| &c.id == id)
                    .cloned()
                    .ok_or_else(|| {
                        CmdError::invalid(format!("beatify: no saved clip {id} for this track"))
                    })?;
                let draft = ClipDraft {
                    name: clip.name,
                    rows: clip.rows,
                    columns: clip.columns,
                    placements: clip.placements,
                };
                Arc::new(self.assemble(&draft, depth + 1)?)
            }
        };
        self.cache.insert(key, Arc::clone(&audio));
        Ok(audio)
    }

    fn seed(&self) -> CmdResult<Arc<AudioData>> {
        let path = store::warped_path(self.state.library.data_dir(), &self.hash);
        Ok(Arc::new(decode(&path, "the beatified render")?))
    }

    /// A stem on the grid: the separated FLAC pulled through the seed's
    /// warp map, cached as a wav so the WSOLA render is paid once.
    fn stem(&self, name: &str) -> CmdResult<Arc<AudioData>> {
        let cached = self.stem_path(name);
        if cached.is_file() {
            return Ok(Arc::new(decode(&cached, name)?));
        }
        let index = dj_analysis::STEM_NAMES
            .iter()
            .position(|s| *s == name)
            .ok_or_else(|| {
                CmdError::invalid(format!(
                    "beatify: unknown stem {name:?} (expected one of {})",
                    dj_analysis::STEM_NAMES.join(", ")
                ))
            })?;
        let paths = self
            .state
            .stems
            .cached_paths(self.track_id)
            .ok_or_else(|| CmdError::invalid(stem_hint(self.state)))?;
        let raw = decode(&paths[index], name)?;
        let map = WarpMap {
            points: self
                .record
                .warp
                .map
                .iter()
                .map(|p| (p[0], p[1]))
                .collect::<Vec<_>>(),
        };
        // The output is as long as the seed's render, so every stem lines
        // up with it sample for sample.
        let out_secs = self.grid().phase + self.grid().beats as f64 * self.grid().period;
        let warped = build_warp(&raw, &map, out_secs);
        if let Some(dir) = cached.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Best effort: a clip still plays if the cache cannot be written.
        let _ = std::fs::write(&cached, dj_analysis::clip::wav16_bytes(&warped));
        Ok(Arc::new(warped))
    }

    fn stem_path(&self, name: &str) -> PathBuf {
        store::record_dir(self.state.library.data_dir(), &self.hash)
            .join("stems")
            .join(format!("{name}.wav"))
    }

    /// Lay every placement down on the shared grid and mix.
    fn assemble(&mut self, draft: &ClipDraft, depth: usize) -> CmdResult<AudioData> {
        let grid = *self.grid();
        let columns = draft.length_columns();
        let out_secs = build::clip_secs(&grid, columns).min(MAX_PREVIEW_SECS);

        // Resolve first: `Lay` borrows the audio, so every source has to
        // be in hand before any of them is pointed at.
        let mut parts: Vec<(Arc<AudioData>, &ClipPlacement)> = Vec::new();
        for placement in &draft.placements {
            let audio = self.audio(&placement.source, depth)?;
            parts.push((audio, placement));
        }
        let (sample_rate, channels) = parts
            .first()
            .map(|(a, _)| (a.sample_rate, a.channels.len()))
            .unwrap_or((44_100, 2));
        let lays: Vec<build::Lay> = parts
            .iter()
            .map(|(audio, p)| {
                // Beat times are the grid's, whichever source this is:
                // that is what beatifying bought.
                let (from_secs, at_secs, secs) = build::span(&grid, p.source_beat, p.col, p.beats);
                build::Lay {
                    audio: audio.as_ref(),
                    from_secs,
                    at_secs,
                    secs,
                }
            })
            .collect();
        Ok(build::assemble(&lays, out_secs, sample_rate, channels))
    }
}

/// Warp with the seed's map. Split out so the "no warp at all" position
/// (MOD-17) skips the stretch entirely, like the seed render does.
fn build_warp(audio: &AudioData, map: &WarpMap, out_secs: f64) -> AudioData {
    if map.points.is_empty() || map.is_identity() {
        return dj_analysis::clip::slice(audio, 0.0, out_secs);
    }
    dj_analysis::beatify::warp::render(audio, map, out_secs)
}

fn decode(path: &std::path::Path, what: &str) -> CmdResult<AudioData> {
    dj_analysis::decode_audio(path).map_err(|e| err(format!("reading {what}: {e}")))
}

fn stem_hint(state: &AppState) -> String {
    format!(
        "no {} stems yet — separate this track on the Clip page first",
        state.stems.backend()
    )
}

fn wav(audio: &AudioData) -> CmdResult<tauri::ipc::Response> {
    if audio.frames() == 0 {
        return Err(CmdError::invalid("beatify: nothing to play there"));
    }
    Ok(tauri::ipc::Response::new(dj_analysis::clip::wav16_bytes(
        audio,
    )))
}

// ---------------------------------------------------------------------------
// Saved clips
// ---------------------------------------------------------------------------

fn clips_path(state: &AppState, hash: &str) -> PathBuf {
    store::record_dir(state.library.data_dir(), hash).join(CLIPS_NAME)
}

fn read_clips(state: &AppState, hash: &str) -> CmdResult<Vec<SavedClip>> {
    let path = clips_path(state, hash);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| err(format!("reading clips: {e}")))?;
    serde_json::from_str(&text).map_err(|e| err(format!("reading clips: {e}")))
}

fn write_clips(state: &AppState, hash: &str, clips: &[SavedClip]) -> CmdResult<()> {
    let path = clips_path(state, hash);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| err(format!("writing clips: {e}")))?;
    }
    let json =
        serde_json::to_string_pretty(clips).map_err(|e| err(format!("writing clips: {e}")))?;
    std::fs::write(&path, json).map_err(|e| err(format!("writing clips: {e}")))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// What this track can be cut up into (BC-1).
#[tauri::command(async)]
pub fn beatify_clip_sources(state: State<AppState>, track_id: i64) -> CmdResult<ClipSources> {
    let resolver = Resolver::new(&state, track_id)?;
    let stems_ready = state.stems.cached_paths(track_id).is_some();
    let hint = (!stems_ready).then(|| stem_hint(&state));
    let mut sources = vec![ClipSourceInfo {
        source: ClipSourceRef::Seed,
        label: "Seed track".into(),
        available: true,
        hint: None,
    }];
    sources.extend(dj_analysis::STEM_NAMES.iter().map(|name| ClipSourceInfo {
        source: ClipSourceRef::Stem {
            name: (*name).into(),
        },
        label: (*name).into(),
        available: stems_ready,
        hint: hint.clone(),
    }));
    Ok(ClipSources {
        sources,
        clips: resolver.clips.clone(),
        grid: GridInfo::from(resolver.grid()),
    })
}

/// Open a source in the timeline: its length and its waveform.
#[tauri::command(async)]
pub fn beatify_clip_open(
    state: State<AppState>,
    track_id: i64,
    source: ClipSourceRef,
    buckets: usize,
) -> CmdResult<ClipSourceAudio> {
    let mut resolver = Resolver::new(&state, track_id)?;
    let label = match &source {
        ClipSourceRef::Seed => "Seed track".to_string(),
        ClipSourceRef::Stem { name } => name.clone(),
        ClipSourceRef::Clip { id } => resolver
            .clips
            .iter()
            .find(|c| &c.id == id)
            .map(|c| c.name.clone())
            .unwrap_or_else(|| format!("clip {id}")),
    };
    let audio = resolver.audio(&source, 0)?;
    let grid = *resolver.grid();
    let duration = audio.duration_secs();
    Ok(ClipSourceAudio {
        source,
        label,
        duration_secs: duration,
        sample_rate: audio.sample_rate,
        channels: audio.channels.len(),
        beats: ((duration - grid.phase) / grid.period).floor().max(0.0) as usize,
        peaks: dj_analysis::clip::peaks(&audio, buckets.min(MAX_BUCKETS)),
    })
}

/// A window of a source, for the source pane's transport.
#[tauri::command(async)]
pub fn beatify_clip_audio(
    state: State<AppState>,
    track_id: i64,
    source: ClipSourceRef,
    start_secs: f64,
    secs: f64,
) -> CmdResult<tauri::ipc::Response> {
    let mut resolver = Resolver::new(&state, track_id)?;
    let audio = resolver.audio(&source, 0)?;
    wav(&dj_analysis::clip::slice(
        &audio,
        start_secs,
        secs.min(MAX_PREVIEW_SECS),
    ))
}

/// A window of the clip being edited — assembled from the draft, so the
/// editor plays what is on screen and not what was last saved (BC-8).
#[tauri::command(async)]
pub fn beatify_clip_preview(
    state: State<AppState>,
    track_id: i64,
    draft: ClipDraft,
    start_secs: f64,
    secs: f64,
) -> CmdResult<tauri::ipc::Response> {
    let mut resolver = Resolver::new(&state, track_id)?;
    let clip = resolver.assemble(&draft, 0)?;
    wav(&dj_analysis::clip::slice(
        &clip,
        start_secs,
        secs.min(MAX_PREVIEW_SECS),
    ))
}

/// Save the clip (BC-9). An id that already exists is overwritten, so
/// saving twice keeps one clip rather than breeding copies.
#[tauri::command(async)]
pub fn beatify_clip_save(
    state: State<AppState>,
    track_id: i64,
    clip: SavedClip,
) -> CmdResult<Vec<SavedClip>> {
    let track = state.library.track(track_id).map_err(err)?;
    let mut clips = read_clips(&state, &track.content_hash)?;
    let mut clip = clip;
    if clip.id.is_empty() {
        clip.id = next_id(&clips);
    }
    match clips.iter_mut().find(|c| c.id == clip.id) {
        Some(existing) => *existing = clip,
        None => clips.push(clip),
    }
    write_clips(&state, &track.content_hash, &clips)?;
    Ok(clips)
}

#[tauri::command(async)]
pub fn beatify_clip_delete(
    state: State<AppState>,
    track_id: i64,
    id: String,
) -> CmdResult<Vec<SavedClip>> {
    let track = state.library.track(track_id).map_err(err)?;
    let mut clips = read_clips(&state, &track.content_hash)?;
    clips.retain(|c| c.id != id);
    write_clips(&state, &track.content_hash, &clips)?;
    Ok(clips)
}

fn next_id(clips: &[SavedClip]) -> String {
    let highest = clips
        .iter()
        .filter_map(|c| c.id.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    (highest + 1).to_string()
}
