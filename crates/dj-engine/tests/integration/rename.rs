//! Module renaming: user-typed display names normalize into instance ids,
//! duplicates are rejected without side effects, wires/sync/macros survive,
//! and names round-trip through patch save/load.

use dj_engine::{normalize_module_name, Engine, EngineConfig, MacroInterface, MacroJack};

#[test]
fn normalization_rules() {
    assert_eq!(normalize_module_name("Wobble LFO"), "wobble_lfo");
    assert_eq!(normalize_module_name("  My   Osc!! 2 "), "my_osc_2");
    assert_eq!(normalize_module_name("lfo1"), "lfo1");
    assert_eq!(normalize_module_name("A/B"), "a_b"); // '/' is reserved
    assert_eq!(normalize_module_name("___"), "");
    assert_eq!(normalize_module_name(""), "");
}

#[test]
fn rename_normalizes_and_keeps_wires_and_state() {
    let mut engine = crate::common::default_engine();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    engine.connect("osc1", "audio", "vca1", "in").unwrap();
    engine.set_knob_position("vca1", "cv", 0.7).unwrap();

    let new_id = engine.rename_module("vca1", "Main VCA").unwrap();
    assert_eq!(new_id, "main_vca");

    // Old id gone, new id live, display name kept as typed.
    assert!(engine.tap("vca1", "in").is_err());
    let info = engine
        .nodes
        .iter()
        .find(|n| n.instance_id == "main_vca")
        .unwrap();
    assert_eq!(info.display_name.as_deref(), Some("Main VCA"));

    // Wires reference slots, so the connection (and knob state) survive.
    let doc = engine.snapshot("t");
    let wires: Vec<_> = doc.wires["osc1"].wires.clone();
    assert_eq!(wires.len(), 1);
    assert_eq!(wires[0].to, "main_vca");
    assert_eq!(doc.modules["main_vca"].name.as_deref(), Some("Main VCA"));
    let pos = engine.knob_state("main_vca", "cv").unwrap().position;
    assert!((pos - 0.7).abs() < 1e-6);

    // Renaming to exactly the normalized form stores no display name.
    let id2 = engine.rename_module("main_vca", "main_vca").unwrap();
    assert_eq!(id2, "main_vca");
    let info = engine
        .nodes
        .iter()
        .find(|n| n.instance_id == "main_vca")
        .unwrap();
    assert_eq!(info.display_name, None);
}

#[test]
fn duplicate_or_empty_rename_fails_without_side_effects() {
    let mut engine = crate::common::default_engine();
    engine.add_module("lfo1", "com.dj.lfo").unwrap();
    engine.add_module("lfo2", "com.dj.lfo").unwrap();
    let before = engine.snapshot("t");

    // Normalized collision: "LFO 1" -> "lfo_1" is fine, "LFO1" -> "lfo1" is
    // taken by the other module.
    let err = engine.rename_module("lfo2", "LFO1").unwrap_err();
    assert!(err.to_string().contains("already exists"), "{err}");
    // A name with no usable characters is rejected too.
    let err = engine.rename_module("lfo2", " !! ").unwrap_err();
    assert!(err.to_string().contains("no usable characters"), "{err}");
    // Unknown instance.
    assert!(engine.rename_module("nope", "x").is_err());

    // Nothing changed.
    assert_eq!(engine.snapshot("t"), before);

    // Renaming a module to its own current name (case/space variant) works.
    let id = engine.rename_module("lfo2", "LFO 2").unwrap();
    assert_eq!(id, "lfo_2");
    let id = engine.rename_module("lfo_2", "Lfo 2").unwrap();
    assert_eq!(id, "lfo_2");
}

#[test]
fn display_name_round_trips_through_save_load() {
    let dir = tempfile::tempdir().unwrap();
    let mut engine = crate::common::default_engine();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    engine.rename_module("osc1", "Bass Tone").unwrap();
    engine.save_patch(dir.path(), "t").unwrap();

    let loaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    let info = loaded
        .nodes
        .iter()
        .find(|n| n.instance_id == "bass_tone")
        .unwrap();
    assert_eq!(info.display_name.as_deref(), Some("Bass Tone"));
}

#[test]
fn rename_undo_redo_via_apply_doc() {
    let mut engine = crate::common::default_engine();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    let before = engine.snapshot("t");

    engine.rename_module("osc1", "Lead Osc").unwrap();
    let after = engine.snapshot("t");
    assert!(after.modules.contains_key("lead_osc"));

    engine.apply_doc(&before).unwrap();
    assert!(engine.snapshot("t").modules.contains_key("osc1"));
    engine.apply_doc(&after).unwrap();
    let redone = engine.snapshot("t");
    assert_eq!(redone.modules["lead_osc"].name.as_deref(), Some("Lead Osc"));
}

#[test]
fn deck_sync_partner_follows_rename() {
    let mut engine = crate::common::default_engine();
    engine.add_module("decka", "builtin.deck").unwrap();
    engine.add_module("deckb", "builtin.deck").unwrap();
    engine.deck_sync("deckb", Some("decka")).unwrap();

    engine.rename_module("decka", "Master Deck").unwrap();
    assert_eq!(
        engine.deck_sync_to("deckb").unwrap().as_deref(),
        Some("master_deck")
    );
    assert_eq!(
        engine.snapshot("t").modules["deckb"].sync_to.as_deref(),
        Some("master_deck")
    );
}

#[test]
fn macro_instance_rename_moves_internals_and_keeps_audio_paths() {
    let mut engine = {
        let config = EngineConfig::default();
        Engine::new(config, crate::common::registry()).unwrap()
    };
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    engine.connect("osc1", "audio", "vca1", "in").unwrap();
    engine
        .collapse_to_macro(
            &["osc1", "vca1"],
            "tone1",
            "macro.tone",
            "Tone",
            MacroInterface {
                inputs: vec![MacroJack {
                    id: "level".into(),
                    node: "vca1".into(),
                    jack: "cv".into(),
                }],
                outputs: vec![MacroJack {
                    id: "out".into(),
                    node: "vca1".into(),
                    jack: "out".into(),
                }],
                params: vec![],
            },
        )
        .unwrap();

    let new_id = engine.rename_module("tone1", "My Tone").unwrap();
    assert_eq!(new_id, "my_tone");

    // Internal nodes moved under the new prefix; external knob access
    // resolves through the renamed instance.
    assert!(engine.nodes.iter().any(|n| n.instance_id == "my_tone/osc1"));
    assert!(!engine
        .nodes
        .iter()
        .any(|n| n.instance_id.starts_with("tone1")));
    engine.set_knob_position("my_tone", "level", 0.8).unwrap();

    // Renaming a macro-internal node directly is rejected.
    assert!(engine.rename_module("my_tone/osc1", "x").is_err());

    // Snapshot persists the instance under its new id with the typed name.
    let doc = engine.snapshot("t");
    assert!(doc.modules.contains_key("my_tone"));
    assert_eq!(doc.modules["my_tone"].name.as_deref(), Some("My Tone"));
}
