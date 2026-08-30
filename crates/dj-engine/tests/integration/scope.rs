//! What the Scope actually sees when a source is patched into it.
//!
//! The panel draws the samples the engine captures on the scope's `in`
//! jack (`dj_engine::capture`) — nothing is reconstructed from the scalar
//! outputs any more — so these cases render real modules into a real scope
//! and assert on that capture: an oscillator is a tone at the frequency it
//! was asked for, white noise is broadband down to the bottom of the
//! display range with no dead band and NO fundamental to report, and an
//! unwired scope captures silence.

use dj_engine::{CaptureWindow, Engine, KnobConfig, KnobStyle, CAPTURE_SAMPLES};

const SR: f32 = 48_000.0;
/// The panel's log-frequency display range (ScopeUI.tsx: F_LO, F_HI) and the
/// default band count its `bins` input starts at (DEFAULT_BINS).
const F_LO: f32 = 20.0;
const F_HI: f32 = 16_000.0;
const BANDS: usize = 48;

fn engine_with_scope() -> Engine {
    let mut e = crate::common::default_engine();
    e.add_module("scope1", "com.dj.scope").unwrap();
    e
}

fn capture(engine: &Engine) -> CaptureWindow {
    engine.jack_capture("scope1", "in").unwrap()
}

/// Amplitude of the sinusoidal component at `freq` (Hann-windowed one-bin
/// DFT), in volts.
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

/// RMS amplitude across one of `bands` display bands, probed at five
/// frequencies so a single unlucky bin of a random signal cannot decide
/// the answer.
fn band_amp_of(x: &[f32], band: usize, bands: usize) -> f32 {
    let edge = |b: usize| F_LO * (F_HI / F_LO).powf(b as f32 / bands as f32);
    let (lo, hi) = (edge(band), edge(band + 1));
    const PROBES: usize = 5;
    let mut power = 0.0f64;
    for p in 0..PROBES {
        let f = lo * (hi / lo).powf((p as f32 + 0.5) / PROBES as f32);
        let a = amp_at(x, f) as f64;
        power += a * a;
    }
    (power / PROBES as f64).sqrt() as f32
}

/// The same, over the panel's default number of bands.
fn band_amp(x: &[f32], band: usize) -> f32 {
    band_amp_of(x, band, BANDS)
}

/// Highest normalized autocorrelation over lags that could be a period:
/// ~1 for anything periodic, near 0 for noise.
fn max_autocorr(x: &[f32], min_lag: usize, max_lag: usize) -> f32 {
    let energy: f64 = x.iter().map(|&v| (v * v) as f64).sum();
    if energy <= 0.0 {
        return 0.0;
    }
    let mut best = 0.0f64;
    for lag in min_lag..=max_lag.min(x.len() / 2) {
        let mut num = 0.0f64;
        let mut a = 0.0f64;
        let mut b = 0.0f64;
        for i in 0..x.len() - lag {
            let (u, v) = (x[i] as f64, x[i + lag] as f64);
            num += u * v;
            a += u * u;
            b += v * v;
        }
        let denom = (a * b).sqrt();
        if denom > 0.0 {
            best = best.max(num / denom);
        }
    }
    best as f32
}

/// An oscillator's tone arrives in the capture at the frequency it was set
/// to (the bin the panel draws it in), and the scope reports that same
/// frequency on `hz` (1 V per 100 Hz).
#[test]
fn sine_lands_in_the_expected_bin() {
    let mut e = engine_with_scope();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.connect("osc1", "audio", "scope1", "in").unwrap();
    // 1 V/oct from C4: 440 Hz.
    e.set_knob_value("osc1", "pitch", (440.0f32 / 261.626).log2())
        .unwrap();
    e.render_offline((0.5 * SR) as usize).unwrap();

    let w = capture(&e);
    assert_eq!(w.sample_rate, SR);
    assert_eq!(w.samples.len(), CAPTURE_SAMPLES);
    let at_440 = amp_at(&w.samples, 440.0);
    assert!(
        at_440 > 4.0,
        "440 Hz component {at_440} V (osc peaks at 5 V)"
    );
    // A sine and nothing else: neighbours and harmonics are far down.
    for f in [220.0, 880.0, 1320.0] {
        let a = amp_at(&w.samples, f);
        assert!(a < 0.1 * at_440, "{f} Hz component {a} V vs {at_440} V");
    }
    // The captured window IS periodic — this is what a waveform looks like.
    let period = (SR / 440.0) as usize;
    assert!(
        max_autocorr(&w.samples, period - 2, period + 2) > 0.9,
        "a sine must correlate with itself one period later"
    );

    let hz = e.tap_out("scope1", "hz").unwrap();
    assert!(
        (hz.display - 4.4).abs() < 0.1,
        "hz reads {} V, expected 4.4 V (440 Hz)",
        hz.display
    );
}

/// A saw brings its own harmonic series (1/k), a sine brings none: the
/// captured spectrum is the SIGNAL's, not a template picked by crest
/// factor.
#[test]
fn a_saw_shows_its_own_harmonics() {
    // Waveform is a 4-detent stepped knob, picked by POSITION: setting a
    // stepped knob by value lands on the detent boundary.
    let harmonics = |waveform: f32| {
        let mut e = engine_with_scope();
        e.add_module("osc1", "com.dj.oscillator").unwrap();
        e.connect("osc1", "audio", "scope1", "in").unwrap();
        e.set_knob_position("osc1", "waveform", waveform / 3.0)
            .unwrap();
        e.set_knob_value("osc1", "pitch", (440.0f32 / 261.626).log2())
            .unwrap();
        e.render_offline((0.5 * SR) as usize).unwrap();
        let w = capture(&e);
        let f = amp_at(&w.samples, 440.0);
        [2.0f32, 3.0, 4.0].map(|k| amp_at(&w.samples, k * 440.0) / f)
    };

    for (k, ratio) in harmonics(1.0).iter().enumerate() {
        // Saw harmonic k+2 sits at 1/(k+2) of the fundamental.
        let expected = 1.0 / (k as f32 + 2.0);
        assert!(
            (ratio - expected).abs() < 0.25 * expected,
            "saw harmonic {}: {ratio} of the fundamental, expected {expected}",
            k + 2
        );
    }
    for (k, ratio) in harmonics(0.0).iter().enumerate() {
        assert!(*ratio < 0.02, "sine harmonic {}: {ratio}", k + 2);
    }
}

/// White noise is BROADBAND: every band of the panel's display range —
/// including the low ones the old reconstructed spectrum left empty — has
/// energy, and it is flat within a few dB.
#[test]
fn white_noise_is_broadband_with_no_dead_bins() {
    let mut e = engine_with_scope();
    e.add_module("noise1", "com.dj.noise").unwrap();
    e.connect("noise1", "white", "scope1", "in").unwrap();
    e.render_offline((0.5 * SR) as usize).unwrap();

    let w = capture(&e);
    let amps: Vec<f32> = (0..BANDS).map(|b| band_amp(&w.samples, b)).collect();
    let mean = amps.iter().sum::<f32>() / BANDS as f32;
    assert!(mean > 0.02, "white noise is not silent: mean band {mean} V");
    for (b, &a) in amps.iter().enumerate() {
        assert!(
            a > mean * 0.2,
            "band {b} is dead: {a} V against a {mean} V mean"
        );
        assert!(
            a < mean * 5.0,
            "band {b} is a spike: {a} V against a {mean} V mean"
        );
    }
    // The lowest bands (20-100 Hz) carry as much as the rest: white noise
    // has no low-frequency hole.
    let low: f32 = amps[..12].iter().sum::<f32>() / 12.0;
    assert!(
        low > mean * 0.4,
        "low bands {low} V against a {mean} V mean"
    );
}

/// Noise must not draw as a waveform: the captured window does not repeat,
/// and the scope reports no fundamental for it (`hz` at 0, so the panel
/// reads "— Hz" instead of inventing a pitch).
#[test]
fn white_noise_is_not_periodic_and_has_no_pitch() {
    let mut e = engine_with_scope();
    e.add_module("noise1", "com.dj.noise").unwrap();
    e.connect("noise1", "white", "scope1", "in").unwrap();
    e.render_offline((0.5 * SR) as usize).unwrap();

    let w = capture(&e);
    let r = max_autocorr(&w.samples, 4, 1024);
    assert!(r < 0.3, "captured noise repeats at some lag (r = {r})");

    let hz = e.tap_out("scope1", "hz").unwrap();
    assert!(
        hz.display < 0.01 && hz.instantaneous < 0.01,
        "noise has no fundamental, hz reads {hz:?}"
    );
    let trig = e.tap_out("scope1", "trig").unwrap();
    assert!(
        trig.rms_100ms < 0.01,
        "the sync pulse must stay down on an unsyncable input: {trig:?}"
    );
    // Level readings are still real measurements of the noise.
    let peak = e.tap_out("scope1", "peak").unwrap();
    let rms = e.tap_out("scope1", "rms").unwrap();
    assert!(peak.display > 4.0, "white noise peaks near 5 V: {peak:?}");
    assert!(
        (rms.display - 5.0 / 3.0f32.sqrt()).abs() < 0.5,
        "uniform white noise rms ~2.9 V: {rms:?}"
    );
}

/// Pink noise is broadband too, tilted down with frequency (-3 dB/oct) —
/// the display must show the tilt, not gaps.
#[test]
fn pink_noise_is_broadband_and_tilted() {
    let mut e = engine_with_scope();
    e.add_module("noise1", "com.dj.noise").unwrap();
    e.connect("noise1", "pink", "scope1", "in").unwrap();
    e.render_offline((0.5 * SR) as usize).unwrap();

    let w = capture(&e);
    let amps: Vec<f32> = (0..BANDS).map(|b| band_amp(&w.samples, b)).collect();
    for (b, &a) in amps.iter().enumerate() {
        assert!(a > 0.0005, "band {b} is dead: {a} V");
    }
    let low: f32 = amps[..12].iter().sum::<f32>() / 12.0;
    let high: f32 = amps[BANDS - 12..].iter().sum::<f32>() / 12.0;
    assert!(
        low > high * 2.0,
        "pink tilts down: low {low} V, high {high} V"
    );
}

/// An unwired scope captures silence, and says so.
#[test]
fn silence_is_empty() {
    let mut e = engine_with_scope();
    e.render_offline((0.3 * SR) as usize).unwrap();

    let w = capture(&e);
    assert_eq!(w.samples.len(), CAPTURE_SAMPLES);
    assert!(
        w.samples.iter().all(|&v| v == 0.0),
        "an unwired input captures zeros"
    );
    let hz = e.tap_out("scope1", "hz").unwrap();
    let peak = e.tap_out("scope1", "peak").unwrap();
    assert!(hz.display < 1e-6 && peak.display < 1e-6, "{hz:?} {peak:?}");
}

/// The window is the LAST 43 ms, not whatever was there first: a source
/// that stops is a trace that goes quiet.
#[test]
fn the_capture_is_never_stale() {
    let mut e = engine_with_scope();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.connect("osc1", "audio", "scope1", "in").unwrap();
    e.render_offline((0.3 * SR) as usize).unwrap();
    let loud = capture(&e);
    assert!(loud.samples.iter().any(|&v| v.abs() > 1.0));

    e.disconnect("osc1", "audio", "scope1", "in").unwrap();
    // One ring's worth of silence is all it takes (2048 samples).
    e.render_offline((0.2 * SR) as usize).unwrap();
    let quiet = capture(&e);
    assert!(
        quiet.samples.iter().all(|&v| v == 0.0),
        "the window still holds the old signal"
    );
}

/// The `bins` input's knob, as the panel reads it: the detents are whole
/// band counts from 16 to 144, and the default is the 48 bars the spectrum
/// has always been drawn with (ScopeUI.tsx MIN_BINS/MAX_BINS/DEFAULT_BINS).
///
/// The detent count is 17 rather than a round 16 on purpose: a manifest
/// default lands on the position `position_for_value` binary-searches to,
/// which is the boundary between two detents, and only a boundary at an
/// exact binary fraction — `steps - 1` a power of two — snaps back to the
/// detent that was asked for instead of the one below it.
#[test]
fn the_bins_knob_steps_through_whole_band_counts() {
    let e = engine_with_scope();
    let manifest = &crate::common::registry().extensions["com.dj.scope"].manifest;
    let decl = manifest
        .inputs
        .iter()
        .find(|i| i.id == "bins")
        .expect("the scope declares a bins input");
    let cfg: KnobConfig = decl.knob.clone().expect("bins is a knob");
    assert_eq!(cfg.style, KnobStyle::Stepped);
    assert_eq!((cfg.min, cfg.max, cfg.steps), (16.0, 144.0, Some(17)));
    // Every detent is a usable bar count: whole, and 8 apart.
    for step in 0..17 {
        let value = cfg.map(step as f32 / 16.0);
        assert_eq!(value.round(), (16 + 8 * step) as f32, "detent {step}");
    }
    // A fresh scope starts on the 48-bar detent — the panel's default.
    let position = e.knob_state("scope1", "bins").unwrap().position;
    assert_eq!(cfg.map(position).round(), BANDS as f32);
}

/// Moving `bins` moves the picture and nothing else: it is a display
/// control, so the audio through `thru` and every measured output read
/// exactly the same at the two ends of its range. (The jack still costs
/// the DSP an input slot — this is also the pin that the module's input
/// count and its manifest agree.)
#[test]
fn bins_changes_the_display_only() {
    let render_at = |bins: f32| {
        let mut e = engine_with_scope();
        e.add_module("osc1", "com.dj.oscillator").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.connect("osc1", "audio", "scope1", "in").unwrap();
        e.connect("scope1", "thru", "out1", "l").unwrap();
        e.set_knob_value("scope1", "bins", bins).unwrap();
        let audio = e.render_offline((0.2 * SR) as usize).unwrap().remove(0);
        let readings = ["hz", "peak", "rms"].map(|j| e.tap_out("scope1", j).unwrap().display);
        (audio, readings)
    };
    let (few_audio, few_readings) = render_at(16.0);
    let (many_audio, many_readings) = render_at(144.0);
    assert_eq!(few_audio, many_audio, "bins must not touch the signal");
    assert_eq!(few_readings, many_readings, "bins must not touch a reading");
    assert!(few_readings[0] > 0.0, "the tone was measured at all");
}

/// The capture a denser spectrum is folded from covers the whole display
/// range whatever the bar count: at the coarse end of `bins` every band of
/// white noise carries energy, so turning the control down loses detail and
/// never a part of the picture. (How bands are folded is the panel's — see
/// `spectrumBands` in ScopeUI.test.tsx for the dense end, where a band is
/// narrower than an FFT bin.)
#[test]
fn a_coarse_spectrum_still_covers_the_range() {
    let mut e = engine_with_scope();
    e.add_module("noise1", "com.dj.noise").unwrap();
    e.connect("noise1", "white", "scope1", "in").unwrap();
    e.render_offline((0.5 * SR) as usize).unwrap();

    let w = capture(&e);
    const COARSE: usize = 16;
    let amps: Vec<f32> = (0..COARSE)
        .map(|b| band_amp_of(&w.samples, b, COARSE))
        .collect();
    let mean = amps.iter().sum::<f32>() / COARSE as f32;
    for (b, &a) in amps.iter().enumerate() {
        assert!(a > mean * 0.2, "band {b} of {COARSE} is dead: {a} V");
    }
}

/// A bin count is patch state like any other knob: it survives a save and
/// a load, and a patch written before the input existed loads on the
/// default (the committed E2E scope case is exactly such a patch).
#[test]
fn the_bin_count_survives_a_patch_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = engine_with_scope();
    e.set_knob_value("scope1", "bins", 96.0).unwrap();
    e.save_patch(dir.path(), "scope-bins").unwrap();

    let reloaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    let cfg: KnobConfig = crate::common::registry().extensions["com.dj.scope"]
        .manifest
        .inputs
        .iter()
        .find(|i| i.id == "bins")
        .and_then(|i| i.knob.clone())
        .unwrap();
    let position = reloaded.knob_state("scope1", "bins").unwrap().position;
    assert_eq!(cfg.map(position).round(), 96.0);
}

/// Only jacks whose manifest asks for it carry a capture ring — one fixed
/// buffer per drawn jack, not per jack in the rack.
#[test]
fn only_capture_jacks_have_a_window() {
    let mut e = engine_with_scope();
    e.add_module("vca1", "com.dj.vca").unwrap();
    assert!(e.jack_capture("scope1", "hysteresis").is_err());
    assert!(e.jack_capture("vca1", "in").is_err());
    assert!(e.jack_capture("scope1", "in").is_ok());
}
