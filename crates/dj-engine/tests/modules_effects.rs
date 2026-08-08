//! Behaviour tests for the Effects and Analysis modules
//! (delay, reverb, modfx, compressor, granular, resonator, scope).
//!
//! Each test renders a short patch offline and asserts on the samples.

mod common;

use dj_engine::{Engine, EngineConfig};

const SR: f32 = 48_000.0;

fn stereo_engine() -> Engine {
    let config = EngineConfig {
        master_channels: 2,
        ..EngineConfig::default()
    };
    Engine::new(config, common::registry()).unwrap()
}

/// MIDI -> ADSR -> VCA gated sine "blip" source, wired to nothing yet.
/// Output jack: `("vca1", "out")`. Note on/off are injected by the caller.
fn add_blip_source(e: &mut Engine) {
    e.add_module("midi1", "builtin.midi").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("adsr1", "com.dj.adsr").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_midi_mapping("midi1", "note", 60, "pad_1").unwrap();
    e.connect("midi1", "pad_1", "adsr1", "gate").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("adsr1", "env", "vca1", "cv").unwrap();
    e.set_knob_value("adsr1", "attack", 0.002).unwrap();
    e.set_knob_value("adsr1", "decay", 0.01).unwrap();
    e.set_knob_value("adsr1", "sustain", 1.0).unwrap();
    e.set_knob_value("adsr1", "release", 0.005).unwrap();
}

fn blip_at(e: &mut Engine, on: f32, len: f32) {
    e.inject_midi("midi1", (on * SR) as u64, [0x90, 60, 100])
        .unwrap();
    e.inject_midi("midi1", ((on + len) * SR) as u64, [0x80, 60, 0])
        .unwrap();
}

/// Peak level per `win` seconds.
fn envelope(signal: &[f32], win: f32) -> Vec<f32> {
    common::window_peaks(signal, (win * SR) as usize)
}

/// Time (seconds) of the loudest window at or after `from`.
fn peak_time(signal: &[f32], win: f32, from: f32) -> f32 {
    let env = envelope(signal, win);
    let start = (from / win) as usize;
    let (i, _) = env
        .iter()
        .enumerate()
        .skip(start)
        .fold(
            (0usize, 0.0f32),
            |acc, (i, &v)| {
                if v > acc.1 {
                    (i, v)
                } else {
                    acc
                }
            },
        );
    i as f32 * win
}

fn rms(signal: &[f32]) -> f32 {
    (signal.iter().map(|x| x * x).sum::<f32>() / signal.len().max(1) as f32).sqrt()
}

fn assert_finite(signal: &[f32], what: &str) {
    assert!(
        signal.iter().all(|x| x.is_finite() && x.abs() < 100.0),
        "{what}: output not finite/bounded"
    );
}

// ---------------------------------------------------------------------------
// Delay
// ---------------------------------------------------------------------------

#[test]
fn delay_repeats_at_the_set_time() {
    let mut e = stereo_engine();
    add_blip_source(&mut e);
    e.add_module("dly", "com.dj.delay").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("vca1", "out", "dly", "in_l").unwrap();
    e.connect("dly", "out_l", "out1", "l").unwrap();
    e.set_knob_value("dly", "time", 0.25).unwrap();
    e.set_knob_value("dly", "mix", 1.0).unwrap();
    e.set_knob_value("dly", "feedback", 0.0).unwrap();
    blip_at(&mut e, 0.30, 0.02);

    let out = e.render_offline((0.8 * SR) as usize).unwrap();
    assert_finite(&out[0], "delay");
    // Wet-only: the dry blip at 0.30 s is gone, the echo lands at 0.55 s.
    let dry = &out[0][(0.29 * SR) as usize..(0.33 * SR) as usize];
    assert!(rms(dry) < 1e-3, "wet-only delay leaked dry signal");
    let t = peak_time(&out[0], 0.005, 0.35);
    assert!(
        (t - 0.55).abs() < 0.02,
        "echo at {t:.3}s, expected 0.55s (0.30 + 0.25)"
    );
}

#[test]
fn delay_feedback_decays_and_stays_bounded() {
    let mut e = stereo_engine();
    add_blip_source(&mut e);
    e.add_module("dly", "com.dj.delay").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("vca1", "out", "dly", "in_l").unwrap();
    e.connect("dly", "out_l", "out1", "l").unwrap();
    e.set_knob_value("dly", "time", 0.1).unwrap();
    e.set_knob_value("dly", "mix", 1.0).unwrap();
    e.set_knob_value("dly", "feedback", 0.6).unwrap();
    blip_at(&mut e, 0.30, 0.02);

    let out = e.render_offline((1.2 * SR) as usize).unwrap();
    assert_finite(&out[0], "delay feedback");
    let peak_at = |t: f32| -> f32 {
        let a = (t * SR) as usize;
        let b = ((t + 0.06) * SR) as usize;
        out[0][a..b].iter().fold(0.0f32, |m, &x| m.max(x.abs()))
    };
    let e1 = peak_at(0.40);
    let e2 = peak_at(0.50);
    let e3 = peak_at(0.60);
    assert!(e1 > 0.5, "first echo too quiet: {e1}");
    assert!(e2 < e1 && e2 > 0.1 * e1, "second echo {e2} vs first {e1}");
    assert!(e3 < e2, "third echo {e3} not decaying vs {e2}");
}

#[test]
fn delay_max_feedback_does_not_blow_up() {
    let mut e = stereo_engine();
    add_blip_source(&mut e);
    e.add_module("dly", "com.dj.delay").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("vca1", "out", "dly", "in_l").unwrap();
    e.connect("dly", "out_l", "out1", "l").unwrap();
    e.set_knob_value("dly", "time", 0.05).unwrap();
    e.set_knob_value("dly", "mix", 1.0).unwrap();
    e.set_knob_position("dly", "feedback", 1.0).unwrap();
    blip_at(&mut e, 0.05, 0.4);

    let out = e.render_offline((3.0 * SR) as usize).unwrap();
    assert_finite(&out[0], "delay runaway");
    let tail = &out[0][(2.5 * SR) as usize..];
    let peak = tail.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    assert!(peak < 12.0, "self-oscillation exceeded the ceiling: {peak}");
}

#[test]
fn delay_pingpong_bounces_to_the_other_channel() {
    let mut e = stereo_engine();
    add_blip_source(&mut e);
    e.add_module("dly", "com.dj.delay").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("vca1", "out", "dly", "in_l").unwrap();
    e.connect("dly", "out_l", "out1", "l").unwrap();
    e.connect("dly", "out_r", "out1", "r").unwrap();
    e.set_knob_value("dly", "time", 0.15).unwrap();
    e.set_knob_value("dly", "mix", 1.0).unwrap();
    e.set_knob_value("dly", "feedback", 0.7).unwrap();
    e.set_knob_position("dly", "pingpong", 1.0).unwrap();
    blip_at(&mut e, 0.30, 0.02);

    let out = e.render_offline((1.0 * SR) as usize).unwrap();
    assert_finite(&out[0], "pingpong L");
    assert_finite(&out[1], "pingpong R");
    // Left repeat first (0.45 s), right repeat one delay later (0.60 s).
    let tl = peak_time(&out[0], 0.005, 0.35);
    let tr = peak_time(&out[1], 0.005, 0.35);
    assert!((tl - 0.45).abs() < 0.02, "left echo at {tl:.3}s");
    assert!((tr - 0.60).abs() < 0.02, "right echo at {tr:.3}s");
}

#[test]
fn delay_follows_a_patched_clock() {
    let mut e = stereo_engine();
    add_blip_source(&mut e);
    // Square oscillator at the lowest knob pitch (-5 oct = 8.176 Hz) is the
    // clock; one clock period = 0.12231 s at division "1".
    e.add_module("clk", "com.dj.oscillator").unwrap();
    e.set_knob_value("clk", "pitch", -5.0).unwrap();
    e.set_knob_value("clk", "waveform", 2.0).unwrap();
    e.add_module("dly", "com.dj.delay").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("vca1", "out", "dly", "in_l").unwrap();
    e.connect("clk", "audio", "dly", "clock").unwrap();
    e.connect("dly", "out_l", "out1", "l").unwrap();
    // The time knob is deliberately far away: the clock must win.
    e.set_knob_value("dly", "time", 1.0).unwrap();
    e.set_knob_value("dly", "mix", 1.0).unwrap();
    e.set_knob_value("dly", "feedback", 0.0).unwrap();
    e.set_knob_value("dly", "div", 6.0).unwrap(); // x1
    blip_at(&mut e, 0.60, 0.02);

    let out = e.render_offline((1.2 * SR) as usize).unwrap();
    assert_finite(&out[0], "clocked delay");
    let t = peak_time(&out[0], 0.005, 0.65);
    let expected = 0.60 + 1.0 / (261.626 / 32.0);
    assert!(
        (t - expected).abs() < 0.02,
        "clocked echo at {t:.3}s, expected {expected:.3}s"
    );
}
