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
        .add_midi_mapping("midi1", "note", 60, "pad_1")
        .unwrap();
    engine.connect("midi1", "pad_1", "adsr1", "gate").unwrap();

    engine.inject_midi("midi1", 0, [0x90, 60, 100]).unwrap();
    engine.render_offline((0.5 * SR) as usize).unwrap();

    let t = engine.tap("adsr1", "gate").unwrap();
    assert!(!t.is_fast, "held gate must be classified slow: {t:?}");
    assert!((t.instantaneous - 10.0).abs() < 1e-4, "gate high {t:?}");
    assert!((t.display - 10.0).abs() < 1e-4, "display {t:?}");
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
