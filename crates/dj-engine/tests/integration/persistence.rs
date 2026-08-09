//! M0 acceptance:
//! - Knob config (style/endpoints/curve) persists in the saved patch and
//!   reloads identically.
//! - Patch saves as a directory tree; moving one knob and re-saving produces
//!   a diff touching exactly one file.
//! - ADSR params round-trip through patch save/load.

use dj_engine::{Curve, Engine, KnobConfig, KnobStyle};
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
    assert_eq!(midi.midi_mappings[0].kind, "note");
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
