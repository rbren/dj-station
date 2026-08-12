//! The Hands module in the engine graph: camera-panel landmark frames in,
//! held CV out. Values cross the SPSC ring and land at wired inputs; a
//! vanished hand holds its last value while the seen gate falls; the node
//! round-trips through the patch directory format.

use dj_engine::hands::{jack, HandsDetection, N_HANDS_JACKS, N_LANDMARKS};
use dj_engine::Engine;

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
    engine
        .hands_feed("hands1", 0, Some(&both_hands(-0.5, 0.5)))
        .unwrap();
    engine.process_blocks(2).unwrap();

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
fn vanished_hand_holds_values_and_drops_gate() {
    let (mut engine, taps) = rigged_engine();
    engine
        .hands_feed("hands1", 0, Some(&both_hands(-0.5, 0.5)))
        .unwrap();
    engine.process_blocks(2).unwrap();
    let held_lx = read(&engine, &taps, jack::LX);
    let held_pinch = read(&engine, &taps, jack::L_PINCH);

    // Left hand leaves the frame; right hand moves.
    let det = HandsDetection {
        left: None,
        right: Some(hand_at(0.8, 0.2)),
    };
    engine.hands_feed("hands1", 0, Some(&det)).unwrap();
    engine.process_blocks(2).unwrap();

    // Left values hold; the gate falls; right keeps tracking.
    assert_eq!(read(&engine, &taps, jack::LX), held_lx);
    assert_eq!(read(&engine, &taps, jack::L_PINCH), held_pinch);
    assert_eq!(read(&engine, &taps, jack::L_SEEN), 0.0);
    assert_eq!(read(&engine, &taps, jack::R_SEEN), 10.0);
    assert!(read(&engine, &taps, jack::RX) > 3.5);

    // A dropped frame (None) changes nothing at all.
    let before: Vec<f32> = (0..N_HANDS_JACKS)
        .map(|j| read(&engine, &taps, j))
        .collect();
    engine.hands_feed("hands1", 0, None).unwrap();
    engine.process_blocks(2).unwrap();
    let after: Vec<f32> = (0..N_HANDS_JACKS)
        .map(|j| read(&engine, &taps, j))
        .collect();
    assert_eq!(before, after);
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
    loaded
        .hands_feed("hands1", 0, Some(&both_hands(-0.3, 0.3)))
        .unwrap();
    loaded.process_blocks(2).unwrap();
    assert!(loaded.tap("scope1", "in").unwrap().instantaneous > 0.0);
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
