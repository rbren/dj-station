//! Audio focus (`Engine::set_audio_focus`): ONE PAGE SOUNDS AT A TIME.
//!
//! The Rack is the whole patch; the Decks page is the bank and whatever
//! the bank is played through; every other page makes its own sound, so
//! the engine makes none. Nothing about the graph changes for this — the
//! bank's clock and the rack's oscillators keep running, and the signal
//! is held at the last step, where a wire enters an Audio or Monitor
//! Output module.

use dj_engine::beat_clip::BeatClipRef;
use dj_engine::builtin::MONITOR_OUT_ID;
use dj_engine::decks::{SlotControl, DECKS_ID};
use dj_engine::playback::TrackData;
use dj_engine::{AudioFocus, Engine, EngineConfig};

const SR: f32 = 48_000.0;
const BLOCK: usize = 128;
const CLIP_BPM: f64 = 120.0;
/// The clip is steady DC at half scale, so the bank's contribution to the
/// mix is this exact value and anything else is the rack.
const DECK_LEVEL: f32 = 5.0;
/// Long enough for the slot's un-mute ramp (10 ms) to be over.
const SETTLE: usize = 24_000;

/// A bank playing one clip, an oscillator, and both into one output — the
/// two pages sharing an Audio Output, which is what the Decks tab's own
/// wiring produces.
fn page_pair() -> Engine {
    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            block_size: BLOCK,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();
    e.add_module("bank1", DECKS_ID).unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.add_module("mon1", MONITOR_OUT_ID).unwrap();
    e.connect("bank1", "audio_l", "out1", "l").unwrap();
    e.connect("bank1", "mon_l", "mon1", "l").unwrap();
    e.connect("osc1", "audio", "out1", "l").unwrap();
    play_clip(&mut e);
    e
}

/// Put a two-beat clip in slot 0, send it to the LIVE mix (a fresh load
/// lands cued to the monitor) and START the bank — a bank is created
/// stopped, so nothing plays until it is asked to.
fn play_clip(e: &mut Engine) {
    e.decks_load(
        "bank1",
        0,
        Some(BeatClipRef {
            project: "p1".into(),
            clip: "c1".into(),
            name: "c1".into(),
            project_name: "set one".into(),
            stems: Vec::new(),
        }),
        TrackData {
            channels: vec![vec![0.5; 24_000 * 2]],
            sample_rate: SR,
        },
        CLIP_BPM,
    )
    .unwrap();
    e.decks_set_control("bank1", 0, SlotControl::Monitor, 0.0)
        .unwrap();
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    e.decks_set_running("bank1", true).unwrap();
}

fn live(e: &mut Engine, frames: usize) -> Vec<f32> {
    e.render_offline(frames).unwrap().remove(0)
}

fn peak(xs: &[f32]) -> f32 {
    xs.iter().fold(0.0f32, |a, s| a.max(s.abs()))
}

#[test]
fn a_fresh_engine_plays_for_the_rack() {
    let mut e = page_pair();
    assert_eq!(e.audio_focus(), AudioFocus::Rack);
    let out = live(&mut e, SETTLE);
    assert!(
        peak(&out[BLOCK..]) > DECK_LEVEL + 1.0,
        "the whole patch sounds on the rack page: the oscillator too"
    );
}

#[test]
fn the_rack_is_held_back_while_the_decks_page_is_open() {
    let mut e = page_pair();
    live(&mut e, SETTLE);
    e.set_audio_focus(AudioFocus::Decks).unwrap();
    let out = live(&mut e, SETTLE);
    // What is left is the bank alone: steady DC, with no oscillator
    // riding on it at all.
    for s in &out[BLOCK..] {
        assert!(
            (s - DECK_LEVEL).abs() < 0.01,
            "the decks page hears its bank and nothing else, got {s}"
        );
    }
}

#[test]
fn a_page_that_makes_its_own_sound_leaves_the_engine_silent() {
    let mut e = page_pair();
    e.decks_set_control("bank1", 0, SlotControl::Monitor, 1.0)
        .unwrap();
    live(&mut e, SETTLE);
    e.set_audio_focus(AudioFocus::Silent).unwrap();
    let out = live(&mut e, SETTLE);
    assert_eq!(peak(&out[BLOCK..]), 0.0, "the live mix says nothing");
    let cue = e.render_offline_monitor(SETTLE).unwrap().remove(0);
    assert_eq!(peak(&cue), 0.0, "and neither does the cue");
}

#[test]
fn coming_back_to_a_page_brings_it_straight_back() {
    let mut e = page_pair();
    live(&mut e, SETTLE);
    e.set_audio_focus(AudioFocus::Silent).unwrap();
    live(&mut e, SETTLE);
    e.set_audio_focus(AudioFocus::Rack).unwrap();
    let out = live(&mut e, SETTLE);
    assert!(
        peak(&out[BLOCK..]) > DECK_LEVEL + 1.0,
        "the patch is exactly where it was"
    );
}

#[test]
fn the_change_is_a_fade_not_a_click() {
    let mut e = page_pair();
    // The bank alone, so the level at the top of the fade is known.
    e.set_audio_focus(AudioFocus::Decks).unwrap();
    live(&mut e, SETTLE);
    e.set_audio_focus(AudioFocus::Silent).unwrap();
    let block = live(&mut e, BLOCK);
    assert!(
        (block[0] - DECK_LEVEL).abs() < 0.01,
        "the fade starts where the audio was"
    );
    assert!(
        block[BLOCK - 1].abs() < DECK_LEVEL / 10.0,
        "and it is gone by the end of the block"
    );
    for pair in block.windows(2) {
        assert!(pair[1] <= pair[0] + 1e-6, "it only ever falls");
    }
    assert_eq!(peak(&live(&mut e, BLOCK)), 0.0, "one block, then silence");
}

#[test]
fn the_bank_is_still_heard_through_the_rack_it_plays_into() {
    let mut e = page_pair();
    // Route the bank through a rack module on its way out: a compressor,
    // a VCA, anything the user put in the path is still the decks.
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.set_knob_value("vca1", "cv", 10.0).unwrap();
    e.disconnect("bank1", "audio_l", "out1", "l").unwrap();
    e.connect("bank1", "audio_l", "vca1", "in").unwrap();
    e.connect("vca1", "out", "out1", "l").unwrap();
    e.set_audio_focus(AudioFocus::Decks).unwrap();
    let out = live(&mut e, SETTLE);
    assert!(
        peak(&out[BLOCK..]) > 0.1,
        "a bank played through the rack still reaches the room"
    );
}

#[test]
fn a_wire_edit_cannot_reopen_the_page_nobody_is_looking_at() {
    let mut e = page_pair();
    e.set_audio_focus(AudioFocus::Decks).unwrap();
    live(&mut e, SETTLE);
    // Every plan carries the focus, so a wire added while the Decks page
    // is open must not let the rack back in.
    e.add_module("osc2", "com.dj.oscillator").unwrap();
    e.connect("osc2", "audio", "out1", "l").unwrap();
    let out = live(&mut e, SETTLE);
    for s in &out[BLOCK..] {
        assert!(
            (s - DECK_LEVEL).abs() < 0.01,
            "still the bank alone, got {s}"
        );
    }
}
