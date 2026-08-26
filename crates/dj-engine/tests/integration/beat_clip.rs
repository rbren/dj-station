//! Beat Clip module (`builtin.beat_clip`) tests:
//! - silent until TWO clock edges have measured a tempo (one edge is a
//!   phase, not a speed), and after a reset,
//! - the interval between the last two edges is the tempo (one clip beat
//!   per interval), so a clock at twice the clip's tempo plays it twice as
//!   fast and a changing clock is followed,
//! - that speed change is a STRETCH: the pitch does not move with it,
//! - every edge re-anchors the phase, so the clip's beat 0 lands ON a tick
//!   and never between two,
//! - the clip binding (not its audio) survives a patch save/load, and a
//!   reloaded node reports itself as waiting to be assembled,
//! - copying a module copies the clip it is playing.
//!
//! The clip under test is a RAMP: sample *i* is `i / frames * 0.5`, so the
//! rendered value says where the playhead is ([`played_frame`]) — read as
//! the grain-weighted average of the voices in flight, which is why
//! position assertions carry a grain of tolerance ([`SMEAR`]). The pitch
//! test uses a tone instead.

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
/// How far a position read out of stretched audio may sit from the virtual
/// playhead: grains are up to 40 ms long and WSOLA-aligned within ±4 ms of
/// it (`dj_engine::stretch`), and a ramp biases that search towards its
/// loud end. A twentieth of a beat — nowhere near enough to confuse one
/// beat of the clip with another, which is what these tests are about.
const SMEAR: f64 = 0.05 * BEAT_FRAMES as f64;

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

/// A clip that is one steady tone, for asking what the stretch did to the
/// pitch.
fn tone_clip(hz: f64) -> TrackData {
    TrackData {
        channels: vec![(0..CLIP_FRAMES)
            .map(|i| (2.0 * std::f64::consts::PI * hz * i as f64 / SR as f64).sin() as f32 * 0.5)
            .collect()],
        sample_rate: SR,
    }
}

/// Which clip frame a rendered sample came from (engine units are ±10 V,
/// the ramp spans 0..0.5 of the file).
fn played_frame(sample: f32) -> f64 {
    sample as f64 / 10.0 / 0.5 * CLIP_FRAMES as f64
}

fn zero_crossing_hz(signal: &[f32]) -> f64 {
    let crossings = signal
        .windows(2)
        .filter(|w| (w[0] >= 0.0) != (w[1] >= 0.0))
        .count();
    crossings as f64 / 2.0 / (signal.len() as f64 / SR as f64)
}

/// Beat Clip -> Audio Out, loaded with `clip` at the clip's own tempo.
fn engine_with(clip: TrackData) -> Engine {
    let mut e = mono_engine();
    e.add_module("bc1", BEAT_CLIP_ID).unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("bc1", "audio_l", "out1", "l").unwrap();
    e.beat_clip_load("bc1", None, clip, CLIP_BPM).unwrap();
    e
}

fn beat_clip_engine() -> Engine {
    engine_with(ramp_clip())
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

/// The pair of beats that tells the module how fast to play: everything
/// from the second edge on is audible.
fn start(e: &mut Engine, blocks: usize) {
    tick(e, blocks);
    tick(e, blocks);
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
fn silent_until_two_clock_edges_measure_the_tempo() {
    let mut e = beat_clip_engine();
    let quiet = e.render_offline(BLOCK * 10).unwrap().remove(0);
    assert!(
        quiet.iter().all(|s| *s == 0.0),
        "a clip with no clock must not play"
    );

    // One edge is a phase, not yet a speed: still nothing to play.
    let first = tick(&mut e, 180);
    assert!(
        first.iter().all(|s| *s == 0.0),
        "one clock edge does not say how fast the clip should run"
    );
    let status = e.beat_clip_status("bc1").unwrap();
    assert_eq!(status.beat, -1, "still waiting for a tempo");
    assert_eq!(status.clock_bpm, 0.0);
    assert!(!status.playing);

    // The second edge measures the beat — and is beat 0 of the clip.
    let second = tick(&mut e, 180);
    assert!(
        second.iter().any(|s| *s != 0.0),
        "the second clock edge starts the clip"
    );
    let status = e.beat_clip_status("bc1").unwrap();
    assert_eq!(status.beats, CLIP_BEATS);
    assert_eq!(status.beat, 0, "the clip starts at beat 0");
    assert!((status.clock_bpm - CLIP_BPM).abs() < 1.0);
    assert!(status.playing);
}

#[test]
fn the_clock_sets_the_tempo() {
    // Ticks twice as fast as the clip was rendered: one clip beat has to
    // fit in half the time, so the audio runs at 2x.
    let mut e = beat_clip_engine();
    start(&mut e, 90);
    let third = tick(&mut e, 90);

    // Measured across several grains: within one the clip is read at its
    // own rate, and the stretch lands on the grain boundaries.
    let (from, to) = (1_000, 9_000);
    let rate = (played_frame(third[to]) - played_frame(third[from])) / (to - from) as f64;
    assert!(
        (rate - 2.0).abs() < 0.05,
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
    let rate = (played_frame(slow[to]) - played_frame(slow[from])) / (to - from) as f64;
    assert!(
        (rate - 1.0).abs() < 0.05,
        "back at the clip's own tempo the rate is 1x, got {rate}"
    );
}

#[test]
fn stretching_the_clip_holds_its_pitch() {
    // The tempo change is a stretch, not a speed-up: a 440 Hz clip still
    // sounds 440 Hz whether the clock runs it at double or half speed.
    // ±10 cents around 440 Hz ~ ±2.55 Hz — the deck's keylock tolerance.
    let cents_10 = 440.0 * (2f64.powf(10.0 / 1200.0) - 1.0);
    for (blocks, factor) in [(90usize, 2.0f64), (360, 0.5)] {
        let mut e = engine_with(tone_clip(440.0));
        start(&mut e, blocks);
        let played = tick(&mut e, blocks);
        // Past the grain the beat edge lands in, over whole hops.
        let hz = zero_crossing_hz(&played[2_000..10_000]);
        assert!(
            (hz - 440.0).abs() <= cents_10,
            "at {factor}x the clip should still sound 440 Hz, measured {hz:.2}"
        );
    }
}

#[test]
fn every_edge_re_anchors_the_phase() {
    let mut e = beat_clip_engine();
    start(&mut e, 180);
    // Deliberately uneven: the third beat is short, so a free-running
    // playhead would drift off the grid. Phase belongs to the clock.
    for (beat, blocks) in [(1usize, 180usize), (2, 150), (3, 180)] {
        let out = tick(&mut e, blocks);
        // Read a little way in, past the crossfade that carries the
        // previous grain over the edge, and subtract that much again.
        let at = played_frame(out[4_000]) - 4_000.0;
        let want = (beat * BEAT_FRAMES) as f64;
        assert!(
            (at - want).abs() < SMEAR,
            "beat {beat} should start at clip frame {want}, started at {at}"
        );
        assert_eq!(e.beat_clip_status("bc1").unwrap().beat, beat as i64);
    }
    // Past the last beat the clip comes back around — on the tick.
    let wrapped = tick(&mut e, 180);
    let at = played_frame(wrapped[4_000]) - 4_000.0;
    assert!(
        at.abs() < SMEAR,
        "the clip restarts at frame 0 on the tick after its last beat, at {at}"
    );
    assert_eq!(e.beat_clip_status("bc1").unwrap().beat, 0);
}

#[test]
fn reset_parks_at_beat_zero_until_the_next_clock() {
    let mut e = beat_clip_engine();
    start(&mut e, 180);
    tick(&mut e, 180);

    let after_reset = pulse(&mut e, "reset", 20);
    assert!(
        after_reset.iter().all(|s| *s == 0.0),
        "reset silences the clip rather than restarting it between ticks"
    );
    let status = e.beat_clip_status("bc1").unwrap();
    assert_eq!(status.beat, -1, "a reset module is waiting for a clock");
    assert_eq!(status.position_secs, 0.0, "phase is back at 0");

    // The tempo is still known, so ONE edge restarts it: a reset moves the
    // phase, it does not make the module re-learn the clock.
    let restarted = tick(&mut e, 180);
    let at = played_frame(restarted[4_000]) - 4_000.0;
    assert!(
        at.abs() < SMEAR,
        "the next clock plays beat 0, from the top of the clip, at {at}"
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
        stems: vec!["drums".into(), "bass".into()],
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

#[test]
fn a_copy_plays_the_same_clip_as_its_source() {
    // What copy/paste rides on: the new module is handed the assembled
    // audio, the binding and the tempo, with nothing to re-render.
    let clip = BeatClipRef {
        project: "p2".into(),
        clip: "7".into(),
        name: "chorus stack".into(),
        stems: vec!["drums".into(), "bass".into()],
    };
    let mut e = beat_clip_engine();
    e.beat_clip_load("bc1", Some(clip.clone()), ramp_clip(), CLIP_BPM)
        .unwrap();
    e.add_module("bc2", BEAT_CLIP_ID).unwrap();
    e.connect("bc2", "audio_l", "out1", "l").unwrap();

    assert!(e.beat_clip_copy("bc1", "bc2").unwrap());
    let status = e.beat_clip_status("bc2").unwrap();
    assert_eq!(status.clip.as_ref(), Some(&clip));
    assert_eq!(status.bpm, CLIP_BPM);
    assert_eq!(status.beats, CLIP_BEATS);
    assert!(
        e.beat_clip_pending().is_empty(),
        "a copy has its audio already; there is nothing to assemble"
    );

    // And it plays: the copy is a working module, not just metadata.
    for _ in 0..2 {
        e.set_knob_position("bc2", "clock", 1.0).unwrap();
        e.render_offline(BLOCK).unwrap();
        e.set_knob_position("bc2", "clock", 0.0).unwrap();
        e.render_offline(BLOCK * 179).unwrap();
    }
    let played = e.render_offline(BLOCK * 40).unwrap().remove(0);
    assert!(
        played.iter().any(|s| *s != 0.0),
        "the copied module should play the clip it was handed"
    );

    // A source with no audio (a patch just loaded) has nothing to hand
    // on, and says so: the copy is left to the app layer's assembly.
    let mut fresh = mono_engine();
    fresh.add_module("a", BEAT_CLIP_ID).unwrap();
    fresh.add_module("b", BEAT_CLIP_ID).unwrap();
    fresh.beat_clip_bind("a", Some(clip.clone())).unwrap();
    fresh.beat_clip_bind("b", Some(clip)).unwrap();
    assert!(!fresh.beat_clip_copy("a", "b").unwrap());
    assert_eq!(
        fresh.beat_clip_pending().len(),
        2,
        "both ends then wait for the app layer to assemble the clip"
    );
}
