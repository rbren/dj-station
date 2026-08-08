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

// ---------------------------------------------------------------------------
// Wavetable
// ---------------------------------------------------------------------------

/// Knob position for table `t` of the eight-table set.
fn table_pos(t: usize) -> f32 {
    t as f32 / 7.0
}

#[test]
fn wavetable_position_morphs_sine_to_saw() {
    let f0 = 220.0;
    let harmonics = |pos: f32| -> [f32; 4] {
        let mut e = source_patch("com.dj.wavetable", "audio");
        e.set_knob_value("src", "pitch", pitch_of(f0)).unwrap();
        e.set_knob_value("src", "pos", pos).unwrap();
        let out = render(&mut e, 0.5);
        let body = &out[4_800..];
        [
            amp_at(body, f0),
            amp_at(body, 2.0 * f0),
            amp_at(body, 3.0 * f0),
            peak(body),
        ]
    };

    // Table 0 is a pure sine: peak ±5, nothing above the fundamental.
    let sine = harmonics(table_pos(0));
    assert!((sine[0] - 5.0).abs() < 0.05, "sine fundamental {}", sine[0]);
    assert!(
        sine[1] < 0.005 && sine[2] < 0.005,
        "sine has harmonics: {sine:?}"
    );
    assert!((sine[3] - 5.0).abs() < 0.05, "sine peak {}", sine[3]);

    // Table 5 is a full saw: harmonic h at 1/h of the fundamental.
    let saw = harmonics(table_pos(5));
    assert!(
        (saw[1] / saw[0] - 0.5).abs() < 0.05 && (saw[2] / saw[0] - 1.0 / 3.0).abs() < 0.05,
        "saw harmonics {saw:?}"
    );

    // Halfway between tables 0 and 1 (sine, sine + 2nd) the crossfade gives
    // half of table 1's second harmonic.
    let two = harmonics(table_pos(1));
    let mid = harmonics(0.5 * table_pos(1));
    assert!(two[1] > 0.5, "table 1 second harmonic {}", two[1]);
    assert!(
        (mid[1] - 0.5 * two[1]).abs() < 0.05 * two[1],
        "morph is not a linear crossfade: {} vs {}",
        mid[1],
        two[1]
    );
}

#[test]
fn wavetable_mipmaps_stay_clean_at_high_pitch() {
    for f0 in [3_111.0f32, 5_000.0] {
        let mut e = source_patch("com.dj.wavetable", "audio");
        e.set_knob_value("src", "pitch", pitch_of(f0)).unwrap();
        e.set_knob_value("src", "pos", table_pos(5)).unwrap();
        let out = render(&mut e, 0.5);
        let body = &out[4_800..];
        let fund = amp_at(body, f0);
        assert!(fund > 1.0, "{f0} Hz: fundamental {fund}");
        for h in 2..=30u32 {
            let f = f0 * h as f32;
            if f <= SR / 2.0 {
                continue;
            }
            let a = amp_at(body, fold(f));
            assert!(
                a < fund * 0.002,
                "{f0} Hz: alias of harmonic {h} at {} Hz: {a} (fundamental {fund})",
                fold(f)
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

/// Mean power in a band, sampled at 48 log-spaced probe frequencies.
fn band_power(x: &[f32], lo: f32, hi: f32) -> f32 {
    let probes = 48;
    let mut acc = 0.0f32;
    for i in 0..probes {
        let t = (i as f32 + 0.5) / probes as f32;
        let a = amp_at(x, lo * (hi / lo).powf(t));
        acc += a * a;
    }
    acc / probes as f32
}

/// Average spectral slope in dB per octave between two bands five octaves
/// apart.
fn slope_db_per_octave(x: &[f32]) -> f32 {
    let low = band_power(x, 100.0, 200.0);
    let high = band_power(x, 3_200.0, 6_400.0);
    10.0 * (high / low).log10() / 5.0
}

#[test]
fn noise_colours_have_expected_spectral_slopes() {
    for (jack, expected) in [
        ("white", 0.0f32),
        ("pink", -3.0),
        ("red", -6.0),
        ("blue", 6.0),
    ] {
        let mut e = source_patch("com.dj.noise", jack);
        let out = render(&mut e, 2.0);
        let body = &out[9_600..];
        let slope = slope_db_per_octave(body);
        assert!(
            (slope - expected).abs() < 0.6,
            "{jack}: {slope:.2} dB/oct, expected {expected}"
        );
        let level = rms(body);
        assert!(
            level > 1.0 && level < 3.5,
            "{jack}: RMS {level} outside the useful audio range"
        );
        assert!(peak(body) < 10.0, "{jack}: peak {} exceeds ±10", peak(body));
    }
}

#[test]
fn noise_random_holds_between_steps() {
    // Free-running: the rate knob sets the step rate when nothing is
    // patched into the clock.
    let mut e = source_patch("com.dj.noise", "random");
    e.set_knob_value("src", "rate", 10.0).unwrap();
    let out = render(&mut e, 2.0);
    let steps = out.windows(2).filter(|w| w[0] != w[1]).count();
    assert!((steps as i32 - 20).abs() <= 1, "free-run steps: {steps}");
    assert!(peak(&out) <= 5.0, "random exceeds ±5: {}", peak(&out));
    // Values must actually move around, not sit on one level.
    assert!(rms(&out) > 1.0, "random is stuck: rms {}", rms(&out));

    // Clocked: an external gate takes over from the internal rate.
    let mut e = mono_engine();
    e.add_module("clk", "com.dj.vco").unwrap();
    e.add_module("src", "com.dj.noise").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("clk", "pulse", "src", "clock").unwrap();
    e.connect("src", "random", "out1", "l").unwrap();
    e.set_knob_value("clk", "pitch", pitch_of(40.0)).unwrap();
    e.set_knob_value("src", "rate", 10.0).unwrap();
    let out = render(&mut e, 1.0);
    let steps = out.windows(2).filter(|w| w[0] != w[1]).count();
    assert!((steps as i32 - 40).abs() <= 2, "clocked steps: {steps}");
}

#[test]
fn noise_is_deterministic_across_instances() {
    let a = render(&mut source_patch("com.dj.noise", "white"), 0.1);
    let b = render(&mut source_patch("com.dj.noise", "white"), 0.1);
    assert_eq!(a, b, "noise must render identically from a fixed seed");
    assert!(rms(&a) > 1.0);
}

// ---------------------------------------------------------------------------
// Drum voice
// ---------------------------------------------------------------------------

/// MIDI note 36/38/42 (kick/snare/hat) -> the drum module's trigger jacks,
/// with `out_jack` patched to the master bus.
fn drum_patch(out_jack: &str) -> Engine {
    let mut e = mono_engine();
    e.add_module("midi1", "builtin.midi").unwrap();
    e.add_module("drum", "com.dj.drum").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    for (note, name, jack) in [
        (36u8, "k", "kick_trig"),
        (38, "s", "snare_trig"),
        (42, "h", "hat_trig"),
    ] {
        e.add_midi_mapping("midi1", "note", note, name).unwrap();
        e.connect("midi1", name, "drum", jack).unwrap();
    }
    e.connect("drum", out_jack, "out1", "l").unwrap();
    e
}

/// Fire `note` at 0.1 s and release it 40 ms later.
fn hit(engine: &mut Engine, note: u8) {
    engine
        .inject_midi("midi1", 4_800, [0x90, note, 100])
        .unwrap();
    engine.inject_midi("midi1", 6_720, [0x80, note, 0]).unwrap();
}

#[test]
fn drum_kick_sweeps_pitch_and_decays() {
    let mut e = drum_patch("kick");
    e.set_knob_value("drum", "kick_decay", 0.3).unwrap();
    e.set_knob_value("drum", "kick_tone", 0.0).unwrap();
    hit(&mut e, 36);
    let out = render(&mut e, 0.6);

    assert!(peak(&out[..4_800]) < 1e-9, "kick sounds before its trigger");
    let attack = peak(&out[4_800..5_280]);
    assert!(
        attack > 3.5 && attack < 5.5,
        "kick attack peak {attack} out of range"
    );

    // The pitch envelope starts the sine well above the tuned frequency and
    // settles onto it (52 Hz) within a few tens of ms.
    let early = zero_cross_rate(&out[4_800..5_040]);
    let late = zero_cross_rate(&out[9_600..24_000]);
    assert!(early > 3.0 * late, "no pitch sweep: {early} -> {late}");
    assert!((late - 52.0).abs() < 5.0, "kick settles at {late} Hz");

    // -60 dB by the end of the decay time (0.3 s after the trigger).
    let tail = peak(&out[(4_800 + (0.3 * SR) as usize)..]);
    assert!(tail < 0.05 * attack, "kick still at {tail} after its decay");
}

#[test]
fn drum_snare_balances_body_and_noise() {
    // (tuned-body amplitude, noise-band level, attack peak)
    let measure = |tone: f32| -> (f32, f32, f32) {
        let mut e = drum_patch("snare");
        e.set_knob_value("drum", "snare_tone", tone).unwrap();
        e.set_knob_value("drum", "snare_decay", 0.25).unwrap();
        hit(&mut e, 38);
        let out = render(&mut e, 0.5);
        let body = &out[4_800..9_600];
        (
            amp_at(body, 185.0),
            band_power(body, 1_000.0, 6_000.0).sqrt(),
            peak(&out[4_800..5_280]),
        )
    };
    let (tonal_body, tonal_noise, tonal_peak) = measure(0.0);
    let (snappy_body, snappy_noise, snappy_peak) = measure(1.0);

    assert!(
        tonal_body > 0.2 && tonal_body > 6.0 * snappy_body,
        "body-only snare: fundamental {tonal_body} vs snappy {snappy_body}"
    );
    assert!(
        tonal_peak > 2.0 && tonal_peak < 6.0 && snappy_peak > 2.0 && snappy_peak < 6.0,
        "snare levels: body {tonal_peak}, snappy {snappy_peak}"
    );
    assert!(
        snappy_noise > 4.0 * tonal_noise,
        "snappy snare noise band {snappy_noise} vs body-only {tonal_noise}"
    );
}

#[test]
fn drum_hat_is_high_passed_and_short() {
    let mut e = drum_patch("hat");
    e.set_knob_value("drum", "hat_decay", 0.06).unwrap();
    hit(&mut e, 42);
    let out = render(&mut e, 0.4);
    let body = &out[4_800..7_200];

    let low = band_power(body, 200.0, 800.0);
    let high = band_power(body, 6_000.0, 12_000.0);
    assert!(
        high > 100.0 * low,
        "hat is not high-passed: low {low}, high {high}"
    );

    let attack = peak(&out[4_800..5_280]);
    assert!(attack > 1.0, "hat attack {attack} too quiet");
    let tail = peak(&out[(4_800 + (0.06 * SR) as usize)..]);
    assert!(tail < 0.05 * attack, "hat still at {tail} after its decay");
}

#[test]
fn drum_mix_sums_the_three_voices() {
    let render_jack = |jack: &str| -> Vec<f32> {
        let mut e = drum_patch(jack);
        for note in [36u8, 38, 42] {
            hit(&mut e, note);
        }
        render(&mut e, 0.3)
    };
    let kick = render_jack("kick");
    let snare = render_jack("snare");
    let hat = render_jack("hat");
    let mix = render_jack("mix");

    let mut worst = 0.0f32;
    for i in 0..mix.len() {
        worst = worst.max((mix[i] - 0.6 * (kick[i] + snare[i] + hat[i])).abs());
    }
    assert!(worst < 1e-5, "mix is not the -4.4 dB voice sum: {worst}");
    assert!(
        peak(&mix) > 2.0 && peak(&mix) < 10.0,
        "mix peak {}",
        peak(&mix)
    );
}
