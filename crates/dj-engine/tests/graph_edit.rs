//! Live graph editing: wires can be disconnected, and structural edits work
//! across a stop → edit → restart cycle (the flow the GUI uses when adding
//! modules/wires while audio is running).

mod common;

use dj_engine::KnobStyle;

const SR: f32 = 48_000.0;

#[test]
fn disconnect_removes_the_wire_and_restores_the_knob_value() {
    let mut engine = common::default_engine();
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
    let mut engine = common::default_engine();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    engine.add_module("out1", "builtin.audio_out").unwrap();
    engine.connect("osc1", "audio", "out1", "ch1").unwrap();

    // Run realtime (null backend), then stop: the graph must come back so
    // edits can continue — this is what GUI add-module/wiring relies on.
    engine.start_null_realtime().unwrap();
    assert_eq!(engine.backend_name(), Some("null"));
    std::thread::sleep(std::time::Duration::from_millis(30));
    engine.stop().unwrap();
    assert_eq!(engine.backend_name(), None);

    engine.add_module("vca1", "com.dj.vca").unwrap();
    engine.disconnect("osc1", "audio", "out1", "ch1").unwrap();
    engine.connect("osc1", "audio", "vca1", "in").unwrap();
    engine.connect("vca1", "out", "out1", "ch1").unwrap();
    assert_eq!(engine.wire_specs().len(), 2);

    // And the edited graph still runs.
    engine.start_null_realtime().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(30));
    engine.stop().unwrap();
}

#[test]
fn wire_knob_style_roundtrips_like_any_other_config() {
    let mut engine = common::default_engine();
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
