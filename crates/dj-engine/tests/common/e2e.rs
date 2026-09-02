//! Shared E2E golden-audio harness (PRD §10.1).
//!
//! Each case under `tests/e2e/patches/<case>/` is a serialized patch
//! (directory-tree format, §12.3) plus an `events.json` sidecar describing
//! render length and virtual MIDI/track/deck setup. [`check_case`]
//! loads the patch, renders it offline to a WAV, and compares against the
//! committed golden in `tests/e2e/goldens/<case>.wav`.
//!
//! The render pipeline is deterministic on a given platform, so comparison
//! is sample-exact within a tiny epsilon (1e-6) that absorbs cross-platform
//! libm differences.
//!
//! Test files own their cases: a `#[test]` calls its own `regen_*` builder
//! when [`regen`] is true (set by `./scripts/regen-goldens.sh`), then
//! `check_case`. Keeping the harness here lets new modules add cases in
//! their own `tests/e2e_suite/e2e_*.rs` module instead of one shared file.
#![allow(dead_code)]

use dj_engine::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
pub struct MidiEventSpec {
    pub instance: String,
    pub frame: u64,
    pub data: [u8; 3],
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrackLoadSpec {
    pub instance: String,
    /// Audio file, relative to the case directory (keeps patches portable).
    pub file: String,
    /// The track's tempo as the library knows it (Audio nodes adopt it on
    /// load). Library metadata lives outside the patch, like deck grids,
    /// so cases carry it in the sidecar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bpm: Option<f64>,
    /// Which slot of a Decks bank the audio goes into.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<usize>,
}

/// One Decks slot's mix and place on the bank's grid, applied AFTER its
/// audio. Loading a clip deliberately resets a slot (cued to the monitor,
/// unmuted, un-shifted), so a case that wants to hear one on the live
/// pair says so here — the same shape as a deck's grid/cues arriving
/// after `deck_load`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DecksSlotSpec {
    pub instance: String,
    pub slot: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub low: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mid: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub high: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mute: Option<bool>,
    #[serde(default, alias = "solo", skip_serializing_if = "Option::is_none")]
    pub monitor: Option<bool>,
    /// How much of the deck's insert is heard (0 = dry).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wet: Option<f32>,
    /// Cue what came back from the insert into the monitor pair.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insert_monitor: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<i32>,
    /// Run this deck at a ratio of the bank's grid (2 = double time).
    /// It goes in the sidecar rather than the patch because a load puts a
    /// deck back on the bank's grid, and the sidecar is what loads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ratio: Option<f32>,
    /// A queue or drop armed before the render: the bank's clock decides
    /// when the mute it stands for lands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arm: Option<dj_engine::decks::DeckArm>,
}

/// Deck DJ metadata applied after load. In the app this comes from the
/// library DB (track metadata, PRD §7); E2E cases carry it in the sidecar
/// so the committed patches stay self-contained.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeckSetupSpec {
    pub instance: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid: Option<(f64, f64)>, // (bpm, anchor_secs)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cues: Vec<(usize, f64)>, // (slot, position_secs)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#loop: Option<(f64, f64, bool)>, // (start, end, enabled)
    /// Stem files (vocals/drums/bass/other), case-relative. Like grids and
    /// cues, stems come from the app layer (library stem cache) rather
    /// than the patch, so E2E cases carry them in the sidecar (M3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stems: Option<[String; 4]>,
}

/// A recorded hand-landmark fixture (JSON `HandsTrace`, case-relative)
/// fed into a Hands node before rendering. Landmark frames come from the
/// camera panel's tracker at runtime, so E2E cases carry them in the
/// sidecar like deck metadata.
#[derive(Debug, Serialize, Deserialize)]
pub struct HandsTraceSpec {
    pub instance: String,
    pub trace: String,
}

/// A key transition into a QWERTY node at an engine frame (the qwerty
/// analogue of `MidiEventSpec`).
#[derive(Debug, Serialize, Deserialize)]
pub struct QwertyEventSpec {
    pub instance: String,
    pub frame: u64,
    pub key: String,
    pub down: bool,
}

/// A raw Launch Control XL surface message into one module at an engine
/// frame. Hardware never runs in CI, so golden cases drive the module
/// through the same synthetic `launchcontrol_inject` seam the engine
/// tests use.
#[derive(Debug, Serialize, Deserialize)]
pub struct LaunchControlEventSpec {
    pub instance: String,
    pub frame: u64,
    pub data: [u8; 3],
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct EventsFile {
    pub seconds: f32,
    #[serde(default)]
    pub midi: Vec<MidiEventSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub qwerty: Vec<QwertyEventSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub launch_control: Vec<LaunchControlEventSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tracks: Vec<TrackLoadSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decks: Vec<DeckSetupSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deck_slots: Vec<DecksSlotSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hands: Vec<HandsTraceSpec>,
    /// Audio focus for the whole render ("rack" is the engine default;
    /// "decks"/"silent" gate by workspace tag) — how a golden pins the
    /// per-page gating of the workspace tags a patch carries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<String>,
}

impl EventsFile {
    /// A sidecar that only sets the render length (the common case).
    pub fn seconds(seconds: f32) -> Self {
        EventsFile {
            seconds,
            ..EventsFile::default()
        }
    }
}

pub fn e2e_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/e2e")
}

/// True when `REGEN_GOLDENS=1` (see `./scripts/regen-goldens.sh`).
pub fn regen() -> bool {
    std::env::var("REGEN_GOLDENS")
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// Create (and return) the patch directory for a case.
pub fn case_dir(case: &str) -> PathBuf {
    let dir = e2e_dir().join("patches").join(case);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub fn write_events(case_dir: &Path, events: &EventsFile) {
    let mut s = serde_json::to_string_pretty(events).unwrap();
    s.push('\n');
    std::fs::write(case_dir.join("events.json"), s).unwrap();
}

/// Deterministic 16-bit mono tone, committed next to a case's patch.
pub fn write_case_tone(path: &Path, freq: f64, seconds: f64) {
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

fn render_case(case: &str) -> PathBuf {
    let case_dir = e2e_dir().join("patches").join(case);
    let events: EventsFile =
        serde_json::from_str(&std::fs::read_to_string(case_dir.join("events.json")).unwrap())
            .unwrap();
    let mut engine = Engine::load_patch(&case_dir.join("patch"), super::registry()).unwrap();
    if let Some(focus) = &events.focus {
        let focus = match focus.as_str() {
            "rack" => dj_engine::AudioFocus::Rack,
            "decks" => dj_engine::AudioFocus::Decks,
            "silent" => dj_engine::AudioFocus::Silent,
            other => panic!("unknown focus {other:?}"),
        };
        engine.set_audio_focus(focus).unwrap();
    }
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
        } else if ext == "builtin.audio" {
            engine
                .audio_load(&t.instance, &case_dir.join(&t.file), t.bpm)
                .unwrap();
        } else if ext == "builtin.decks" {
            // A bank's clips come from the clip store the same way a Beat
            // Clip's do, so the case carries the rendered audio and the
            // tempo it was rendered at.
            engine
                .decks_load_file(
                    &t.instance,
                    t.slot.unwrap_or(0),
                    &case_dir.join(&t.file),
                    t.bpm.unwrap_or(120.0),
                )
                .unwrap();
        } else if ext == "builtin.beat_clip" {
            // A clip is loaded by the app layer out of the clip store, so
            // cases carry the rendered audio (and the tempo it was
            // rendered at) in the sidecar, like deck metadata.
            engine
                .beat_clip_load_file(&t.instance, &case_dir.join(&t.file), t.bpm.unwrap_or(120.0))
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
    for d in &events.deck_slots {
        use dj_engine::decks::SlotControl;
        let mut set = |c: SlotControl, v: f32| {
            engine.decks_set_control(&d.instance, d.slot, c, v).unwrap();
        };
        if let Some(v) = d.level {
            set(SlotControl::Level, v);
        }
        if let Some(v) = d.low {
            set(SlotControl::Low, v);
        }
        if let Some(v) = d.mid {
            set(SlotControl::Mid, v);
        }
        if let Some(v) = d.high {
            set(SlotControl::High, v);
        }
        if let Some(v) = d.mute {
            set(SlotControl::Mute, if v { 10.0 } else { 0.0 });
        }
        if let Some(v) = d.monitor {
            set(SlotControl::Monitor, if v { 10.0 } else { 0.0 });
        }
        if let Some(v) = d.wet {
            set(SlotControl::Wet, v);
        }
        if let Some(v) = d.insert_monitor {
            set(SlotControl::InsertMonitor, if v { 10.0 } else { 0.0 });
        }
        if let Some(v) = d.ratio {
            engine.decks_set_ratio(&d.instance, d.slot, v).unwrap();
        }
        if let Some(v) = d.tail {
            engine.decks_set_tail(&d.instance, d.slot, v).unwrap();
        }
        if let Some(v) = d.phase {
            engine.decks_set_phase(&d.instance, d.slot, v).unwrap();
        }
        // After the mix, so the arm's own mute write is the last word.
        if let Some(arm) = d.arm {
            engine.decks_arm(&d.instance, d.slot, arm).unwrap();
        }
    }
    // A bank is created STOPPED and the transport is not patch state (see
    // `decks_set_running`), so the harness presses play for every bank in
    // the patch — the Decks page's own Start button, and the only thing
    // that makes a rendered bank anything but silence.
    for instance in engine.decks_nodes() {
        engine.decks_set_running(&instance, true).unwrap();
    }
    for ev in &events.midi {
        engine.inject_midi(&ev.instance, ev.frame, ev.data).unwrap();
    }
    for ev in &events.qwerty {
        engine
            .qwerty_key(&ev.instance, ev.frame, &ev.key, ev.down)
            .unwrap();
    }
    for ev in &events.launch_control {
        engine
            .launchcontrol_inject(&ev.instance, ev.frame, ev.data)
            .unwrap();
    }
    for h in &events.hands {
        let trace = dj_engine::hands::HandsTrace::load(&case_dir.join(&h.trace)).unwrap();
        engine.hands_feed_trace(&h.instance, &trace, 0).unwrap();
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

/// Render `case` and compare it against its committed golden (or rewrite
/// the golden when `REGEN_GOLDENS=1`).
pub fn check_case(case: &str) {
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
