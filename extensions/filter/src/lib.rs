//! Multimode filter with three selectable topologies sharing one per-sample
//! framework.
//!
//! * `topology = 0` — **SVF**: a clean topology-preserving-transform (ZDF)
//!   state-variable filter (Cytomic form). LP/BP/HP/notch come out of the
//!   same two integrators simultaneously, so the four output jacks are
//!   always live.
//! * `topology = 1` — **Ladder**: four cascaded one-pole TPT stages with a
//!   zero-delay global feedback path and saturating integrator states
//!   (transistor-ladder flavour). The LP/BP/HP/notch jacks are the classic
//!   Oberheim-style weighted sums of the stage taps.
//! * `topology = 2` — **OTA**: the SVF core with a saturating resonance
//!   state, which squashes the resonant peak as it gets loud the way an
//!   OTA/diode-limited filter does.
//!
//! Cutoff is exponential (1 V/oct, 0 = C4) from the `cutoff` knob plus the
//! `cutoff_cv` jack. Resonance runs from gently damped up to
//! self-oscillation: at the top of the range the damping term goes slightly
//! negative and a Van-der-Pol style amplitude term (`NL_DAMP`) brings the
//! loop back to unity gain, so with no input the filter sings a clean ~5 V
//! sine at the cutoff frequency instead of blowing up or dying out.
//!
//! `drive` is a pre-gain into the core. In SVF mode it is transparent
//! (linear); in ladder/OTA mode it pushes the saturating stages.

use dj_module_sdk::{export_module, pitch_to_hz, InitCtx, Module, ProcessIo};

const IN_SIGNAL: usize = 0;
const IN_CUTOFF: usize = 1;
const IN_CUTOFF_CV: usize = 2;
const IN_RES: usize = 3;
const IN_RES_CV: usize = 4;
const IN_DRIVE: usize = 5;
const IN_TOPOLOGY: usize = 6;

const OUT_LP: usize = 0;
const OUT_BP: usize = 1;
const OUT_HP: usize = 2;
const OUT_NOTCH: usize = 3;

/// Damping at zero resonance (Q = 0.5) and the slope that takes it just
/// below zero at full resonance, where the filter self-oscillates.
const DAMP_MAX: f32 = 2.0;
const DAMP_SLOPE: f32 = 2.05;
/// Amplitude-dependent damping: `NL_DAMP * (bp / 5 V)^2`. Zero net damping
/// at 5 V when the linear term sits at its most negative (-0.05).
const NL_DAMP: f32 = 0.05;
/// Ladder feedback at full resonance (self-oscillates just above 4).
const LADDER_K: f32 = 4.15;
/// Soft-saturation knee for the nonlinear topologies, in volts.
const SAT_LEVEL: f32 = 6.0;
/// Belt-and-braces output clamp; the nonlinearities keep things far below.
const OUT_CLAMP: f32 = 15.0;

const MIN_HZ: f32 = 4.0;
/// One-shot kick that starts self-oscillation from rest (millivolts).
const SEED: f32 = 0.05;

#[inline]
fn sat(x: f32) -> f32 {
    SAT_LEVEL * (x / SAT_LEVEL).tanh()
}

pub struct Filter {
    sample_rate: f32,
    max_hz: f32,
    /// SVF/OTA integrator states.
    ic1: f32,
    ic2: f32,
    /// Previous bandpass value, used by the amplitude-dependent damping.
    bp_prev: f32,
    /// Ladder one-pole states.
    l: [f32; 4],
}

impl Filter {
    #[inline]
    fn damping(&self, res: f32) -> f32 {
        let linear = DAMP_MAX - DAMP_SLOPE * res;
        let bpn = self.bp_prev * 0.2;
        (linear + NL_DAMP * bpn * bpn).clamp(-0.5, DAMP_MAX)
    }

    /// Cytomic-form ZDF state-variable filter. `saturate` swaps in the OTA
    /// flavour by soft-clipping the resonance state.
    #[inline]
    fn svf(&mut self, x: f32, g: f32, k: f32, saturate: bool) -> [f32; 4] {
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;
        let ic1 = if saturate { sat(self.ic1) } else { self.ic1 };
        let v3 = x - self.ic2;
        let bp = a1 * ic1 + a2 * v3;
        let lp = self.ic2 + a2 * ic1 + a3 * v3;
        self.ic1 = 2.0 * bp - self.ic1;
        self.ic2 = 2.0 * lp - self.ic2;
        self.bp_prev = bp;
        let hp = x - k * bp - lp;
        [lp, bp, hp, hp + lp]
    }

    /// Four one-pole TPT stages with ZDF global feedback and saturated
    /// states. Outputs are the Oberheim stage-tap mixes.
    #[inline]
    fn ladder(&mut self, x: f32, g: f32, k: f32) -> [f32; 4] {
        let big_g = g / (1.0 + g);
        let one_minus = 1.0 - big_g;
        let s: [f32; 4] = [
            sat(self.l[0]),
            sat(self.l[1]),
            sat(self.l[2]),
            sat(self.l[3]),
        ];
        let g2 = big_g * big_g;
        let g4 = g2 * g2;
        let state_sum = one_minus * (g2 * big_g * s[0] + g2 * s[1] + big_g * s[2] + s[3]);
        // Solve the feedback loop: y4 = G^4 * (x - k*y4) + state_sum.
        let y4_zdf = (g4 * x + state_sum) / (1.0 + k * g4);
        let u = x - k * y4_zdf;

        let v0 = big_g * (u - s[0]);
        let y1 = s[0] + v0;
        self.l[0] = y1 + v0;
        let v1 = big_g * (y1 - s[1]);
        let y2 = s[1] + v1;
        self.l[1] = y2 + v1;
        let v2 = big_g * (y2 - s[2]);
        let y3 = s[2] + v2;
        self.l[2] = y3 + v2;
        let v3 = big_g * (y3 - s[3]);
        let y4 = s[3] + v3;
        self.l[3] = y4 + v3;

        self.bp_prev = y2 - y4;
        let lp = y4;
        let bp = 4.0 * (y2 - 2.0 * y3 + y4);
        let hp = u - 4.0 * y1 + 6.0 * y2 - 4.0 * y3 + y4;
        let notch = u - 2.0 * y1 + 2.0 * y2;
        [lp, bp, hp, notch]
    }
}

impl Module for Filter {
    const N_INPUTS: usize = 7;
    const N_OUTPUTS: usize = 4;

    fn new(ctx: &InitCtx) -> Self {
        Filter {
            sample_rate: ctx.sample_rate,
            max_hz: 0.45 * ctx.sample_rate,
            ic1: 0.0,
            ic2: 0.0,
            bp_prev: 0.0,
            l: [0.0; 4],
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        for s in 0..n {
            let topology = (io.inputs[IN_TOPOLOGY][s] + 0.5).clamp(0.0, 2.0) as u32;
            let drive = io.inputs[IN_DRIVE][s].clamp(0.0, 20.0);
            let x = io.inputs[IN_SIGNAL][s] * drive;

            let pitch = io.inputs[IN_CUTOFF][s] + io.inputs[IN_CUTOFF_CV][s];
            let fc = pitch_to_hz(pitch.clamp(-12.0, 12.0)).clamp(MIN_HZ, self.max_hz);
            let g = (core::f32::consts::PI * fc / self.sample_rate).tan();

            let res = (io.inputs[IN_RES][s] + 0.1 * io.inputs[IN_RES_CV][s]).clamp(0.0, 1.0);

            let ladder_k = LADDER_K * res;
            let svf_k = self.damping(res);
            // A real filter starts self-oscillating on its own noise floor.
            // Give the loop one deterministic nudge when it has net gain and
            // the state is at rest, so "no input, resonance up" sings.
            let at_rest =
                self.ic1.abs() + self.ic2.abs() + self.l.iter().map(|v| v.abs()).sum::<f32>()
                    < 1e-4;
            let has_gain = if topology == 1 {
                ladder_k > 4.0
            } else {
                svf_k < 0.0
            };
            let x = if at_rest && has_gain { x + SEED } else { x };

            let out = match topology {
                1 => self.ladder(x, g, ladder_k),
                2 => self.svf(x, g, svf_k, true),
                _ => self.svf(x, g, svf_k, false),
            };

            io.outputs[OUT_LP][s] = out[0].clamp(-OUT_CLAMP, OUT_CLAMP);
            io.outputs[OUT_BP][s] = out[1].clamp(-OUT_CLAMP, OUT_CLAMP);
            io.outputs[OUT_HP][s] = out[2].clamp(-OUT_CLAMP, OUT_CLAMP);
            io.outputs[OUT_NOTCH][s] = out[3].clamp(-OUT_CLAMP, OUT_CLAMP);
        }

        // Numerical hygiene: a pathological CV burst can only ever poison the
        // states, so recover once per block rather than per sample.
        if !(self.ic1.is_finite() && self.ic2.is_finite() && self.l.iter().all(|v| v.is_finite())) {
            self.ic1 = 0.0;
            self.ic2 = 0.0;
            self.bp_prev = 0.0;
            self.l = [0.0; 4];
        }
    }
}

export_module!(Filter);
