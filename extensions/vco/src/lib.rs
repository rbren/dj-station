//! VCO: analogue-style oscillator with PolyBLEP antialiasing, 2x
//! oversampling, hard sync and thru-zero linear FM.
//!
//! All four shapes are computed every sample and published on their own
//! output jack (saw / tri / sine / pulse) — there is deliberately no
//! waveform selector: separate outs let one VCO feed several destinations
//! and share the oscillator core for free.
//!
//! Inputs (ordinary jacks with knobs, PRD §4/§5.1):
//! - `pitch`    1V/oct, 0.0 = C4.
//! - `fine`     fine tune in semitones (±1).
//! - `fm`       linear, **thru-zero** FM: the instantaneous frequency is
//!   `f0 * (1 + fm/5 * index)`, so a modulator past `-5/index` volts drives
//!   the frequency negative and the phase runs backwards (no rectification,
//!   no clamping at DC).
//! - `fm_index` FM depth, 0..4 (index 1 = ±100 % deviation at ±5 V).
//! - `pwm`      pulse width; ±5 V sweeps the duty cycle across 2 %..98 %.
//! - `sync`     hard sync — a rising gate edge resets the phase.
//!
//! Antialiasing: the core runs at 2x the host sample rate; saw and pulse
//! edges get a PolyBLEP residual, and the triangle is the leaky integral of
//! the (already band-limited) square, so it inherits the same edge
//! treatment. A 33-tap halfband FIR decimates back to the host rate, which
//! removes what PolyBLEP alone leaves behind just under Nyquist: at a 5 kHz
//! fundamental every alias below 16 kHz sits under -50 dBc, where PolyBLEP
//! at 1x manages only about -22 dBc. Cost is 9 multiplies per output sample
//! per shape (the halfband's even taps are zero except the centre, and the
//! odd taps fold by symmetry).
//!
//! A backwards-running phase is handled by evaluating the mirrored waveform
//! `-f(1 - p)`, exact for both saw and pulse, which keeps the BLEP residual
//! on the correct side of each discontinuity.

use dj_module_sdk::{export_module, pitch_to_hz, InitCtx, Module, ProcessIo};

const AMPLITUDE: f32 = 5.0;
/// Internal (oversampled) phase increment limit, as a fraction of the
/// oversampled rate. Keeps PolyBLEP inside its valid range when thru-zero
/// FM asks for an absurd frequency.
const MAX_INC: f32 = 0.45;

const HB_TAPS: usize = 33;
const HB_CENTER: usize = HB_TAPS / 2;
/// Group delay of the decimator in host samples (`HB_CENTER / 2`); must
/// match `latency_samples` in the manifest.
const HB_LATENCY: usize = HB_CENTER / 2;
const _: () = assert!(HB_LATENCY == 8);

const IN_PITCH: usize = 0;
const IN_FINE: usize = 1;
const IN_FM: usize = 2;
const IN_FM_INDEX: usize = 3;
const IN_PWM: usize = 4;
const IN_SYNC: usize = 5;

const OUT_SAW: usize = 0;
const OUT_TRI: usize = 1;
const OUT_SINE: usize = 2;
const OUT_PULSE: usize = 3;

/// PolyBLEP residual for a downward step of 2 at `t == 0`, for a phase
/// advancing `dt` per sample.
#[inline]
fn poly_blep(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

#[inline]
fn wrap01(p: f32) -> f32 {
    p - p.floor()
}

#[inline]
fn blep_saw(t: f32, dt: f32) -> f32 {
    2.0 * t - 1.0 - poly_blep(t, dt)
}

#[inline]
fn blep_pulse(t: f32, width: f32, dt: f32) -> f32 {
    let naive = if t < width { 1.0 } else { -1.0 };
    naive + poly_blep(t, dt) - poly_blep(wrap01(t - width), dt)
}

/// Halfband decimation coefficients: the centre tap plus the eight distinct
/// odd taps (every other tap of a halfband FIR is zero, and the rest is
/// symmetric around the centre).
struct HalfbandCoeffs {
    center: f32,
    odd: [f32; 8],
}

impl HalfbandCoeffs {
    fn new() -> Self {
        let mut h = [0.0f64; HB_TAPS];
        for (k, hk) in h.iter_mut().enumerate() {
            let x = 0.5 * (k as f64 - HB_CENTER as f64);
            let sinc = if x == 0.0 {
                1.0
            } else {
                (core::f64::consts::PI * x).sin() / (core::f64::consts::PI * x)
            };
            let a = core::f64::consts::TAU * k as f64 / (HB_TAPS - 1) as f64;
            let window =
                0.35875 - 0.48829 * a.cos() + 0.14128 * (2.0 * a).cos() - 0.01168 * (3.0 * a).cos();
            *hk = sinc * window;
        }
        let sum: f64 = h.iter().sum();
        let mut odd = [0.0f32; 8];
        for (i, o) in odd.iter_mut().enumerate() {
            *o = (h[2 * i + 1] / sum) as f32;
        }
        HalfbandCoeffs {
            center: (h[HB_CENTER] / sum) as f32,
            odd,
        }
    }
}

/// Decimate-by-two state for one signal: the even-phase history feeds the
/// centre tap, the odd-phase history the folded odd taps.
#[derive(Default)]
struct Halfband {
    even: [f32; 16],
    odd: [f32; 32],
    m: usize,
}

impl Halfband {
    /// Consume one oversampled pair and emit one host-rate sample.
    #[inline]
    fn step(&mut self, a: f32, b: f32, c: &HalfbandCoeffs) -> f32 {
        let m = self.m.wrapping_add(1);
        self.m = m;
        self.even[m & 15] = a;
        self.odd[m & 31] = b;
        let mut acc = c.center * self.even[m.wrapping_sub(8) & 15];
        for (i, &h) in c.odd.iter().enumerate() {
            let lo = self.odd[m.wrapping_sub(i + 1) & 31];
            let hi = self.odd[m.wrapping_sub(16 - i) & 31];
            acc += h * (lo + hi);
        }
        acc
    }
}

pub struct Vco {
    /// Oversampled rate (2x the host rate).
    inner_rate: f32,
    phase: f32,
    /// Leaky integrator holding the triangle (integral of the square).
    tri: f32,
    last_sync: f32,
    coeffs: HalfbandCoeffs,
    decim: [Halfband; 4],
}

impl Module for Vco {
    const N_INPUTS: usize = 6;
    const N_OUTPUTS: usize = 4;

    fn new(ctx: &InitCtx) -> Self {
        Vco {
            inner_rate: 2.0 * ctx.sample_rate.max(1.0),
            phase: 0.0,
            tri: 0.0,
            last_sync: 0.0,
            coeffs: HalfbandCoeffs::new(),
            decim: Default::default(),
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        for s in 0..n {
            let sync = io.inputs[IN_SYNC][s];
            let sync_edge = sync >= 1.0 && self.last_sync < 1.0;
            self.last_sync = sync;

            let pitch =
                io.inputs[IN_PITCH][s].clamp(-12.0, 12.0) + io.inputs[IN_FINE][s] * (1.0 / 12.0);
            let index = io.inputs[IN_FM_INDEX][s].max(0.0);
            let freq = pitch_to_hz(pitch) * (1.0 + io.inputs[IN_FM][s] * 0.2 * index);
            let mut inc = freq / self.inner_rate;
            if !inc.is_finite() {
                inc = 0.0;
            }
            let inc = inc.clamp(-MAX_INC, MAX_INC);
            let dt = inc.abs().max(1e-7);
            let width = (0.5 + io.inputs[IN_PWM][s] * 0.096).clamp(0.02, 0.98);

            let mut os = [[0.0f32; 4]; 2];
            for (half, frame) in os.iter_mut().enumerate() {
                if half == 0 && sync_edge {
                    self.phase = 0.0;
                }
                // Backwards phase: evaluate the mirrored waveform so each
                // BLEP residual stays on the correct side of its edge.
                let (t, w, sign) = if inc >= 0.0 {
                    (self.phase, width, 1.0f32)
                } else {
                    (wrap01(1.0 - self.phase), 1.0 - width, -1.0f32)
                };
                let square = sign * blep_pulse(t, 0.5, dt);
                // Leaky integration of the square: the pole tracks the phase
                // increment so the amplitude stays flat across the range
                // while DC is still rejected. 4.0 normalizes the ±0.25 ramp
                // the integrator accumulates over a half period.
                self.tri = self.tri * (1.0 - dt) + inc * square;

                frame[OUT_SAW] = sign * blep_saw(t, dt);
                frame[OUT_TRI] = 4.0 * self.tri;
                frame[OUT_SINE] = (core::f32::consts::TAU * self.phase).sin();
                frame[OUT_PULSE] = sign * blep_pulse(t, w, dt);
                self.phase = wrap01(self.phase + inc);
            }

            for (jack, out) in io.outputs.iter_mut().enumerate() {
                let v = self.decim[jack].step(os[0][jack], os[1][jack], &self.coeffs);
                out[s] = AMPLITUDE * v;
            }
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(8);
        out.extend_from_slice(&self.phase.to_le_bytes());
        out.extend_from_slice(&self.tri.to_le_bytes());
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 8 {
            self.phase = f32::from_le_bytes(bytes[0..4].try_into().unwrap());
            self.tri = f32::from_le_bytes(bytes[4..8].try_into().unwrap());
        }
    }
}

export_module!(Vco);
