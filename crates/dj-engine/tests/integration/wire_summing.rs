//! Multi-wire input summing and the ±10 V input rail clip.
//!
//! The graph sums every wire arriving at one input jack, then hard-clips
//! the blended (knob baseline + signal · atten + offset) value to ±10 V.
//! Output jacks carry telemetry too, so the post-module signal is
//! observable via `Engine::tap_out`.

const SR: f32 = 48_000.0;

/// Two DC sources (attenuverter offset channels) into one input: the
/// input sees their sum.
#[test]
fn two_wires_into_one_input_sum() {
    let mut engine = crate::common::default_engine();
    engine.add_module("att1", "com.dj.attenuverter").unwrap();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    // Channel outputs are `in*atten + offset`; unwired ins make them DC.
    engine.set_knob_value("att1", "offset1", 4.0).unwrap();
    engine.set_knob_value("att1", "offset2", 3.0).unwrap();
    engine.connect("att1", "out1", "vca1", "in").unwrap();
    engine.connect("att1", "out2", "vca1", "in").unwrap();

    engine.render_offline((0.3 * SR) as usize).unwrap();

    let t = engine.tap("vca1", "in").unwrap();
    assert!(
        (t.display - 7.0).abs() < 1e-3,
        "two wires must sum: {t:?} != 7"
    );
}

/// The summed wired-input value hard-clips at +10 V, and the clipped
/// value is what the module actually processes (observed on its output).
#[test]
fn summed_input_clips_at_ten_volts() {
    let mut engine = crate::common::default_engine();
    engine.add_module("att1", "com.dj.attenuverter").unwrap();
    engine.add_module("att2", "com.dj.attenuverter").unwrap();
    engine.set_knob_value("att1", "offset1", 8.0).unwrap();
    engine.set_knob_value("att1", "offset2", 6.0).unwrap();
    // att2 channel 1 passes its input through (atten defaults to 1).
    engine.connect("att1", "out1", "att2", "in1").unwrap();
    engine.connect("att1", "out2", "att2", "in1").unwrap();

    engine.render_offline((0.3 * SR) as usize).unwrap();

    let t = engine.tap("att2", "in1").unwrap();
    assert!(
        (t.display - 10.0).abs() < 1e-3,
        "8 + 6 must clip to 10: {t:?}"
    );
    // The module ran on the clipped buffer: unity pass-through emits 10 V,
    // visible on the output jack's own telemetry.
    let out = engine.tap_out("att2", "out1").unwrap();
    assert!(
        (out.display - 10.0).abs() < 1e-3,
        "post-clip output {out:?}"
    );
}

/// Negative rail too: two negative offsets clip at −10 V.
#[test]
fn summed_input_clips_at_negative_ten_volts() {
    let mut engine = crate::common::default_engine();
    engine.add_module("att1", "com.dj.attenuverter").unwrap();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    engine.set_knob_value("att1", "offset1", -8.0).unwrap();
    engine.set_knob_value("att1", "offset2", -6.0).unwrap();
    engine.connect("att1", "out1", "vca1", "in").unwrap();
    engine.connect("att1", "out2", "vca1", "in").unwrap();

    engine.render_offline((0.3 * SR) as usize).unwrap();

    let t = engine.tap("vca1", "in").unwrap();
    assert!(
        (t.display + 10.0).abs() < 1e-3,
        "-8 + -6 must clip to -10: {t:?}"
    );
}

/// Two gate signals into one gate input: either one opens the gate
/// (summing semantics — a high gate keeps the sum high).
#[test]
fn two_gates_into_one_gate_input_or_together() {
    let mut engine = crate::common::default_engine();
    engine.add_module("midi1", "builtin.midi").unwrap();
    engine.add_module("adsr1", "com.dj.adsr").unwrap();
    engine
        .add_midi_mapping("midi1", dj_engine::MidiMapKind::Note, 60, "pad_a")
        .unwrap();
    engine
        .add_midi_mapping("midi1", dj_engine::MidiMapKind::Note, 61, "pad_b")
        .unwrap();
    engine.connect("midi1", "pad_a", "adsr1", "gate").unwrap();
    engine.connect("midi1", "pad_b", "adsr1", "gate").unwrap();

    // Only pad B is held: the summed gate input must still read high.
    engine.inject_midi("midi1", 0, [0x90, 61, 100]).unwrap();
    engine.render_offline((0.2 * SR) as usize).unwrap();
    let t = engine.tap("adsr1", "gate").unwrap();
    assert!(
        (t.display - 10.0).abs() < 1e-3,
        "one held gate of two wires must open the input: {t:?}"
    );

    // Both held: the sum (20 V) clips back to the 10 V rail.
    engine.inject_midi("midi1", 0, [0x90, 60, 100]).unwrap();
    engine.render_offline((0.2 * SR) as usize).unwrap();
    let t = engine.tap("adsr1", "gate").unwrap();
    assert!(
        (t.display - 10.0).abs() < 1e-3,
        "two held gates must clip to the rail, not stack: {t:?}"
    );
}
