//! Wheel-mode geometry: two on-screen wheels, each split into 8 radial
//! sections plus a center section — 18 mappable zones total (PRD §7.3).

use serde::{Deserialize, Serialize};

use crate::detect::Point;

/// Zones per wheel: index 0 is the center section, 1..=8 the radial
/// sections counted clockwise from the positive x axis (screen
/// coordinates, y down).
pub const ZONES_PER_WHEEL: usize = 9;
pub const N_WHEELS: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Wheel {
    /// Center, normalized image coordinates.
    pub cx: f32,
    pub cy: f32,
    /// Outer radius (normalized units).
    pub radius: f32,
    /// Radius of the center section.
    pub center_radius: f32,
}

impl Wheel {
    /// Which zone (0 = center, 1..=8 = radial section) contains `p`,
    /// if any.
    pub fn zone_of(&self, p: Point) -> Option<usize> {
        let dx = p.x - self.cx;
        let dy = p.y - self.cy;
        let dist = (dx * dx + dy * dy).sqrt();
        if dist > self.radius {
            return None;
        }
        if dist <= self.center_radius {
            return Some(0);
        }
        let mut angle = dy.atan2(dx);
        if angle < 0.0 {
            angle += 2.0 * std::f32::consts::PI;
        }
        let section = (angle / (std::f32::consts::PI / 4.0)) as usize;
        Some(1 + section.min(7))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WheelLayout {
    pub wheels: [Wheel; N_WHEELS],
}

impl Default for WheelLayout {
    fn default() -> WheelLayout {
        WheelLayout {
            wheels: [
                Wheel {
                    cx: 0.28,
                    cy: 0.5,
                    radius: 0.22,
                    center_radius: 0.08,
                },
                Wheel {
                    cx: 0.72,
                    cy: 0.5,
                    radius: 0.22,
                    center_radius: 0.08,
                },
            ],
        }
    }
}

impl WheelLayout {
    /// (wheel, zone) pairs containing `p`.
    pub fn zones_of(&self, p: Point) -> Vec<(usize, usize)> {
        self.wheels
            .iter()
            .enumerate()
            .filter_map(|(w, wheel)| wheel.zone_of(p).map(|z| (w, z)))
            .collect()
    }

    /// A point guaranteed to fall inside (wheel, zone) — the zone's
    /// "sweet spot" (section mid-angle at mid-ring radius). Useful for
    /// tests and fixture generation.
    pub fn zone_center(&self, wheel: usize, zone: usize) -> Point {
        let w = &self.wheels[wheel];
        if zone == 0 {
            return Point { x: w.cx, y: w.cy };
        }
        let angle = (zone as f32 - 0.5) * std::f32::consts::PI / 4.0;
        let r = (w.center_radius + w.radius) * 0.5;
        Point {
            x: w.cx + r * angle.cos(),
            y: w.cy + r * angle.sin(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zone_centers_classify_back() {
        let layout = WheelLayout::default();
        for w in 0..N_WHEELS {
            for z in 0..ZONES_PER_WHEEL {
                let p = layout.zone_center(w, z);
                assert_eq!(layout.wheels[w].zone_of(p), Some(z), "wheel {w} zone {z}");
            }
        }
    }

    #[test]
    fn outside_is_no_zone() {
        let layout = WheelLayout::default();
        assert_eq!(layout.wheels[0].zone_of(Point { x: 0.999, y: 0.01 }), None);
    }
}
