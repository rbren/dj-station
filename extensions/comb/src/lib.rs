//! Comb filter: one delay line short enough to be a pitch, tuned in
//! 1 V/oct.
//!
//! `tune` is the comb's fundamental (0 V = C4, like the Filter's cutoff),
//! so the delay is `sample_rate / f` samples and the response combs at
//! every multiple of `f`. Two modes share that line:
//!
//! * `mode = 0` — **feedback** (IIR): `y = x + fb·damp(y[n-d])`. Peaks at
//!   multiples of the tuning for a positive `fb`, at ODD multiples of half
//!   of it for a negative one (the hollow, square-wave-ish comb), and at
//!   high feedback it is a tuned resonator a click can ring like a string.
//! * `mode = 1` — **feedforward** (FIR): `y = x + fb·damp(x[n-d])`, the
//!   flanger comb — the same teeth as notches instead of peaks, and
//!   unconditionally stable at any depth.
//!
//! THE PEAK SITS AT UNITY whatever the feedback, because the input is
//! trimmed by `1 - |fb|` (feedback mode) or `1/(1 + |fb|)` (feedforward)
//! going into the comb rather than the output being turned down after it:
//! the loop then runs at signal level, so nothing in it has to be
//! saturated and a feedback sweep is a change of tone rather than of
//! loudness. At `fb = 0` both modes are an exact pass-through.
//!
//! `damping` is a one-pole lowpass in the delay path — the "each
//! reflection is duller" law the Delay's feedback filter follows — and its
//! own phase delay is subtracted from the read distance, so darkening the
//! comb does not flatten its tuning.
//!
//! The delay line is allocated once in [`Module::new`] and read with
//! linear interpolation at the current tuning every sample, so `tune` is
//! playable at CV rate (a swept comb is the point) instead of being
//! slewed like the Delay's tape head.

use dj_module_sdk::{export_module, pitch_to_hz, InitCtx, Module, ProcessIo};

const IN_SIGNAL: usize = 0;
const IN_TUNE: usize = 1;
const IN_FEEDBACK: usize = 2;
const IN_DAMPING: usize = 3;
const IN_MODE: usize = 4;
const IN_MIX: usize = 5;

/// Longest comb, seconds — the buffer is sized from this and [`MIN_HZ`]
/// is what the tuning is clamped to.
const MAX_DELAY_SECS: f32 = 0.3;
const MIN_HZ: f32 = 4.0;
/// Feedback ceiling: an exactly unity loop would ring forever and the
/// input trim would close completely.
const MAX_FEEDBACK: f32 = 0.98;
const OUT_CLAMP: f32 = 15.0;

/// Guard on what enters the delay line. A HARD clamp, not a saturator: a
/// tanh knee is already several percent down at ±5 V, and losing that much
/// loop gain every pass audibly flattens the resonance. The input trim
/// keeps the loop near signal level, so this only ever catches
/// pathological CV.
#[inline]
fn guard(x: f32) -> f32 {
    if x.is_finite() {
        x.clamp(-OUT_CLAMP, OUT_CLAMP)
    } else {
        0.0
    }
}

/// One-pole coefficient for a cutoff in Hz.
#[inline]
fn one_pole_coeff(hz: f32, sample_rate: f32) -> f32 {
    let x = (-core::f32::consts::TAU * hz / sample_rate).exp();
    (1.0 - x).clamp(0.001, 1.0)
}

pub struct Comb {
    sample_rate: f32,
    buf: Vec<f32>,
    mask: usize,
    write: usize,
    /// Damping one-pole state.
    lp: f32,
    max_delay: f32,
    min_hz: f32,
}

impl Comb {
    /// Linear-interpolated read `delay` samples behind the write head.
    /// The head holds the value written on the PREVIOUS sample, so the
    /// round trip through the line is `delay + 1` samples.
    #[inline]
    fn read(&self, delay: f32) -> f32 {
        let d = delay.clamp(1.0, self.max_delay);
        let i = d as usize;
        let frac = d - i as f32;
        let len = self.buf.len();
        let a = self.buf[(self.write + len - i) & self.mask];
        let b = self.buf[(self.write + len - i - 1) & self.mask];
        a + (b - a) * frac
    }

    #[inline]
    fn push(&mut self, v: f32) {
        self.write = (self.write + 1) & self.mask;
        self.buf[self.write] = v;
    }
}

impl Module for Comb {
    const N_INPUTS: usize = 6;
    const N_OUTPUTS: usize = 1;

    fn new(ctx: &InitCtx) -> Self {
        let needed = (MAX_DELAY_SECS * ctx.sample_rate) as usize + 4;
        let len = needed.next_power_of_two();
        let max_delay = (len - 4) as f32;
        Comb {
            sample_rate: ctx.sample_rate,
            buf: vec![0.0; len],
            mask: len - 1,
            write: 0,
            lp: 0.0,
            max_delay,
            min_hz: MIN_HZ.max(ctx.sample_rate / max_delay),
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        // The damping coefficient costs an exp() and the mode is a
        // selector, so both are read once per block (the Delay's
        // granularity); tuning, feedback and mix are read per sample.
        let damp_a = one_pole_coeff(
            io.inputs[IN_DAMPING][0].clamp(20.0, 0.45 * self.sample_rate),
            self.sample_rate,
        );
        // What the round trip costs before the delay line gets a say: the
        // one-pole's own group delay at low frequencies plus the sample
        // between the write head and the read. Take both off the requested
        // distance, so darkening the comb never flattens its tuning.
        let head_start = (1.0 - damp_a) / damp_a + 1.0;
        let feedforward = io.inputs[IN_MODE][0] >= 0.5;

        for s in 0..n {
            let x = io.inputs[IN_SIGNAL][s];
            let hz = pitch_to_hz(io.inputs[IN_TUNE][s].clamp(-12.0, 12.0))
                .clamp(self.min_hz, 0.5 * self.sample_rate);
            let delay = (self.sample_rate / hz - head_start).clamp(1.0, self.max_delay);
            let fb = io.inputs[IN_FEEDBACK][s].clamp(-MAX_FEEDBACK, MAX_FEEDBACK);
            let mix = io.inputs[IN_MIX][s].clamp(0.0, 1.0);

            let delayed = self.read(delay);
            self.lp += damp_a * (delayed - self.lp);
            let damped = self.lp;

            let wet = if feedforward {
                let trim = 1.0 / (1.0 + fb.abs());
                self.push(guard(x));
                trim * (x + fb * damped)
            } else {
                let trim = 1.0 - fb.abs();
                let y = trim * x + fb * damped;
                self.push(guard(y));
                y
            };

            io.outputs[0][s] = (x * (1.0 - mix) + wet * mix).clamp(-OUT_CLAMP, OUT_CLAMP);
        }

        if !self.lp.is_finite() {
            self.lp = 0.0;
        }
    }
}

export_module!(Comb);
