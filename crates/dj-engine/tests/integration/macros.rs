//! Collapse-to-macro (PRD §6, M4 acceptance): collapse a selection to a
//! macro via API; instantiate it twice;every instance keeps its own copy of
//! the definition. The store-side verbs (pull/save/reset) and the
//! pre-store migration live in `macro_store.rs`.

use dj_engine::{Engine, EngineConfig, MacroInterface, MacroJack, MacroParam, PatchDoc};

const SR: f32 = 48_000.0;

fn mono_engine() -> Engine {
    let config = EngineConfig {
        master_channels: 1,
        ..EngineConfig::default()
    };
    Engine::new(config, crate::common::registry()).unwrap()
}

/// Osc -> VCA -> Audio Out; returns the engine (osc+vca are the collapse
/// candidates, out stays outside).
fn build_tone_patch(e: &mut Engine) {
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();
    e.set_knob_position("vca1", "cv", 0.5).unwrap();
}

/// The standard interface for collapsing osc1+vca1 into a "tone" macro.
fn tone_interface() -> MacroInterface {
    MacroInterface {
        inputs: vec![
            MacroJack {
                id: "pitch".into(),
                node: "osc1".into(),
                jack: "pitch".into(),
            },
            MacroJack {
                id: "level".into(),
                node: "vca1".into(),
                jack: "cv".into(),
            },
        ],
        outputs: vec![MacroJack {
            id: "out".into(),
            node: "vca1".into(),
            jack: "out".into(),
        }],
        params: vec![],
    }
}

/// Knob position of the oscillator's waveform input for a given waveform
/// index (stepped knob, linear 0..3).
fn wave_pos(waveform: f32) -> f32 {
    waveform / 3.0
}

fn render(e: &mut Engine, secs: f32) -> Vec<f32> {
    e.render_offline((secs * SR) as usize)
        .unwrap()
        .into_iter()
        .next()
        .unwrap()
}

fn peak(xs: &[f32]) -> f32 {
    xs.iter().fold(0.0f32, |m, &x| m.max(x.abs()))
}

#[test]
fn collapsed_macro_renders_identically_to_the_flat_patch() {
    let mut flat = mono_engine();
    build_tone_patch(&mut flat);
    let golden = render(&mut flat, 0.25);
    assert!(peak(&golden) > 1.0, "flat patch should be audible");

    let mut e = mono_engine();
    build_tone_patch(&mut e);
    let def = e
        .collapse_to_macro(
            &["osc1", "vca1"],
            "tone1",
            "macro.tone",
            "Tone",
            tone_interface(),
        )
        .unwrap();
    assert_eq!(def.modules.len(), 2);
    // Internal wire (osc->vca) lives in the def; boundary wire got
    // rewritten to the instance's external jack.
    assert_eq!(def.wires["osc1"].wires.len(), 1);
    assert!(e.macro_instances().contains_key("tone1"));
    assert!(e.nodes.iter().any(|n| n.instance_id == "tone1/osc1"));

    let collapsed = render(&mut e, 0.25);
    assert_eq!(golden, collapsed, "collapse changed the audio");
}

/// Removing a macro instance incrementally removes every expanded internal
/// node plus the instance record; the rest of the patch is untouched.
#[test]
fn remove_module_takes_a_whole_macro_instance_with_its_internals() {
    let mut e = mono_engine();
    build_tone_patch(&mut e);
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone-rm",
        "Tone",
        tone_interface(),
    )
    .unwrap();
    e.add_module("lfo1", "com.dj.lfo").unwrap();
    assert!(e.nodes.iter().any(|n| n.instance_id == "tone1/osc1"));

    e.remove_module("tone1").unwrap();
    assert!(!e.macro_instances().contains_key("tone1"));
    assert!(e.nodes.iter().all(|n| !n.instance_id.starts_with("tone1/")));
    // Boundary wire (tone1 -> out1) went with it; bystanders remain.
    assert!(e.wire_specs().is_empty());
    assert!(e.nodes.iter().any(|n| n.instance_id == "lfo1"));
    assert!(e.nodes.iter().any(|n| n.instance_id == "out1"));
    render(&mut e, 0.05); // still renders

    // Internal nodes are not directly removable.
    e.add_module("tone2", "macro.tone-rm").unwrap();
    assert!(e.remove_module("tone2/osc1").is_err());
}

/// Reset on a macro instance targets the definition's saved state — what a
/// fresh instantiation would give — not the raw manifest defaults.
#[test]
fn reset_on_a_macro_instance_restores_the_definition_state() {
    let mut e = mono_engine();
    build_tone_patch(&mut e); // saves vca1 cv at position 0.5 into the def
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone-reset",
        "Tone",
        tone_interface(),
    )
    .unwrap();

    // Knob reset on the external jack: back to the def's saved 0.5.
    e.set_knob_position("tone1", "level", 0.9).unwrap();
    e.set_knob_atten_offset("tone1", "level", -0.5, 2.0)
        .unwrap();
    e.reset_knob("tone1", "level").unwrap();
    let s = e.knob_state("tone1", "level").unwrap();
    assert_eq!(s.position, 0.5);
    assert_eq!((s.atten, s.offset), (1.0, 0.0));

    // Module-wide reset: every internal knob back to the def's state.
    e.set_knob_position("tone1", "level", 0.9).unwrap();
    e.set_knob_position("tone1", "pitch", 1.0).unwrap();
    e.reset_module("tone1").unwrap();
    assert_eq!(e.knob_state("tone1", "level").unwrap().position, 0.5);
    // pitch was at its manifest default when collapsed (0 on -5..5 => 0.5).
    assert_eq!(e.knob_state("tone1", "pitch").unwrap().position, 0.5);
    // Non-structural: internals and the instance record survive.
    assert!(e.macro_instances().contains_key("tone1"));
    assert!(e.nodes.iter().any(|n| n.instance_id == "tone1/osc1"));
}

/// Every instance owns the definition it adopted: editing the base leaves
/// live instances alone, and adopting it again gives the second instance a
/// different copy — both live side by side in one patch and survive a
/// round-trip (the "v1 and v2 in the same patch" case).
#[test]
fn instances_keep_the_copy_they_adopted_when_the_base_changes() {
    let mut e = mono_engine();
    build_tone_patch(&mut e);
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone",
        "Tone",
        tone_interface(),
    )
    .unwrap();
    let adopted = e.knob_state("tone1/osc1", "waveform").unwrap().position;

    // The base moves on to a square wave; the live instance must not.
    let mut next = e.macros.get("macro.tone").unwrap().clone();
    next.modules
        .get_mut("osc1")
        .unwrap()
        .knobs
        .get_mut("waveform")
        .unwrap()
        .position = wave_pos(2.0);
    e.register_macro(next);
    assert_eq!(
        e.knob_state("tone1/osc1", "waveform").unwrap().position,
        adopted,
        "an existing instance followed a base edit"
    );

    // A fresh instance adopts the current base instead.
    e.add_module("tone2", "macro.tone").unwrap();
    e.connect("tone2", "out", "out1", "l").unwrap();
    let second = e.knob_state("tone2/osc1", "waveform").unwrap().position;
    assert!((second - wave_pos(2.0)).abs() < 1e-6);
    assert_ne!(adopted, second);

    // Both copies are in the patch, one file per instance.
    let dir = tempfile::tempdir().unwrap();
    e.save_patch(dir.path(), "two-copies").unwrap();
    let doc = PatchDoc::read(dir.path()).unwrap();
    assert_eq!(doc.macros["tone1"].def.id, "macro.tone");
    assert_eq!(doc.macros["tone2"].def.id, "macro.tone");
    assert_ne!(doc.macros["tone1"].def, doc.macros["tone2"].def);

    let loaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    assert_eq!(
        loaded
            .knob_state("tone1/osc1", "waveform")
            .unwrap()
            .position,
        adopted
    );
    assert_eq!(
        loaded
            .knob_state("tone2/osc1", "waveform")
            .unwrap()
            .position,
        second
    );
}

#[test]
fn macro_patches_roundtrip_save_load_byte_stable() {
    let dir = tempfile::tempdir().unwrap();
    let golden;
    {
        let mut e = mono_engine();
        build_tone_patch(&mut e);
        e.collapse_to_macro(
            &["osc1", "vca1"],
            "tone1",
            "macro.tone",
            "Tone",
            tone_interface(),
        )
        .unwrap();
        golden = render(&mut e, 0.25);
        e.save_patch(dir.path(), "macro-patch").unwrap();
    }
    // The instance's own copy of the definition rides in the patch tree.
    assert!(dir.path().join("macros/tone1.json").exists());
    assert!(dir.path().join("modules/tone1.json").exists());
    assert!(
        !dir.path().join("modules/tone1/osc1.json").exists()
            && std::fs::read_dir(dir.path().join("modules"))
                .unwrap()
                .count()
                == 2,
        "internal nodes must not leak into the patch"
    );

    let mut loaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    assert!(loaded.macro_instances().contains_key("tone1"));
    assert_eq!(render(&mut loaded, 0.25), golden);

    // Re-saving the loaded patch is byte-stable.
    let dir2 = tempfile::tempdir().unwrap();
    loaded.save_patch(dir2.path(), "macro-patch").unwrap();
    for sub in ["patch.json", "modules/tone1.json", "modules/out1.json"] {
        let a = std::fs::read_to_string(dir.path().join(sub)).unwrap();
        let b = std::fs::read_to_string(dir2.path().join(sub)).unwrap();
        assert_eq!(a, b, "{sub} not byte-stable");
    }
}

/// Macros are flat: a selection containing a macro instance cannot be
/// collapsed, and a definition that references another macro is refused at
/// expansion.
#[test]
fn macros_may_not_nest() {
    let mut e = mono_engine();
    build_tone_patch(&mut e);
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone",
        "Tone",
        tone_interface(),
    )
    .unwrap();
    e.add_module("vca2", "com.dj.vca").unwrap();
    e.disconnect("tone1", "out", "out1", "l").unwrap();
    e.connect("tone1", "out", "vca2", "in").unwrap();
    e.connect("vca2", "out", "out1", "l").unwrap();

    let err = e
        .collapse_to_macro(
            &["tone1", "vca2"],
            "duo1",
            "macro.duo",
            "Duo",
            MacroInterface {
                inputs: vec![],
                outputs: vec![MacroJack {
                    id: "out".into(),
                    node: "vca2".into(),
                    jack: "out".into(),
                }],
                params: vec![],
            },
        )
        .unwrap_err();
    assert!(
        format!("{err:#}").contains("may not nest"),
        "unexpected error: {err:#}"
    );
    assert!(e.macros.get("macro.duo").is_none());
    assert!(e.macro_instances().contains_key("tone1"));

    // A hand-written definition nesting another macro is refused too.
    let mut nested = e.macros.get("macro.tone").unwrap().clone();
    nested.id = "macro.nested".into();
    nested.modules.insert(
        "inner".into(),
        dj_engine::patch::ModuleFile {
            ext: "macro.tone".into(),
            name: None,
            knobs: Default::default(),
            params: Default::default(),
            midi_mappings: Vec::new(),
            midi_led_mappings: Vec::new(),
            choreo: None,
            decks: None,
            track: None,
            clip: None,
            sync_to: None,
            bypassed: false,
        },
    );
    e.register_macro(nested);
    let err = e.add_module("nest1", "macro.nested").unwrap_err();
    assert!(
        format!("{err:#}").contains("may not nest"),
        "unexpected error: {err:#}"
    );
}

#[test]
fn boundary_wires_must_use_promoted_jacks() {
    let mut e = mono_engine();
    build_tone_patch(&mut e);
    // Interface without the vca "out" promotion: the vca1->out1 boundary
    // wire has nowhere to go.
    let bad = MacroInterface {
        inputs: vec![],
        outputs: vec![],
        params: vec![],
    };
    let err = e
        .collapse_to_macro(&["osc1", "vca1"], "tone1", "macro.bad", "Bad", bad)
        .unwrap_err();
    assert!(
        format!("{err:#}").contains("promoted"),
        "unexpected error: {err:#}"
    );
    // Failed collapse must not leave a half-registered macro behind.
    assert!(e.macros.get("macro.bad").is_none());
}

#[test]
fn promoted_params_and_macro_manifest_work() {
    let mut e = mono_engine();
    build_tone_patch(&mut e);
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone",
        "Tone",
        tone_interface(),
    )
    .unwrap();

    // Promoted params come from modules that still carry real params
    // (mode-style toggles like the deck's keylock) — all WASM module
    // controls are knob-backed inputs and get promoted as jacks instead.
    e.add_module("deck1", "builtin.deck").unwrap();
    e.collapse_to_macro(
        &["deck1"],
        "deckm1",
        "macro.deck",
        "Deck Macro",
        MacroInterface {
            inputs: vec![],
            outputs: vec![MacroJack {
                id: "out".into(),
                node: "deck1".into(),
                jack: "audio_l".into(),
            }],
            params: vec![MacroParam {
                id: "keylock".into(),
                node: "deck1".into(),
                param: "keylock".into(),
            }],
        },
    )
    .unwrap();

    // Promoted param routes to the internal node.
    e.set_param("deckm1", "keylock", 1.0).unwrap();
    let info = e
        .nodes
        .iter()
        .find(|n| n.instance_id == "deckm1/deck1")
        .unwrap();
    assert_eq!(info.params["keylock"], 1.0);
    let dm = e.macro_manifest("macro.deck").unwrap();
    assert_eq!(dm.params[0].id, "keylock");

    // Synthesized manifest exposes the external interface for UIs.
    let m = e.macro_manifest("macro.tone").unwrap();
    assert_eq!(m.abi, "macro-1");
    assert_eq!(
        m.inputs.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
        vec!["pitch", "level"]
    );
    assert_eq!(m.outputs[0].id, "out");

    // Promoted input is wireable like any jack: modulate level externally.
    e.add_module("osc2", "com.dj.oscillator").unwrap();
    e.connect("osc2", "audio", "tone1", "level").unwrap();
    let out = render(&mut e, 0.25);
    assert!(peak(&out) > 0.0);
}

/// Break-macro (the UI's right-click "Break Macro"): internals become
/// ordinary top-level modules in place — same wires, same DSP state, audio
/// byte-identical — and the instance record dissolves. The definition
/// stays registered.
#[test]
fn break_macro_lifts_internals_to_top_level_without_audio_change() {
    let mut e = mono_engine();
    build_tone_patch(&mut e);
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone-brk",
        "Tone",
        tone_interface(),
    )
    .unwrap();
    let golden = render(&mut e, 0.25);
    assert!(peak(&golden) > 1.0);

    let renames = e.break_macro("tone1").unwrap();
    assert_eq!(renames["tone1/osc1"], "osc1");
    assert_eq!(renames["tone1/vca1"], "vca1");
    assert!(!e.macro_instances().contains_key("tone1"));
    assert!(e.nodes.iter().all(|n| !n.instance_id.contains('/')));
    assert!(e.macros.get("macro.tone-brk").is_some());

    // Same graph, same audio (DSP state was reset by neither collapse nor
    // break — compare a fresh flat render at the same point in time).
    let mut flat = mono_engine();
    build_tone_patch(&mut flat);
    render(&mut flat, 0.25);
    assert_eq!(render(&mut flat, 0.25), render(&mut e, 0.25));

    // Post-break snapshot round-trips as a plain flat patch.
    let doc = e.snapshot("broken");
    assert!(doc.modules.contains_key("osc1"));
    assert!(
        doc.macros.is_empty(),
        "no instance copies left after a break"
    );
    let mut reloaded = Engine::from_doc(&doc, crate::common::registry()).unwrap();
    let mut flat2 = mono_engine();
    build_tone_patch(&mut flat2);
    assert_eq!(render(&mut flat2, 0.25), render(&mut reloaded, 0.25));
}

/// Breaking a macro renames internals that would collide with existing
/// top-level ids.
#[test]
fn break_macro_avoids_collisions() {
    let mut e = mono_engine();
    build_tone_patch(&mut e);
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone-brk2",
        "Tone",
        tone_interface(),
    )
    .unwrap();
    // A top-level module that will collide with the lifted internal.
    e.add_module("osc1", "com.dj.oscillator").unwrap();

    let renames = e.break_macro("tone1").unwrap();
    let lifted_osc = &renames["tone1/osc1"];
    assert_ne!(lifted_osc, "osc1");
    assert!(!lifted_osc.contains('/'));
    assert!(e.nodes.iter().any(|n| &n.instance_id == lifted_osc));
    assert!(e.macro_instances().is_empty());
    // Wire endpoints survived the renames: still renders.
    assert!(peak(&render(&mut e, 0.25)) > 0.0);
}

/// Definition positions: UI passthrough metadata on the def (saved and
/// loaded with it) exposed per fresh instance through macro_layout.
#[test]
fn macro_positions_persist_through_macro_layout() {
    let mut e = mono_engine();
    build_tone_patch(&mut e);
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone-pos",
        "Tone",
        tone_interface(),
    )
    .unwrap();
    let def = e
        .set_macro_positions(
            "macro.tone-pos",
            [
                ("osc1".to_string(), (0.0, 0.0)),
                ("vca1".to_string(), (180.0, 20.0)),
            ]
            .into(),
        )
        .unwrap();
    assert_eq!(def.positions.len(), 2);

    let layout = e.macro_layout("macro.tone-pos").unwrap();
    assert_eq!(layout["osc1"], (0.0, 0.0));
    assert_eq!(layout["vca1"], (180.0, 20.0));

    // Positions live on the base, so they survive a rebuild that carries
    // the library (patches themselves hold per-instance copies only).
    let doc = e.snapshot("pos");
    let e2 =
        Engine::from_doc_with_macros(&doc, crate::common::registry(), e.macros.clone()).unwrap();
    assert_eq!(
        e2.macro_layout("macro.tone-pos").unwrap()["vca1"],
        (180.0, 20.0)
    );
}

/// macro_preview — the picker-thumbnail view of a definition: internal
/// nodes with their manifests, definition-saved knobs and saved positions,
/// read purely from the definition (no instance).
#[test]
fn macro_preview_exposes_internal_nodes() {
    let mut e = mono_engine();
    build_tone_patch(&mut e);
    // The collapsed vca carries a non-default knob (cv @ 0.5, set by
    // build_tone_patch) that the preview must surface.
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone-prev",
        "Tone",
        tone_interface(),
    )
    .unwrap();
    e.set_macro_positions(
        "macro.tone-prev",
        [
            ("osc1".to_string(), (0.0, 0.0)),
            ("vca1".to_string(), (180.0, 20.0)),
        ]
        .into(),
    )
    .unwrap();

    let preview = e.macro_preview("macro.tone-prev").unwrap();
    assert_eq!(preview.len(), 2);
    let osc = preview.iter().find(|n| n.id == "osc1").unwrap();
    assert_eq!(osc.ext, "com.dj.oscillator");
    assert_eq!(osc.manifest.id, "com.dj.oscillator");
    assert_eq!(osc.position, Some((0.0, 0.0)));
    let vca = preview.iter().find(|n| n.id == "vca1").unwrap();
    assert_eq!(vca.position, Some((180.0, 20.0)));
    assert_eq!(vca.knobs["cv"].position, 0.5);

    assert!(e.macro_preview("macro.nope").is_err());
}

/// Breaking an instance dissolves the grouping but must leave the macro
/// DEFINITION registered and instantiable (PRD §6: macros live in the
/// library, instances are just uses).
#[test]
fn breaking_an_instance_leaves_the_definition_available() {
    let mut e = mono_engine();
    build_tone_patch(&mut e);
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone",
        "Tone",
        tone_interface(),
    )
    .unwrap();
    e.break_macro("tone1").unwrap();
    assert!(e.macro_instances().is_empty());
    assert!(e.macros.get("macro.tone").is_some(), "definition lost");
    // Still instantiable.
    e.add_module("tone2", "macro.tone").unwrap();
    assert!(e.macro_instances().contains_key("tone2"));
}

/// Renaming a macro changes the base's display name under its stable id.
/// Live instances keep the name they adopted until they pull.
#[test]
fn rename_macro_changes_the_base_name() {
    let mut e = mono_engine();
    build_tone_patch(&mut e);
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone",
        "Tone",
        tone_interface(),
    )
    .unwrap();
    let def = e.rename_macro("macro.tone", "Fat Tone").unwrap();
    assert_eq!(def.id, "macro.tone");
    assert_eq!(def.name, "Fat Tone");
    assert_eq!(e.macros.get("macro.tone").unwrap().name, "Fat Tone");
    assert_eq!(e.macro_instances()["tone1"].def.name, "Tone");
    // Internals untouched: still renders.
    assert!(peak(&render(&mut e, 0.1)) > 1.0);
    assert!(e.rename_macro("macro.tone", "  ").is_err());
    assert!(e.rename_macro("macro.nope", "X").is_err());
}

/// unregister_macro removes the definition; instantiation then fails.
#[test]
fn unregister_macro_removes_the_definition() {
    let mut e = mono_engine();
    build_tone_patch(&mut e);
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone",
        "Tone",
        tone_interface(),
    )
    .unwrap();
    e.break_macro("tone1").unwrap();
    assert!(e.unregister_macro("macro.tone").is_some());
    assert!(e.unregister_macro("macro.tone").is_none());
    assert!(e.add_module("tone2", "macro.tone").is_err());
}

/// recollapse_macro overwrites the base under its stable id. The instance
/// it was saved from adopts the new definition; other live instances keep
/// the copy they already had.
#[test]
fn recollapse_overwrites_the_base_and_leaves_other_instances_alone() {
    let mut e = mono_engine();
    build_tone_patch(&mut e);
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone",
        "Tone",
        tone_interface(),
    )
    .unwrap();

    // A second, louder selection to save over the same name.
    e.add_module("osc2", "com.dj.oscillator").unwrap();
    e.add_module("vca2", "com.dj.vca").unwrap();
    e.connect("osc2", "audio", "vca2", "in").unwrap();
    e.set_knob_position("vca2", "cv", 1.0).unwrap();
    let interface = MacroInterface {
        inputs: vec![MacroJack {
            id: "level".into(),
            node: "vca2".into(),
            jack: "cv".into(),
        }],
        outputs: vec![MacroJack {
            id: "out".into(),
            node: "vca2".into(),
            jack: "out".into(),
        }],
        params: vec![],
    };
    let def = e
        .recollapse_macro(&["osc2", "vca2"], "tone2", "macro.tone", "Tone", interface)
        .unwrap();
    assert_eq!(def.id, "macro.tone");
    assert_eq!(e.macros.get("macro.tone"), Some(&def));
    // No scratch artifacts left behind.
    assert_eq!(e.macros.list().len(), 1);

    // The saved-from instance runs the new internals...
    assert!(e.nodes.iter().any(|n| n.instance_id == "tone2/osc2"));
    // ...and the older instance still runs the copy it adopted.
    assert!(e.nodes.iter().any(|n| n.instance_id == "tone1/osc1"));
    assert!(e.nodes.iter().all(|n| n.instance_id != "tone1/osc2"));
    assert_ne!(e.macro_instances()["tone1"].def, def);
    render(&mut e, 0.05);

    assert!(e
        .recollapse_macro(
            &["nope"],
            "x1",
            "macro.nope",
            "Nope",
            MacroInterface::default()
        )
        .is_err());
}

/// Undo of a macro-instance delete restores the WHOLE instance — expanded
/// members, boundary wires, per-instance knob state AND the members' rack
/// layout (positions travel per `/`-prefixed member id in PatchDoc::layout).
#[test]
fn undo_of_macro_delete_restores_members_wires_and_layout() {
    let mut e = mono_engine();
    build_tone_patch(&mut e);
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone-undo",
        "Tone",
        tone_interface(),
    )
    .unwrap();
    e.set_module_position("tone1/osc1", (96.0, 48.0)).unwrap();
    e.set_module_position("tone1/vca1", (336.0, 48.0)).unwrap();
    e.set_knob_position("tone1", "level", 0.8).unwrap();

    let mut h = dj_engine::UndoHistory::new();
    h.record("remove:tone1", e.snapshot("t"));
    e.remove_module("tone1").unwrap();
    assert!(!e.macro_instances().contains_key("tone1"));
    assert!(
        e.snapshot("t").layout.is_empty(),
        "members' layout went too"
    );

    let doc = h.undo(e.snapshot("t")).unwrap();
    e.apply_doc(&doc).unwrap();
    assert!(e.macro_instances().contains_key("tone1"));
    assert_eq!(e.module_position("tone1/osc1"), Some((96.0, 48.0)));
    assert_eq!(e.module_position("tone1/vca1"), Some((336.0, 48.0)));
    // Internal + boundary wires and promoted knob state came back whole.
    assert_eq!(e.wire_specs().len(), 2);
    assert_eq!(e.knob_state("tone1", "level").unwrap().position, 0.8);
    assert!(peak(&render(&mut e, 0.1)) > 0.0, "audible again after undo");
}

/// Collapsing keeps the members' on-screen spots: layout entries follow the
/// rename to `/`-prefixed member ids through the collapse rebuild.
#[test]
fn collapse_carries_member_layout_to_prefixed_ids() {
    let mut e = mono_engine();
    build_tone_patch(&mut e);
    e.set_module_position("osc1", (0.0, 0.0)).unwrap();
    e.set_module_position("vca1", (240.0, 0.0)).unwrap();
    e.set_module_position("out1", (480.0, 0.0)).unwrap();
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone-layout",
        "Tone",
        tone_interface(),
    )
    .unwrap();
    assert_eq!(e.module_position("tone1/osc1"), Some((0.0, 0.0)));
    assert_eq!(e.module_position("tone1/vca1"), Some((240.0, 0.0)));
    assert_eq!(e.module_position("out1"), Some((480.0, 0.0)));
}
