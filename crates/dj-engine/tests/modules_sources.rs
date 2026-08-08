//! Behaviour tests for the Sources module batch: VCO, Wavetable, Noise and
//! Drum. Each case renders a short patch offline and asserts on the samples
//! (frequency, spectrum, envelope timing, alias rejection).

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

/// Render `seconds` of the master bus (channel 0).
fn render(engine: &mut Engine, seconds: f32) -> Vec<f32> {
    engine
        .render_offline((seconds * SR) as usize)
        .unwrap()
        .remove(0)
}

/// Amplitude of the sinusoidal component at `freq` (Hann-windowed one-bin
/// DFT). Returns the peak amplitude of that component, in signal units.
fn amp_at(x: &[f32], freq: f32) -> f32 {
    let n = x.len() as f64;
    let (mut re, mut im, mut wsum) = (0.0f64, 0.0f64, 0.0f64);
    let w0 = std::f64::consts::TAU * freq as f64 / SR as f64;
    for (i, &v) in x.iter().enumerate() {
        let w = 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n).cos();
        let ph = w0 * i as f64;
        re += w * v as f64 * ph.cos();
        im -= w * v as f64 * ph.sin();
        wsum += w;
    }
    2.0 * (re * re + im * im).sqrt() as f32 / wsum as f32
}

fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0f32, |m, &v| m.max(v.abs()))
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|&v| (v * v) as f64).sum::<f64>() / x.len() as f64).sqrt() as f32
}

/// Rising zero crossings per second.
fn zero_cross_rate(x: &[f32]) -> f32 {
    let mut n = 0usize;
    for w in x.windows(2) {
        if w[0] <= 0.0 && w[1] > 0.0 {
            n += 1;
        }
    }
    n as f32 / (x.len() as f32 / SR)
}

/// Pitch value (1V/oct, 0 = C4) for a frequency in Hz.
fn pitch_of(hz: f32) -> f32 {
    (hz / 261.626).log2()
}

/// Patch `<ext>:<out>` straight into the mono master bus.
fn source_patch(ext: &str, out_jack: &str) -> Engine {
    let mut e = mono_engine();
    e.add_module("src", ext).unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("src", out_jack, "out1", "l").unwrap();
    e
}

// ---------------------------------------------------------------------------
// VCO
// ---------------------------------------------------------------------------

#[test]
fn vco_shapes_have_expected_pitch_and_amplitude() {
    // Band-limited edges ring (Gibbs), so the discontinuous shapes overshoot
    // the ±5 nominal a little; the smooth ones must not.
    for (jack, max_peak) in [
        ("saw", 6.0f32),
        ("pulse", 6.0),
        ("sine", 5.05),
        ("tri", 5.2),
    ] {
        let mut e = source_patch("com.dj.vco", jack);
        e.set_knob_value("src", "pitch", pitch_of(220.0)).unwrap();
        let out = render(&mut e, 1.0);
        // Skip the integrator's start-up transient on the triangle.
        let body = &out[4_800..];
        assert!(
            (zero_cross_rate(body) - 220.0).abs() < 1.5,
            "{jack}: rate {} != 220",
            zero_cross_rate(body)
        );
        let p = peak(body);
        assert!(p > 4.8 && p < max_peak, "{jack}: peak {p} out of range");
        // Fundamental amplitude of each ideal shape at ±5.
        let expected_fund = match jack {
            "saw" => 2.0 * 5.0 / std::f32::consts::PI,
            "pulse" => 4.0 * 5.0 / std::f32::consts::PI,
            "tri" => 8.0 * 5.0 / (std::f32::consts::PI * std::f32::consts::PI),
            _ => 5.0,
        };
        let got = amp_at(body, 220.0);
        assert!(
            (got - expected_fund).abs() < 0.1 * expected_fund,
            "{jack}: fundamental {got} != {expected_fund}"
        );
    }
}

/// Frequency `f` folded into [0, SR/2].
fn fold(f: f32) -> f32 {
    let m = f % SR;
    if m > SR / 2.0 {
        SR - m
    } else {
        m
    }
}

#[test]
fn vco_saw_is_clean_above_5khz() {
    // 3111 and 5000 Hz are both non-integer divisors of 48 kHz, so no image
    // lands on a real harmonic and every measurement is pure alias.
    for f0 in [3_111.0f32, 5_000.0] {
        let mut e = source_patch("com.dj.vco", "saw");
        e.set_knob_value("src", "pitch", pitch_of(f0)).unwrap();
        let out = render(&mut e, 0.5);
        let body = &out[4_800..];

        let fund = amp_at(body, f0);
        assert!(
            (fund - 2.0 * 5.0 / std::f32::consts::PI).abs() < 0.25,
            "{f0} Hz: fundamental {fund}"
        );

        // Every harmonic above Nyquist folds back; a naive saw drops -20 dBc
        // junk into the audible band and 1x PolyBLEP still leaves -22 dBc.
        // Oversampled + halfband-decimated, everything below 16 kHz has to
        // stay under -46 dBc.
        for h in 2..=30u32 {
            let f = f0 * h as f32;
            if f <= SR / 2.0 {
                continue;
            }
            let folded = fold(f);
            if folded > 16_000.0 {
                continue; // halfband transition band; inaudible anyway
            }
            let a = amp_at(body, folded);
            assert!(
                a < fund * 0.005,
                "{f0} Hz: alias of harmonic {h} at {folded} Hz: {a} (fundamental {fund})"
            );
        }
    }
}

#[test]
fn vco_pulse_width_follows_pwm() {
    for (pwm, duty) in [(0.0f32, 0.5f32), (2.5, 0.74), (-2.5, 0.26)] {
        let mut e = source_patch("com.dj.vco", "pulse");
        e.set_knob_value("src", "pitch", pitch_of(200.0)).unwrap();
        e.set_knob_value("src", "pwm", pwm).unwrap();
        let out = render(&mut e, 0.5);
        let body = &out[4_800..];
        let high = body.iter().filter(|&&v| v > 0.0).count() as f32 / body.len() as f32;
        assert!(
            (high - duty).abs() < 0.02,
            "pwm {pwm}: duty {high} != {duty}"
        );
    }
}

#[test]
fn vco_thru_zero_fm_runs_phase_backwards() {
    // index 2 with fm = -5 V gives a frequency factor of 1 - 2 = -1: the
    // phase runs backwards at the same rate, so the sine inverts rather
    // than rectifying to the same waveform.
    let mut fwd = source_patch("com.dj.vco", "sine");
    fwd.set_knob_value("src", "pitch", pitch_of(300.0)).unwrap();
    let a = render(&mut fwd, 0.2);

    let mut back = source_patch("com.dj.vco", "sine");
    back.set_knob_value("src", "pitch", pitch_of(300.0))
        .unwrap();
    back.set_knob_value("src", "fm_index", 2.0).unwrap();
    back.set_knob_value("src", "fm", -5.0).unwrap();
    let b = render(&mut back, 0.2);

    let err = a
        .iter()
        .zip(&b)
        .map(|(&x, &y)| (x + y).abs())
        .fold(0.0f32, f32::max);
    assert!(err < 0.05, "thru-zero sine is not the time-reverse: {err}");

    // A frequency factor of exactly 0 must stand still (DC), not fold.
    let mut zero = source_patch("com.dj.vco", "saw");
    zero.set_knob_value("src", "pitch", pitch_of(300.0))
        .unwrap();
    zero.set_knob_value("src", "fm_index", 1.0).unwrap();
    zero.set_knob_value("src", "fm", -5.0).unwrap();
    let z = render(&mut zero, 0.1);
    assert!(
        rms(&z[100..]) - z[100].abs() < 1e-3,
        "frozen phase expected"
    );
}

#[test]
fn vco_hard_sync_locks_to_the_master() {
    let mut e = mono_engine();
    e.add_module("master", "com.dj.vco").unwrap();
    e.add_module("slave", "com.dj.vco").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("master", "pulse", "slave", "sync").unwrap();
    e.connect("slave", "saw", "out1", "l").unwrap();
    e.set_knob_value("master", "pitch", pitch_of(150.0))
        .unwrap();
    e.set_knob_value("slave", "pitch", pitch_of(430.0)).unwrap();
    let out = render(&mut e, 0.5);
    let body = &out[4_800..];

    // Synced: the waveform repeats at the master's rate, so energy appears
    // at 150 Hz and its harmonics even though the slave runs at 430 Hz.
    let locked = amp_at(body, 150.0);
    let free = {
        let mut e2 = source_patch("com.dj.vco", "saw");
        e2.set_knob_value("src", "pitch", pitch_of(430.0)).unwrap();
        let o = render(&mut e2, 0.5);
        amp_at(&o[4_800..], 150.0)
    };
    assert!(
        locked > 0.3 && locked > free * 20.0,
        "sync energy at 150 Hz: locked {locked}, free-running {free}"
    );
}
