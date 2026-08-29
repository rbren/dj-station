//! E2E golden-audio case for the Decks bank (PRD §10.1).
//!
//! `decks-bank-two-clips`: a two-beat clip and a three-beat clip, both cut
//! at 120 BPM, in one bank running at 150 — so the golden pins the
//! stretch, the mix (a level and a killed low band), the whole-beat shift
//! and the beat of silence hung on the end of the second slot, and the
//! phase relationship the bank's single clock gives them (two beats
//! against four: they meet every four). Both channels are the bank's own
//! stereo pair — mono clips feed both — so the case is the mix as the
//! room would hear it.
//!
//! The clips' audio and the tempo they were rendered at come from the
//! sidecar, like a Beat Clip's: the app layer assembles a bank's clips out
//! of a Beatify project.
//!
//! Regenerate with `REGEN_GOLDENS=1 cargo test -p dj-engine --release
//! --test e2e_suite decks` (or `./scripts/regen-goldens.sh`).

use crate::common::e2e::{
    case_dir, check_case, regen, write_case_tone, write_events, DecksSlotSpec, EventsFile,
    TrackLoadSpec,
};
use dj_engine::{Engine, EngineConfig};

fn regen_decks_bank_two_clips() {
    let dir = case_dir("decks-bank-two-clips");
    // One second = two beats at 120 BPM; 1.5 s = three beats.
    write_case_tone(&dir.join("two-beat.wav"), 220.0, 1.0);
    write_case_tone(&dir.join("three-beat.wav"), 330.0, 1.5);

    let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
    e.add_module("bank1", "builtin.decks").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.set_knob_value("bank1", "bpm", 150.0).unwrap();
    e.connect("bank1", "audio_l", "out1", "l").unwrap();
    e.connect("bank1", "audio_r", "out1", "r").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-decks-bank-two-clips")
        .unwrap();
    write_events(
        &dir,
        &EventsFile {
            seconds: 2.0,
            tracks: vec![
                TrackLoadSpec {
                    instance: "bank1".into(),
                    file: "two-beat.wav".into(),
                    bpm: Some(120.0),
                    slot: Some(0),
                },
                TrackLoadSpec {
                    instance: "bank1".into(),
                    file: "three-beat.wav".into(),
                    bpm: Some(120.0),
                    slot: Some(1),
                },
            ],
            deck_slots: vec![
                DecksSlotSpec {
                    instance: "bank1".into(),
                    slot: 0,
                    level: Some(0.8),
                    mute: Some(false),
                    ..slot_defaults()
                },
                DecksSlotSpec {
                    instance: "bank1".into(),
                    slot: 1,
                    level: Some(0.6),
                    // Kill the lows and lift the highs: the tone controls
                    // are in the golden, not just in the unit tests.
                    low: Some(0.0),
                    high: Some(1.5),
                    mute: Some(false),
                    // Three beats of clip plus one of silence, shifted a
                    // beat: four against the other slot's two.
                    tail: Some(1),
                    phase: Some(1),
                    ..slot_defaults()
                },
            ],
            ..EventsFile::default()
        },
    );
}

fn slot_defaults() -> DecksSlotSpec {
    DecksSlotSpec {
        instance: String::new(),
        slot: 0,
        level: None,
        low: None,
        mid: None,
        high: None,
        mute: None,
        monitor: None,
        tail: None,
        phase: None,
    }
}

#[test]
fn decks_bank_two_clips() {
    if regen() {
        regen_decks_bank_two_clips();
    }
    check_case("decks-bank-two-clips");
}
