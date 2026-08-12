//! Four-band parametric EQ: four RBJ peaking-bell biquads in series.
//!
//! Each band has a frequency (1 V/oct, 0 = C4 — same pitch law as the
//! filter's cutoff), a gain in dB (the jack value IS the dB amount) and a
//! Q that sets how wide a band the bell governs (higher Q = narrower).
//! A band at 0 dB is an exact pass-through whatever its Q, so unused
//! bands are free.
//!
//! Coefficients are recomputed at block rate from each parameter block's
//! first sample (knob edits and wire modulation both arrive smoothly at
//! that granularity), with a small epsilon so an idle patch recomputes
//! nothing. The biquads run Direct Form II transposed, which keeps state
//! magnitudes near the signal level.

use dj_module_sdk::{export_module, pitch_to_hz, InitCtx, Module, ProcessIo};

const IN_SIGNAL: usize = 0;
/// Per-band jacks follow as (freq, gain, q) triples: band b at
/// `1 + 3*b + {0,1,2}`.
const BANDS: usize = 4;

const MIN_HZ: f32 = 20.0;
const MAX_GAIN_DB: f32 = 15.0;
const MIN_Q: f32 = 0.2;
const MAX_Q: f32 = 12.0;
/// Parameter change below this does not trigger a coefficient recompute.
const EPS: f32 = 1e-4;

#[derive(Clone, Copy, Default)]
struct Band {
    // Cached raw params (pitch V, dB, Q) for the change check.
    pitch: f32,
    gain_db: f32,
    q: f32,
    // RBJ peaking coefficients, normalized by a0.
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    // DF2T state.
    z1: f32,
    z2: f32,
    fresh: bool,
}

impl Band {
    fn recompute(&mut self, pitch: f32, gain_db: f32, q: f32, sample_rate: f32, max_hz: f32) {
        if self.fresh
            && (self.pitch - pitch).abs() < EPS
            && (self.gain_db - gain_db).abs() < EPS
            && (self.q - q).abs() < EPS
        {
            return;
        }
        self.fresh = true;
        self.pitch = pitch;
        self.gain_db = gain_db;
        self.q = q;

        let f0 = pitch_to_hz(pitch).clamp(MIN_HZ, max_hz);
        let a = 10.0f32.powf(gain_db.clamp(-MAX_GAIN_DB, MAX_GAIN_DB) / 40.0);
        let q = q.clamp(MIN_Q, MAX_Q);
        let w0 = core::f32::consts::TAU * f0 / sample_rate;
        let (sin, cos) = (w0.sin(), w0.cos());
        let alpha = sin / (2.0 * q);

        let a0 = 1.0 + alpha / a;
        self.b0 = (1.0 + alpha * a) / a0;
        self.b1 = -2.0 * cos / a0;
        self.b2 = (1.0 - alpha * a) / a0;
        self.a1 = -2.0 * cos / a0;
        self.a2 = (1.0 - alpha / a) / a0;
    }

    #[inline]
    fn tick(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

pub struct Eq {
    sample_rate: f32,
    max_hz: f32,
    bands: [Band; BANDS],
}

impl Module for Eq {
    const N_INPUTS: usize = 1 + 3 * BANDS;
    const N_OUTPUTS: usize = 1;

    fn new(ctx: &InitCtx) -> Self {
        Eq {
            sample_rate: ctx.sample_rate,
            max_hz: 0.45 * ctx.sample_rate,
            bands: [Band::default(); BANDS],
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        for (b, band) in self.bands.iter_mut().enumerate() {
            let base = 1 + 3 * b;
            band.recompute(
                io.inputs[base][0],
                io.inputs[base + 1][0],
                io.inputs[base + 2][0],
                self.sample_rate,
                self.max_hz,
            );
        }
        for s in 0..n {
            let mut x = io.inputs[IN_SIGNAL][s];
            for band in self.bands.iter_mut() {
                x = band.tick(x);
            }
            io.outputs[0][s] = x.clamp(-15.0, 15.0);
        }
    }
}

export_module!(Eq);
