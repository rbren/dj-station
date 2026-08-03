//! Undo/redo: PatchDoc snapshots restore full engine state, and
//! UndoHistory coalesces rapid same-key edits (e.g. knob drags).

mod common;

use common::registry;
use dj_engine::{Engine, UndoHistory};

fn demo_engine() -> Engine {
    let mut e = common::default_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();
    e.set_knob_position("osc1", "pitch", 0.25).unwrap();
    e
}

#[test]
fn snapshot_restores_modules_wires_knobs_and_params() {
    let mut e = demo_engine();
    let before = e.snapshot("t");

    // Mutate: knob move, param change, new wire, new module.
    e.set_knob_position("osc1", "pitch", 0.9).unwrap();
    e.set_param("osc1", "waveform", 2.0).unwrap();
    e.add_module("osc2", "com.dj.oscillator").unwrap();
    e.disconnect("vca1", "out", "out1", "l").unwrap();
    assert_ne!(e.snapshot("t"), before);

    let restored = Engine::from_doc(&before, registry()).unwrap();
    assert_eq!(restored.snapshot("t"), before);
    assert_eq!(restored.knob_state("osc1", "pitch").unwrap().position, 0.25);
    assert!(restored.nodes.iter().all(|n| n.instance_id != "osc2"));
}

#[test]
fn undo_and_redo_walk_the_edit_history() {
    let mut e = demo_engine();
    let mut h = UndoHistory::new();

    h.record("knob:osc1:pitch", e.snapshot("t"));
    e.set_knob_position("osc1", "pitch", 0.9).unwrap();
    let after_knob = e.snapshot("t");

    h.record("add:osc2", e.snapshot("t"));
    e.add_module("osc2", "com.dj.oscillator").unwrap();
    let after_add = e.snapshot("t");

    // Undo the add, then the knob move.
    let doc = h.undo(e.snapshot("t")).unwrap();
    assert_eq!(doc, after_knob);
    e = Engine::from_doc(&doc, registry()).unwrap();
    let doc = h.undo(e.snapshot("t")).unwrap();
    e = Engine::from_doc(&doc, registry()).unwrap();
    assert_eq!(e.knob_state("osc1", "pitch").unwrap().position, 0.25);
    assert!(h.undo(e.snapshot("t")).is_none());

    // Redo both.
    let doc = h.redo(e.snapshot("t")).unwrap();
    assert_eq!(doc, after_knob);
    e = Engine::from_doc(&doc, registry()).unwrap();
    let doc = h.redo(e.snapshot("t")).unwrap();
    assert_eq!(doc, after_add);
    e = Engine::from_doc(&doc, registry()).unwrap();
    assert!(e.nodes.iter().any(|n| n.instance_id == "osc2"));
    assert!(h.redo(e.snapshot("t")).is_none());
}

#[test]
fn rapid_same_key_edits_coalesce_into_one_undo_step() {
    let mut e = demo_engine();
    let mut h = UndoHistory::new();

    // A knob drag streams many position updates with the same key.
    for i in 1..=20 {
        h.record("knob:osc1:pitch", e.snapshot("t"));
        e.set_knob_position("osc1", "pitch", 0.25 + i as f32 * 0.01)
            .unwrap();
    }

    // One undo returns to the pre-drag value; nothing older remains.
    let doc = h.undo(e.snapshot("t")).unwrap();
    let restored = Engine::from_doc(&doc, registry()).unwrap();
    assert_eq!(restored.knob_state("osc1", "pitch").unwrap().position, 0.25);
    assert!(!h.can_undo());
}

#[test]
fn new_edit_clears_the_redo_stack() {
    let mut e = demo_engine();
    let mut h = UndoHistory::new();

    h.record("knob:osc1:pitch", e.snapshot("t"));
    e.set_knob_position("osc1", "pitch", 0.9).unwrap();

    let doc = h.undo(e.snapshot("t")).unwrap();
    e = Engine::from_doc(&doc, registry()).unwrap();
    assert!(h.can_redo());

    h.record("param:osc1:waveform", e.snapshot("t"));
    e.set_param("osc1", "waveform", 1.0).unwrap();
    assert!(!h.can_redo());
    assert!(h.redo(e.snapshot("t")).is_none());
}

#[test]
fn end_gesture_splits_same_knob_edits_into_separate_undo_steps() {
    let mut e = demo_engine();
    let mut h = UndoHistory::new();

    // First drag gesture: two rapid records coalesce into one step.
    h.record("knob:osc1:pitch", e.snapshot("t"));
    e.set_knob_position("osc1", "pitch", 0.5).unwrap();
    h.record("knob:osc1:pitch", e.snapshot("t"));
    e.set_knob_position("osc1", "pitch", 0.6).unwrap();
    h.end_gesture(); // pointer-up

    // Second gesture on the same knob, well within the time window.
    h.record("knob:osc1:pitch", e.snapshot("t"));
    e.set_knob_position("osc1", "pitch", 0.9).unwrap();

    // First undo -> back to end of the first gesture (0.6), not 0.25.
    let doc = h.undo(e.snapshot("t")).unwrap();
    e = Engine::from_doc(&doc, registry()).unwrap();
    assert_eq!(e.knob_state("osc1", "pitch").unwrap().position, 0.6);

    // Second undo -> back to the original position.
    let doc = h.undo(e.snapshot("t")).unwrap();
    e = Engine::from_doc(&doc, registry()).unwrap();
    assert_eq!(e.knob_state("osc1", "pitch").unwrap().position, 0.25);
}

#[test]
fn remove_module_drops_node_and_all_touching_wires() {
    let e = demo_engine();
    let mut doc = e.snapshot("t");
    assert!(doc.remove_module("vca1"));
    assert!(!doc.remove_module("vca1")); // already gone

    let rebuilt = Engine::from_doc(&doc, registry()).unwrap();
    assert!(rebuilt.nodes.iter().all(|n| n.instance_id != "vca1"));
    // Both the osc1->vca1 and vca1->out1 wires are gone.
    assert!(rebuilt.wire_specs().is_empty());
    // Still renders (silence) without panicking.
    let mut rebuilt = rebuilt;
    rebuilt.render_offline(4_800).unwrap();
}
