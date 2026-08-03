//! M5 acceptance (detection pipeline): recorded fixtures play through the
//! mock frame source + detector; known poses produce the expected named
//! landmarks within pixel tolerance, deterministically across runs. Also
//! hosts the fixture provenance check and the throughput benchmark.

use dj_gesture::{
    fixtures, landmark, Detection, FrameSource, HandDetector, MarkerDetector, PoseTrace,
    TraceFrameSource, WheelLayout,
};
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn generated() -> Vec<(&'static str, PoseTrace)> {
    vec![
        ("poses.json", fixtures::poses_trace(30.0)),
        ("pinch.json", fixtures::pinch_trace(30.0, 45, 0.04, 0.3)),
        (
            "wheel-tour.json",
            fixtures::wheel_tour_trace(30.0, &WheelLayout::default(), 2),
        ),
    ]
}

/// Committed fixtures are exactly what the deterministic generators
/// produce (regenerate with `REGEN_FIXTURES=1`).
#[test]
fn fixtures_match_generators() {
    let regen = std::env::var("REGEN_FIXTURES")
        .map(|v| v == "1")
        .unwrap_or(false);
    for (name, trace) in generated() {
        let path = fixtures_dir().join(name);
        if regen {
            trace.save(&path).unwrap();
            println!("regenerated {}", path.display());
            continue;
        }
        let committed = PoseTrace::load(&path).unwrap();
        assert_eq!(committed, trace, "{name} out of sync with its generator");
    }
}

/// Run a trace through the full pipeline (synthetic frames -> detector).
fn run_pipeline(trace: &PoseTrace) -> Vec<Detection> {
    let mut source = TraceFrameSource::new(trace.clone());
    let mut detector = MarkerDetector;
    let mut out = Vec::new();
    while let Some(frame) = source.next_frame().unwrap() {
        out.push(detector.detect(&frame).unwrap());
    }
    out
}

/// [A] Known poses produce the expected named landmarks within pixel
/// tolerance (1 px at the fixture's frame size), for every hand and
/// landmark in the fixture, and the pipeline is deterministic across runs.
#[test]
fn known_poses_recover_named_landmarks() {
    let trace = PoseTrace::load(&fixtures_dir().join("poses.json")).unwrap();
    let detections = run_pipeline(&trace);
    assert_eq!(detections.len(), trace.frames.len());
    let tol_x = 1.0 / (trace.width - 1) as f32;
    let tol_y = 1.0 / (trace.height - 1) as f32;
    let mut checked = 0;
    for (i, det) in detections.iter().enumerate() {
        let truth = trace.detection(i).unwrap();
        assert_eq!(det.hands.len(), truth.hands.len(), "frame {i}: hand count");
        for hand in &truth.hands {
            for (lm, expect) in hand.points.iter().enumerate() {
                let name = landmark::point_name(hand.handedness, lm);
                let got = det
                    .point_named(&name)
                    .unwrap_or_else(|| panic!("frame {i}: {name} not detected"));
                assert!(
                    (got.x - expect.x).abs() <= tol_x && (got.y - expect.y).abs() <= tol_y,
                    "frame {i}: {name} off by ({}, {}) > 1 px",
                    (got.x - expect.x).abs() * (trace.width - 1) as f32,
                    (got.y - expect.y).abs() * (trace.height - 1) as f32,
                );
                checked += 1;
            }
        }
    }
    assert!(checked >= 4 * landmark::N_LANDMARKS, "fixture too small");

    // Deterministic across runs: a second full pass is bit-identical.
    let again = run_pipeline(&trace);
    assert_eq!(detections, again, "pipeline is not deterministic");
}

/// Empty frames yield empty detections (no false positives).
#[test]
fn empty_frame_detects_nothing() {
    let trace = PoseTrace::load(&fixtures_dir().join("poses.json")).unwrap();
    let frame = TraceFrameSource::render(&trace, 2).unwrap(); // the empty frame
    let det = MarkerDetector.detect(&frame).unwrap();
    assert!(det.hands.is_empty());
}

/// [A-adapted] Throughput: the PRD criterion is ≥ 30 fps on M4 hardware,
/// which can't be timed in this headless Linux environment. This measures
/// the synthetic-frame pipeline (render + detect, the full per-frame CPU
/// cost of the mock path) and asserts a generous floor; the on-hardware
/// ≥ 30 fps timing stays an open PRD checkbox. See reports/M5_REPORT.md.
#[test]
fn pipeline_throughput_floor() {
    let trace = fixtures::demo_trace(30.0, &WheelLayout::default());
    let mut detector = MarkerDetector;
    // Warm-up pass.
    for i in 0..trace.frames.len() {
        let frame = TraceFrameSource::render(&trace, i).unwrap();
        detector.detect(&frame).unwrap();
    }
    let frames = 300;
    let start = std::time::Instant::now();
    for i in 0..frames {
        let frame = TraceFrameSource::render(&trace, i % trace.frames.len()).unwrap();
        let det = detector.detect(&frame).unwrap();
        assert_eq!(det.hands.len(), 2);
    }
    let fps = frames as f64 / start.elapsed().as_secs_f64();
    assert!(
        fps >= 120.0,
        "pipeline throughput {fps:.0} fps below the 120 fps local floor"
    );
    println!("pipeline throughput: {fps:.0} fps at 320x240");
}
