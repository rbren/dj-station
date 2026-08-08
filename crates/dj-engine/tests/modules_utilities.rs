//! Behaviour tests for the Utilities modules (mixer, attenuverter, mult,
//! quantizer, logic, sequential switch).
//!
//! Each test renders a small offline patch and asserts on the samples.
//! Module outputs are observed by routing them to master channels through
//! `builtin.audio_out` nodes (two channels each, placed with the
//! `channel_offset` input).

mod common;

use dj_engine::{Engine, EngineConfig};

const SR: f32 = 48_000.0;

/// Engine with `channels` master channels and one `audio_out` probe node
/// per channel pair.
fn probe_engine(channels: usize) -> Engine {
    assert!(channels <= 10, "channel_offset tops out at 8");
    let mut e = Engine::new(
        EngineConfig {
            master_channels: channels,
            ..EngineConfig::default()
        },
        common::registry(),
    )
    .unwrap();
    for k in 0..channels.div_ceil(2) {
        let id = format!("probe{k}");
        e.add_module(&id, "builtin.audio_out").unwrap();
        // Stepped 0..8 in 9 steps: position = offset / 8.
        e.set_knob_position(&id, "channel_offset", (2 * k) as f32 / 8.0)
            .unwrap();
    }
    e
}

/// Route `src`'s output jack to master channel `ch`.
fn probe(e: &mut Engine, src: &str, jack: &str, ch: usize) {
    let id = format!("probe{}", ch / 2);
    e.connect(src, jack, &id, ["l", "r"][ch % 2]).unwrap();
}

/// Render `seconds` and return the last sample of each master channel.
fn render_tail(e: &mut Engine, seconds: f32) -> Vec<f32> {
    let out = e.render_offline((seconds * SR) as usize).unwrap();
    out.iter().map(|c| *c.last().unwrap()).collect()
}

fn assert_near(actual: f32, expected: f32, what: &str) {
    assert!(
        (actual - expected).abs() < 1e-4,
        "{what}: got {actual}, want {expected}"
    );
}

// ---------------------------------------------------------------------------
// Mixer
// ---------------------------------------------------------------------------

#[test]
fn mixer_sums_channels_with_attenuverters_and_cv() {
    let mut e = probe_engine(2);
    e.add_module("mx", "com.dj.mixer").unwrap();
    probe(&mut e, "mx", "out", 0);
    probe(&mut e, "mx", "inv", 1);

    // Channel 1: +3 V at unity. Channel 2: +4 V through an inverting level.
    e.set_knob_value("mx", "in1", 3.0).unwrap();
    e.set_knob_value("mx", "lvl1", 1.0).unwrap();
    e.set_knob_value("mx", "in2", 4.0).unwrap();
    e.set_knob_value("mx", "lvl2", -0.5).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 3.0 - 2.0, "mixer sum");
    assert_near(tail[1], -(3.0 - 2.0), "mixer inverted sum");

    // A channel's CV input scales that channel only (10 V = unity).
    e.set_knob_value("mx", "cv1", 5.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 1.5 - 2.0, "mixer sum with cv1 at half");

    // Master scales the whole sum.
    e.set_knob_value("mx", "master", 2.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 0.2 * (1.5 - 2.0), "mixer sum with master at 0.2");

    // Unpatched channels with a centred level contribute nothing.
    e.set_knob_value("mx", "master", 10.0).unwrap();
    e.set_knob_value("mx", "lvl1", 0.0).unwrap();
    e.set_knob_value("mx", "lvl2", 0.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 0.0, "mixer silent with levels centred");
}

#[test]
fn mixer_cancels_a_signal_against_its_inverse() {
    let mut e = probe_engine(2);
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("mx", "com.dj.mixer").unwrap();
    e.connect("osc1", "audio", "mx", "in1").unwrap();
    e.connect("osc1", "audio", "mx", "in2").unwrap();
    e.set_knob_value("mx", "lvl1", 1.0).unwrap();
    e.set_knob_value("mx", "lvl2", -1.0).unwrap();
    probe(&mut e, "mx", "out", 0);
    probe(&mut e, "osc1", "audio", 1);

    let out = e.render_offline((0.1 * SR) as usize).unwrap();
    let peak = out[0].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    let src_peak = out[1].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    assert!(src_peak > 4.9, "oscillator should swing ±5, got {src_peak}");
    assert!(peak < 1e-6, "signal + inverse should cancel, peak {peak}");

    // Same signal at unity on both channels: exactly double.
    e.set_knob_value("mx", "lvl2", 1.0).unwrap();
    let out = e.render_offline((0.1 * SR) as usize).unwrap();
    for (i, (&sum, &src)) in out[0].iter().zip(&out[1]).enumerate() {
        assert!(
            (sum - 2.0 * src).abs() < 1e-4,
            "sample {i}: {sum} != 2 * {src}"
        );
    }
}

// ---------------------------------------------------------------------------
// Attenuverter / offset
// ---------------------------------------------------------------------------

#[test]
fn attenuverter_channels_apply_exact_gain_and_offset() {
    let mut e = probe_engine(10);
    e.add_module("att", "com.dj.attenuverter").unwrap();
    for ch in 0..5 {
        probe(&mut e, "att", &format!("out{}", ch + 1), ch);
    }

    // Ch 1: unity. Ch 2: inverted unity. Ch 3: attenuator centred (muted)
    // with a pure offset. Ch 4: half gain plus offset. Ch 5: untouched, to
    // pin the shipped defaults (atten = +1, offset = 0).
    for ch in 1..=5 {
        e.set_knob_value("att", &format!("in{ch}"), 5.0).unwrap();
    }
    e.set_knob_value("att", "atten1", 1.0).unwrap();
    e.set_knob_value("att", "atten2", -1.0).unwrap();
    e.set_knob_value("att", "atten3", 0.0).unwrap();
    e.set_knob_value("att", "offset3", 2.5).unwrap();
    e.set_knob_value("att", "atten4", 0.5).unwrap();
    e.set_knob_value("att", "offset4", -4.0).unwrap();

    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 5.0, "unity channel");
    assert_near(tail[1], -5.0, "inverted channel");
    assert_near(tail[2], 2.5, "muted channel passes offset only");
    assert_near(tail[3], -1.5, "half gain plus offset");
    assert_near(tail[4], 5.0, "default channel is unity with no offset");

    // Offsets span the full ±10 V and the output clamps at the rails.
    e.set_knob_value("att", "offset1", 10.0).unwrap();
    e.set_knob_value("att", "offset2", -10.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 10.0, "5 V + 10 V offset clamps at the rail");
    assert_near(tail[1], -10.0, "-5 V - 10 V offset clamps at the rail");
}

#[test]
fn attenuverter_scales_audio_sample_accurately() {
    let mut e = probe_engine(4);
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("att", "com.dj.attenuverter").unwrap();
    e.connect("osc1", "audio", "att", "in1").unwrap();
    e.connect("osc1", "audio", "att", "in2").unwrap();
    e.set_knob_value("att", "atten1", 0.25).unwrap();
    e.set_knob_value("att", "atten2", -0.25).unwrap();
    e.set_knob_value("att", "offset2", 1.0).unwrap();
    probe(&mut e, "osc1", "audio", 0);
    probe(&mut e, "att", "out1", 1);
    probe(&mut e, "att", "out2", 2);

    let out = e.render_offline((0.05 * SR) as usize).unwrap();
    let mut peak = 0.0f32;
    for i in 0..out[0].len() {
        let src = out[0][i];
        peak = peak.max(src.abs());
        assert!(
            (out[1][i] - 0.25 * src).abs() < 1e-4,
            "sample {i}: {} != 0.25 * {src}",
            out[1][i]
        );
        assert!(
            (out[2][i] - (-0.25 * src + 1.0)).abs() < 1e-4,
            "sample {i}: {} != -0.25 * {src} + 1",
            out[2][i]
        );
    }
    assert!(peak > 4.9, "expected a ±5 source, got {peak}");
}

// ---------------------------------------------------------------------------
// Mult / merge / split
// ---------------------------------------------------------------------------

/// A DC source: an attenuverter channel with nothing patched in, so its
/// output is just the channel offset.
fn add_dc(e: &mut Engine, id: &str, volts: f32) {
    e.add_module(id, "com.dj.attenuverter").unwrap();
    e.set_knob_value(id, "offset1", volts).unwrap();
}

#[test]
fn mult_banks_chain_until_the_second_input_is_patched() {
    let mut e = probe_engine(6);
    add_dc(&mut e, "dc_a", 3.0);
    add_dc(&mut e, "dc_b", -2.0);
    e.add_module("mult", "com.dj.mult").unwrap();
    e.connect("dc_a", "out1", "mult", "a_in").unwrap();
    probe(&mut e, "mult", "a1", 0);
    probe(&mut e, "mult", "a4", 1);
    probe(&mut e, "mult", "b1", 2);
    probe(&mut e, "mult", "b4", 3);

    // Bank B unpatched: normalled from bank A, so all eight outs carry A.
    let tail = render_tail(&mut e, 0.01);
    for (i, v) in tail.iter().take(4).enumerate() {
        assert_near(*v, 3.0, &format!("normalled mult out {i}"));
    }

    // Patching B breaks the normal; bank A is unaffected.
    e.connect("dc_b", "out1", "mult", "b_in").unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 3.0, "bank A out 1");
    assert_near(tail[1], 3.0, "bank A out 4");
    assert_near(tail[2], -2.0, "bank B out 1");
    assert_near(tail[3], -2.0, "bank B out 4");
}

#[test]
fn mult_merge_sums_only_patched_inputs() {
    let mut e = probe_engine(2);
    add_dc(&mut e, "dc_a", 3.0);
    add_dc(&mut e, "dc_b", 4.0);
    e.add_module("mult", "com.dj.mult").unwrap();
    e.connect("dc_a", "out1", "mult", "merge1").unwrap();
    e.connect("dc_b", "out1", "mult", "merge2").unwrap();
    probe(&mut e, "mult", "merge", 0);

    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 7.0, "merge of two patched inputs");

    // An unpatched merge jack contributes nothing, whatever its knob says.
    e.set_knob_value("mult", "merge3", 5.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 7.0, "unpatched merge jack stays out of the sum");
}

#[test]
fn mult_split_routes_the_input_to_the_selected_output() {
    let mut e = probe_engine(4);
    add_dc(&mut e, "dc_a", 6.0);
    e.add_module("mult", "com.dj.mult").unwrap();
    e.connect("dc_a", "out1", "mult", "split_in").unwrap();
    for way in 0..4 {
        probe(&mut e, "mult", &format!("s{}", way + 1), way);
    }

    for sel in 0..4 {
        e.set_knob_position("mult", "split_sel", sel as f32 / 3.0)
            .unwrap();
        let tail = render_tail(&mut e, 0.01);
        for (way, v) in tail.iter().enumerate() {
            let want = if way == sel { 6.0 } else { 0.0 };
            assert_near(*v, want, &format!("split sel {sel} out {way}"));
        }
    }
}

// ---------------------------------------------------------------------------
// Quantizer
// ---------------------------------------------------------------------------

/// Scale index -> semitone degrees, mirroring the module's table.
const SCALE_DEGREES: [&[i32]; 10] = [
    &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    &[0, 2, 4, 5, 7, 9, 11],
    &[0, 2, 3, 5, 7, 8, 10],
    &[0, 2, 3, 5, 7, 8, 11],
    &[0, 2, 4, 7, 9],
    &[0, 3, 5, 7, 10],
    &[0, 3, 5, 6, 7, 10],
    &[0, 2, 3, 5, 7, 9, 10],
    &[0, 2, 4, 5, 7, 9, 10],
    &[0, 2, 4, 6, 8, 10],
];

/// Rising edges of a gate signal.
fn rising_edges(signal: &[f32]) -> Vec<usize> {
    let mut edges = Vec::new();
    let mut prev = 0.0f32;
    for (i, &v) in signal.iter().enumerate() {
        if v >= 1.0 && prev < 1.0 {
            edges.push(i);
        }
        prev = v;
    }
    edges
}

#[test]
fn quantizer_snaps_a_sweep_to_every_scale() {
    // A slow saw sweeps the quantizer across ±5 octaves.
    let mut e = probe_engine(2);
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("q", "com.dj.quantizer").unwrap();
    e.set_knob_position("osc1", "waveform", 1.0 / 3.0).unwrap(); // saw
    e.set_knob_value("osc1", "pitch", -5.0).unwrap(); // ~8 Hz sweep
    e.connect("osc1", "audio", "q", "in").unwrap();
    probe(&mut e, "q", "out", 0);

    for (scale, degrees) in SCALE_DEGREES.iter().enumerate() {
        e.set_knob_position("q", "scale", scale as f32 / 9.0)
            .unwrap();
        let out = e.render_offline((0.3 * SR) as usize).unwrap();
        let mut seen = std::collections::BTreeSet::new();
        for (i, &v) in out[0].iter().enumerate() {
            let semi = v * 12.0;
            let rounded = semi.round();
            assert!(
                (semi - rounded).abs() < 1e-3,
                "scale {scale} sample {i}: {semi} semitones is not an integer"
            );
            let pc = rounded.rem_euclid(12.0) as i32;
            assert!(
                degrees.contains(&pc),
                "scale {scale} sample {i}: pitch class {pc} is not in the scale"
            );
            seen.insert(pc);
        }
        assert_eq!(
            seen.len(),
            degrees.len(),
            "scale {scale}: sweep should visit every degree, saw {seen:?}"
        );
    }
}

#[test]
fn quantizer_root_and_transpose_shift_the_grid() {
    let mut e = probe_engine(2);
    e.add_module("q", "com.dj.quantizer").unwrap();
    probe(&mut e, "q", "out", 0);
    // Major scale, input a little above the root: snaps to the root.
    e.set_knob_position("q", "scale", 1.0 / 9.0).unwrap();
    e.set_knob_value("q", "in", 0.2 / 12.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 0.0, "C major snaps 0.2 semitones to C4");

    // Same input, root D: C natural is not in D major, so it snaps to C#.
    e.set_knob_position("q", "root", 2.0 / 11.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 1.0 / 12.0, "D major snaps 0.2 semitones to C#4");

    // Transposition is exact: +5 semitones and -1 octave.
    e.set_knob_position("q", "root", 0.0).unwrap();
    e.set_knob_position("q", "semitones", 5.0 / 12.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 5.0 / 12.0, "+5 semitones");
    e.set_knob_position("q", "octaves", 3.0 / 8.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 5.0 / 12.0 - 1.0, "+5 semitones, -1 octave");
}

#[test]
fn quantizer_triggers_on_every_note_change() {
    let mut e = probe_engine(2);
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("scale", "com.dj.attenuverter").unwrap();
    e.add_module("q", "com.dj.quantizer").unwrap();
    e.set_knob_position("osc1", "waveform", 1.0 / 3.0).unwrap(); // saw
    e.set_knob_value("osc1", "pitch", -5.0).unwrap(); // ~8 Hz sweep
                                                      // Sweep two octaves, slowly enough that notes outlast a 5 ms pulse.
    e.connect("osc1", "audio", "scale", "in1").unwrap();
    e.set_knob_value("scale", "atten1", 0.2).unwrap();
    e.connect("scale", "out1", "q", "in").unwrap();
    e.set_knob_position("q", "scale", 4.0 / 9.0).unwrap(); // pentatonic major
    probe(&mut e, "q", "out", 0);
    probe(&mut e, "q", "trig", 1);

    let out = e.render_offline((0.3 * SR) as usize).unwrap();
    let (pitch, trig) = (&out[0], &out[1]);

    let mut changes = 0;
    for i in 1..pitch.len() {
        if pitch[i] != pitch[i - 1] {
            changes += 1;
        }
    }
    assert!(
        changes > 20,
        "sweep should change note often, got {changes}"
    );

    let edges = rising_edges(trig);
    // One pulse per change, plus the pulse for the very first note.
    assert_eq!(edges.len(), changes + 1, "one trigger per note change");
    assert!(
        trig.iter().all(|&v| v == 0.0 || v == 10.0),
        "trigger must be 0 or 10 V"
    );

    // Pulses are a few ms of 10 V (5 ms at 48 kHz = 240 samples).
    let width = (0.005 * SR) as usize;
    for &start in edges.iter().take(edges.len() - 1) {
        let high = trig[start..(start + width).min(trig.len())]
            .iter()
            .filter(|&&v| v >= 1.0)
            .count();
        assert_eq!(high, width.min(trig.len() - start), "pulse too short");
    }
}

#[test]
fn quantizer_hysteresis_ignores_a_wobble_on_a_note_boundary() {
    // Sit exactly on the boundary between C4 and C#4 (0.5 semitones) with a
    // ±0.04 semitone wobble on top: without hysteresis this would chatter
    // twice per oscillator cycle.
    let mut e = probe_engine(2);
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("wob", "com.dj.attenuverter").unwrap();
    e.add_module("q", "com.dj.quantizer").unwrap();
    e.connect("osc1", "audio", "wob", "in1").unwrap();
    // ±5 V * 0.000667 = ±0.0033 units = ±0.04 semitones.
    e.set_knob_value("wob", "atten1", 0.04 / 12.0 / 5.0)
        .unwrap();
    e.set_knob_value("wob", "offset1", 0.5 / 12.0).unwrap();
    e.connect("wob", "out1", "q", "in").unwrap();
    probe(&mut e, "q", "out", 0);
    probe(&mut e, "q", "trig", 1);

    let out = e.render_offline((0.2 * SR) as usize).unwrap();
    assert!(
        out[0].iter().all(|&v| v == out[0][0]),
        "quantizer chattered across the note boundary"
    );
    assert_eq!(
        rising_edges(&out[1]).len(),
        1,
        "only the initial note should trigger"
    );

    // A wobble wider than the dead band does move the note.
    e.set_knob_value("wob", "atten1", 0.4 / 12.0 / 5.0).unwrap();
    let out = e.render_offline((0.2 * SR) as usize).unwrap();
    assert!(
        out[0].iter().any(|&v| v != out[0][0]),
        "a ±0.4 semitone wobble should cross the boundary"
    );
}

// ---------------------------------------------------------------------------
// Logic & comparator
// ---------------------------------------------------------------------------

#[test]
fn logic_boolean_outputs_follow_their_truth_tables() {
    let mut e = probe_engine(8);
    e.add_module("lg", "com.dj.logic").unwrap();
    let jacks = ["and", "or", "xor", "nand", "nor", "xnor", "not_a", "not_b"];
    for (ch, jack) in jacks.iter().enumerate() {
        probe(&mut e, "lg", jack, ch);
    }

    for (a, b) in [(false, false), (true, false), (false, true), (true, true)] {
        e.set_knob_value("lg", "a", if a { 10.0 } else { 0.0 })
            .unwrap();
        e.set_knob_value("lg", "b", if b { 10.0 } else { 0.0 })
            .unwrap();
        let tail = render_tail(&mut e, 0.005);
        let want = [
            a && b,
            a || b,
            a ^ b,
            !(a && b),
            !(a || b),
            !(a ^ b),
            !a,
            !b,
        ];
        for (ch, jack) in jacks.iter().enumerate() {
            let expected = if want[ch] { 10.0 } else { 0.0 };
            assert_near(tail[ch], expected, &format!("{jack} for a={a} b={b}"));
        }
    }
}

#[test]
fn logic_third_input_joins_only_when_patched() {
    let mut e = probe_engine(4);
    add_dc(&mut e, "low", 0.0);
    e.add_module("lg", "com.dj.logic").unwrap();
    e.set_knob_value("lg", "a", 10.0).unwrap();
    e.set_knob_value("lg", "b", 10.0).unwrap();
    probe(&mut e, "lg", "and", 0);
    probe(&mut e, "lg", "xor", 1);

    let tail = render_tail(&mut e, 0.005);
    assert_near(tail[0], 10.0, "AND of two highs with C unpatched");
    assert_near(tail[1], 0.0, "XOR of two highs with C unpatched");

    // Patching a low gate into C pulls AND down: C is now part of the logic.
    e.connect("low", "out1", "lg", "c").unwrap();
    let tail = render_tail(&mut e, 0.005);
    assert_near(tail[0], 0.0, "AND with a patched low C");
}

#[test]
fn logic_comparator_and_window_track_their_thresholds() {
    let mut e = probe_engine(4);
    e.add_module("lg", "com.dj.logic").unwrap();
    probe(&mut e, "lg", "cmp", 0);
    probe(&mut e, "lg", "window", 1);

    e.set_knob_value("lg", "cmp_in", 3.0).unwrap();
    e.set_knob_value("lg", "threshold", 2.0).unwrap();
    e.set_knob_value("lg", "win_in", 3.0).unwrap();
    e.set_knob_value("lg", "win_low", 1.0).unwrap();
    e.set_knob_value("lg", "win_high", 5.0).unwrap();
    let tail = render_tail(&mut e, 0.005);
    assert_near(tail[0], 10.0, "comparator above threshold");
    assert_near(tail[1], 10.0, "window inside bounds");

    e.set_knob_value("lg", "threshold", 4.0).unwrap();
    e.set_knob_value("lg", "win_in", 7.0).unwrap();
    let tail = render_tail(&mut e, 0.005);
    assert_near(tail[0], 0.0, "comparator below threshold");
    assert_near(tail[1], 0.0, "window above the high bound");

    e.set_knob_value("lg", "win_in", 0.5).unwrap();
    let tail = render_tail(&mut e, 0.005);
    assert_near(tail[1], 0.0, "window below the low bound");
}

#[test]
fn logic_comparator_makes_one_clean_edge_per_crossing() {
    // A sine through the comparator at 0 V: exactly one edge per half cycle.
    let mut e = probe_engine(2);
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("lg", "com.dj.logic").unwrap();
    e.set_knob_value("osc1", "pitch", -3.0).unwrap(); // ~32.7 Hz
    e.connect("osc1", "audio", "lg", "cmp_in").unwrap();
    probe(&mut e, "lg", "cmp", 0);

    let seconds = 1.0;
    let out = e.render_offline((seconds * SR) as usize).unwrap();
    let cycles = 261.626 / 8.0 * seconds;
    let edges = rising_edges(&out[0]);
    assert!(
        (edges.len() as f32 - cycles).abs() <= 1.0,
        "expected ~{cycles} comparator edges, got {}",
        edges.len()
    );
    assert!(
        out[0].iter().all(|&v| v == 0.0 || v == 10.0),
        "comparator must be 0 or 10 V"
    );
}

#[test]
fn logic_gate_to_trigger_emits_a_fixed_width_pulse() {
    let mut e = probe_engine(2);
    e.add_module("lg", "com.dj.logic").unwrap();
    probe(&mut e, "lg", "trig", 0);
    e.set_knob_value("lg", "trig_ms", 5.0).unwrap();

    // Rising edge: one 5 ms pulse, however long the gate stays high.
    e.set_knob_value("lg", "g2t_in", 10.0).unwrap();
    let out = e.render_offline((0.1 * SR) as usize).unwrap();
    let high = out[0].iter().filter(|&&v| v >= 1.0).count();
    let expected = (0.005 * SR) as usize;
    assert_eq!(high, expected, "pulse width at 5 ms");
    assert_eq!(rising_edges(&out[0]), vec![0], "one pulse per rising edge");

    // Still high: no new pulse.
    let out = e.render_offline((0.1 * SR) as usize).unwrap();
    assert!(
        out[0].iter().all(|&v| v == 0.0),
        "a held gate must not retrigger"
    );

    // Falling then rising again, with a different width.
    e.set_knob_value("lg", "g2t_in", 0.0).unwrap();
    e.render_offline(64).unwrap();
    e.set_knob_value("lg", "trig_ms", 20.0).unwrap();
    e.set_knob_value("lg", "g2t_in", 10.0).unwrap();
    let out = e.render_offline((0.1 * SR) as usize).unwrap();
    let high = out[0].iter().filter(|&&v| v >= 1.0).count();
    assert_eq!(high, (0.020 * SR) as usize, "pulse width at 20 ms");
}
