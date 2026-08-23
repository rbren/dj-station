//! E2E golden-audio case for the Audio module (PRD §10.1).
//!
//! `audio-tone-clock-gate`: a library track playing at its own tempo, with
//! the module's beat clock chopping that audio through a VCA — left is the
//! gated track, right the raw clock, so the golden pins both the playback
//! rate and the beat timing the BPM input produces. The track's tempo
//! comes from the sidecar (library metadata, like deck beatgrids), and the
//! module adopts it on load.
//!
//! Regenerate with `REGEN_GOLDENS=1 cargo test -p dj-engine --release
//! --test e2e_suite audio` (or `./scripts/regen-goldens.sh`).

use crate::common::e2e::{
    case_dir, check_case, regen, write_case_tone, write_events, EventsFile, TrackLoadSpec,
};
use dj_engine::{Engine, EngineConfig};

fn regen_audio_clock_gate() {
    let dir = case_dir("audio-tone-clock-gate");
    write_case_tone(&dir.join("tone.wav"), 330.0, 1.2);

    let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
    e.add_module("audio1", "builtin.audio").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("audio1", "audio_l", "vca1", "in").unwrap();
    // The beat clock alone opens the VCA (knob closed), so every beat cuts
    // a 10 ms slice out of the track.
    e.connect("audio1", "clock", "vca1", "cv").unwrap();
    e.set_knob_value("vca1", "cv", 0.0).unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();
    e.connect("audio1", "clock", "out1", "r").unwrap();
    e.set_knob_position("audio1", "play", 1.0).unwrap();

    e.save_patch(&dir.join("patch"), "e2e-audio-tone-clock-gate")
        .unwrap();
    // Loading the track sets speed to 1x and BPM to the library's 150.
    write_events(
        &dir,
        &EventsFile {
            seconds: 1.0,
            tracks: vec![TrackLoadSpec {
                instance: "audio1".into(),
                file: "tone.wav".into(),
                bpm: Some(150.0),
            }],
            ..EventsFile::default()
        },
    );
}

#[test]
fn audio_tone_clock_gate() {
    if regen() {
        regen_audio_clock_gate();
    }
    check_case("audio-tone-clock-gate");
}
