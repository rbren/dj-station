//! The two modes that ship first (PRD §7.3): Wheel and Landmark.

use anyhow::{anyhow, Result};
use serde::Deserialize;

use crate::detect::Detection;
use crate::mode::{GestureMode, MappingEval, ModeCtx};
use crate::wheel::{N_WHEELS, ZONES_PER_WHEEL};
use crate::GATE_HIGH;

/// Default gate decay timeout (seconds without a usable detection before
/// a held gate falls back to 0).
pub const DEFAULT_TIMEOUT: f32 = 0.5;

fn default_timeout() -> f32 {
    DEFAULT_TIMEOUT
}

// ---------------------------------------------------------------------------
// Wheel mode
// ---------------------------------------------------------------------------

/// Config: `{"wheel": 0..1, "zone": 0..8, "timeout": secs?}` — zone 0 is
/// the center section, 1..=8 the radial sections.
#[derive(Debug, Deserialize)]
struct WheelConfig {
    wheel: usize,
    zone: usize,
    #[serde(default = "default_timeout")]
    timeout: f32,
}

/// Wheel mode: hand presence inside the mapped zone drives a gate output.
/// The reference point is the hand centroid; when a detection is present
/// the gate follows zone membership exactly, when detections drop the gate
/// holds and decays to 0 after `timeout`.
pub struct WheelMode;

struct WheelEval {
    cfg: WheelConfig,
    value: f32,
    starved: f32,
}

impl MappingEval for WheelEval {
    fn update(&mut self, det: Option<&Detection>, dt: f32, ctx: &ModeCtx) -> f32 {
        match det {
            Some(d) => {
                self.starved = 0.0;
                let inside = d.hands.iter().any(|h| {
                    ctx.wheels.wheels[self.cfg.wheel].zone_of(h.centroid()) == Some(self.cfg.zone)
                });
                self.value = if inside { GATE_HIGH } else { 0.0 };
            }
            None => {
                self.starved += dt;
                if self.starved >= self.cfg.timeout {
                    self.value = 0.0;
                }
            }
        }
        self.value
    }
}

impl GestureMode for WheelMode {
    fn id(&self) -> &str {
        "wheel"
    }

    fn create(&self, config: &serde_json::Value) -> Result<Box<dyn MappingEval>> {
        let cfg: WheelConfig = serde_json::from_value(config.clone())
            .map_err(|e| anyhow!("bad wheel mapping config: {e}"))?;
        anyhow::ensure!(cfg.wheel < N_WHEELS, "wheel index out of range");
        anyhow::ensure!(cfg.zone < ZONES_PER_WHEEL, "zone index out of range");
        Ok(Box::new(WheelEval {
            cfg,
            value: 0.0,
            starved: 0.0,
        }))
    }

    /// Learn: the zone the first detected hand is currently in.
    fn learn(&self, det: &Detection, ctx: &ModeCtx) -> Option<serde_json::Value> {
        let hand = det.hands.first()?;
        let (wheel, zone) = ctx.wheels.zones_of(hand.centroid()).into_iter().next()?;
        Some(serde_json::json!({ "wheel": wheel, "zone": zone }))
    }
}

// ---------------------------------------------------------------------------
// Landmark mode
// ---------------------------------------------------------------------------

/// Config, two mapping types (PRD §7.3):
/// - `{"type": "presence", "point": "L.index.tip", "timeout": secs?}` —
///   gate 10 while the named point is detected; holds through dropped
///   frames and decays to 0 once the point has been missing for `timeout`.
/// - `{"type": "distance", "a": "L.thumb.tip", "b": "L.index.tip",
///    "min": 0.02, "max": 0.35, "smooth": secs?}` — distance between two
///   named points, normalized to 0..1 over [min, max] (normalized image
///   units), one-pole smoothed, presented on the jack scaled ×10
///   (0..10, the host's unipolar CV range — VCA cv reaches unity at 10).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum LandmarkConfig {
    Presence {
        point: String,
        #[serde(default = "default_timeout")]
        timeout: f32,
    },
    Distance {
        a: String,
        b: String,
        #[serde(default = "default_dist_min")]
        min: f32,
        #[serde(default = "default_dist_max")]
        max: f32,
        #[serde(default = "default_smooth")]
        smooth: f32,
    },
}

fn default_dist_min() -> f32 {
    0.02
}
fn default_dist_max() -> f32 {
    0.35
}
fn default_smooth() -> f32 {
    0.08
}

pub struct LandmarkMode;

struct PresenceEval {
    point: String,
    timeout: f32,
    value: f32,
    missing: f32,
}

impl MappingEval for PresenceEval {
    fn update(&mut self, det: Option<&Detection>, dt: f32, _ctx: &ModeCtx) -> f32 {
        let seen = det.map(|d| d.point_named(&self.point).is_some());
        match seen {
            Some(true) => {
                self.missing = 0.0;
                self.value = GATE_HIGH;
            }
            // Point absent from a valid detection or frame dropped: hold,
            // then decay after the timeout.
            Some(false) | None => {
                self.missing += dt;
                if self.missing >= self.timeout {
                    self.value = 0.0;
                }
            }
        }
        self.value
    }
}

struct DistanceEval {
    a: String,
    b: String,
    min: f32,
    max: f32,
    smooth: f32,
    value: f32,
}

impl MappingEval for DistanceEval {
    fn update(&mut self, det: Option<&Detection>, dt: f32, _ctx: &ModeCtx) -> f32 {
        // Missing points/frames hold the last value (continuous outputs
        // degrade by holding, not decaying — PRD §7.3).
        if let Some(d) = det {
            if let (Some(a), Some(b)) = (d.point_named(&self.a), d.point_named(&self.b)) {
                let raw = a.distance(b);
                let norm = ((raw - self.min) / (self.max - self.min)).clamp(0.0, 1.0);
                let target = norm * 10.0;
                let alpha = if self.smooth <= 0.0 {
                    1.0
                } else {
                    1.0 - (-dt / self.smooth).exp()
                };
                self.value += alpha * (target - self.value);
            }
        }
        self.value
    }
}

impl GestureMode for LandmarkMode {
    fn id(&self) -> &str {
        "landmark"
    }

    fn create(&self, config: &serde_json::Value) -> Result<Box<dyn MappingEval>> {
        let cfg: LandmarkConfig = serde_json::from_value(config.clone())
            .map_err(|e| anyhow!("bad landmark mapping config: {e}"))?;
        match cfg {
            LandmarkConfig::Presence { point, timeout } => {
                anyhow::ensure!(
                    crate::landmark::parse_point_name(&point).is_some(),
                    "unknown point {point:?}"
                );
                Ok(Box::new(PresenceEval {
                    point,
                    timeout,
                    value: 0.0,
                    missing: 0.0,
                }))
            }
            LandmarkConfig::Distance {
                a,
                b,
                min,
                max,
                smooth,
            } => {
                for p in [&a, &b] {
                    anyhow::ensure!(
                        crate::landmark::parse_point_name(p).is_some(),
                        "unknown point {p:?}"
                    );
                }
                anyhow::ensure!(max > min, "distance max must exceed min");
                Ok(Box::new(DistanceEval {
                    a,
                    b,
                    min,
                    max,
                    smooth,
                    value: 0.0,
                }))
            }
        }
    }

    /// Learn: presence of the first detected hand's index tip — the
    /// simplest useful candidate; richer configs come from the mapping UI.
    fn learn(&self, det: &Detection, _ctx: &ModeCtx) -> Option<serde_json::Value> {
        let hand = det.hands.first()?;
        let point = crate::landmark::point_name(hand.handedness, 8);
        Some(serde_json::json!({ "type": "presence", "point": point }))
    }
}
