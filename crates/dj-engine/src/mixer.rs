//! Built-in Crossfader/Mixer module (PRD §11 M2): stereo A/B crossfade
//! with an equal-power gain law.
//!
//! - Inputs: `a_l`, `a_r`, `b_l`, `b_r`, `xfade` (-10 = full A, +10 = full
//!   B, 0 = center; also a knob when unwired).
//! - Outputs: `out_l`, `out_r`.
//!
//! Gain law: with x = (xfade + 10) / 20 clamped to [0, 1],
//! `gain_a = cos(x·π/2)`, `gain_b = sin(x·π/2)` — constant combined power
//! across the sweep, and each side reaches exactly 1.0 at its end stop and
//! exactly 0.0 at the other (a fader hard over is digital silence).

use crate::knob::{Curve, KnobConfig, KnobStyle};
use crate::manifest::{categories, JackDecl, Manifest, OutputDecl};
use crate::module_host::HostModule;

pub const CROSSFADER_ID: &str = "builtin.crossfader";

const IN_A_L: usize = 0;
const IN_A_R: usize = 1;
const IN_B_L: usize = 2;
const IN_B_R: usize = 3;
const IN_XFADE: usize = 4;

pub fn crossfader_manifest() -> Manifest {
    let audio_in = |id: &str, name: &str| JackDecl {
        id: id.into(),
        name: name.into(),
        default: 0.0,
        audio: false,
        capture: false,
        knob: None,
        display: None,
    };
    Manifest {
        id: CROSSFADER_ID.into(),
        name: "Crossfader".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::DJ.into(),
        inputs: vec![
            audio_in("a_l", "A Left"),
            audio_in("a_r", "A Right"),
            audio_in("b_l", "B Left"),
            audio_in("b_r", "B Right"),
            JackDecl {
                id: "xfade".into(),
                name: "Crossfade".into(),
                default: 0.0,
                audio: false,
                capture: false,
                knob: Some(KnobConfig {
                    style: KnobStyle::Continuous,
                    min: -10.0,
                    max: 10.0,
                    curve: Curve::Linear,
                    steps: None,
                }),
                display: None,
            },
        ],
        outputs: vec![
            OutputDecl {
                id: "out_l".into(),
                name: "Out L".into(),
                display: None,
            },
            OutputDecl {
                id: "out_r".into(),
                name: "Out R".into(),
                display: None,
            },
        ],
        params: vec![],
        ui: None,
        latency_samples: 0,
        bypass: Default::default(),
    }
}

/// Equal-power gains for a crossfade signal value in [-10, +10].
pub fn crossfader_gains(xfade: f32) -> (f32, f32) {
    let x = ((xfade + 10.0) / 20.0).clamp(0.0, 1.0);
    let theta = x * std::f32::consts::FRAC_PI_2;
    // f32 `FRAC_PI_2` rounds up, so `cos` undershoots to ~-4.4e-8 at the top
    // of the sweep — a fader hard over would leak a phase-inverted copy of
    // the closed side instead of muting it. The cosine is non-negative
    // across the sweep by construction, so clamping only removes that
    // rounding residue and makes both end stops exactly silent.
    (theta.cos().max(0.0), theta.sin().max(0.0))
}

pub struct CrossfaderModule;

impl HostModule for CrossfaderModule {
    fn process(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        for s in 0..frames {
            let (ga, gb) = crossfader_gains(inputs[IN_XFADE][s]);
            outputs[0][s] = inputs[IN_A_L][s] * ga + inputs[IN_B_L][s] * gb;
            outputs[1][s] = inputs[IN_A_R][s] * ga + inputs[IN_B_R][s] * gb;
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
