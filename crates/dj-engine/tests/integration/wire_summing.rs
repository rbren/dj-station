//! Multi-wire input summing, the two wired-blend laws, and the ±10 V rail.
//!
//! The graph sums every wire arriving at one input jack, then blends the
//! sum with the jack's knob (knob.rs docs):
//! - plain wire jacks (no knob declared): `baseline + signal · atten +
//!   offset`, hard-clipped to ±10 V;
//! - knob-backed inputs: position-space blend
//!   `curve(clamp01(base_pos + signal · atten / 10 + offset))`, clamped to
//!   the knob's travel, so the knob's curve shapes the modulation.
//!
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

/// Knob-backed inputs blend in position space: on the LFO's exp rate knob
/// a DC offset moves the baseline geometrically, and the reachable range
/// is the knob's travel — not a ±5 Hz band.
#[test]
fn positional_blend_tracks_an_exp_knob_geometrically() {
    // rate knob: exp 0.01..2000 Hz. Baseline at mid-travel = sqrt(0.01*2000).
    let baseline = |dc: f32, atten: f32| -> f32 {
        let mut e = crate::common::default_engine();
        e.add_module("att1", "com.dj.attenuverter").unwrap();
        e.add_module("lfo1", "com.dj.lfo").unwrap();
        e.set_knob_value("att1", "offset1", dc).unwrap();
        e.connect("att1", "out1", "lfo1", "rate").unwrap();
        e.set_knob_position("lfo1", "rate", 0.5).unwrap();
        e.set_knob_atten_offset("lfo1", "rate", atten, 0.0).unwrap();
        e.render_offline((0.3 * SR) as usize).unwrap();
        e.tap("lfo1", "rate").unwrap().display
    };
    let mid = (0.01f32 * 2000.0).sqrt(); // ≈ 4.472 Hz
    assert!(
        (baseline(0.0, 1.0) - mid).abs() / mid < 1e-3,
        "zero signal must leave the knob baseline: {}",
        baseline(0.0, 1.0)
    );
    // +5 V at atten 1 = +half travel: position 0.5 + 0.5 = 1.0, the knob max.
    assert!(
        (baseline(5.0, 1.0) - 2000.0).abs() / 2000.0 < 1e-3,
        "+5 V full-atten must reach the knob max: {}",
        baseline(5.0, 1.0)
    );
    // -5 V symmetric: the knob min. The old additive law clamped at
    // baseline-5 Hz ≈ 0 — the "spread of 10" bug.
    assert!(
        baseline(-5.0, 1.0) <= 0.0101,
        "-5 V full-atten must reach the knob min: {}",
        baseline(-5.0, 1.0)
    );
    // Geometric linking: ±2.5 V at atten 1 = ±quarter travel, a constant
    // RATIO either side of the baseline ((2000/0.01)^0.25 ≈ 21.15).
    let ratio = (2000.0f32 / 0.01).powf(0.25);
    let up = baseline(2.5, 1.0);
    let down = baseline(-2.5, 1.0);
    assert!(
        (up / mid - ratio).abs() / ratio < 1e-2 && (mid / down - ratio).abs() / ratio < 1e-2,
        "spread must track the baseline geometrically: {down} .. {mid} .. {up}"
    );
}

/// On a linear knob spanning 10 units the positional law reduces to the
/// old additive one (pitch ±5 V here): back-compat for V-scaled CV inputs.
#[test]
fn positional_blend_is_additive_on_ten_volt_linear_knobs() {
    let mut e = crate::common::default_engine();
    e.add_module("att1", "com.dj.attenuverter").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.set_knob_value("att1", "offset1", 2.0).unwrap();
    e.connect("att1", "out1", "osc1", "pitch").unwrap();
    e.set_knob_value("osc1", "pitch", 1.0).unwrap();
    e.set_knob_atten_offset("osc1", "pitch", 0.5, 0.0).unwrap();
    e.render_offline((0.3 * SR) as usize).unwrap();
    let t = e.tap("osc1", "pitch").unwrap();
    assert!(
        (t.display - 2.0).abs() < 1e-3,
        "1 V baseline + 2 V · 0.5 must read 2 V: {t:?}"
    );
}

/// The positional blend clamps to the knob's travel, not the ±10 V rail:
/// an overdriven wire pins the input at the knob's endpoints.
#[test]
fn positional_blend_clamps_to_the_knob_travel() {
    let mut e = crate::common::default_engine();
    e.add_module("att1", "com.dj.attenuverter").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.set_knob_value("att1", "offset1", -9.0).unwrap();
    e.connect("att1", "out1", "vca1", "cv").unwrap();
    e.set_knob_value("vca1", "cv", 5.0).unwrap();
    e.render_offline((0.3 * SR) as usize).unwrap();
    let t = e.tap("vca1", "cv").unwrap();
    assert!(
        t.display.abs() < 1e-3,
        "cv is a 0..10 knob: -9 V past the bottom must clamp to 0, not -4: {t:?}"
    );
}

/// Override wire style: the signal IS the value — knob baseline, atten
/// and offset are all ignored (a pitch wire sets the note; the knob does
/// not add to it).
#[test]
fn override_wire_style_passes_the_signal_through() {
    let mut e = crate::common::default_engine();
    e.add_module("att1", "com.dj.attenuverter").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.set_knob_value("att1", "offset1", 2.0).unwrap();
    e.connect("att1", "out1", "osc1", "pitch").unwrap();
    // A knob baseline and a scaled-down atten that would matter under CV:
    e.set_knob_value("osc1", "pitch", 1.0).unwrap();
    e.set_knob_atten_offset("osc1", "pitch", 0.5, 0.3).unwrap();
    e.set_knob_wire_style("osc1", "pitch", dj_engine::WireStyle::Override)
        .unwrap();
    e.render_offline((0.3 * SR) as usize).unwrap();
    let t = e.tap("osc1", "pitch").unwrap();
    assert!(
        (t.display - 2.0).abs() < 1e-3,
        "override must pass 2 V through untouched (knob/atten/offset ignored): {t:?}"
    );
}

/// Override clamps the summed signal to the knob's configured range in
/// VALUE space — never squeezed through the knob's curve.
#[test]
fn override_clamps_to_knob_range_in_value_space() {
    let mut e = crate::common::default_engine();
    e.add_module("att1", "com.dj.attenuverter").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    // pitch knob range is -5..5; drive 8 V at it.
    e.set_knob_value("att1", "offset1", 8.0).unwrap();
    e.connect("att1", "out1", "osc1", "pitch").unwrap();
    e.set_knob_wire_style("osc1", "pitch", dj_engine::WireStyle::Override)
        .unwrap();
    e.render_offline((0.3 * SR) as usize).unwrap();
    let t = e.tap("osc1", "pitch").unwrap();
    assert!(
        (t.display - 5.0).abs() < 1e-3,
        "8 V must clamp to the pitch knob's +5 V max: {t:?}"
    );
}

/// Multiple wires into an Override input still sum before the clamp
/// (note CV + small vibrato works; the clamp guards the extremes).
#[test]
fn override_sums_multiple_wires_before_clamping() {
    let mut e = crate::common::default_engine();
    e.add_module("att1", "com.dj.attenuverter").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.set_knob_value("att1", "offset1", 2.0).unwrap();
    e.set_knob_value("att1", "offset2", 1.0).unwrap();
    e.connect("att1", "out1", "osc1", "pitch").unwrap();
    e.connect("att1", "out2", "osc1", "pitch").unwrap();
    e.set_knob_wire_style("osc1", "pitch", dj_engine::WireStyle::Override)
        .unwrap();
    e.render_offline((0.3 * SR) as usize).unwrap();
    let t = e.tap("osc1", "pitch").unwrap();
    assert!(
        (t.display - 3.0).abs() < 1e-3,
        "override input must sum its wires: {t:?}"
    );
}

/// Unwired, an Override jack still reads its knob value — the mode only
/// matters while a wire is present.
#[test]
fn override_unwired_falls_back_to_the_knob() {
    let mut e = crate::common::default_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.set_knob_value("osc1", "pitch", 1.5).unwrap();
    e.set_knob_wire_style("osc1", "pitch", dj_engine::WireStyle::Override)
        .unwrap();
    e.render_offline((0.3 * SR) as usize).unwrap();
    let t = e.tap("osc1", "pitch").unwrap();
    assert!(
        (t.display - 1.5).abs() < 1e-3,
        "unwired override jack must read the knob: {t:?}"
    );
}

/// `wire_is_pitch_pair`: v/oct output into v/oct input is the auto-
/// Override case; anything else (LFO into pitch, pitch into a plain CV
/// input) is not.
#[test]
fn pitch_pair_detection_requires_voct_on_both_ends() {
    let mut e = crate::common::default_engine();
    e.add_module("kb1", "builtin.qwerty").unwrap();
    e.add_module("lfo1", "com.dj.lfo").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    assert!(e
        .wire_is_pitch_pair("kb1", "note", "osc1", "pitch")
        .unwrap());
    assert!(!e.wire_is_pitch_pair("lfo1", "bi", "osc1", "pitch").unwrap());
    assert!(!e.wire_is_pitch_pair("kb1", "note", "vca1", "cv").unwrap());
    assert!(!e.wire_is_pitch_pair("kb1", "z", "osc1", "pitch").unwrap());
}

/// The wire-time auto mode: the first wire decides (pitch pair =>
/// Override, anything else => CV, clearing a stale Override); later
/// wires never touch the mode.
#[test]
fn auto_wire_style_first_wire_decides_later_wires_keep_it() {
    use dj_engine::WireStyle;
    let mut e = crate::common::default_engine();
    e.add_module("kb1", "builtin.qwerty").unwrap();
    e.add_module("lfo1", "com.dj.lfo").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();

    // First wire is pitch into pitch: Override.
    e.connect("kb1", "note", "osc1", "pitch").unwrap();
    e.auto_wire_style_on_connect("kb1", "note", "osc1", "pitch")
        .unwrap();
    assert_eq!(
        e.knob_state("osc1", "pitch").unwrap().wire_style,
        WireStyle::Override
    );

    // Second wire (vibrato LFO on top) must not flip the mode back.
    e.connect("lfo1", "bi", "osc1", "pitch").unwrap();
    e.auto_wire_style_on_connect("lfo1", "bi", "osc1", "pitch")
        .unwrap();
    assert_eq!(
        e.knob_state("osc1", "pitch").unwrap().wire_style,
        WireStyle::Override
    );

    // Unplug everything; a fresh first wire from the LFO is plain CV and
    // must clear the stale Override.
    e.disconnect("kb1", "note", "osc1", "pitch").unwrap();
    e.disconnect("lfo1", "bi", "osc1", "pitch").unwrap();
    e.connect("lfo1", "bi", "osc1", "pitch").unwrap();
    e.auto_wire_style_on_connect("lfo1", "bi", "osc1", "pitch")
        .unwrap();
    assert_eq!(
        e.knob_state("osc1", "pitch").unwrap().wire_style,
        WireStyle::Cv
    );
}
