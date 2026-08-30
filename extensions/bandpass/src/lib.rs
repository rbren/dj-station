//! Band pass: one band, taken seriously.
//!
//! The Filter module's `bp` jack is a band-pass among four outputs whose
//! level rides with its resonance; this module is the dedicated one — a
//! CONSTANT-PEAK-GAIN band-pass, so `q` changes how wide a band survives
//! and never how loud it is. That is what makes it usable as a sweepable
//! isolator or a formant: turning the band from two octaves wide down to a
//! whistle leaves the peak at unity throughout.
//!
//! `freq` is the centre in 1 V/oct (0 V = C4, the same pitch law as the
//! Filter's cutoff), read PER SAMPLE, so an envelope or an audio-rate
//! modulator on it is a sweep rather than a staircase. `q` is the ratio of
//! centre frequency to -3 dB bandwidth: 0.5 is nearly two octaves wide, 40
//! is a hair.
//!
//! `slope` picks one 2-pole section (12 dB/oct skirts) or two identical
//! ones in series (24 dB/oct, and correspondingly tighter for the same
//! `q`). Each section is a topology-preserving-transform (Cytomic) state
//! variable filter whose band-pass tap is scaled by `1/q`, which is what
//! puts the peak at exactly unity; nothing in the signal path saturates,
//! and the filter never self-oscillates — that is the Filter module's job.
//!
//! `mix` blends the band back with the dry signal: full wet is a band-pass,
//! part way is a resonant emphasis, and 0 is the input untouched.

use dj_module_sdk::{export_module, pitch_to_hz, InitCtx, Module, ProcessIo};

const IN_SIGNAL: usize = 0;
const IN_FREQ: usize = 1;
const IN_Q: usize = 2;
const IN_SLOPE: usize = 3;
const IN_MIX: usize = 4;

const MIN_HZ: f32 = 4.0;
const MIN_Q: f32 = 0.5;
const MAX_Q: f32 = 40.0;
/// Belt-and-braces output clamp; a unity-peak band-pass stays far below.
const OUT_CLAMP: f32 = 15.0;

/// One TPT state-variable section, band-pass tap only.
#[derive(Clone, Copy, Default)]
struct Svf {
    ic1: f32,
    ic2: f32,
}

impl Svf {
    /// `g = tan(pi f0 / sr)`, `k = 1/Q`. Returns the band-pass output
    /// already scaled to unity peak gain.
    #[inline]
    fn tick(&mut self, x: f32, g: f32, k: f32) -> f32 {
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;
        let v3 = x - self.ic2;
        let bp = a1 * self.ic1 + a2 * v3;
        let lp = self.ic2 + a2 * self.ic1 + a3 * v3;
        self.ic1 = 2.0 * bp - self.ic1;
        self.ic2 = 2.0 * lp - self.ic2;
        k * bp
    }
}

pub struct BandPass {
    sample_rate: f32,
    max_hz: f32,
    stages: [Svf; 2],
}

impl Module for BandPass {
    const N_INPUTS: usize = 5;
    const N_OUTPUTS: usize = 1;

    fn new(ctx: &InitCtx) -> Self {
        BandPass {
            sample_rate: ctx.sample_rate,
            max_hz: 0.45 * ctx.sample_rate,
            stages: [Svf::default(); 2],
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        for s in 0..n {
            let x = io.inputs[IN_SIGNAL][s];
            let f0 =
                pitch_to_hz(io.inputs[IN_FREQ][s].clamp(-12.0, 12.0)).clamp(MIN_HZ, self.max_hz);
            let g = (core::f32::consts::PI * f0 / self.sample_rate).tan();
            let k = 1.0 / io.inputs[IN_Q][s].clamp(MIN_Q, MAX_Q);
            let four_pole = io.inputs[IN_SLOPE][s] >= 0.5;
            let mix = io.inputs[IN_MIX][s].clamp(0.0, 1.0);

            let mut wet = self.stages[0].tick(x, g, k);
            if four_pole {
                wet = self.stages[1].tick(wet, g, k);
            }
            io.outputs[0][s] = (x * (1.0 - mix) + wet * mix).clamp(-OUT_CLAMP, OUT_CLAMP);
        }

        // Numerical hygiene: only a pathological CV burst can poison the
        // states, so recover once per block rather than per sample.
        if !self
            .stages
            .iter()
            .all(|s| s.ic1.is_finite() && s.ic2.is_finite())
        {
            self.stages = [Svf::default(); 2];
        }
    }
}

export_module!(BandPass);
