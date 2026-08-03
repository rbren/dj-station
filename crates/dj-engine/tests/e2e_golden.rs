//! E2E audio regression tests (PRD §10.1).
//!
//! Each case under `tests/e2e/patches/<case>/` is a serialized patch
//! (directory-tree format, §12.3) plus an `events.json` sidecar describing
//! render length and virtual MIDI injection. The harness loads the patch,
//! renders it offline to a WAV, and compares against the committed golden
//! in `tests/e2e/goldens/<case>.wav`.
//!
//! The render pipeline is deterministic on a given platform, so comparison
//! is sample-exact within a tiny epsilon (1e-6) that absorbs cross-platform
//! libm differences.
//!
//! Regenerating goldens intentionally: `./scripts/regen-goldens.sh`
//! (sets REGEN_GOLDENS=1, which rebuilds the patch dirs *and* goldens).

mod common;

use dj_engine::{Engine, EngineConfig};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
struct MidiEventSpec {
    instance: String,
    frame: u64,
    data: [u8; 3],
}

#[derive(Debug, Serialize, Deserialize)]
struct TrackLoadSpec {
    instance: String,
    /// Audio file, relative to the case directory (keeps patches portable).
    file: String,
}

/// Deck DJ metadata applied after load. In the app this comes from the
/// library DB (track metadata, PRD §7); E2E cases carry it in the sidecar
/// so the committed patches stay self-contained.
#[derive(Debug, Serialize, Deserialize)]
struct DeckSetupSpec {
    instance: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grid: Option<(f64, f64)>, // (bpm, anchor_secs)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    cues: Vec<(usize, f64)>, // (slot, position_secs)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    r#loop: Option<(f64, f64, bool)>, // (start, end, enabled)
    /// Stem files (vocals/drums/bass/other), case-relative. Like grids and
    /// cues, stems come from the app layer (library stem cache) rather
    /// than the patch, so E2E cases carry them in the sidecar (M3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stems: Option<[String; 4]>,
}

#[derive(Debug, Serialize, Deserialize)]
struct EventsFile {
    seconds: f32,
    #[serde(default)]
    midi: Vec<MidiEventSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tracks: Vec<TrackLoadSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    decks: Vec<DeckSetupSpec>,
}

fn e2e_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/e2e")
}

fn regen() -> bool {
    std::env::var("REGEN_GOLDENS")
        .map(|v| v == "1")
        .unwrap_or(false)
}

fn render_case(case: &str) -> PathBuf {
    let case_dir = e2e_dir().join("patches").join(case);
    let events: EventsFile =
        serde_json::from_str(&std::fs::read_to_string(case_dir.join("events.json")).unwrap())
            .unwrap();
    let mut engine = Engine::load_patch(&case_dir.join("patch"), common::registry()).unwrap();
    for t in &events.tracks {
        let ext = engine
            .nodes
            .iter()
            .find(|n| n.instance_id == t.instance)
            .map(|n| n.ext_id.clone())
            .unwrap_or_default();
        if ext == "builtin.deck" {
            engine
                .deck_load(&t.instance, &case_dir.join(&t.file))
                .unwrap();
        } else {
            engine
                .playback_load(&t.instance, &case_dir.join(&t.file))
                .unwrap();
        }
    }
    for d in &events.decks {
        if let Some((bpm, anchor)) = d.grid {
            engine.deck_set_beatgrid(&d.instance, bpm, anchor).unwrap();
        }
        for &(slot, pos) in &d.cues {
            engine.deck_set_cue(&d.instance, slot, Some(pos)).unwrap();
        }
        if let Some((start, end, enabled)) = d.r#loop {
            engine.deck_set_loop(&d.instance, start, end).unwrap();
            engine.deck_loop_enable(&d.instance, enabled).unwrap();
        }
        if let Some(stems) = &d.stems {
            let paths: [PathBuf; 4] = std::array::from_fn(|i| case_dir.join(&stems[i]));
            engine.deck_load_stems(&d.instance, &paths).unwrap();
        }
    }
    for ev in &events.midi {
        engine.inject_midi(&ev.instance, ev.frame, ev.data).unwrap();
    }
    let frames = (events.seconds * engine.config.sample_rate) as usize;
    let out = std::env::temp_dir().join(format!("dj-e2e-{case}.wav"));
    engine.render_offline_wav(frames, &out).unwrap();
    out
}

fn read_wav(path: &Path) -> (hound::WavSpec, Vec<f32>) {
    let mut reader = hound::WavReader::open(path)
        .unwrap_or_else(|e| panic!("cannot open {}: {e}", path.display()));
    let spec = reader.spec();
    let samples: Vec<f32> = reader.samples::<f32>().map(|s| s.unwrap()).collect();
    (spec, samples)
}

fn check_case(case: &str) {
    let golden_path = e2e_dir().join("goldens").join(format!("{case}.wav"));
    let rendered_path = render_case(case);
    if regen() {
        std::fs::create_dir_all(golden_path.parent().unwrap()).unwrap();
        std::fs::copy(&rendered_path, &golden_path).unwrap();
        println!("regenerated golden {}", golden_path.display());
        return;
    }
    let (gspec, golden) = read_wav(&golden_path);
    let (rspec, rendered) = read_wav(&rendered_path);
    assert_eq!(gspec, rspec, "{case}: WAV spec changed");
    assert_eq!(golden.len(), rendered.len(), "{case}: length changed");
    let mut max_diff = 0.0f32;
    let mut max_at = 0usize;
    for (i, (&g, &r)) in golden.iter().zip(&rendered).enumerate() {
        let d = (g - r).abs();
        if d > max_diff {
            max_diff = d;
            max_at = i;
        }
    }
    assert!(
        max_diff <= 1e-6,
        "{case}: rendered audio deviates from golden (max diff {max_diff} at sample {max_at}).\n\
         If this change is intentional, run ./scripts/regen-goldens.sh and review the diff."
    );
    let _ = std::fs::remove_file(&rendered_path);
}

// ---------------------------------------------------------------------------
// Case construction (only used with REGEN_GOLDENS=1 to build the committed
// patch directories; the sidecar events.json files are written too).
// ---------------------------------------------------------------------------

fn write_events(case_dir: &Path, events: &EventsFile) {
    let mut s = serde_json::to_string_pretty(events).unwrap();
    s.push('\n');
    std::fs::write(case_dir.join("events.json"), s).unwrap();
}

fn regen_patches() {
    let patches = e2e_dir().join("patches");

    // Case 1: Osc (sine, C4) -> VCA (half gain via cv knob) -> Audio Out.
    {
        let dir = patches.join("osc-sine-vca");
        std::fs::create_dir_all(&dir).unwrap();
        let config = EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        };
        let mut e = Engine::new(config, common::registry()).unwrap();
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
                midi: vec![],
                tracks: vec![],
                decks: vec![],
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
        let mut e = Engine::new(config, common::registry()).unwrap();
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
        e.set_param("adsr1", "attack", 0.02).unwrap();
        e.set_param("adsr1", "decay", 0.1).unwrap();
        e.set_param("adsr1", "sustain", 0.6).unwrap();
        e.set_param("adsr1", "release", 0.15).unwrap();
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
                tracks: vec![],
                decks: vec![],
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
        let mut e = Engine::new(config, common::registry()).unwrap();
        e.add_module("osc1", "com.dj.oscillator").unwrap();
        e.add_module("osc2", "com.dj.oscillator").unwrap();
        e.add_module("osc3", "com.dj.oscillator").unwrap();
        e.add_module("vca1", "com.dj.vca").unwrap();
        e.add_module("out1", "builtin.audio_out").unwrap();
        e.set_param("osc1", "waveform", 3.0).unwrap(); // tri
        e.set_param("osc2", "waveform", 2.0).unwrap(); // square
        e.set_param("osc3", "waveform", 1.0).unwrap(); // saw
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
                midi: vec![],
                tracks: vec![],
                decks: vec![],
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
        let mut e = Engine::new(config, common::registry()).unwrap();
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
            },
        );
    }
}

// Deterministic 16-bit mono tone, committed next to a deck case.
fn write_case_tone(path: &Path, freq: f64, seconds: f64) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 48_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..(seconds * 48_000.0) as u64 {
        let t = i as f64 / 48_000.0;
        let x = (2.0 * std::f64::consts::PI * freq * t).sin() * 0.5;
        w.write_sample((x * i16::MAX as f64) as i16).unwrap();
    }
    w.finalize().unwrap();
}

fn regen_deck_patches() {
    let patches = e2e_dir().join("patches");

    // Case 5 (M2): one deck, keylock on at +8 %, active loop, manual
    // beatgrid. l = deck audio, r = beat_clock.
    {
        let dir = patches.join("deck-loop-keylock");
        std::fs::create_dir_all(&dir).unwrap();
        write_case_tone(&dir.join("tone.wav"), 220.0, 3.0);

        let mut e = Engine::new(EngineConfig::default(), common::registry()).unwrap();
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
        let mut e = Engine::new(config, common::registry()).unwrap();
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
            },
        );
    }
}

fn regen_stem_patches() {
    let patches = e2e_dir().join("patches");

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

        let mut e = Engine::new(EngineConfig::default(), common::registry()).unwrap();
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
            },
        );
    }
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
