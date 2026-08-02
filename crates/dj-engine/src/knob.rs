//! Knob configuration and state — PRD §5.1.
//!
//! Every input jack is simultaneously a wire jack and a knob target.
//! - Unwired: the knob position maps through the config to a constant value.
//! - Wired: the knob acts as attenuverter (`atten` in [-1, 1]) plus `offset`
//!   applied to the incoming signal: `effective = signal * atten + offset`.
//!
//! Knob config is data, not code. Per-patch overrides are stored in the patch.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KnobStyle {
    Continuous,
    Switch,
    Button,
    Stepped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Curve {
    Linear,
    Exp,
    Log,
    /// Piecewise-linear breakpoints: pairs of (position in 0..1, value).
    Custom(Vec<[f32; 2]>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KnobConfig {
    #[serde(default = "default_style")]
    pub style: KnobStyle,
    #[serde(default)]
    pub min: f32,
    #[serde(default = "default_max")]
    pub max: f32,
    #[serde(default = "default_curve")]
    pub curve: Curve,
    /// Number of steps for `stepped` style.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steps: Option<u32>,
}

fn default_style() -> KnobStyle {
    KnobStyle::Continuous
}
fn default_max() -> f32 {
    10.0
}
fn default_curve() -> Curve {
    Curve::Linear
}

impl Default for KnobConfig {
    fn default() -> Self {
        KnobConfig {
            style: KnobStyle::Continuous,
            min: 0.0,
            max: 10.0,
            curve: Curve::Linear,
            steps: None,
        }
    }
}

impl KnobConfig {
    /// Map a normalized knob position (0..1) to a signal value.
    pub fn map(&self, position: f32) -> f32 {
        let p = position.clamp(0.0, 1.0);
        let p = match self.style {
            KnobStyle::Continuous => p,
            KnobStyle::Switch | KnobStyle::Button => {
                if p >= 0.5 {
                    1.0
                } else {
                    0.0
                }
            }
            KnobStyle::Stepped => {
                let steps = self.steps.unwrap_or(2).max(2);
                let q = (p * (steps - 1) as f32).round() / (steps - 1) as f32;
                q
            }
        };
        match &self.curve {
            Curve::Linear => self.min + p * (self.max - self.min),
            Curve::Exp => {
                // Exponential interpolation; requires min/max > 0, falls back
                // to a squared-position curve otherwise.
                if self.min > 0.0 && self.max > 0.0 {
                    self.min * (self.max / self.min).powf(p)
                } else {
                    self.min + p * p * (self.max - self.min)
                }
            }
            Curve::Log => {
                if self.min > 0.0 && self.max > 0.0 {
                    // Inverse of exp mapping.
                    let ratio = (self.max / self.min).ln();
                    self.min + (p * ratio).exp_m1() / ratio.exp_m1() * (self.max - self.min)
                } else {
                    self.min + p.sqrt() * (self.max - self.min)
                }
            }
            Curve::Custom(points) => {
                if points.is_empty() {
                    return self.min;
                }
                let mut prev = points[0];
                if p <= prev[0] {
                    return prev[1];
                }
                for pt in &points[1..] {
                    if p <= pt[0] {
                        let t = (p - prev[0]) / (pt[0] - prev[0]).max(1e-9);
                        return prev[1] + t * (pt[1] - prev[1]);
                    }
                    prev = *pt;
                }
                prev[1]
            }
        }
    }
}

/// Per-patch, per-input knob state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KnobState {
    /// Normalized knob position, 0..1.
    pub position: f32,
    /// Attenuverter applied to the incoming signal when wired, -1..1.
    pub atten: f32,
    /// Offset added to the incoming signal when wired.
    pub offset: f32,
    /// Per-patch config override (None = use the manifest's knob config).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<KnobConfig>,
}

impl Default for KnobState {
    fn default() -> Self {
        KnobState {
            position: 0.0,
            atten: 1.0,
            offset: 0.0,
            config: None,
        }
    }
}

/// Precomputed RT-side values for one input jack (no allocation on RT path).
#[derive(Debug, Clone, Copy)]
pub struct JackRt {
    /// Constant fed to the input when no wire is connected.
    pub unwired_value: f32,
    pub atten: f32,
    pub offset: f32,
}

impl JackRt {
    pub fn from_state(state: &KnobState, manifest_config: Option<&KnobConfig>, default: f32) -> Self {
        let cfg_owned;
        let cfg = match (&state.config, manifest_config) {
            (Some(c), _) => c,
            (None, Some(c)) => c,
            (None, None) => {
                cfg_owned = KnobConfig::default();
                &cfg_owned
            }
        };
        // A knob position of exactly 0 with no explicit interaction uses the
        // manifest default; callers set position from the default via
        // `position_for_value` when creating nodes.
        let _ = default;
        JackRt {
            unwired_value: cfg.map(state.position),
            atten: state.atten,
            offset: state.offset,
        }
    }
}

/// Find the knob position that maps (approximately) to `value` — used to
/// initialize knobs from manifest defaults.
pub fn position_for_value(config: &KnobConfig, value: f32) -> f32 {
    // Binary search over the monotone map; good enough for initialization.
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    let increasing = config.map(1.0) >= config.map(0.0);
    for _ in 0..40 {
        let mid = 0.5 * (lo + hi);
        let v = config.map(mid);
        if (v < value) == increasing {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}
