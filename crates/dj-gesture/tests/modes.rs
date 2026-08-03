//! Mode-system tests at the processor level: wheel zones, landmark
//! presence/distance semantics, frame-drop behavior, learn flow, and the
//! extensible-registry criterion (stub third mode, zero core changes).
//! Graph-level equivalents live in dj-engine/tests/gesture.rs.

use dj_gesture::{
    fixtures, Detection, GestureMode, GestureProcessor, HandDetector, MappingDef, MappingEval,
    MarkerDetector, ModeCtx, Point, TraceFrameSource, WheelLayout, GATE_HIGH, ZONES_PER_WHEEL,
};

fn wheel_mapping(name: &str, wheel: usize, zone: usize) -> MappingDef {
    MappingDef {
        name: name.into(),
        mode: "wheel".into(),
        config: serde_json::json!({ "wheel": wheel, "zone": zone }),
    }
}

fn run_frame(p: &mut GestureProcessor, det: Option<&Detection>, dt: f32) -> Vec<(usize, f32)> {
    let mut events = Vec::new();
    p.process(det, dt, |jack, value| events.push((jack, value)));
    events
}

/// All 18 zones mapped; the wheel-tour fixture (full pipeline: synthetic
/// frames -> detector) toggles exactly the visited zone's gate and no
/// others.
#[test]
fn wheel_tour_toggles_exactly_one_zone() {
    let layout = WheelLayout::default();
    let mut p = GestureProcessor::default();
    let mut jacks = Vec::new(); // (wheel, zone) -> jack
    for wheel in 0..2 {
        for zone in 0..ZONES_PER_WHEEL {
            let def = wheel_mapping(&format!("w{wheel}z{zone}"), wheel, zone);
            jacks.push(p.add_mapping(def).unwrap());
        }
    }
    let trace = fixtures::wheel_tour_trace(30.0, &layout, 2);
    let mut det = MarkerDetector;
    let dt = 1.0 / 30.0;
    // The tour visits (wheel, zone) in order, `dwell` frames each plus one
    // empty frame; on dwell frames exactly the visited gate is high.
    let mut frame_idx = 0usize;
    for wheel in 0..2 {
        for zone in 0..ZONES_PER_WHEEL {
            for _ in 0..2 {
                let frame = TraceFrameSource::render(&trace, frame_idx).unwrap();
                run_frame(&mut p, Some(&det.detect(&frame).unwrap()), dt);
                frame_idx += 1;
                for (i, jack) in jacks.iter().enumerate() {
                    let expect = if i == wheel * ZONES_PER_WHEEL + zone {
                        GATE_HIGH
                    } else {
                        0.0
                    };
                    assert_eq!(
                        p.value(*jack),
                        expect,
                        "hand in w{wheel}z{zone}: mapping {i} wrong"
                    );
                }
            }
            // The separator frame is a *valid* detection with no hands in
            // any zone: everything drops low immediately.
            let frame = TraceFrameSource::render(&trace, frame_idx).unwrap();
            run_frame(&mut p, Some(&det.detect(&frame).unwrap()), dt);
            frame_idx += 1;
            for jack in &jacks {
                assert_eq!(p.value(*jack), 0.0);
            }
        }
    }
    assert_eq!(frame_idx, trace.frames.len());
}

/// Presence gate: 10 while the point is detected; holds through missing
/// detections and decays to 0 once the configured timeout elapses.
#[test]
fn presence_gate_decays_after_timeout() {
    let mut p = GestureProcessor::default();
    let jack = p
        .add_mapping(MappingDef {
            name: "idx".into(),
            mode: "landmark".into(),
            config: serde_json::json!({ "type": "presence", "point": "L.index.tip", "timeout": 0.1 }),
        })
        .unwrap();
    let dt = 1.0 / 30.0;
    let with_hand = Detection {
        hands: vec![trace_hand_to_hand(&fixtures::synth_hand_at(
            'L',
            Point { x: 0.5, y: 0.5 },
            0.02,
        ))],
    };
    run_frame(&mut p, Some(&with_hand), dt);
    assert_eq!(p.value(jack), GATE_HIGH);

    // Dropped frames within the timeout hold the gate...
    run_frame(&mut p, None, dt);
    run_frame(&mut p, None, dt);
    assert_eq!(p.value(jack), GATE_HIGH, "gate must hold before timeout");
    // ...and it decays once 0.1 s have accumulated.
    run_frame(&mut p, None, dt);
    assert_eq!(p.value(jack), 0.0, "gate must decay after timeout");

    // Re-detection brings it straight back.
    run_frame(&mut p, Some(&with_hand), dt);
    assert_eq!(p.value(jack), GATE_HIGH);

    // A valid detection *without* the point behaves like a drop: hold,
    // then decay.
    let empty = Detection::default();
    run_frame(&mut p, Some(&empty), dt);
    assert_eq!(p.value(jack), GATE_HIGH);
    run_frame(&mut p, Some(&empty), dt);
    run_frame(&mut p, Some(&empty), dt);
    assert_eq!(p.value(jack), 0.0);
}

fn trace_hand_to_hand(th: &dj_gesture::TraceHand) -> dj_gesture::Hand {
    let mut points = [Point { x: 0.0, y: 0.0 }; dj_gesture::N_LANDMARKS];
    for (p, src) in points.iter_mut().zip(&th.points) {
        *p = Point {
            x: src[0],
            y: src[1],
        };
    }
    dj_gesture::Hand {
        handedness: dj_gesture::Handedness::from_letter(th.hand.chars().next().unwrap()).unwrap(),
        points,
    }
}

/// Distance mapping tracks the scripted pinch fixture monotonically
/// (through the full frame pipeline), normalized into 0..1 (jack value
/// 0..10) and smoothed; missing frames hold the last value.
#[test]
fn pinch_distance_is_monotonic_normalized_and_holds() {
    let mut p = GestureProcessor::default();
    let jack = p
        .add_mapping(MappingDef {
            name: "pinch".into(),
            mode: "landmark".into(),
            config: serde_json::json!({
                "type": "distance",
                "a": "L.thumb.tip",
                "b": "L.index.tip",
                "min": 0.04,
                "max": 0.3,
            }),
        })
        .unwrap();
    let trace = fixtures::pinch_trace(30.0, 45, 0.04, 0.3);
    let mut det = MarkerDetector;
    let dt = 1.0 / 30.0;
    let mut values = Vec::new();
    for i in 0..trace.frames.len() {
        let frame = TraceFrameSource::render(&trace, i).unwrap();
        run_frame(&mut p, Some(&det.detect(&frame).unwrap()), dt);
        values.push(p.value(jack));
    }
    // The smoothed output peaks within a couple frames of the scripted
    // turnaround (one-pole lag) and is monotonic on each side of its peak.
    let half = (trace.frames.len() - 1) / 2;
    let peak_at = (0..values.len())
        .max_by(|&a, &b| values[a].total_cmp(&values[b]))
        .unwrap();
    assert!(
        peak_at.abs_diff(half) <= 2,
        "output peak at frame {peak_at}, gesture turnaround at {half}"
    );
    for i in 1..=peak_at {
        assert!(
            values[i] >= values[i - 1],
            "open phase not monotonic at {i}: {} < {}",
            values[i],
            values[i - 1]
        );
    }
    for i in peak_at + 1..values.len() {
        assert!(
            values[i] <= values[i - 1],
            "close phase not monotonic at {i}"
        );
    }
    // Normalized: stays in 0..10 and actually spans most of the range.
    assert!(values.iter().all(|v| (0.0..=10.0).contains(v)));
    let peak = values[peak_at];
    assert!(peak > 8.0, "peak {peak} too low — normalization off");
    assert!(values[0] < 1.0);

    // Frame drops hold the last value exactly.
    let held = p.value(jack);
    assert!(run_frame(&mut p, None, dt).is_empty());
    assert_eq!(p.value(jack), held);
}

/// Learn flow: arming + a detection yields a mode-proposed config.
#[test]
fn learn_proposes_mapping_from_detection() {
    let layout = WheelLayout::default();
    let mut p = GestureProcessor::default();

    // Wheel mode: hand parked in wheel 1, zone 3.
    let det = Detection {
        hands: vec![trace_hand_to_hand(&fixtures::centered_hand(
            'R',
            layout.zone_center(1, 3),
        ))],
    };
    p.learn_begin();
    assert!(p.learn_take().is_none(), "nothing learned before a frame");
    run_frame(&mut p, Some(&det), 0.033);
    let cfg = p.learn_take().expect("wheel learn candidate");
    assert_eq!(cfg, serde_json::json!({ "wheel": 1, "zone": 3 }));

    // Landmark mode: proposes presence of the detected hand's index tip.
    p.set_active_mode("landmark").unwrap();
    p.learn_begin();
    run_frame(&mut p, Some(&det), 0.033);
    let cfg = p.learn_take().expect("landmark learn candidate");
    assert_eq!(
        cfg,
        serde_json::json!({ "type": "presence", "point": "R.index.tip" })
    );
}

// ---------------------------------------------------------------------------
// Extensible registry: a stub third mode registers against the module core
// with ZERO core changes — only this registration call (M5 acceptance).
// ---------------------------------------------------------------------------

/// Stub third mode: outputs the number of detected hands scaled to gates.
struct HandCountMode;

struct HandCountEval {
    value: f32,
}

impl MappingEval for HandCountEval {
    fn update(&mut self, det: Option<&Detection>, _dt: f32, _ctx: &ModeCtx) -> f32 {
        if let Some(d) = det {
            self.value = d.hands.len() as f32 * GATE_HIGH;
        }
        self.value
    }
}

impl GestureMode for HandCountMode {
    fn id(&self) -> &str {
        "hand_count"
    }
    fn create(&self, _config: &serde_json::Value) -> anyhow::Result<Box<dyn MappingEval>> {
        Ok(Box::new(HandCountEval { value: 0.0 }))
    }
    fn learn(&self, _det: &Detection, _ctx: &ModeCtx) -> Option<serde_json::Value> {
        Some(serde_json::json!({}))
    }
}

#[test]
fn stub_third_mode_registers_without_core_changes() {
    let mut p = GestureProcessor::default();
    assert_eq!(p.mode_ids(), vec!["wheel", "landmark"]);

    p.register_mode(Box::new(HandCountMode));
    assert_eq!(p.mode_ids(), vec!["wheel", "landmark", "hand_count"]);

    p.set_active_mode("hand_count").unwrap();
    let jack = p
        .add_mapping(MappingDef {
            name: "hands".into(),
            mode: "hand_count".into(),
            config: serde_json::json!({}),
        })
        .unwrap();

    let two_hands = Detection {
        hands: vec![
            trace_hand_to_hand(&fixtures::synth_hand_at(
                'L',
                Point { x: 0.3, y: 0.5 },
                0.02,
            )),
            trace_hand_to_hand(&fixtures::synth_hand_at(
                'R',
                Point { x: 0.7, y: 0.5 },
                0.02,
            )),
        ],
    };
    run_frame(&mut p, Some(&two_hands), 0.033);
    assert_eq!(p.value(jack), 2.0 * GATE_HIGH);

    // The learn flow routes through the new mode too.
    p.learn_begin();
    run_frame(&mut p, Some(&two_hands), 0.033);
    assert_eq!(p.learn_take(), Some(serde_json::json!({})));
}
