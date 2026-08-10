//! Behaviour tests for the Effects and Analysis modules
//! (delay, reverb, modfx, compressor, granular, resonator, scope).
//!
//! Each test renders a short patch offline and asserts on the samples.

use dj_engine::{Engine, EngineConfig, MidiMapKind};

const SR: f32 = 48_000.0;

fn stereo_engine() -> Engine {
    let config = EngineConfig {
        master_channels: 2,
        ..EngineConfig::default()
    };
    Engine::new(config, crate::common::registry()).unwrap()
}

/// MIDI -> ADSR -> VCA gated sine "blip" source, wired to nothing yet.
/// Output jack: `("vca1", "out")`. Note on/off are injected by the caller.
fn add_blip_source(e: &mut Engine) {
    e.add_module("midi1", "builtin.midi").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("adsr1", "com.dj.adsr").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_midi_mapping("midi1", MidiMapKind::Note, 60, "pad_1")
        .unwrap();
    e.connect("midi1", "pad_1", "adsr1", "gate").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("adsr1", "env", "vca1", "cv").unwrap();
    // A wired input adds to its knob baseline; close the gain knob so the
    // envelope alone opens the VCA and the source really is a blip.
    e.set_knob_value("vca1", "cv", 0.0).unwrap();
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
    crate::common::window_peaks(signal, (win * SR) as usize)
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

// ---------------------------------------------------------------------------
// Reverb
// ---------------------------------------------------------------------------

/// Blip -> reverb -> stereo out, with the wet/dry and tank knobs applied.
fn reverb_patch(decay: f32, mix: f32, freeze: f32) -> Engine {
    let mut e = stereo_engine();
    add_blip_source(&mut e);
    e.add_module("rev", "com.dj.reverb").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("vca1", "out", "rev", "in_l").unwrap();
    e.connect("vca1", "out", "rev", "in_r").unwrap();
    e.connect("rev", "out_l", "out1", "l").unwrap();
    e.connect("rev", "out_r", "out1", "r").unwrap();
    e.set_knob_value("rev", "decay", decay).unwrap();
    e.set_knob_value("rev", "mix", mix).unwrap();
    e.set_knob_position("rev", "freeze", freeze).unwrap();
    e
}

#[test]
fn reverb_tail_decays_and_is_stereo() {
    let mut e = reverb_patch(0.6, 1.0, 0.0);
    blip_at(&mut e, 0.05, 0.05);
    let out = e.render_offline((2.0 * SR) as usize).unwrap();
    assert_finite(&out[0], "reverb L");
    assert_finite(&out[1], "reverb R");

    let seg = |ch: usize, a: f32, b: f32| rms(&out[ch][(a * SR) as usize..(b * SR) as usize]);
    let early = seg(0, 0.15, 0.35);
    let mid = seg(0, 0.6, 0.8);
    let late = seg(0, 1.6, 1.8);
    assert!(early > 1e-3, "no reverb tail: {early}");
    assert!(mid < early, "tail not decaying: {mid} vs {early}");
    assert!(late < mid, "tail not decaying: {late} vs {mid}");
    // The two output taps are decorrelated, not a copy of each other.
    let a = &out[0][(0.2 * SR) as usize..(0.6 * SR) as usize];
    let b = &out[1][(0.2 * SR) as usize..(0.6 * SR) as usize];
    let diff = a
        .iter()
        .zip(b)
        .map(|(x, y)| (x - y) * (x - y))
        .sum::<f32>()
        .sqrt();
    assert!(diff > 1e-2, "reverb outputs are identical, expected stereo");
}

#[test]
fn reverb_dry_path_is_unity_at_zero_mix() {
    let mut e = reverb_patch(0.6, 0.0, 0.0);
    blip_at(&mut e, 0.05, 0.1);
    let out = e.render_offline((0.5 * SR) as usize).unwrap();
    let tail = rms(&out[0][(0.3 * SR) as usize..]);
    let body = rms(&out[0][(0.07 * SR) as usize..(0.14 * SR) as usize]);
    assert!(body > 1.0, "dry signal missing at mix=0: {body}");
    assert!(tail < 1e-4, "wet leaked at mix=0: {tail}");
}

#[test]
fn reverb_freeze_holds_the_tail_and_mutes_the_input() {
    let mut e = reverb_patch(0.5, 1.0, 0.0);
    blip_at(&mut e, 0.05, 0.2);
    // A second blip lands well after the freeze; it must not enter the tank.
    blip_at(&mut e, 1.6, 0.3);
    // Freeze once the first blip has filled the tank. `out` starts here.
    e.process_blocks((0.6 * SR) as usize / 512).unwrap();
    e.set_knob_position("rev", "freeze", 1.0).unwrap();
    let out = e.render_offline((3.0 * SR) as usize).unwrap();
    assert_finite(&out[0], "reverb freeze");
    let seg = |a: f32, b: f32| rms(&out[0][(a * SR) as usize..(b * SR) as usize]);
    let first = seg(0.1, 0.5);
    let last = seg(2.4, 2.9);
    assert!(last > 1e-3, "frozen tail died out: {last}");
    assert!(
        last > 0.2 * first,
        "frozen tail decayed too far: {last} vs {first}"
    );
    // Windows before/during the muted second blip stay in the same ballpark.
    let before = seg(0.7, 0.95);
    let during = seg(1.05, 1.3);
    assert!(
        during < 2.0 * before,
        "input leaked into the frozen tank: {during} vs {before}"
    );
    let peak = out[0].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    assert!(peak < 12.5, "frozen tank exceeded the ceiling: {peak}");
}

// ---------------------------------------------------------------------------
// Modulation FX
// ---------------------------------------------------------------------------

/// Sine -> modfx -> stereo out. `mode`: 0 chorus, 1 flanger, 2 phaser.
fn modfx_patch(mode: f32, depth: f32, feedback: f32, mix: f32) -> Engine {
    let mut e = stereo_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("fx", "com.dj.modfx").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "fx", "in_l").unwrap();
    e.connect("osc1", "audio", "fx", "in_r").unwrap();
    e.connect("fx", "out_l", "out1", "l").unwrap();
    e.connect("fx", "out_r", "out1", "r").unwrap();
    e.set_knob_value("fx", "mode", mode).unwrap();
    e.set_knob_value("fx", "rate", 2.0).unwrap();
    e.set_knob_value("fx", "depth", depth).unwrap();
    e.set_knob_value("fx", "feedback", feedback).unwrap();
    e.set_knob_value("fx", "mix", mix).unwrap();
    e
}

/// Spread of the 10 ms peak envelope over `signal`, relative to its mean:
/// 0 for a steady tone, large when the effect sweeps comb notches.
fn envelope_swing(signal: &[f32]) -> f32 {
    let env = envelope(signal, 0.01);
    let body = &env[10..env.len() - 1];
    let mean = body.iter().sum::<f32>() / body.len() as f32;
    let min = body.iter().fold(f32::MAX, |m, &x| m.min(x));
    let max = body.iter().fold(0.0f32, |m, &x| m.max(x));
    (max - min) / mean.max(1e-9)
}

#[test]
fn modfx_all_modes_sweep_and_stay_bounded() {
    // A steady sine through each mode picks up sweeping comb/notch
    // amplitude modulation; the raw oscillator does not.
    let mut plain = stereo_engine();
    plain.add_module("osc1", "com.dj.oscillator").unwrap();
    plain.add_module("out1", "builtin.audio_out").unwrap();
    plain.connect("osc1", "audio", "out1", "l").unwrap();
    let dry = plain.render_offline((1.5 * SR) as usize).unwrap();
    assert!(envelope_swing(&dry[0]) < 0.05, "dry tone is not steady");

    for (mode, name, fb) in [
        (0.0, "chorus", 0.3),
        (1.0, "flanger", 0.8),
        (2.0, "phaser", 0.6),
    ] {
        let mut e = modfx_patch(mode, 0.8, fb, 0.5);
        let out = e.render_offline((1.5 * SR) as usize).unwrap();
        assert_finite(&out[0], name);
        let swing = envelope_swing(&out[0]);
        assert!(swing > 0.2, "{name}: no modulation (swing {swing})");
        let peak = out[0].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
        assert!(peak < 10.0, "{name}: level runaway ({peak})");
    }
}

#[test]
fn modfx_spread_decorrelates_the_channels() {
    let mut e = modfx_patch(0.0, 0.9, 0.0, 0.5);
    e.set_knob_value("fx", "spread", 1.0).unwrap();
    let out = e.render_offline((1.0 * SR) as usize).unwrap();
    let (l, r) = (
        &out[0][(0.2 * SR) as usize..],
        &out[1][(0.2 * SR) as usize..],
    );
    let diff = rms(&l.iter().zip(r).map(|(a, b)| a - b).collect::<Vec<_>>());
    assert!(diff > 0.1, "spread produced identical channels: {diff}");

    let mut mono = modfx_patch(0.0, 0.9, 0.0, 0.5);
    mono.set_knob_value("fx", "spread", 0.0).unwrap();
    let out = mono.render_offline((1.0 * SR) as usize).unwrap();
    let (l, r) = (
        &out[0][(0.2 * SR) as usize..],
        &out[1][(0.2 * SR) as usize..],
    );
    let diff = rms(&l.iter().zip(r).map(|(a, b)| a - b).collect::<Vec<_>>());
    assert!(
        diff < 1e-6,
        "no spread should keep the channels equal: {diff}"
    );
}

#[test]
fn modfx_through_zero_flanger_nulls() {
    // Through-zero: the dry path is delayed by the sweep centre and the wet
    // path inverted, so the two cancel each time the sweep crosses zero.
    let mut e = modfx_patch(1.0, 1.0, 0.0, 0.5);
    e.set_knob_value("fx", "rate", 1.0).unwrap();
    e.set_knob_position("fx", "through_zero", 1.0).unwrap();
    let out = e.render_offline((1.5 * SR) as usize).unwrap();
    assert_finite(&out[0], "through-zero flanger");
    // 1 ms windows: the null is deep but brief (the sweep crosses zero at
    // ~700 samples/s), so a longer window would smear it.
    let env = envelope(&out[0], 0.001);
    let body = &env[200..];
    let min = body.iter().fold(f32::MAX, |m, &x| m.min(x));
    let max = body.iter().fold(0.0f32, |m, &x| m.max(x));
    assert!(max > 1.0, "through-zero flanger has no peaks: {max}");
    assert!(
        min < 0.05 * max,
        "no through-zero null: min {min} max {max}"
    );

    // The through-zero path (delayed dry, inverted wet) is audibly its own
    // effect, not the same signal as the ordinary flanger.
    let mut plain = modfx_patch(1.0, 1.0, 0.0, 0.5);
    plain.set_knob_value("fx", "rate", 1.0).unwrap();
    let plain_out = plain.render_offline((1.5 * SR) as usize).unwrap();
    let diff = rms(&out[0]
        .iter()
        .zip(&plain_out[0])
        .map(|(a, b)| a - b)
        .collect::<Vec<_>>());
    assert!(diff > 0.5, "through-zero matched the plain flanger: {diff}");
}

// ---------------------------------------------------------------------------
// Compressor
// ---------------------------------------------------------------------------

/// Peak level of `signal` in dBFS (5 V = 0 dBFS, PRD §4).
fn peak_dbfs(signal: &[f32]) -> f32 {
    let peak = signal.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    20.0 * (peak / 5.0).max(1e-9).log10()
}

/// Osc -> VCA(`level`, 0..1) -> compressor -> out L; `gr` on out R.
fn compressor_patch(level: f32) -> Engine {
    let mut e = stereo_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("comp", "com.dj.compressor").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("vca1", "out", "comp", "in_l").unwrap();
    e.connect("comp", "out_l", "out1", "l").unwrap();
    e.connect("comp", "gr", "out1", "r").unwrap();
    e.set_knob_value("vca1", "cv", 10.0 * level).unwrap();
    e.set_knob_value("comp", "attack", 0.002).unwrap();
    e.set_knob_value("comp", "release", 0.3).unwrap();
    e.set_knob_value("comp", "knee", 0.0).unwrap();
    e
}

#[test]
fn compressor_applies_the_static_curve() {
    // 0 dBFS in, threshold -12 dB, 4:1, hard knee => -9 dBFS out.
    let mut e = compressor_patch(1.0);
    e.set_knob_value("comp", "threshold", -12.0).unwrap();
    e.set_knob_value("comp", "ratio", 4.0).unwrap();
    let out = e.render_offline((1.0 * SR) as usize).unwrap();
    assert_finite(&out[0], "compressor");
    let settled = &out[0][(0.6 * SR) as usize..];
    let db = peak_dbfs(settled);
    assert!((db + 9.0).abs() < 1.0, "compressed peak {db:.2} dBFS != -9");
    // The gain-reduction CV reports the same 9 dB at 0.5 V/dB.
    let gr = out[1][(0.9 * SR) as usize..].iter().sum::<f32>()
        / out[1][(0.9 * SR) as usize..].len() as f32;
    assert!((gr - 4.5).abs() < 0.5, "gr CV {gr:.2} V != 4.5 V (9 dB)");
}

#[test]
fn compressor_passes_signals_below_threshold() {
    let mut e = compressor_patch(0.1); // -20 dBFS
    e.set_knob_value("comp", "threshold", -12.0).unwrap();
    e.set_knob_value("comp", "ratio", 8.0).unwrap();
    let out = e.render_offline((0.5 * SR) as usize).unwrap();
    let db = peak_dbfs(&out[0][(0.3 * SR) as usize..]);
    assert!(
        (db + 20.0).abs() < 0.2,
        "below threshold changed: {db} dBFS"
    );
    let gr = out[1][(0.4 * SR) as usize..]
        .iter()
        .fold(0.0f32, |m, &x| m.max(x));
    assert!(gr < 0.05, "gain reduction below threshold: {gr} V");
}

#[test]
fn compressor_sidechain_replaces_the_internal_detector() {
    let mut e = compressor_patch(0.2); // -14 dBFS programme
    e.set_knob_value("comp", "threshold", -20.0).unwrap();
    e.set_knob_value("comp", "ratio", 8.0).unwrap();
    let quiet = e.render_offline((0.5 * SR) as usize).unwrap();
    // Internal detector: -14 dBFS is 6 dB over threshold => -19.25 dBFS out.
    let unducked = peak_dbfs(&quiet[0][(0.3 * SR) as usize..]);
    assert!(
        (unducked + 19.25).abs() < 1.0,
        "internal detector output {unducked:.2} dBFS != -19.25"
    );

    // Same patch, but a full-scale tone drives the sidechain.
    let mut e = compressor_patch(0.2);
    e.set_knob_value("comp", "threshold", -20.0).unwrap();
    e.set_knob_value("comp", "ratio", 8.0).unwrap();
    e.add_module("osc2", "com.dj.oscillator").unwrap();
    e.set_knob_value("osc2", "pitch", -1.0).unwrap();
    e.connect("osc2", "audio", "comp", "sidechain").unwrap();
    let out = e.render_offline((0.5 * SR) as usize).unwrap();
    let ducked = peak_dbfs(&out[0][(0.3 * SR) as usize..]);
    // The sidechain (0 dBFS, 20 dB over threshold, 8:1) takes over the
    // detector completely: 17.5 dB of reduction on the -14 dBFS programme.
    assert!(
        (ducked + 31.5).abs() < 1.0,
        "sidechained output {ducked:.2} dBFS != -31.5 (was {unducked:.2})"
    );
}

#[test]
fn compressor_attack_follows_the_time_constant() {
    let mut e = stereo_engine();
    add_blip_source(&mut e);
    e.add_module("comp", "com.dj.compressor").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("vca1", "out", "comp", "in_l").unwrap();
    e.connect("comp", "out_l", "out1", "l").unwrap();
    e.connect("comp", "gr", "out1", "r").unwrap();
    e.set_knob_value("comp", "threshold", -20.0).unwrap();
    e.set_knob_value("comp", "ratio", 8.0).unwrap();
    e.set_knob_value("comp", "attack", 0.05).unwrap();
    e.set_knob_value("comp", "release", 0.3).unwrap();
    e.set_knob_value("comp", "knee", 0.0).unwrap();
    blip_at(&mut e, 0.20, 0.6);

    let out = e.render_offline((0.9 * SR) as usize).unwrap();
    let gr = &out[1];
    let final_gr = gr[(0.75 * SR) as usize];
    assert!(
        final_gr > 5.0,
        "no gain reduction on a loud tone: {final_gr}"
    );
    // One time constant after onset the reduction is ~63 % of the final.
    let at_tau = gr[((0.20 + 0.05) * SR) as usize];
    let frac = at_tau / final_gr;
    assert!(
        (frac - 0.63).abs() < 0.15,
        "gr at one attack constant is {frac:.2} of final, expected ~0.63"
    );
}

// ---------------------------------------------------------------------------
// Granular
// ---------------------------------------------------------------------------

/// Osc -> granular -> stereo out, wet only unless `mix` says otherwise.
fn granular_patch(density: f32, size: f32, pitch: f32, mix: f32) -> Engine {
    let mut e = stereo_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("gran", "com.dj.granular").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "gran", "in_l").unwrap();
    e.connect("osc1", "audio", "gran", "in_r").unwrap();
    e.connect("gran", "out_l", "out1", "l").unwrap();
    e.connect("gran", "out_r", "out1", "r").unwrap();
    e.set_knob_value("gran", "density", density).unwrap();
    e.set_knob_value("gran", "size", size).unwrap();
    e.set_knob_value("gran", "pitch", pitch).unwrap();
    e.set_knob_value("gran", "mix", mix).unwrap();
    e.set_knob_value("gran", "spread", 0.0).unwrap();
    e
}

/// Zero crossings per second (a cheap fundamental estimate for tones).
fn zero_cross_hz(signal: &[f32]) -> f32 {
    let crossings = signal
        .windows(2)
        .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
        .count();
    crossings as f32 * SR / signal.len() as f32
}

/// Fundamental of `signal` by autocorrelation, searched between `min_hz`
/// and `max_hz` — robust where zero crossings are fooled by harmonics.
fn autocorr_hz(signal: &[f32], min_hz: f32, max_hz: f32) -> f32 {
    let mean = signal.iter().sum::<f32>() / signal.len() as f32;
    let x: Vec<f32> = signal.iter().map(|v| v - mean).collect();
    let min_lag = (SR / max_hz) as usize;
    let max_lag = ((SR / min_hz) as usize).min(x.len() / 2);
    let mut best = (min_lag, f32::MIN);
    for lag in min_lag..max_lag {
        let r: f32 = x[..x.len() - lag]
            .iter()
            .zip(&x[lag..])
            .map(|(a, b)| a * b)
            .sum();
        if r > best.1 {
            best = (lag, r);
        }
    }
    SR / best.0 as f32
}

/// Fundamental of the loudest `win`-second window — measuring the whole
/// signal would count silent gaps between sparse grains as low frequency.
fn dominant_hz(signal: &[f32], win: f32) -> f32 {
    let chunk = (win * SR) as usize;
    signal
        .chunks(chunk)
        .filter(|c| c.len() == chunk)
        .max_by(|a, b| rms(a).partial_cmp(&rms(b)).unwrap())
        .map(zero_cross_hz)
        .unwrap_or(0.0)
}

#[test]
fn granular_grains_are_windowed_and_bounded() {
    let mut e = granular_patch(30.0, 0.05, 0.0, 1.0);
    let out = e.render_offline((1.5 * SR) as usize).unwrap();
    assert_finite(&out[0], "granular");
    let body = &out[0][(0.5 * SR) as usize..];
    assert!(rms(body) > 0.3, "granular output is silent: {}", rms(body));
    // Windowed grains never step: the largest sample-to-sample jump stays
    // in the same ballpark as the source tone's own slope (~0.17 V).
    let jump = body
        .windows(2)
        .fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()));
    assert!(jump < 1.0, "grain discontinuity (click) of {jump} V");
}

#[test]
fn granular_pitch_transposes_grains() {
    // Sparse, non-overlapping grains so the measured pitch is one grain's.
    for (pitch, expected) in [(0.0f32, 261.6f32), (1.0, 523.25), (-1.0, 130.8)] {
        let mut e = granular_patch(2.0, 0.3, pitch, 1.0);
        let out = e.render_offline((3.0 * SR) as usize).unwrap();
        assert_finite(&out[0], "granular pitch");
        let hz = dominant_hz(&out[0][(1.0 * SR) as usize..], 0.2);
        assert!(
            (hz - expected).abs() < 0.05 * expected,
            "pitch {pitch}: grains read {hz:.1} Hz, expected ~{expected:.1}"
        );
    }
}

#[test]
fn granular_freeze_keeps_playing_without_input() {
    let mut e = stereo_engine();
    add_blip_source(&mut e);
    e.add_module("gran", "com.dj.granular").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("vca1", "out", "gran", "in_l").unwrap();
    e.connect("vca1", "out", "gran", "in_r").unwrap();
    e.connect("gran", "out_l", "out1", "l").unwrap();
    e.connect("gran", "out_r", "out1", "r").unwrap();
    e.set_knob_value("gran", "density", 25.0).unwrap();
    e.set_knob_value("gran", "size", 0.1).unwrap();
    e.set_knob_value("gran", "position", 0.05).unwrap();
    e.set_knob_value("gran", "mix", 1.0).unwrap();
    // Fill the buffer with a tone, then freeze once the source is silent.
    blip_at(&mut e, 0.05, 0.6);
    e.process_blocks((0.9 * SR) as usize / 512).unwrap();
    e.set_knob_position("gran", "freeze", 1.0).unwrap();
    let out = e.render_offline((1.0 * SR) as usize).unwrap();
    assert_finite(&out[0], "granular freeze");
    let level = rms(&out[0][(0.3 * SR) as usize..]);
    assert!(level > 0.2, "frozen buffer stopped playing: {level}");
}

#[test]
fn granular_mix_and_density_extremes_are_sane() {
    // mix = 0 is a bit-exact dry path.
    let mut dry = granular_patch(30.0, 0.05, 0.0, 0.0);
    let out = dry.render_offline((0.3 * SR) as usize).unwrap();
    let mut plain = stereo_engine();
    plain.add_module("osc1", "com.dj.oscillator").unwrap();
    plain.add_module("out1", "builtin.audio_out").unwrap();
    plain.connect("osc1", "audio", "out1", "l").unwrap();
    let reference = plain.render_offline((0.3 * SR) as usize).unwrap();
    let diff = out[0]
        .iter()
        .zip(&reference[0])
        .fold(0.0f32, |m, (a, b)| m.max((a - b).abs()));
    assert!(diff < 1e-6, "mix=0 is not a clean dry path: {diff}");

    // Maximum density with long grains keeps the pool bounded.
    let mut dense = granular_patch(150.0, 0.5, 0.0, 1.0);
    dense.set_knob_value("gran", "spread", 1.0).unwrap();
    dense.set_knob_value("gran", "feedback", 0.9).unwrap();
    let out = dense.render_offline((2.0 * SR) as usize).unwrap();
    assert_finite(&out[0], "granular dense");
    let peak = out[0].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    assert!(peak < 9.0, "dense granular exceeded the ceiling: {peak}");
}

// ---------------------------------------------------------------------------
// Resonator
// ---------------------------------------------------------------------------

/// Resonator with its internal exciter, triggered by MIDI-gated pulses.
/// `mode`: 0 modal, 1 Karplus-Strong strings.
fn resonator_patch(mode: f32, pitch: f32) -> Engine {
    let mut e = stereo_engine();
    e.add_module("midi1", "builtin.midi").unwrap();
    e.add_module("res", "com.dj.resonator").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.add_midi_mapping("midi1", MidiMapKind::Note, 60, "pad_1")
        .unwrap();
    e.connect("midi1", "pad_1", "res", "trig").unwrap();
    e.connect("res", "out_l", "out1", "l").unwrap();
    e.connect("res", "out_r", "out1", "r").unwrap();
    e.set_knob_value("res", "mode", mode).unwrap();
    e.set_knob_value("res", "pitch", pitch).unwrap();
    e.set_knob_value("res", "damping", 0.35).unwrap(); // ~1.8 s decay
    e.set_knob_value("res", "structure", 0.0).unwrap();
    e.set_knob_value("res", "brightness", 0.5).unwrap();
    e
}

fn trig_at(e: &mut Engine, t: f32) {
    e.inject_midi("midi1", (t * SR) as u64, [0x90, 60, 100])
        .unwrap();
    e.inject_midi("midi1", ((t + 0.005) * SR) as u64, [0x80, 60, 0])
        .unwrap();
}

#[test]
fn resonator_modal_rings_at_the_patched_pitch() {
    // Trigger the internal exciter; the modal bank should ring at C4 and
    // decay away rather than sustain forever.
    let mut e = resonator_patch(0.0, 0.0);
    trig_at(&mut e, 0.05);
    let out = e.render_offline((2.0 * SR) as usize).unwrap();
    assert_finite(&out[0], "modal resonator");
    let sum: Vec<f32> = out[0].iter().zip(&out[1]).map(|(a, b)| a + b).collect();
    let hz = dominant_hz(&sum[(0.1 * SR) as usize..], 0.1);
    assert!(
        (hz - 261.6).abs() < 15.0,
        "modal fundamental {hz:.1} Hz, expected ~261.6"
    );
    let early = rms(&sum[(0.1 * SR) as usize..(0.3 * SR) as usize]);
    let late = rms(&sum[(1.5 * SR) as usize..]);
    assert!(early > 0.05, "modal bank did not ring: {early}");
    assert!(
        late < 0.5 * early,
        "modal ring never decays: {late}/{early}"
    );
    // Odd/even partials are split across the outputs.
    let diff = rms(&out[0]
        .iter()
        .zip(&out[1])
        .map(|(a, b)| a - b)
        .collect::<Vec<_>>());
    assert!(diff > 1e-3, "modal outputs are identical: {diff}");
}

#[test]
fn resonator_string_mode_tracks_1v_oct() {
    for (pitch, expected) in [(0.0f32, 261.6f32), (-1.0, 130.8)] {
        let mut e = resonator_patch(1.0, pitch);
        e.set_knob_value("res", "voices", 1.0).unwrap();
        e.set_knob_value("res", "brightness", 0.8).unwrap();
        trig_at(&mut e, 0.05);
        let out = e.render_offline((1.0 * SR) as usize).unwrap();
        assert_finite(&out[0], "string resonator");
        // Measure once the loop filter has settled the pluck (the initial
        // burst is still broadband, so autocorrelation over harmonics).
        let hz = autocorr_hz(
            &out[0][(0.3 * SR) as usize..(0.5 * SR) as usize],
            60.0,
            900.0,
        );
        assert!(
            (hz - expected).abs() < 0.05 * expected,
            "string at pitch {pitch} rang at {hz:.1} Hz, expected ~{expected:.1}"
        );
    }
}

#[test]
fn resonator_external_exciter_replaces_the_internal_one() {
    // Patched exciter: the resonator sings without any trigger.
    let mut e = stereo_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("res", "com.dj.resonator").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "res", "in").unwrap();
    e.connect("res", "out_l", "out1", "l").unwrap();
    e.connect("res", "out_r", "out1", "r").unwrap();
    e.set_knob_value("osc1", "pitch", -2.0).unwrap();
    e.set_knob_value("res", "damping", 0.6).unwrap();
    let out = e.render_offline((0.6 * SR) as usize).unwrap();
    assert_finite(&out[0], "excited resonator");
    let level = rms(&out[0][(0.3 * SR) as usize..]);
    assert!(level > 0.05, "external exciter produced nothing: {level}");

    // Without a wire, an untriggered resonator is silent.
    let mut quiet = resonator_patch(0.0, 0.0);
    let out = quiet.render_offline((0.3 * SR) as usize).unwrap();
    let level = rms(&out[0]);
    assert!(level < 1e-6, "untriggered resonator is not silent: {level}");
}

#[test]
fn resonator_stays_bounded_with_minimum_damping() {
    for mode in [0.0f32, 1.0] {
        let mut e = resonator_patch(mode, 0.0);
        e.set_knob_value("res", "damping", 0.0).unwrap(); // longest decay
        e.set_knob_value("res", "voices", 4.0).unwrap();
        for i in 0..8 {
            trig_at(&mut e, 0.05 + i as f32 * 0.2);
        }
        let out = e.render_offline((3.0 * SR) as usize).unwrap();
        assert_finite(&out[0], "resonator sustain");
        let peak = out[0].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
        assert!(peak < 9.0, "mode {mode}: level runaway ({peak})");
    }
}

// ---------------------------------------------------------------------------
// Scope (analysis)
// ---------------------------------------------------------------------------

/// Osc -> scope, with every measurement output wired to a VCA input so the
/// test can read it back through jack telemetry.
fn scope_patch(pitch: f32, waveform: f32, level: f32) -> Engine {
    let mut e = stereo_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("scope", "com.dj.scope").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("vca1", "out", "scope", "in").unwrap();
    e.connect("scope", "thru", "out1", "l").unwrap();
    e.set_knob_value("osc1", "pitch", pitch).unwrap();
    e.set_knob_value("osc1", "waveform", waveform).unwrap();
    e.set_knob_value("vca1", "cv", 10.0 * level).unwrap();
    for (i, jack) in ["pitch", "hz", "peak", "rms", "trig"].iter().enumerate() {
        let probe = format!("probe{i}");
        e.add_module(&probe, "com.dj.vca").unwrap();
        e.connect("scope", jack, &probe, "in").unwrap();
    }
    e
}

/// Read a scope output through its probe VCA's input telemetry.
fn probe(e: &Engine, index: usize) -> f32 {
    e.tap(&format!("probe{index}"), "in").unwrap().instantaneous
}

#[test]
fn scope_passes_audio_through_unchanged() {
    let mut e = scope_patch(0.0, 1.0, 1.0); // saw, full level
    let out = e.render_offline((0.2 * SR) as usize).unwrap();
    let mut plain = stereo_engine();
    plain.add_module("osc1", "com.dj.oscillator").unwrap();
    plain.add_module("out1", "builtin.audio_out").unwrap();
    plain.connect("osc1", "audio", "out1", "l").unwrap();
    plain.set_knob_value("osc1", "waveform", 1.0).unwrap();
    let reference = plain.render_offline((0.2 * SR) as usize).unwrap();
    let diff = out[0]
        .iter()
        .zip(&reference[0])
        .fold(0.0f32, |m, (a, b)| m.max((a - b).abs()));
    assert!(diff < 1e-6, "scope altered the signal: {diff}");
}

#[test]
fn scope_detects_frequency_and_pitch() {
    for (pitch, hz) in [(0.0f32, 261.6f32), (-1.0, 130.8), (1.0, 523.3)] {
        for waveform in [0.0f32, 1.0, 2.0, 3.0] {
            let mut e = scope_patch(pitch, waveform, 1.0);
            e.render_offline((0.3 * SR) as usize).unwrap();
            let detected_pitch = probe(&e, 0);
            let detected_hz = probe(&e, 1) * 100.0;
            assert!(
                (detected_hz - hz).abs() < 0.02 * hz,
                "waveform {waveform}: detected {detected_hz:.1} Hz, expected {hz:.1}"
            );
            assert!(
                (detected_pitch - pitch).abs() < 0.05,
                "waveform {waveform}: detected pitch {detected_pitch:.3}, expected {pitch}"
            );
        }
    }
}

#[test]
fn scope_reports_peak_and_rms_levels() {
    let mut e = scope_patch(0.0, 0.0, 1.0); // sine at ±5 V
    e.render_offline((0.4 * SR) as usize).unwrap();
    let peak = probe(&e, 2);
    let level_rms = probe(&e, 3);
    assert!((peak - 5.0).abs() < 0.2, "peak {peak:.3} V != 5");
    assert!(
        (level_rms - 3.535).abs() < 0.2,
        "rms {level_rms:.3} V != 3.54 (5/sqrt(2))"
    );

    // Half amplitude halves both readings.
    let mut e = scope_patch(0.0, 0.0, 0.5);
    e.render_offline((0.4 * SR) as usize).unwrap();
    assert!((probe(&e, 2) - 2.5).abs() < 0.15, "peak at half level");
    assert!((probe(&e, 3) - 1.77).abs() < 0.15, "rms at half level");

    // Silence: levels fall away and `hz` reports "unvoiced".
    let mut e = scope_patch(0.0, 0.0, 0.0);
    e.render_offline((0.5 * SR) as usize).unwrap();
    assert!(probe(&e, 2) < 1e-3, "peak on silence");
    assert!(probe(&e, 1) < 1e-6, "hz should be 0 on silence");
}

#[test]
fn scope_trigger_fires_once_per_period() {
    let mut e = scope_patch(0.0, 0.0, 1.0);
    e.add_module("out2", "builtin.audio_out").unwrap();
    e.connect("scope", "trig", "out2", "r").unwrap();
    let out = e.render_offline((0.5 * SR) as usize).unwrap();
    let trig = &out[1][(0.1 * SR) as usize..];
    let pulses = trig
        .windows(2)
        .filter(|w| w[0] < 5.0 && w[1] >= 5.0)
        .count();
    let rate = pulses as f32 * SR / trig.len() as f32;
    assert!(
        (rate - 261.6).abs() < 10.0,
        "sync pulses at {rate:.1} Hz, expected one per 261.6 Hz period"
    );
    let high = trig.iter().fold(0.0f32, |m, &x| m.max(x));
    assert!(
        (high - 10.0).abs() < 1e-6,
        "trigger not a 10 V gate: {high}"
    );
}
