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
    self, audition, detect, grid, store, Agreement, Analysis, Grid, Quality, Reading, Ruler,
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

/// A beatified track as the track view needs it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatifyTrack {
    pub track_id: i64,
    pub title: String,
    pub artist: String,
    pub record: beatify::BeatifyRecord,
    pub duration_secs: f64,
    pub sample_rate: u32,
    pub channels: usize,
    pub peaks: Vec<f32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub strength: f64,
    pub lead_in: f64,
    pub ruler_group: u32,
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
        reading: a.reading,
        agreement: a.agreement.clone(),
        beats: a.beats.clone(),
        confidence: a.confidence.clone(),
        drift: a.drift_spans(),
        sweep: a.sweep.clone(),
        strength,
        quality: a.quality_at(strength),
        residuals: a.residuals_at(strength),
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
/// layered and looped.
#[tauri::command(async)]
pub fn beatify_sync_check(
    state: State<AppState>,
    strength: f64,
) -> CmdResult<tauri::ipc::Response> {
    state.beatify.with(|session| {
        let layered = audition::sync_check(&session.audio, &session.analysis, strength);
        wav(&layered)
    })
}

/// Commit (MOD-29/MOD-A24): render the warp once, write the two artifacts
/// under `<data_dir>/beatify/<hash>/` plus the sidecar, and hand the track
/// view its record.
#[tauri::command(async)]
pub fn beatify_save(
    state: State<AppState>,
    request: SaveRequest,
    buckets: usize,
) -> CmdResult<BeatifyTrack> {
    let track_id = state.beatify.with(|s| Ok(s.track_id))?;
    let track = state.library.track(track_id).map_err(err)?;
    state.beatify.with(|session| {
        let (warped, map) = beatify::render(&session.audio, &session.analysis, request.strength);
        let warped_name = warped_name(&session.source_path);
        let record = beatify::record(
            &session.analysis,
            &beatify::Commit {
                source: &session.source_path,
                source_hash: &session.source_hash,
                warped_name: &warped_name,
                strength: request.strength,
                lead_in: request.lead_in.clamp(0.0, grid::LEAD_IN_MAX),
                ruler: Ruler {
                    group: request.ruler_group.max(1),
                },
            },
            &map,
        );
        store::save(
            state.library.data_dir(),
            &session.source_hash,
            &record,
            &warped,
        )
        .map_err(err)?;
        Ok(BeatifyTrack {
            track_id,
            title: track.title.clone(),
            artist: track.artist.clone(),
            duration_secs: warped.duration_secs(),
            sample_rate: warped.sample_rate,
            channels: warped.channels.len(),
            peaks: dj_analysis::clip::peaks(&warped, buckets.min(MAX_BUCKETS)),
            record,
        })
    })
}

/// `boys.wav` → `boys.beatified.wav` (§3.11), display only: the file on
/// disk is always `warped.wav` inside the hash-keyed record directory.
fn warped_name(source: &std::path::Path) -> String {
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("track");
    format!("{stem}.beatified.wav")
}

/// The saved record for a track, if it has one (MOD-A31: a beatified track
/// skips the modal and goes straight to the track view).
#[tauri::command(async)]
pub fn beatify_load(
    state: State<AppState>,
    track_id: i64,
    buckets: usize,
) -> CmdResult<Option<BeatifyTrack>> {
    let track = state.library.track(track_id).map_err(err)?;
    let Some(record) = store::load(state.library.data_dir(), &track.content_hash).map_err(err)?
    else {
        return Ok(None);
    };
    let path = store::warped_path(state.library.data_dir(), &track.content_hash);
    let warped = dj_analysis::decode_audio(&path)
        .map_err(|e| err(format!("reading the beatified render: {e}")))?;
    Ok(Some(BeatifyTrack {
        track_id,
        title: track.title,
        artist: track.artist,
        duration_secs: warped.duration_secs(),
        sample_rate: warped.sample_rate,
        channels: warped.channels.len(),
        peaks: dj_analysis::clip::peaks(&warped, buckets.min(MAX_BUCKETS)),
        record,
    }))
}

/// A window of a saved beatified track, for the track view's transport.
#[tauri::command(async)]
pub fn beatify_track_audio(
    state: State<AppState>,
    track_id: i64,
    start_secs: f64,
    secs: f64,
) -> CmdResult<tauri::ipc::Response> {
    let track = state.library.track(track_id).map_err(err)?;
    let path = store::warped_path(state.library.data_dir(), &track.content_hash);
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
