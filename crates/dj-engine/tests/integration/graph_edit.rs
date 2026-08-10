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
