//! The QWERTY module in the engine graph: key transitions in, held gates
//! out. Events cross the SPSC ring sample-accurately, gates land at wired
//! inputs, unknown keys are ignored, and the node round-trips through the
//! patch directory format.

use dj_engine::qwerty::{key_index, KEYS, KEY_GATE_VOLTS, N_QWERTY_JACKS};
use dj_engine::Engine;

/// A qwerty node with a scope on a few representative key jacks so gate
/// values are observable via telemetry (additive wire law, plain `in`).
fn rigged_engine(keys: &[&str]) -> Engine {
    let mut engine = crate::common::default_engine();
    engine.add_module("kb1", "builtin.qwerty").unwrap();
    for key in keys {
        let scope = format!("scope_{key}");
        engine.add_module(&scope, "com.dj.scope").unwrap();
        engine.connect("kb1", key, &scope, "in").unwrap();
    }
    engine
}

fn read(engine: &Engine, key: &str) -> f32 {
    engine
        .tap(&format!("scope_{key}"), "in")
        .unwrap()
        .instantaneous
}

#[test]
fn key_gates_land_at_wired_inputs() {
    let mut engine = rigged_engine(&["q", "space", "5"]);

    engine.qwerty_key("kb1", 0, "q", true).unwrap();
    engine.qwerty_key("kb1", 0, " ", true).unwrap();
    engine.process_blocks(2).unwrap();
    assert_eq!(read(&engine, "q"), KEY_GATE_VOLTS);
    assert_eq!(read(&engine, "space"), KEY_GATE_VOLTS);
    assert_eq!(read(&engine, "5"), 0.0, "unpressed key must stay low");

    engine
        .qwerty_key("kb1", engine.current_frame(), "q", false)
        .unwrap();
    engine.process_blocks(2).unwrap();
    assert_eq!(read(&engine, "q"), 0.0, "released key must drop to 0 V");
    assert_eq!(
        read(&engine, "space"),
        KEY_GATE_VOLTS,
        "space is still held"
    );
}

#[test]
fn unknown_keys_are_ignored_and_wrong_module_errors() {
    let mut engine = rigged_engine(&[]);
    // Escape/F-keys/etc. are not jacks; the panel forwards everything.
    engine.qwerty_key("kb1", 0, "escape", true).unwrap();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    assert!(engine.qwerty_key("osc1", 0, "q", true).is_err());
    assert!(engine.qwerty_key("nope", 0, "q", true).is_err());
}

#[test]
fn manifest_covers_all_alnum_keys_plus_space() {
    let m = dj_engine::qwerty::qwerty_manifest();
    assert_eq!(m.outputs.len(), N_QWERTY_JACKS);
    for c in "abcdefghijklmnopqrstuvwxyz0123456789".chars() {
        assert!(
            key_index(&c.to_string()).is_some(),
            "missing key jack for {c:?}"
        );
    }
    assert!(key_index("space").is_some());
    // Manifest order is the physical rows: number row first, then
    // q/a/z rows, space last.
    assert_eq!(m.outputs[0].id, "1");
    assert_eq!(m.outputs[10].id, "q");
    assert_eq!(m.outputs[20].id, "a");
    assert_eq!(m.outputs[29].id, "z");
    assert_eq!(m.outputs[36].id, "space");
    assert_eq!(KEYS.len(), N_QWERTY_JACKS);
}

#[test]
fn qwerty_node_round_trips_through_patch() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut engine = crate::common::default_engine();
        engine.add_module("kb1", "builtin.qwerty").unwrap();
        engine.add_module("adsr1", "com.dj.adsr").unwrap();
        engine.connect("kb1", "space", "adsr1", "gate").unwrap();
        engine.save_patch(dir.path(), "qwerty-roundtrip").unwrap();
    }
    let mut engine = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    let node = engine
        .nodes
        .iter()
        .find(|n| n.instance_id == "kb1")
        .expect("qwerty node survives save/load");
    assert_eq!(node.ext_id, "builtin.qwerty");
    // And it still accepts key events after the round trip.
    engine.qwerty_key("kb1", 0, "space", true).unwrap();
    engine.process_blocks(2).unwrap();
    assert_eq!(
        engine.tap("adsr1", "gate").unwrap().instantaneous,
        KEY_GATE_VOLTS
    );
}
