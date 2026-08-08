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
