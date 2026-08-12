//! The Hands module in the engine graph: camera-panel landmark frames in,
//! held CV out. Values cross the SPSC ring and land at wired inputs;
//! visibility changes are debounced (one bad frame = no thrash); a
//! confirmed-vanished hand decays its values to 0 V over DECAY_SECONDS
//! while the seen gate falls; the node round-trips through the patch
//! directory format.

use dj_engine::hands::{jack, HandsDetection, DEBOUNCE_FRAMES, N_HANDS_JACKS, N_LANDMARKS};
use dj_engine::Engine;

/// Feed the same detection enough consecutive frames to clear the
/// visibility debounce, then let the ramps (if any) finish.
fn feed_confirmed(engine: &mut Engine, det: &HandsDetection) {
    for _ in 0..DEBOUNCE_FRAMES {
        engine
            .hands_feed("hands1", engine.current_frame(), Some(det))
            .unwrap();
        engine.process_blocks(2).unwrap();
    }
    // DECAY_SECONDS (10 ms) at 48 kHz / 128 is ~3.75 blocks; give
    // in-flight ramps room to complete.
    engine.process_blocks(6).unwrap();
}

/// A synthetic hand: all landmarks near (x, y), with the thumb/index/
/// palm landmarks placed for a mid pinch and neutral thumb.
fn hand_at(x: f32, y: f32) -> [[f32; 3]; N_LANDMARKS] {
    let mut pts = [[0.0f32; 3]; N_LANDMARKS];
    for (i, p) in pts.iter_mut().enumerate() {
        *p = [x + 0.005 * i as f32, y + 0.005 * i as f32, 0.0];
    }
    pts[0] = [x, y, 0.0]; // wrist
    pts[9] = [x, y + 0.3, 0.0]; // middle MCP
    pts[2] = [x, y + 0.1, 0.0]; // thumb MCP
    pts[4] = [x + 0.1, y + 0.15, 0.0]; // thumb tip
    pts[8] = [x + 0.2, y + 0.15, 0.0]; // index tip
    pts
}

fn both_hands(lx: f32, rx: f32) -> HandsDetection {
    HandsDetection {
        left: Some(hand_at(lx, 0.0)),
        right: Some(hand_at(rx, 0.0)),
    }
}

/// Wire every output jack to its own scope's plain `in` jack (additive
/// wire law, no knob position clamp — hands CV is bipolar) so values are
/// observable in the graph via telemetry.
fn rigged_engine() -> (Engine, Vec<(String, String)>) {
    let mut engine = crate::common::default_engine();
    engine.add_module("hands1", "builtin.hands").unwrap();
    let manifest = dj_engine::hands::hands_manifest();
    let mut taps = Vec::new();
    for out in &manifest.outputs {
        let scope = format!("scope_{}", out.id);
        engine.add_module(&scope, "com.dj.scope").unwrap();
        engine.connect("hands1", &out.id, &scope, "in").unwrap();
        taps.push((out.id.clone(), scope));
    }
    (engine, taps)
}

fn read(engine: &Engine, taps: &[(String, String)], jack: usize) -> f32 {
    engine.tap(&taps[jack].1, "in").unwrap().instantaneous
}

#[test]
fn detections_land_as_cv_at_wired_inputs() {
    let (mut engine, taps) = rigged_engine();
    feed_confirmed(&mut engine, &both_hands(-0.5, 0.5));

    let lx = read(&engine, &taps, jack::LX);
    let rx = read(&engine, &taps, jack::RX);
    assert!(
        lx < -1.0,
        "left hand at x=-0.5 must read negative volts: {lx}"
    );
    assert!(
        rx > 1.0,
        "right hand at x=0.5 must read positive volts: {rx}"
    );
    // dx = right - left, positive here; centroid between them.
    assert!(read(&engine, &taps, jack::DX) > 3.0);
    let cx = read(&engine, &taps, jack::CX);
    assert!(
        (cx - (lx + rx) / 2.0).abs() < 0.1,
        "cx {cx} vs mean of {lx},{rx}"
    );
    assert_eq!(read(&engine, &taps, jack::L_SEEN), 10.0);
    assert_eq!(read(&engine, &taps, jack::R_SEEN), 10.0);
    assert!(read(&engine, &taps, jack::L_PINCH) > 0.0);
}

#[test]
fn vanished_hand_decays_values_and_drops_gate() {
    let (mut engine, taps) = rigged_engine();
    feed_confirmed(&mut engine, &both_hands(-0.5, 0.5));
    assert!(read(&engine, &taps, jack::LX) < -1.0);
    assert!(read(&engine, &taps, jack::L_PINCH) > 0.0);

    // Left hand leaves the frame (confirmed); right hand moves.
    let det = HandsDetection {
        left: None,
        right: Some(hand_at(0.8, 0.2)),
    };
    feed_confirmed(&mut engine, &det);

    // Left values decayed to 0 V; the gate fell; right keeps tracking.
    assert_eq!(read(&engine, &taps, jack::LX), 0.0);
    assert_eq!(read(&engine, &taps, jack::L_PINCH), 0.0);
    assert_eq!(read(&engine, &taps, jack::L_SEEN), 0.0);
    assert_eq!(read(&engine, &taps, jack::R_SEEN), 10.0);
    assert!(read(&engine, &taps, jack::RX) > 3.5);
    // The combined centroid still follows the remaining hand.
    assert!(read(&engine, &taps, jack::CX) > 3.5);

    // A dropped frame (None) changes nothing at all.
    let before: Vec<f32> = (0..N_HANDS_JACKS)
        .map(|j| read(&engine, &taps, j))
        .collect();
    engine
        .hands_feed("hands1", engine.current_frame(), None)
        .unwrap();
    engine.process_blocks(2).unwrap();
    let after: Vec<f32> = (0..N_HANDS_JACKS)
        .map(|j| read(&engine, &taps, j))
        .collect();
    assert_eq!(before, after);
}

#[test]
fn single_glitch_frame_does_not_thrash_outputs() {
    let (mut engine, taps) = rigged_engine();
    feed_confirmed(&mut engine, &both_hands(-0.5, 0.5));
    let lx = read(&engine, &taps, jack::LX);

    // One bad frame: the left hand misdetected as gone (e.g. its
    // landmarks momentarily labelled right). Debounce absorbs it.
    let glitch = HandsDetection {
        left: None,
        right: Some(hand_at(0.5, 0.0)),
    };
    engine
        .hands_feed("hands1", engine.current_frame(), Some(&glitch))
        .unwrap();
    engine.process_blocks(6).unwrap();
    assert_eq!(read(&engine, &taps, jack::LX), lx, "glitch frame must hold");
    assert_eq!(read(&engine, &taps, jack::L_SEEN), 10.0);

    // Tracking resumes as if nothing happened.
    engine
        .hands_feed(
            "hands1",
            engine.current_frame(),
            Some(&both_hands(-0.5, 0.5)),
        )
        .unwrap();
    engine.process_blocks(2).unwrap();
    assert_eq!(read(&engine, &taps, jack::LX), lx);
}

#[test]
fn hand_loss_decays_over_10ms_not_instantly() {
    let (mut engine, taps) = rigged_engine();
    feed_confirmed(&mut engine, &both_hands(-0.5, 0.5));
    let lx = read(&engine, &taps, jack::LX);
    assert!(lx < -1.0);

    // Confirm the loss (DEBOUNCE_FRAMES gone frames), processing only
    // one block per feed so the ramp is still in flight afterwards.
    let gone = HandsDetection::default();
    for _ in 0..DEBOUNCE_FRAMES {
        engine
            .hands_feed("hands1", engine.current_frame(), Some(&gone))
            .unwrap();
        engine.process_blocks(1).unwrap();
    }
    // One block (128/48k ~ 2.7 ms) into the 10 ms ramp: partway down.
    let mid = read(&engine, &taps, jack::LX);
    assert!(
        mid > lx && mid < 0.0,
        "must be mid-decay: {mid} (from {lx})"
    );

    // After the full ramp: exactly zero.
    engine.process_blocks(6).unwrap();
    assert_eq!(read(&engine, &taps, jack::LX), 0.0);
    assert_eq!(read(&engine, &taps, jack::CX), 0.0);
    assert_eq!(read(&engine, &taps, jack::DX), 0.0);
}

#[test]
fn hands_node_round_trips_through_patch() {
    let dir = tempfile::tempdir().unwrap();
    let mut engine = crate::common::default_engine();
    engine.add_module("hands1", "builtin.hands").unwrap();
    engine.add_module("scope1", "com.dj.scope").unwrap();
    engine.connect("hands1", "l_pinch", "scope1", "in").unwrap();
    engine.save_patch(dir.path(), "hands-rt").unwrap();

    let mut loaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    // The node exists with its fixed jack set, wire intact, and the feed
    // path is live.
    for _ in 0..DEBOUNCE_FRAMES {
        loaded
            .hands_feed(
                "hands1",
                loaded.current_frame(),
                Some(&both_hands(-0.3, 0.3)),
            )
            .unwrap();
        loaded.process_blocks(2).unwrap();
    }
    assert!(loaded.tap("scope1", "in").unwrap().instantaneous > 0.0);
}

/// Regression: a Hands module added mid-session must apply feeds
/// immediately. Events are stamped with the GLOBAL engine frame clock;
/// if the RT module's local clock starts at 0 instead of the engine's
/// current frame, every event lands "in the future" and the outputs
/// freeze (then jump as the local clock crawls past stale timestamps).
#[test]
fn module_added_mid_session_applies_feeds_immediately() {
    let mut engine = crate::common::default_engine();
    // Let the engine run a while before the module exists.
    engine.process_blocks(500).unwrap();

    engine.add_module("hands1", "builtin.hands").unwrap();
    engine.add_module("scope1", "com.dj.scope").unwrap();
    engine.connect("hands1", "rx", "scope1", "in").unwrap();

    // DEBOUNCE_FRAMES feeds to confirm the hand, one block each — the
    // point is that events stamped "now" apply promptly, not after an
    // engine-age lag.
    for _ in 0..DEBOUNCE_FRAMES {
        engine
            .hands_feed(
                "hands1",
                engine.current_frame(),
                Some(&both_hands(-0.5, 0.5)),
            )
            .unwrap();
        engine.process_blocks(1).unwrap();
    }
    let rx = engine.tap("scope1", "in").unwrap().instantaneous;
    assert!(
        rx > 1.0,
        "feed stamped 'now' must apply within a block: {rx}"
    );
}

#[test]
fn feed_rejects_non_hands_instances() {
    let mut engine = crate::common::default_engine();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    assert!(engine
        .hands_feed("vca1", 0, Some(&HandsDetection::default()))
        .is_err());
    assert!(engine.hands_feed("nope", 0, None).is_err());
}
