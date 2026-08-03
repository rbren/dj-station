//! Recorded pose-trace fixtures and the synthetic frame source.
//!
//! A [`PoseTrace`] is a small JSON file: per-frame hand poses in normalized
//! coordinates. Fixtures checked into the test tree use this format instead
//! of video binaries (keeps the repo lean, and the traces double as ground
//! truth for detector accuracy tests).
//!
//! [`TraceFrameSource`] renders each trace frame into a synthetic RGB
//! [`Frame`]: every landmark is drawn as a 3×3 color-coded marker block
//! (see [`crate::marker`] for the encoding), standing in for a camera
//! pointed at real hands. The render → detect round trip is deterministic
//! and recovers landmark positions within a pixel.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::detect::{Detection, Hand, Point};
use crate::frame::{Frame, FrameSource};
use crate::landmark::{Handedness, N_LANDMARKS};
use crate::marker::marker_color;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraceHand {
    /// "L" or "R".
    pub hand: String,
    /// 21 `[x, y]` pairs, normalized [0, 1] coordinates.
    pub points: Vec<[f32; 2]>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TraceFrame {
    #[serde(default)]
    pub hands: Vec<TraceHand>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PoseTrace {
    pub fps: f32,
    /// Synthetic frame size the trace renders to.
    pub width: u32,
    pub height: u32,
    pub frames: Vec<TraceFrame>,
}

impl PoseTrace {
    pub fn load(path: &Path) -> Result<PoseTrace> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading pose trace {}", path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let mut s = serde_json::to_string_pretty(self)?;
        s.push('\n');
        std::fs::write(path, s)?;
        Ok(())
    }

    /// Ground-truth detection for frame `i` (what a perfect detector
    /// would return).
    pub fn detection(&self, i: usize) -> Option<Detection> {
        let frame = self.frames.get(i)?;
        let mut hands = Vec::with_capacity(frame.hands.len());
        for th in &frame.hands {
            let handedness = Handedness::from_letter(th.hand.chars().next()?)?;
            if th.points.len() != N_LANDMARKS {
                return None;
            }
            let mut points = [Point { x: 0.0, y: 0.0 }; N_LANDMARKS];
            for (p, src) in points.iter_mut().zip(&th.points) {
                *p = Point {
                    x: src[0],
                    y: src[1],
                };
            }
            hands.push(Hand { handedness, points });
        }
        Some(Detection { hands })
    }
}

/// Plays a [`PoseTrace`] back as synthetic frames — the mock camera.
pub struct TraceFrameSource {
    trace: PoseTrace,
    next: usize,
    /// Loop forever instead of ending (mock live feed).
    looped: bool,
}

impl TraceFrameSource {
    pub fn new(trace: PoseTrace) -> TraceFrameSource {
        TraceFrameSource {
            trace,
            next: 0,
            looped: false,
        }
    }

    pub fn looped(trace: PoseTrace) -> TraceFrameSource {
        TraceFrameSource {
            trace,
            next: 0,
            looped: true,
        }
    }

    pub fn trace(&self) -> &PoseTrace {
        &self.trace
    }

    /// Render one trace frame to a synthetic RGB frame.
    pub fn render(trace: &PoseTrace, index: usize) -> Option<Frame> {
        let tf = trace.frames.get(index)?;
        let mut frame = Frame::new(trace.width, trace.height);
        for th in &tf.hands {
            let hand = Handedness::from_letter(th.hand.chars().next()?)?;
            for (lm, p) in th.points.iter().enumerate().take(N_LANDMARKS) {
                let cx = (p[0] * (trace.width - 1) as f32).round() as i64;
                let cy = (p[1] * (trace.height - 1) as f32).round() as i64;
                let color = marker_color(hand, lm);
                for dy in -1..=1i64 {
                    for dx in -1..=1i64 {
                        let x = (cx + dx).clamp(0, trace.width as i64 - 1) as u32;
                        let y = (cy + dy).clamp(0, trace.height as i64 - 1) as u32;
                        frame.put_pixel(x, y, color);
                    }
                }
            }
        }
        Some(frame)
    }
}

impl FrameSource for TraceFrameSource {
    fn fps(&self) -> f32 {
        self.trace.fps
    }

    fn next_frame(&mut self) -> Result<Option<Frame>> {
        if self.next >= self.trace.frames.len() {
            if !self.looped || self.trace.frames.is_empty() {
                return Ok(None);
            }
            self.next = 0;
        }
        let frame = TraceFrameSource::render(&self.trace, self.next);
        self.next += 1;
        Ok(frame)
    }
}
