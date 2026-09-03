//! The Grid page's ENGINE SESSION: the clock and the row modules that
//! play the open arrangement.
//!
//! The Grid page used to schedule its clips in the webview through Web
//! Audio. It does not any more: an arrangement is played by the engine,
//! like everything else that makes a sound. What the page sends is the
//! document it already owns, and this module keeps a small graph in step
//! with it —
//!
//! ```text
//!   builtin.clock ─clock/reset─> builtin.grid_track (one per row) ─> builtin.audio_out
//! ```
//!
//! — creating rows that appeared, removing rows that went, loading a
//! row's clip when it changed, and pushing each row's program (its
//! placements, its level line and the play range). Everything is in
//! ABSOLUTE grid beats, so the page's playhead is the clock's position
//! and nothing has to be rotated into the range.
//!
//! THE SESSION IS NOT PATCH STATE. Its nodes live in the Grid workspace
//! ([`Workspace::Grid`]), which no patch saves and no patch restores: an
//! arrangement is a document of its own (`grids/<name>.json`,
//! [`crate::beat_clip::grid_save`]) and the page re-syncs it on open. The
//! edits here are therefore NOT undoable and do not dirty the patch —
//! they are the engine catching up with a document, not a user editing a
//! rack.

use dj_engine::clock::{ClockProgram, TempoPoint};
use dj_engine::grid_track::{GridTrackProgram, LevelPoint};
use dj_engine::{Engine, Workspace};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{engine_lock, err, AppState, CmdResult};

/// The session's node ids. Fixed rather than generated: there is one
/// Grid page, and a fixed id makes a re-sync idempotent.
const CLOCK: &str = "gridclock";
const OUT: &str = "gridout";
const ROW_PREFIX: &str = "gridrow";

const CLOCK_ID: &str = dj_engine::clock::CLOCK_ID;
const GRID_TRACK_ID: &str = dj_engine::grid_track::GRID_TRACK_ID;

/// One row of the document, as the page sends it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridSyncRow {
    /// The document's row id (stable across re-orders).
    pub id: String,
    pub clip_id: String,
    /// The clip's revision ([`dj_analysis::clip::beat_clip_rev`]): a clip
    /// EDITED keeps its id, so this is what tells the session that the
    /// audio a row holds is last time's.
    #[serde(default)]
    pub rev: String,
    /// Where copies of the clip are laid, as grid columns.
    #[serde(default)]
    pub placements: Vec<f64>,
    /// The clip's length in beats (trailing silence included) — the
    /// document's view of it, which is what the page draws.
    pub clip_beats: f64,
    #[serde(default)]
    pub levels: Vec<GridSyncLevel>,
    /// The row rack's chrome: the baseline the level line is read
    /// against, where the row sits, and how much of its rack is heard.
    pub level: f32,
    pub pan: f32,
    pub wet: f32,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct GridSyncLevel {
    pub beat: f64,
    pub level: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct GridSyncTempoPoint {
    pub beat: f64,
    pub bpm: f64,
}

/// The whole arrangement, as much of it as the engine needs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridSyncDoc {
    #[serde(default)]
    pub rows: Vec<GridSyncRow>,
    /// The master tempo's base value.
    pub bpm: f64,
    #[serde(default)]
    pub tempo_points: Vec<GridSyncTempoPoint>,
    /// The columns playback is confined to (the loop, or the whole grid).
    pub range_start: f64,
    pub range_end: f64,
}

/// Where the transport is, for the page's playhead.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridStatus {
    /// Fractional grid column, as of the engine's last block.
    pub beat: f64,
    pub playing: bool,
    /// The tempo the clock is running at right now.
    pub bpm: f64,
}

fn row_instance(row_id: &str) -> String {
    let tail: String = row_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("{ROW_PREFIX}_{tail}")
}

/// Add `instance` if it is not there, tagged into the Grid workspace.
fn ensure_node(engine: &mut Engine, instance: &str, ext_id: &str) -> CmdResult<bool> {
    if engine.nodes.iter().any(|n| n.instance_id == instance) {
        return Ok(false);
    }
    engine.add_module(instance, ext_id).map_err(err)?;
    engine
        .set_module_workspace(instance, Workspace::Grid)
        .map_err(err)?;
    Ok(true)
}

/// The clip a row is holding, as the session records it: id and revision
/// together, so a re-cut clip counts as different audio.
fn clip_key(row: &GridSyncRow) -> String {
    format!("{}@{}", row.clip_id, row.rev)
}

/// Bring the engine's Grid session in line with the document. Idempotent
/// — the page calls it after every edit — and cheap when nothing
/// structural changed: only a row whose CLIP changed pays for a decode.
///
/// `async` because that decode reads and stretches seconds of audio; a
/// sync command would run it on the main thread.
#[tauri::command(async)]
pub fn grid_sync(state: State<AppState>, doc: GridSyncDoc) -> CmdResult<()> {
    // Decode outside the engine lock, and only what changed.
    let wanted: Vec<(String, String)> = {
        let engine = engine_lock(&state)?;
        doc.rows
            .iter()
            .filter(|row| !row.clip_id.is_empty())
            .filter(|row| {
                let instance = row_instance(&row.id);
                engine
                    .grid_track_clip(&instance)
                    .ok()
                    .flatten()
                    .map(|held| held != clip_key(row))
                    .unwrap_or(true)
            })
            .map(|row| (row.id.clone(), row.clip_id.clone()))
            .collect()
    };
    let mut loaded = Vec::new();
    for (row_id, clip_id) in wanted {
        match crate::beat_clip::render_clip(&state, &clip_id) {
            Ok(rendered) => loaded.push((row_id, rendered)),
            // A row pointing at a clip that has been deleted keeps its
            // place in the document and simply makes no sound.
            Err(e) => eprintln!("[dj-audio] grid: clip {clip_id} unavailable: {}", e.message),
        }
    }

    let mut engine = engine_lock(&state)?;
    ensure_node(&mut engine, CLOCK, CLOCK_ID)?;
    ensure_node(&mut engine, OUT, dj_engine::builtin::AUDIO_OUT_ID)?;

    for row in &doc.rows {
        let instance = row_instance(&row.id);
        if ensure_node(&mut engine, &instance, GRID_TRACK_ID)? {
            for (from, to) in [("clock", "clock"), ("reset", "reset")] {
                engine.connect(CLOCK, from, &instance, to).map_err(err)?;
            }
            for (jack, channel) in [("audio_l", "l"), ("audio_r", "r")] {
                engine.connect(&instance, jack, OUT, channel).map_err(err)?;
            }
        }
    }
    // Rows the document no longer has go, wires and all.
    let stale: Vec<String> = engine
        .nodes
        .iter()
        .filter(|n| n.ext_id == GRID_TRACK_ID && n.workspace == Workspace::Grid)
        .map(|n| n.instance_id.clone())
        .filter(|id| !doc.rows.iter().any(|row| row_instance(&row.id) == *id))
        .collect();
    for id in stale {
        engine.remove_module(&id).map_err(err)?;
    }

    for (row_id, rendered) in loaded {
        let instance = row_instance(&row_id);
        let key = doc
            .rows
            .iter()
            .find(|r| r.id == row_id)
            .map(clip_key)
            .unwrap_or_default();
        engine
            .grid_track_load(&instance, Some(key), rendered.clip_audio(), rendered.bpm)
            .map_err(err)?;
    }

    let program = |row: &GridSyncRow| GridTrackProgram {
        copies: {
            let mut copies = row.placements.clone();
            copies.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            copies
        },
        levels: row
            .levels
            .iter()
            .map(|p| LevelPoint {
                beat: p.beat,
                level: p.level,
            })
            .collect(),
        clip_beats: row.clip_beats,
        loop_start: doc.range_start,
        loop_end: doc.range_end,
        start_beat: doc.range_start,
        start_bpm: 0.0,
    };
    for row in &doc.rows {
        let instance = row_instance(&row.id);
        engine
            .grid_track_set_program(&instance, program(row))
            .map_err(err)?;
        for (jack, value) in [("level", row.level), ("pan", row.pan), ("wet", row.wet)] {
            engine.set_knob_value(&instance, jack, value).map_err(err)?;
        }
    }

    let clock = clock_program(&doc, doc.range_start);
    engine.clock_set_program(CLOCK, clock).map_err(err)?;
    engine
        .set_knob_value(CLOCK, "bpm", doc.bpm as f32)
        .map_err(err)?;
    Ok(())
}

fn clock_program(doc: &GridSyncDoc, start_beat: f64) -> ClockProgram {
    ClockProgram {
        points: doc
            .tempo_points
            .iter()
            .map(|p| TempoPoint {
                beat: p.beat,
                bpm: p.bpm,
            })
            .collect(),
        start_beat,
        loop_start: doc.range_start,
        loop_end: doc.range_end,
        looping: true,
    }
}

/// Play from `from` (a grid column), or hold where the transport is.
///
/// A start re-parks the whole session: the clock's start beat and every
/// row's are written first, then the transport is restarted, and the
/// clock's own reset pulse is what re-arms the rows — one moment, on the
/// audio clock, for the clock and every row it feeds.
#[tauri::command(async)]
pub fn grid_transport(
    state: State<AppState>,
    playing: bool,
    from: Option<f64>,
    doc: Option<GridSyncDoc>,
) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    if engine.nodes.iter().all(|n| n.instance_id != CLOCK) {
        // Nothing has been synced yet: there is no session to run.
        return Ok(());
    }
    if let (Some(doc), Some(from)) = (&doc, from) {
        let mut clock = clock_program(doc, from);
        // The tempo the cue sits at, so every row comes in ON the first
        // beat instead of sitting one out to measure what the app
        // already knows (`GridTrackProgram::start_bpm`).
        let start_bpm = clock.bpm_at(from, doc.bpm);
        clock.start_beat = from;
        engine.clock_set_program(CLOCK, clock).map_err(err)?;
        let rows: Vec<String> = doc.rows.iter().map(|r| row_instance(&r.id)).collect();
        for instance in rows {
            let Ok(mut program) = engine.grid_track_program(&instance) else {
                continue;
            };
            program.start_beat = from;
            program.start_bpm = start_bpm;
            engine
                .grid_track_set_program(&instance, program)
                .map_err(err)?;
        }
    }
    engine
        .clock_transport(CLOCK, playing, from.is_some())
        .map_err(err)
}

/// Where the Grid transport is. Polled by the page for its playhead, so
/// it must be cheap: three atomics off the clock module.
#[tauri::command]
pub fn grid_status(state: State<AppState>) -> CmdResult<GridStatus> {
    let engine = engine_lock(&state)?;
    let Ok(status) = engine.clock_status(CLOCK) else {
        return Ok(GridStatus {
            beat: 0.0,
            playing: false,
            bpm: 0.0,
        });
    };
    Ok(GridStatus {
        beat: status.beat,
        playing: status.running,
        bpm: status.bpm,
    })
}

/// Tear the session down (the page closed, or a new arrangement was
/// opened). Leaving it up would keep clips loaded and a clock ticking
/// for a page nobody is looking at.
#[tauri::command(async)]
pub fn grid_teardown(state: State<AppState>) -> CmdResult<()> {
    let mut engine = engine_lock(&state)?;
    let nodes: Vec<String> = engine
        .nodes
        .iter()
        .filter(|n| n.workspace == Workspace::Grid)
        .map(|n| n.instance_id.clone())
        .collect();
    for id in nodes {
        engine.remove_module(&id).map_err(err)?;
    }
    Ok(())
}
