//! The Grid page's engine session: a Clock (`builtin.clock`) feeding Grid
//! Track rows (`builtin.grid_track`), which is what
//! `app/src-tauri/src/grid.rs` builds from an arrangement.
//!
//! What is pinned here is the page's behaviour rather than the modules'
//! internals (those have unit tests of their own):
//! - a synced but stopped session is silent, and playing it sounds where
//!   the clips are laid — in ABSOLUTE grid columns, so a row's copy at
//!   column 4 is heard on the fifth beat and nowhere else,
//! - a cue plays FROM that column,
//! - a pause silences the rows and not only the clock — a row interpolates
//!   between clock edges, so stopping the clock alone left it playing on,
//! - the play range wraps back to its own start, not to zero,
//! - a row edited under a running transport is heard changed without the
//!   transport moving,
//! - the Grid workspace is gated by audio focus, and nothing of the
//!   session survives into a saved patch.

use dj_engine::clock::ClockProgram;
use dj_engine::grid_track::{GridTrackProgram, GRID_TRACK_ID};
use dj_engine::playback::TrackData;
use dj_engine::{AudioFocus, Engine, EngineConfig, Workspace};
use std::sync::Arc;

const SR: f32 = 48_000.0;
const BPM: f64 = 120.0;
/// Frames in one beat at 120 BPM.
const BEAT: usize = 24_000;
const CLIP_BEATS: f64 = 2.0;

fn engine() -> Engine {
    Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap()
}

/// A clip of steady tone, two beats long at 120 BPM.
fn clip() -> Arc<TrackData> {
    let frames = BEAT * CLIP_BEATS as usize;
    Arc::new(TrackData {
        channels: vec![(0..frames)
            .map(|i| (2.0 * std::f64::consts::PI * 220.0 * i as f64 / SR as f64).sin() as f32 * 0.5)
            .collect()],
        sample_rate: SR,
    })
}

/// The session `grid_sync` builds: a clock, one row, an output.
fn session(program: GridTrackProgram) -> Engine {
    let mut e = engine();
    e.add_module("gridclock", dj_engine::clock::CLOCK_ID)
        .unwrap();
    e.add_module("gridrow_row1", GRID_TRACK_ID).unwrap();
    e.add_module("gridout", "builtin.audio_out").unwrap();
    for id in ["gridclock", "gridrow_row1", "gridout"] {
        e.set_module_workspace(id, Workspace::Grid).unwrap();
    }
    e.connect("gridclock", "clock", "gridrow_row1", "clock")
        .unwrap();
    e.connect("gridclock", "reset", "gridrow_row1", "reset")
        .unwrap();
    e.connect("gridrow_row1", "audio_l", "gridout", "l")
        .unwrap();
    e.set_knob_value("gridclock", "bpm", BPM as f32).unwrap();
    e.grid_track_load("gridrow_row1", Some("clip1".into()), clip(), BPM)
        .unwrap();
    e.grid_track_set_program("gridrow_row1", program).unwrap();
    // The page that owns the session is the page that plays it.
    e.set_audio_focus(AudioFocus::Grid).unwrap();
    e
}

fn row_program(copies: Vec<f64>, range: (f64, f64)) -> GridTrackProgram {
    GridTrackProgram {
        copies,
        clip_beats: CLIP_BEATS,
        loop_start: range.0,
        loop_end: range.1,
        start_beat: range.0,
        start_bpm: BPM,
        ..GridTrackProgram::default()
    }
}

fn clock_program(range: (f64, f64), from: f64) -> ClockProgram {
    ClockProgram {
        start_beat: from,
        loop_start: range.0,
        loop_end: range.1,
        looping: true,
        ..ClockProgram::default()
    }
}

/// Peak level of each beat of a render — one number per grid column.
fn beats(e: &mut Engine, n: usize) -> Vec<f32> {
    let out = e.render_offline(BEAT * n).unwrap().remove(0);
    (0..n)
        .map(|b| {
            out[b * BEAT..(b + 1) * BEAT]
                .iter()
                .fold(0.0f32, |m, &x| m.max(x.abs()))
        })
        .collect()
}

/// Which columns of a render sounded (peak above the noise floor).
fn sounding(peaks: &[f32]) -> Vec<usize> {
    peaks
        .iter()
        .enumerate()
        .filter(|(_, p)| **p > 0.1)
        .map(|(i, _)| i)
        .collect()
}

#[test]
fn a_synced_session_is_silent_until_the_transport_runs() {
    let mut e = session(row_program(vec![0.0, 4.0], (0.0, 8.0)));
    e.clock_set_program("gridclock", clock_program((0.0, 8.0), 0.0))
        .unwrap();
    assert!(sounding(&beats(&mut e, 4)).is_empty(), "stopped is silent");

    e.clock_transport("gridclock", true, true).unwrap();
    // Copies at columns 0 and 4 of a two-beat clip: 0,1 and 4,5.
    assert_eq!(sounding(&beats(&mut e, 8)), vec![0, 1, 4, 5]);
}

#[test]
fn a_cue_plays_from_that_column() {
    let mut e = session(GridTrackProgram {
        start_beat: 4.0,
        ..row_program(vec![0.0, 4.0], (0.0, 8.0))
    });
    e.clock_set_program("gridclock", clock_program((0.0, 8.0), 4.0))
        .unwrap();
    e.clock_transport("gridclock", true, true).unwrap();
    // Cued at column 4: the copy there is heard at once, and the one at
    // column 0 only after the range has come round.
    assert_eq!(sounding(&beats(&mut e, 4)), vec![0, 1]);
    assert!((e.clock_status("gridclock").unwrap().beat - 8.0).abs() < 1e-6);
}

#[test]
fn the_play_range_wraps_to_its_own_start() {
    // A range of columns 4..8 with the clip laid at 4: every pass plays
    // it, and the wrap goes back to 4 rather than to 0.
    let mut e = session(row_program(vec![0.0, 4.0], (4.0, 8.0)));
    e.clock_set_program("gridclock", clock_program((4.0, 8.0), 4.0))
        .unwrap();
    e.clock_transport("gridclock", true, true).unwrap();
    assert_eq!(sounding(&beats(&mut e, 8)), vec![0, 1, 4, 5]);
    let beat = e.clock_status("gridclock").unwrap().beat;
    assert!(
        (4.0..8.0).contains(&beat),
        "wrapped inside the range: {beat}"
    );
}

#[test]
fn pausing_the_transport_stops_the_sound() {
    // Copies end to end, so the row is sounding whatever beat the pause
    // lands on. A row interpolates its position BETWEEN clock edges, so a
    // clock that simply stops pulsing left it free-running at the last
    // measured tempo: the page's pause went quiet on screen while the
    // audio played on.
    let mut e = session(row_program(vec![0.0, 2.0, 4.0, 6.0], (0.0, 8.0)));
    e.clock_set_program("gridclock", clock_program((0.0, 8.0), 0.0))
        .unwrap();
    e.grid_track_transport("gridrow_row1", true).unwrap();
    e.clock_transport("gridclock", true, true).unwrap();
    assert!(!sounding(&beats(&mut e, 2)).is_empty(), "playing sounds");

    // Pause, exactly as `grid_transport { playing: false }` sends it.
    e.grid_track_transport("gridrow_row1", false).unwrap();
    e.clock_transport("gridclock", false, false).unwrap();
    let peaks = beats(&mut e, 4);
    assert!(sounding(&peaks).is_empty(), "paused is silent: {peaks:?}");
    assert!(!e.grid_track_status("gridrow_row1").unwrap().playing);
}

#[test]
fn an_edit_made_while_paused_stays_silent() {
    // The page syncs after every keystroke, so a paused grid is edited
    // through the same call a playing one is. Re-deriving the voices in
    // flight must not be what starts the sound again.
    let mut e = session(row_program(vec![0.0, 2.0, 4.0, 6.0], (0.0, 8.0)));
    e.clock_set_program("gridclock", clock_program((0.0, 8.0), 0.0))
        .unwrap();
    e.clock_transport("gridclock", true, true).unwrap();
    assert!(!sounding(&beats(&mut e, 2)).is_empty());

    e.grid_track_transport("gridrow_row1", false).unwrap();
    e.clock_transport("gridclock", false, false).unwrap();
    e.grid_track_set_program(
        "gridrow_row1",
        row_program(vec![0.0, 2.0, 4.0, 6.0, 7.0], (0.0, 8.0)),
    )
    .unwrap();
    let peaks = beats(&mut e, 4);
    assert!(sounding(&peaks).is_empty(), "still paused: {peaks:?}");
}

#[test]
fn play_after_a_pause_sounds_again() {
    // Pause must hold the row, not retire it: the page cues the next play
    // and every row has to come back in on it.
    let mut e = session(row_program(vec![0.0, 2.0, 4.0, 6.0], (0.0, 8.0)));
    e.clock_set_program("gridclock", clock_program((0.0, 8.0), 0.0))
        .unwrap();
    e.clock_transport("gridclock", true, true).unwrap();
    assert!(!sounding(&beats(&mut e, 2)).is_empty());

    e.grid_track_transport("gridrow_row1", false).unwrap();
    e.clock_transport("gridclock", false, false).unwrap();
    assert!(sounding(&beats(&mut e, 2)).is_empty());

    // Play from column 4, the cue the page sends with a start.
    e.grid_track_set_program(
        "gridrow_row1",
        GridTrackProgram {
            start_beat: 4.0,
            ..row_program(vec![0.0, 2.0, 4.0, 6.0], (0.0, 8.0))
        },
    )
    .unwrap();
    e.grid_track_transport("gridrow_row1", true).unwrap();
    e.clock_set_program("gridclock", clock_program((0.0, 8.0), 4.0))
        .unwrap();
    e.clock_transport("gridclock", true, true).unwrap();
    assert!(!sounding(&beats(&mut e, 2)).is_empty(), "resumes sounding");
}

#[test]
fn a_row_edited_under_a_running_transport_is_heard_changed() {
    let mut e = session(row_program(vec![0.0], (0.0, 8.0)));
    e.clock_set_program("gridclock", clock_program((0.0, 8.0), 0.0))
        .unwrap();
    e.clock_transport("gridclock", true, true).unwrap();
    assert_eq!(sounding(&beats(&mut e, 4)), vec![0, 1]);

    // Placing a copy at column 6 while it runs: the transport does not
    // move, and the new copy is heard when the playhead reaches it.
    e.grid_track_set_program("gridrow_row1", row_program(vec![0.0, 6.0], (0.0, 8.0)))
        .unwrap();
    let peaks = beats(&mut e, 4);
    assert_eq!(sounding(&peaks), vec![2, 3], "columns 6 and 7: {peaks:?}");
}

#[test]
fn audio_focus_gates_the_grid_workspace() {
    // Copies end to end, so whatever the playhead is on, the row sounds.
    let mut e = session(row_program(vec![0.0, 2.0, 4.0, 6.0], (0.0, 8.0)));
    e.clock_set_program("gridclock", clock_program((0.0, 8.0), 0.0))
        .unwrap();
    e.clock_transport("gridclock", true, true).unwrap();
    // The Rack page does not play the Grid page's session (the gate
    // FADES, so the first beat after the switch is the fade itself)...
    e.set_audio_focus(AudioFocus::Rack).unwrap();
    beats(&mut e, 1);
    assert!(sounding(&beats(&mut e, 2)).is_empty());
    // ...and the Grid page does.
    e.set_audio_focus(AudioFocus::Grid).unwrap();
    assert!(!sounding(&beats(&mut e, 4)).is_empty());
}

#[test]
fn the_session_is_not_saved_with_the_patch() {
    let mut e = session(row_program(vec![0.0], (0.0, 8.0)));
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    let mut rack = e.snapshot("grid-session-test");
    rack.retain_workspace(Workspace::Rack);
    assert_eq!(
        rack.modules.keys().collect::<Vec<_>>(),
        vec!["osc1"],
        "a saved rack has none of the Grid page's session in it"
    );
}
