//! Built-in module presets (manifest `presets`, `Engine::apply_preset`):
//! named sets of input-jack VALUES any module can declare and the user
//! recalls from the module's right-click menu. Applying one only moves
//! knobs — it is not a patch, and it owns nothing else about the module.

use dj_engine::Engine;

/// Value an input jack's knob currently reads (the manifest knob config,
/// or the per-patch override when one is set).
fn knob_value(engine: &Engine, instance: &str, jack: &str) -> f32 {
    let node = engine
        .nodes
        .iter()
        .find(|n| n.instance_id == instance)
        .expect("no such module");
    let idx = node
        .manifest
        .inputs
        .iter()
        .position(|i| i.id == jack)
        .expect("no such jack");
    let cfg = node.knobs[idx]
        .config
        .clone()
        .or_else(|| node.manifest.inputs[idx].knob.clone())
        .unwrap_or_default();
    cfg.map(node.knobs[idx].position)
}

fn spectral_noise() -> Engine {
    let mut e = crate::common::default_engine();
    e.add_module("noise1", "com.dj.spectral_noise").unwrap();
    e
}

#[test]
fn presets_are_manifest_data_with_unique_names() {
    let e = spectral_noise();
    let manifest = &e
        .nodes
        .iter()
        .find(|n| n.instance_id == "noise1")
        .unwrap()
        .manifest;
    let names: Vec<&str> = manifest.presets.iter().map(|p| p.name.as_str()).collect();
    assert!(
        names.contains(&"White") && names.contains(&"Pink") && names.contains(&"Violet"),
        "spectral noise ships the colours: {names:?}"
    );
    let mut sorted = names.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(
        sorted.len(),
        names.len(),
        "duplicate preset name: {names:?}"
    );
    // Every value addresses a real input jack (also enforced at load).
    for preset in &manifest.presets {
        for jack in preset.values.keys() {
            assert!(
                manifest.inputs.iter().any(|i| &i.id == jack),
                "preset {:?} names unknown jack {jack:?}",
                preset.name
            );
        }
    }
}

#[test]
fn applying_a_preset_moves_the_knobs_it_names() {
    let mut e = spectral_noise();
    assert_eq!(knob_value(&e, "noise1", "tilt"), 0.0, "default is white");

    e.apply_preset("noise1", "Pink").unwrap();
    assert!((knob_value(&e, "noise1", "tilt") + 3.0).abs() < 1e-3);

    e.apply_preset("noise1", "Violet").unwrap();
    assert!((knob_value(&e, "noise1", "tilt") - 6.0).abs() < 1e-3);

    // Grey is a scoop at 2.5 kHz rather than a slope: a preset carries
    // every control it names, not just the headline one.
    e.apply_preset("noise1", "Grey").unwrap();
    assert!((knob_value(&e, "noise1", "tilt")).abs() < 1e-3);
    assert!((knob_value(&e, "noise1", "curve") + 12.0).abs() < 1e-3);
    let pivot_hz = 261.626 * 2f32.powf(knob_value(&e, "noise1", "pivot"));
    assert!((pivot_hz - 2_500.0).abs() < 10.0, "pivot at {pivot_hz} Hz");
}

#[test]
fn a_preset_is_a_set_of_values_and_touches_nothing_else() {
    let mut e = spectral_noise();
    e.add_module("lfo1", "com.dj.lfo").unwrap();
    e.connect("lfo1", "bi", "noise1", "tilt").unwrap();
    e.set_knob_atten_offset("noise1", "tilt", 0.4, -0.2)
        .unwrap();

    e.apply_preset("noise1", "Red / brown").unwrap();

    let knob = e.knob_state("noise1", "tilt").unwrap();
    assert!((knob.atten - 0.4).abs() < 1e-6, "attenuverter moved");
    assert!((knob.offset + 0.2).abs() < 1e-6, "offset moved");
    assert_eq!(
        e.wire_specs().len(),
        1,
        "a preset must not add or drop wires"
    );
    assert!((knob_value(&e, "noise1", "tilt") + 6.0).abs() < 1e-3);
}

#[test]
fn an_unknown_preset_is_refused() {
    let mut e = spectral_noise();
    let err = e.apply_preset("noise1", "Puce").unwrap_err().to_string();
    assert!(err.contains("preset"), "unhelpful error: {err}");
    // A module with no presets at all refuses everything the same way.
    e.add_module("vca1", "com.dj.vca").unwrap();
    assert!(e.apply_preset("vca1", "White").is_err());
}

#[test]
fn a_second_module_ships_its_own_presets_the_poisson_densities() {
    // Presets are data, so nothing about them is spectral-noise-shaped:
    // the Poisson Clock offers its gamma shapes by name, and recalling one
    // lands the exact k the manifest names — both ends of the knob's
    // exponential range included.
    let mut e = crate::common::default_engine();
    e.add_module("pz", "com.dj.poisson").unwrap();
    for (name, k) in [
        ("Clumpy (k 1/16)", 0.0625f32),
        ("Poisson (k 1)", 1.0),
        ("Nearly regular (k 16)", 16.0),
    ] {
        e.apply_preset("pz", name).unwrap();
        let got = knob_value(&e, "pz", "density");
        assert!((got - k).abs() < 1e-3, "preset {name}: density {got}");
    }
}

#[test]
fn preset_values_are_ordinary_knob_state_and_survive_a_save() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = spectral_noise();
    e.apply_preset("noise1", "Blue").unwrap();
    e.save_patch(dir.path(), "presets").unwrap();

    let reloaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    assert!((knob_value(&reloaded, "noise1", "tilt") - 3.0).abs() < 1e-3);
}
