//! Beat Clip module (`builtin.beat_clip`) tests:
//! - silent until the first clock edge, and after a reset,
//! - the interval between the last two edges is the tempo (one clip beat
//!   per interval), so a clock at twice the clip's tempo plays it twice as
//!   fast and a changing clock is followed,
//! - every edge re-anchors the phase, so the clip's beat 0 lands ON a tick
//!   and never between two,
//! - the clip binding (not its audio) survives a patch save/load, and a
//!   reloaded node reports itself as waiting to be assembled.
//!
//! The clip under test is a RAMP: sample *i* is `i / frames * 0.5`, so the
//! rendered value says exactly where the playhead is ([`played_frame`]).

use dj_engine::beat_clip::{BeatClipRef, BEAT_CLIP_ID};
use dj_engine::playback::TrackData;
use dj_engine::{Engine, EngineConfig};

const SR: f32 = 48_000.0;
const BLOCK: usize = 128;
/// One beat is 23_040 frames = 180 blocks, so a clock edge driven from a
/// knob (which lands on a block boundary) can sit exactly on a beat.
const CLIP_BPM: f64 = 125.0;
const BEAT_FRAMES: usize = 23_040;
const CLIP_BEATS: usize = 4;
const CLIP_FRAMES: usize = BEAT_FRAMES * CLIP_BEATS;

fn mono_engine() -> Engine {
    Engine::new(
        EngineConfig {
            master_channels: 1,
            ..EngineConfig::default()
        },
        crate::common::registry(),
    )
    .unwrap()
}

/// The clip: a ramp, so every rendered sample names its own source frame.
fn ramp_clip() -> TrackData {
    TrackData {
        channels: vec![(0..CLIP_FRAMES)
            .map(|i| i as f32 / CLIP_FRAMES as f32 * 0.5)
            .collect()],
        sample_rate: SR,
    }
}

/// Which clip frame a rendered sample came from (engine units are ±10 V,
/// the ramp spans 0..0.5 of the file).
fn played_frame(sample: f32) -> f64 {
    sample as f64 / 10.0 / 0.5 * CLIP_FRAMES as f64
}

/// Beat Clip -> Audio Out, loaded with the ramp at its own tempo.
fn beat_clip_engine() -> Engine {
    let mut e = mono_engine();
    e.add_module("bc1", BEAT_CLIP_ID).unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("bc1", "audio_l", "out1", "l").unwrap();
    e.beat_clip_load("bc1", None, ramp_clip(), CLIP_BPM)
        .unwrap();
    e
}

/// A clock edge on `jack` (a block high, then `low_blocks` blocks low),
/// returning everything rendered.
fn pulse(e: &mut Engine, jack: &str, low_blocks: usize) -> Vec<f32> {
    e.set_knob_position("bc1", jack, 1.0).unwrap();
    let mut out = e.render_offline(BLOCK).unwrap().remove(0);
    e.set_knob_position("bc1", jack, 0.0).unwrap();
    out.extend(e.render_offline(BLOCK * low_blocks).unwrap().remove(0));
    out
}

/// One clock beat, `blocks` blocks long (180 = the clip's own tempo).
fn tick(e: &mut Engine, blocks: usize) -> Vec<f32> {
    pulse(e, "clock", blocks - 1)
}

#[test]
fn beat_clip_is_listed_in_all_manifests() {
    let ids: Vec<String> = crate::common::registry()
        .all_manifests()
        .iter()
        .map(|m| m.id.clone())
        .collect();
    assert!(
        ids.contains(&BEAT_CLIP_ID.to_string()),
        "{BEAT_CLIP_ID} missing from module list: {ids:?}"
    );
}

#[test]
fn silent_until_the_first_clock_edge() {
    let mut e = beat_clip_engine();
    let quiet = e.render_offline(BLOCK * 10).unwrap().remove(0);
    assert!(
        quiet.iter().all(|s| *s == 0.0),
        "a clip with no clock must not play"
    );

    let played = tick(&mut e, 4);
    assert!(
        played.iter().any(|s| *s != 0.0),
        "the first clock edge starts the clip"
    );
    let status = e.beat_clip_status("bc1").unwrap();
    assert_eq!(status.beats, CLIP_BEATS);
    assert_eq!(status.beat, 0, "the first edge plays beat 0");
    assert!(status.playing);
}

#[test]
fn the_clock_sets_the_tempo() {
    // Ticks twice as fast as the clip was rendered: one clip beat has to
    // fit in half the time, so the audio runs at 2x.
    let mut e = beat_clip_engine();
    tick(&mut e, 90);
    tick(&mut e, 90);
    let third = tick(&mut e, 90);

    let span = 1000;
    let rate = (played_frame(third[span]) - played_frame(third[0])) / span as f64;
    assert!(
        (rate - 2.0).abs() < 0.02,
        "a double-speed clock should play the clip at 2x, got {rate}"
    );
    let bpm = e.beat_clip_status("bc1").unwrap().clock_bpm;
    assert!(
        (bpm - 2.0 * CLIP_BPM).abs() < 1.0,
        "the clock's own tempo should read back as 250 BPM, got {bpm}"
    );

    // Halving the clock rate halves the playback rate: the tempo is the
    // last two edges, not the first two.
    tick(&mut e, 180);
    let slow = tick(&mut e, 180);
    let rate = (played_frame(slow[span]) - played_frame(slow[0])) / span as f64;
    assert!(
        (rate - 1.0).abs() < 0.02,
        "back at the clip's own tempo the rate is 1x, got {rate}"
    );
}

#[test]
fn every_edge_re_anchors_the_phase() {
    let mut e = beat_clip_engine();
    // Deliberately uneven: the fourth beat is short, so a free-running
    // playhead would drift off the grid. Phase belongs to the clock.
    for (beat, blocks) in [(0usize, 180usize), (1, 180), (2, 150), (3, 180)] {
        let out = tick(&mut e, blocks);
        let at = played_frame(out[0]);
        let want = (beat * BEAT_FRAMES) as f64;
        assert!(
            (at - want).abs() < 8.0,
            "beat {beat} should start at clip frame {want}, started at {at}"
        );
    }
    // Past the last beat the clip comes back around — on the tick.
    let wrapped = tick(&mut e, 180);
    assert!(
        played_frame(wrapped[0]) < 8.0,
        "the clip restarts at frame 0 on the tick after its last beat"
    );
    assert_eq!(e.beat_clip_status("bc1").unwrap().beat, 0);
}

#[test]
fn reset_parks_at_beat_zero_until_the_next_clock() {
    let mut e = beat_clip_engine();
    tick(&mut e, 180);
    tick(&mut e, 180);

    let after_reset = pulse(&mut e, "reset", 20);
    assert!(
        after_reset.iter().all(|s| *s == 0.0),
        "reset silences the clip rather than restarting it between ticks"
    );
    let status = e.beat_clip_status("bc1").unwrap();
    assert_eq!(status.beat, -1, "a reset module is waiting for a clock");
    assert_eq!(status.position_secs, 0.0, "phase is back at 0");

    let restarted = tick(&mut e, 180);
    assert!(
        played_frame(restarted[0]) < 8.0,
        "the next clock plays beat 0, from the top of the clip"
    );
}

#[test]
fn the_clip_binding_survives_a_patch_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("patch");
    let clip = BeatClipRef {
        project: "p2".into(),
        clip: "7".into(),
        name: "chorus stack".into(),
    };

    let mut e = beat_clip_engine();
    e.beat_clip_load("bc1", Some(clip.clone()), ramp_clip(), CLIP_BPM)
        .unwrap();
    assert!(
        e.beat_clip_pending().is_empty(),
        "a node playing its clip is not waiting for anything"
    );
    e.save_patch(&dir, "beat-clip").unwrap();

    let loaded = Engine::load_patch(&dir, crate::common::registry()).unwrap();
    let status = loaded.beat_clip_status("bc1").unwrap();
    assert_eq!(status.clip.as_ref(), Some(&clip));
    assert_eq!(status.bpm, CLIP_BPM, "the clip's tempo rides in its knobs");
    assert_eq!(
        loaded.beat_clip_pending(),
        vec![("bc1".to_string(), clip)],
        "a reloaded clip has no audio yet — the app layer assembles it"
    );
    assert_eq!(
        status.duration_secs, 0.0,
        "the patch carries the binding, never the audio"
    );
}
