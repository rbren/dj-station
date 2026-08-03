//! Collapse-to-macro (PRD §6, M4 acceptance): collapse a selection to a
//! macro via API; instantiate it twice; edit internals; both instances
//! reflect the change; version-mismatch prompt logic covered by tests.

mod common;

use dj_engine::{
    Engine, EngineConfig, MacroInterface, MacroJack, MacroParam, MacroResolution, PatchDoc,
};

const SR: f32 = 48_000.0;

fn mono_engine() -> Engine {
    let config = EngineConfig {
        master_channels: 1,
        ..EngineConfig::default()
    };
    Engine::new(config, common::registry()).unwrap()
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
    assert_eq!(def.version, 1);
    assert_eq!(def.modules.len(), 2);
    // Internal wire (osc->vca) lives in the def; boundary wire got
    // rewritten to the instance's external jack.
    assert_eq!(def.wires["osc1"].wires.len(), 1);
    assert!(e.macro_instances().contains_key("tone1"));
    assert!(e.nodes.iter().any(|n| n.instance_id == "tone1/osc1"));

    let collapsed = render(&mut e, 0.25);
    assert_eq!(golden, collapsed, "collapse changed the audio");
}

#[test]
fn instantiate_twice_and_edit_internals_updates_both_instances() {
    // Build, collapse, then wire TWO instances of the macro to the output.
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
    e.add_module("tone2", "macro.tone").unwrap();
    e.connect("tone2", "out", "out1", "l").unwrap();
    assert_eq!(
        e.macro_instances().len(),
        2,
        "two instances: {:?}",
        e.macro_instances().keys()
    );

    // Per-instance state: drop instance 2's level so the mix is
    // distinguishable from a doubled instance 1.
    e.set_knob_position("tone2", "level", 0.25).unwrap();
    let before = render(&mut e, 0.25);
    assert!(peak(&before) > 1.0);

    // Edit the macro's internals: version 2 halves the internal VCA level.
    let mut def2 = def.clone();
    def2.version = 2;
    def2.modules
        .get_mut("vca1")
        .unwrap()
        .knobs
        .get_mut("cv")
        .unwrap()
        .position = 0.25;
    e.update_macro(def2).unwrap();

    // Both instances reflect the change...
    for inst in ["tone1", "tone2"] {
        let mi = &e.macro_instances()[inst];
        assert_eq!(mi.version, 2, "{inst} still at version {}", mi.version);
    }
    // ...but *instance-level* promoted knob state survives the update:
    // the "level" knob was promoted, so each instance keeps its own value
    // (tone1 at 0.5, tone2 at 0.25) rather than adopting the def's 0.25.
    let k1 = e.knob_state("tone1", "level").unwrap();
    let k2 = e.knob_state("tone2", "level").unwrap();
    assert_eq!(k1.position, 0.5);
    assert_eq!(k2.position, 0.25);

    // A non-promoted internal edit *does* propagate to both instances:
    // change the internal waveform knob on one def edit instead.
    let mut def3 = e.macros.get("macro.tone").unwrap().clone();
    def3.version = 3;
    def3.modules
        .get_mut("osc1")
        .unwrap()
        .knobs
        .get_mut("waveform")
        .unwrap()
        .position = wave_pos(2.0); // square
    e.update_macro(def3).unwrap();
    let after = render(&mut e, 0.25);
    assert_ne!(before, after, "internal edit must change every instance");
    // Square wave has a higher RMS than sine at the same peak; both
    // instances switching waveform is audible in the mix.
    for inst in ["tone1", "tone2"] {
        assert_eq!(e.macro_instances()[inst].version, 3);
        let node = format!("{inst}/osc1");
        let k = e.knob_state(&node, "waveform").unwrap();
        assert!(
            (k.position - wave_pos(2.0)).abs() < 1e-6,
            "{inst} waveform not updated"
        );
    }
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
    // The macro definition is embedded in the patch tree.
    assert!(dir.path().join("macros/macro.tone.json").exists());
    assert!(dir.path().join("modules/tone1.json").exists());
    assert!(
        !dir.path().join("modules/tone1/osc1.json").exists()
            && std::fs::read_dir(dir.path().join("modules"))
                .unwrap()
                .count()
                == 2,
        "internal nodes must not leak into the patch"
    );

    let mut loaded = Engine::load_patch(dir.path(), common::registry()).unwrap();
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

#[test]
fn version_mismatch_prompt_logic_update_and_fork() {
    // Save a patch with macro v1, then bump the library to v2 (louder
    // internals). Loading must surface a conflict with both resolutions.
    let dir = tempfile::tempdir().unwrap();
    let v1_sound;
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
        v1_sound = render(&mut e, 0.25);
        e.save_patch(dir.path(), "macro-patch").unwrap();
    }

    // The library has since moved to v2 with a different waveform.
    let mut lib = dj_engine::MacroLibrary::default();
    {
        let doc = PatchDoc::read(dir.path()).unwrap();
        let mut def2 = doc.macros["macro.tone"].clone();
        def2.version = 2;
        def2.modules
            .get_mut("osc1")
            .unwrap()
            .knobs
            .get_mut("waveform")
            .unwrap()
            .position = wave_pos(1.0); // saw
        lib.register(def2);
    }

    // 1. Conflict detection.
    let doc = PatchDoc::read(dir.path()).unwrap();
    let conflicts = doc.macro_conflicts(&lib);
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].macro_id, "macro.tone");
    assert_eq!(conflicts[0].patch_version, 1);
    assert_eq!(conflicts[0].library_version, 2);

    // 2. Resolution: UPDATE -> instances adopt the library definition.
    let mut doc_up = doc.clone();
    doc_up
        .resolve_macro_conflict("macro.tone", &MacroResolution::UpdateToLibrary, &mut lib)
        .unwrap();
    assert!(doc_up.macro_conflicts(&lib).is_empty());
    let mut updated =
        Engine::from_doc_with_macros(&doc_up, common::registry(), lib.clone()).unwrap();
    assert_eq!(updated.macro_instances()["tone1"].version, 2);
    let updated_sound = render(&mut updated, 0.25);
    assert_ne!(updated_sound, v1_sound, "update must adopt v2 internals");

    // 3. Resolution: FORK -> patch keeps its saved sound under a new id;
    //    the fork lands in the library at version 1.
    let mut doc_fork = doc.clone();
    doc_fork
        .resolve_macro_conflict(
            "macro.tone",
            &MacroResolution::Fork {
                new_id: "macro.tone-fork".into(),
            },
            &mut lib,
        )
        .unwrap();
    assert!(doc_fork.macro_conflicts(&lib).is_empty());
    assert_eq!(lib.get("macro.tone-fork").unwrap().version, 1);
    assert_eq!(lib.get("macro.tone").unwrap().version, 2);
    assert_eq!(doc_fork.modules["tone1"].ext, "macro.tone-fork");
    let mut forked =
        Engine::from_doc_with_macros(&doc_fork, common::registry(), lib.clone()).unwrap();
    assert_eq!(
        forked.macro_instances()["tone1"].macro_id,
        "macro.tone-fork"
    );
    let forked_sound = render(&mut forked, 0.25);
    assert_eq!(forked_sound, v1_sound, "fork must keep the saved sound");

    // 4. No conflict when versions match.
    let doc_clean = PatchDoc::read(dir.path()).unwrap();
    let mut same_lib = dj_engine::MacroLibrary::default();
    same_lib.register(doc_clean.macros["macro.tone"].clone());
    assert!(doc_clean.macro_conflicts(&same_lib).is_empty());
}

#[test]
fn macros_nest_arbitrarily() {
    // Collapse osc+vca -> macro.tone; then collapse [tone1] + a second vca
    // -> macro.duo (a macro containing a macro instance).
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
    e.set_knob_position("vca2", "cv", 1.0).unwrap();
    let flat = render(&mut e, 0.25);
    assert!(peak(&flat) > 1.0);

    let outer_interface = MacroInterface {
        inputs: vec![MacroJack {
            id: "trim".into(),
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
    e.collapse_to_macro(
        &["tone1", "vca2"],
        "duo1",
        "macro.duo",
        "Duo",
        outer_interface,
    )
    .unwrap();
    assert!(e.macro_instances().contains_key("duo1"));
    assert!(
        e.macro_instances().contains_key("duo1/tone1"),
        "nested instance missing: {:?}",
        e.macro_instances().keys()
    );
    assert!(e.nodes.iter().any(|n| n.instance_id == "duo1/tone1/osc1"));
    assert_eq!(render(&mut e, 0.25), flat, "nesting changed the audio");

    // Editing the INNER macro propagates through the outer instance.
    let mut inner2 = e.macros.get("macro.tone").unwrap().clone();
    inner2.version = 2;
    inner2
        .modules
        .get_mut("osc1")
        .unwrap()
        .knobs
        .get_mut("waveform")
        .unwrap()
        .position = wave_pos(2.0);
    e.update_macro(inner2).unwrap();

    // Save before rendering: update_macro rebuilt the engine (fresh
    // oscillator phase), so the first post-edit render is comparable with
    // a freshly loaded engine's first render.
    let dir = tempfile::tempdir().unwrap();
    e.save_patch(dir.path(), "nested").unwrap();
    assert!(dir.path().join("macros/macro.duo.json").exists());
    assert!(dir.path().join("macros/macro.tone.json").exists());

    let edited = render(&mut e, 0.25);
    assert_ne!(edited, flat, "inner edit must propagate");

    // And a nested-macro patch round-trips.
    let mut loaded = Engine::load_patch(dir.path(), common::registry()).unwrap();
    assert_eq!(render(&mut loaded, 0.25), edited);
}

#[test]
fn macro_defs_roundtrip_through_the_sqlite_library_store() {
    // Collapse -> persist the def to the library DB (as the app does) ->
    // fresh engine seeds its macro library from the DB -> instantiate.
    let dir = tempfile::tempdir().unwrap();
    let lib = dj_library::Library::open(dir.path()).unwrap();

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
    let sound = render(&mut e, 0.25);
    lib.save_macro(&dj_library::MacroRecord {
        id: def.id.clone(),
        name: def.name.clone(),
        version: def.version as i64,
        definition: serde_json::to_string(&def).unwrap(),
    })
    .unwrap();

    // A brand-new engine, seeded only from the DB, can instantiate it.
    let mut fresh = mono_engine();
    for rec in lib.macros().unwrap() {
        let def: dj_engine::MacroDef = serde_json::from_str(&rec.definition).unwrap();
        fresh.register_macro(def);
    }
    fresh.add_module("t1", "macro.tone").unwrap();
    fresh.add_module("out1", "builtin.audio_out").unwrap();
    fresh.connect("t1", "out", "out1", "l").unwrap();
    assert_eq!(render(&mut fresh, 0.25), sound);
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
