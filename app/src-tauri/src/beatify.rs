//! Beatify tab IPC (PRD "Beatify"): analyze a library track, inspect the
//! grid in the import modal, and commit a constant-tempo render.
//!
//! Like the Clip page this is a pure control-plane feature — it never
//! touches the engine or the RT thread, and every command is `async` so
//! the (multi-second) detection and warp render run on Tauri's worker pool
//! instead of the UI thread.
//!
//! The modal is EPHEMERAL (MOD-3.10): the analysis lives in
//! [`BeatifySession`] until Save writes the two artifacts, and dismissing
//! the modal leaves nothing behind. Reading corrections and the warp
//! slider re-query the session; neither re-runs the tracker (MOD-26) and
//! neither renders audio (MOD-A22).
//!
//! Serialization here is camelCase throughout, because the §5 payload the
//! tab emits is specified that way and one convention per feature beats
//! two.

use dj_analysis::beatify::{
    self, audition, detect, grid, scope, store, Agreement, Analysis, Grid, Quality, Reading, Ruler,
    Sweep, WarpMap,
};
use dj_analysis::AudioData;
use dj_library::Track;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

use crate::{err, AppState, CmdError, CmdResult};

/// Waveform overview resolution cap (same law as the Clip page).
const MAX_BUCKETS: usize = 20_000;
/// Audition window cap: preview bytes cross the IPC boundary in one piece.
const MAX_PREVIEW_SECS: f64 = 120.0;

/// The modal's in-flight analysis. One at a time: the tab shows one track.
#[derive(Default)]
pub struct BeatifySession(Mutex<Option<Session>>);

struct Session {
    track_id: i64,
    source_path: PathBuf,
    source_hash: String,
    audio: Arc<AudioData>,
    analysis: Analysis,
}

impl BeatifySession {
    fn with<T>(&self, f: impl FnOnce(&mut Session) -> CmdResult<T>) -> CmdResult<T> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| CmdError::invalid("beatify: session lock poisoned"))?;
        match guard.as_mut() {
            Some(session) => f(session),
            None => Err(CmdError::invalid(
                "beatify: nothing analyzed yet — open a track first",
            )),
        }
    }

    fn set(&self, session: Session) -> CmdResult<()> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| CmdError::invalid("beatify: session lock poisoned"))?;
        *guard = Some(session);
        Ok(())
    }

    /// MOD-A25: cancel discards everything, because nothing was created.
    fn clear(&self) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = None;
        }
    }
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatifySource {
    pub track_id: i64,
    pub title: String,
    pub artist: String,
    pub duration_secs: f64,
    pub sample_rate: u32,
    pub channels: usize,
    pub peaks: Vec<f32>,
}

/// Everything phase 1 and phase 2 draw, in one payload.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatifyAnalysis {
    pub source: BeatifySource,
    pub tracker: String,
    /// Analyzed span in source seconds — and therefore the import (MOD-A8).
    pub region: [f64; 2],
    pub grid: Grid,
    /// The same beats in SOURCE seconds, spanning the whole file: what the
    /// modal draws over the source waveform and snaps its region to.
    /// `grid` is the OUTPUT timebase and says nothing about the file.
    pub source_grid: Grid,
    pub reading: Reading,
    pub agreement: Agreement,
    /// Detections in source seconds (amber: what was played).
    pub beats: Vec<f64>,
    pub confidence: Vec<f32>,
    pub drift: Vec<grid::DriftSpan>,
    pub sweep: Sweep,
    /// Slider position the sweep recommends.
    pub strength: f64,
    pub quality: Quality,
    /// Per-beat residuals at `strength`, seconds (the error strip).
    pub residuals: Vec<f64>,
    /// `source_grid` beat each residual belongs to — the strip is drawn
    /// over the beat it is about, and dropped detections leave gaps.
    pub residual_beats: Vec<f64>,
    pub anchors: Vec<f64>,
    pub lead_in: f64,
    /// MOD-23 auto-flag: the interval histogram is bimodal at 2:1.
    pub metrical_flag: bool,
    pub output_secs: f64,
}

/// What the warp slider asks for on every move (MOD-A22): arithmetic only.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatifyMeters {
    pub strength: f64,
    /// Anchor spacing in beats; 0 is the no-warp position.
    pub anchor_stride: usize,
    pub quality: Quality,
    pub residuals: Vec<f64>,
    pub anchors: Vec<f64>,
}

/// The cut point inspector (§3.5). Traces are peak-reduced source
/// samples, not a render: the slider can ask for these as often as it
/// likes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatifyScope {
    pub pre_secs: f64,
    pub post_secs: f64,
    pub traces: Vec<BeatifyTrace>,
    /// Median distance the attacks begin BEFORE the grid line, seconds.
    pub attack_lead: f64,
    /// Horizontal smear across the traces, seconds.
    pub spread: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatifyTrace {
    pub beat: usize,
    pub samples: Vec<f32>,
    /// Attack position relative to the line, or null where nothing rises.
    pub attack: Option<f64>,
}

/// One seed of a project, as the track view needs it.
///
/// Structurally this is what a "beatified track" always was, plus the
/// three things that only make sense once a project can hold more than
/// one: which seed it is, the tempo it was played at, and the ratio it
/// now runs at.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatifySeed {
    /// Seed id within the project (`s1`), NOT a library id.
    pub id: String,
    /// The project it belongs to. Every clip command is keyed by that.
    pub project_id: String,
    pub project_name: String,
    pub track_id: i64,
    pub title: String,
    pub artist: String,
    pub record: beatify::BeatifyRecord,
    pub duration_secs: f64,
    pub sample_rate: u32,
    pub channels: usize,
    pub peaks: Vec<f32>,
    /// Tempo of the performance, before it was conformed.
    pub source_bpm: f64,
    /// Playback ratio that put it on the project's grid (1.0 = none).
    pub speed: f64,
    /// The source track is no longer in the library: the render is the
    /// project's own, but stems, re-beatify and re-tempo need the file.
    pub source_missing: bool,
}

/// An open project: the tempo, and everything beatified onto it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatifyProject {
    pub id: String,
    pub name: String,
    /// `None` until the first seed sets it.
    pub bpm: Option<f64>,
    pub seeds: Vec<BeatifySeed>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub strength: f64,
    pub lead_in: f64,
    pub ruler_group: u32,
    /// The project to import into. Empty mints one, which is how a
    /// project can still be started straight from a track.
    #[serde(default)]
    pub project_id: String,
    /// The seed being REPLACED (re-beatify). Empty adds a new one.
    #[serde(default)]
    pub seed_id: String,
    /// What to call a newly minted project. Ignored for an existing one,
    /// which keeps the name it already has (rename is its own command).
    #[serde(default)]
    pub name: String,
}

/// A project as the tab's shelf shows it: the envelope plus enough to
/// tell two of them apart at a glance.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    /// `None` for a project with nothing in it yet.
    pub bpm: Option<f64>,
    /// Seed names in import order — what the shelf lists under the name.
    pub seeds: Vec<String>,
    pub updated: u64,
    /// At least one seed's source track is missing from the library.
    pub source_missing: bool,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn describe(track: &Track, audio: &AudioData, buckets: usize) -> BeatifySource {
    BeatifySource {
        track_id: track.id,
        title: track.title.clone(),
        artist: track.artist.clone(),
        duration_secs: audio.duration_secs(),
        sample_rate: audio.sample_rate,
        channels: audio.channels.len(),
        peaks: dj_analysis::clip::peaks(audio, buckets.min(MAX_BUCKETS)),
    }
}

fn summarize(session: &Session, buckets: usize, track: &Track) -> BeatifyAnalysis {
    let a = &session.analysis;
    let strength = a.sweep.default_strength;
    BeatifyAnalysis {
        source: describe(track, &session.audio, buckets),
        tracker: a.tracker.clone(),
        region: a.region,
        grid: a.grid,
        source_grid: a.source_grid(session.audio.duration_secs()),
        reading: a.reading,
        agreement: a.agreement.clone(),
        beats: a.beats.clone(),
        confidence: a.confidence.clone(),
        drift: a.drift_spans(),
        sweep: a.sweep.clone(),
        strength,
        quality: a.quality_at(strength),
        residuals: a.residuals_at(strength),
        residual_beats: a.residual_beats(),
        anchors: a.anchors_at(strength).iter().map(|x| x.dst).collect(),
        lead_in: a.lead_in,
        metrical_flag: a.metrical_flag,
        output_secs: a.output_secs(),
    }
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
// Commands
// ---------------------------------------------------------------------------

/// Which beat tracker the tab will use, and how to install the good one.
///
/// `beat_this` is an optional runtime dependency (PyTorch): when it is not
/// importable the tab stays fully usable on the built-in DSP tracker and
/// shows the install hint, exactly like the YouTube provider without
/// `yt-dlp`.
#[tauri::command(async)]
pub fn beatify_tracker_status() -> detect::TrackerStatus {
    detect::tracker_status()
}

/// Detect beats and fit a grid. `region` is the import span (MOD-A8);
/// `None` is the whole file, which is what the modal runs on open
/// (MOD-A1/MOD-A11).
#[tauri::command(async)]
pub fn beatify_analyze(
    state: State<AppState>,
    track_id: i64,
    region: Option<[f64; 2]>,
    buckets: usize,
) -> CmdResult<BeatifyAnalysis> {
    let track = state.library.track(track_id).map_err(err)?;
    let path = PathBuf::from(&track.file_path);
    let audio = Arc::new(
        dj_analysis::decode_audio(&path).map_err(|e| err(format!("decoding {}: {e}", track.title)))?,
    );
    let tracker = detect::default_tracker();
    let analysis = beatify::analyze(
        &audio,
        tracker.as_ref(),
        region.map(|r| (r[0], r[1])),
        Reading::default(),
    )
    .map_err(|e| CmdError::invalid(e.to_string()))?;
    let session = Session {
        track_id,
        source_path: path,
        source_hash: track.content_hash.clone(),
        audio,
        analysis,
    };
    let summary = summarize(&session, buckets, &track);
    state.beatify.set(session)?;
    Ok(summary)
}

/// Re-read the current detections at another metrical level or phase
/// (MOD-23/MOD-24). Never re-runs the tracker.
#[tauri::command(async)]
pub fn beatify_set_reading(
    state: State<AppState>,
    reading: Reading,
    buckets: usize,
) -> CmdResult<BeatifyAnalysis> {
    let track_id = state.beatify.with(|s| Ok(s.track_id))?;
    let track = state.library.track(track_id).map_err(err)?;
    state.beatify.with(|session| {
        session.analysis = session
            .analysis
            .with_reading(reading)
            .map_err(|e| CmdError::invalid(e.to_string()))?;
        Ok(summarize(session, buckets, &track))
    })
}

/// Meters for a slider position (MOD-13): anchor arithmetic, no audio.
#[tauri::command(async)]
pub fn beatify_meters(state: State<AppState>, strength: f64) -> CmdResult<BeatifyMeters> {
    state.beatify.with(|session| {
        let a = &session.analysis;
        Ok(BeatifyMeters {
            strength,
            anchor_stride: grid::anchor_stride(strength).unwrap_or(0),
            quality: a.quality_at(strength),
            residuals: a.residuals_at(strength),
            anchors: a.anchors_at(strength).iter().map(|x| x.dst).collect(),
        })
    })
}

/// Audition a window (MOD-A20/A21/A23). `warped = false` plays the source
/// (phase 1), `true` renders just those beats through the warp (phase 2).
/// `click` mixes the metronome on top (MOD-27).
#[tauri::command(async)]
pub fn beatify_preview(
    state: State<AppState>,
    start_secs: f64,
    secs: f64,
    warped: bool,
    strength: f64,
    click: bool,
) -> CmdResult<tauri::ipc::Response> {
    let secs = secs.min(MAX_PREVIEW_SECS);
    state.beatify.with(|session| {
        let a = &session.analysis;
        let mut window = if warped {
            beatify::render_window(&session.audio, a, strength, start_secs, secs)
        } else {
            dj_analysis::clip::slice(&session.audio, start_secs, secs)
        };
        if click {
            let times: Vec<f64> = if warped {
                a.output_grid_times()
            } else {
                // Phase 1 ticks the DETECTIONS: over unwarped audio that is
                // what tells the user whether the metrical level and phase
                // are right, which a straight grid on a drifting song
                // cannot.
                a.beats.clone()
            };
            let local: Vec<f64> = times
                .iter()
                .map(|t| t - start_secs)
                .filter(|t| *t >= 0.0 && *t < secs)
                .collect();
            audition::mix_click(&mut window, &local, 0.5);
        }
        wav(&window)
    })
}

/// The sync check (MOD-28): four beats from each end of the track,
/// layered and looped. Cut at the lead-in, because that is where the
/// user can hear whether the lead-in is doing its job (§3.7).
#[tauri::command(async)]
pub fn beatify_sync_check(
    state: State<AppState>,
    strength: f64,
    lead_in: f64,
) -> CmdResult<tauri::ipc::Response> {
    state.beatify.with(|session| {
        let layered = audition::sync_check(
            &session.audio,
            &session.analysis,
            strength,
            lead_in.clamp(0.0, grid::LEAD_IN_MAX),
        );
        wav(&layered)
    })
}

/// The cut point inspector (§3.5): a dozen beats sampled across the
/// track, drawn on top of each other around the grid line. No render —
/// these are source samples where the warp maps each line back to
/// (MOD-A22), so the strength slider can refresh it freely.
#[tauri::command(async)]
pub fn beatify_scope(
    state: State<AppState>,
    strength: f64,
    points: usize,
    pre_secs: f64,
) -> CmdResult<BeatifyScope> {
    state.beatify.with(|session| {
        let s = scope::scope(&session.audio, &session.analysis, strength, points, pre_secs);
        Ok(BeatifyScope {
            pre_secs: s.pre_secs,
            post_secs: s.post_secs,
            attack_lead: s.attack_lead,
            spread: s.spread,
            traces: s
                .traces
                .into_iter()
                .map(|t| BeatifyTrace {
                    beat: t.beat,
                    samples: t.samples,
                    attack: t.attack,
                })
                .collect(),
        })
    })
}

/// Commit (MOD-29/MOD-A24): render the warp once, write the seed's
/// artifacts under `<data_dir>/beatify/<project>/seeds/<seed>/` plus the
/// sidecar, and hand the builder the project it now belongs to.
///
/// THE FIRST SEED SETS THE TEMPO. A project with no BPM takes the one
/// this analysis fitted; a project that already has one conforms the
/// seed to it ([`beatify::render_at`]) so everything on the page shares a
/// grid — which is the only reason beats from two different records can
/// be laid side by side. Conforming costs no extra pass over the audio:
/// it is a scale of the warp map the render was going to use anyway.
///
/// An empty `project_id` MINTS a project; a `seed_id` REPLACES that seed
/// (re-beatify), keeping its clips — which is why the builder warns that
/// they may no longer line up.
#[tauri::command(async)]
pub fn beatify_save(
    state: State<AppState>,
    request: SaveRequest,
    buckets: usize,
) -> CmdResult<BeatifyProject> {
    let track_id = state.beatify.with(|s| Ok(s.track_id))?;
    let track = state.library.track(track_id).map_err(err)?;
    let data_dir = state.library.data_dir().to_path_buf();
    let existing = store::list(&data_dir).map_err(err)?;
    let mut project = match request.project_id.as_str() {
        "" => None,
        id => store::project(&data_dir, id).map_err(err)?,
    }
    .unwrap_or_else(|| {
        store::Project::new(
            store::new_id(&existing),
            project_name(&request.name, &track),
        )
    });

    state.beatify.with(|session| {
        let analysis = &session.analysis;
        let period = project.period().unwrap_or(analysis.grid.period);
        let (warped, map, grid) =
            beatify::render_at(&session.audio, analysis, request.strength, period);
        let record = beatify::record(
            analysis,
            &beatify::Commit {
                source: &session.source_path,
                source_hash: &session.source_hash,
                warped_name: &warped_name(&session.source_path),
                strength: request.strength,
                lead_in: request.lead_in.clamp(0.0, grid::LEAD_IN_MAX),
                ruler: Ruler {
                    group: request.ruler_group.max(1),
                },
                grid,
            },
            &map,
        );
        // Playback ratio in the DJ sense: >1 means it runs faster than it
        // was played. The seed that set the tempo is exactly 1.
        let speed = analysis.grid.period / period;
        let seed = match project.seed(&request.seed_id) {
            // Re-beatify keeps the seed's identity and its directory, so
            // the render it replaces is the one the clips point at.
            Some(previous) => store::Seed {
                name: previous.name.clone(),
                track_id,
                source_hash: session.source_hash.clone(),
                source_bpm: analysis.grid.bpm,
                speed,
                ..previous.clone()
            },
            None => {
                let id = project.new_seed_id();
                store::Seed {
                    dir: store::seed_dir_name(&id),
                    id,
                    name: seed_name(&track),
                    track_id,
                    source_hash: session.source_hash.clone(),
                    source_bpm: analysis.grid.bpm,
                    speed,
                }
            }
        };
        match project.seeds.iter_mut().find(|s| s.id == seed.id) {
            Some(slot) => *slot = seed.clone(),
            None => project.seeds.push(seed.clone()),
        }
        project.bpm = Some(grid.bpm);
        project.updated = store::now_secs();
        store::save_seed(&data_dir, &project, &seed, &record, &warped).map_err(err)?;
        Ok(())
    })?;

    open(&state, &project, buckets)
}

/// Start a project with nothing in it (§3.11): a name and a tempo it has
/// not been told yet. Seeds are imported into it afterwards, which is
/// what makes a project a place rather than one take on one track.
#[tauri::command(async)]
pub fn beatify_project_new(state: State<AppState>, name: String) -> CmdResult<BeatifyProject> {
    let data_dir = state.library.data_dir();
    let existing = store::list(data_dir).map_err(err)?;
    let name = match name.trim() {
        "" => format!("project {}", existing.len() + 1),
        given => given.to_string(),
    };
    let project = store::Project::new(store::new_id(&existing), name);
    store::save_project(data_dir, &project).map_err(err)?;
    open(&state, &project, 0)
}

/// Re-tempo the whole project (the BPM box): every seed is re-rendered
/// onto the new grid.
///
/// Clips survive untouched, and that is not luck — a placement is a run
/// of BEATS, so it means the same thing at any tempo. What has to be
/// rebuilt is audio: each seed's stored map is scaled to the new period
/// and re-rendered from the ORIGINAL file where it is still in the
/// library (one stretch, no generation loss), or by stretching its
/// existing render where it is not.
#[tauri::command(async)]
pub fn beatify_project_set_bpm(
    state: State<AppState>,
    project_id: String,
    bpm: f64,
    buckets: usize,
) -> CmdResult<BeatifyProject> {
    if !bpm.is_finite() || !(MIN_BPM..=MAX_BPM).contains(&bpm) {
        return Err(CmdError::invalid(format!(
            "beatify: {bpm} BPM is outside {MIN_BPM}–{MAX_BPM}"
        )));
    }
    let data_dir = state.library.data_dir().to_path_buf();
    let mut project = store::project(&data_dir, &project_id)
        .map_err(err)?
        .ok_or_else(|| CmdError::invalid(format!("beatify: no project {project_id}")))?;
    let period = 60.0 / bpm;

    for seed in &mut project.seeds {
        let Some(record) = store::load_seed(&data_dir, &project_id, seed).map_err(err)? else {
            continue;
        };
        seed.speed = if seed.source_bpm > 0.0 {
            bpm / seed.source_bpm
        } else {
            1.0
        };
        let k = period / record.grid.period;
        if (k - 1.0).abs() < 1e-9 {
            continue;
        }
        let grid = Grid {
            bpm,
            period,
            phase: period,
            beats: record.grid.beats,
        };
        let out_secs = (grid.beats as f64 + 1.0) * grid.period;
        let stored = WarpMap {
            points: record.warp.map.iter().map(|p| (p[0], p[1])).collect(),
        };
        let map = beatify::conform(&stored, k);
        let warped = match source_audio(&state, seed, &record) {
            Some(source) => beatify::warp::render(&source, &map, out_secs),
            None => stretch(
                &dj_analysis::decode_audio(&store::seed_warped_path(&data_dir, &project_id, seed))
                    .map_err(|e| err(format!("reading the beatified render: {e}")))?,
                k,
                out_secs,
            ),
        };
        let record = beatify::BeatifyRecord {
            grid,
            warp: beatify::WarpSpec {
                map: map.pairs(),
                ..record.warp.clone()
            },
            ..record
        };
        store::save_seed_render(&data_dir, &project_id, seed, &record, &warped).map_err(err)?;
    }

    project.bpm = Some(bpm);
    project.updated = store::now_secs();
    store::save_project(&data_dir, &project).map_err(err)?;
    open(&state, &project, buckets)
}

/// Drop one seed. Its clips keep their placements — what they lost is
/// audio, not arithmetic — and the project keeps its tempo, because the
/// tempo is the project's, not the seed's.
#[tauri::command(async)]
pub fn beatify_seed_delete(
    state: State<AppState>,
    project_id: String,
    seed_id: String,
    buckets: usize,
) -> CmdResult<BeatifyProject> {
    let data_dir = state.library.data_dir().to_path_buf();
    let mut project = store::project(&data_dir, &project_id)
        .map_err(err)?
        .ok_or_else(|| CmdError::invalid(format!("beatify: no project {project_id}")))?;
    let Some(seed) = project.seed(&seed_id).cloned() else {
        return open(&state, &project, buckets);
    };
    store::remove_seed(&data_dir, &project_id, &seed).map_err(err)?;
    project.seeds.retain(|s| s.id != seed_id);
    project.updated = store::now_secs();
    store::save_project(&data_dir, &project).map_err(err)?;
    open(&state, &project, buckets)
}

/// Rename a seed. Like a project's name it is a label: nothing keys off
/// it, and the clips that use the seed are unaffected.
#[tauri::command(async)]
pub fn beatify_seed_rename(
    state: State<AppState>,
    project_id: String,
    seed_id: String,
    name: String,
    buckets: usize,
) -> CmdResult<BeatifyProject> {
    let data_dir = state.library.data_dir().to_path_buf();
    let mut project = store::project(&data_dir, &project_id)
        .map_err(err)?
        .ok_or_else(|| CmdError::invalid(format!("beatify: no project {project_id}")))?;
    let name = name.trim();
    if name.is_empty() {
        return Err(CmdError::invalid("beatify: a seed needs a name"));
    }
    if let Some(seed) = project.seeds.iter_mut().find(|s| s.id == seed_id) {
        seed.name = name.to_string();
    }
    project.updated = store::now_secs();
    store::save_project(&data_dir, &project).map_err(err)?;
    open(&state, &project, buckets)
}

/// The tempo range the BPM box accepts. Wide on purpose: half-time and
/// double-time are legitimate places to put a project.
const MIN_BPM: f64 = 20.0;
const MAX_BPM: f64 = 400.0;

/// Stretch a finished render by `k` — the fallback for a seed whose
/// source has left the library. A straight line through the map, so it is
/// the same renderer doing the same job with less to work from.
fn stretch(audio: &AudioData, k: f64, out_secs: f64) -> AudioData {
    let secs = audio.duration_secs();
    let map = WarpMap {
        points: vec![(0.0, 0.0), (secs, secs * k)],
    };
    beatify::warp::render(audio, &map, out_secs)
}

/// The source audio of a seed, if the library still has the track.
fn source_audio(
    state: &AppState,
    seed: &store::Seed,
    record: &beatify::BeatifyRecord,
) -> Option<AudioData> {
    let path = seed_track(state, seed)
        .map(|t| PathBuf::from(t.file_path))
        .filter(|p| p.is_file())
        .or_else(|| Some(PathBuf::from(&record.source)).filter(|p| p.is_file()))?;
    dj_analysis::decode_audio(&path).ok()
}

/// A new project is named for its track unless the user said otherwise.
fn project_name(asked: &str, track: &Track) -> String {
    let asked = asked.trim();
    if !asked.is_empty() {
        return asked.to_string();
    }
    seed_name(track)
}

fn seed_name(track: &Track) -> String {
    if track.title.trim().is_empty() {
        format!("track {}", track.id)
    } else {
        track.title.clone()
    }
}

/// `boys.wav` → `boys.beatified.wav` (§3.11), display only: the file on
/// disk is always `warped.wav` inside the seed's directory.
fn warped_name(source: &std::path::Path) -> String {
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("track");
    format!("{stem}.beatified.wav")
}

/// Every project in the store, newest first. This is the tab's front
/// door: a project, not a track, is what gets opened.
#[tauri::command(async)]
pub fn beatify_projects(state: State<AppState>) -> CmdResult<Vec<ProjectSummary>> {
    let data_dir = state.library.data_dir();
    let mut out = Vec::new();
    for project in store::list(data_dir).map_err(err)? {
        out.push(ProjectSummary {
            id: project.id.clone(),
            name: project.name.clone(),
            bpm: project.bpm,
            seeds: project.seeds.iter().map(|s| s.name.clone()).collect(),
            source_missing: project
                .seeds
                .iter()
                .any(|s| seed_track(&state, s).is_none()),
            updated: project.updated,
        });
    }
    Ok(out)
}

/// The library row a seed came from: by hash first, because ids are
/// re-assigned when a track is re-imported and the audio is not.
fn seed_track(state: &AppState, seed: &store::Seed) -> Option<Track> {
    if let Ok(Some(found)) = state.library.track_by_hash(&seed.source_hash) {
        return Some(found);
    }
    state.library.track(seed.track_id).ok()
}

/// Open a project: its tempo and every seed's record and render.
#[tauri::command(async)]
pub fn beatify_project_open(
    state: State<AppState>,
    project_id: String,
    buckets: usize,
) -> CmdResult<Option<BeatifyProject>> {
    let Some(project) = store::project(state.library.data_dir(), &project_id).map_err(err)? else {
        return Ok(None);
    };
    open(&state, &project, buckets).map(Some)
}

/// Assemble the payload for an open project. A seed whose render has gone
/// missing is left out rather than taking the project down with it.
fn open(state: &AppState, project: &store::Project, buckets: usize) -> CmdResult<BeatifyProject> {
    let data_dir = state.library.data_dir();
    let mut seeds = Vec::new();
    for seed in &project.seeds {
        let Some(record) = store::load_seed(data_dir, &project.id, seed).map_err(err)? else {
            continue;
        };
        let path = store::seed_warped_path(data_dir, &project.id, seed);
        let Ok(warped) = dj_analysis::decode_audio(&path) else {
            continue;
        };
        let track = seed_track(state, seed);
        seeds.push(BeatifySeed {
            id: seed.id.clone(),
            project_id: project.id.clone(),
            project_name: project.name.clone(),
            track_id: track.as_ref().map(|t| t.id).unwrap_or(seed.track_id),
            title: seed.name.clone(),
            artist: track.as_ref().map(|t| t.artist.clone()).unwrap_or_default(),
            duration_secs: warped.duration_secs(),
            sample_rate: warped.sample_rate,
            channels: warped.channels.len(),
            peaks: dj_analysis::clip::peaks(&warped, buckets.min(MAX_BUCKETS)),
            source_bpm: seed.source_bpm,
            speed: seed.speed,
            source_missing: track.is_none(),
            record,
        });
    }
    Ok(BeatifyProject {
        id: project.id.clone(),
        name: project.name.clone(),
        bpm: project.bpm,
        seeds,
    })
}

/// Rename a project. The name is a label, nothing keys off it.
#[tauri::command(async)]
pub fn beatify_project_rename(
    state: State<AppState>,
    project_id: String,
    name: String,
) -> CmdResult<Vec<ProjectSummary>> {
    let data_dir = state.library.data_dir();
    let mut project = store::project(data_dir, &project_id)
        .map_err(err)?
        .ok_or_else(|| CmdError::invalid(format!("beatify: no project {project_id}")))?;
    let name = name.trim();
    if name.is_empty() {
        return Err(CmdError::invalid("beatify: a project needs a name"));
    }
    project.name = name.to_string();
    project.updated = store::now_secs();
    store::save_project(data_dir, &project).map_err(err)?;
    beatify_projects(state)
}

/// Delete a project: its tempo, its seeds, its renders, its clips.
/// The source tracks and the library are untouched.
#[tauri::command(async)]
pub fn beatify_project_delete(
    state: State<AppState>,
    project_id: String,
) -> CmdResult<Vec<ProjectSummary>> {
    store::remove(state.library.data_dir(), &project_id).map_err(err)?;
    beatify_projects(state)
}

/// A window of one seed's render, for a transport that has nothing to do
/// with the clip builder's source list.
#[tauri::command(async)]
pub fn beatify_project_audio(
    state: State<AppState>,
    project_id: String,
    seed_id: String,
    start_secs: f64,
    secs: f64,
) -> CmdResult<tauri::ipc::Response> {
    let data_dir = state.library.data_dir();
    let project = store::project(data_dir, &project_id)
        .map_err(err)?
        .ok_or_else(|| CmdError::invalid(format!("beatify: no project {project_id}")))?;
    let seed = project
        .seed(&seed_id)
        .or_else(|| project.seeds.first())
        .ok_or_else(|| CmdError::invalid("beatify: this project has no seeds yet"))?;
    let path = store::seed_warped_path(data_dir, &project_id, seed);
    let warped = dj_analysis::decode_audio(&path)
        .map_err(|e| err(format!("reading the beatified render: {e}")))?;
    wav(&dj_analysis::clip::slice(
        &warped,
        start_secs,
        secs.min(MAX_PREVIEW_SECS),
    ))
}

/// Dismiss the modal (MOD-A25): drop the session, write nothing.
#[tauri::command(async)]
pub fn beatify_cancel(state: State<AppState>) {
    state.beatify.clear();
}

/// The anchor map of the current session at a slider position — handy for
/// debugging and used by the modal's "what will Save write" readout.
#[tauri::command(async)]
pub fn beatify_warp_map(state: State<AppState>, strength: f64) -> CmdResult<Vec<[f64; 2]>> {
    state
        .beatify
        .with(|session| Ok(WarpMap::from_anchors(&session.analysis.anchors_at(strength)).pairs()))
}
