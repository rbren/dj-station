//! Deck stem jacks + per-stem gains (PRD M3):
//! - muting a stem in an offline render measurably removes that stem's
//!   energy from the main outs (and only that stem's),
//! - the four stem jacks are independently routable through the graph,
//! - stem gains scale continuously and round-trip through patch
//!   save/load,
//! - clearing stems reverts to the original mix.

mod common;

use dj_engine::{Engine, EngineConfig};
use std::path::Path;

const SR: u32 = 48_000;

/// One tone per stem, chosen bin-exact for a 0.1 s window (multiples of
/// 10 Hz) and far apart so DFT leakage is negligible.
const STEM_FREQS: [f64; 4] = [1000.0, 2500.0, 60.0, 3500.0]; // vocals, drums, bass, other
const STEM_PARAMS: [&str; 4] = ["stem_vocals", "stem_drums", "stem_bass", "stem_other"];
const STEM_JACKS: [&str; 4] = ["stem_vocals", "stem_drums", "stem_bass", "stem_other"];

fn write_tone(path: &Path, freq: f64, amp: f64, seconds: f64) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SR,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..(seconds * SR as f64) as u64 {
        let t = i as f64 / SR as f64;
        let x = (2.0 * std::f64::consts::PI * freq * t).sin() * amp;
        w.write_sample((x * i16::MAX as f64) as i16).unwrap();
    }
    w.finalize().unwrap();
}

/// The "original mix": sum of the four stem tones.
fn write_mix(path: &Path, amp: f64, seconds: f64) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SR,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..(seconds * SR as f64) as u64 {
        let t = i as f64 / SR as f64;
        let x: f64 = STEM_FREQS
            .iter()
            .map(|f| (2.0 * std::f64::consts::PI * f * t).sin() * amp)
            .sum();
        w.write_sample((x * i16::MAX as f64) as i16).unwrap();
    }
    w.finalize().unwrap();
}

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

struct Fixture {
    _tmp: tempfile::TempDir,
    mix: std::path::PathBuf,
    stems: [std::path::PathBuf; 4],
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let mix = tmp.path().join("mix.wav");
    write_mix(&mix, 0.2, 4.0);
    let stems = std::array::from_fn(|k| {
        let p = tmp.path().join(format!("stem{k}.wav"));
        write_tone(&p, STEM_FREQS[k], 0.2, 4.0);
        p
    });
    Fixture {
        _tmp: tmp,
        mix,
        stems,
    }
}

fn deck_engine(channels: usize) -> Engine {
    let config = EngineConfig {
        master_channels: channels,
        ..EngineConfig::default()
    };
    let mut e = Engine::new(config, common::registry()).unwrap();
    e.add_module("deck1", "builtin.deck").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e
}

fn load_and_play(e: &mut Engine, fx: &Fixture) {
    e.deck_load("deck1", &fx.mix).unwrap();
    e.deck_load_stems("deck1", &fx.stems.clone()).unwrap();
    e.set_knob_position("deck1", "play_gate", 1.0).unwrap();
}

/// Render 0.6 s from the top of the track, returning the master buffers.
fn render(e: &mut Engine) -> Vec<Vec<f32>> {
    e.deck_seek("deck1", 0.0).unwrap();
    e.render_offline((0.6 * SR as f64) as usize).unwrap()
}

/// Amplitudes of the four stem tones in `signal`, skipping a settle
/// window.
fn stem_amps(signal: &[f32]) -> [f64; 4] {
    let skip = (0.1 * SR as f64) as usize;
    let win = &signal[skip..skip + (0.4 * SR as f64) as usize];
    std::array::from_fn(|k| tone_amplitude(win, STEM_FREQS[k]))
}

#[test]
fn muting_each_stem_removes_its_energy_and_only_its_energy() {
    let fx = fixture();
    let mut e = deck_engine(1);
    e.connect("deck1", "audio_l", "out1", "l").unwrap();
    load_and_play(&mut e, &fx);

    let full = stem_amps(&render(&mut e)[0]);
    for (k, &amp) in full.iter().enumerate() {
        assert!(amp > 1.0, "stem {k} inaudible at full gain: {amp}");
    }

    for muted in 0..4 {
        for (k, param) in STEM_PARAMS.iter().enumerate() {
            e.set_param("deck1", param, if k == muted { 0.0 } else { 1.0 })
                .unwrap();
        }
        let amps = stem_amps(&render(&mut e)[0]);
        for k in 0..4 {
            if k == muted {
                assert!(
                    amps[k] < full[k] * 0.01,
                    "muting stem {muted}: its tone only dropped to {:.4} (full {:.4})",
                    amps[k],
                    full[k]
                );
            } else {
                assert!(
                    (amps[k] - full[k]).abs() < full[k] * 0.02,
                    "muting stem {muted} changed stem {k}: {:.4} vs {:.4}",
                    amps[k],
                    full[k]
                );
            }
        }
    }
}

#[test]
fn stem_jacks_are_independently_routable() {
    let fx = fixture();
    let mut e = deck_engine(4);
    // Audio Output is stereo (l/r + channel_offset), so route the four
    // stems through two audio_out modules at offsets 0 and 2.
    e.add_module("out2", "builtin.audio_out").unwrap();
    e.set_knob_value("out2", "channel_offset", 2.0).unwrap();
    for (k, jack) in STEM_JACKS.iter().enumerate() {
        let (out, ch) = (["out1", "out2"][k / 2], ["l", "r"][k % 2]);
        e.connect("deck1", jack, out, ch).unwrap();
    }
    load_and_play(&mut e, &fx);
    // Give drums a distinct gain so the jack is provably post-gain.
    e.set_param("deck1", "stem_drums", 0.5).unwrap();

    let rendered = render(&mut e);
    for ch in 0..4 {
        let amps = stem_amps(&rendered[ch]);
        for k in 0..4 {
            if k == ch {
                let expect = if k == 1 { 0.5 } else { 1.0 };
                // The jack carries the mono mix of a mono source at the
                // stem's own gain.
                assert!(
                    amps[k] > 1.0 * expect,
                    "ch{ch} missing its stem tone: {amps:?}"
                );
                if k == 1 {
                    // ~half of the vocals-jack level (same source amp).
                    let voc = stem_amps(&rendered[0])[0];
                    assert!(
                        (amps[k] / voc - 0.5).abs() < 0.02,
                        "drums jack not post-gain: {} vs vocals {}",
                        amps[k],
                        voc
                    );
                }
            } else {
                assert!(
                    amps[k] < 0.02,
                    "stem tone {k} leaked into jack channel {ch}: {amps:?}"
                );
            }
        }
    }
}

#[test]
fn stem_gains_scale_continuously_and_round_trip_through_patch() {
    let fx = fixture();
    let mut e = deck_engine(1);
    e.connect("deck1", "audio_l", "out1", "l").unwrap();
    load_and_play(&mut e, &fx);

    let gains = [0.25f32, 0.5, 0.75, 1.0];
    for (param, &g) in STEM_PARAMS.iter().zip(&gains) {
        e.set_param("deck1", param, g).unwrap();
    }
    let full = {
        // Reference render at unity gains from a fresh engine.
        let mut e0 = deck_engine(1);
        e0.connect("deck1", "audio_l", "out1", "l").unwrap();
        load_and_play(&mut e0, &fx);
        stem_amps(&render(&mut e0)[0])
    };
    let amps = stem_amps(&render(&mut e)[0]);
    for k in 0..4 {
        let got = amps[k] / full[k];
        assert!(
            (got - gains[k] as f64).abs() < 0.02,
            "stem {k}: gain {} rendered as {got:.4}",
            gains[k]
        );
    }

    // Save / load: stem gains are ordinary params and must round-trip.
    let dir = tempfile::tempdir().unwrap();
    e.save_patch(dir.path(), "stems-test").unwrap();
    let mut re = Engine::load_patch(dir.path(), common::registry()).unwrap();
    let node = re
        .nodes
        .iter()
        .position(|n| n.instance_id == "deck1")
        .unwrap();
    for (param, &g) in STEM_PARAMS.iter().zip(&gains) {
        assert_eq!(
            re.nodes[node].params.get(*param).copied(),
            Some(g),
            "param {param} did not round-trip"
        );
    }
    // Stems themselves are app-layer state (re-applied from the library on
    // patch load, like grids/cues); the reloaded engine renders the gains
    // once stems are loaded again.
    re.deck_load_stems("deck1", &fx.stems.clone()).unwrap();
    re.set_knob_position("deck1", "play_gate", 1.0).unwrap();
    let amps = stem_amps(&render(&mut re)[0]);
    for k in 0..4 {
        let got = amps[k] / full[k];
        assert!(
            (got - gains[k] as f64).abs() < 0.02,
            "after reload, stem {k}: gain {} rendered as {got:.4}",
            gains[k]
        );
    }
}

#[test]
fn clearing_stems_reverts_to_the_original_mix() {
    let fx = fixture();
    let mut e = deck_engine(1);
    e.connect("deck1", "audio_l", "out1", "l").unwrap();
    load_and_play(&mut e, &fx);
    e.set_param("deck1", "stem_bass", 0.0).unwrap();
    assert!(e.deck_status("deck1").unwrap().stems_loaded);

    let amps = stem_amps(&render(&mut e)[0]);
    assert!(amps[2] < 0.02, "bass audible while muted: {amps:?}");

    // Clear stems: the deck plays the original mix again — the bass tone
    // is back even though its stem gain is still 0.
    e.deck_clear_stems("deck1").unwrap();
    assert!(!e.deck_status("deck1").unwrap().stems_loaded);
    let amps = stem_amps(&render(&mut e)[0]);
    assert!(amps[2] > 1.0, "bass still missing after clear: {amps:?}");
}

#[test]
fn stems_track_keylock_and_loops_like_the_mix() {
    // With stems loaded at unity gains, the keylock (WSOLA) + loop path
    // must sound like the original-mix path: same grains, read from the
    // stems. Compare against a stem-free baseline rather than absolute
    // amplitudes (WSOLA inherently smears tones, identically in both).
    let fx = fixture();
    let setup = |e: &mut Engine| {
        e.connect("deck1", "audio_l", "out1", "l").unwrap();
        e.deck_load("deck1", &fx.mix).unwrap();
        e.set_knob_position("deck1", "play_gate", 1.0).unwrap();
        e.set_param("deck1", "keylock", 1.0).unwrap();
        e.set_knob_position("deck1", "speed", 1.0).unwrap(); // +range
        e.deck_set_loop("deck1", 0.2, 1.2).unwrap();
        e.deck_loop_enable("deck1", true).unwrap();
    };

    let mut base = deck_engine(1);
    setup(&mut base);
    let baseline = stem_amps(&render(&mut base)[0]);

    let mut e = deck_engine(1);
    setup(&mut e);
    e.deck_load_stems("deck1", &fx.stems.clone()).unwrap();
    let amps = stem_amps(&render(&mut e)[0]);
    for k in 0..4 {
        assert!(
            (amps[k] - baseline[k]).abs() < baseline[k].max(0.05) * 0.1 + 1e-3,
            "keylock stems path diverges from mix path at stem {k}: {amps:?} vs {baseline:?}"
        );
    }

    // Muting still works inside the keylock/loop path.
    e.set_param("deck1", "stem_other", 0.0).unwrap();
    let amps = stem_amps(&render(&mut e)[0]);
    assert!(
        amps[3] < baseline[3] * 0.01 + 1e-4,
        "muted stem audible under keylock: {amps:?}"
    );
    for k in 0..3 {
        assert!(
            (amps[k] - baseline[k]).abs() < baseline[k].max(0.05) * 0.1 + 1e-3,
            "muting 'other' disturbed stem {k} under keylock: {amps:?} vs {baseline:?}"
        );
    }
}
