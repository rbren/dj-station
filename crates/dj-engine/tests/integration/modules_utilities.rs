//! Behaviour tests for the Utilities modules (mixer, attenuverter, mult,
//! quantizer, logic, sequential switch).
//!
//! Each test renders a small offline patch and asserts on the samples.
//! Module outputs are observed by routing them to master channels through
//! `builtin.audio_out` nodes (two channels each, placed with the
//! `channel_offset` input).

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
        crate::common::registry(),
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
fn mixer_sums_stereo_channels_with_levels() {
    let mut e = probe_engine(2);
    e.add_module("mx", "com.dj.mixer").unwrap();
    probe(&mut e, "mx", "out_l", 0);
    probe(&mut e, "mx", "out_r", 1);

    // Channel 1: +3 V at unity (lvl 10). Channel 2: +4 V at half (lvl 5).
    // Pans stay centred: both sides at unity.
    e.set_knob_value("mx", "in1_l", 3.0).unwrap();
    e.set_knob_value("mx", "lvl1", 10.0).unwrap();
    e.set_knob_value("mx", "in2_l", 4.0).unwrap();
    e.set_knob_value("mx", "lvl2", 5.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 3.0 + 2.0, "mixer left sum");
    assert_near(tail[1], 3.0 + 2.0, "mixer right sum (R normalled to L)");

    // Master scales the whole sum.
    e.set_knob_value("mx", "master", 2.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 0.2 * 5.0, "mixer sum with master at 0.2");

    // Channels with the fader down contribute nothing.
    e.set_knob_value("mx", "master", 10.0).unwrap();
    e.set_knob_value("mx", "lvl1", 0.0).unwrap();
    e.set_knob_value("mx", "lvl2", 0.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 0.0, "mixer silent with faders down");
}

/// A fader at 0 kills its channel EXACTLY — with every input jack wired,
/// pans off centre and the other channels playing.
#[test]
fn mixer_level_at_zero_is_exact_silence_on_a_full_desk() {
    let peaks = |e: &mut Engine| {
        let out = e.render_offline((0.05 * SR) as usize).unwrap();
        let p = |c: &Vec<f32>| c.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
        (p(&out[0]), p(&out[1]))
    };

    let mut e = probe_engine(2);
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("lfo1", "com.dj.lfo").unwrap();
    e.add_module("mx", "com.dj.mixer").unwrap();
    probe(&mut e, "mx", "out_l", 0);
    probe(&mut e, "mx", "out_r", 1);
    for ch in 1..=6 {
        e.connect("osc1", "audio", "mx", &format!("in{ch}_l"))
            .unwrap();
        // Odd channels take a wired R, even ones keep the L normal.
        if ch % 2 == 1 {
            e.connect("osc1", "audio", "mx", &format!("in{ch}_r"))
                .unwrap();
        }
        e.connect("lfo1", "bi", "mx", &format!("pan{ch}")).unwrap();
        e.set_knob_value("mx", &format!("lvl{ch}"), 10.0).unwrap();
    }
    let (loud_l, loud_r) = peaks(&mut e);
    assert!(loud_l > 4.9 && loud_r > 4.9, "desk should be loud first");

    // Every fader down: digital silence, not a residue of six channels.
    for ch in 1..=6 {
        e.set_knob_value("mx", &format!("lvl{ch}"), 0.0).unwrap();
    }
    assert_eq!(peaks(&mut e), (0.0, 0.0), "faders down must be silent");

    // ... and a single fader brings its own channel back, so the silence
    // above was the faders' doing and not a dead patch. (Its pan sits
    // wherever the LFO left it, so only the favoured side is at unity.)
    e.set_knob_value("mx", "lvl4", 10.0).unwrap();
    let (l, r) = peaks(&mut e);
    assert!(l.max(r) > 4.9, "channel 4 alone should play: {l}, {r}");
}

#[test]
fn mixer_pan_places_a_mono_source_in_the_field() {
    let mut e = probe_engine(2);
    e.add_module("mx", "com.dj.mixer").unwrap();
    probe(&mut e, "mx", "out_l", 0);
    probe(&mut e, "mx", "out_r", 1);
    e.set_knob_value("mx", "in1_l", 4.0).unwrap();
    e.set_knob_value("mx", "lvl1", 10.0).unwrap();

    // Hard left: L at unity, R silent.
    e.set_knob_value("mx", "pan1", -10.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 4.0, "hard left keeps L at unity");
    assert_near(tail[1], 0.0, "hard left silences R");

    // Half right: L fades to half, R stays at unity (balance law).
    e.set_knob_value("mx", "pan1", 5.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 2.0, "half right fades L");
    assert_near(tail[1], 4.0, "half right keeps R at unity");
}

#[test]
fn mixer_right_input_breaks_the_left_normal_when_wired() {
    let mut e = probe_engine(2);
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("mx", "com.dj.mixer").unwrap();
    e.connect("osc1", "audio", "mx", "in1_l").unwrap();
    e.set_knob_value("mx", "lvl1", 10.0).unwrap();
    probe(&mut e, "mx", "out_l", 0);
    probe(&mut e, "mx", "out_r", 1);

    // R unwired: normalled to L, both sides identical.
    let out = e.render_offline((0.1 * SR) as usize).unwrap();
    let peak = out[0].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    assert!(peak > 4.9, "oscillator should reach ±5, got {peak}");
    for (i, (&l, &r)) in out[0].iter().zip(&out[1]).enumerate() {
        assert!((l - r).abs() < 1e-6, "sample {i}: normalled R {r} != L {l}");
    }

    // Wiring R replaces the normal with the jack's own signal (silent here).
    e.add_module("att", "com.dj.attenuverter").unwrap();
    e.connect("att", "out1", "mx", "in1_r").unwrap();
    let out = e.render_offline((0.1 * SR) as usize).unwrap();
    let peak_l = out[0].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    let peak_r = out[1].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    assert!(peak_l > 4.9, "L keeps the oscillator, got {peak_l}");
    assert!(
        peak_r < 1e-6,
        "wired-but-silent R must not mirror L: {peak_r}"
    );
}

/// Three DC channels at unity, so a sum reads the audible set directly.
fn mute_solo_engine() -> Engine {
    let mut e = probe_engine(2);
    e.add_module("mx", "com.dj.mixer").unwrap();
    probe(&mut e, "mx", "out_l", 0);
    probe(&mut e, "mx", "out_r", 1);
    for (ch, volts) in [1.0f32, 2.0, 4.0].iter().enumerate() {
        e.set_knob_value("mx", &format!("in{}_l", ch + 1), *volts)
            .unwrap();
        e.set_knob_value("mx", &format!("lvl{}", ch + 1), 10.0)
            .unwrap();
    }
    e
}

/// Gate a mute/solo switch on (10 V) or off.
fn switch(e: &mut Engine, jack: &str, on: bool) {
    e.set_knob_value("mx", jack, if on { 10.0 } else { 0.0 })
        .unwrap();
}

#[test]
fn mixer_mute_silences_only_its_own_channel() {
    let mut e = mute_solo_engine();
    assert_near(render_tail(&mut e, 0.02)[0], 7.0, "all three channels sum");

    switch(&mut e, "mute2", true);
    assert_near(render_tail(&mut e, 0.02)[0], 5.0, "channel 2 muted");

    switch(&mut e, "mute1", true);
    assert_near(render_tail(&mut e, 0.02)[0], 4.0, "channels 1 + 2 muted");

    switch(&mut e, "mute1", false);
    switch(&mut e, "mute2", false);
    assert_near(render_tail(&mut e, 0.02)[0], 7.0, "un-muted again");
}

#[test]
fn mixer_solo_silences_every_channel_that_is_not_soloed() {
    let mut e = mute_solo_engine();
    switch(&mut e, "solo2", true);
    assert_near(render_tail(&mut e, 0.02)[0], 2.0, "only the soloed channel");

    // Solo is additive: soloing a second channel adds it to the bus.
    switch(&mut e, "solo3", true);
    assert_near(render_tail(&mut e, 0.02)[0], 6.0, "two soloed channels");

    // Mute is independent of solo: a muted soloed channel stays silent.
    switch(&mut e, "mute3", true);
    assert_near(render_tail(&mut e, 0.02)[0], 2.0, "muted solo stays silent");

    // Dropping every solo hands the bus back to the un-muted channels.
    switch(&mut e, "solo2", false);
    switch(&mut e, "solo3", false);
    assert_near(render_tail(&mut e, 0.02)[0], 3.0, "solo cleared, 3 muted");
}

/// A mute switch is a jack like any other: CV can gate it.
#[test]
fn mixer_mute_accepts_a_wired_gate() {
    let mut e = mute_solo_engine();
    e.add_module("att", "com.dj.attenuverter").unwrap();
    e.connect("att", "out1", "mx", "mute1").unwrap();
    assert_near(render_tail(&mut e, 0.02)[0], 7.0, "gate low: nothing muted");

    e.set_knob_value("att", "offset1", 5.0).unwrap();
    assert_near(render_tail(&mut e, 0.02)[0], 6.0, "gate high mutes ch 1");
}

/// Toggling mute fades over a few ms — a hard cut would click.
#[test]
fn mixer_mute_fades_instead_of_stepping() {
    let mut e = mute_solo_engine();
    render_tail(&mut e, 0.02);
    switch(&mut e, "mute3", true);
    let out = e.render_offline((0.02 * SR) as usize).unwrap();
    let biggest_step = out[0]
        .windows(2)
        .fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()));
    // 4 V over a 5 ms fade at 48 kHz ~= 0.017 V per sample.
    assert!(
        biggest_step < 0.05,
        "mute should ramp, biggest sample step was {biggest_step} V"
    );
    assert_near(*out[0].last().unwrap(), 3.0, "fade settles at the new mix");
}

#[test]
fn mixer_mute_and_solo_persist_through_save_load() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = mute_solo_engine();
    switch(&mut e, "mute1", true);
    switch(&mut e, "solo2", true);
    e.save_patch(dir.path(), "mixer-mute-solo").unwrap();

    let mut reloaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    assert_near(
        render_tail(&mut reloaded, 0.02)[0],
        2.0,
        "reloaded patch keeps ch 1 muted and ch 2 soloed",
    );
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
    for (i, &src) in out[0].iter().enumerate() {
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

#[test]
fn attenuverter1_single_channel_matches_the_eight_channel_law() {
    let mut e = probe_engine(4);
    for (i, id) in ["unity", "inverted", "offset_only", "scaled"]
        .iter()
        .enumerate()
    {
        e.add_module(id, "com.dj.attenuverter1").unwrap();
        e.set_knob_value(id, "in", 5.0).unwrap();
        probe(&mut e, id, "out", i);
    }

    // "unity" keeps the shipped defaults (atten = +1, offset = 0).
    e.set_knob_value("inverted", "atten", -1.0).unwrap();
    e.set_knob_value("offset_only", "atten", 0.0).unwrap();
    e.set_knob_value("offset_only", "offset", 2.5).unwrap();
    e.set_knob_value("scaled", "atten", 0.5).unwrap();
    e.set_knob_value("scaled", "offset", -4.0).unwrap();

    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 5.0, "default is unity with no offset");
    assert_near(tail[1], -5.0, "inverted unity");
    assert_near(tail[2], 2.5, "muted input passes offset only");
    assert_near(tail[3], -1.5, "half gain plus offset");

    // The output clamps at the ±10 V rails.
    e.set_knob_value("unity", "offset", 10.0).unwrap();
    e.set_knob_value("inverted", "offset", -10.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 10.0, "5 V + 10 V offset clamps at the rail");
    assert_near(tail[1], -10.0, "-5 V - 10 V offset clamps at the rail");
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

#[test]
fn quantizer_custom_scale_mask_selects_the_degrees() {
    // Scale 0 with a custom mask: a saw sweep must visit exactly the
    // masked degrees.
    let mut e = probe_engine(2);
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("q", "com.dj.quantizer").unwrap();
    e.set_knob_position("osc1", "waveform", 1.0 / 3.0).unwrap(); // saw
    e.set_knob_value("osc1", "pitch", -5.0).unwrap(); // ~8 Hz sweep
    e.connect("osc1", "audio", "q", "in").unwrap();
    e.set_knob_position("q", "scale", 0.0).unwrap();
    probe(&mut e, "q", "out", 0);

    // C major triad: degrees {0, 4, 7} -> mask 0b000010010001 = 145.
    let degrees = [0i32, 4, 7];
    let mask: u16 = degrees.iter().map(|d| 1u16 << d).sum();
    e.set_knob_value("q", "custom", mask as f32).unwrap();

    let out = e.render_offline((0.3 * SR) as usize).unwrap();
    let mut seen = std::collections::BTreeSet::new();
    for (i, &v) in out[0].iter().enumerate() {
        let semi = v * 12.0;
        let rounded = semi.round();
        assert!(
            (semi - rounded).abs() < 1e-3,
            "sample {i}: {semi} is not an integer semitone"
        );
        let pc = rounded.rem_euclid(12.0) as i32;
        assert!(
            degrees.contains(&pc),
            "sample {i}: pitch class {pc} off-mask"
        );
        seen.insert(pc);
    }
    assert_eq!(seen.len(), degrees.len(), "sweep must visit every degree");

    // The mask is relative to the root: root = D shifts everything +2.
    e.set_knob_position("q", "root", 2.0 / 11.0).unwrap();
    let out = e.render_offline((0.3 * SR) as usize).unwrap();
    for (i, &v) in out[0].iter().enumerate() {
        let pc = (v * 12.0).round().rem_euclid(12.0) as i32;
        assert!(
            degrees.contains(&((pc - 2).rem_euclid(12))),
            "rooted sample {i}: pitch class {pc} off-mask"
        );
    }

    // An empty mask degenerates to root-only (octaves of D here).
    e.set_knob_value("q", "custom", 0.0).unwrap();
    let out = e.render_offline((0.3 * SR) as usize).unwrap();
    for (i, &v) in out[0].iter().enumerate() {
        let pc = (v * 12.0).round().rem_euclid(12.0) as i32;
        assert_eq!(pc, 2, "empty mask sample {i}: expected the root, got {pc}");
    }

    // Preset scales ignore the mask entirely (mask still 0 here).
    e.set_knob_position("q", "root", 0.0).unwrap();
    e.set_knob_position("q", "scale", 4.0 / 9.0).unwrap(); // pentatonic major
    let out = e.render_offline((0.3 * SR) as usize).unwrap();
    let penta = [0, 2, 4, 7, 9];
    for (i, &v) in out[0].iter().enumerate() {
        let pc = (v * 12.0).round().rem_euclid(12.0) as i32;
        assert!(
            penta.contains(&pc),
            "preset sample {i}: {pc} not pentatonic"
        );
    }
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

// ---------------------------------------------------------------------------
// Sequential switch
// ---------------------------------------------------------------------------

/// Feed one clock pulse (a short high followed by a short low) and return
/// the tail sample of every master channel.
fn clock_once(e: &mut Engine, id: &str) -> Vec<f32> {
    e.set_knob_value(id, "clock", 10.0).unwrap();
    let tail = render_tail(e, 0.002);
    e.set_knob_value(id, "clock", 0.0).unwrap();
    e.render_offline(64).unwrap();
    tail
}

/// A sequential switch with `in` at 7 V and inputs 1..8 at 1..8 V.
fn seq_switch_engine(channels: usize) -> Engine {
    let mut e = probe_engine(channels);
    e.add_module("sw", "com.dj.seq_switch").unwrap();
    e.set_knob_value("sw", "in", 7.0).unwrap();
    for i in 1..=8 {
        e.set_knob_value("sw", &format!("i{i}"), i as f32).unwrap();
    }
    e
}

#[test]
fn seq_switch_clock_advances_both_directions() {
    let mut e = seq_switch_engine(10);
    // Channels 0..7: the 1-to-8 outputs. Channel 8: the 8-to-1 output.
    for step in 0..8 {
        probe(&mut e, "sw", &format!("o{}", step + 1), step);
    }
    probe(&mut e, "sw", "out", 8);

    for step in 0..8 {
        let tail = if step == 0 {
            render_tail(&mut e, 0.002)
        } else {
            clock_once(&mut e, "sw")
        };
        for (out, v) in tail.iter().take(8).enumerate() {
            let want = if out == step { 7.0 } else { 0.0 };
            assert_near(*v, want, &format!("step {step}: 1-to-8 out {out}"));
        }
        assert_near(tail[8], (step + 1) as f32, &format!("step {step}: 8-to-1"));
    }

    // Wraps back to step 1 after the eighth step.
    let tail = clock_once(&mut e, "sw");
    assert_near(tail[0], 7.0, "wrapped to step 1");
    assert_near(tail[8], 1.0, "wrapped to input 1");
}

#[test]
fn seq_switch_step_count_reset_and_mutes() {
    let mut e = seq_switch_engine(2);
    probe(&mut e, "sw", "out", 0);
    probe(&mut e, "sw", "step_cv", 1);

    // Four steps: 1, 2, 3, 4, then back to 1.
    e.set_knob_position("sw", "steps", 2.0 / 6.0).unwrap();
    // The selected input's index (its knob is set to `index` volts).
    let index = |v: f32| v.round() as i32;
    let mut seen = vec![index(render_tail(&mut e, 0.002)[0])];
    for _ in 0..4 {
        seen.push(index(clock_once(&mut e, "sw")[0]));
    }
    assert_eq!(seen, vec![1, 2, 3, 4, 1], "4-step cycle");

    // Reset returns to the first step.
    clock_once(&mut e, "sw");
    e.set_knob_value("sw", "reset", 10.0).unwrap();
    let tail = render_tail(&mut e, 0.002);
    assert_near(tail[0], 1.0, "reset returns to step 1");
    // Step CV reports the centre of the step's address cell.
    assert_near(tail[1], 10.0 * 0.5 / 4.0, "step CV for step 1 of 4");
    e.set_knob_value("sw", "reset", 0.0).unwrap();
    e.render_offline(64).unwrap();

    // Muting step 2 makes the clock skip it.
    e.set_knob_value("sw", "m2", 10.0).unwrap();
    let seen: Vec<i32> = (0..4).map(|_| index(clock_once(&mut e, "sw")[0])).collect();
    assert_eq!(seen, vec![3, 4, 1, 3], "muted step 2 is skipped");
}

#[test]
fn seq_switch_position_survives_a_hot_reload() {
    let mut e = seq_switch_engine(2);
    probe(&mut e, "sw", "out", 0);
    render_tail(&mut e, 0.002);
    clock_once(&mut e, "sw");
    let before = clock_once(&mut e, "sw")[0];
    assert_eq!(before.round() as i32, 3, "clocked to step 3");

    // save_state -> fresh instance -> load_state (PRD §5.4).
    assert_eq!(e.reload_extension("com.dj.seq_switch").unwrap(), 1);
    let after = render_tail(&mut e, 0.002)[0];
    assert_eq!(after.round() as i32, 3, "step position survived the swap");
    let next = clock_once(&mut e, "sw")[0];
    assert_eq!(
        next.round() as i32,
        4,
        "clocking resumes from the same step"
    );
}

#[test]
fn seq_switch_cv_addresses_steps_directly() {
    let mut e = seq_switch_engine(2);
    add_dc(&mut e, "addr", 0.0);
    e.connect("addr", "out1", "sw", "cv").unwrap();
    probe(&mut e, "sw", "out", 0);
    probe(&mut e, "sw", "step_cv", 1);

    // 0..10 V spans the eight steps: each cell is 1.25 V wide.
    for step in 0..8 {
        let volts = (step as f32 + 0.5) * 10.0 / 8.0;
        e.set_knob_value("addr", "offset1", volts).unwrap();
        let tail = render_tail(&mut e, 0.002);
        assert_near(
            tail[0],
            (step + 1) as f32,
            &format!("{volts} V addresses step {step}"),
        );
        // step_cv is the inverse mapping: it addresses the same step.
        assert_near(tail[1], volts, "step CV round-trips the address");
    }

    // While addressed, the clock is ignored.
    let tail = clock_once(&mut e, "sw");
    assert_near(tail[0], 8.0, "clock ignored while CV-addressed");

    // The step count divides the CV range: with 2 steps, 6 V is step 2.
    e.set_knob_position("sw", "steps", 0.0).unwrap();
    e.set_knob_value("addr", "offset1", 6.0).unwrap();
    let tail = render_tail(&mut e, 0.002);
    assert_near(tail[0], 2.0, "6 V of a 2-step range addresses step 2");
}

// ---------------------------------------------------------------------------
// Alias
// ---------------------------------------------------------------------------

#[test]
fn alias_is_a_bit_identical_pass_through() {
    let mut e = probe_engine(2);
    e.add_module("osc", "com.dj.oscillator").unwrap();
    e.add_module("al", "com.dj.alias").unwrap();

    // The same oscillator output feeds channel 0 directly and channel 1
    // through the alias; the render must match sample for sample.
    probe(&mut e, "osc", "audio", 0);
    e.connect("osc", "audio", "al", "in").unwrap();
    probe(&mut e, "al", "out", 1);

    let out = e.render_offline((0.05 * SR) as usize).unwrap();
    let peak = out[0].iter().fold(0.0f32, |m, s| m.max(s.abs()));
    assert!(peak > 4.9, "expected a ±5 source, got {peak}");
    assert_eq!(out[0], out[1], "alias must be bit-identical to its input");
}

#[test]
fn alias_renames_without_touching_the_audio() {
    let mut e = probe_engine(1);
    add_dc(&mut e, "dc", 3.0);
    e.add_module("al", "com.dj.alias").unwrap();
    e.connect("dc", "out1", "al", "in").unwrap();
    probe(&mut e, "al", "out", 0);

    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 3.0, "alias passes the DC source through");

    // The point of the module: give the pass-through a user-typed name.
    // The rename is control-side only, so the signal keeps flowing.
    let id = e.rename_module("al", "Kick Bus").unwrap();
    assert_eq!(id, "kick_bus");
    let info = e.nodes.iter().find(|n| n.instance_id == id).unwrap();
    assert_eq!(info.display_name.as_deref(), Some("Kick Bus"));

    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 3.0, "renamed alias still passes the source");
}

// ---------------------------------------------------------------------------
// Audio Output mute
// ---------------------------------------------------------------------------

#[test]
fn audio_out_mute_kills_the_master_mix() {
    let mut e = probe_engine(2);
    add_dc(&mut e, "dc", 3.0);
    probe(&mut e, "dc", "out1", 0);

    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 3.0, "unmuted output mixes to master");

    // Mute is a switch knob: position 1 = on.
    e.set_knob_position("probe0", "mute", 1.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 0.0, "muted output mixes nothing");

    e.set_knob_position("probe0", "mute", 0.0).unwrap();
    let tail = render_tail(&mut e, 0.01);
    assert_near(tail[0], 3.0, "unmuting restores the mix");
}
