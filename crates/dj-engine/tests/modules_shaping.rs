//! Behaviour tests for the Shaping / Modulation module batch
//! (`com.dj.filter`, `com.dj.vca_dual`, `com.dj.waveshaper`, `com.dj.lfo`,
//! `com.dj.function`, `com.dj.sample_hold`).
//!
//! Each test renders a tiny patch offline and asserts on the samples.

mod common;

use dj_engine::{Engine, EngineConfig};

const SR: f32 = 48_000.0;

fn mono_engine() -> Engine {
    Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        common::registry(),
    )
    .unwrap()
}

fn stereo_engine() -> Engine {
    Engine::new(EngineConfig::default(), common::registry()).unwrap()
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
}

fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

/// Fundamental frequency estimate from zero crossings (positive-going).
fn zero_cross_hz(x: &[f32]) -> f32 {
    let mut first = None;
    let mut last = 0usize;
    let mut count = 0usize;
    for i in 1..x.len() {
        if x[i - 1] <= 0.0 && x[i] > 0.0 {
            if first.is_none() {
                first = Some(i);
            }
            last = i;
            count += 1;
        }
    }
    match first {
        Some(f) if count > 1 => (count - 1) as f32 * SR / (last - f) as f32,
        _ => 0.0,
    }
}

/// Steady-state tail of a render (skips the first 40 %).
fn tail(x: &[f32]) -> &[f32] {
    &x[x.len() * 2 / 5..]
}

// ---------------------------------------------------------------------------
// com.dj.filter
// ---------------------------------------------------------------------------

/// Osc (sine at `pitch`) -> filter -> out, rendered for `secs`.
fn render_filter(topology: f32, cutoff: f32, res: f32, pitch: f32, out_jack: &str) -> Vec<f32> {
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("f1", "com.dj.filter").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "f1", "in").unwrap();
    e.connect("f1", out_jack, "out1", "l").unwrap();
    e.set_knob_value("osc1", "pitch", pitch).unwrap();
    e.set_knob_position("f1", "topology", topology).unwrap();
    e.set_knob_value("f1", "cutoff", cutoff).unwrap();
    e.set_knob_value("f1", "res", res).unwrap();
    e.render_offline((0.4 * SR) as usize)
        .unwrap()
        .pop()
        .unwrap()
}

#[test]
fn filter_lowpass_passes_below_and_rejects_above_cutoff() {
    // 4 octaves below cutoff: essentially unity gain.
    let pass = render_filter(0.0, 2.0, 0.1, -2.0, "lp");
    assert!(
        (rms(tail(&pass)) - 5.0 / std::f32::consts::SQRT_2).abs() < 0.4,
        "passband rms {}",
        rms(tail(&pass))
    );

    // 3 octaves above cutoff: a 2-pole SVF gives ~-36 dB.
    let stop = render_filter(0.0, 0.0, 0.1, 3.0, "lp");
    let g = rms(tail(&stop)) / (5.0 / std::f32::consts::SQRT_2);
    assert!(g < 0.05 && g > 0.002, "stopband gain {g}");
}

#[test]
fn filter_ladder_is_steeper_than_svf() {
    let svf = rms(tail(&render_filter(0.0, 0.0, 0.1, 3.0, "lp")));
    let ladder = rms(tail(&render_filter(0.5, 0.0, 0.1, 3.0, "lp")));
    assert!(
        ladder < svf * 0.25,
        "4-pole ladder {ladder} not steeper than 2-pole svf {svf}"
    );
}

#[test]
fn filter_highpass_rejects_below_cutoff() {
    let stop = render_filter(0.0, 2.0, 0.1, -1.0, "hp");
    let g = rms(tail(&stop)) / (5.0 / std::f32::consts::SQRT_2);
    assert!(g < 0.05, "hp stopband gain {g}");

    let pass = render_filter(0.0, -2.0, 0.1, 2.0, "hp");
    let g = rms(tail(&pass)) / (5.0 / std::f32::consts::SQRT_2);
    assert!(g > 0.9, "hp passband gain {g}");
}

#[test]
fn filter_self_oscillates_as_a_clean_sine() {
    let mut e = mono_engine();
    e.add_module("f1", "com.dj.filter").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("f1", "bp", "out1", "l").unwrap();
    e.set_knob_value("f1", "cutoff", 0.0).unwrap(); // C4 = 261.6 Hz
    e.set_knob_value("f1", "res", 1.0).unwrap();
    let out = e
        .render_offline((2.0 * SR) as usize)
        .unwrap()
        .pop()
        .unwrap();
    let steady = &out[out.len() / 2..];

    let hz = zero_cross_hz(steady);
    assert!(
        (hz - 261.6).abs() / 261.6 < 0.02,
        "self-oscillation at {hz} Hz"
    );
    let p = peak(steady);
    assert!((2.0..8.0).contains(&p), "self-oscillation amplitude {p}");
    // A clean sine has crest factor sqrt(2); clipping or folding lowers it.
    let crest = p / rms(steady);
    assert!(
        (crest - std::f32::consts::SQRT_2).abs() < 0.06,
        "crest factor {crest} — self-oscillation is not sinusoidal"
    );
}

#[test]
fn filter_every_topology_sings_at_full_resonance() {
    for (topo, name) in [(0.0f32, "svf"), (0.5, "ladder"), (1.0, "ota")] {
        for cutoff in [-2.0f32, 0.0, 2.0] {
            let mut e = mono_engine();
            e.add_module("f1", "com.dj.filter").unwrap();
            e.add_module("out1", "builtin.audio_out").unwrap();
            e.connect("f1", "lp", "out1", "l").unwrap();
            e.set_knob_position("f1", "topology", topo).unwrap();
            e.set_knob_value("f1", "cutoff", cutoff).unwrap();
            e.set_knob_value("f1", "res", 1.0).unwrap();
            let out = e
                .render_offline((3.0 * SR) as usize)
                .unwrap()
                .pop()
                .unwrap();
            let steady = &out[out.len() * 2 / 3..];
            let expected = 261.626 * 2.0f32.powf(cutoff);
            let hz = zero_cross_hz(steady);
            let amp = peak(steady);
            println!("{name} @ {expected:.0} Hz: {hz:.1} Hz, {amp:.2} V");
            assert!(
                (hz - expected).abs() / expected < 0.05,
                "{name} @ {expected} Hz: self-oscillates at {hz} Hz"
            );
            assert!(
                (1.0..10.0).contains(&amp),
                "{name} @ {expected} Hz: self-oscillation amplitude {amp}"
            );
        }
    }
}

#[test]
fn filter_stays_finite_under_extreme_drive_and_modulation() {
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("lfo_osc", "com.dj.oscillator").unwrap();
    e.add_module("f1", "com.dj.filter").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "f1", "in").unwrap();
    e.connect("lfo_osc", "audio", "f1", "cutoff_cv").unwrap();
    e.connect("f1", "lp", "out1", "l").unwrap();
    e.set_knob_value("lfo_osc", "pitch", -3.0).unwrap();
    e.set_knob_value("f1", "res", 1.0).unwrap();
    e.set_knob_value("f1", "drive", 10.0).unwrap();
    for topo in [0.0f32, 0.5, 1.0] {
        e.set_knob_position("f1", "topology", topo).unwrap();
        let out = e
            .render_offline((0.3 * SR) as usize)
            .unwrap()
            .pop()
            .unwrap();
        assert!(
            out.iter().all(|v| v.is_finite() && v.abs() <= 15.0),
            "topology {topo}: unstable output"
        );
    }
}

// ---------------------------------------------------------------------------
// com.dj.waveshaper
// ---------------------------------------------------------------------------

/// Osc (sine at `pitch`) -> waveshaper -> out. Also returns the raw
/// oscillator signal (same phase evolution) for reference measurements.
fn render_shaper(mode: f32, drive: f32, pitch: f32, secs: f32) -> (Vec<f32>, Vec<f32>) {
    let frames = (secs * SR) as usize;
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("w1", "com.dj.waveshaper").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "w1", "in").unwrap();
    e.connect("w1", "out", "out1", "l").unwrap();
    e.set_knob_value("osc1", "pitch", pitch).unwrap();
    e.set_knob_position("w1", "mode", mode).unwrap();
    e.set_knob_value("w1", "drive", drive).unwrap();
    let shaped = e.render_offline(frames).unwrap().pop().unwrap();

    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "out1", "l").unwrap();
    e.set_knob_value("osc1", "pitch", pitch).unwrap();
    let raw = e.render_offline(frames).unwrap().pop().unwrap();
    (shaped, raw)
}

/// Energy left after a 48-sample boxcar (a 1 kHz-ish lowpass with a null
/// comb): for a >6 kHz input this is essentially the alias floor.
fn low_band_rms(x: &[f32]) -> f32 {
    let w = 48;
    let filtered: Vec<f32> = x
        .windows(w)
        .map(|c| c.iter().sum::<f32>() / w as f32)
        .collect();
    rms(tail(&filtered))
}

#[test]
fn waveshaper_saturator_soft_clips() {
    let (soft, raw) = render_shaper(1.0 / 3.0, 2.0, 0.0, 0.2);
    // Normalized so full scale stays at 5 V, but the waveform is fattened.
    assert!((peak(&soft) - 5.0).abs() < 0.15, "peak {}", peak(&soft));
    assert!(rms(tail(&soft)) > rms(tail(&raw)) * 1.15, "no compression");

    // Hard drive pushes it towards a square: crest factor collapses to 1.
    let (hard, _) = render_shaper(1.0 / 3.0, 10.0, 0.0, 0.2);
    let crest = peak(&hard) / rms(tail(&hard));
    assert!(crest < 1.2, "crest factor {crest} — not squared up");
}

#[test]
fn waveshaper_folder_folds_repeatedly() {
    let (folded, raw) = render_shaper(0.0, 8.0, 0.0, 0.2);
    let in_hz = zero_cross_hz(tail(&raw));
    let out_hz = zero_cross_hz(tail(&folded));
    // Every fold adds a pair of zero crossings per cycle.
    assert!(
        out_hz > in_hz * 5.0,
        "folder zero-crossing rate {out_hz} vs input {in_hz}"
    );
    assert!(
        peak(&folded) <= 5.05,
        "folder overshoots: {}",
        peak(&folded)
    );
}

#[test]
fn waveshaper_folder_antialiases() {
    // 6.9 kHz: the 7th harmonic lands at 48.3 kHz and aliases to ~300 Hz,
    // right in the passband of the boxcar below.
    let pitch = (6900.0f32 / 261.626).log2();
    let drive = 5.0f32;
    let (folded, raw) = render_shaper(0.0, drive, pitch, 0.3);

    // Same nonlinearity, evaluated naively sample by sample.
    let a = std::f32::consts::FRAC_PI_2 * (1.0 + drive);
    let naive: Vec<f32> = raw.iter().map(|x| 5.0 * (a * x / 5.0).sin()).collect();

    let aliased = low_band_rms(&naive);
    let clean = low_band_rms(&folded);
    assert!(aliased > 0.05, "reference has no alias energy ({aliased})");
    assert!(
        clean < aliased * 0.5,
        "ADAA alias floor {clean} vs naive {aliased}"
    );
}

#[test]
fn waveshaper_bitcrusher_quantizes() {
    let (crushed, _) = render_shaper(2.0 / 3.0, 10.0, 0.0, 0.1);
    // 1 bit at full amount: only -5, 0 and +5 V survive.
    for &v in &crushed {
        let q = v / 5.0;
        assert!(
            (q - q.round()).abs() < 1e-4 && q.abs() <= 1.0,
            "unquantized sample {v}"
        );
    }
    let distinct = crushed
        .iter()
        .map(|v| (v / 5.0).round() as i32)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(distinct.len(), 3, "expected 3 levels, got {distinct:?}");
}

#[test]
fn waveshaper_rate_reducer_holds() {
    let (held, _) = render_shaper(1.0, 10.0, 0.0, 0.1);
    let mut runs = Vec::new();
    let mut run = 1usize;
    for i in 1..held.len() {
        if held[i] == held[i - 1] {
            run += 1;
        } else {
            runs.push(run);
            run = 1;
        }
    }
    // Full amount holds every 128 samples.
    let interior = &runs[1..runs.len() - 1];
    assert!(!interior.is_empty(), "no held steps");
    assert!(
        interior.iter().all(|&r| r == 128),
        "hold lengths not 128: {:?}",
        &interior[..interior.len().min(8)]
    );
}

#[test]
fn waveshaper_bias_keeps_silence_silent() {
    for mode in [0.0f32, 1.0 / 3.0, 2.0 / 3.0, 1.0] {
        let mut e = mono_engine();
        e.add_module("w1", "com.dj.waveshaper").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.connect("w1", "out", "out1", "l").unwrap();
        e.set_knob_position("w1", "mode", mode).unwrap();
        e.set_knob_value("w1", "bias", 3.0).unwrap();
        let out = e.render_offline(4800).unwrap().pop().unwrap();
        assert!(
            peak(tail(&out)) < 1e-4,
            "mode {mode}: bias leaks DC ({})",
            peak(tail(&out))
        );
    }
}

// ---------------------------------------------------------------------------
// com.dj.vca_dual
// ---------------------------------------------------------------------------

/// Osc (sine, C4) -> vca_dual ch1 -> out, with the given CV and response.
fn render_vca(cv: f32, exponential: bool) -> Vec<f32> {
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("v1", "com.dj.vca_dual").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "v1", "in1").unwrap();
    e.connect("v1", "out1", "out1", "l").unwrap();
    e.set_knob_value("v1", "cv1", cv).unwrap();
    e.set_knob_position("v1", "resp1", if exponential { 1.0 } else { 0.0 })
        .unwrap();
    e.render_offline((0.2 * SR) as usize)
        .unwrap()
        .pop()
        .unwrap()
}

#[test]
fn vca_dual_linear_response_scales_amplitude() {
    assert!((peak(&render_vca(10.0, false)) - 5.0).abs() < 0.01);
    assert!((peak(&render_vca(5.0, false)) - 2.5).abs() < 0.01);
    assert!(peak(&render_vca(0.0, false)) < 1e-6);
}

#[test]
fn vca_dual_exponential_response_is_below_linear_and_closes_fully() {
    let lin = peak(&render_vca(5.0, false));
    let exp = peak(&render_vca(5.0, true));
    assert!(exp < lin * 0.3 && exp > 0.05, "exp {exp} vs lin {lin}");
    // Both tapers still reach unity at the top and silence at the bottom.
    assert!((peak(&render_vca(10.0, true)) - 5.0).abs() < 0.01);
    assert!(peak(&render_vca(0.0, true)) < 1e-6);
}

#[test]
fn vca_dual_is_dc_coupled_and_offsets() {
    let mut e = mono_engine();
    // v0 is used as a pure DC source via its channel-1 offset.
    e.add_module("v0", "com.dj.vca_dual").unwrap();
    e.add_module("v1", "com.dj.vca_dual").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("v0", "out1", "v1", "in1").unwrap();
    e.connect("v1", "out1", "out1", "l").unwrap();
    e.set_knob_value("v0", "offset1", 4.0).unwrap();
    e.set_knob_value("v1", "cv1", 5.0).unwrap(); // linear: gain 0.5
    e.set_knob_value("v1", "offset1", -1.0).unwrap();
    let out = e
        .render_offline((1.0 * SR) as usize)
        .unwrap()
        .pop()
        .unwrap();
    // 4 V * 0.5 - 1 V = 1 V, and it must not droop over a full second.
    for &v in tail(&out) {
        assert!((v - 1.0).abs() < 1e-3, "dc output {v}");
    }
}

#[test]
fn vca_dual_channel_two_normals_the_mix_bus() {
    // In 2 unpatched: Out 2 carries channel 1 as well.
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("v1", "com.dj.vca_dual").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "v1", "in1").unwrap();
    e.connect("v1", "out2", "out1", "l").unwrap();
    e.set_knob_value("v1", "cv1", 5.0).unwrap();
    let normalled = e
        .render_offline((0.2 * SR) as usize)
        .unwrap()
        .pop()
        .unwrap();
    assert!(
        (peak(&normalled) - 2.5).abs() < 0.01,
        "normalled mix missing"
    );

    // In 2 patched (to a silent source): the normalling breaks.
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("silent", "com.dj.vca_dual").unwrap();
    e.add_module("v1", "com.dj.vca_dual").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "v1", "in1").unwrap();
    e.connect("silent", "out1", "v1", "in2").unwrap();
    e.connect("v1", "out2", "out1", "l").unwrap();
    let split = e
        .render_offline((0.2 * SR) as usize)
        .unwrap()
        .pop()
        .unwrap();
    assert!(
        peak(&split) < 1e-6,
        "normalling not broken by a patched In 2"
    );
}

// ---------------------------------------------------------------------------
// com.dj.lfo
// ---------------------------------------------------------------------------

const SHAPE_SINE: f32 = 0.0;
const SHAPE_SAW_UP: f32 = 2.0 / 6.0;
const SHAPE_PULSE: f32 = 4.0 / 6.0;
const SHAPE_SH: f32 = 5.0 / 6.0;

/// A free-running LFO rendered on the master (bipolar out).
fn render_lfo(shape: f32, rate: f32, secs: f32) -> Vec<f32> {
    let mut e = mono_engine();
    e.add_module("lfo1", "com.dj.lfo").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("lfo1", "bi", "out1", "l").unwrap();
    e.set_knob_position("lfo1", "shape", shape).unwrap();
    e.set_knob_value("lfo1", "rate", rate).unwrap();
    e.render_offline((secs * SR) as usize)
        .unwrap()
        .pop()
        .unwrap()
}

#[test]
fn lfo_runs_from_sub_hertz_to_audio_rate() {
    for rate in [0.5f32, 5.0, 200.0, 2000.0] {
        let out = render_lfo(SHAPE_SINE, rate, 4.0 / rate.min(20.0));
        let hz = zero_cross_hz(&out);
        assert!(
            (hz - rate).abs() / rate < 0.03,
            "asked {rate} Hz, measured {hz} Hz"
        );
        assert!((peak(&out) - 5.0).abs() < 0.2, "amplitude {}", peak(&out));
    }
}

#[test]
fn lfo_unipolar_output_tracks_bipolar() {
    let mut e = stereo_engine();
    e.add_module("lfo1", "com.dj.lfo").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("lfo1", "bi", "out1", "l").unwrap();
    e.connect("lfo1", "uni", "out1", "r").unwrap();
    e.set_knob_value("lfo1", "rate", 20.0).unwrap();
    let out = e.render_offline((0.5 * SR) as usize).unwrap();
    for (b, u) in out[0].iter().zip(&out[1]) {
        assert!((u - (b + 5.0)).abs() < 1e-5, "uni {u} vs bi {b}");
        assert!((-0.001..=10.001).contains(u), "unipolar out of range: {u}");
    }
}

#[test]
fn lfo_saw_is_antialiased_at_audio_rate() {
    // Same alias probe as the waveshaper: at 6.9 kHz the harmonics near
    // multiples of the sample rate fold down into the boxcar's passband.
    let out = render_lfo(SHAPE_SAW_UP, 6900.0, 0.3);
    let hz = zero_cross_hz(&out);
    let naive: Vec<f32> = (0..out.len())
        .map(|i| {
            let p = (hz * i as f32 / SR).fract();
            5.0 * (2.0 * p - 1.0)
        })
        .collect();
    let aliased = low_band_rms(&naive);
    let clean = low_band_rms(&out);
    assert!(aliased > 0.05, "reference has no alias energy ({aliased})");
    assert!(
        clean < aliased * 0.3,
        "PolyBLEP alias floor {clean} vs naive {aliased}"
    );
}

#[test]
fn lfo_syncs_to_a_clock_with_multiplier_and_divider() {
    // clk is a 4 Hz pulse LFO (unipolar, so a clean 0/10 gate).
    for (ratio_pos, expected) in [(5.0 / 8.0, 8.0f32), (3.0 / 8.0, 2.0)] {
        let mut e = mono_engine();
        e.add_module("clk", "com.dj.lfo").unwrap();
        e.add_module("lfo1", "com.dj.lfo").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.set_knob_position("clk", "shape", SHAPE_PULSE).unwrap();
        e.set_knob_value("clk", "rate", 4.0).unwrap();
        e.connect("clk", "uni", "lfo1", "clock").unwrap();
        e.connect("lfo1", "bi", "out1", "l").unwrap();
        e.set_knob_position("lfo1", "shape", SHAPE_SAW_UP).unwrap();
        e.set_knob_value("lfo1", "rate", 2.0).unwrap(); // ignored while synced
        e.set_knob_position("lfo1", "ratio", ratio_pos).unwrap();
        let out = e
            .render_offline((3.0 * SR) as usize)
            .unwrap()
            .pop()
            .unwrap();
        let hz = zero_cross_hz(tail(&out));
        assert!(
            (hz - expected).abs() / expected < 0.05,
            "ratio {ratio_pos}: expected {expected} Hz, got {hz} Hz"
        );
    }
}

#[test]
fn lfo_reset_restarts_the_cycle() {
    let mut e = mono_engine();
    e.add_module("clk", "com.dj.lfo").unwrap();
    e.add_module("lfo1", "com.dj.lfo").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.set_knob_position("clk", "shape", SHAPE_PULSE).unwrap();
    e.set_knob_value("clk", "rate", 10.0).unwrap();
    e.connect("clk", "uni", "lfo1", "reset").unwrap();
    e.connect("lfo1", "bi", "out1", "l").unwrap();
    e.set_knob_position("lfo1", "shape", SHAPE_SAW_UP).unwrap();
    e.set_knob_value("lfo1", "rate", 3.0).unwrap();
    let out = e
        .render_offline((2.0 * SR) as usize)
        .unwrap()
        .pop()
        .unwrap();
    // Restarted every 100 ms, a 3 Hz ramp only ever climbs 30 % of its
    // -5..+5 V travel: it sweeps -5 V to -2 V, mean -3.5 V, where a
    // free-running one would average 0 V and spend 40 % of its time above
    // -1 V. (The odd sample right at a reset reads 0 V: the PolyBLEP
    // correction straddles the jump.)
    let steady = tail(&out);
    let mean = steady.iter().sum::<f32>() / steady.len() as f32;
    assert!(
        (mean + 3.5).abs() < 0.3,
        "mean {mean} V — resets not landing"
    );
    let high = steady.iter().filter(|&&v| v > -1.0).count();
    assert!(
        (high as f32) < 0.01 * steady.len() as f32,
        "{high} samples climbed past -1 V despite resets"
    );
}

#[test]
fn lfo_sample_and_hold_shape_is_stepped() {
    let out = render_lfo(SHAPE_SH, 10.0, 1.0);
    let mut changes = 0;
    let mut run = 1usize;
    let mut runs = Vec::new();
    for i in 1..out.len() {
        if out[i] != out[i - 1] {
            changes += 1;
            runs.push(run);
            run = 1;
        } else {
            run += 1;
        }
    }
    // One step per 10 Hz cycle over a second (the tenth lands on the very
    // last frame, so 9 or 10 transitions are both correct).
    assert!((9..=10).contains(&changes), "{changes} steps in 1 s");
    for &r in &runs[1..] {
        assert!((4790..=4810).contains(&r), "step length {r}");
    }
    assert!(peak(&out) > 0.5, "stepped random is stuck at zero");
}

#[test]
fn lfo_shifted_output_lags_by_the_phase_knob() {
    let mut e = stereo_engine();
    e.add_module("lfo1", "com.dj.lfo").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("lfo1", "bi", "out1", "l").unwrap();
    e.connect("lfo1", "shifted", "out1", "r").unwrap();
    e.set_knob_value("lfo1", "rate", 5.0).unwrap();
    e.set_knob_value("lfo1", "phase", 0.25).unwrap();
    let out = e.render_offline((1.0 * SR) as usize).unwrap();
    let lag = (0.25 * SR / 5.0) as usize; // quarter cycle at 5 Hz
    for i in (SR as usize / 2)..out[0].len() {
        assert!(
            (out[1][i] - out[0][i - lag]).abs() < 0.02,
            "shifted output does not lag by a quarter cycle at {i}"
        );
    }
}

// ---------------------------------------------------------------------------
// com.dj.sample_hold
// ---------------------------------------------------------------------------

/// A clock LFO (pulse, `rate` Hz, unipolar) driving a Sample & Hold.
/// Left channel is the S&H output, right channel the clock's own bipolar
/// signal or the patched source, depending on `source`.
fn sample_hold_patch(e: &mut Engine, rate: f32) {
    e.add_module("clk", "com.dj.lfo").unwrap();
    e.add_module("sh1", "com.dj.sample_hold").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.set_knob_position("clk", "shape", SHAPE_PULSE).unwrap();
    e.set_knob_value("clk", "rate", rate).unwrap();
    e.connect("clk", "uni", "sh1", "trig").unwrap();
    e.connect("sh1", "out", "out1", "l").unwrap();
}

/// Runs of identical samples in a signal.
fn runs(x: &[f32]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut run = 1usize;
    for i in 1..x.len() {
        if x[i] == x[i - 1] {
            run += 1;
        } else {
            out.push(run);
            run = 1;
        }
    }
    out.push(run);
    out
}

#[test]
fn sample_hold_normals_its_own_noise() {
    let mut e = mono_engine();
    sample_hold_patch(&mut e, 10.0);
    let out = e.render_offline(SR as usize).unwrap().pop().unwrap();

    // One fresh random value per clock (9 or 10 edges land inside 1 s).
    let steps = runs(&out);
    assert!(
        (10..=11).contains(&steps.len()),
        "{} held segments in 1 s",
        steps.len()
    );
    for &r in &steps[1..steps.len() - 1] {
        assert!((4790..=4810).contains(&r), "hold length {r}");
    }
    let values: Vec<f32> = out.chunks(4800).map(|c| c[100]).collect();
    assert!(values.iter().all(|v| v.abs() <= 5.0), "noise out of range");
    assert!(
        values.windows(2).all(|w| w[0] != w[1]),
        "held values repeat: {values:?}"
    );

    // Deterministic: the same patch renders the same sequence.
    let mut e2 = mono_engine();
    sample_hold_patch(&mut e2, 10.0);
    let again = e2.render_offline(SR as usize).unwrap().pop().unwrap();
    assert_eq!(out, again, "noise is not deterministic");
}

#[test]
fn sample_hold_noise_output_is_white_and_full_scale() {
    let mut e = mono_engine();
    e.add_module("sh1", "com.dj.sample_hold").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("sh1", "noise", "out1", "l").unwrap();
    let out = e.render_offline(SR as usize).unwrap().pop().unwrap();
    let mean = out.iter().sum::<f32>() / out.len() as f32;
    assert!(mean.abs() < 0.05, "noise mean {mean}");
    // Uniform white noise over ±5 V has an RMS of 5/sqrt(3).
    let expected = 5.0 / 3.0f32.sqrt();
    assert!(
        (rms(&out) - expected).abs() < 0.1,
        "noise rms {}",
        rms(&out)
    );
    assert!(peak(&out) > 4.9 && peak(&out) <= 5.0, "noise peak");
}

#[test]
fn sample_hold_samples_a_patched_source() {
    let mut e = stereo_engine();
    sample_hold_patch(&mut e, 8.0);
    e.add_module("saw", "com.dj.lfo").unwrap();
    e.set_knob_position("saw", "shape", SHAPE_SAW_UP).unwrap();
    e.set_knob_value("saw", "rate", 1.0).unwrap();
    e.connect("saw", "bi", "sh1", "in").unwrap();
    e.connect("saw", "bi", "out1", "r").unwrap();
    let out = e.render_offline(SR as usize).unwrap();

    // Each held value is the ramp at the instant of the clock edge, and
    // the staircase climbs with it.
    let mut prev = f32::MIN;
    let mut checked = 0;
    for step in 1..8 {
        let at = step * 6000;
        let held = out[0][at + 10];
        let source = out[1][at + 1];
        assert!(
            (held - source).abs() < 0.02,
            "step {step}: held {held} vs source {source}"
        );
        assert!(held > prev, "staircase not climbing at step {step}");
        prev = held;
        checked += 1;
    }
    assert_eq!(checked, 7);
    // The normalled noise must not leak once `in` is patched.
    assert!(runs(&out[0]).len() < 12, "output is not a clean staircase");
}

#[test]
fn sample_hold_track_and_hold_mode() {
    let mut e = stereo_engine();
    sample_hold_patch(&mut e, 4.0);
    e.add_module("saw", "com.dj.lfo").unwrap();
    e.set_knob_position("saw", "shape", SHAPE_SAW_UP).unwrap();
    e.set_knob_value("saw", "rate", 1.0).unwrap();
    e.connect("saw", "bi", "sh1", "in").unwrap();
    e.connect("saw", "bi", "out1", "r").unwrap();
    e.set_knob_position("sh1", "mode", 1.0).unwrap(); // track & hold
    let out = e.render_offline(SR as usize).unwrap();

    // Clock high for the first half of each 250 ms window: tracking.
    for i in [2000usize, 5000, 14000] {
        assert!(
            (out[0][i] - out[1][i]).abs() < 1e-5,
            "not tracking at {i}: {} vs {}",
            out[0][i],
            out[1][i]
        );
    }
    // Clock low for the second half: frozen.
    for start in [7000usize, 19000] {
        let held = out[0][start];
        for (i, &v) in out[0].iter().enumerate().skip(start).take(4000) {
            assert!((v - held).abs() < 1e-6, "not holding at {i}");
        }
    }
}

#[test]
fn sample_hold_slew_glides_between_steps() {
    let mut e = mono_engine();
    sample_hold_patch(&mut e, 4.0);
    e.set_knob_value("sh1", "slew", 0.05).unwrap();
    let out = e.render_offline(SR as usize).unwrap().pop().unwrap();
    let max_step = out
        .windows(2)
        .map(|w| (w[1] - w[0]).abs())
        .fold(0.0f32, f32::max);
    // A one-pole lag of 50 ms can move at most step/2400 per sample.
    assert!(max_step < 0.01, "slew still jumps by {max_step} V");
    assert!(peak(tail(&out)) > 0.5, "slewed output collapsed to nothing");
}

// ---------------------------------------------------------------------------
// com.dj.function
// ---------------------------------------------------------------------------

/// MIDI note gate -> `jack` of a Function module -> master. The note runs
/// from `on_t` to `off_t` seconds.
fn render_function_gate(jack: &str, rise: f32, fall: f32, on_t: f32, off_t: f32) -> Vec<f32> {
    let mut e = mono_engine();
    e.add_module("midi1", "builtin.midi").unwrap();
    e.add_module("fn1", "com.dj.function").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.add_midi_mapping("midi1", "note", 60, "pad_1").unwrap();
    e.connect("midi1", "pad_1", "fn1", jack).unwrap();
    e.connect("fn1", "out", "out1", "l").unwrap();
    e.set_knob_value("fn1", "rise", rise).unwrap();
    e.set_knob_value("fn1", "fall", fall).unwrap();
    e.inject_midi("midi1", (on_t * SR) as u64, [0x90, 60, 100])
        .unwrap();
    e.inject_midi("midi1", (off_t * SR) as u64, [0x80, 60, 0])
        .unwrap();
    e.render_offline(SR as usize).unwrap().pop().unwrap()
}

#[test]
fn function_trigger_makes_an_attack_decay_shape() {
    let out = render_function_gate("trig", 0.05, 0.1, 0.1, 0.15);
    let at = |t: f32| out[(t * SR) as usize];
    assert!(at(0.099) < 0.01, "not idle before the trigger");
    assert!(at(0.125) > 4.0 && at(0.125) < 6.0, "mid-rise {}", at(0.125));
    assert!(at(0.151) > 9.8, "peak {}", at(0.151));
    // A trigger ignores the gate's release: the fall runs to completion.
    assert!((at(0.2) - 5.0).abs() < 0.3, "mid-fall {}", at(0.2));
    assert!(at(0.26) < 0.01, "did not return to zero: {}", at(0.26));
}

#[test]
fn function_gate_sustains_at_the_top() {
    let out = render_function_gate("gate", 0.05, 0.1, 0.1, 0.5);
    let at = |t: f32| out[(t * SR) as usize];
    assert!(at(0.16) > 9.99 && at(0.45) > 9.99, "gate did not sustain");
    assert!((at(0.55) - 5.0).abs() < 0.3, "mid-fall {}", at(0.55));
    assert!(at(0.61) < 0.01, "did not return to zero: {}", at(0.61));
}

#[test]
fn function_cycle_is_an_lfo_with_a_matching_eor_square() {
    let mut e = stereo_engine();
    e.add_module("fn1", "com.dj.function").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("fn1", "out", "out1", "l").unwrap();
    e.connect("fn1", "eor", "out1", "r").unwrap();
    e.set_knob_value("fn1", "rise", 0.02).unwrap();
    e.set_knob_value("fn1", "fall", 0.03).unwrap();
    e.set_knob_position("fn1", "cycle", 1.0).unwrap();
    let out = e.render_offline(SR as usize).unwrap();

    // 20 ms up + 30 ms down = 20 Hz.
    let centered: Vec<f32> = out[0].iter().map(|v| v - 5.0).collect();
    let hz = zero_cross_hz(&centered);
    assert!((hz - 20.0).abs() < 0.5, "cycling at {hz} Hz");
    assert!(out[0].iter().all(|&v| (-0.01..=10.01).contains(&v)));

    // EOR is high for the fall: 30 of every 50 ms.
    let duty = out[1].iter().filter(|&&v| v > 5.0).count() as f32 / out[1].len() as f32;
    assert!((duty - 0.6).abs() < 0.02, "EOR duty {duty}");
}

#[test]
fn function_eoc_triggers_a_second_function() {
    let mut e = stereo_engine();
    e.add_module("fn1", "com.dj.function").unwrap();
    e.add_module("fn2", "com.dj.function").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("fn1", "eoc", "out1", "l").unwrap();
    e.connect("fn1", "eoc", "fn2", "trig").unwrap();
    e.connect("fn2", "out", "out1", "r").unwrap();
    e.set_knob_value("fn1", "rise", 0.04).unwrap();
    e.set_knob_value("fn1", "fall", 0.06).unwrap();
    e.set_knob_position("fn1", "cycle", 1.0).unwrap();
    e.set_knob_value("fn2", "rise", 0.005).unwrap();
    e.set_knob_value("fn2", "fall", 0.005).unwrap();
    let out = e.render_offline(SR as usize).unwrap();

    // One 2 ms trigger per 100 ms cycle.
    let mut pulses = 0;
    let mut width = 0usize;
    let mut run = 0usize;
    for i in 1..out[0].len() {
        if out[0][i] > 5.0 && out[0][i - 1] <= 5.0 {
            pulses += 1;
            run = 1;
        } else if out[0][i] > 5.0 {
            run += 1;
        } else if run > 0 {
            width = run;
            run = 0;
        }
    }
    // Ten 100 ms cycles per second; the tenth end-of-cycle lands one sample
    // past the render, so nine or ten pulses are both right.
    assert!((9..=10).contains(&pulses), "{pulses} EOC pulses per second");
    assert_eq!(width, (0.002 * SR) as usize, "EOC pulse width");

    // The chained function answers every one of them.
    let hits = out[1]
        .windows(2)
        .filter(|w| w[0] <= 9.9 && w[1] > 9.9)
        .count();
    assert_eq!(hits, pulses, "chained function did not fire on every EOC");
}

#[test]
fn function_slews_at_the_configured_rate() {
    // A 2 Hz bipolar square steps ±5 V; rise 0.1 s / fall 0.2 s means the
    // output may only travel 10 V per 0.1 s up and 10 V per 0.2 s down.
    let mut e = mono_engine();
    e.add_module("sq", "com.dj.lfo").unwrap();
    e.add_module("fn1", "com.dj.function").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.set_knob_position("sq", "shape", SHAPE_PULSE).unwrap();
    e.set_knob_value("sq", "rate", 2.0).unwrap();
    e.connect("sq", "bi", "fn1", "in").unwrap();
    e.connect("fn1", "out", "out1", "l").unwrap();
    e.set_knob_value("fn1", "rise", 0.1).unwrap();
    e.set_knob_value("fn1", "fall", 0.2).unwrap();
    let out = e
        .render_offline((2.0 * SR) as usize)
        .unwrap()
        .pop()
        .unwrap();

    let up = 10.0 / (0.1 * SR);
    let down = 10.0 / (0.2 * SR);
    let mut max_up = 0.0f32;
    let mut max_down = 0.0f32;
    for w in tail(&out).windows(2) {
        let d = w[1] - w[0];
        max_up = max_up.max(d);
        max_down = max_down.max(-d);
    }
    assert!(
        (max_up - up).abs() < up * 0.02,
        "rise slope {max_up} vs {up}"
    );
    assert!(
        (max_down - down).abs() < down * 0.02,
        "fall slope {max_down} vs {down}"
    );
    assert!(peak(&out) <= 5.01, "slew overshoots the input");
}

#[test]
fn function_follows_an_audio_envelope() {
    // Fast rise, slow fall on a raw audio signal: the output snaps to each
    // positive peak and decays between them — an envelope follower with no
    // extra mode switch.
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("fn1", "com.dj.function").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "fn1", "in").unwrap();
    e.connect("fn1", "out", "out1", "l").unwrap();
    e.set_knob_value("fn1", "rise", 0.001).unwrap();
    e.set_knob_value("fn1", "fall", 0.05).unwrap();
    let out = e
        .render_offline((0.5 * SR) as usize)
        .unwrap()
        .pop()
        .unwrap();
    let steady = tail(&out);
    let lo = steady.iter().fold(f32::MAX, |m, &v| m.min(v));
    let hi = steady.iter().fold(f32::MIN, |m, &v| m.max(v));
    assert!(hi <= 5.01 && hi > 4.9, "envelope top {hi}");
    assert!(lo > 3.5, "envelope dips to {lo} — not following the peaks");
}

#[test]
fn function_curve_bends_the_rise() {
    let quarter = |curve: f32| {
        let mut e = mono_engine();
        e.add_module("fn1", "com.dj.function").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.connect("fn1", "out", "out1", "l").unwrap();
        e.set_knob_value("fn1", "rise", 0.1).unwrap();
        e.set_knob_value("fn1", "fall", 0.1).unwrap();
        e.set_knob_value("fn1", "curve", curve).unwrap();
        e.set_knob_position("fn1", "cycle", 1.0).unwrap();
        let out = e
            .render_offline((0.5 * SR) as usize)
            .unwrap()
            .pop()
            .unwrap();
        out[(0.025 * SR) as usize] // a quarter of the way up the first rise
    };
    let (fast, lin, slow) = (quarter(1.0), quarter(0.0), quarter(-1.0));
    assert!((lin - 2.5).abs() < 0.2, "linear quarter point {lin}");
    assert!(
        fast > lin + 2.0,
        "positive curve is not fast-starting: {fast}"
    );
    assert!(
        slow < lin - 2.0,
        "negative curve is not slow-starting: {slow}"
    );
}
