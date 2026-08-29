//! M0 acceptance: jack activation values and 100 ms RMS smoothing are
//! exposed via the telemetry API (`Engine::tap`) and match expected values
//! for known test signals.

const SR: f32 = 48_000.0;

/// A slow (DC) signal displays its instantaneous value.
#[test]
fn dc_signal_reports_instantaneous_value() {
    let mut engine = crate::common::default_engine();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    // Unwired cv knob: linear 0..10, position 0.5 -> constant 5.0.
    engine.set_knob_position("vca1", "cv", 0.5).unwrap();

    engine.render_offline((0.3 * SR) as usize).unwrap();

    let t = engine.tap("vca1", "cv").unwrap();
    assert!(!t.is_fast, "DC must be classified slow: {t:?}");
    assert!((t.instantaneous - 5.0).abs() < 1e-4, "instantaneous {t:?}");
    assert!((t.display - 5.0).abs() < 1e-4, "display {t:?}");
    // RMS of DC 5.0 is also 5.0.
    assert!((t.rms_100ms - 5.0).abs() < 1e-3, "rms {t:?}");
}

/// A fast signal (audio-rate sine) displays 100 ms RMS = amplitude / sqrt(2).
#[test]
fn sine_reports_windowed_rms() {
    let mut engine = crate::common::default_engine();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    engine.connect("osc1", "audio", "vca1", "in").unwrap();

    // Default pitch 0.0 = C4 (261.626 Hz) sine, amplitude 5.
    engine.render_offline((0.5 * SR) as usize).unwrap();

    let t = engine.tap("vca1", "in").unwrap();
    assert!(t.is_fast, "261 Hz sine must be classified fast: {t:?}");
    let expected_rms = 5.0 / 2.0f32.sqrt();
    assert!(
        (t.rms_100ms - expected_rms).abs() < 0.05,
        "rms {} != {expected_rms}",
        t.rms_100ms
    );
    // Display value follows RMS for fast signals.
    assert!((t.display - t.rms_100ms).abs() < 1e-6, "display {t:?}");
}

/// A gate (slow square driven by MIDI) displays instantaneous value.
#[test]
fn gate_reports_instantaneous_value() {
    let mut engine = crate::common::default_engine();
    engine.add_module("midi1", "builtin.midi").unwrap();
    engine.add_module("adsr1", "com.dj.adsr").unwrap();
    engine
        .add_midi_mapping("midi1", dj_engine::MidiMapKind::Note, 60, "pad_1")
        .unwrap();
    engine.connect("midi1", "pad_1", "adsr1", "gate").unwrap();

    engine.inject_midi("midi1", 0, [0x90, 60, 100]).unwrap();
    engine.render_offline((0.5 * SR) as usize).unwrap();

    let t = engine.tap("adsr1", "gate").unwrap();
    assert!(!t.is_fast, "held gate must be classified slow: {t:?}");
    assert!((t.instantaneous - 10.0).abs() < 1e-4, "gate high {t:?}");
    assert!((t.display - 10.0).abs() < 1e-4, "display {t:?}");
}

/// A loud signal that goes exactly silent must not publish NaN. The sliding
/// window keeps a running sum of squares; when the loud blocks age out the
/// float cancellation can leave the total a hair below zero, and `sqrt` of
/// that is NaN. NaN reaches the UI as JSON `null` (serde_json has no NaN
/// literal), which crashes the front end.
#[test]
fn telemetry_stays_finite_when_a_loud_signal_goes_silent() {
    let mut engine = crate::common::default_engine();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    engine.add_module("mx", "com.dj.mixer").unwrap();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    engine.connect("osc1", "audio", "mx", "in1_l").unwrap();
    engine.connect("mx", "out_l", "vca1", "in").unwrap();

    // Loud for long enough to fill the 100 ms window...
    engine.set_knob_value("mx", "lvl1", 10.0).unwrap();
    engine.render_offline((0.3 * SR) as usize).unwrap();
    // ...then exactly silent, and drain the window in small steps.
    engine.set_knob_value("mx", "lvl1", 0.0).unwrap();
    for step in 0..40 {
        engine.render_offline((0.005 * SR) as usize).unwrap();
        let t = engine.tap("vca1", "in").unwrap();
        assert!(
            t.instantaneous.is_finite()
                && t.rms_100ms.is_finite()
                && t.display.is_finite()
                && t.rms_100ms >= 0.0,
            "non-finite telemetry at step {step}: {t:?}"
        );
    }
}

/// Output jacks have telemetry taps too (`Engine::tap_out`), fed by the
/// same analyzer machinery as inputs.
#[test]
fn output_jack_reports_telemetry() {
    let mut engine = crate::common::default_engine();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    engine.add_module("att1", "com.dj.attenuverter").unwrap();
    engine.set_knob_value("att1", "offset1", 5.0).unwrap();

    engine.render_offline((0.5 * SR) as usize).unwrap();

    // Audio-rate source output: fast, RMS = amplitude / sqrt(2).
    let t = engine.tap_out("osc1", "audio").unwrap();
    assert!(t.is_fast, "261 Hz output must be fast: {t:?}");
    assert!(
        (t.rms_100ms - 5.0 / 2.0f32.sqrt()).abs() < 0.05,
        "output rms {t:?}"
    );
    // DC output: slow, display = value.
    let t = engine.tap_out("att1", "out1").unwrap();
    assert!(!t.is_fast, "DC output must be slow: {t:?}");
    assert!((t.display - 5.0).abs() < 1e-3, "DC output display {t:?}");
    assert_eq!(t.volatility, 0.0, "DC output volatility {t:?}");
}

/// A slow signal's display value is the low-pass windowed mean, not the
/// jumpy instantaneous sample: right after a gate falls, the instantaneous
/// value is already 0 but the display still carries the window's mean.
#[test]
fn slow_display_value_is_windowed_mean() {
    let mut engine = crate::common::default_engine();
    engine.add_module("midi1", "builtin.midi").unwrap();
    engine.add_module("adsr1", "com.dj.adsr").unwrap();
    engine
        .add_midi_mapping("midi1", dj_engine::MidiMapKind::Note, 60, "pad_1")
        .unwrap();
    engine.connect("midi1", "pad_1", "adsr1", "gate").unwrap();

    // Hold the gate long enough to fill the 100 ms window, release, then
    // render exactly half a window more.
    engine.inject_midi("midi1", 0, [0x90, 60, 100]).unwrap();
    engine.render_offline((0.3 * SR) as usize).unwrap();
    engine.inject_midi("midi1", 0, [0x80, 60, 0]).unwrap();
    engine.render_offline((0.05 * SR) as usize).unwrap();

    let t = engine.tap("adsr1", "gate").unwrap();
    assert!(!t.is_fast, "a single gate edge must stay slow: {t:?}");
    assert!(t.instantaneous.abs() < 1e-4, "gate released {t:?}");
    // Half the window was at 10, half at 0: the smoothed display ~5.
    assert!(
        (t.display - 5.0).abs() < 1.0,
        "display must be the windowed mean, not the instantaneous 0: {t:?}"
    );
}

/// Volatility grades fast full-scale signals: 0 for slow, clearly nonzero
/// at 11 Hz, deeper at 60 Hz.
#[test]
fn volatility_scales_with_rate() {
    let mut engine = crate::common::default_engine();
    for (id, rate) in [("lfo_slow", 2.0), ("lfo_11", 11.0), ("lfo_60", 60.0)] {
        engine.add_module(id, "com.dj.lfo").unwrap();
        engine.set_knob_value(id, "rate", rate).unwrap();
    }

    engine.render_offline((0.5 * SR) as usize).unwrap();

    let slow = engine.tap_out("lfo_slow", "bi").unwrap();
    let v11 = engine.tap_out("lfo_11", "bi").unwrap();
    let v60 = engine.tap_out("lfo_60", "bi").unwrap();
    assert_eq!(slow.volatility, 0.0, "2 Hz LFO displayable: {slow:?}");
    assert!(
        v11.volatility > 0.3,
        "11 Hz full-scale LFO must be clearly volatile: {v11:?}"
    );
    assert!(
        v60.volatility > v11.volatility && v60.volatility > 0.8,
        "60 Hz must be deeper than 11 Hz: {v60:?} vs {v11:?}"
    );
}

/// A fast but negligible ripple is not volatile: the smoothed display
/// hides nothing that matters.
#[test]
fn tiny_fast_ripple_is_not_volatile() {
    let mut engine = crate::common::default_engine();
    engine.add_module("lfo1", "com.dj.lfo").unwrap();
    engine.add_module("att1", "com.dj.attenuverter").unwrap();
    engine.set_knob_value("lfo1", "rate", 60.0).unwrap();
    engine.set_knob_value("att1", "atten1", 0.01).unwrap(); // ±0.05 V
    engine.connect("lfo1", "bi", "att1", "in1").unwrap();

    engine.render_offline((0.5 * SR) as usize).unwrap();

    let t = engine.tap_out("att1", "out1").unwrap();
    assert!(
        t.volatility < 0.05,
        "±0.05 V ripple must not read as volatile: {t:?}"
    );
}

/// Output jacks publish telemetry too (used by the UI for panel meters and
/// sequencer step displays): `tap_out` reads the module's rendered
/// output, wired or not.
#[test]
fn output_tap_reports_module_output_level() {
    let mut engine = crate::common::default_engine();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    engine.connect("osc1", "audio", "vca1", "in").unwrap();
    // cv defaults to 0 (closed): open the gain knob fully for unity gain.
    engine.set_knob_value("vca1", "cv", 10.0).unwrap();
    engine.render_offline((0.5 * SR) as usize).unwrap();

    // The oscillator's own output jack — even though nothing taps `audio`
    // downstream of the analyzer, the slot publishes every block.
    let t = engine.tap_out("osc1", "audio").unwrap();
    assert!(t.is_fast, "C4 sine is fast: {t:?}");
    let expected_rms = 5.0 / 2.0f32.sqrt();
    assert!((t.rms_100ms - expected_rms).abs() < 0.05, "{t:?}");

    // The VCA's output matches its input (unity gain).
    let t = engine.tap_out("vca1", "out").unwrap();
    assert!((t.rms_100ms - expected_rms).abs() < 0.05, "vca out {t:?}");

    // Unknown jacks error rather than panicking.
    assert!(engine.tap_out("vca1", "nope").is_err());
}

/// Master bus telemetry is exposed too (used by the UI for output metering).
#[test]
fn master_tap_reports_output_level() {
    let mut engine = crate::common::default_engine();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    engine.add_module("out1", "builtin.audio_out").unwrap();
    engine.connect("osc1", "audio", "out1", "l").unwrap();

    engine.render_offline((0.5 * SR) as usize).unwrap();

    let t = engine.tap_master(0).unwrap();
    assert!(t.is_fast);
    assert!((t.rms_100ms - 5.0 / 2.0f32.sqrt()).abs() < 0.05, "{t:?}");
    // Channel 2 is silent.
    let t2 = engine.tap_master(1).unwrap();
    assert!(t2.rms_100ms < 1e-6, "{t2:?}");
}

/// The device readout is about HARDWARE the engine actually reached, and
/// only the cpal backend ever reaches any: a headless run must say
/// "nothing is playing" rather than name a device it never opened, and
/// stopping must take the claim back. The app's output picker draws its
/// "silent" state from exactly this.
#[test]
fn a_backend_with_no_device_claims_no_output() {
    let mut engine = crate::common::default_engine();
    assert_eq!(engine.audio_device_status(), Default::default());

    engine.start_null_realtime().unwrap();
    let running = engine.audio_device_status();
    assert_eq!(running.live, None, "{running:?}");
    assert_eq!(running.monitor, None, "{running:?}");

    engine.stop().unwrap();
    assert_eq!(engine.audio_device_status(), Default::default());
}
