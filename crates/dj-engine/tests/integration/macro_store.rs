//! The global macro store (`<data_dir>/macros/<id>.json`, sibling of
//! `patches/`) and the three per-instance verbs it feeds: *pull latest*,
//! *save macro*, *reset to defaults* — plus the migration of patches that
//! embedded one shared definition per macro id.

use dj_engine::{Engine, EngineConfig, MacroInterface, MacroJack, MacroStore, PatchDoc};

const SR: f32 = 48_000.0;

fn mono_engine() -> Engine {
    let config = EngineConfig {
        master_channels: 1,
        ..EngineConfig::default()
    };
    Engine::new(config, crate::common::registry()).unwrap()
}

fn tone_interface() -> MacroInterface {
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
    }
}

/// Osc -> VCA -> Out, with osc1+vca1 collapsed into `macro.tone`.
fn tone_engine() -> Engine {
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();
    e.set_knob_position("vca1", "cv", 0.5).unwrap();
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone",
        "Tone",
        tone_interface(),
    )
    .unwrap();
    e
}

fn render(e: &mut Engine, secs: f32) -> Vec<f32> {
    e.render_offline((secs * SR) as usize)
        .unwrap()
        .into_iter()
        .next()
        .unwrap()
}

#[test]
fn store_publishes_definitions_as_one_file_per_macro() {
    let dir = tempfile::tempdir().unwrap();
    let store = MacroStore::new(dir.path().join("macros"));
    assert!(
        store.load().unwrap().defs.is_empty(),
        "missing dir is empty"
    );

    let mut e = tone_engine();
    let def = e.macros.get("macro.tone").unwrap().clone();
    store.save(&def).unwrap();
    assert!(dir.path().join("macros/macro.tone.json").is_file());

    // A fresh engine seeded from the store can instantiate it.
    let mut fresh = mono_engine();
    for def in store.load().unwrap().defs.into_values() {
        fresh.register_macro(def);
    }
    fresh.add_module("t1", "macro.tone").unwrap();
    fresh.add_module("out1", "builtin.audio_out").unwrap();
    fresh.connect("t1", "out", "out1", "l").unwrap();
    assert_eq!(render(&mut fresh, 0.25), render(&mut e, 0.25));

    assert!(store.remove("macro.tone").unwrap());
    assert!(!store.remove("macro.tone").unwrap());
    assert!(store.load().unwrap().defs.is_empty());
    // Ids are file names: traversal is refused.
    assert!(store.save(&bad_id_def(&def, "../escape")).is_err());
}

fn bad_id_def(def: &dj_engine::MacroDef, id: &str) -> dj_engine::MacroDef {
    let mut def = def.clone();
    def.id = id.into();
    def
}

/// *Save macro* publishes the instance's current internals — knob values
/// included — and makes that state the instance's own defaults.
#[test]
fn save_macro_publishes_current_settings_and_is_a_noop_when_unchanged() {
    let mut e = tone_engine();
    assert_eq!(
        e.save_macro_instance("tone1").unwrap(),
        None,
        "nothing changed yet"
    );

    e.set_knob_position("tone1/osc1", "waveform", 1.0).unwrap();
    let def = e.save_macro_instance("tone1").unwrap().expect("published");
    assert_eq!(def.id, "macro.tone");
    assert_eq!(def.modules["osc1"].knobs["waveform"].position, 1.0);
    assert_eq!(e.macros.get("macro.tone"), Some(&def));
    // The instance is clean again: its copy IS what was published.
    assert!(e.snapshot("t").macros["tone1"].state.is_none());
    assert_eq!(e.save_macro_instance("tone1").unwrap(), None);
}

/// *Reset to defaults* restores the instance's own copy — the state it was
/// adopted with — including internal wiring, not the internal modules'
/// manifest defaults and not the base.
#[test]
fn reset_restores_the_adopted_copy_not_the_module_defaults() {
    let mut e = tone_engine();
    // vca1 cv sits at 0.5 in the adopted copy; the module default is 0.0.
    e.set_knob_position("tone1/vca1", "cv", 0.9).unwrap();
    e.set_knob_position("tone1/osc1", "waveform", 1.0).unwrap();
    e.disconnect("tone1/osc1", "audio", "tone1/vca1", "in")
        .unwrap();
    assert!(e.snapshot("t").macros["tone1"].state.is_some());

    e.reset_macro_instance("tone1").unwrap();
    assert_eq!(e.knob_state("tone1/vca1", "cv").unwrap().position, 0.5);
    assert!(e.knob_state("tone1/osc1", "waveform").unwrap().position < 1e-6);
    assert!(
        e.macro_instance_state("tone1").unwrap().wires["osc1"]
            .wires
            .iter()
            .any(|w| w.to == "vca1"),
        "internal wiring must come back"
    );
    assert!(e.snapshot("t").macros["tone1"].state.is_none());
    // Idempotent.
    e.reset_macro_instance("tone1").unwrap();
}

/// *Pull latest* adopts the current base, discarding local edits. It is a
/// no-op while the instance already matches the base.
#[test]
fn pull_latest_adopts_the_base_and_discards_local_edits() {
    let mut e = tone_engine();
    assert!(e.pull_macro_instance("tone1").unwrap().is_empty());

    // The base moves on...
    let mut next = e.macros.get("macro.tone").unwrap().clone();
    next.modules
        .get_mut("osc1")
        .unwrap()
        .knobs
        .get_mut("waveform")
        .unwrap()
        .position = 1.0;
    e.register_macro(next.clone());
    // ...and the instance drifts locally.
    e.set_knob_position("tone1/vca1", "cv", 0.9).unwrap();
    assert!(e.knob_state("tone1/osc1", "waveform").unwrap().position < 1e-6);

    e.pull_macro_instance("tone1").unwrap();
    assert_eq!(
        e.knob_state("tone1/osc1", "waveform").unwrap().position,
        1.0
    );
    assert_eq!(
        e.knob_state("tone1/vca1", "cv").unwrap().position,
        0.5,
        "pull is destructive: local edits are gone"
    );
    assert_eq!(e.macro_instances()["tone1"].def, next);
    assert!(e.pull_macro_instance("tone1").unwrap().is_empty());
}

/// Pulling a base whose interface dropped a promoted jack reports the wires
/// it had to drop rather than failing the load.
#[test]
fn pull_reports_dropped_wires_when_the_interface_shrinks() {
    let mut e = tone_engine();
    e.add_module("lfo1", "com.dj.lfo").unwrap();
    e.connect("lfo1", "uni", "tone1", "level").unwrap();

    let mut narrowed = e.macros.get("macro.tone").unwrap().clone();
    narrowed.interface.inputs.clear();
    e.register_macro(narrowed);

    let warnings = e.pull_macro_instance("tone1").unwrap();
    assert!(
        warnings.iter().any(|w| w.contains("lfo1")),
        "expected a dropped-wire warning, got {warnings:?}"
    );
    assert!(e.macro_instances().contains_key("tone1"));
}

/// Internal edits inside an instance survive a patch save/load: they ride
/// in the instance's `state`, leaving its adopted copy (the reset target)
/// untouched.
#[test]
fn instance_internal_state_round_trips_through_the_patch() {
    let dir = tempfile::tempdir().unwrap();
    let expected;
    {
        let mut e = tone_engine();
        e.set_knob_position("tone1/vca1", "cv", 0.9).unwrap();
        e.set_knob_position("tone1/osc1", "waveform", 1.0).unwrap();
        expected = render(&mut e, 0.25);
        e.save_patch(dir.path(), "edited").unwrap();
    }
    let doc = PatchDoc::read(dir.path()).unwrap();
    let file = &doc.macros["tone1"];
    assert_eq!(file.def.modules["vca1"].knobs["cv"].position, 0.5);
    let state = file.state.as_ref().expect("live state persisted");
    assert_eq!(state.modules["vca1"].knobs["cv"].position, 0.9);
    assert_eq!(state.modules["osc1"].knobs["waveform"].position, 1.0);

    let mut loaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    assert_eq!(render(&mut loaded, 0.25), expected);
    // Reset still goes back to the adopted copy after the round-trip.
    loaded.reset_macro_instance("tone1").unwrap();
    assert_eq!(loaded.knob_state("tone1/vca1", "cv").unwrap().position, 0.5);
}

/// Patches from before the store: one definition per macro id under
/// `<patch>/macros/<id>.json`, shared by every instance. The migration
/// seeds the base from the newest one it finds, gives each instance its own
/// copy, and leaves the patch sounding the same.
#[test]
fn migration_seeds_bases_and_gives_every_instance_a_copy() {
    let data = tempfile::tempdir().unwrap();
    let patches = data.path().join("patches");
    let store = MacroStore::new(data.path().join("macros"));

    // Two patches sharing a macro id, with different definitions behind it
    // (the older one is "version 1", the newer "version 2").
    let mut old_sound = Vec::new();
    for (name, waveform, version) in [("old", 0.0, 1u32), ("new", 1.0, 2u32)] {
        let mut e = tone_engine();
        e.add_module("tone2", "macro.tone").unwrap();
        e.set_knob_position("tone1/osc1", "waveform", waveform)
            .unwrap();
        e.set_knob_position("tone2/osc1", "waveform", waveform)
            .unwrap();
        let dir = patches.join(name);
        e.save_patch(&dir, name).unwrap();
        if name == "old" {
            old_sound = render(&mut e, 0.25);
        }
        write_legacy_layout(&dir, &e, version);
    }

    let report = store.import_patch_macros(&patches).unwrap();
    assert_eq!(report.bases, vec!["macro.tone".to_string()]);
    assert_eq!(report.instances.len(), 4, "two instances in each patch");
    assert_eq!(
        report.deduped, 1,
        "both patches carried the same macro id; one object survives"
    );

    // One global object, seeded from the NEWEST definition.
    let bases = store.load().unwrap();
    assert_eq!(bases.defs.len(), 1);
    assert_eq!(
        bases.get("macro.tone").unwrap().modules["osc1"].knobs["waveform"].position,
        1.0
    );

    // Each patch now has one copy per instance and still sounds the same.
    let doc = PatchDoc::read(&patches.join("old")).unwrap();
    assert_eq!(
        doc.macros.keys().collect::<Vec<_>>(),
        vec!["tone1", "tone2"]
    );
    assert!(!patches.join("old/macros/macro.tone.json").exists());
    assert_eq!(
        doc.macros["tone1"].def.modules["osc1"].knobs["waveform"].position, 0.0,
        "the old patch kept its own definition"
    );
    let mut loaded = Engine::load_patch(&patches.join("old"), crate::common::registry()).unwrap();
    assert_eq!(render(&mut loaded, 0.25), old_sound);
    let module = std::fs::read_to_string(patches.join("old/modules/tone1.json")).unwrap();
    assert!(
        !module.contains("macro_version"),
        "the retired version reference is gone from the instance's module file"
    );

    // Idempotent: a second run finds nothing left to migrate.
    assert!(store.import_patch_macros(&patches).unwrap().is_empty());
}

/// Rewrite a freshly saved patch tree into the pre-store layout: one
/// `macros/<macro id>.json` holding the bare definition (with the old
/// version counter), no per-instance files, and every instance's module
/// file pointing back at that counter.
fn write_legacy_layout(dir: &std::path::Path, e: &Engine, version: u32) {
    let macros = dir.join("macros");
    std::fs::remove_dir_all(&macros).unwrap();
    std::fs::create_dir_all(&macros).unwrap();
    let def = e.macro_instance_state("tone1").unwrap();
    let mut json = serde_json::to_value(&def).unwrap();
    json.as_object_mut()
        .unwrap()
        .insert("version".into(), version.into());
    std::fs::write(
        macros.join(format!("{}.json", def.id)),
        serde_json::to_string_pretty(&json).unwrap(),
    )
    .unwrap();
    for instance in ["tone1", "tone2"] {
        let path = dir.join(format!("modules/{instance}.json"));
        let mut module: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        module
            .as_object_mut()
            .unwrap()
            .insert("macro_version".into(), version.into());
        std::fs::write(&path, serde_json::to_string_pretty(&module).unwrap()).unwrap();
    }
}
