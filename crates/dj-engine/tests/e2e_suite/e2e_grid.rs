//! E2E golden-audio cases for the Grid modules — the Clock
//! (`builtin.clock`) and the Grid Track (`builtin.grid_track`) that
//! together play a Grid arrangement inside the engine.
//!
//! `grid-two-rows`: two rows over a four-beat loop running at 140 BPM
//! from clips cut at 120, so the golden pins the stretch, the placement
//! arithmetic (a two-beat clip on beats 0 and 2 against a one-beat clip
//! on beats 1 and 3), the row level line, the pan law and the loop's
//! seam. Left and right are the mix — row 2 is panned right and pulled
//! down by its level line, so the two channels differ.
//!
//! The arrangement is NOT patch state (a Grid is saved in its own
//! document, `grids/<name>.json`), so the programs and the clips ride in
//! the sidecar the way a Decks bank's clips do.
//!
//! Regenerate with `REGEN_GOLDENS=1 cargo test -p dj-engine --release
//! --test e2e_suite grid` (or `./scripts/regen-goldens.sh`).

use crate::common::e2e::{
    case_dir, check_case, regen, write_case_tone, write_events, ClockSpec, EventsFile,
    GridTrackSpec,
};
use dj_engine::clock::ClockProgram;
use dj_engine::grid_track::{GridTrackProgram, LevelPoint};
use dj_engine::{Engine, EngineConfig};

fn regen_grid_two_rows() {
    let dir = case_dir("grid-two-rows");
    // At 120 BPM a beat is half a second: a two-beat clip and a one-beat.
    write_case_tone(&dir.join("two-beat.wav"), 220.0, 1.0);
    write_case_tone(&dir.join("one-beat.wav"), 330.0, 0.5);

    let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
    e.add_module("clk", "builtin.clock").unwrap();
    e.add_module("row1", "builtin.grid_track").unwrap();
    e.add_module("row2", "builtin.grid_track").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.set_knob_value("clk", "bpm", 140.0).unwrap();
    // Row 2 sits right of centre and half as loud — the chrome controls
    // are ordinary jacks, which is the point of the refactor.
    e.set_knob_value("row2", "pan", 0.6).unwrap();
    e.set_knob_value("row2", "level", 0.5).unwrap();
    for row in ["row1", "row2"] {
        e.connect("clk", "clock", row, "clock").unwrap();
        e.connect("clk", "reset", row, "reset").unwrap();
        e.connect(row, "audio_l", "out1", "l").unwrap();
        e.connect(row, "audio_r", "out1", "r").unwrap();
    }

    e.save_patch(&dir.join("patch"), "e2e-grid-two-rows")
        .unwrap();
    write_events(
        &dir,
        &EventsFile {
            seconds: 2.5,
            grid_tracks: vec![
                GridTrackSpec {
                    instance: "row1".into(),
                    file: "two-beat.wav".into(),
                    bpm: Some(120.0),
                    program: GridTrackProgram {
                        copies: vec![0.0, 2.0],
                        clip_beats: 2.0,
                        loop_end: 4.0,
                        ..GridTrackProgram::default()
                    },
                },
                GridTrackSpec {
                    instance: "row2".into(),
                    file: "one-beat.wav".into(),
                    bpm: Some(120.0),
                    program: GridTrackProgram {
                        copies: vec![1.0, 3.0],
                        levels: vec![
                            LevelPoint {
                                beat: 0.0,
                                level: 1.0,
                            },
                            LevelPoint {
                                beat: 4.0,
                                level: 0.2,
                            },
                        ],
                        clip_beats: 1.0,
                        loop_end: 4.0,
                        ..GridTrackProgram::default()
                    },
                },
            ],
            clocks: vec![ClockSpec {
                instance: "clk".into(),
                program: ClockProgram {
                    loop_end: 4.0,
                    looping: true,
                    ..ClockProgram::default()
                },
                running: true,
            }],
            ..EventsFile::default()
        },
    );
}

#[test]
fn grid_two_rows() {
    if regen() {
        regen_grid_two_rows();
    }
    check_case("grid-two-rows");
}
