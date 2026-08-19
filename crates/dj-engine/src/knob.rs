//! Knob configuration and state — PRD §5.1.
//!
//! Every input jack is simultaneously a wire jack and a knob target.
//! - Unwired: the knob position maps through the config to a constant value.
//! - Wired, knob-backed input: the blend happens in POSITION space so the
//!   knob's curve shapes the modulation exactly like it shapes the dial. The
//!   knob sets a baseline position; the signal moves that position, scaled
//!   by the attenuverter (`atten` in [-1, 1], expressed against the ±10 V
//!   rails so a full-scale ±5 V signal at atten = 1 sweeps half the travel)
//!   plus `offset` (also in position units):
//!   `effective = curve(clamp01(base_pos + signal * atten / 10 + offset))`.
//!   On a linear knob spanning 10 units (pitch ±5 V, cv 0..10) this reduces
//!   to the plain additive `knob_value + signal * atten` law; on exp/log
//!   knobs the modulation tracks the baseline geometrically (the whole
//!   point: ±CV on an exp rate knob is a musical spread at any baseline).
//! - Wired, plain jack (no knob declared, or style `wire`): the signal adds
//!   directly onto the mapped baseline, `knob_value + signal * atten +
//!   offset`, hard-clipped to the ±10 V rails — audio and gate pass-through
//!   paths must never be squeezed through a knob range.
//! - Wired, `wire_style = Override`: the signal IS the value — knob
//!   position, atten and offset are ignored and the summed wire value is
//!   clamped to the knob's configured range in VALUE space (never squeezed
//!   through the curve — a v/oct pitch CV must pass through untouched).
//!   This is what a pitch wire into a pitch input wants: the keyboard sets
//!   the note, the knob doesn't add to it. The app flips a jack to
//!   Override automatically when both wire ends carry a `volt_per_octave`
//!   display map; the mode is per-patch state a user can change in the
//!   knob menu. Unwired, an Override jack falls back to its knob value
//!   like any other jack (the mode only matters while wired).
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
    /// No knob at all — the input is a plain wire jack. Unwired it still
    /// maps its position like a continuous knob (yielding the default).
    Wire,
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
    /// Style quantization of a raw 0..1 position: detent rounding for
    /// `stepped`, on/off snap for `switch`/`button`, identity otherwise.
    pub fn snap(&self, position: f32) -> f32 {
        let p = position.clamp(0.0, 1.0);
        match self.style {
            KnobStyle::Continuous | KnobStyle::Wire => p,
            KnobStyle::Switch | KnobStyle::Button => {
                if p >= 0.5 {
                    1.0
                } else {
                    0.0
                }
            }
            KnobStyle::Stepped => {
                let steps = self.steps.unwrap_or(2).max(2);
                (p * (steps - 1) as f32).round() / (steps - 1) as f32
            }
        }
    }

    /// Map a normalized knob position (0..1) to a signal value.
    pub fn map(&self, position: f32) -> f32 {
        self.curve_at(self.snap(position))
    }

    /// Curve mapping only (no style snap) of an already-snapped position —
    /// the wired-blend path adds the signal in position space after the
    /// baseline snap and must not re-quantize the moving sum.
    pub fn curve_at(&self, position: f32) -> f32 {
        let p = position.clamp(0.0, 1.0);
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

/// How a wired input treats the incoming signal (module docs above).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WireStyle {
    /// The signal modulates the knob baseline (positional or additive law).
    #[default]
    Cv,
    /// The signal IS the value; the knob is inert while wired.
    Override,
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
    /// CV (default) or Override blending while wired. Old patches omit
    /// the field and load as CV — behavior-identical to before it existed.
    #[serde(default, skip_serializing_if = "is_default_wire_style")]
    pub wire_style: WireStyle,
    /// Per-patch config override (None = use the manifest's knob config).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<KnobConfig>,
}

fn is_default_wire_style(w: &WireStyle) -> bool {
    *w == WireStyle::Cv
}

impl Default for KnobState {
    fn default() -> Self {
        KnobState {
            position: 0.0,
            atten: 1.0,
            offset: 0.0,
            wire_style: WireStyle::Cv,
            config: None,
        }
    }
}

/// Resolution of the RT lookup table custom curves are resampled into.
pub const CURVE_TABLE_LEN: usize = 33;

/// RT-evaluable curve: a `Copy` mirror of a `KnobConfig`'s curve branch so
/// `JackRt` can cross the command ring and run per-sample without touching
/// the `Curve::Custom` breakpoint `Vec` (no allocation or drop on the RT
/// thread).
#[derive(Debug, Clone, Copy)]
pub enum CurveRt {
    /// `min + p * span`
    Linear { min: f32, span: f32 },
    /// Geometric interpolation `min * e^(k·p)`, `k = ln(max/min)`.
    Geometric { min: f32, k: f32 },
    /// Squared-position fallback for `exp` with non-positive endpoints.
    Squared { min: f32, span: f32 },
    /// expm1 log map: `min + expm1(p·r) · inv_expm1_r · span`.
    LogGeometric {
        min: f32,
        span: f32,
        r: f32,
        inv_expm1_r: f32,
    },
    /// `sqrt` fallback for `log` with non-positive endpoints.
    Sqrt { min: f32, span: f32 },
    /// Custom breakpoint curves, resampled onto a uniform grid (linear
    /// interpolation between samples — breakpoints that fall between grid
    /// points are approximated; the unwired baseline stays exact because it
    /// is computed off-RT via `KnobConfig::map`).
    Table { values: [f32; CURVE_TABLE_LEN] },
}

impl CurveRt {
    pub fn from_config(cfg: &KnobConfig) -> Self {
        let span = cfg.max - cfg.min;
        match &cfg.curve {
            Curve::Linear => CurveRt::Linear { min: cfg.min, span },
            Curve::Exp => {
                if cfg.min > 0.0 && cfg.max > 0.0 {
                    CurveRt::Geometric {
                        min: cfg.min,
                        k: (cfg.max / cfg.min).ln(),
                    }
                } else {
                    CurveRt::Squared { min: cfg.min, span }
                }
            }
            Curve::Log => {
                if cfg.min > 0.0 && cfg.max > 0.0 {
                    let r = (cfg.max / cfg.min).ln();
                    CurveRt::LogGeometric {
                        min: cfg.min,
                        span,
                        r,
                        inv_expm1_r: 1.0 / r.exp_m1(),
                    }
                } else {
                    CurveRt::Sqrt { min: cfg.min, span }
                }
            }
            Curve::Custom(_) => {
                let mut values = [0.0f32; CURVE_TABLE_LEN];
                for (i, v) in values.iter_mut().enumerate() {
                    *v = cfg.curve_at(i as f32 / (CURVE_TABLE_LEN - 1) as f32);
                }
                CurveRt::Table { values }
            }
        }
    }

    /// Evaluate the curve at a (clamped) 0..1 position.
    #[inline]
    pub fn at(&self, position: f32) -> f32 {
        let p = position.clamp(0.0, 1.0);
        match self {
            CurveRt::Linear { min, span } => min + p * span,
            CurveRt::Geometric { min, k } => min * (k * p).exp(),
            CurveRt::Squared { min, span } => min + p * p * span,
            CurveRt::LogGeometric {
                min,
                span,
                r,
                inv_expm1_r,
            } => min + (p * r).exp_m1() * inv_expm1_r * span,
            CurveRt::Sqrt { min, span } => min + p.sqrt() * span,
            CurveRt::Table { values } => {
                let x = p * (CURVE_TABLE_LEN - 1) as f32;
                let i = (x as usize).min(CURVE_TABLE_LEN - 2);
                let t = x - i as f32;
                values[i] + t * (values[i + 1] - values[i])
            }
        }
    }
}

/// How a wired input combines the incoming signal with its knob (see the
/// module docs above for the two laws).
#[derive(Debug, Clone, Copy)]
pub enum BlendRt {
    /// Plain jack: `baseline + signal · atten + offset`, rail-clipped.
    Additive,
    /// Knob-backed: `curve(clamp01(base_pos + signal · atten / 10 + offset))`.
    Positional { base_pos: f32, curve: CurveRt },
    /// The signal IS the value, clamped to the knob's range in value
    /// space (atten/offset/position ignored) — see the module docs.
    Override { min: f32, max: f32 },
}

/// Precomputed RT-side values for one input jack (no allocation on RT path).
#[derive(Debug, Clone, Copy)]
pub struct JackRt {
    /// Constant fed to the input when no wire is connected.
    pub unwired_value: f32,
    pub atten: f32,
    pub offset: f32,
    pub blend: BlendRt,
}

impl JackRt {
    pub fn from_state(
        state: &KnobState,
        manifest_config: Option<&KnobConfig>,
        default: f32,
    ) -> Self {
        // A jack with no knob declared anywhere is a plain wire jack (audio
        // ins, gate thrus): keep the additive law so bipolar signals are
        // never squeezed through a knob range.
        let plain = state.config.is_none() && manifest_config.is_none();
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
        let blend = if state.wire_style == WireStyle::Override {
            // Plain jacks have no meaningful configured range (the default
            // 0..10 would squash bipolar signals) — clamp to the rails.
            if plain {
                BlendRt::Override {
                    min: -10.0,
                    max: 10.0,
                }
            } else {
                BlendRt::Override {
                    min: cfg.min.min(cfg.max),
                    max: cfg.min.max(cfg.max),
                }
            }
        } else if plain || cfg.style == KnobStyle::Wire {
            BlendRt::Additive
        } else {
            BlendRt::Positional {
                base_pos: cfg.snap(state.position),
                curve: CurveRt::from_config(cfg),
            }
        };
        JackRt {
            unwired_value: cfg.map(state.position),
            atten: state.atten,
            offset: state.offset,
            blend,
        }
    }
}

/// Find the knob position that maps (approximately) to `value` — used to
/// initialize knobs from manifest defaults.
pub fn position_for_value(config: &KnobConfig, value: f32) -> f32 {
    // Continuous linear maps invert exactly. This matters now that wired
    // inputs add the knob baseline to the signal: a default of 0 must invert
    // to a position that maps back to exactly 0, not to a binary-search
    // epsilon away from it.
    if matches!(config.curve, Curve::Linear)
        && matches!(config.style, KnobStyle::Continuous | KnobStyle::Wire)
    {
        if config.max == config.min {
            return 0.0;
        }
        return ((value - config.min) / (config.max - config.min)).clamp(0.0, 1.0);
    }
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
