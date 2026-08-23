//! Deterministic marker detector — the tested default [`HandDetector`].
//!
//! [`crate::TraceFrameSource`] renders each landmark as a 3×3 block of a
//! color that encodes (handedness, landmark index):
//!
//! - blue channel: `MARKER_MAGIC` (tags marker pixels),
//! - red channel: `210 + hand` (210 = left, 211 = right),
//! - green channel: landmark index (0..20).
//!
//! The detector scans the frame once, accumulates matching pixels per
//! (hand, landmark), and returns each centroid in normalized coordinates.
//! A hand is reported only when all 21 landmarks are visible (fixtures keep
//! poses in frame and landmarks ≥ 2 px apart so blocks never fully
//! occlude each other). Pure integer scanning + one division per landmark:
//! byte-identical results across runs and platforms.
//!
//! This stands in for a real camera+model pair with the same interface;
//! the ONNX-backed MediaPipe-Hands detector lives behind `--features onnx`
//! (see [`crate::onnx`]).

use anyhow::Result;

use crate::detect::{Detection, Hand, HandDetector, Point};
use crate::frame::Frame;
use crate::landmark::{Handedness, N_LANDMARKS};

pub const MARKER_MAGIC: u8 = 137;
const MARKER_RED_BASE: u8 = 210;

/// The color a landmark marker is rendered with.
pub fn marker_color(hand: Handedness, landmark: usize) -> [u8; 3] {
    [
        MARKER_RED_BASE + hand.index() as u8,
        landmark as u8,
        MARKER_MAGIC,
    ]
}

#[derive(Debug, Default)]
pub struct MarkerDetector;

impl HandDetector for MarkerDetector {
    fn detect(&mut self, frame: &Frame) -> Result<Detection> {
        // (sum_x, sum_y, count) per hand and landmark.
        let mut acc = [[(0u64, 0u64, 0u64); N_LANDMARKS]; 2];
        let w = frame.width as usize;
        for (i, px) in frame.rgb.as_chunks::<3>().0.iter().enumerate() {
            if px[2] != MARKER_MAGIC {
                continue;
            }
            let hand = px[0].wrapping_sub(MARKER_RED_BASE);
            let lm = px[1] as usize;
            if hand > 1 || lm >= N_LANDMARKS {
                continue;
            }
            let (x, y) = ((i % w) as u64, (i / w) as u64);
            let cell = &mut acc[hand as usize][lm];
            cell.0 += x;
            cell.1 += y;
            cell.2 += 1;
        }
        let mut hands = Vec::new();
        for (h, cells) in acc.iter().enumerate() {
            if cells.iter().any(|c| c.2 == 0) {
                continue; // hand absent (or partially occluded: skip whole hand)
            }
            let mut points = [Point { x: 0.0, y: 0.0 }; N_LANDMARKS];
            for (p, &(sx, sy, n)) in points.iter_mut().zip(cells) {
                *p = Point {
                    x: (sx as f64 / n as f64) as f32 / (frame.width - 1) as f32,
                    y: (sy as f64 / n as f64) as f32 / (frame.height - 1) as f32,
                };
            }
            hands.push(Hand {
                handedness: if h == 0 {
                    Handedness::Left
                } else {
                    Handedness::Right
                },
                points,
            });
        }
        Ok(Detection { hands })
    }
}
