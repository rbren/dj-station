//! E2E golden-audio case for the Beat Clip module (PRD §10.1).
//!
//! `beat-clip-double-time`: a two-beat clip rendered at 120 BPM, played
//! from a clock running at 240 — so the golden pins the silence until the
//! second edge has measured that tempo, the doubled (pitch-preserving)
//! playback rate, the phase every edge re-anchors, and the wrap back to
//! beat 0 on the tick after the clip's last beat. Left is the clip, right
//! the clock that drives it. The clip's audio and the tempo it was
//! rendered at come from the sidecar (the app layer loads clips out of the
//! clip store, like deck metadata coming from the library).
//!
//! Regenerate with `REGEN_GOLDENS=1 cargo test -p dj-engine --release
//! --test e2e_suite beat_clip` (or `./scripts/regen-goldens.sh`).

use crate::common::add_clock;
use crate::common::e2e::{
    case_dir, check_case, regen, write_case_tone, write_events, EventsFile, TrackLoadSpec,
};
use dj_engine::{Engine, EngineConfig};

fn regen_beat_clip_double_time() {
    let dir = case_dir("beat-clip-double-time");
    // One second of tone = two beats at the clip's 120 BPM.
    write_case_tone(&dir.join("clip.wav"), 330.0, 1.0);

    let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
    add_clock(&mut e, "clk", 4.0); // 240 BPM: double the clip's tempo
    e.add_module("bc1", "builtin.beat_clip").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("clk", "out", "bc1", "clock").unwrap();
    e.connect("bc1", "audio_l", "out1", "l").unwrap();
    e.connect("clk", "out", "out1", "r").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-beat-clip-double-time")
        .unwrap();
    write_events(
        &dir,
        &EventsFile {
            seconds: 1.0,
            tracks: vec![TrackLoadSpec {
                instance: "bc1".into(),
                file: "clip.wav".into(),
                bpm: Some(120.0),
                slot: None,
            }],
            ..EventsFile::default()
        },
    );
}

#[test]
fn beat_clip_double_time() {
    if regen() {
        regen_beat_clip_double_time();
    }
    check_case("beat-clip-double-time");
}
