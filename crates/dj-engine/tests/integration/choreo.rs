//! Choreography module: track CRUD and jack allocation, clocked playback
//! of all three track kinds through the RT graph, reorder/rename
//! stability, and patch round-trip.

use dj_engine::choreo::{degree_to_volts, ChoreoTrackData, NoteStep};
use dj_engine::{Engine, EngineConfig};

fn engine() -> Engine {
    Engine::new(EngineConfig::default(), crate::common::registry()).unwrap()
}

/// Feed one clock rising edge (high then low, one block each).
fn tick(e: &mut Engine, instance: &str) {
    e.set_knob_value(instance, "clock", 10.0).unwrap();
    e.process_blocks(1).unwrap();
    e.set_knob_value(instance, "clock", 0.0).unwrap();
    e.process_blocks(1).unwrap();
}

fn out_v(e: &Engine, instance: &str, jack: &str) -> f32 {
    e.tap_out(instance, jack).unwrap().instantaneous
}

#[test]
fn track_crud_allocates_stable_jacks() {
    let mut e = engine();
    e.add_module("ch", "builtin.choreo").unwrap();

    let j0 = e.choreo_add_track("ch", "kick", "boolean").unwrap();
    let j1 = e.choreo_add_track("ch", "sweep", "continuous").unwrap();
    let j2 = e.choreo_add_track("ch", "lead", "note").unwrap(); // 2 jacks
    let j3 = e.choreo_add_track("ch", "hat", "boolean").unwrap();
    assert_eq!((j0, j1, j2, j3), (0, 1, 2, 4));

    // Duplicate names rejected.
    assert!(e.choreo_add_track("ch", "kick", "boolean").is_err());
    // Unknown kinds rejected.
    assert!(e.choreo_add_track("ch", "x", "polyphonic").is_err());

    // Removing the continuous track frees its slot; the next note track
    // needs two contiguous slots, so it skips the freed single slot.
    e.choreo_remove_track("ch", 1).unwrap();
    let j4 = e.choreo_add_track("ch", "pad", "note").unwrap();
    assert_eq!(j4, 5);
    // ... but a boolean track reuses it.
    let j5 = e.choreo_add_track("ch", "clap", "boolean").unwrap();
    assert_eq!(j5, 1);

    // Rename and reorder keep jack slots with their tracks.
    e.choreo_rename_track("ch", 0, "kick2").unwrap();
    e.choreo_move_track("ch", 0, 3).unwrap();
    let st = e.choreo("ch").unwrap();
    let kick = st.tracks.iter().find(|t| t.name == "kick2").unwrap();
    assert_eq!(kick.jack, 0);
    assert_eq!(st.tracks[3].name, "kick2");
}

#[test]
fn boolean_track_outputs_gate_per_beat() {
    let mut e = engine();
    e.add_module("ch", "builtin.choreo").unwrap();
    e.choreo_set_beats("ch", 4).unwrap();
    e.choreo_add_track("ch", "kick", "boolean").unwrap();
    e.choreo_set_bool("ch", 0, 0, true).unwrap();
    e.choreo_set_bool("ch", 0, 2, true).unwrap();

    // Before any clock: silent, playhead parked.
    e.process_blocks(2).unwrap();
    assert_eq!(out_v(&e, "ch", "t0"), 0.0);
    assert_eq!(e.choreo_playhead("ch").unwrap(), -1);

    let expect = [10.0, 0.0, 10.0, 0.0, 10.0, 0.0]; // wraps after beat 3
    for (i, &v) in expect.iter().enumerate() {
        tick(&mut e, "ch");
        assert_eq!(out_v(&e, "ch", "t0"), v, "beat {i}");
        assert_eq!(e.choreo_playhead("ch").unwrap(), (i % 4) as i64);
    }

    // Reset re-arms: the next clock plays beat 0 again.
    e.set_knob_value("ch", "reset", 10.0).unwrap();
    e.process_blocks(1).unwrap();
    e.set_knob_value("ch", "reset", 0.0).unwrap();
    tick(&mut e, "ch");
    assert_eq!(out_v(&e, "ch", "t0"), 10.0);
    assert_eq!(e.choreo_playhead("ch").unwrap(), 0);
}

#[test]
fn continuous_track_interpolates_between_beats() {
    let mut e = engine();
    e.add_module("ch", "builtin.choreo").unwrap();
    e.choreo_set_beats("ch", 4).unwrap();
    e.choreo_add_track("ch", "sweep", "continuous").unwrap();
    e.choreo_set_values("ch", 0, 0, &[0.0, 8.0, -4.0, 0.0])
        .unwrap();

    // First tick plays beat 0; the interval is unknown until the second
    // edge, so the lane holds beat 0's value un-interpolated.
    tick(&mut e, "ch");
    assert_eq!(out_v(&e, "ch", "t0"), 0.0);
    // Second edge: measures the interval (2 blocks = 256 samples) and
    // lands on beat 1. One block (128 samples) in, the lane has lerped
    // halfway from 8 toward beat 2's -4.
    e.set_knob_value("ch", "clock", 10.0).unwrap();
    e.process_blocks(1).unwrap();
    let mid = out_v(&e, "ch", "t0");
    assert!(
        (mid - 2.0).abs() < 0.5,
        "expected ~2.0 halfway from 8 to -4, got {mid}"
    );
    // A full interval past the edge: clamped at the target.
    e.set_knob_value("ch", "clock", 0.0).unwrap();
    e.process_blocks(1).unwrap();
    let v = out_v(&e, "ch", "t0");
    assert!((v - -4.0).abs() < 0.5, "expected ~-4 at phase 1.0, got {v}");

    // Values clamp to +/-10.
    e.choreo_set_values("ch", 0, 0, &[20.0]).unwrap();
    let st = e.choreo("ch").unwrap();
    match &st.tracks[0].data {
        ChoreoTrackData::Continuous { values } => assert_eq!(values[0], 10.0),
        _ => unreachable!(),
    }
}

#[test]
fn note_track_outputs_pitch_and_velocity() {
    let mut e = engine();
    e.add_module("ch", "builtin.choreo").unwrap();
    e.choreo_set_beats("ch", 4).unwrap();
    e.choreo_add_track("ch", "lead", "note").unwrap();
    // Major scale over C4: degree 0 = C4 (0 V), degree 2 = E4, degree 7 =
    // C5 (1 V, octave wrap).
    e.choreo_set_note_settings("ch", 0, 2, "major", 60).unwrap();
    e.choreo_set_note(
        "ch",
        0,
        0,
        Some(NoteStep {
            degree: 0,
            velocity: 1.0,
        }),
    )
    .unwrap();
    e.choreo_set_note(
        "ch",
        0,
        1,
        Some(NoteStep {
            degree: 7,
            velocity: 0.5,
        }),
    )
    .unwrap();
    // Beats 2 and 3 stay empty.

    tick(&mut e, "ch"); // beat 0
    assert_eq!(out_v(&e, "ch", "t0"), 0.0); // C4 = 0 V
    assert_eq!(out_v(&e, "ch", "t1"), 10.0); // full velocity

    tick(&mut e, "ch"); // beat 1
    assert_eq!(out_v(&e, "ch", "t0"), 1.0); // C5 = 1 V
    assert_eq!(out_v(&e, "ch", "t1"), 5.0); // half velocity

    tick(&mut e, "ch"); // beat 2: no note — pitch holds, velocity gates off
    assert_eq!(out_v(&e, "ch", "t0"), 1.0);
    assert_eq!(out_v(&e, "ch", "t1"), 0.0);

    // Clearing a note works.
    e.choreo_set_note("ch", 0, 1, None).unwrap();
    let st = e.choreo("ch").unwrap();
    match &st.tracks[0].data {
        ChoreoTrackData::Note { steps, .. } => assert!(steps[1].is_none()),
        _ => unreachable!(),
    }
}

#[test]
fn degree_voltage_math() {
    // Pentatonic major: 5 degrees per octave.
    assert_eq!(degree_to_volts("penta maj", 60, 0), 0.0);
    assert_eq!(degree_to_volts("penta maj", 60, 5), 1.0); // octave up
    assert_eq!(degree_to_volts("penta maj", 60, 1), 2.0 / 12.0); // D4
                                                                 // Base note shifts linearly: A4 = MIDI 69 = +9 semitones.
    assert_eq!(degree_to_volts("chromatic", 69, 0), 9.0 / 12.0);
    // Base an octave down.
    assert_eq!(degree_to_volts("major", 48, 0), -1.0);
}

#[test]
fn track_jacks_are_wireable_and_survive_persistence() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = engine();
    e.add_module("ch", "builtin.choreo").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.choreo_set_beats("ch", 8).unwrap();
    e.choreo_add_track("ch", "gate", "boolean").unwrap();
    e.choreo_add_track("ch", "lead", "note").unwrap();
    e.choreo_set_bool("ch", 0, 0, true).unwrap();
    e.choreo_set_note(
        "ch",
        1,
        0,
        Some(NoteStep {
            degree: 3,
            velocity: 0.75,
        }),
    )
    .unwrap();
    e.choreo_set_note_settings("ch", 1, 3, "penta min", 57)
        .unwrap();
    // Wire the boolean track into the VCA (by stable jack id).
    e.connect("ch", "t0", "vca1", "cv").unwrap();

    e.save_patch(dir.path(), "choreo-test").unwrap();
    let mut e2 = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();

    let st = e2.choreo("ch").unwrap();
    assert_eq!(st.beats, 8);
    assert_eq!(st.tracks.len(), 2);
    assert_eq!(st.tracks[0].name, "gate");
    assert_eq!(st.tracks[1].jack, 1);
    match &st.tracks[1].data {
        ChoreoTrackData::Note {
            octaves,
            scale,
            base_note,
            steps,
        } => {
            assert_eq!((*octaves, scale.as_str(), *base_note), (3, "penta min", 57));
            assert_eq!(
                steps[0],
                Some(NoteStep {
                    degree: 3,
                    velocity: 0.75
                })
            );
        }
        _ => unreachable!(),
    }
    // The restored wire still carries the gate.
    tick(&mut e2, "ch");
    assert_eq!(e2.tap("vca1", "cv").unwrap().instantaneous, 10.0);

    // Saving again is byte-stable.
    let snap1 = e2.snapshot("choreo-test");
    e2.save_patch(dir.path(), "choreo-test").unwrap();
    let snap2 = Engine::load_patch(dir.path(), crate::common::registry())
        .unwrap()
        .snapshot("choreo-test");
    assert_eq!(snap1, snap2);
}

#[test]
fn set_beats_resizes_and_undo_restore_diffs_state() {
    let mut e = engine();
    e.add_module("ch", "builtin.choreo").unwrap();
    e.choreo_set_beats("ch", 4).unwrap();
    e.choreo_add_track("ch", "a", "continuous").unwrap();
    e.choreo_set_values("ch", 0, 0, &[1.0, 2.0, 3.0, 4.0])
        .unwrap();
    let before = e.snapshot("t");

    // Grow: old values kept, new beats default.
    e.choreo_set_beats("ch", 6).unwrap();
    e.choreo_set_values("ch", 0, 4, &[5.0, 6.0]).unwrap();
    // Shrink: truncates.
    e.choreo_set_beats("ch", 2).unwrap();
    match &e.choreo("ch").unwrap().tracks[0].data {
        ChoreoTrackData::Continuous { values } => assert_eq!(values, &[1.0, 2.0]),
        _ => unreachable!(),
    }

    // apply_doc (undo path) restores the earlier timeline in place.
    let recreated = e.apply_doc(&before).unwrap();
    assert!(
        recreated.is_empty(),
        "choreo diff must not recreate the node"
    );
    assert_eq!(e.choreo("ch").unwrap().beats, 4);
    match &e.choreo("ch").unwrap().tracks[0].data {
        ChoreoTrackData::Continuous { values } => assert_eq!(values, &[1.0, 2.0, 3.0, 4.0]),
        _ => unreachable!(),
    }

    // Out-of-range edits fail cleanly.
    assert!(e.choreo_set_bool("ch", 0, 0, true).is_err()); // wrong kind
    assert!(e.choreo_set_values("ch", 0, 3, &[0.0, 0.0]).is_err()); // past end
    assert!(e.choreo_set_beats("ch", 0).is_err());
    assert!(e.choreo_set_beats("ch", 1_000_000).is_err());
}
