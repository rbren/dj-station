//! Waveshaper: wavefolder, saturator, bitcrusher and sample-rate reducer
//! behind one mode switch.
//!
//! * `mode = 0` — **Fold**: west-coast style repeated folding,
//!   `sin(a * x)` with `a` growing with drive, so the signal folds back on
//!   itself more times the harder it is driven.
//! * `mode = 1` — **Saturate**: `tanh(d * x)`, normalized so low drive is
//!   near unity gain.
//! * `mode = 2` — **Crush**: quantize to N bits, N sweeping 16 -> 1.
//! * `mode = 3` — **Rate**: sample-and-hold decimation, holding every
//!   1 .. 128 samples.
//!
//! The two continuous shapers (fold, saturate) run first-order
//! antiderivative antialiasing (ADAA): instead of the nonlinearity itself
//! the module evaluates the average of the nonlinearity over the segment
//! between the previous and current sample, using the closed-form
//! antiderivative. That drops fold/saturation aliasing by tens of dB
//! without oversampling or latency. Crush and rate reduction alias on
//! purpose — that is the sound — and are left raw.
//!
//! `bias` shifts the signal into the shaper (asymmetric folding / a moved
//! quantization grid); the shaper's response to the bias alone is
//! subtracted afterwards so silence in stays silence out.
//!
//! Everything is computed in normalized units (±1 == ±5 V) and scaled back
//! out by `level`, which keeps the folder usable at high drive.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_SIGNAL: usize = 0;
const IN_MODE: usize = 1;
const IN_DRIVE: usize = 2;
const IN_BIAS: usize = 3;
const IN_LEVEL: usize = 4;

const MODE_SATURATE: u32 = 1;
const MODE_CRUSH: u32 = 2;
const MODE_RATE: u32 = 3;

/// Audio full scale in volts; the shapers work on `x / VOLT_SCALE`.
const VOLT_SCALE: f32 = 5.0;
/// Below this input step the ADAA difference quotient is ill-conditioned
/// and the direct nonlinearity (at the segment midpoint) is used instead.
const ADAA_EPS: f64 = 1e-5;
/// Longest sample-and-hold period of the rate reducer, in samples.
const MAX_HOLD: f32 = 128.0;

#[inline]
fn fold(x: f64, a: f64) -> f64 {
    (a * x).sin()
}

/// Antiderivative of [`fold`].
#[inline]
fn fold_int(x: f64, a: f64) -> f64 {
    -(a * x).cos() / a
}

#[inline]
fn saturate(x: f64, d: f64) -> f64 {
    (d * x).tanh()
}

/// Antiderivative of [`saturate`]: `ln(cosh(d x)) / d`, in the overflow-free
/// form `|u| + ln(1 + e^-2|u|) - ln 2`.
#[inline]
fn saturate_int(x: f64, d: f64) -> f64 {
    let u = (d * x).abs();
    (u + (-2.0 * u).exp().ln_1p() - core::f64::consts::LN_2) / d
}

pub struct Waveshaper {
    /// Previous shaper input (normalized, bias included).
    x_prev: f64,
    /// Rate reducer: held sample and fractional-rate accumulator.
    held: f32,
    acc: f32,
}

impl Waveshaper {
    /// First-order ADAA of `f` given its antiderivative `f_int`.
    #[inline]
    fn adaa(&self, x: f64, param: f64, f: fn(f64, f64) -> f64, f_int: fn(f64, f64) -> f64) -> f64 {
        let dx = x - self.x_prev;
        if dx.abs() > ADAA_EPS {
            (f_int(x, param) - f_int(self.x_prev, param)) / dx
        } else {
            f(0.5 * (x + self.x_prev), param)
        }
    }
}

impl Module for Waveshaper {
    const N_INPUTS: usize = 5;
    const N_OUTPUTS: usize = 1;

    fn new(_ctx: &InitCtx) -> Self {
        Waveshaper {
            x_prev: 0.0,
            held: 0.0,
            acc: 1.0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        for s in 0..n {
            let mode = (io.inputs[IN_MODE][s] + 0.5).clamp(0.0, 3.0) as u32;
            let drive = io.inputs[IN_DRIVE][s].clamp(0.0, 10.0);
            let bias = (io.inputs[IN_BIAS][s] / VOLT_SCALE) as f64;
            let level = io.inputs[IN_LEVEL][s].clamp(0.0, 4.0);
            let x = (io.inputs[IN_SIGNAL][s] / VOLT_SCALE) as f64 + bias;

            let y = match mode {
                MODE_SATURATE => {
                    let d = 1.0 + 0.9 * drive as f64;
                    let norm = 1.0 / saturate(1.0, d);
                    (self.adaa(x, d, saturate, saturate_int) - saturate(bias, d)) * norm
                }
                MODE_CRUSH => {
                    let bits = 16.0 - 1.5 * drive;
                    let half = (2.0f32).powf(bits - 1.0) as f64;
                    ((x * half).round() - (bias * half).round()) / half
                }
                MODE_RATE => {
                    let hold = 1.0 + (drive * 0.1) * (drive * 0.1) * (MAX_HOLD - 1.0);
                    self.acc += 1.0 / hold;
                    if self.acc >= 1.0 {
                        self.acc -= 1.0;
                        self.held = x as f32;
                    }
                    self.held as f64 - bias
                }
                // Fold (mode 0) is also the fallback for out-of-range values.
                _ => {
                    let a = core::f64::consts::FRAC_PI_2 * (1.0 + drive as f64);
                    self.adaa(x, a, fold, fold_int) - fold(bias, a)
                }
            };
            self.x_prev = x;
            io.outputs[0][s] = (y as f32 * VOLT_SCALE * level).clamp(-10.0, 10.0);
        }
    }
}

export_module!(Waveshaper);
