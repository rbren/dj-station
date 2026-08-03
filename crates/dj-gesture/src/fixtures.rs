//! Deterministic synthetic pose generators.
//!
//! These build the recorded-fixture [`PoseTrace`]s checked into the test
//! trees (JSON traces, not video binaries — repo stays lean) and drive the
//! headless mock camera feed in the app. Everything here is pure f32 math
//! with no randomness: regenerating a fixture yields byte-identical JSON.

use crate::detect::Point;
use crate::trace::{PoseTrace, TraceFrame, TraceHand};
use crate::wheel::{WheelLayout, ZONES_PER_WHEEL};

/// Default synthetic frame size.
pub const FRAME_W: u32 = 320;
pub const FRAME_H: u32 = 240;

fn round4(v: f32) -> f32 {
    (v * 10_000.0).round() / 10_000.0
}

/// A synthetic hand: 19 landmarks on a fixed grid around `center` (5
/// finger columns × 4 joints minus the two tips placed explicitly), with
/// thumb.tip and index.tip at `thumb_tip` / `index_tip`. Grid spacing `u`
/// (normalized units) keeps markers ≥ 3 px apart at the default frame
/// size, so the marker detector always sees all 21 landmarks.
pub fn synth_hand(
    hand: char,
    center: Point,
    u: f32,
    thumb_tip: Point,
    index_tip: Point,
) -> TraceHand {
    let mut points = vec![[0.0f32; 2]; crate::landmark::N_LANDMARKS];
    // wrist below the palm grid
    points[0] = [center.x, center.y + 2.5 * u];
    // finger columns: thumb(1..4), index(5..8), middle(9..12), ring(13..16),
    // pinky(17..20); joints stack upward from the palm.
    for finger in 0..5 {
        let x = center.x + (finger as f32 - 2.0) * u;
        for joint in 0..4 {
            let idx = 1 + finger * 4 + joint;
            points[idx] = [x, center.y + (1.0 - joint as f32) * u];
        }
    }
    // The two pinch-relevant tips are explicit.
    points[4] = [thumb_tip.x, thumb_tip.y];
    points[8] = [index_tip.x, index_tip.y];
    TraceHand {
        hand: hand.to_string(),
        points: points
            .into_iter()
            .map(|p| [round4(p[0]), round4(p[1])])
            .collect(),
    }
}

/// A hand whose centroid is irrelevant — tips sit on the grid.
pub fn synth_hand_at(hand: char, center: Point, u: f32) -> TraceHand {
    let thumb = Point {
        x: center.x - 2.0 * u,
        y: center.y - 2.0 * u,
    };
    let index = Point {
        x: center.x - u,
        y: center.y - 2.0 * u,
    };
    synth_hand(hand, center, u, thumb, index)
}

/// Centroid of a [`TraceHand`] (matches [`crate::Hand::centroid`]).
pub fn trace_centroid(hand: &TraceHand) -> Point {
    let n = hand.points.len() as f32;
    let (sx, sy) = hand
        .points
        .iter()
        .fold((0.0, 0.0), |(sx, sy), p| (sx + p[0], sy + p[1]));
    Point {
        x: sx / n,
        y: sy / n,
    }
}

/// Scripted pinch fixture: a left hand holds still while thumb.tip and
/// index.tip move apart horizontally (frames `0..=half`) and back together
/// (`half..n-1`). The tip distance sweeps `min_d..max_d..min_d`, strictly
/// monotonic in each phase.
pub fn pinch_trace(fps: f32, n: usize, min_d: f32, max_d: f32) -> PoseTrace {
    let half = (n - 1) / 2;
    let anchor = Point { x: 0.5, y: 0.72 };
    let hand_center = Point { x: 0.5, y: 0.35 };
    let frames = (0..n)
        .map(|i| {
            let phase = if i <= half {
                i as f32 / half as f32
            } else {
                (n - 1 - i) as f32 / (n - 1 - half) as f32
            };
            let d = min_d + (max_d - min_d) * phase;
            let thumb = Point {
                x: anchor.x - d / 2.0,
                y: anchor.y,
            };
            let index = Point {
                x: anchor.x + d / 2.0,
                y: anchor.y,
            };
            TraceFrame {
                hands: vec![synth_hand('L', hand_center, 0.022, thumb, index)],
            }
        })
        .collect();
    PoseTrace {
        fps,
        width: FRAME_W,
        height: FRAME_H,
        frames,
    }
}

/// Wheel-tour fixture: a right hand parks its centroid in every zone of
/// both wheels in turn (wheel-major, zone 0 = center first), `dwell`
/// frames per zone, with one empty frame between zones so gate edges are
/// unambiguous.
pub fn wheel_tour_trace(fps: f32, layout: &WheelLayout, dwell: usize) -> PoseTrace {
    let mut frames = Vec::new();
    for wheel in 0..layout.wheels.len() {
        for zone in 0..ZONES_PER_WHEEL {
            let target = layout.zone_center(wheel, zone);
            for _ in 0..dwell {
                frames.push(TraceFrame {
                    hands: vec![centered_hand('R', target)],
                });
            }
            frames.push(TraceFrame::default());
        }
    }
    PoseTrace {
        fps,
        width: FRAME_W,
        height: FRAME_H,
        frames,
    }
}

/// A hand whose landmark *centroid* lands exactly on `target` (the grid is
/// generated around `target`, then translated by the centroid error).
pub fn centered_hand(hand: char, target: Point) -> TraceHand {
    let mut h = synth_hand_at(hand, target, 0.016);
    let c = trace_centroid(&h);
    for p in &mut h.points {
        p[0] = round4(p[0] + target.x - c.x);
        p[1] = round4(p[1] + target.y - c.y);
    }
    h
}

/// Static two-hand poses fixture (detector accuracy test material).
pub fn poses_trace(fps: f32) -> PoseTrace {
    let frames = vec![
        TraceFrame {
            hands: vec![
                synth_hand_at('L', Point { x: 0.3, y: 0.4 }, 0.022),
                synth_hand_at('R', Point { x: 0.7, y: 0.6 }, 0.022),
            ],
        },
        TraceFrame {
            hands: vec![synth_hand_at('L', Point { x: 0.5, y: 0.5 }, 0.03)],
        },
        TraceFrame::default(),
        TraceFrame {
            hands: vec![synth_hand_at('R', Point { x: 0.25, y: 0.7 }, 0.018)],
        },
    ];
    PoseTrace {
        fps,
        width: FRAME_W,
        height: FRAME_H,
        frames,
    }
}

/// The looping demo trace the app's headless mock camera plays: the right
/// hand orbits wheel 1's sections while the left hand pinches open/closed.
pub fn demo_trace(fps: f32, layout: &WheelLayout) -> PoseTrace {
    let n = 120usize;
    let mut frames = Vec::with_capacity(n);
    for i in 0..n {
        let t = i as f32 / n as f32;
        let zone = 1 + ((t * 8.0) as usize).min(7);
        let right = centered_hand('R', layout.zone_center(1, zone));
        let phase = 0.5 - 0.5 * (t * 2.0 * std::f32::consts::PI).cos();
        let d = 0.04 + 0.26 * phase;
        let anchor = Point { x: 0.28, y: 0.72 };
        let left = synth_hand(
            'L',
            Point { x: 0.28, y: 0.35 },
            0.022,
            Point {
                x: anchor.x - d / 2.0,
                y: anchor.y,
            },
            Point {
                x: anchor.x + d / 2.0,
                y: anchor.y,
            },
        );
        frames.push(TraceFrame {
            hands: vec![left, right],
        });
    }
    PoseTrace {
        fps,
        width: FRAME_W,
        height: FRAME_H,
        frames,
    }
}
