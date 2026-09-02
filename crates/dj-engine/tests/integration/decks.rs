//! Decks bank (`builtin.decks`) tests — the engine behind the Decks tab:
//! - a clip lands CUED to the monitor (unmuted, off the live mix),
//!   un-shifted and stretched to the bank's tempo,
//! - the bank's one clock is what phase-aligns the slots: an 8-beat clip
//!   and a 2-beat clip share a downbeat, a 6-beat one lands on the even
//!   beats they share, and a 7-beat one is honestly reported as sharing
//!   nothing,
//! - beats of silence on the end and whole-beat shifts move a slot on
//!   that grid,
//! - a Launch Control XL column drives its slot (knobs = tone controls,
//!   fader = level, buttons TOGGLE mute and monitor on ONE press, and the
//!   lamps follow),
//! - a cued deck leaves the live mix for the monitor bus, and each of the
//!   two pairs has a master fader of its own,
//! - and the whole bank — bindings and mix — round-trips through a patch,
//!   whose reload asks the app layer for the audio back.

use dj_engine::beat_clip::BeatClipRef;
use dj_engine::builtin::MONITOR_OUT_ID;
use dj_engine::decks::{
    led, DeckArm, MasterBus, SlotControl, DECKS_ID, DEFAULT_SURFACE_CHANNEL, EQ_MAX, LEVEL_MAX,
    LEVEL_UNITY, MOMENTARY_RELEASE_SECS, SLOTS,
};
use dj_engine::playback::TrackData;
use dj_engine::{Engine, EngineConfig};

const SR: f32 = 48_000.0;
const CLIP_BPM: f64 = 120.0;

/// A bank wired to an output and STARTED — a bank is created stopped, so
/// every test that listens to one has to press play first, exactly like
/// the page's Start button.
fn bank() -> Engine {
    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();
    e.add_module("bank1", DECKS_ID).unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("bank1", "audio_l", "out1", "l").unwrap();
    e.decks_set_running("bank1", true).unwrap();
    e
}

/// A clip of `beats` whole beats at 120 BPM, as a steady value so the
/// level it comes out at is readable straight off the render.
fn clip(beats: usize, value: f32) -> TrackData {
    TrackData {
        channels: vec![vec![value; 24_000 * beats]],
        sample_rate: SR,
    }
}

fn clip_ref(name: &str) -> BeatClipRef {
    BeatClipRef {
        project: "p1".into(),
        clip: name.into(),
        name: name.into(),
        project_name: "set one".into(),
        stems: Vec::new(),
        ones: Vec::new(),
    }
}

/// The same binding, for a clip whose grid marks these beats as its ONES.
fn clip_ref_ones(name: &str, ones: &[u32]) -> BeatClipRef {
    BeatClipRef {
        ones: ones.to_vec(),
        ..clip_ref(name)
    }
}

/// Load a clip and park it MUTED on the LIVE pair. A fresh load lands
/// cued — unmuted, on the monitor pair (pinned by
/// [`a_loaded_clip_arrives_cued_and_stretched_to_the_banks_tempo`]) — but
/// these tests drive the live mix, so the helper puts the slot where a
/// user who has taken it off cue and muted it would.
fn load(e: &mut Engine, slot: usize, beats: usize) {
    e.decks_load(
        "bank1",
        slot,
        Some(clip_ref(&format!("clip{beats}"))),
        clip(beats, 0.5),
        CLIP_BPM,
    )
    .unwrap();
    e.decks_set_control("bank1", slot, SlotControl::Monitor, 0.0)
        .unwrap();
    e.decks_set_control("bank1", slot, SlotControl::Mute, 10.0)
        .unwrap();
}

/// One control-surface gesture: press and release, so the next press is a
/// fresh one (the buttons are momentary on the device).
fn press(e: &mut Engine, note: u8) {
    e.decks_inject("bank1", [0x90, note, 127]).unwrap();
    e.decks_inject("bank1", [0x80, note, 0]).unwrap();
}

/// The Launch Control XL note the surface sends for a column's buttons.
const FOCUS_NOTES: [u8; 8] = [41, 42, 43, 44, 57, 58, 59, 60];
const CONTROL_NOTES: [u8; 8] = [73, 74, 75, 76, 89, 90, 91, 92];

#[test]
fn decks_is_listed_in_all_manifests() {
    let ids: Vec<String> = crate::common::registry()
        .all_manifests()
        .iter()
        .map(|m| m.id.clone())
        .collect();
    assert!(
        ids.contains(&DECKS_ID.to_string()),
        "{DECKS_ID} missing from the module list: {ids:?}"
    );
}

/// A bank exactly as it is created: wired to an output, but never
/// started. What the app has when the Decks page first opens.
fn stopped_bank() -> Engine {
    let mut e = bank();
    e.decks_set_running("bank1", false).unwrap();
    e
}

#[test]
fn a_new_bank_is_stopped_and_stays_silent_until_it_is_started() {
    let mut e = stopped_bank();
    load(&mut e, 0, 2);
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    let st = e.decks_status("bank1").unwrap();
    assert!(!st.running, "opening the page is not a reason to play");

    let out = e.render_offline(48_000).unwrap().remove(0);
    assert_eq!(peak(&out), 0.0, "an unmuted deck on a stopped bank is mute");
    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.beat, 0.0, "and the clock has not moved");
    assert!(!st.slots[0].playing && !st.slots[0].sounding);

    // Start is the whole difference: same slot, same mute, now audible.
    e.decks_set_running("bank1", true).unwrap();
    assert!(e.decks_status("bank1").unwrap().running);
    let out = e.render_offline(48_000).unwrap().remove(0);
    assert!(peak(&out[4_800..]) > 0.1, "started, the deck plays");
    let st = e.decks_status("bank1").unwrap();
    assert!(st.beat > 1.0, "the clock is running");
    assert!(st.slots[0].playing);
}

#[test]
fn stopping_parks_the_bank_back_on_beat_zero() {
    let mut e = bank();
    load(&mut e, 0, 4);
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    e.render_offline(48_000).unwrap();
    assert!(e.decks_status("bank1").unwrap().beat > 1.0);

    e.decks_set_running("bank1", false).unwrap();
    let out = e.render_offline(48_000).unwrap().remove(0);
    assert!(
        peak(&out[4_800..]) < 1e-4,
        "a stopped bank is silent, mute or not"
    );
    let st = e.decks_status("bank1").unwrap();
    assert!(!st.running);
    assert_eq!(
        st.beat, 0.0,
        "so the next start comes in from the top of every clip"
    );
}

#[test]
fn a_stopped_bank_clocks_nothing() {
    let mut e = stopped_bank();
    e.add_module("out2", "builtin.audio_out").unwrap();
    e.connect("bank1", "clock", "out2", "l").unwrap();
    let out = e.render_offline(48_000).unwrap().remove(0);
    assert_eq!(peak(&out), 0.0, "a grid that is not moving is not a grid");
}

#[test]
fn the_transport_is_not_patch_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = bank();
    load(&mut e, 0, 4);
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    e.save_patch(&dir.path().join("p"), "decks").unwrap();

    let e2 = Engine::load_patch(&dir.path().join("p"), crate::common::registry()).unwrap();
    let st = e2.decks_status("bank1").unwrap();
    assert!(
        !st.running,
        "a bank restored with the app comes back stopped"
    );
    assert!(!st.slots[0].mute, "the mix the patch kept is untouched");
}

#[test]
fn a_bank_starts_empty_muted_and_silent() {
    let mut e = bank();
    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.slots.len(), SLOTS);
    assert!(st.slots.iter().all(|s| s.clip.is_none() && s.mute));
    assert_eq!(st.cycle_beats, 0, "nothing loaded comes round at all");
    let out = e.render_offline(4096).unwrap().remove(0);
    assert!(out.iter().all(|s| *s == 0.0));
}

#[test]
fn a_loaded_clip_arrives_cued_and_stretched_to_the_banks_tempo() {
    let mut e = bank();
    e.set_knob_value("bank1", "bpm", 150.0).unwrap();
    // The raw load, not the helper: this test pins what a fresh load is.
    e.decks_load("bank1", 0, Some(clip_ref("clip4")), clip(4, 0.5), CLIP_BPM)
        .unwrap();

    let st = e.decks_status("bank1").unwrap();
    let slot = &st.slots[0];
    assert_eq!(slot.clip.as_ref().unwrap().clip, "clip4");
    assert!(slot.loaded, "the audio is in hand");
    assert_eq!(slot.beats, 4);
    assert_eq!(slot.source_bpm as f64, CLIP_BPM);
    assert!(
        (slot.stretch - 150.0 / 120.0).abs() < 1e-9,
        "the slot reports how far it is being stretched: {}",
        slot.stretch
    );
    assert!(!slot.mute, "a fresh load is unmuted, ready in the cue");
    assert!(
        slot.monitor,
        "a clip that loaded itself into the LIVE mix would be a bug: it lands on the monitor pair"
    );
    assert_eq!((slot.phase, slot.tail), (0, 0));

    let out = e.render_offline(4_096).unwrap().remove(0);
    assert!(
        out.iter().all(|s| *s == 0.0),
        "cued is for the headphones: the live mix stays silent"
    );

    // Taken off cue it plays in the room, and the bank's tempo is what it
    // plays at: one second of render (the cued blocks included — the
    // clock runs whether or not anyone is listening) is 2.5 beats at 150
    // BPM, so a four-beat clip is on its beat 2.
    e.decks_set_control("bank1", 0, SlotControl::Monitor, 0.0)
        .unwrap();
    let out = e.render_offline(48_000 - 4_096).unwrap().remove(0);
    assert!(
        out[out.len() - 1_000..].iter().any(|s| s.abs() > 0.1),
        "off cue, an unmuted slot sounds"
    );
    let st = e.decks_status("bank1").unwrap();
    assert!(
        (st.beat - 2.5).abs() < 0.01,
        "a second at 150 BPM is 2.5 beats, got {}",
        st.beat
    );
    assert_eq!(st.slots[0].beat, 2);
}

#[test]
fn slots_share_the_banks_grid_however_long_their_loops_are() {
    let mut e = bank();
    load(&mut e, 0, 8);
    load(&mut e, 1, 2);
    load(&mut e, 2, 6);

    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.cycle_beats, 24, "8, 2 and 6 come round together on 24");

    // The alignment is real, not just arithmetic: two beats in, the
    // 8-beat clip is on its beat 2 and the 2-beat clip is back at 0 —
    // the same instant of the same grid.
    for s in 0..3 {
        e.decks_set_control("bank1", s, SlotControl::Mute, 0.0)
            .unwrap();
    }
    e.render_offline(48_000).unwrap();
    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.slots[0].beat, 2);
    assert_eq!(st.slots[1].beat, 0);
    assert_eq!(st.slots[2].beat, 2);

    // Seven beats share nothing with any of them: the bank still runs
    // them all off the one clock, it just takes longer to come round.
    load(&mut e, 3, 7);
    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.cycle_beats, 168, "and only comes round every 168 beats");
}

#[test]
fn a_fresh_load_lines_the_clip_up_by_its_first_one_beat() {
    let mut e = bank();
    // Two 8-beat clips whose downbeats sit at different places in the
    // audio: one starts on its one, the other picks up two beats before
    // it. Lining up the FIRST beats would put those two ones two beats
    // apart; lining up the ones puts them both on the bank's beat 0.
    e.decks_load(
        "bank1",
        0,
        Some(clip_ref_ones("a", &[0, 4])),
        clip(8, 0.5),
        CLIP_BPM,
    )
    .unwrap();
    e.decks_load(
        "bank1",
        1,
        Some(clip_ref_ones("b", &[2, 6])),
        clip(8, 0.5),
        CLIP_BPM,
    )
    .unwrap();
    // A clip that marks no ones is lined up by its first beat, as before.
    e.decks_load("bank1", 2, Some(clip_ref("c")), clip(8, 0.5), CLIP_BPM)
        .unwrap();

    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.slots[0].phase, 0, "its one is already at the top");
    assert_eq!(
        st.slots[1].phase, 6,
        "shifted so its beat 2 — its first one — lands on the bank's 0"
    );
    assert_eq!(st.slots[2].phase, 0, "no ones, no shift");
    assert_eq!(st.slots[1].ones, vec![2, 6], "the lamp row marks both");
    assert_eq!(st.slots[1].lead_one, Some(2), "led by the clip's first one");

    // And it is real, not just arithmetic: the bank starts on beat 0, so
    // two beats later each deck is two beats past the one it started on.
    e.render_offline(48_000).unwrap(); // two beats at 120 BPM
    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.slots[0].beat, 2, "deck 0's one was at its beat 0");
    assert_eq!(st.slots[1].beat, 4, "deck 1's was at its beat 2");
}

#[test]
fn shifting_a_deck_hands_the_lead_to_whichever_one_comes_round_first() {
    let mut e = bank();
    e.decks_load(
        "bank1",
        0,
        Some(clip_ref_ones("a", &[0, 4])),
        clip(8, 0.5),
        CLIP_BPM,
    )
    .unwrap();
    assert_eq!(e.decks_status("bank1").unwrap().slots[0].lead_one, Some(0));

    // Shifted five beats along, the clip's SECOND one is the one that now
    // falls closest after the bank's downbeat (beat 1 against beat 5), so
    // that is the one the deck is being lined up by.
    e.decks_set_phase("bank1", 0, 5).unwrap();
    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.slots[0].lead_one, Some(4));
    assert_eq!(st.slots[0].ones, vec![0, 4], "both are still ones");

    // Back where the load put it, and the clip's first one leads again.
    e.decks_set_phase("bank1", 0, 0).unwrap();
    assert_eq!(e.decks_status("bank1").unwrap().slots[0].lead_one, Some(0));
}

#[test]
fn a_one_closing_the_clip_marks_its_first_beat_not_its_last() {
    let mut e = bank();
    // A grid cut to an eight-beat clip keeps the beat at BOTH edges of the
    // span, so a clip tapped four-to-the-bar marks 0, 4 and 8: beat 8 is
    // the downbeat of the next pass, which is this clip's beat 0.
    e.decks_load(
        "bank1",
        0,
        Some(clip_ref_ones("a", &[0, 4, 8])),
        clip(8, 0.5),
        CLIP_BPM,
    )
    .unwrap();
    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.slots[0].beats, 8);
    assert_eq!(
        st.slots[0].ones,
        vec![0, 4],
        "the closing one is beat 0 come round again, never the clip's last beat"
    );
    assert_eq!(st.slots[0].lead_one, Some(0));
    assert_eq!(st.slots[0].phase, 0, "and the load still lands unshifted");

    // A clip that marks ONLY its closing beat is marked — and lined up —
    // on its beat 0, the instant that marker names.
    e.decks_load(
        "bank1",
        1,
        Some(clip_ref_ones("b", &[8])),
        clip(8, 0.5),
        CLIP_BPM,
    )
    .unwrap();
    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.slots[1].ones, vec![0]);
    assert_eq!(st.slots[1].lead_one, Some(0));
    assert_eq!(st.slots[1].phase, 0);
}

#[test]
fn a_deck_in_double_time_counts_its_ones_on_the_banks_grid() {
    let mut e = bank();
    e.decks_load(
        "bank1",
        0,
        Some(clip_ref_ones("a", &[0, 4])),
        clip(8, 0.5),
        CLIP_BPM,
    )
    .unwrap();
    e.decks_set_ratio("bank1", 0, 2.0).unwrap();
    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.slots[0].beats, 4, "eight clip beats in four bank ones");
    assert_eq!(
        st.slots[0].ones,
        vec![0, 2],
        "and its downbeats come round twice as often"
    );
}

#[test]
fn silence_on_the_end_lengthens_the_loop_and_a_shift_moves_it() {
    let mut e = bank();
    load(&mut e, 0, 2);
    e.decks_set_tail("bank1", 0, 2).unwrap();
    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.slots[0].tail, 2);
    assert_eq!(st.cycle_beats, 4, "two beats of clip plus two of silence");

    // A shift is kept inside one loop, so nudging past the end comes back
    // to the start rather than counting off to infinity.
    e.decks_set_phase("bank1", 0, 5).unwrap();
    assert_eq!(e.decks_status("bank1").unwrap().slots[0].phase, 1);
    e.decks_set_phase("bank1", 0, -1).unwrap();
    assert_eq!(e.decks_status("bank1").unwrap().slots[0].phase, 3);

    // Two beats of tail on a two-beat clip: the second half of the loop
    // is silence, whatever the fader says.
    e.decks_set_phase("bank1", 0, 0).unwrap();
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    let out = e.render_offline(96_000).unwrap().remove(0);
    assert!(out[40_000].abs() > 0.1, "the clip's own beats sound");
    assert!(
        out[60_000..90_000].iter().all(|s| s.abs() < 1e-4),
        "the tail is silence"
    );
}

#[test]
fn a_deck_can_run_at_a_ratio_of_the_banks_grid() {
    let mut e = bank(); // 120 BPM bank, 120 BPM clips
    load(&mut e, 0, 4);
    assert_eq!(
        e.decks_status("bank1").unwrap().slots[0].beats,
        4,
        "as cut, four clip beats fill four of the bank's"
    );

    e.decks_set_ratio("bank1", 0, 2.0).unwrap();
    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.slots[0].ratio, 2.0);
    assert_eq!(
        st.slots[0].beats, 2,
        "double time gets through the same clip in two of the bank's beats"
    );
    assert!(
        (st.slots[0].stretch - 2.0).abs() < 1e-9,
        "and the audio is read twice as fast: {}",
        st.slots[0].stretch
    );
    assert_eq!(
        st.cycle_beats, 2,
        "so the whole loop comes round twice as often"
    );

    // And it is HEARD there: two beats of clip, then the silence hung on
    // the end — where the same clip on the bank's grid would still have
    // been playing. 120 BPM is 24_000 frames a beat.
    e.decks_set_tail("bank1", 0, 2).unwrap();
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    let out = e.render_offline(96_000).unwrap().remove(0);
    assert!(
        out[20_000].abs() > 0.1,
        "the clip plays over the bank's first two beats"
    );
    assert!(
        out[60_000..90_000].iter().all(|s| s.abs() < 1e-4),
        "and the rest of the loop is the tail's silence"
    );

    // The other way round, a deck at half time takes twice the grid.
    e.decks_set_ratio("bank1", 0, 0.5).unwrap();
    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.slots[0].beats, 8);
    assert!((st.slots[0].stretch - 0.5).abs() < 1e-9);
}

#[test]
fn a_decks_ratio_rides_in_the_patch_and_a_fresh_clip_lands_on_the_grid() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = bank();
    load(&mut e, 0, 4);
    e.decks_set_ratio("bank1", 0, 1.0 / 3.0).unwrap();
    e.save_patch(&dir.path().join("p"), "decks").unwrap();

    let mut e2 = Engine::load_patch(&dir.path().join("p"), crate::common::registry()).unwrap();
    let st = e2.decks_status("bank1").unwrap();
    assert!(
        (st.slots[0].ratio - 1.0 / 3.0).abs() < 1e-6,
        "a bank comes back running the deck where it was left"
    );
    assert_eq!(
        st.slots[0].beats, 12,
        "four clip beats over a third of the speed"
    );

    // A new clip is a new timeline: it arrives on the bank's own grid,
    // like the shift and the silence the load clears.
    load(&mut e2, 0, 4);
    let st = e2.decks_status("bank1").unwrap();
    assert_eq!((st.slots[0].ratio, st.slots[0].beats), (1.0, 4));
}

#[test]
fn a_deck_plays_as_imported_at_mid_fader_and_boosts_above_it() {
    let mut e = bank();
    load(&mut e, 0, 4); // a constant 0.5, so the gain reads off the render
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();

    // A slot starts at unity — halfway up its fader — so a clip plays at
    // exactly the volume it was imported at (a 0.5 sample is 5 V out).
    assert_eq!(e.decks_status("bank1").unwrap().slots[0].level, LEVEL_UNITY);
    let unity = settled_peak(&mut e);
    assert!(
        (unity - 5.0).abs() < 1e-2,
        "unity is the clip itself: {unity}"
    );

    // The half above unity is what the travel is for, and it stops at
    // +6 dB however hard the caller pushes.
    e.decks_set_control("bank1", 0, SlotControl::Level, 4.0)
        .unwrap();
    assert_eq!(e.decks_status("bank1").unwrap().slots[0].level, LEVEL_MAX);
    let loud = settled_peak(&mut e);
    assert!(
        (loud - 2.0 * unity).abs() < 1e-2,
        "the top is +6 dB: {loud}"
    );

    // Below unity is the cut it always was.
    e.decks_set_control("bank1", 0, SlotControl::Level, 0.5)
        .unwrap();
    let quiet = settled_peak(&mut e);
    assert!((quiet - unity / 2.0).abs() < 1e-2, "half unity: {quiet}");
}

/// Loudest sample of the second half of half a second of render — past
/// the block the mix ramp lands in.
fn settled_peak(e: &mut Engine) -> f32 {
    peak(&e.render_offline(24_000).unwrap().remove(0)[12_000..])
}

#[test]
fn a_surface_column_drives_its_slot() {
    let mut e = bank();
    load(&mut e, 2, 4);

    // Column 3's fader (CC 79) is slot 3's level, and the fader's MIDDLE
    // is the clip as imported: halfway up is unity, the top half boost.
    e.decks_inject("bank1", [0xB8, 79, 64]).unwrap();
    let st = e.decks_status("bank1").unwrap();
    assert!((st.slots[2].level - 64.0 / 127.0 * LEVEL_MAX).abs() < 1e-6);
    e.decks_inject("bank1", [0xB8, 79, 127]).unwrap();
    assert_eq!(e.decks_status("bank1").unwrap().slots[2].level, LEVEL_MAX);
    e.decks_inject("bank1", [0xB8, 79, 64]).unwrap();

    // Its three knobs are high/mid/low, flat at 12 o'clock.
    e.decks_inject("bank1", [0xB8, 15, 127]).unwrap(); // send A, col 3
    e.decks_inject("bank1", [0xB8, 31, 64]).unwrap(); // send B, col 3
    e.decks_inject("bank1", [0xB8, 51, 0]).unwrap(); // pan, col 3
    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.slots[2].high, EQ_MAX);
    assert!((st.slots[2].mid - 64.0 / 127.0 * EQ_MAX).abs() < 1e-6);
    assert_eq!(st.slots[2].low, 0.0);

    // The buttons are momentary on the device and TOGGLE here: a mute you
    // have to hold is not a mute.
    assert!(st.slots[2].mute, "the helper parked it muted");
    press(&mut e, FOCUS_NOTES[2]);
    assert!(!e.decks_status("bank1").unwrap().slots[2].mute);
    press(&mut e, FOCUS_NOTES[2]);
    assert!(e.decks_status("bank1").unwrap().slots[2].mute);
    press(&mut e, CONTROL_NOTES[2]);
    assert!(e.decks_status("bank1").unwrap().slots[2].monitor);

    // A column with nothing in it still moves its own slot, and no other.
    e.decks_inject("bank1", [0xB8, 84, 127]).unwrap();
    let st = e.decks_status("bank1").unwrap();
    assert_eq!(st.slots[7].level, LEVEL_MAX);
    assert!((st.slots[2].level - 64.0 / 127.0 * LEVEL_MAX).abs() < 1e-6);
}

#[test]
fn only_banks_following_the_surface_hear_the_device() {
    let mut e = bank();
    e.add_module("bank2", DECKS_ID).unwrap();
    e.set_param("bank2", "surface", 0.0).unwrap();

    e.decks_feed([0xB8, 77, 127]).unwrap();
    assert_eq!(e.decks_status("bank1").unwrap().slots[0].level, LEVEL_MAX);
    assert_eq!(
        e.decks_status("bank2").unwrap().slots[0].level,
        LEVEL_UNITY,
        "a bank switched off the surface must not move"
    );
    e.decks_feed([0xB8, 77, 0]).unwrap();
    assert_eq!(e.decks_status("bank1").unwrap().slots[0].level, 0.0);
    assert_eq!(e.decks_status("bank2").unwrap().slots[0].level, LEVEL_UNITY);
    // Addressed directly, the same message lands anyway (the test seam).
    e.decks_inject("bank2", [0xB8, 77, 0]).unwrap();
    assert_eq!(e.decks_status("bank2").unwrap().slots[0].level, 0.0);
}

#[test]
fn a_queued_deck_comes_in_on_its_clips_first_beat_and_never_mid_clip() {
    let mut e = bank();
    load(&mut e, 0, 2);
    // Half a beat in at 120 BPM, still silent.
    let out = e.render_offline(12_000).unwrap().remove(0);
    assert!(out.iter().all(|s| *s == 0.0));

    e.decks_arm("bank1", 0, DeckArm::Queue).unwrap();
    let slot = &e.decks_status("bank1").unwrap().slots[0];
    assert_eq!(slot.arm, DeckArm::Queue);
    assert!(
        !slot.mute,
        "the mute a patch keeps is already where the queue is going"
    );

    // The rest of this beat AND the whole next one are silence: the
    // bank's beat 1 is the middle of the two-beat clip, and a queue does
    // not start a clip partway through.
    let out = e.render_offline(36_000).unwrap().remove(0);
    assert!(
        out.iter().all(|s| s.abs() < 1e-6),
        "a queued deck is held until ITS first beat, not just any beat"
    );
    assert_eq!(
        e.decks_status("bank1").unwrap().slots[0].arm,
        DeckArm::Queue
    );

    // Beat 2 is the loop seam — the clip's first beat coming round —
    // and there it plays, with the arm spent.
    let out = e.render_offline(12_000).unwrap().remove(0);
    assert!(
        out[out.len() - 100..].iter().any(|s| s.abs() > 0.1),
        "its first beat started it"
    );
    let slot = &e.decks_status("bank1").unwrap().slots[0];
    assert_eq!(slot.arm, DeckArm::None);
    assert!(slot.playing);
}

#[test]
fn a_dropped_deck_plays_its_last_beat_before_it_stops() {
    let mut e = bank();
    load(&mut e, 0, 2);
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    // A beat in — halfway through a two-beat clip.
    e.render_offline(24_000).unwrap();

    e.decks_arm("bank1", 0, DeckArm::Drop).unwrap();
    let slot = &e.decks_status("bank1").unwrap().slots[0];
    assert_eq!(slot.arm, DeckArm::Drop);
    assert!(
        slot.mute,
        "a drop is a mute, waiting for the end of the clip"
    );

    // The clip's second beat still sounds: the drop is not a cut.
    let out = e.render_offline(23_000).unwrap().remove(0);
    assert!(
        out[out.len() - 100..].iter().any(|s| s.abs() > 0.1),
        "a dropping deck plays its clip out"
    );

    // Past the seam it is gone, rather than round again.
    let out = e.render_offline(24_000).unwrap().remove(0);
    assert!(out[8_000..].iter().all(|s| s.abs() < 1e-4));
    let slot = &e.decks_status("bank1").unwrap().slots[0];
    assert_eq!(slot.arm, DeckArm::None);
    assert!(!slot.playing);
}

#[test]
fn an_arm_can_be_taken_back_and_the_mute_button_overrules_it() {
    let mut e = bank();
    load(&mut e, 0, 2);

    // Queue, then think better of it: the deck is muted again, as it was.
    e.decks_arm("bank1", 0, DeckArm::Queue).unwrap();
    e.decks_arm("bank1", 0, DeckArm::None).unwrap();
    let slot = &e.decks_status("bank1").unwrap().slots[0];
    assert_eq!(slot.arm, DeckArm::None);
    assert!(slot.mute);
    let out = e.render_offline(48_000).unwrap().remove(0);
    assert!(
        out.iter().all(|s| s.abs() < 1e-6),
        "a cancelled queue never starts"
    );

    // Arming with the deck running and then pressing MUTE: the button
    // wins, and nothing is left waiting to undo it.
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    e.render_offline(4_096).unwrap();
    e.decks_arm("bank1", 0, DeckArm::Drop).unwrap();
    e.decks_set_control("bank1", 0, SlotControl::Mute, 10.0)
        .unwrap();
    let slot = &e.decks_status("bank1").unwrap().slots[0];
    assert_eq!(slot.arm, DeckArm::None);
    assert!(slot.mute);
    let out = e.render_offline(24_000).unwrap().remove(0);
    assert!(
        out[8_000..].iter().all(|s| s.abs() < 1e-4),
        "a pressed mute is a mute now, not at the end of the clip"
    );
}

#[test]
fn an_arm_is_transport_not_patch_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = bank();
    load(&mut e, 0, 4);
    e.decks_arm("bank1", 0, DeckArm::Queue).unwrap();
    e.save_patch(&dir.path().join("p"), "decks").unwrap();

    let e2 = Engine::load_patch(&dir.path().join("p"), crate::common::registry()).unwrap();
    let slot = &e2.decks_status("bank1").unwrap().slots[0];
    assert_eq!(slot.arm, DeckArm::None, "a bank comes back unarmed");
    assert!(
        !slot.mute,
        "what the patch kept is the mute the queue was on its way to"
    );
}

#[test]
fn clearing_a_slot_keeps_the_mix_the_user_set() {
    let mut e = bank();
    load(&mut e, 0, 4);
    e.decks_set_control("bank1", 0, SlotControl::Level, 0.4)
        .unwrap();
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    e.decks_clear("bank1", 0).unwrap();

    let st = e.decks_status("bank1").unwrap();
    assert!(st.slots[0].clip.is_none() && !st.slots[0].loaded);
    assert_eq!(st.slots[0].beats, 0);
    assert!(
        (st.slots[0].level - 0.4).abs() < 1e-6,
        "the fader is the slot's"
    );
    assert!(st.slots[0].mute, "an empty slot is muted again");
    let out = e.render_offline(4096).unwrap().remove(0);
    assert!(out.iter().all(|s| *s == 0.0));
}

#[test]
fn a_new_clip_arrives_on_a_deck_with_nothing_the_last_one_was_played_with() {
    let mut e = bank();
    e.add_module("vca1", "com.dj.vca").unwrap();
    load(&mut e, 0, 4);
    // Everything a hand can do to a deck, said about the clip in it: the
    // mix, the grid, the insert and the cables that make one.
    for (control, value) in [
        (SlotControl::Level, 0.4),
        (SlotControl::Low, 0.0),
        (SlotControl::Mid, 1.5),
        (SlotControl::High, 0.25),
        (SlotControl::Wet, 0.5),
        (SlotControl::InsertMonitor, 10.0),
    ] {
        e.decks_set_control("bank1", 0, control, value).unwrap();
    }
    e.decks_set_tail("bank1", 0, 3).unwrap();
    e.decks_set_phase("bank1", 0, 2).unwrap();
    e.decks_set_ratio("bank1", 0, 2.0).unwrap();
    e.connect("bank1", "d1_out", "vca1", "in").unwrap();
    e.connect("vca1", "out", "bank1", "d1_in").unwrap();
    e.connect("bank1", "d1_low", "vca1", "cv").unwrap();
    // Deck two's own cables, to prove a load is about ONE deck.
    e.connect("bank1", "d2_out", "vca1", "in").unwrap();
    assert!(e.decks_status("bank1").unwrap().slots[0].insert);

    // What the shell's load does, in order: the cables out, then the clip
    // in (see `decks_load` in app/src-tauri/src/decks.rs).
    e.decks_unplug_slot("bank1", 0).unwrap();
    e.decks_load("bank1", 0, Some(clip_ref("next")), clip(2, 0.5), CLIP_BPM)
        .unwrap();

    let st = e.decks_status("bank1").unwrap();
    let s = &st.slots[0];
    assert_eq!(s.level, LEVEL_UNITY, "the fader is back at unity");
    assert_eq!((s.low, s.mid, s.high), (1.0, 1.0, 1.0), "the tone is flat");
    assert_eq!(s.wet, 1.0);
    assert!(!s.insert_monitor);
    assert_eq!((s.tail, s.phase, s.ratio), (0, 0, 1.0));
    assert!(
        !s.insert,
        "the insert went with the clip it was built for: the deck's cables are out"
    );
    assert!(
        s.tone_patched.iter().all(|p| !p),
        "and so did the tone CV driving it"
    );
    assert!(
        e.wire_specs()
            .iter()
            .any(|w| w.from_jack == dj_engine::decks::send_jack(1)),
        "deck two's cable is deck two's business"
    );
}

#[test]
fn the_whole_bank_round_trips_through_a_patch_and_asks_for_its_audio_back() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = bank();
    load(&mut e, 0, 8);
    load(&mut e, 3, 2);
    e.set_knob_value("bank1", "bpm", 128.0).unwrap();
    e.decks_set_control("bank1", 0, SlotControl::Level, 0.75)
        .unwrap();
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    e.decks_set_control("bank1", 3, SlotControl::Low, 0.25)
        .unwrap();
    e.decks_set_control("bank1", 3, SlotControl::Monitor, 10.0)
        .unwrap();
    e.decks_set_tail("bank1", 3, 2).unwrap();
    e.decks_set_phase("bank1", 3, 1).unwrap();
    assert!(
        e.decks_pending().is_empty(),
        "nothing is pending while the audio is in hand"
    );
    e.save_patch(&dir.path().join("p"), "decks").unwrap();

    let e2 = Engine::load_patch(&dir.path().join("p"), crate::common::registry()).unwrap();
    let st = e2.decks_status("bank1").unwrap();
    assert!((st.bpm - 128.0).abs() < 1e-4);
    assert_eq!(st.slots[0].clip.as_ref().unwrap().clip, "clip8");
    assert!((st.slots[0].level - 0.75).abs() < 1e-6);
    assert!(!st.slots[0].mute);
    assert_eq!(st.slots[0].beats, 8);
    assert!((st.slots[3].low - 0.25).abs() < 1e-6);
    assert!(st.slots[3].monitor);
    assert_eq!((st.slots[3].tail, st.slots[3].phase), (2, 1));
    // The audio is NOT in the patch: a clip is placements, and the app
    // layer is asked to assemble exactly the slots that need it.
    assert!(!st.slots[0].loaded && !st.slots[3].loaded);
    let pending: Vec<(String, usize, String)> = e2
        .decks_pending()
        .into_iter()
        .map(|(i, s, c)| (i, s, c.clip))
        .collect();
    assert_eq!(
        pending,
        vec![
            ("bank1".to_string(), 0, "clip8".to_string()),
            ("bank1".to_string(), 3, "clip2".to_string()),
        ]
    );

    // Handing it over settles the debt.
    let mut e2 = e2;
    e2.decks_load("bank1", 0, st.slots[0].clip.clone(), clip(8, 0.5), CLIP_BPM)
        .unwrap();
    assert_eq!(e2.decks_pending().len(), 1);
}

#[test]
fn an_untouched_bank_round_trips_unchanged() {
    // An untouched bank still persists its (default) slots, and reading
    // them back leaves the module exactly as it was — the round trip is
    // what patches promise.
    let dir = tempfile::tempdir().unwrap();
    let e = bank();
    e.save_patch(&dir.path().join("p"), "decks").unwrap();
    let e2 = Engine::load_patch(&dir.path().join("p"), crate::common::registry()).unwrap();
    assert_eq!(
        e2.decks_state("bank1").unwrap(),
        e.decks_state("bank1").unwrap()
    );
}

#[test]
fn a_bank_restored_from_a_patch_plays_once_its_audio_comes_back() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = bank();
    load(&mut e, 0, 2);
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    let out = e.render_offline(48_000).unwrap().remove(0);
    assert!(
        out[out.len() - 100..].iter().any(|s| s.abs() > 0.1),
        "the live bank plays"
    );
    e.save_patch(&dir.path().join("p"), "decks").unwrap();

    // What the app does at startup: load the patch, then hand back the
    // audio the patch could not carry. Sound is the whole point of the
    // handover, so assert on the render, not on the bookkeeping.
    let mut e2 = Engine::load_patch(&dir.path().join("p"), crate::common::registry()).unwrap();
    for (instance, slot, cl) in e2.decks_pending() {
        e2.decks_supply(&instance, slot, Some(cl), clip(2, 0.5), CLIP_BPM)
            .unwrap();
    }
    // A restored bank comes back STOPPED, so the sound is what the page's
    // Start button asks for.
    e2.decks_set_running("bank1", true).unwrap();
    let out = e2.render_offline(48_000).unwrap().remove(0);
    let peak = out.iter().fold(0.0f32, |a, s| a.max(s.abs()));
    assert!(peak > 0.1, "a restored bank plays (peak {peak})");
}

#[test]
fn a_restored_bank_runs_when_the_backend_starts_after_the_handover() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = bank();
    load(&mut e, 0, 2);
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    e.save_patch(&dir.path().join("p"), "decks").unwrap();

    // The app's startup order: load the patch, hand the audio back while
    // the engine is STOPPED, then start the backend.
    let mut e2 = Engine::load_patch(&dir.path().join("p"), crate::common::registry()).unwrap();
    for (instance, slot, cl) in e2.decks_pending() {
        e2.decks_supply(&instance, slot, Some(cl), clip(2, 0.5), CLIP_BPM)
            .unwrap();
    }
    e2.decks_set_running("bank1", true).unwrap();
    e2.start_null_realtime().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    let st = e2.decks_status("bank1").unwrap();
    e2.stop().unwrap();
    assert!(st.beat > 0.1, "the bank's clock runs");
    assert!(st.slots[0].playing, "the slot is sounding");
}

#[test]
fn one_button_press_is_one_change_whichever_template_sends_it() {
    let mut e = bank();
    load(&mut e, 0, 2);
    let note = FOCUS_NOTES[0];
    assert!(
        e.decks_status("bank1").unwrap().slots[0].mute,
        "the helper parked it muted"
    );

    // A MOMENTARY button: down then straight back up is one press.
    press(&mut e, note);
    assert!(!e.decks_status("bank1").unwrap().slots[0].mute);

    // A TOGGLE template: the on is one press and the off, arriving a
    // finger-lift later than any finger lift, is the NEXT press — acting
    // only on the on is what used to make the user tap twice.
    e.decks_inject("bank1", [0x90, note, 127]).unwrap();
    assert!(e.decks_status("bank1").unwrap().slots[0].mute);
    std::thread::sleep(std::time::Duration::from_secs_f64(
        MOMENTARY_RELEASE_SECS + 0.05,
    ));
    e.decks_inject("bank1", [0x80, note, 0]).unwrap();
    assert!(
        !e.decks_status("bank1").unwrap().slots[0].mute,
        "the off is a press of its own, not a release"
    );
}

#[test]
fn the_surface_lamps_follow_mute_and_monitor() {
    let mut e = bank();
    load(&mut e, 1, 2);
    // A fresh bank owes the device every lamp: it forgets them when it is
    // unplugged, so nothing may be assumed about what is lit.
    let first = e.decks_drain_leds();
    assert_eq!(first.len(), SLOTS * 2, "both lamps of every slot");
    assert!(
        e.decks_drain_leds().is_empty(),
        "nothing changed, nothing to send"
    );

    e.decks_set_control("bank1", 1, SlotControl::Monitor, 1.0)
        .unwrap();
    let leds = e.decks_drain_leds();
    assert_eq!(leds.len(), 2, "only the slot that moved");
    let status = 0x90 | DEFAULT_SURFACE_CHANNEL;
    // The helper parked it muted, and it is now cued as well: red under
    // the fader, green beside it, on the channel the device last spoke on.
    assert_eq!(leds[0].data, [status, FOCUS_NOTES[1], led::RED]);
    assert_eq!(leds[1].data, [status, CONTROL_NOTES[1], led::GREEN]);

    e.decks_set_control("bank1", 1, SlotControl::Mute, 0.0)
        .unwrap();
    let leds = e.decks_drain_leds();
    assert_eq!(
        leds[0].data[2],
        led::OFF,
        "unmuted, so the mute lamp is out"
    );
    assert_eq!(leds[1].data[2], led::GREEN);

    // A bank that has stopped following the surface must not light it.
    e.set_param("bank1", "surface", 0.0).unwrap();
    e.decks_set_control("bank1", 1, SlotControl::Mute, 1.0)
        .unwrap();
    assert!(e.decks_drain_leds().is_empty());
}

/// A bank on its own in an empty patch — what the Decks tab's "add the
/// deck bank" gesture starts from when the rack is bare — started, like
/// [`bank`].
fn bare_bank() -> Engine {
    let mut e = Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap();
    e.add_module("bank1", DECKS_ID).unwrap();
    e.decks_set_running("bank1", true).unwrap();
    e
}

#[test]
fn a_bank_in_a_patch_with_no_output_is_given_one() {
    let mut e = bare_bank();
    assert_eq!(e.decks_loose_outputs("bank1").unwrap(), (true, true));
    e.decks_connect_outputs("bank1").unwrap();
    assert_eq!(e.decks_loose_outputs("bank1").unwrap(), (false, false));
    let kinds: Vec<&str> = e.nodes.iter().map(|n| n.ext_id.as_str()).collect();
    assert!(kinds.contains(&"builtin.audio_out"), "the room hears it");
    assert!(kinds.contains(&MONITOR_OUT_ID), "and so do the headphones");

    // The live pair is the one that used to go nowhere: play a clip and
    // it must reach the master bus, not just the cue.
    load(&mut e, 0, 2);
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    let live = e.render_offline(24_000).unwrap().remove(0);
    assert!(peak(&live[4_800..]) > 0.1, "a bank you can hear");
}

#[test]
fn wiring_a_bank_that_can_already_play_changes_nothing() {
    let mut e = bare_bank();
    e.decks_connect_outputs("bank1").unwrap();
    let (nodes, wires) = (e.nodes.iter().count(), e.wire_specs().len());
    e.decks_connect_outputs("bank1").unwrap();
    assert_eq!(
        (e.nodes.iter().count(), e.wire_specs().len()),
        (nodes, wires)
    );
}

#[test]
fn a_bank_the_user_has_routed_keeps_its_routing() {
    let mut e = bare_bank();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.connect("bank1", "audio_l", "vca1", "in").unwrap();
    assert_eq!(e.decks_loose_outputs("bank1").unwrap(), (false, true));
    e.decks_connect_outputs("bank1").unwrap();
    // The live pair still goes exactly where it was put, and only the cue
    // pair was given somewhere to go.
    let audio_l = e
        .wire_specs()
        .iter()
        .filter(|w| w.from_jack == 0)
        .collect::<Vec<_>>();
    assert_eq!(audio_l.len(), 1, "no second destination behind their back");
}

#[test]
fn a_monitored_deck_leaves_the_live_mix_for_the_monitor_one() {
    let mut e = bank();
    e.add_module("mon1", MONITOR_OUT_ID).unwrap();
    e.connect("bank1", "mon_l", "mon1", "l").unwrap();
    load(&mut e, 0, 2);
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();

    let live = e.render_offline(24_000).unwrap().remove(0);
    assert!(peak(&live) > 0.1, "it is in the live mix");

    e.decks_set_control("bank1", 0, SlotControl::Monitor, 1.0)
        .unwrap();
    let live = e.render_offline(24_000).unwrap().remove(0);
    assert!(
        peak(&live[4_800..]) < 1e-3,
        "cueing a deck takes it out of the room"
    );
    let monitor = e.render_offline_monitor(24_000).unwrap().remove(0);
    assert!(peak(&monitor[4_800..]) > 0.1, "and puts it in the cue");
}

#[test]
fn a_decks_insert_is_one_cable_each_way_and_its_wetness_says_how_much_is_heard() {
    let mut e = bank();
    // Deck 1 out to a VCA at half gain and back in: one send, one return.
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.connect("bank1", "d1_out", "vca1", "in").unwrap();
    e.connect("vca1", "out", "bank1", "d1_in").unwrap();
    e.set_knob_value("vca1", "cv", 5.0).unwrap();
    load(&mut e, 0, 2);
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    assert!(
        e.decks_status("bank1").unwrap().slots[0].insert,
        "a wired return is an insert"
    );

    // In engine volts: the clip's 0.5 leaves the deck as 5 V, and the VCA
    // at half gain hands back half of that.
    let wet = peak(&e.render_offline(24_000).unwrap().remove(0)[4_800..]);
    e.decks_set_control("bank1", 0, SlotControl::Wet, 0.0)
        .unwrap();
    let dry = peak(&e.render_offline(24_000).unwrap().remove(0)[4_800..]);
    assert!(
        (dry - 5.0).abs() < 0.05,
        "wetness 0 is the deck's own audio — the insert is bypassed ({dry})"
    );
    assert!(
        (wet - 2.5).abs() < 0.05,
        "and full wet is what the rack handed back ({wet})"
    );
}

#[test]
fn cueing_a_decks_insert_auditions_it_while_the_room_keeps_the_deck() {
    let mut e = bank();
    e.add_module("mon1", MONITOR_OUT_ID).unwrap();
    e.connect("bank1", "mon_l", "mon1", "l").unwrap();
    e.add_module("vca1", "com.dj.vca").unwrap();
    e.connect("bank1", "d1_out", "vca1", "in").unwrap();
    e.connect("vca1", "out", "bank1", "d1_in").unwrap();
    e.set_knob_value("vca1", "cv", 5.0).unwrap();
    load(&mut e, 0, 2);
    e.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    // Dry in the room, and the insert cued into the headphones.
    e.decks_set_control("bank1", 0, SlotControl::Wet, 0.0)
        .unwrap();
    e.decks_set_control("bank1", 0, SlotControl::InsertMonitor, 10.0)
        .unwrap();

    let live = peak(&e.render_offline(24_000).unwrap().remove(0)[4_800..]);
    let cue = peak(&e.render_offline_monitor(24_000).unwrap().remove(0)[4_800..]);
    assert!(
        (live - 5.0).abs() < 0.05,
        "the room carries on hearing the deck ({live})"
    );
    assert!(
        (cue - 2.5).abs() < 0.05,
        "and the monitor hears what the rack made of it ({cue})"
    );

    // Cue the deck itself as well: it leaves the room, and the monitor
    // hears the insert instead of its mix rather than both.
    e.decks_set_control("bank1", 0, SlotControl::Monitor, 10.0)
        .unwrap();
    let live = peak(&e.render_offline(24_000).unwrap().remove(0)[4_800..]);
    let cue = peak(&e.render_offline_monitor(24_000).unwrap().remove(0)[4_800..]);
    assert!(live < 1e-2, "a cued deck is not in the room ({live})");
    assert!(
        (cue - 2.5).abs() < 0.05,
        "the monitor hears the insert alone ({cue})"
    );
}

#[test]
fn each_output_pair_has_a_master_of_its_own() {
    let mut e = bank();
    e.add_module("mon1", MONITOR_OUT_ID).unwrap();
    e.connect("bank1", "mon_l", "mon1", "l").unwrap();
    // Two decks: one for the room, one cued into the headphones.
    load(&mut e, 0, 2);
    load(&mut e, 1, 2);
    for slot in [0, 1] {
        e.decks_set_control("bank1", slot, SlotControl::Mute, 0.0)
            .unwrap();
    }
    e.decks_set_control("bank1", 1, SlotControl::Monitor, 10.0)
        .unwrap();
    let full_live = peak(&e.render_offline(24_000).unwrap().remove(0)[4_800..]);
    let full_cue = peak(&e.render_offline_monitor(24_000).unwrap().remove(0)[4_800..]);
    assert!(full_live > 0.1 && full_cue > 0.1);

    // Half the room, and the cue untouched: a master is one pair's.
    e.decks_set_master("bank1", MasterBus::Live, 0.5).unwrap();
    let live = peak(&e.render_offline(24_000).unwrap().remove(0)[4_800..]);
    let cue = peak(&e.render_offline_monitor(24_000).unwrap().remove(0)[4_800..]);
    assert!(
        (live / full_live - 0.5).abs() < 0.02,
        "the live master halved the room ({live} of {full_live})"
    );
    assert!(
        (cue - full_cue).abs() < 1e-3,
        "and left the headphones where they were"
    );

    // And the other way round.
    e.decks_set_master("bank1", MasterBus::Monitor, 0.0)
        .unwrap();
    let cue = peak(&e.render_offline_monitor(24_000).unwrap().remove(0)[4_800..]);
    assert!(cue < 1e-3, "a closed cue master is silence in the phones");
    let live = peak(&e.render_offline(24_000).unwrap().remove(0)[4_800..]);
    assert!((live / full_live - 0.5).abs() < 0.02, "the room plays on");

    let st = e.decks_status("bank1").unwrap();
    assert_eq!((st.master_live, st.master_monitor), (0.5, 0.0));
}

#[test]
fn the_output_masters_round_trip_through_a_patch() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = bank();
    e.decks_set_master("bank1", MasterBus::Live, 0.7).unwrap();
    e.decks_set_master("bank1", MasterBus::Monitor, 0.25)
        .unwrap();
    e.save_patch(&dir.path().join("p"), "decks").unwrap();

    let mut e2 = Engine::load_patch(&dir.path().join("p"), crate::common::registry()).unwrap();
    let st = e2.decks_status("bank1").unwrap();
    assert_eq!((st.master_live, st.master_monitor), (0.7, 0.25));

    // And the restored bank SOUNDS at the level it was saved at — the
    // faders reach the RT thread on the way back in, not just the status.
    load(&mut e2, 0, 2);
    e2.decks_set_control("bank1", 0, SlotControl::Mute, 0.0)
        .unwrap();
    e2.decks_set_running("bank1", true).unwrap();
    let quiet = peak(&e2.render_offline(24_000).unwrap().remove(0)[4_800..]);
    e2.decks_set_master("bank1", MasterBus::Live, 1.0).unwrap();
    let loud = peak(&e2.render_offline(24_000).unwrap().remove(0)[4_800..]);
    assert!(
        (quiet / loud - 0.7).abs() < 0.02,
        "the saved master was what was playing ({quiet} of {loud})"
    );
}

#[test]
fn the_bank_pulses_its_clock_once_a_beat() {
    let mut e = bank();
    e.add_module("out2", "builtin.audio_out").unwrap();
    e.connect("bank1", "clock", "out2", "l").unwrap();
    // 120 BPM: half a second a beat, so one second is two pulses — count
    // the rising edges rather than the samples, the gate has width.
    let out = e.render_offline(48_000).unwrap().remove(0);
    let mut edges = 0;
    let mut high = false;
    for s in &out {
        let now = *s > 0.5;
        if now && !high {
            edges += 1;
        }
        high = now;
    }
    assert_eq!(edges, 2, "one pulse a beat at 120 BPM");
}

fn peak(xs: &[f32]) -> f32 {
    xs.iter().fold(0.0f32, |a, s| a.max(s.abs()))
}
