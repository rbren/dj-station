//! Detection results and the detector trait.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::frame::Frame;
use crate::landmark::{parse_point_name, Handedness, N_LANDMARKS};

/// A landmark position in normalized image coordinates ([0, 1] each axis,
/// origin top-left).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

impl Point {
    pub fn distance(self, other: Point) -> f32 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        (dx * dx + dy * dy).sqrt()
    }
}

/// One detected hand: 21 named landmarks (see [`crate::landmark`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hand {
    pub handedness: Handedness,
    pub points: [Point; N_LANDMARKS],
}

impl Hand {
    /// Reference point for zone tests: the centroid of all landmarks.
    pub fn centroid(&self) -> Point {
        let mut x = 0.0;
        let mut y = 0.0;
        for p in &self.points {
            x += p.x;
            y += p.y;
        }
        let n = N_LANDMARKS as f32;
        Point { x: x / n, y: y / n }
    }
}

/// Everything detected in one frame.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Detection {
    pub hands: Vec<Hand>,
}

impl Detection {
    pub fn hand(&self, handedness: Handedness) -> Option<&Hand> {
        self.hands.iter().find(|h| h.handedness == handedness)
    }

    pub fn point(&self, handedness: Handedness, landmark: usize) -> Option<Point> {
        self.hand(handedness)
            .and_then(|h| h.points.get(landmark).copied())
    }

    /// Look up a point by full name, e.g. `"L.index.tip"`.
    pub fn point_named(&self, name: &str) -> Option<Point> {
        let (hand, landmark) = parse_point_name(name)?;
        self.point(hand, landmark)
    }
}

/// Turns frames into detections. Implementations: [`crate::MarkerDetector`]
/// (deterministic, tested default) and the feature-gated ONNX-backed
/// detector ([`crate::onnx`], MediaPipe-Hands-class models).
pub trait HandDetector: Send {
    fn detect(&mut self, frame: &Frame) -> Result<Detection>;
}
