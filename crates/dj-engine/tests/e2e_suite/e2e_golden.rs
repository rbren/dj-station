//! E2E audio regression tests (PRD §10.1) for the core M0–M5 cases.
//!
//! The harness lives in `tests/common/e2e.rs`; see its docs for the case
//! layout and the regeneration flow (`./scripts/regen-goldens.sh`).
//! Module-specific cases live in their own `tests/e2e_*.rs` files.

use crate::common::e2e::{
    check_case, regen, write_case_tone, write_events, DeckSetupSpec, EventsFile, GestureTraceSpec,
    MidiEventSpec, TrackLoadSpec,
};
use dj_engine::{Engine, EngineConfig};

fn regen_patches() {
    let patches = crate::common::e2e::e2e_dir().join("patches");

    // Case 1: Osc (sine, C4) -> VCA (half gain via cv knob) -> Audio Out.
    {
        let dir = patches.join("osc-sine-vca");
        std::fs::create_dir_all(&dir).unwrap();
        let config = EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        };
        let mut e = Engine::new(config, crate::common::registry()).unwrap();
        e.add_module("osc1", "com.dj.oscillator").unwrap();
        e.add_module("vca1", "com.dj.vca").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.connect("osc1", "audio", "vca1", "in").unwrap();
        e.connect("vca1", "out", "out1", "l").unwrap();
        e.set_knob_position("vca1", "cv", 0.5).unwrap(); // gain 0.5
        e.save_patch(&dir.join("patch"), "e2e-osc-sine-vca")
            .unwrap();
        write_events(
            &dir,
            &EventsFile {
                seconds: 0.5,
                ..EventsFile::default()
            },
        );
    }

    // Case 2: MIDI-driven ADSR envelope on a VCA (the M0 demo patch, mono).
    {
        let dir = patches.join("midi-adsr-envelope");
        std::fs::create_dir_all(&dir).unwrap();
        let config = EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        };
        let mut e = Engine::new(config, crate::common::registry()).unwrap();
        e.add_module("midi1", "builtin.midi").unwrap();
        e.add_module("osc1", "com.dj.oscillator").unwrap();
        e.add_module("adsr1", "com.dj.adsr").unwrap();
        e.add_module("vca1", "com.dj.vca").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.add_midi_mapping("midi1", "note", 60, "pad_1").unwrap();
        e.connect("midi1", "pad_1", "adsr1", "gate").unwrap();
        e.connect("osc1", "audio", "vca1", "in").unwrap();
        e.connect("adsr1", "env", "vca1", "cv").unwrap();
        e.connect("vca1", "out", "out1", "l").unwrap();
        e.set_knob_value("adsr1", "attack", 0.02).unwrap();
        e.set_knob_value("adsr1", "decay", 0.1).unwrap();
        e.set_knob_value("adsr1", "sustain", 0.6).unwrap();
        e.set_knob_value("adsr1", "release", 0.15).unwrap();
        // Wired inputs add to the knob baseline; zero the cv knob so the
        // envelope alone shapes the gain.
        e.set_knob_value("vca1", "cv", 0.0).unwrap();
        e.save_patch(&dir.join("patch"), "e2e-midi-adsr-envelope")
            .unwrap();
        write_events(
            &dir,
            &EventsFile {
                seconds: 0.6,
                midi: vec![
                    MidiEventSpec {
                        instance: "midi1".into(),
                        frame: 2_400, // 0.05 s
                        data: [0x90, 60, 100],
                    },
                    MidiEventSpec {
                        instance: "midi1".into(),
                        frame: 12_000, // 0.25 s
                        data: [0x80, 60, 0],
                    },
                ],
                ..EventsFile::default()
            },
        );
    }

    // Case 3: waveforms + FM + hard sync + attenuverter:
    // osc1 (tri, -2 oct) FM-modulates osc2 (square) via a 0.2 attenuverter;
    // osc3 (saw) hard-syncs from osc1; both mix into the out.
    {
        let dir = patches.join("waveforms-fm-sync");
        std::fs::create_dir_all(&dir).unwrap();
        let config = EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        };
        let mut e = Engine::new(config, crate::common::registry()).unwrap();
        e.add_module("osc1", "com.dj.oscillator").unwrap();
        e.add_module("osc2", "com.dj.oscillator").unwrap();
        e.add_module("osc3", "com.dj.oscillator").unwrap();
        e.add_module("vca1", "com.dj.vca").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.set_knob_value("osc1", "waveform", 3.0).unwrap(); // tri
        e.set_knob_value("osc2", "waveform", 2.0).unwrap(); // square
        e.set_knob_value("osc3", "waveform", 1.0).unwrap(); // saw
        e.set_knob_position("osc1", "pitch", 0.3).unwrap(); // -2 oct
        e.connect("osc1", "audio", "osc2", "fm").unwrap();
        e.set_knob_atten_offset("osc2", "fm", 0.2, 0.0).unwrap();
        e.connect("osc1", "audio", "osc3", "sync").unwrap();
        e.connect("osc2", "audio", "vca1", "in").unwrap();
        e.set_knob_position("vca1", "cv", 0.4).unwrap();
        e.connect("vca1", "out", "out1", "l").unwrap();
        e.connect("osc3", "audio", "out1", "l").unwrap();
        e.save_patch(&dir.join("patch"), "e2e-waveforms-fm-sync")
            .unwrap();
        write_events(
            &dir,
            &EventsFile {
                seconds: 0.5,
                ..EventsFile::default()
            },
        );
    }

    // Case 4 (M1): Playback (committed 440 Hz test tone, gate high,
    // speed 0) -> VCA (half gain) -> Audio Out.
    {
        let dir = patches.join("playback-tone-vca");
        std::fs::create_dir_all(&dir).unwrap();

        // Deterministic 16-bit source tone, committed next to the patch.
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(dir.join("tone.wav"), spec).unwrap();
        for i in 0..(0.4 * 48_000.0) as u32 {
            let t = i as f32 / 48_000.0;
            let x = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.5;
            writer.write_sample((x * i16::MAX as f32) as i16).unwrap();
        }
        writer.finalize().unwrap();

        let config = EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        };
        let mut e = Engine::new(config, crate::common::registry()).unwrap();
        e.add_module("play1", "builtin.playback").unwrap();
        e.add_module("vca1", "com.dj.vca").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.connect("play1", "audio_l", "vca1", "in").unwrap();
        e.connect("vca1", "out", "out1", "l").unwrap();
        e.set_knob_position("play1", "play_gate", 1.0).unwrap(); // gate 10
        e.set_knob_position("play1", "speed", 0.5).unwrap(); // exactly 0
        e.set_knob_position("vca1", "cv", 0.5).unwrap(); // gain 0.5
                                                         // The track itself is loaded via events.json (case-relative path),
                                                         // so the committed patch stays machine-independent.
        e.save_patch(&dir.join("patch"), "e2e-playback-tone-vca")
            .unwrap();
        write_events(
            &dir,
            &EventsFile {
                seconds: 0.5,
                midi: vec![],
                tracks: vec![TrackLoadSpec {
                    instance: "play1".into(),
                    file: "tone.wav".into(),
                }],
                decks: vec![],
                gestures: vec![],
            },
        );
    }
}

fn regen_deck_patches() {
    let patches = crate::common::e2e::e2e_dir().join("patches");

    // Case 5 (M2): one deck, keylock on at +8 %, active loop, manual
    // beatgrid. l = deck audio, r = beat_clock.
    {
        let dir = patches.join("deck-loop-keylock");
        std::fs::create_dir_all(&dir).unwrap();
        write_case_tone(&dir.join("tone.wav"), 220.0, 3.0);

        let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
        e.add_module("deck1", "builtin.deck").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.connect("deck1", "audio_l", "out1", "l").unwrap();
        e.connect("deck1", "beat_clock", "out1", "r").unwrap();
        e.set_knob_position("deck1", "play_gate", 1.0).unwrap();
        e.set_knob_position("deck1", "speed", 1.0).unwrap(); // +8 %
        e.set_param("deck1", "keylock", 1.0).unwrap();
        e.save_patch(&dir.join("patch"), "e2e-deck-loop-keylock")
            .unwrap();
        write_events(
            &dir,
            &EventsFile {
                seconds: 2.5,
                midi: vec![],
                tracks: vec![TrackLoadSpec {
                    instance: "deck1".into(),
                    file: "tone.wav".into(),
                }],
                decks: vec![DeckSetupSpec {
                    instance: "deck1".into(),
                    grid: Some((125.0, 0.05)),
                    cues: vec![],
                    r#loop: Some((0.5, 1.5, true)),
                    stems: None,
                }],
                gestures: vec![],
            },
        );
    }

    // Case 6 (M2): two decks with different grids, deck B beat-synced to
    // deck A, mixed by the crossfader leaning toward A (xfade = -5).
    {
        let dir = patches.join("deck-crossfader-sync");
        std::fs::create_dir_all(&dir).unwrap();
        write_case_tone(&dir.join("tone-a.wav"), 440.0, 3.0);
        write_case_tone(&dir.join("tone-b.wav"), 660.0, 3.0);

        let config = EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        };
        let mut e = Engine::new(config, crate::common::registry()).unwrap();
        e.add_module("deckA", "builtin.deck").unwrap();
        e.add_module("deckB", "builtin.deck").unwrap();
        e.add_module("xf1", "builtin.crossfader").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.connect("deckA", "audio_l", "xf1", "a_l").unwrap();
        e.connect("deckB", "audio_l", "xf1", "b_l").unwrap();
        e.connect("xf1", "out_l", "out1", "l").unwrap();
        e.set_knob_position("deckA", "play_gate", 1.0).unwrap();
        e.set_knob_position("deckB", "play_gate", 1.0).unwrap();
        e.set_knob_position("xf1", "xfade", 0.25).unwrap(); // -5 = toward A
        e.deck_sync("deckB", Some("deckA")).unwrap(); // persisted in patch
        e.save_patch(&dir.join("patch"), "e2e-deck-crossfader-sync")
            .unwrap();
        write_events(
            &dir,
            &EventsFile {
                seconds: 2.0,
                midi: vec![],
                tracks: vec![
                    TrackLoadSpec {
                        instance: "deckA".into(),
                        file: "tone-a.wav".into(),
                    },
                    TrackLoadSpec {
                        instance: "deckB".into(),
                        file: "tone-b.wav".into(),
                    },
                ],
                decks: vec![
                    DeckSetupSpec {
                        instance: "deckA".into(),
                        grid: Some((128.0, 0.1)),
                        cues: vec![],
                        r#loop: None,
                        stems: None,
                    },
                    DeckSetupSpec {
                        instance: "deckB".into(),
                        grid: Some((120.0, 0.3)),
                        cues: vec![],
                        r#loop: None,
                        stems: None,
                    },
                ],
                gestures: vec![],
            },
        );
    }
}

fn regen_stem_patches() {
    let patches = crate::common::e2e::e2e_dir().join("patches");

    // Case 7 (M3): deck with stems loaded — bass muted, drums at half
    // gain — plus the drums stem jack routed out separately.
    // l = deck mix (gain-weighted stem sum), r = stem_drums jack.
    {
        let dir = patches.join("deck-stems-gains");
        std::fs::create_dir_all(&dir).unwrap();
        // One tone per stem; the "mix" is their sum.
        let freqs = [1000.0, 2500.0, 60.0, 3500.0];
        let names = ["vocals", "drums", "bass", "other"];
        for (f, n) in freqs.iter().zip(names) {
            write_case_tone(&dir.join(format!("stem-{n}.wav")), *f, 2.0);
        }
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(dir.join("mix.wav"), spec).unwrap();
        for i in 0..(2.0 * 48_000.0) as u64 {
            let t = i as f64 / 48_000.0;
            let x: f64 = freqs
                .iter()
                .map(|f| (2.0 * std::f64::consts::PI * f * t).sin() * 0.125)
                .sum();
            w.write_sample((x * i16::MAX as f64) as i16).unwrap();
        }
        w.finalize().unwrap();

        let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
        e.add_module("deck1", "builtin.deck").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.connect("deck1", "audio_l", "out1", "l").unwrap();
        e.connect("deck1", "stem_drums", "out1", "r").unwrap();
        e.set_knob_position("deck1", "play_gate", 1.0).unwrap();
        e.set_param("deck1", "stem_drums", 0.5).unwrap();
        e.set_param("deck1", "stem_bass", 0.0).unwrap();
        e.save_patch(&dir.join("patch"), "e2e-deck-stems-gains")
            .unwrap();
        write_events(
            &dir,
            &EventsFile {
                seconds: 1.0,
                midi: vec![],
                tracks: vec![TrackLoadSpec {
                    instance: "deck1".into(),
                    file: "mix.wav".into(),
                }],
                decks: vec![DeckSetupSpec {
                    instance: "deck1".into(),
                    grid: None,
                    cues: vec![],
                    r#loop: None,
                    stems: Some([
                        "stem-vocals.wav".into(),
                        "stem-drums.wav".into(),
                        "stem-bass.wav".into(),
                        "stem-other.wav".into(),
                    ]),
                }],
                gestures: vec![],
            },
        );
    }
}

/// M4 case: a patch containing a macro instance renders byte-identically.
/// Built by collapsing osc+vca into `macro.tone` (promoting pitch/level/out)
/// and instantiating it twice at different levels, plus an FM wire into a
/// promoted input across the macro boundary.
fn regen_macro_patches() {
    let patches = crate::common::e2e::e2e_dir().join("patches");
    let dir = patches.join("macro-tone-collapse");
    std::fs::create_dir_all(&dir).unwrap();
    let config = EngineConfig {
        master_channels: 1,
        ..EngineConfig::default()
    };
    let mut e = Engine::new(config, crate::common::registry()).unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "vca1", "in").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();
    e.set_knob_position("vca1", "cv", 0.5).unwrap();
    e.collapse_to_macro(
        &["osc1", "vca1"],
        "tone1",
        "macro.tone",
        "Tone",
        dj_engine::MacroInterface {
            inputs: vec![
                dj_engine::MacroJack {
                    id: "pitch".into(),
                    node: "osc1".into(),
                    jack: "pitch".into(),
                },
                dj_engine::MacroJack {
                    id: "level".into(),
                    node: "vca1".into(),
                    jack: "cv".into(),
                },
            ],
            outputs: vec![dj_engine::MacroJack {
                id: "out".into(),
                node: "vca1".into(),
                jack: "out".into(),
            }],
            params: vec![],
        },
    )
    .unwrap();
    // Second instance from the library, detuned and quieter, with an
    // external LFO modulating its level through the promoted input.
    e.add_module("tone2", "macro.tone").unwrap();
    e.connect("tone2", "out", "out1", "l").unwrap();
    e.set_knob_position("tone2", "pitch", 0.55).unwrap();
    e.set_knob_position("tone2", "level", 0.3).unwrap();
    e.add_module("lfo1", "com.dj.oscillator").unwrap();
    e.set_knob_position("lfo1", "pitch", 0.1).unwrap();
    e.connect("lfo1", "audio", "tone2", "level").unwrap();
    // The level knob (position 0.3 -> 3.0) is the baseline now that wired
    // inputs blend with the knob; the LFO adds ±0.2 of its swing on top.
    e.set_knob_atten_offset("tone2", "level", 0.2, 0.0).unwrap();
    e.save_patch(&dir.join("patch"), "e2e-macro-tone-collapse")
        .unwrap();
    write_events(
        &dir,
        &EventsFile {
            seconds: 0.5,
            ..EventsFile::default()
        },
    );
}

#[test]
fn e2e_macro_tone_collapse() {
    if regen() {
        regen_macro_patches();
    }
    check_case("macro-tone-collapse");
}

#[test]
fn e2e_deck_stems_gains() {
    if regen() {
        regen_stem_patches();
    }
    check_case("deck-stems-gains");
}

#[test]
fn e2e_osc_sine_vca() {
    if regen() {
        regen_patches();
    }
    check_case("osc-sine-vca");
}

#[test]
fn e2e_midi_adsr_envelope() {
    if regen() {
        regen_patches();
    }
    check_case("midi-adsr-envelope");
}

#[test]
fn e2e_waveforms_fm_sync() {
    if regen() {
        regen_patches();
    }
    check_case("waveforms-fm-sync");
}

#[test]
fn e2e_playback_tone_vca() {
    if regen() {
        regen_patches();
    }
    check_case("playback-tone-vca");
}

#[test]
fn e2e_deck_loop_keylock() {
    if regen() {
        regen_deck_patches();
    }
    check_case("deck-loop-keylock");
}

#[test]
fn e2e_deck_crossfader_sync() {
    if regen() {
        regen_deck_patches();
    }
    check_case("deck-crossfader-sync");
}

fn regen_gesture_patches() {
    let patches = crate::common::e2e::e2e_dir().join("patches");

    // Case 9 (M5): Gesture(distance: L thumb<->index) -> VCA(cv) with
    // Osc -> VCA -> Audio Out (stereo l/r), driven by the recorded pinch
    // fixture: rendered amplitude tracks the pinch open/close.
    {
        let dir = patches.join("gesture-pinch-vca");
        std::fs::create_dir_all(&dir).unwrap();
        let trace = dj_engine::dj_gesture::fixtures::pinch_trace(30.0, 45, 0.04, 0.3);
        trace.save(&dir.join("pinch.json")).unwrap();

        let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
        e.add_module("gest1", "builtin.gesture").unwrap();
        e.add_module("osc1", "com.dj.oscillator").unwrap();
        e.add_module("vca1", "com.dj.vca").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.add_gesture_mapping(
            "gest1",
            "pinch",
            "landmark",
            serde_json::json!({
                "type": "distance",
                "a": "L.thumb.tip", "b": "L.index.tip",
                "min": 0.04, "max": 0.3,
            }),
        )
        .unwrap();
        e.connect("osc1", "audio", "vca1", "in").unwrap();
        e.connect("gest1", "pinch", "vca1", "cv").unwrap();
        e.connect("vca1", "out", "out1", "l").unwrap();
        e.connect("vca1", "out", "out1", "r").unwrap();
        // Wired inputs add to the knob baseline; zero the cv knob so the
        // pinch alone drives the amplitude.
        e.set_knob_value("vca1", "cv", 0.0).unwrap();
        e.save_patch(&dir.join("patch"), "e2e-gesture-pinch-vca")
            .unwrap();
        write_events(
            &dir,
            &EventsFile {
                seconds: 1.5,
                gestures: vec![GestureTraceSpec {
                    instance: "gest1".into(),
                    trace: "pinch.json".into(),
                }],
                ..EventsFile::default()
            },
        );
    }
}

#[test]
fn e2e_gesture_pinch_vca() {
    if regen() {
        regen_gesture_patches();
    }
    check_case("gesture-pinch-vca");
}
