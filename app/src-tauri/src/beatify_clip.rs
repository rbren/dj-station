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

/// A project outlives its source: the render is its own, but anything
/// that needs the ORIGINAL file (stems, re-beatify) cannot be done.
const SOURCE_GONE: &str =
    "beatify: this project's source track is no longer in the library — re-import it for stems";

/// Same cap as the rest of Beatify: preview bytes cross IPC in one piece.
const MAX_PREVIEW_SECS: f64 = 120.0;
const MAX_BUCKETS: usize = 20_000;
/// A clip made of clips made of clips is a mistake, not a feature.
const MAX_DEPTH: usize = 4;
const CLIPS_NAME: &str = "clips.json";

/// Which audio a run of beats was cut from.
///
/// A STEM IS NOT A SOURCE OF ITS OWN: it is a seed with some of its parts
/// switched off, exactly as on the Clip page. `stems` empty means the
/// whole mix — and then the render itself is played, rather than four
/// separated files summed back together.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClipSourceRef {
    /// The beatified render of one seed, whole or in parts.
    Seed {
        /// Which seed. Empty means the project's first, which is what a
        /// clip saved before projects held more than one seed says.
        #[serde(default)]
        id: String,
        #[serde(default)]
        stems: Vec<String>,
    },
    /// A stem as its own entry — the shape clips were saved in before
    /// stems became a switch on their seed. Read, never written.
    Stem { name: String },
    Clip { id: String },
}

impl ClipSourceRef {
    fn key(&self) -> String {
        match self {
            ClipSourceRef::Seed { id, stems } if stems.is_empty() => format!("seed:{id}"),
            ClipSourceRef::Seed { id, stems } => format!("seed:{id}/{}", stems.join("+")),
            ClipSourceRef::Stem { name } => format!("stem:{name}"),
            ClipSourceRef::Clip { id } => format!("clip:{id}"),
        }
    }

    /// The seed this refers to, once it is known which seed "" means.
    /// Adopting the old per-stem shape here is what keeps clips saved
    /// against the single-seed layout playable.
    fn resolved(&self, first_seed: &str) -> ClipSourceRef {
        match self {
            ClipSourceRef::Seed { id, stems } if id.is_empty() => ClipSourceRef::Seed {
                id: first_seed.to_string(),
                stems: stems.clone(),
            },
            ClipSourceRef::Stem { name } => ClipSourceRef::Seed {
                id: first_seed.to_string(),
                stems: vec![name.clone()],
            },
            other => other.clone(),
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

/// What a save answers with: the id it was filed under — which the
/// editor has to learn, or its next save would file a second copy — and
/// the list as it now stands.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSaved {
    pub id: String,
    pub clips: Vec<SavedClip>,
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

/// One seed in the left-hand list: what it is, and which of its parts can
/// be switched on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSourceInfo {
    /// The whole mix of this seed — what clicking its name opens.
    pub source: ClipSourceRef,
    pub seed_id: String,
    pub label: String,
    /// Beats of grid this seed's render carries.
    pub beats: usize,
    /// Tempo it was played at, and the ratio it now runs at.
    pub source_bpm: f64,
    pub speed: f64,
    /// False when the render is not readable at all.
    pub available: bool,
    pub hint: Option<String>,
    /// Stems belong to the seed they came out of, not to the list.
    pub stems: Vec<ClipStemInfo>,
}

/// One switchable part of a seed (BC-1, the Clip page's stem toggles).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipStemInfo {
    pub name: String,
    /// False when the audio is not there yet (stems not separated).
    pub available: bool,
    /// Why not, and what to do about it — shown in the list.
    pub hint: Option<String>,
}

/// The left-hand list: every seed with its stems, and everything built so
/// far.
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
/// cache so a draft that uses one seed twenty times decodes it once.
struct Resolver<'a> {
    state: &'a AppState,
    project: store::Project,
    /// Each seed's record, by seed id — the warp map a stem has to be
    /// pulled through, and the grid its render landed on.
    records: HashMap<String, BeatifyRecord>,
    clips: Vec<SavedClip>,
    cache: HashMap<String, Arc<AudioData>>,
}

impl<'a> Resolver<'a> {
    fn new(state: &'a AppState, project_id: &str) -> CmdResult<Self> {
        let data_dir = state.library.data_dir();
        let project = store::project(data_dir, project_id)
            .map_err(err)?
            .ok_or_else(|| CmdError::invalid(format!("beatify: no project {project_id}")))?;
        let mut records = HashMap::new();
        for seed in &project.seeds {
            if let Some(record) = store::load_seed(data_dir, &project.id, seed).map_err(err)? {
                records.insert(seed.id.clone(), record);
            }
        }
        let clips = read_clips(state, project_id)?;
        Ok(Resolver {
            state,
            project,
            records,
            clips,
            cache: HashMap::new(),
        })
    }

    /// Which seed a bare reference means. Clips saved when a project held
    /// exactly one seed do not name it.
    fn first_seed(&self) -> String {
        self.project
            .seeds
            .first()
            .map(|s| s.id.clone())
            .unwrap_or_default()
    }

    /// THE GRID IS THE PROJECT'S, NOT A SEED'S. Every seed was rendered
    /// onto it — conformed if it was played at another tempo — so beat n
    /// of any of them is the same instant, which is what lets one clip
    /// hold runs from several tracks.
    fn grid(&self) -> Grid {
        let period = self
            .project
            .period()
            .or_else(|| self.records.values().next().map(|r| r.grid.period))
            .unwrap_or(0.5);
        let beats = self
            .records
            .values()
            .map(|r| r.grid.beats)
            .max()
            .unwrap_or(0);
        Grid {
            bpm: 60.0 / period,
            period,
            // OUT-1a: a beat of head padding, the same for every seed.
            phase: period,
            beats,
        }
    }

    /// What the pane above calls what it is showing. A submix says which
    /// parts are on, because "Boys" playing only its drums is not "Boys".
    fn label(&self, source: &ClipSourceRef) -> String {
        match source.resolved(&self.first_seed()) {
            ClipSourceRef::Seed { id, stems } => {
                let name = self
                    .project
                    .seed(&id)
                    .map(|s| s.name.clone())
                    .unwrap_or_else(|| format!("seed {id}"));
                if stems.is_empty() {
                    name
                } else {
                    format!("{name} · {}", stems.join(" + "))
                }
            }
            ClipSourceRef::Clip { id } => self
                .clips
                .iter()
                .find(|c| c.id == id)
                .map(|c| c.name.clone())
                .unwrap_or_else(|| format!("clip {id}")),
            ClipSourceRef::Stem { name } => name,
        }
    }

    fn seed_of(&self, id: &str) -> CmdResult<&store::Seed> {
        self.project
            .seed(id)
            .ok_or_else(|| CmdError::invalid(format!("beatify: no seed {id} in this project")))
    }

    fn audio(&mut self, source: &ClipSourceRef, depth: usize) -> CmdResult<Arc<AudioData>> {
        if depth > MAX_DEPTH {
            return Err(CmdError::invalid(
                "beatify: this clip is built out of itself",
            ));
        }
        let source = source.resolved(&self.first_seed());
        let key = source.key();
        if let Some(hit) = self.cache.get(&key) {
            return Ok(Arc::clone(hit));
        }
        let audio = match &source {
            ClipSourceRef::Seed { id, stems } if stems.is_empty() => self.seed(id)?,
            ClipSourceRef::Seed { id, stems } => self.submix(id, stems)?,
            // `resolved` has turned every legacy stem into a seed.
            ClipSourceRef::Stem { name } => {
                return Err(CmdError::invalid(format!(
                    "beatify: stem {name:?} belongs to no seed"
                )))
            }
            ClipSourceRef::Clip { id } => {
                let clip = self
                    .clips
                    .iter()
                    .find(|c| &c.id == id)
                    .cloned()
                    .ok_or_else(|| {
                        CmdError::invalid(format!("beatify: no saved clip {id} in this project"))
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

    fn seed(&self, seed_id: &str) -> CmdResult<Arc<AudioData>> {
        let seed = self.seed_of(seed_id)?;
        let path = store::seed_warped_path(self.state.library.data_dir(), &self.project.id, seed);
        Ok(Arc::new(decode(&path, "the beatified render")?))
    }

    /// The seed with only some of its parts switched on: the chosen stems
    /// summed. Four-of-four is never asked for — the list turns all-on
    /// back into the whole mix, which is the render itself.
    fn submix(&self, seed_id: &str, stems: &[String]) -> CmdResult<Arc<AudioData>> {
        let mut parts = Vec::new();
        for name in stems {
            parts.push(self.stem(seed_id, name)?);
        }
        let refs: Vec<&AudioData> = parts.iter().map(|p| p.as_ref()).collect();
        Ok(Arc::new(build::mix(&refs)))
    }

    /// A stem on the grid: the separated FLAC pulled through ITS OWN
    /// seed's warp map, cached beside that seed so the WSOLA render is
    /// paid once.
    fn stem(&self, seed_id: &str, name: &str) -> CmdResult<Arc<AudioData>> {
        let seed = self.seed_of(seed_id)?;
        let cached = store::seed_stems_dir(self.state.library.data_dir(), &self.project.id, seed)
            .join(format!("{name}.wav"));
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
        let track_id = track_of(self.state, seed).ok_or_else(|| CmdError::invalid(SOURCE_GONE))?;
        let paths = self
            .state
            .stems
            .cached_paths(track_id)
            .ok_or_else(|| CmdError::invalid(stem_hint(self.state)))?;
        let record = self
            .records
            .get(seed_id)
            .ok_or_else(|| CmdError::invalid(format!("beatify: seed {seed_id} has no grid")))?;
        let raw = decode(&paths[index], name)?;
        let map = WarpMap {
            points: record.warp.map.iter().map(|p| (p[0], p[1])).collect(),
        };
        // The output is as long as that seed's render, so every stem lines
        // up with it sample for sample.
        let grid = record.grid;
        let out_secs = grid.phase + grid.beats as f64 * grid.period;
        let warped = build_warp(&raw, &map, out_secs);
        if let Some(dir) = cached.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Best effort: a clip still plays if the cache cannot be written.
        let _ = std::fs::write(&cached, dj_analysis::clip::wav16_bytes(&warped));
        Ok(Arc::new(warped))
    }

    /// Lay every placement down on the shared grid and mix.
    ///
    /// A placement whose seed has been deleted is SKIPPED rather than
    /// fatal: losing one source should cost a clip that source, not the
    /// ability to play at all.
    fn assemble(&mut self, draft: &ClipDraft, depth: usize) -> CmdResult<AudioData> {
        let grid = self.grid();
        let columns = draft.length_columns();
        let out_secs = build::clip_secs(&grid, columns).min(MAX_PREVIEW_SECS);

        // Resolve first: `Lay` borrows the audio, so every source has to
        // be in hand before any of them is pointed at.
        let mut parts: Vec<(Arc<AudioData>, &ClipPlacement)> = Vec::new();
        for placement in &draft.placements {
            match self.audio(&placement.source, depth) {
                Ok(audio) => parts.push((audio, placement)),
                Err(_) if self.missing(&placement.source) => continue,
                Err(e) => return Err(e),
            }
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

    /// Is this reference to a seed the project no longer has?
    fn missing(&self, source: &ClipSourceRef) -> bool {
        match source.resolved(&self.first_seed()) {
            ClipSourceRef::Seed { id, .. } => self.project.seed(&id).is_none(),
            _ => false,
        }
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

fn clips_path(state: &AppState, project_id: &str) -> PathBuf {
    store::project_dir(state.library.data_dir(), project_id).join(CLIPS_NAME)
}

fn read_clips(state: &AppState, project_id: &str) -> CmdResult<Vec<SavedClip>> {
    let path = clips_path(state, project_id);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| err(format!("reading clips: {e}")))?;
    serde_json::from_str(&text).map_err(|e| err(format!("reading clips: {e}")))
}

fn write_clips(state: &AppState, project_id: &str, clips: &[SavedClip]) -> CmdResult<()> {
    let path = clips_path(state, project_id);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| err(format!("writing clips: {e}")))?;
    }
    let json =
        serde_json::to_string_pretty(clips).map_err(|e| err(format!("writing clips: {e}")))?;
    std::fs::write(&path, json).map_err(|e| err(format!("writing clips: {e}")))
}

/// Which library row a seed was cut from, by hash first: ids are
/// re-assigned on re-import, the audio is not.
fn track_of(state: &AppState, seed: &store::Seed) -> Option<i64> {
    if let Ok(Some(found)) = state.library.track_by_hash(&seed.source_hash) {
        return Some(found.id);
    }
    state.library.track(seed.track_id).ok().map(|t| t.id)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// What this project can be cut up into (BC-1): every seed, the stems
/// each of them can be broken into, and the clips built so far.
#[tauri::command(async)]
pub fn beatify_clip_sources(
    state: State<AppState>,
    project_id: String,
) -> CmdResult<ClipSources> {
    let resolver = Resolver::new(&state, &project_id)?;
    let grid = resolver.grid();
    let sources = resolver
        .project
        .seeds
        .iter()
        .map(|seed| {
            let track = track_of(&state, seed);
            let stems_ready = track.is_some_and(|id| state.stems.cached_paths(id).is_some());
            let hint = (!stems_ready).then(|| {
                if track.is_some() {
                    stem_hint(&state)
                } else {
                    SOURCE_GONE.to_string()
                }
            });
            ClipSourceInfo {
                source: ClipSourceRef::Seed {
                    id: seed.id.clone(),
                    stems: Vec::new(),
                },
                seed_id: seed.id.clone(),
                label: seed.name.clone(),
                beats: resolver
                    .records
                    .get(&seed.id)
                    .map(|r| r.grid.beats)
                    .unwrap_or(0),
                source_bpm: seed.source_bpm,
                speed: seed.speed,
                available: resolver.records.contains_key(&seed.id),
                hint: None,
                stems: dj_analysis::STEM_NAMES
                    .iter()
                    .map(|name| ClipStemInfo {
                        name: (*name).into(),
                        available: stems_ready,
                        hint: hint.clone(),
                    })
                    .collect(),
            }
        })
        .collect();
    Ok(ClipSources {
        sources,
        clips: resolver.clips.clone(),
        grid: GridInfo::from(&grid),
    })
}

/// Open a source in the timeline: its length and its waveform.
#[tauri::command(async)]
pub fn beatify_clip_open(
    state: State<AppState>,
    project_id: String,
    source: ClipSourceRef,
    buckets: usize,
) -> CmdResult<ClipSourceAudio> {
    let mut resolver = Resolver::new(&state, &project_id)?;
    let label = resolver.label(&source);
    let audio = resolver.audio(&source, 0)?;
    let grid = resolver.grid();
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
    project_id: String,
    source: ClipSourceRef,
    start_secs: f64,
    secs: f64,
) -> CmdResult<tauri::ipc::Response> {
    let mut resolver = Resolver::new(&state, &project_id)?;
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
    project_id: String,
    draft: ClipDraft,
    start_secs: f64,
    secs: f64,
) -> CmdResult<tauri::ipc::Response> {
    let mut resolver = Resolver::new(&state, &project_id)?;
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
    project_id: String,
    clip: SavedClip,
) -> CmdResult<ClipSaved> {
    let mut clips = read_clips(&state, &project_id)?;
    let mut clip = clip;
    if clip.id.is_empty() {
        clip.id = next_id(&clips);
    }
    let id = clip.id.clone();
    match clips.iter_mut().find(|c| c.id == clip.id) {
        Some(existing) => *existing = clip,
        None => clips.push(clip),
    }
    write_clips(&state, &project_id, &clips)?;
    Ok(ClipSaved { id, clips })
}

#[tauri::command(async)]
pub fn beatify_clip_delete(
    state: State<AppState>,
    project_id: String,
    id: String,
) -> CmdResult<Vec<SavedClip>> {
    let mut clips = read_clips(&state, &project_id)?;
    clips.retain(|c| c.id != id);
    write_clips(&state, &project_id, &clips)?;
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
