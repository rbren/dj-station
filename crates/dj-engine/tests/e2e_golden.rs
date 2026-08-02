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

#[derive(Debug, Serialize, Deserialize)]
struct EventsFile {
    seconds: f32,
    #[serde(default)]
    midi: Vec<MidiEventSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tracks: Vec<TrackLoadSpec>,
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
        engine
            .playback_load(&t.instance, &case_dir.join(&t.file))
            .unwrap();
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
        e.connect("vca1", "out", "out1", "ch1").unwrap();
        e.set_knob_position("vca1", "cv", 0.5).unwrap(); // gain 0.5
        e.save_patch(&dir.join("patch"), "e2e-osc-sine-vca")
            .unwrap();
        write_events(
            &dir,
            &EventsFile {
                seconds: 0.5,
                midi: vec![],
                tracks: vec![],
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
        e.connect("vca1", "out", "out1", "ch1").unwrap();
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
        e.connect("vca1", "out", "out1", "ch1").unwrap();
        e.connect("osc3", "audio", "out1", "ch1").unwrap();
        e.save_patch(&dir.join("patch"), "e2e-waveforms-fm-sync")
            .unwrap();
        write_events(
            &dir,
            &EventsFile {
                seconds: 0.5,
                midi: vec![],
                tracks: vec![],
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
        e.connect("vca1", "out", "out1", "ch1").unwrap();
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
            },
        );
    }
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
