//! M0 acceptance:
//! - Knob config (style/endpoints/curve) persists in the saved patch and
//!   reloads identically.
//! - Patch saves as a directory tree; moving one knob and re-saving produces
//!   a diff touching exactly one file.
//! - ADSR params round-trip through patch save/load.

use dj_engine::{Curve, Engine, KnobConfig, KnobStyle, MidiMapKind};
use std::collections::BTreeMap;
use std::path::Path;

/// Snapshot of every file in a directory tree: relative path -> content.
fn snapshot(dir: &Path) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    fn walk(base: &Path, dir: &Path, map: &mut BTreeMap<String, String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(base, &path, map);
            } else {
                let rel = path
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .to_string();
                map.insert(rel, std::fs::read_to_string(&path).unwrap());
            }
        }
    }
    walk(dir, dir, &mut map);
    map
}

#[test]
fn knob_config_persists_and_reloads_identically() {
    let dir = tempfile::tempdir().unwrap();
    let mut engine = crate::common::default_engine();
    crate::common::build_demo_patch(&mut engine);

    // Right-click style knob reconfiguration: stepped, custom endpoints, exp.
    let custom = KnobConfig {
        style: KnobStyle::Stepped,
        min: 0.25,
        max: 8.0,
        curve: Curve::Exp,
        steps: Some(6),
    };
    engine
        .set_knob_config("osc1", "pitch", Some(custom.clone()))
        .unwrap();
    engine.set_knob_position("osc1", "pitch", 0.6).unwrap();
    engine
        .set_knob_atten_offset("vca1", "cv", -0.5, 2.0)
        .unwrap();
    engine.save_patch(dir.path(), "test").unwrap();

    let reloaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    let knob = reloaded.knob_state("osc1", "pitch").unwrap();
    assert_eq!(knob.config.as_ref(), Some(&custom));
    assert!((knob.position - 0.6).abs() < 1e-6);
    let cv = reloaded.knob_state("vca1", "cv").unwrap();
    assert!((cv.atten - -0.5).abs() < 1e-6);
    assert!((cv.offset - 2.0).abs() < 1e-6);

    // Re-saving the reloaded patch must be byte-identical (determinism).
    let dir2 = tempfile::tempdir().unwrap();
    reloaded.save_patch(dir2.path(), "test").unwrap();
    assert_eq!(snapshot(dir.path()), snapshot(dir2.path()));
}

#[test]
fn moving_one_knob_touches_exactly_one_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut engine = crate::common::default_engine();
    crate::common::build_demo_patch(&mut engine);
    engine.save_patch(dir.path(), "test").unwrap();
    let before = snapshot(dir.path());

    engine.set_knob_position("osc1", "pitch", 0.75).unwrap();
    engine.save_patch(dir.path(), "test").unwrap();
    let after = snapshot(dir.path());

    assert_eq!(
        before.keys().collect::<Vec<_>>(),
        after.keys().collect::<Vec<_>>(),
        "file set must not change"
    );
    let changed: Vec<&String> = before
        .iter()
        .filter(|(k, v)| after.get(*k) != Some(v))
        .map(|(k, _)| k)
        .collect();
    assert_eq!(
        changed,
        vec!["modules/osc1.json"],
        "exactly one file (the knob's module) must change"
    );
}

#[test]
fn adsr_params_roundtrip_through_save_load() {
    let dir = tempfile::tempdir().unwrap();
    let mut engine = crate::common::default_engine();
    crate::common::build_demo_patch(&mut engine);
    engine.set_knob_value("adsr1", "attack", 0.033).unwrap();
    engine.set_knob_value("adsr1", "decay", 0.21).unwrap();
    engine.set_knob_value("adsr1", "sustain", 0.42).unwrap();
    engine.set_knob_value("adsr1", "release", 1.5).unwrap();
    engine.save_patch(dir.path(), "test").unwrap();

    let reloaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    // A/D/S/R are ordinary input knobs; their mapped values round-trip.
    let knob_value = |jack: &str| {
        let node = reloaded
            .nodes
            .iter()
            .find(|n| n.instance_id == "adsr1")
            .unwrap();
        let idx = node
            .manifest
            .inputs
            .iter()
            .position(|i| i.id == jack)
            .unwrap();
        let ks = &node.knobs[idx];
        ks.config
            .clone()
            .or_else(|| node.manifest.inputs[idx].knob.clone())
            .unwrap_or_default()
            .map(ks.position)
    };
    assert!((knob_value("attack") - 0.033).abs() < 1e-4);
    assert!((knob_value("decay") - 0.21).abs() < 1e-4);
    assert!((knob_value("sustain") - 0.42).abs() < 1e-4);
    assert!((knob_value("release") - 1.5).abs() < 1e-3);
}

#[test]
fn wires_and_midi_mappings_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let mut engine = crate::common::default_engine();
    crate::common::build_demo_patch(&mut engine);
    engine.save_patch(dir.path(), "test").unwrap();

    let mut reloaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    assert_eq!(reloaded.wire_specs().len(), 5);
    let midi = reloaded
        .nodes
        .iter()
        .find(|n| n.instance_id == "midi1")
        .unwrap();
    assert_eq!(midi.midi_mappings.len(), 1);
    assert_eq!(midi.midi_mappings[0].name, "pad_1");
    assert_eq!(midi.midi_mappings[0].kind, MidiMapKind::Note);
    assert_eq!(midi.midi_mappings[0].num, 60);

    // The reloaded patch is playable: inject a note and confirm output.
    reloaded.inject_midi("midi1", 0, [0x90, 60, 100]).unwrap();
    let out = reloaded.render_offline(48_000).unwrap();
    let peak = out[0].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    assert!(
        peak > 1.0,
        "reloaded patch should produce audio, peak={peak}"
    );
}

#[test]
fn saved_patch_records_engine_version() {
    let dir = tempfile::tempdir().unwrap();
    let mut engine = crate::common::default_engine();
    crate::common::build_demo_patch(&mut engine);
    engine.save_patch(dir.path(), "test").unwrap();

    let header: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("patch.json")).unwrap())
            .unwrap();
    assert_eq!(header["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(header["format"], "djpatch-1");

    // And it round-trips through load → snapshot.
    let reloaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    assert_eq!(
        reloaded.snapshot("test").header.version,
        env!("CARGO_PKG_VERSION")
    );
}

/// Backward compat: a patch saved against an older module version may
/// reference jacks/params the current manifest no longer has (e.g. the
/// camera module dropping its `in`/`thru` pass-through). Loading must not
/// fail — stale wires are dropped with a warning, stale knob entries are
/// skipped silently (nothing user-visible attached), and the rest of the
/// patch loads intact.
#[test]
fn stale_jacks_from_older_module_versions_load_with_warnings() {
    let dir = tempfile::tempdir().unwrap();
    let mut engine = crate::common::default_engine();
    crate::common::build_demo_patch(&mut engine);
    engine.save_patch(dir.path(), "test").unwrap();

    // Simulate the old save: a wire into a jack that no longer exists, a
    // knob entry for a removed jack, and a param the module dropped.
    let vca_wires = dir.path().join("wires").join("osc1.json");
    let mut wf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&vca_wires).unwrap()).unwrap();
    wf["wires"].as_array_mut().unwrap().push(serde_json::json!({
        "from_jack": "audio", "to": "vca1", "to_jack": "gone_jack"
    }));
    std::fs::write(&vca_wires, serde_json::to_string_pretty(&wf).unwrap()).unwrap();

    let vca_mod = dir.path().join("modules").join("vca1.json");
    let mut mf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&vca_mod).unwrap()).unwrap();
    mf["knobs"]["gone_jack"] = serde_json::json!({ "position": 0.5, "atten": 1.0, "offset": 0.0 });
    mf["params"]["gone_param"] = serde_json::json!(1.0);
    std::fs::write(&vca_mod, serde_json::to_string_pretty(&mf).unwrap()).unwrap();

    let reloaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();

    // The good wires all survived; only the stale one was dropped.
    assert_eq!(reloaded.wire_specs().len(), 5);
    // One warning for the wire, one for the param; the stale knob entry is
    // silent (it carries no user-visible state once the jack is gone).
    assert_eq!(
        reloaded.load_warnings.len(),
        2,
        "warnings: {:?}",
        reloaded.load_warnings
    );
    assert!(
        reloaded
            .load_warnings
            .iter()
            .any(|w| w.contains("gone_jack")
                && w.contains("dropped wire")
                && w.contains("osc1")
                && w.contains("vca1")),
        "warnings: {:?}",
        reloaded.load_warnings
    );
    assert!(
        reloaded
            .load_warnings
            .iter()
            .any(|w| w.contains("gone_param") && w.contains("vca1")),
        "warnings: {:?}",
        reloaded.load_warnings
    );

    // A clean load reports no warnings.
    let dir2 = tempfile::tempdir().unwrap();
    let mut clean = crate::common::default_engine();
    crate::common::build_demo_patch(&mut clean);
    clean.save_patch(dir2.path(), "test").unwrap();
    let clean_reload = Engine::load_patch(dir2.path(), crate::common::registry()).unwrap();
    assert!(clean_reload.load_warnings.is_empty());
}

/// A patch that names a module type this build doesn't have — an extension
/// that was retired (the old Clock), or one this machine hasn't installed —
/// loads without it instead of failing: the instance is skipped, its wires
/// are dropped, and every other module still plays.
#[test]
fn a_patch_naming_a_module_this_build_lacks_loads_without_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut engine = crate::common::default_engine();
    crate::common::build_demo_patch(&mut engine);
    engine.save_patch(dir.path(), "test").unwrap();

    // Rewrite osc1 as a module type that no longer exists, keeping the
    // wires that reference it (osc1 -> vca1).
    let module = dir.path().join("modules").join("osc1.json");
    let mut mf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&module).unwrap()).unwrap();
    mf["ext"] = serde_json::json!("com.dj.retired");
    std::fs::write(&module, serde_json::to_string_pretty(&mf).unwrap()).unwrap();

    let reloaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    assert!(
        reloaded.nodes.iter().all(|n| n.instance_id != "osc1"),
        "the unknown module was instantiated anyway"
    );
    assert!(
        reloaded.nodes.iter().any(|n| n.instance_id == "vca1"),
        "the rest of the patch must survive"
    );
    assert!(
        reloaded
            .load_warnings
            .iter()
            .any(|w| w.contains("osc1") && w.contains("com.dj.retired")),
        "warnings: {:?}",
        reloaded.load_warnings
    );
    // Its wires went with it, and every wire that is left resolves.
    assert!(reloaded
        .wire_specs()
        .iter()
        .all(|w| reloaded.nodes[w.from_node].instance_id != "osc1"));
}

/// The Override wire style round-trips through patch save/load, and the
/// default CV style is omitted from the saved JSON entirely — patches
/// written before the field existed and patches that never use Override
/// stay byte-identical to the old format.
#[test]
fn wire_style_roundtrips_and_default_is_omitted() {
    let dir = tempfile::tempdir().unwrap();
    let mut engine = crate::common::default_engine();
    crate::common::build_demo_patch(&mut engine);
    engine
        .set_knob_wire_style("osc1", "pitch", dj_engine::WireStyle::Override)
        .unwrap();
    engine.save_patch(dir.path(), "test").unwrap();

    let reloaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    let knob = reloaded.knob_state("osc1", "pitch").unwrap();
    assert_eq!(knob.wire_style, dj_engine::WireStyle::Override);

    // Every other knob defaulted to CV: their files must not mention the
    // field (old-format compatibility), while osc1's must.
    let files = snapshot(dir.path());
    let osc1 = &files["modules/osc1.json"];
    assert!(
        osc1.contains("wire_style"),
        "osc1 saves its override: {osc1}"
    );
    for (path, content) in &files {
        if path != "modules/osc1.json" {
            assert!(
                !content.contains("wire_style"),
                "default CV must serialize to nothing in {path}"
            );
        }
    }
}

#[test]
fn a_patch_whose_track_file_is_gone_loads_without_it() {
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("deleted-from-the-library.wav");
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 48_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(&wav, spec).unwrap();
    for i in 0..48_000u32 {
        let t = i as f64 / 48_000.0;
        let x = (2.0 * std::f64::consts::PI * 440.0 * t).sin() * 0.5;
        w.write_sample((x * i16::MAX as f64) as i16).unwrap();
    }
    w.finalize().unwrap();

    let dir = tempfile::tempdir().unwrap();
    let mut engine = crate::common::default_engine();
    crate::common::build_demo_patch(&mut engine);
    engine.add_module("deck1", "builtin.deck").unwrap();
    engine.deck_load("deck1", &wav).unwrap();
    engine.save_patch(dir.path(), "test").unwrap();

    // The track was deleted from the library between save and load.
    std::fs::remove_file(&wav).unwrap();

    let reloaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    assert!(
        reloaded
            .load_warnings
            .iter()
            .any(|w| w.contains("deck1") && w.contains("deleted-from-the-library.wav")),
        "warnings: {:?}",
        reloaded.load_warnings
    );
    // The deck is there, simply empty — and the rest of the patch is
    // exactly as it was saved.
    assert!(reloaded.deck_track("deck1").unwrap().is_none());
    assert_eq!(reloaded.wire_specs().len(), 5);
}
