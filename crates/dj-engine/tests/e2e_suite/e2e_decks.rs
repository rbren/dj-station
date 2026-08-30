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
//! sidecar, like a Beat Clip's: the app layer loads a bank's clips out of
//! the clip store.
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
                    // A fresh load lands cued; the golden is the live mix.
                    monitor: Some(false),
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
                    monitor: Some(false),
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
        wet: None,
        insert_monitor: None,
        ratio: None,
        tail: None,
        phase: None,
        arm: None,
    }
}

/// `decks-ratio-double`: two decks playing the SAME two-beat clip on one
/// 120 BPM bank, one of them in DOUBLE TIME. The ratio moves a deck's
/// baseline tempo — its grid is read at half the clip's, so the bank
/// drives it twice as fast — and the golden pins both halves of that at
/// once: deck two gets through the clip in one of the bank's beats and
/// then rests (a beat of silence hung on its end, so the loop is two
/// beats either way), while deck one plays the same audio across two. So
/// the render is the two decks together for the first beat, deck one
/// alone for the second, and the whole thing comes round on the bank's
/// grid — which is what "twice as often as the other decks" means.
fn regen_decks_ratio_double() {
    let dir = case_dir("decks-ratio-double");
    // One second = two beats at 120 BPM.
    write_case_tone(&dir.join("two-beat.wav"), 220.0, 1.0);

    let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
    e.add_module("bank1", "builtin.decks").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.set_knob_value("bank1", "bpm", 120.0).unwrap();
    e.connect("bank1", "audio_l", "out1", "l").unwrap();
    e.connect("bank1", "audio_r", "out1", "r").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-decks-ratio-double")
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
                    file: "two-beat.wav".into(),
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
                    // A fresh load lands cued; the golden is the live mix.
                    monitor: Some(false),
                    ..slot_defaults()
                },
                DecksSlotSpec {
                    instance: "bank1".into(),
                    slot: 1,
                    level: Some(0.8),
                    mute: Some(false),
                    monitor: Some(false),
                    // Double time: the clip in one beat, then one of rest,
                    // so both decks still come round together.
                    ratio: Some(2.0),
                    tail: Some(1),
                    ..slot_defaults()
                },
            ],
            ..EventsFile::default()
        },
    );
}

/// `decks-arm-queue`: a two-beat clip with a QUEUE armed before the
/// render. A queue is a mute the bank's clock holds until the clip's own
/// FIRST beat comes round — the loop seam, not just any beat — so the
/// golden is one silent pass of the loop and then the clip from its top:
/// beats one and two are empty, three and four sound.
fn regen_decks_arm_queue() {
    let dir = case_dir("decks-arm-queue");
    write_case_tone(&dir.join("two-beat.wav"), 220.0, 1.0);

    let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
    e.add_module("bank1", "builtin.decks").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.set_knob_value("bank1", "bpm", 120.0).unwrap();
    e.connect("bank1", "audio_l", "out1", "l").unwrap();
    e.connect("bank1", "audio_r", "out1", "r").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-decks-arm-queue")
        .unwrap();
    write_events(
        &dir,
        &EventsFile {
            seconds: 2.0,
            tracks: vec![TrackLoadSpec {
                instance: "bank1".into(),
                file: "two-beat.wav".into(),
                bpm: Some(120.0),
                slot: Some(0),
            }],
            deck_slots: vec![DecksSlotSpec {
                instance: "bank1".into(),
                slot: 0,
                level: Some(0.8),
                // Off the cue (a fresh load lands on the monitor pair):
                // the queue is heard landing in the live mix.
                monitor: Some(false),
                arm: Some(dj_engine::decks::DeckArm::Queue),
                ..slot_defaults()
            }],
            ..EventsFile::default()
        },
    );
}

/// `decks-arm-drop`: a playing two-beat clip with a DROP armed before the
/// render. The drop is a mute the bank's clock holds until the clip has
/// played its last beat, so the golden is one full pass of the clip and
/// then silence on the seam — beats three and four are empty. That pins
/// the quantized-arm timing in audio bytes: the deck is never cut
/// mid-clip, and it does not come round again.
fn regen_decks_arm_drop() {
    let dir = case_dir("decks-arm-drop");
    write_case_tone(&dir.join("two-beat.wav"), 220.0, 1.0);

    let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
    e.add_module("bank1", "builtin.decks").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.set_knob_value("bank1", "bpm", 120.0).unwrap();
    e.connect("bank1", "audio_l", "out1", "l").unwrap();
    e.connect("bank1", "audio_r", "out1", "r").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-decks-arm-drop")
        .unwrap();
    write_events(
        &dir,
        &EventsFile {
            seconds: 2.0,
            tracks: vec![TrackLoadSpec {
                instance: "bank1".into(),
                file: "two-beat.wav".into(),
                bpm: Some(120.0),
                slot: Some(0),
            }],
            deck_slots: vec![DecksSlotSpec {
                instance: "bank1".into(),
                slot: 0,
                level: Some(0.8),
                mute: Some(false),
                // A fresh load lands cued; the golden is the live mix.
                monitor: Some(false),
                arm: Some(dj_engine::decks::DeckArm::Drop),
                ..slot_defaults()
            }],
            ..EventsFile::default()
        },
    );
}

/// `decks-rack-insert`: one deck routed OUT of the bank and back again.
/// A deck's loop is MONO — one cable each way — so its send feeds a
/// single VCA, that VCA's output comes back into the deck's return, and
/// the deck's LOW tone control — patched, so it no longer cuts the bass
/// — is what opens it. So the golden pins three things at once: that a
/// wired return at full wetness replaces the deck's own path with what
/// the rack hands back (on both sides, from the one cable), that the CV a
/// tone control puts out is the knob's position on the 0..10 V scale, and
/// that the band it used to cut stays flat while it is patched.
fn regen_decks_rack_insert() {
    let dir = case_dir("decks-rack-insert");
    write_case_tone(&dir.join("two-beat.wav"), 220.0, 1.0);

    let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
    e.add_module("bank1", "builtin.decks").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.set_knob_value("bank1", "bpm", 120.0).unwrap();
    // One cable out and one back: a deck's insert is mono.
    e.connect("bank1", "d1_out", "vca1", "in").unwrap();
    e.connect("bank1", "d1_low", "vca1", "cv").unwrap();
    e.connect("vca1", "out", "bank1", "d1_in").unwrap();
    e.connect("bank1", "audio_l", "out1", "l").unwrap();
    e.connect("bank1", "audio_r", "out1", "r").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-decks-rack-insert")
        .unwrap();
    write_events(
        &dir,
        &EventsFile {
            seconds: 1.0,
            tracks: vec![TrackLoadSpec {
                instance: "bank1".into(),
                file: "two-beat.wav".into(),
                bpm: Some(120.0),
                slot: Some(0),
            }],
            deck_slots: vec![DecksSlotSpec {
                instance: "bank1".into(),
                slot: 0,
                level: Some(0.9),
                // A low that would gut the clip if it were still cutting
                // the band; patched, it is 2 V of gain for the VCA.
                low: Some(0.4),
                mute: Some(false),
                // A fresh load lands cued; the golden is the live mix.
                monitor: Some(false),
                ..slot_defaults()
            }],
            ..EventsFile::default()
        },
    );
}

/// `decks-insert-wet`: the same mono loop with the deck's WETNESS knob
/// halfway and the insert CUED. The rack side is a waveshaper folding the
/// clip, so half of what the room hears is the deck's own audio and half
/// is the fold — a golden a bypass switch could not produce. Cueing the
/// insert sends what came back to the monitor pair, which is not what is
/// recorded here: the case pins that the room's side is untouched by it.
fn regen_decks_insert_wet() {
    let dir = case_dir("decks-insert-wet");
    write_case_tone(&dir.join("two-beat.wav"), 220.0, 1.0);

    let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
    e.add_module("bank1", "builtin.decks").unwrap();
    e.add_module("ws1", "com.dj.waveshaper").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.set_knob_value("bank1", "bpm", 120.0).unwrap();
    e.connect("bank1", "d1_out", "ws1", "in").unwrap();
    e.set_knob_position("ws1", "mode", 0.0).unwrap(); // fold
    e.set_knob_value("ws1", "drive", 4.0).unwrap();
    e.connect("ws1", "out", "bank1", "d1_in").unwrap();
    e.connect("bank1", "audio_l", "out1", "l").unwrap();
    e.connect("bank1", "audio_r", "out1", "r").unwrap();

    e.save_patch(&dir.join("patch"), "e2e-decks-insert-wet")
        .unwrap();
    write_events(
        &dir,
        &EventsFile {
            seconds: 1.0,
            tracks: vec![TrackLoadSpec {
                instance: "bank1".into(),
                file: "two-beat.wav".into(),
                bpm: Some(120.0),
                slot: Some(0),
            }],
            deck_slots: vec![DecksSlotSpec {
                instance: "bank1".into(),
                slot: 0,
                mute: Some(false),
                // A fresh load lands cued; the golden is the live mix.
                monitor: Some(false),
                wet: Some(0.5),
                insert_monitor: Some(true),
                ..slot_defaults()
            }],
            ..EventsFile::default()
        },
    );
}

/// `decks-master-mix`: two decks, one in the room and one cued into the
/// headphones, under the bank's two MASTER faders — the live one pulled
/// down to 0.6, the cue one left open. The golden is the master bus, so
/// it pins two things: everything on the live pair comes out at the live
/// master's level, and the cued deck is not in the room at all whatever
/// the cue master says. Both faders are saved IN THE PATCH (they are bank
/// state, like the slot mix), so the case also pins their round trip: the
/// render is played from the file, not from the builder.
fn regen_decks_master_mix() {
    let dir = case_dir("decks-master-mix");
    write_case_tone(&dir.join("two-beat.wav"), 220.0, 1.0);
    write_case_tone(&dir.join("cue-beat.wav"), 330.0, 1.0);

    let mut e = Engine::new(EngineConfig::default(), crate::common::registry()).unwrap();
    e.add_module("bank1", "builtin.decks").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.set_knob_value("bank1", "bpm", 120.0).unwrap();
    e.connect("bank1", "audio_l", "out1", "l").unwrap();
    e.connect("bank1", "audio_r", "out1", "r").unwrap();
    e.decks_set_master("bank1", dj_engine::decks::MasterBus::Live, 0.6)
        .unwrap();
    e.decks_set_master("bank1", dj_engine::decks::MasterBus::Monitor, 1.0)
        .unwrap();

    e.save_patch(&dir.join("patch"), "e2e-decks-master-mix")
        .unwrap();
    write_events(
        &dir,
        &EventsFile {
            seconds: 1.0,
            tracks: vec![
                TrackLoadSpec {
                    instance: "bank1".into(),
                    file: "two-beat.wav".into(),
                    bpm: Some(120.0),
                    slot: Some(0),
                },
                TrackLoadSpec {
                    instance: "bank1".into(),
                    file: "cue-beat.wav".into(),
                    bpm: Some(120.0),
                    slot: Some(1),
                },
            ],
            deck_slots: vec![
                DecksSlotSpec {
                    instance: "bank1".into(),
                    slot: 0,
                    level: Some(1.0),
                    mute: Some(false),
                    // A fresh load lands cued; this is the deck in the room.
                    monitor: Some(false),
                    ..slot_defaults()
                },
                DecksSlotSpec {
                    instance: "bank1".into(),
                    slot: 1,
                    level: Some(1.0),
                    mute: Some(false),
                    monitor: Some(true),
                    ..slot_defaults()
                },
            ],
            ..EventsFile::default()
        },
    );
}

#[test]
fn decks_master_mix() {
    if regen() {
        regen_decks_master_mix();
    }
    check_case("decks-master-mix");
}

#[test]
fn decks_bank_two_clips() {
    if regen() {
        regen_decks_bank_two_clips();
    }
    check_case("decks-bank-two-clips");
}

#[test]
fn decks_ratio_double() {
    if regen() {
        regen_decks_ratio_double();
    }
    check_case("decks-ratio-double");
}

#[test]
fn decks_rack_insert() {
    if regen() {
        regen_decks_rack_insert();
    }
    check_case("decks-rack-insert");
}

#[test]
fn decks_insert_wet() {
    if regen() {
        regen_decks_insert_wet();
    }
    check_case("decks-insert-wet");
}

#[test]
fn decks_arm_queue() {
    if regen() {
        regen_decks_arm_queue();
    }
    check_case("decks-arm-queue");
}

#[test]
fn decks_arm_drop() {
    if regen() {
        regen_decks_arm_drop();
    }
    check_case("decks-arm-drop");
}
