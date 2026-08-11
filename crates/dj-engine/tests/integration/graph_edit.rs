//! Live graph editing: wires can be disconnected, and structural edits work
//! across a stop → edit → restart cycle (the flow the GUI uses when adding
//! modules/wires while audio is running).

use dj_engine::{KnobStyle, MidiMapKind};

const SR: f32 = 48_000.0;

#[test]
fn disconnect_removes_the_wire_and_restores_the_knob_value() {
    let mut engine = crate::common::default_engine();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    engine.connect("osc1", "audio", "vca1", "in").unwrap();
    assert_eq!(engine.wire_specs().len(), 1);

    // Wired: the vca input follows the oscillator (non-zero audio).
    engine.set_knob_position("vca1", "cv", 1.0).unwrap();
    engine.render_offline((0.2 * SR) as usize).unwrap();
    let wired = engine.tap("vca1", "in").unwrap();
    assert!(
        wired.rms_100ms > 0.5,
        "wired input should see audio: {wired:?}"
    );

    engine.disconnect("osc1", "audio", "vca1", "in").unwrap();
    assert!(engine.wire_specs().is_empty());

    // Unwired again: the input falls back to its knob (default 0).
    engine.render_offline((0.2 * SR) as usize).unwrap();
    let unwired = engine.tap("vca1", "in").unwrap();
    assert!(
        unwired.rms_100ms < 1e-3,
        "unwired input should fall back to knob: {unwired:?}"
    );

    // Disconnecting a wire that does not exist fails cleanly.
    assert!(engine.disconnect("osc1", "audio", "vca1", "in").is_err());
}

#[test]
fn structural_edits_work_across_stop_start_cycles() {
    let mut engine = crate::common::default_engine();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    engine.add_module("out1", "builtin.audio_out").unwrap();
    engine.connect("osc1", "audio", "out1", "l").unwrap();

    // Run realtime (null backend), then stop: the graph must come back so
    // edits can continue — this is what GUI add-module/wiring relies on.
    engine.start_null_realtime().unwrap();
    assert_eq!(engine.backend(), Some(dj_engine::Backend::Null));
    std::thread::sleep(std::time::Duration::from_millis(30));
    engine.stop().unwrap();
    assert_eq!(engine.backend(), None);

    engine.add_module("vca1", "com.dj.vca").unwrap();
    engine.disconnect("osc1", "audio", "out1", "l").unwrap();
    engine.connect("osc1", "audio", "vca1", "in").unwrap();
    engine.connect("vca1", "out", "out1", "l").unwrap();
    assert_eq!(engine.wire_specs().len(), 2);

    // And the edited graph still runs.
    engine.start_null_realtime().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(30));
    engine.stop().unwrap();
}

/// Incremental remove: the slot is recycled by the next add, wires to
/// OTHER nodes keep working, and stale ids fail cleanly.
#[test]
fn remove_module_is_incremental_and_recycles_the_slot() {
    let mut e = crate::common::default_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();

    // Removing vca1 drops both touching wires; osc1/out1 survive.
    e.remove_module("vca1").unwrap();
    assert!(e.wire_specs().is_empty());
    assert!(e.remove_module("vca1").is_err()); // already gone
    assert!(e.nodes.iter().all(|n| n.instance_id != "vca1"));
    e.render_offline(4_800).unwrap(); // still renders

    // The freed slot is reused and the recycled graph works end-to-end.
    e.add_module("vca2", "com.dj.vca").unwrap();
    e.connect("osc1", "audio", "vca2", "in").unwrap();
    e.connect("vca2", "out", "out1", "l").unwrap();
    e.set_knob_position("vca2", "cv", 1.0).unwrap();
    e.render_offline((0.2 * SR) as usize).unwrap();
    assert!(
        e.tap("out1", "l").unwrap().rms_100ms > 0.5,
        "audio must flow through the module in the recycled slot"
    );
}

/// `apply_doc` morphs the live engine to a snapshot by diffing: modules in
/// both keep their slot (and thus DSP state + telemetry); removed ones go;
/// new ones appear; knob/param/wire deltas apply.
#[test]
fn apply_doc_diffs_the_live_engine_instead_of_rebuilding() {
    let mut e = crate::common::default_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();
    e.set_knob_position("osc1", "pitch", 0.25).unwrap();
    let before = e.snapshot("undo");

    // Mutate: knob, param-ish knob, extra module, dropped wire.
    e.set_knob_position("osc1", "pitch", 0.9).unwrap();
    e.add_module("osc2", "com.dj.oscillator").unwrap();
    e.disconnect("vca1", "out", "out1", "l").unwrap();

    // Undo via apply_doc: state converges exactly on the snapshot.
    let created = e.apply_doc(&before).unwrap();
    assert!(created.is_empty(), "no module should need recreating");
    assert_eq!(e.snapshot("undo"), before);
    assert_eq!(e.knob_state("osc1", "pitch").unwrap().position, 0.25);
    assert!(e.nodes.iter().all(|n| n.instance_id != "osc2"));

    // Redo direction: a doc with an extra module reports it as created.
    let mut redo = before.clone();
    redo.modules
        .insert("osc3".into(), before.modules.get("osc1").cloned().unwrap());
    let created = e.apply_doc(&redo).unwrap();
    assert_eq!(created, vec!["osc3".to_string()]);
    assert_eq!(e.snapshot("undo"), redo);
}

/// The reason for the rewrite: across an apply_doc undo, an untouched
/// module's DSP state must keep running — no rebuild, no reset.
#[test]
fn apply_doc_preserves_untouched_module_state() {
    let mut e = crate::common::default_engine();
    e.add_module("lfo1", "com.dj.lfo").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.render_offline((0.3 * SR) as usize).unwrap();

    // Control: same patch rendered straight through.
    let mut control = crate::common::default_engine();
    control.add_module("lfo1", "com.dj.lfo").unwrap();
    control.add_module("vca1", "com.dj.vca").unwrap();
    control.render_offline((0.3 * SR) as usize).unwrap();

    // Undo an add (osc2 disappears again) — the LFO must not notice.
    let before = e.snapshot("undo");
    e.add_module("osc2", "com.dj.oscillator").unwrap();
    e.apply_doc(&before).unwrap();

    e.render_offline((0.1 * SR) as usize).unwrap();
    control.render_offline((0.1 * SR) as usize).unwrap();
    let got = e.tap_out("lfo1", "bi").unwrap().instantaneous;
    let want = control.tap_out("lfo1", "bi").unwrap().instantaneous;
    assert!(
        (got - want).abs() < 1e-4,
        "LFO phase reset across apply_doc: {got} != {want}"
    );
}

#[test]
fn wire_knob_style_roundtrips_like_any_other_config() {
    let mut engine = crate::common::default_engine();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    let cfg = dj_engine::KnobConfig {
        style: KnobStyle::Wire,
        ..Default::default()
    };
    engine
        .set_knob_config("vca1", "cv", Some(cfg.clone()))
        .unwrap();
    let state = engine.knob_state("vca1", "cv").unwrap();
    assert_eq!(state.config.unwrap().style, KnobStyle::Wire);

    // Serde round-trip (persistence uses the same serialization).
    let json = serde_json::to_string(&cfg).unwrap();
    assert!(json.contains("\"wire\""), "{json}");
    let back: dj_engine::KnobConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(back.style, KnobStyle::Wire);
}

#[test]
fn midi_mapping_remove_drops_wires_frees_the_slot_and_roundtrips() {
    let mut engine = crate::common::default_engine();
    engine.add_module("midi1", "builtin.midi").unwrap();
    engine.add_module("out1", "builtin.audio_out").unwrap();
    engine
        .add_midi_mapping("midi1", MidiMapKind::Note, 60, "C4")
        .unwrap();
    engine
        .add_midi_mapping("midi1", MidiMapKind::Cc, 7, "cc7")
        .unwrap();
    engine.connect("midi1", "C4", "out1", "l").unwrap();
    assert_eq!(engine.wire_specs().len(), 1);

    // A held note drives the mapped jack…
    engine.inject_midi("midi1", 0, [0x90, 60, 100]).unwrap();
    engine.render_offline((0.2 * SR) as usize).unwrap();
    assert!(engine.tap("out1", "l").unwrap().display > 5.0);

    // …removing the mapping drops its wire and silences the input.
    engine.remove_midi_mapping("midi1", "C4").unwrap();
    assert!(engine.wire_specs().is_empty());
    assert!(engine.remove_midi_mapping("midi1", "C4").is_err());
    engine.render_offline((0.2 * SR) as usize).unwrap();
    assert!(engine.tap("out1", "l").unwrap().display.abs() < 1e-3);

    // The freed slot is reusable without leaking the old note's value.
    engine
        .add_midi_mapping("midi1", MidiMapKind::Note, 64, "E4")
        .unwrap();
    engine.connect("midi1", "E4", "out1", "l").unwrap();
    engine.render_offline((0.2 * SR) as usize).unwrap();
    assert!(
        engine.tap("out1", "l").unwrap().display.abs() < 1e-3,
        "reused slot must start at 0, not the removed note's value"
    );

    // Post-removal mapping state round-trips through patch save/load.
    let dir = tempfile::tempdir().unwrap();
    engine.save_patch(dir.path(), "t").unwrap();
    let reloaded = dj_engine::Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    let midi = reloaded
        .nodes
        .iter()
        .find(|n| n.instance_id == "midi1")
        .unwrap();
    let names: Vec<&str> = midi.midi_mappings.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(names, vec!["cc7", "E4"]);
}
