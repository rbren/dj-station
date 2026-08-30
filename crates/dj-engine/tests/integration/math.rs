//! Math module: the typed expression running on the RT graph — one
//! evaluation per output index, a broken edit leaving the last good
//! program playing, and the text round-tripping through a patch.

use dj_engine::math::{MATH_OUTPUTS, OUT_RAIL};
use dj_engine::{Engine, EngineConfig};

fn engine() -> Engine {
    Engine::new(EngineConfig::default(), crate::common::registry()).unwrap()
}

fn out_v(e: &Engine, instance: &str, jack: &str) -> f32 {
    e.tap_out(instance, jack).unwrap().instantaneous
}

/// Every output jack's value after one block.
fn outs(e: &mut Engine, instance: &str) -> Vec<f32> {
    e.process_blocks(1).unwrap();
    (0..MATH_OUTPUTS)
        .map(|i| out_v(e, instance, &format!("out{i}")))
        .collect()
}

#[test]
fn every_output_evaluates_the_expression_with_its_own_index() {
    let mut e = engine();
    e.add_module("m", "builtin.math").unwrap();

    // A fresh module already computes: the default expression fans the
    // knob out across the eight jacks.
    e.set_knob_value("m", "x", 1.0).unwrap();
    assert_eq!(
        outs(&mut e, "m"),
        vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
    );

    assert_eq!(e.math_set_expr("m", "(3 * (x + i)).pow(2)").unwrap(), None);
    e.set_knob_value("m", "x", 0.0).unwrap();
    let v = outs(&mut e, "m");
    assert_eq!(v[0], 0.0);
    assert_eq!(v[1], 9.0);
    // 36, 81, ... past the rails: a wild expression is held at +-10 V
    // rather than blasting whatever it is patched into.
    assert_eq!(v[2], OUT_RAIL);
    assert_eq!(v[7], OUT_RAIL);
}

#[test]
fn x_reads_the_knob_and_follows_a_wire() {
    let mut e = engine();
    e.add_module("src", "builtin.math").unwrap();
    e.add_module("m", "builtin.math").unwrap();
    e.math_set_expr("m", "x").unwrap();

    e.set_knob_value("m", "x", -4.5).unwrap();
    assert_eq!(outs(&mut e, "m")[0], -4.5);

    // A constant source into `x`: knob-backed inputs blend in position
    // space, so on this -10..+10 V knob a +5 V wire (atten 1, knob at the
    // centre) drives the input to its top end.
    e.math_set_expr("src", "5.0").unwrap();
    e.connect("src", "out0", "m", "x").unwrap();
    e.set_knob_value("m", "x", 0.0).unwrap();
    assert_eq!(outs(&mut e, "m")[0], OUT_RAIL);
}

#[test]
fn a_broken_expression_keeps_the_last_good_program_and_says_why() {
    let mut e = engine();
    e.add_module("m", "builtin.math").unwrap();
    e.math_set_expr("m", "i * 2.0").unwrap();
    let good = outs(&mut e, "m");
    assert_eq!(good[3], 6.0);

    let error = e
        .math_set_expr("m", "i * (2.0")
        .unwrap()
        .expect("an unbalanced paren must be reported");
    assert!(error.contains("expected"), "message was {error:?}");
    assert_eq!(e.math_error("m").unwrap().as_deref(), Some(error.as_str()));
    // The text the user typed is kept (it is what they are editing) and
    // the audio never changes: the last program that compiled plays on.
    assert_eq!(e.math("m").unwrap().expr, "i * (2.0");
    assert_eq!(outs(&mut e, "m"), good);

    // Fixing it clears the error and takes effect.
    assert_eq!(e.math_set_expr("m", "i * 3.0").unwrap(), None);
    assert_eq!(e.math_error("m").unwrap(), None);
    assert_eq!(outs(&mut e, "m")[3], 9.0);
}

#[test]
fn math_verbs_reject_other_modules() {
    let mut e = engine();
    e.add_module("osc", "com.dj.oscillator").unwrap();
    assert!(e.math("osc").is_err());
    assert!(e.math_set_expr("osc", "x").is_err());
    assert!(e.math_error("nope").is_err());
}

#[test]
fn the_expression_round_trips_through_a_patch() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = engine();
    e.add_module("m", "builtin.math").unwrap();
    e.add_module("osc", "com.dj.oscillator").unwrap();
    e.math_set_expr("m", "(x / 2.0).sin() + i as f32 * 0.25")
        .unwrap();
    e.connect("m", "out2", "osc", "pitch").unwrap();
    e.set_knob_value("m", "x", 3.0).unwrap();
    let before = outs(&mut e, "m");
    e.save_patch(dir.path(), "math").unwrap();

    let mut reloaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    assert!(
        reloaded.load_warnings.is_empty(),
        "warnings: {:?}",
        reloaded.load_warnings
    );
    assert_eq!(
        reloaded.math("m").unwrap().expr,
        "(x / 2.0).sin() + i as f32 * 0.25"
    );
    assert_eq!(reloaded.math_error("m").unwrap(), None);
    assert_eq!(outs(&mut reloaded, "m"), before);
    assert_eq!(reloaded.wire_specs().len(), 1);
}

#[test]
fn a_patch_holding_an_unparseable_expression_loads_with_a_warning() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = engine();
    e.add_module("m", "builtin.math").unwrap();
    e.save_patch(dir.path(), "math").unwrap();

    // Hand-edited (or written against a build with more functions): the
    // module comes up silent and the load warns instead of failing.
    let file = dir.path().join("modules").join("m.json");
    let mut mf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    mf["math"]["expr"] = serde_json::json!("x.wobble()");
    std::fs::write(&file, serde_json::to_string_pretty(&mf).unwrap()).unwrap();

    let mut reloaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    assert!(
        reloaded
            .load_warnings
            .iter()
            .any(|w| w.contains("m:") && w.contains("wobble")),
        "warnings: {:?}",
        reloaded.load_warnings
    );
    assert_eq!(reloaded.math("m").unwrap().expr, "x.wobble()");
    assert!(reloaded.math_error("m").unwrap().is_some());
    assert_eq!(outs(&mut reloaded, "m"), vec![0.0; MATH_OUTPUTS]);
}

#[test]
fn undo_style_document_restore_puts_the_expression_back() {
    let mut e = engine();
    e.add_module("m", "builtin.math").unwrap();
    e.math_set_expr("m", "i * 2.0").unwrap();
    let before = e.snapshot("undo");

    e.math_set_expr("m", "i * 4.0").unwrap();
    assert_eq!(outs(&mut e, "m")[1], 4.0);

    e.apply_doc(&before).unwrap();
    assert_eq!(e.math("m").unwrap().expr, "i * 2.0");
    assert_eq!(outs(&mut e, "m")[1], 2.0);
}
