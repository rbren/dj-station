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
