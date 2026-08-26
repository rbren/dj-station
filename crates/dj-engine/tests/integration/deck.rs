//! DJ Deck + Crossfader tests (PRD M2 acceptance):
//! - two decks through a crossfader produce equal-power gain curves,
//! - beat_clock pulses land on the beatgrid within one audio block and
//!   drive an ADSR into envelopes at beat positions,
//! - beat-sync aligns tempo and phase within ±1 ms sustained over 60 s,
//! - keylock holds pitch within ±10 cents at ±8 % tempo,
//! - hot cues, loops, slip mode, reverse, and patch persistence.

use dj_engine::{Engine, EngineConfig};
use std::path::{Path, PathBuf};

const SR: u32 = 48_000;
const BLOCK: usize = 128;

/// Deterministic 16-bit mono WAV: `freq` Hz sine at half amplitude.
fn write_tone(path: &Path, freq: f64, seconds: f64) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SR,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..(seconds * SR as f64) as u64 {
        let t = i as f64 / SR as f64;
        let x = (2.0 * std::f64::consts::PI * freq * t).sin() * 0.5;
        w.write_sample((x * i16::MAX as f64) as i16).unwrap();
    }
    w.finalize().unwrap();
}

/// A position-identifiable ramp: sample value == 0.9 * frame / total.
fn write_ramp(path: &Path, seconds: f64) -> u64 {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SR,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let total = (seconds * SR as f64) as u64;
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..total {
        let x = 0.9 * i as f64 / total as f64;
        w.write_sample((x * i16::MAX as f64) as i16).unwrap();
    }
    w.finalize().unwrap();
    total
}

/// Track position (seconds) encoded in a rendered ramp sample (engine
/// units), given the ramp's total frame count.
fn ramp_pos_secs(sample: f32, total: u64) -> f64 {
    (sample as f64 / 10.0 / 0.9) * total as f64 / SR as f64
}

/// Magnitude of `signal` at `freq` (rectangular-window DFT bin, amplitude
/// units — a pure sine of amplitude A at `freq` reads ~A).
fn tone_amplitude(signal: &[f32], freq: f64) -> f64 {
    let n = signal.len() as f64;
    let (mut re, mut im) = (0.0f64, 0.0f64);
    for (i, &x) in signal.iter().enumerate() {
        let ph = 2.0 * std::f64::consts::PI * freq * i as f64 / SR as f64;
        re += x as f64 * ph.cos();
        im -= x as f64 * ph.sin();
    }
    2.0 * (re * re + im * im).sqrt() / n
}

fn zero_crossing_hz(signal: &[f32]) -> f64 {
    let crossings = signal
        .windows(2)
        .filter(|w| (w[0] >= 0.0) != (w[1] >= 0.0))
        .count();
    crossings as f64 / 2.0 / (signal.len() as f64 / SR as f64)
}

/// Sample indices of rising edges above `thresh`, ignoring re-triggers
/// within `min_gap` samples.
fn rising_edges(signal: &[f32], thresh: f32, min_gap: usize) -> Vec<usize> {
    let mut edges = Vec::new();
    let mut last: Option<usize> = None;
    for i in 1..signal.len() {
        if signal[i] >= thresh && signal[i - 1] < thresh {
            if let Some(l) = last {
                if i - l < min_gap {
                    continue;
                }
            }
            edges.push(i);
            last = Some(i);
        }
    }
    edges
}

fn mono_engine() -> Engine {
    let config = EngineConfig {
        master_channels: 1,
        ..EngineConfig::default()
    };
    Engine::new(config, crate::common::registry()).unwrap()
}

fn play(e: &mut Engine, deck: &str) {
    e.set_knob_position(deck, "play_gate", 1.0).unwrap();
}

// ---------------------------------------------------------------------------
// Criterion 1: two decks + crossfader gain curves
// ---------------------------------------------------------------------------

#[test]
fn two_decks_through_crossfader_follow_equal_power_gain_curves() {
    let tmp = tempfile::tempdir().unwrap();
    let tone_a = tmp.path().join("a.wav");
    let tone_b = tmp.path().join("b.wav");
    // Bin-exact frequencies for the 0.1 s measurement window.
    write_tone(&tone_a, 480.0, 8.0);
    write_tone(&tone_b, 1200.0, 8.0);

    let mut e = mono_engine();
    e.add_module("deckA", "builtin.deck").unwrap();
    e.add_module("deckB", "builtin.deck").unwrap();
    e.add_module("xf1", "builtin.crossfader").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("deckA", "audio_l", "xf1", "a_l").unwrap();
    e.connect("deckB", "audio_l", "xf1", "b_l").unwrap();
    e.connect("xf1", "out_l", "out1", "l").unwrap();
    e.deck_load("deckA", &tone_a).unwrap();
    e.deck_load("deckB", &tone_b).unwrap();
    play(&mut e, "deckA");
    play(&mut e, "deckB");

    // Sweep the crossfader input across its range; measure each deck's
    // contribution per position (0.05 s settle + 0.1 s window).
    let settle = (0.05 * SR as f64) as usize;
    let window = (0.1 * SR as f64) as usize;
    let mut measured: Vec<(f64, f64, f64)> = Vec::new(); // (xfade, amp_a, amp_b)
    for step in 0..=10 {
        let xfade = -10.0 + 2.0 * step as f64;
        // Linear knob over [-10, 10]: position (x+10)/20.
        e.set_knob_position("xf1", "xfade", ((xfade + 10.0) / 20.0) as f32)
            .unwrap();
        let rendered = e.render_offline(settle + window).unwrap();
        let win = &rendered[0][settle..];
        measured.push((
            xfade,
            tone_amplitude(win, 480.0),
            tone_amplitude(win, 1200.0),
        ));
    }

    // Reference amplitude: each deck's full-gain contribution at its end
    // stop (x = -10 -> full A; x = +10 -> full B).
    let full_a = measured[0].1;
    let full_b = measured[10].2;
    assert!(full_a > 3.0, "deck A too quiet: {full_a}");
    assert!(full_b > 3.0, "deck B too quiet: {full_b}");

    for &(xfade, amp_a, amp_b) in &measured {
        let x = (xfade + 10.0) / 20.0;
        let expect_a = (x * std::f64::consts::FRAC_PI_2).cos();
        let expect_b = (x * std::f64::consts::FRAC_PI_2).sin();
        let got_a = amp_a / full_a;
        let got_b = amp_b / full_b;
        assert!(
            (got_a - expect_a).abs() < 0.02,
            "xfade {xfade}: deck A gain {got_a:.4}, expected {expect_a:.4}"
        );
        assert!(
            (got_b - expect_b).abs() < 0.02,
            "xfade {xfade}: deck B gain {got_b:.4}, expected {expect_b:.4}"
        );
    }
    // Equal-power center: both gains ~ -3 dB.
    let center = measured[5];
    assert!((center.1 / full_a - std::f64::consts::FRAC_1_SQRT_2).abs() < 0.02);
    assert!((center.2 / full_b - std::f64::consts::FRAC_1_SQRT_2).abs() < 0.02);
}

/// A fader hard over must silence the far side EXACTLY: `cos`/`sin` of the
/// f32 `FRAC_PI_2` overshoot zero by ~4e-8, which used to leak a
/// phase-inverted copy of the closed channel into the mix.
#[test]
fn crossfader_end_stops_silence_the_closed_channel_exactly() {
    let mut e = mono_engine();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("xf1", "builtin.crossfader").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "xf1", "a_l").unwrap();
    e.connect("osc1", "audio", "xf1", "a_r").unwrap();
    e.connect("xf1", "out_l", "out1", "l").unwrap();

    // Fader hard to B: nothing is patched into B, so the mix must be
    // digital silence, not a residue of A.
    e.set_knob_position("xf1", "xfade", 1.0).unwrap();
    let out = e.render_offline(4800).unwrap();
    let peak = out[0].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    assert_eq!(peak, 0.0, "A leaks at the B end stop");

    // The other end stop passes A at exactly unity.
    e.set_knob_position("xf1", "xfade", 0.0).unwrap();
    let out = e.render_offline(4800).unwrap();
    let peak = out[0].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    assert!(
        peak > 4.9,
        "A should reach ±5 V at its end stop, got {peak}"
    );
}

// ---------------------------------------------------------------------------
// Criterion 4: beat_clock on the grid + ADSR envelopes at beat positions
// ---------------------------------------------------------------------------

#[test]
fn beat_clock_lands_on_beatgrid_and_drives_adsr_envelopes() {
    let tmp = tempfile::tempdir().unwrap();
    let tone = tmp.path().join("tone.wav");
    write_tone(&tone, 440.0, 5.0);

    let config = EngineConfig::default(); // stereo master
    let mut e = Engine::new(config, crate::common::registry()).unwrap();
    e.add_module("deck1", "builtin.deck").unwrap();
    e.add_module("adsr1", "com.dj.adsr").unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    // ch1: the raw beat clock; ch2: osc through an ADSR'd VCA gated by it.
    e.connect("deck1", "beat_clock", "out1", "l").unwrap();
    e.connect("deck1", "beat_clock", "adsr1", "gate").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("adsr1", "env", "vca1", "cv").unwrap();
    e.connect("vca1", "out", "out1", "r").unwrap();
    e.set_knob_value("adsr1", "attack", 0.005).unwrap();
    e.set_knob_value("adsr1", "decay", 0.05).unwrap();
    e.set_knob_value("adsr1", "sustain", 0.5).unwrap();
    e.set_knob_value("adsr1", "release", 0.05).unwrap();
    // Wired inputs add to the knob baseline; zero the VCA's cv knob so the
    // envelope alone sets the gain.
    e.set_knob_value("vca1", "cv", 0.0).unwrap();

    e.deck_load("deck1", &tone).unwrap();
    e.deck_set_beatgrid("deck1", 120.0, 0.25).unwrap();
    play(&mut e, "deck1");

    let seconds = 3.0;
    let rendered = e.render_offline((seconds * SR as f64) as usize).unwrap();
    let clock = &rendered[0];
    let env_ch = &rendered[1];

    // Expected beats at 0.25 + k * 0.5 (rate = 1).
    let expected: Vec<f64> = (0..6).map(|k| 0.25 + 0.5 * k as f64).collect();
    let edges = rising_edges(clock, 5.0, 1000);
    assert_eq!(
        edges.len(),
        expected.len(),
        "beat count mismatch: {edges:?}"
    );
    for (edge, exp) in edges.iter().zip(&expected) {
        let exp_frame = (exp * SR as f64) as i64;
        let diff = (*edge as i64 - exp_frame).unsigned_abs() as usize;
        assert!(
            diff <= BLOCK,
            "beat pulse at frame {edge} deviates from expected {exp_frame} by {diff} (> one block)"
        );
    }

    // Each beat produces an envelope: strong onset after the beat, decayed
    // level right before the next one.
    for &exp in &expected[..5] {
        let b = (exp * SR as f64) as usize;
        let after = &env_ch[b..b + (0.06 * SR as f64) as usize];
        let before_start = b.saturating_sub((0.08 * SR as f64) as usize);
        let before = &env_ch[before_start..b.saturating_sub((0.01 * SR as f64) as usize)];
        let peak_after = after.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
        let peak_before = before.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
        assert!(
            peak_after > 1.0,
            "no envelope onset after beat at {exp}s (peak {peak_after})"
        );
        assert!(
            peak_after > peak_before * 2.0,
            "envelope at {exp}s not beat-shaped: after {peak_after} vs before {peak_before}"
        );
    }
}

// ---------------------------------------------------------------------------
// Criterion 5: keylock holds pitch within ±10 cents at ±8 % tempo
// ---------------------------------------------------------------------------

#[test]
fn keylock_holds_pitch_within_10_cents_at_plus_minus_8_percent() {
    let tmp = tempfile::tempdir().unwrap();
    let tone = tmp.path().join("tone.wav");
    write_tone(&tone, 440.0, 10.0);

    // ±10 cents around 440 Hz ≈ ±2.55 Hz.
    let cents_10 = 440.0 * (2f64.powf(10.0 / 1200.0) - 1.0);

    for (speed_pos, rate) in [(1.0f32, 1.08f64), (0.0f32, 0.92f64)] {
        let mut e = mono_engine();
        e.add_module("deck1", "builtin.deck").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.connect("deck1", "audio_l", "out1", "l").unwrap();
        e.deck_load("deck1", &tone).unwrap();
        e.set_param("deck1", "keylock", 1.0).unwrap();
        // pitch_range defaults to 0.08; speed knob end stops = ±8 %.
        e.set_knob_position("deck1", "speed", speed_pos).unwrap();
        play(&mut e, "deck1");

        let rendered = e.render_offline((4.0 * SR as f64) as usize).unwrap();
        let window = &rendered[0][(0.5 * SR as f64) as usize..(3.5 * SR as f64) as usize];
        let hz = zero_crossing_hz(window);
        assert!(
            (hz - 440.0).abs() <= cents_10,
            "keylock at rate {rate}: measured {hz:.2} Hz, expected 440 ±{cents_10:.2}"
        );

        // The tempo actually changed: the 10 s track must end near
        // 10 s / rate, not near 10 s. 4 s were already rendered; render up
        // to 1 s past the expected end and check both sides of it.
        let mut e_len = e;
        let expected_end = 10.0 / rate;
        let tail = e_len
            .render_offline(((expected_end + 1.0 - 4.0) * SR as f64) as usize)
            .unwrap();
        let at = |t: f64| (((t - 4.0) * SR as f64) as usize).min(tail[0].len());
        let before = &tail[0][at(expected_end - 0.5)..at(expected_end - 0.1)];
        let after = &tail[0][at(expected_end + 0.2)..];
        assert!(
            before.iter().any(|&x| x.abs() > 0.5),
            "track ended too early at rate {rate} (silent before {expected_end:.2}s)"
        );
        assert!(
            after.iter().all(|&x| x == 0.0),
            "track should have ended by {expected_end:.2}s at rate {rate}"
        );
    }

    // Contrast: without keylock, +8 % reads ~475 Hz (pitch follows tempo).
    let mut e = mono_engine();
    e.add_module("deck1", "builtin.deck").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("deck1", "audio_l", "out1", "l").unwrap();
    e.deck_load("deck1", &tone).unwrap();
    e.set_knob_position("deck1", "speed", 1.0).unwrap();
    play(&mut e, "deck1");
    let rendered = e.render_offline((2.0 * SR as f64) as usize).unwrap();
    let hz = zero_crossing_hz(&rendered[0][(0.5 * SR as f64) as usize..]);
    assert!(
        (hz - 475.2).abs() < 5.0,
        "without keylock expected ~475 Hz at +8 %, measured {hz:.2}"
    );
}

// ---------------------------------------------------------------------------
// Criterion 3: beat-sync within ±1 ms sustained over 60 s
// ---------------------------------------------------------------------------

#[test]
fn syncing_deck_b_to_deck_a_aligns_phase_within_1ms_over_60s() {
    let tmp = tempfile::tempdir().unwrap();
    let track_a = tmp.path().join("a.wav");
    let track_b = tmp.path().join("b.wav");
    write_tone(&track_a, 220.0, 70.0);
    write_tone(&track_b, 330.0, 70.0);

    let config = EngineConfig::default(); // stereo master
    let mut e = Engine::new(config, crate::common::registry()).unwrap();
    e.add_module("deckA", "builtin.deck").unwrap();
    e.add_module("deckB", "builtin.deck").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("deckA", "beat_clock", "out1", "l").unwrap();
    e.connect("deckB", "beat_clock", "out1", "r").unwrap();

    e.deck_load("deckA", &track_a).unwrap();
    e.deck_load("deckB", &track_b).unwrap();
    // Different manual grids: A at 128 BPM, B at 120 BPM with a different
    // anchor. Sync must tempo-match (rate 128/120) AND phase-align.
    e.deck_set_beatgrid("deckA", 128.0, 0.1).unwrap();
    e.deck_set_beatgrid("deckB", 120.0, 0.3).unwrap();
    e.deck_sync("deckB", Some("deckA")).unwrap();
    play(&mut e, "deckA");
    play(&mut e, "deckB");

    let seconds = 61.0;
    let rendered = e.render_offline((seconds * SR as f64) as usize).unwrap();
    let min_gap = (0.2 * SR as f64) as usize;
    let edges_a = rising_edges(&rendered[0], 5.0, min_gap);
    let edges_b = rising_edges(&rendered[1], 5.0, min_gap);
    assert!(
        edges_a.len() > 125,
        "deck A produced too few beats: {}",
        edges_a.len()
    );

    // Tempo aligned: over the render, both decks emit the same number of
    // beats (±1 boundary effect).
    assert!(
        (edges_a.len() as i64 - edges_b.len() as i64).abs() <= 1,
        "beat counts diverge: A {} vs B {}",
        edges_a.len(),
        edges_b.len()
    );

    // Phase aligned within ±1 ms for every beat after the first second
    // (sync engages on the first processed block), sustained to the end.
    let tolerance = (0.001 * SR as f64) as i64; // 48 samples
    let mut worst = 0i64;
    for &ea in edges_a.iter().filter(|&&x| x > SR as usize) {
        let nearest = edges_b
            .iter()
            .map(|&eb| (eb as i64 - ea as i64).abs())
            .min()
            .unwrap();
        worst = worst.max(nearest);
        assert!(
            nearest <= tolerance,
            "beat at {:.3}s misaligned by {} samples ({:.2} ms)",
            ea as f64 / SR as f64,
            nearest,
            nearest as f64 / SR as f64 * 1000.0
        );
    }
    println!(
        "sync: {} beats checked over {seconds}s, worst offset {} samples ({:.3} ms)",
        edges_a.len(),
        worst,
        worst as f64 / SR as f64 * 1000.0
    );
}

// ---------------------------------------------------------------------------
// Hot cues, loops, slip, reverse
// ---------------------------------------------------------------------------

#[test]
fn hot_cue_trigger_jumps_and_slip_returns_to_ghost() {
    let tmp = tempfile::tempdir().unwrap();
    let ramp = tmp.path().join("ramp.wav");
    let total = write_ramp(&ramp, 10.0);

    let mut e = mono_engine();
    e.add_module("deck1", "builtin.deck").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("deck1", "audio_l", "out1", "l").unwrap();
    e.deck_load("deck1", &ramp).unwrap();
    e.deck_set_cue("deck1", 2, Some(5.0)).unwrap();
    play(&mut e, "deck1");

    // Play 1 s, then fire cue 3 (slot index 2): the next render starts at
    // the cue point.
    e.render_offline(SR as usize).unwrap();
    e.set_knob_position("deck1", "cue_trig3", 1.0).unwrap();
    let seg = e.render_offline((0.2 * SR as f64) as usize).unwrap();
    let pos = ramp_pos_secs(seg[0][200], total);
    assert!(
        (pos - 5.0).abs() < 0.02,
        "cue jump landed at {pos:.3}s, expected 5.0s"
    );
    // Release the trigger and render so the falling edge is seen (slip is
    // off, so this is a no-op for position). Playhead: ~5.25 s.
    e.set_knob_position("deck1", "cue_trig3", 0.0).unwrap();
    e.render_offline((0.05 * SR as f64) as usize).unwrap();

    // Slip mode: enable slip (ghost = 5.25 s), hold the cue for 0.5 s
    // (audible plays from 5.0), release -> return to the ghost position
    // (5.25 + 0.5 = ~5.75 s), as if playback never jumped.
    e.set_param("deck1", "slip", 1.0).unwrap();
    e.set_knob_position("deck1", "cue_trig3", 1.0).unwrap();
    let held = e.render_offline((0.5 * SR as f64) as usize).unwrap();
    let held_pos = ramp_pos_secs(held[0][200], total);
    assert!(
        (held_pos - 5.0).abs() < 0.02,
        "slip cue hold plays from {held_pos:.3}s, expected 5.0s"
    );
    e.set_knob_position("deck1", "cue_trig3", 0.0).unwrap();
    let released = e.render_offline((0.1 * SR as f64) as usize).unwrap();
    let back_pos = ramp_pos_secs(released[0][200], total);
    assert!(
        (back_pos - 5.75).abs() < 0.03,
        "slip release resumed at {back_pos:.3}s, expected ~5.75s (ghost)"
    );
}

#[test]
fn loop_wraps_slip_loop_exit_returns_to_ghost_and_jack_toggles() {
    let tmp = tempfile::tempdir().unwrap();
    let ramp = tmp.path().join("ramp.wav");
    let total = write_ramp(&ramp, 10.0);

    let mut e = mono_engine();
    e.add_module("deck1", "builtin.deck").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("deck1", "audio_l", "out1", "l").unwrap();
    e.deck_load("deck1", &ramp).unwrap();
    e.deck_set_loop("deck1", 2.0, 2.5).unwrap();
    e.deck_loop_enable("deck1", true).unwrap();
    e.set_param("deck1", "slip", 1.0).unwrap();
    play(&mut e, "deck1");

    // After 4 s of play with a 0.5 s loop from 2.0: audible stays inside
    // the loop.
    let seg = e.render_offline(4 * SR as usize).unwrap();
    let end_pos = ramp_pos_secs(*seg[0].last().unwrap(), total);
    assert!(
        (2.0..2.5).contains(&end_pos),
        "loop escape: playhead at {end_pos:.3}s"
    );
    // Loop halve/double adjust the region.
    e.deck_loop_halve("deck1").unwrap();
    let st = e.deck_status("deck1").unwrap();
    assert_eq!(
        (st.loop_start_secs.unwrap(), st.loop_end_secs.unwrap()),
        (2.0, 2.25)
    );
    e.deck_loop_double("deck1").unwrap();
    let st = e.deck_status("deck1").unwrap();
    assert_eq!(st.loop_end_secs.unwrap(), 2.5);

    // Disabling the loop with slip on returns to the ghost (4 s of real
    // time elapsed -> ghost ~4.0 s).
    e.deck_loop_enable("deck1", false).unwrap();
    let seg = e.render_offline((0.1 * SR as f64) as usize).unwrap();
    let pos = ramp_pos_secs(seg[0][200], total);
    assert!(
        (pos - 4.0).abs() < 0.05,
        "slip loop exit resumed at {pos:.3}s, expected ~4.0s"
    );

    // The loop_toggle jack re-enables the loop on a rising edge (without
    // slip this time), and playback re-enters the region when reached.
    e.set_param("deck1", "slip", 0.0).unwrap();
    e.deck_seek("deck1", 2.1).unwrap();
    e.set_knob_position("deck1", "loop_toggle", 1.0).unwrap();
    let seg = e.render_offline(SR as usize).unwrap();
    let pos = ramp_pos_secs(*seg[0].last().unwrap(), total);
    assert!(
        (2.0..2.5).contains(&pos),
        "jack-toggled loop not looping: playhead at {pos:.3}s"
    );
}

#[test]
fn reverse_plays_backward() {
    let tmp = tempfile::tempdir().unwrap();
    let ramp = tmp.path().join("ramp.wav");
    let total = write_ramp(&ramp, 10.0);

    let mut e = mono_engine();
    e.add_module("deck1", "builtin.deck").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("deck1", "audio_l", "out1", "l").unwrap();
    e.deck_load("deck1", &ramp).unwrap();
    e.deck_seek("deck1", 5.0).unwrap();
    e.set_param("deck1", "reverse", 1.0).unwrap();
    play(&mut e, "deck1");

    let seg = e.render_offline(SR as usize).unwrap();
    let start = ramp_pos_secs(seg[0][200], total);
    let end = ramp_pos_secs(*seg[0].last().unwrap(), total);
    assert!((start - 5.0).abs() < 0.02, "reverse started at {start:.3}s");
    assert!(
        (end - 4.0).abs() < 0.02,
        "after 1 s of reverse expected ~4.0s, got {end:.3}s"
    );
}

// ---------------------------------------------------------------------------
// Tap tempo / grid manipulation
// ---------------------------------------------------------------------------

#[test]
fn tap_tempo_nudge_and_anchor_build_a_beatgrid() {
    let tmp = tempfile::tempdir().unwrap();
    let tone = tmp.path().join("tone.wav");
    write_tone(&tone, 440.0, 10.0);

    let mut e = mono_engine();
    e.add_module("deck1", "builtin.deck").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("deck1", "beat_clock", "out1", "l").unwrap();
    e.deck_load("deck1", &tone).unwrap();

    // Four taps at 0.5 s spacing -> 120 BPM anchored on the first tap.
    for k in 0..4 {
        e.deck_tap_tempo_at("deck1", 1.0 + 0.5 * k as f64).unwrap();
    }
    let (bpm, anchor) = e.deck_beatgrid("deck1").unwrap().unwrap();
    assert!((bpm - 120.0).abs() < 1e-9, "tap tempo bpm {bpm}");
    assert_eq!(anchor, 1.0);

    // Nudge shifts the anchor; a fresh tap run replaces the grid.
    e.deck_nudge_beatgrid("deck1", 0.02).unwrap();
    let (_, anchor) = e.deck_beatgrid("deck1").unwrap().unwrap();
    assert!((anchor - 1.02).abs() < 1e-9);

    // Beat clock follows the manual grid. The grid extends before the
    // anchor too: beats at 1.02 + k/2 for all integer k, so from track
    // start the first crossings are 0.02, 0.52, 1.02, ...
    play(&mut e, "deck1");
    let rendered = e.render_offline(3 * SR as usize).unwrap();
    let edges = rising_edges(&rendered[0], 5.0, 1000);
    let expected: Vec<f64> = (0..6).map(|k| 0.02 + 0.5 * k as f64).collect();
    assert_eq!(edges.len(), expected.len(), "{edges:?}");
    for (edge, exp) in edges.iter().zip(&expected) {
        let diff = (*edge as i64 - (exp * SR as f64) as i64).unsigned_abs() as usize;
        assert!(diff <= BLOCK, "beat at {edge} vs expected {exp}s");
    }

    // Anchor-here moves the anchor to the current playhead (3.0 s).
    e.deck_anchor_here("deck1").unwrap();
    let (_, anchor) = e.deck_beatgrid("deck1").unwrap().unwrap();
    assert!((anchor - 3.0).abs() < 0.01, "anchor_here got {anchor}");
}

// ---------------------------------------------------------------------------
// Persistence: track, sync partner, and params round-trip via the patch
// ---------------------------------------------------------------------------

#[test]
fn deck_track_sync_and_params_persist_through_patch_save_load() {
    let tmp = tempfile::tempdir().unwrap();
    let track_a = tmp.path().join("a.wav");
    let track_b = tmp.path().join("b.wav");
    write_tone(&track_a, 220.0, 2.0);
    write_tone(&track_b, 330.0, 2.0);
    let patch_dir: PathBuf = tmp.path().join("patch");

    {
        let mut e = mono_engine();
        e.add_module("deckA", "builtin.deck").unwrap();
        e.add_module("deckB", "builtin.deck").unwrap();
        e.add_module("xf1", "builtin.crossfader").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.connect("deckA", "audio_l", "xf1", "a_l").unwrap();
        e.connect("deckB", "audio_l", "xf1", "b_l").unwrap();
        e.connect("xf1", "out_l", "out1", "l").unwrap();
        e.deck_load("deckA", &track_a).unwrap();
        e.deck_load("deckB", &track_b).unwrap();
        e.deck_sync("deckB", Some("deckA")).unwrap();
        e.set_param("deckB", "keylock", 1.0).unwrap();
        e.set_param("deckB", "pitch_range", 0.16).unwrap();
        e.save_patch(&patch_dir, "deck-persist").unwrap();
    }

    let e2 = Engine::load_patch(&patch_dir, crate::common::registry()).unwrap();
    assert_eq!(
        e2.deck_track("deckA").unwrap().as_deref(),
        Some(track_a.to_string_lossy().as_ref())
    );
    assert_eq!(
        e2.deck_track("deckB").unwrap().as_deref(),
        Some(track_b.to_string_lossy().as_ref())
    );
    assert_eq!(e2.deck_sync_to("deckB").unwrap().as_deref(), Some("deckA"));
    assert_eq!(e2.deck_sync_to("deckA").unwrap(), None);
    let st = e2.deck_status("deckB").unwrap();
    assert_eq!(st.sync_to.as_deref(), Some("deckA"));
    // Keylock/pitch-range params round-trip via the params map.
    let node_b = e2.nodes.iter().find(|n| n.instance_id == "deckB").unwrap();
    assert_eq!(node_b.params["keylock"], 1.0);
    assert_eq!(node_b.params["pitch_range"], 0.16);
}
