//! Undo/redo: PatchDoc snapshots restore full engine state, and
//! UndoHistory coalesces rapid same-key edits (e.g. knob drags).

use crate::common::registry;
use dj_engine::{Engine, UndoHistory};

fn demo_engine() -> Engine {
    let mut e = crate::common::default_engine();
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
    e.set_knob_value("osc1", "waveform", 2.0).unwrap();
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
    // Restores go through `apply_doc` — the live diff-based morph the app's
    // restore_doc uses — not a from_doc rebuild.
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
    e.apply_doc(&doc).unwrap();
    let doc = h.undo(e.snapshot("t")).unwrap();
    e.apply_doc(&doc).unwrap();
    assert_eq!(e.knob_state("osc1", "pitch").unwrap().position, 0.25);
    assert!(h.undo(e.snapshot("t")).is_none());

    // Redo both.
    let doc = h.redo(e.snapshot("t")).unwrap();
    assert_eq!(doc, after_knob);
    e.apply_doc(&doc).unwrap();
    let doc = h.redo(e.snapshot("t")).unwrap();
    assert_eq!(doc, after_add);
    e.apply_doc(&doc).unwrap();
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

    h.record("knob:osc1:waveform", e.snapshot("t"));
    e.set_knob_value("osc1", "waveform", 1.0).unwrap();
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

// --- Rack layout (module positions) in undo/redo -------------------------
//
// Positions are UI passthrough on NodeInfo, captured in PatchDoc::layout,
// so module moves and deletes (macro instances included) undo with the
// arrangement intact. See the Tauri shell's move_modules/sync_positions.

#[test]
fn layout_rides_snapshots_and_patch_files() {
    let mut e = demo_engine();
    assert!(e.snapshot("t").layout.is_empty());

    e.set_module_position("osc1", (96.0, 48.0)).unwrap();
    e.set_module_position("vca1", (288.0, 48.0)).unwrap();
    assert_eq!(e.module_position("osc1"), Some((96.0, 48.0)));

    let doc = e.snapshot("t");
    assert_eq!(doc.layout["osc1"], (96.0, 48.0));
    assert_eq!(doc.layout["vca1"], (288.0, 48.0));
    assert!(!doc.layout.contains_key("out1"), "unplaced nodes stay out");

    // Round-trips through the patch directory as layout.json...
    let dir = tempfile::tempdir().unwrap();
    e.save_patch(dir.path(), "t").unwrap();
    assert!(dir.path().join("layout.json").is_file());
    assert_eq!(dj_engine::PatchDoc::read(dir.path()).unwrap(), doc);
    let loaded = Engine::load_patch(dir.path(), registry()).unwrap();
    assert_eq!(loaded.module_position("osc1"), Some((96.0, 48.0)));

    // ...and a layout-free patch never writes (and even removes) the file,
    // keeping pre-layout patches byte-identical.
    let fresh = demo_engine();
    fresh.save_patch(dir.path(), "t").unwrap();
    assert!(!dir.path().join("layout.json").exists());
}

#[test]
fn undo_and_redo_restore_module_moves() {
    let mut e = demo_engine();
    let mut h = UndoHistory::new();

    // A first-ever drag: the shell seeds the pre-drag position before the
    // undo snapshot (move_modules), then applies the drop position.
    e.set_module_position("osc1", (0.0, 0.0)).unwrap();
    h.record("move", e.snapshot("t"));
    e.set_module_position("osc1", (192.0, 96.0)).unwrap();
    h.end_gesture();

    // A second drag is its own undo step despite the same key.
    h.record("move", e.snapshot("t"));
    e.set_module_position("osc1", (384.0, 0.0)).unwrap();
    h.end_gesture();

    let doc = h.undo(e.snapshot("t")).unwrap();
    e.apply_doc(&doc).unwrap();
    assert_eq!(e.module_position("osc1"), Some((192.0, 96.0)));

    let doc = h.undo(e.snapshot("t")).unwrap();
    e.apply_doc(&doc).unwrap();
    assert_eq!(e.module_position("osc1"), Some((0.0, 0.0)));

    let doc = h.redo(e.snapshot("t")).unwrap();
    e.apply_doc(&doc).unwrap();
    assert_eq!(e.module_position("osc1"), Some((192.0, 96.0)));

    // A doc that never knew a node's position clears it (the frontend
    // falls back to its local layout store).
    let mut unknown = e.snapshot("t");
    unknown.layout.clear();
    e.apply_doc(&unknown).unwrap();
    assert_eq!(e.module_position("osc1"), None);
}

#[test]
fn undo_restores_a_deleted_module_with_its_position_and_wires() {
    let mut e = demo_engine();
    let mut h = UndoHistory::new();
    e.set_module_position("vca1", (480.0, 240.0)).unwrap();

    h.record("remove:vca1", e.snapshot("t"));
    e.remove_module("vca1").unwrap();
    assert!(e.nodes.iter().all(|n| n.instance_id != "vca1"));
    assert!(e.wire_specs().is_empty());

    let doc = h.undo(e.snapshot("t")).unwrap();
    let recreated = e.apply_doc(&doc).unwrap();
    assert!(recreated.contains(&"vca1".to_string()));
    assert_eq!(e.module_position("vca1"), Some((480.0, 240.0)));
    assert_eq!(e.wire_specs().len(), 2, "both wires restored");
    assert_eq!(e.knob_state("osc1", "pitch").unwrap().position, 0.25);
}

#[test]
fn doc_remove_module_prunes_layout_including_macro_members() {
    let e = demo_engine();
    let mut doc = e.snapshot("t");
    doc.layout.insert("vca1".into(), (1.0, 2.0));
    doc.layout.insert("tone1/osc1".into(), (3.0, 4.0));
    doc.modules.insert(
        "tone1".into(),
        doc.modules["osc1"].clone(), // shape irrelevant for pruning
    );

    assert!(doc.remove_module("vca1"));
    assert!(!doc.layout.contains_key("vca1"));

    assert!(doc.remove_module("tone1"));
    assert!(!doc.layout.contains_key("tone1/osc1"));
}
