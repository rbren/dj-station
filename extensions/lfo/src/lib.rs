//! LFO: seven shapes, 0.01 Hz to audio rate, free-running or clock-synced.
//!
//! Shapes (`shape` jack): 0 sine, 1 triangle, 2 saw up, 3 saw down,
//! 4 pulse (with `pw` pulse width), 5 stepped random (sample & hold),
//! 6 smooth random (interpolated). The discontinuous shapes are
//! PolyBLEP/PolyBLAMP corrected, so the LFO stays clean when it is pushed
//! into the audio band and used as an oscillator.
//!
//! Rate is the `rate` knob multiplied by `2^rate_cv`, i.e. the CV input is
//! 1 V/oct. With a wire in `clock`, the rate instead locks to the measured
//! clock period times the `ratio` selector (/8 /4 /3 /2 x1 x2 x3 x4 x8) and
//! the phase realigns on the appropriate clock edge. `reset` restarts the
//! cycle from phase 0.
//!
//! Outputs: `bi` (-5..+5), `uni` (0..10) and `shifted`, a bipolar copy
//! lagging by the `phase` knob (0..1 cycle). The lag is a delay rather than
//! a lead so the random shapes can be shifted without predicting the
//! future: the module keeps the previous, current and next random values.
//!
//! Randomness is a fixed-seed xorshift32 — same patch, same wiggle, every
//! time.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_RATE: usize = 0;
const IN_RATE_CV: usize = 1;
const IN_SHAPE: usize = 2;
const IN_PW: usize = 3;
const IN_CLOCK: usize = 4;
const IN_RATIO: usize = 5;
const IN_RESET: usize = 6;
const IN_PHASE: usize = 7;

const OUT_BI: usize = 0;
const OUT_UNI: usize = 1;
const OUT_SHIFTED: usize = 2;

const SHAPE_TRI: u32 = 1;
const SHAPE_SAW_UP: u32 = 2;
const SHAPE_SAW_DOWN: u32 = 3;
const SHAPE_PULSE: u32 = 4;
const SHAPE_SH: u32 = 5;
const SHAPE_SMOOTH: u32 = 6;

const AMPLITUDE: f32 = 5.0;
const RATIOS: [f32; 9] = [0.125, 0.25, 1.0 / 3.0, 0.5, 1.0, 2.0, 3.0, 4.0, 8.0];
const SEED: u32 = 0x05EE_D1F0;

/// Polynomial band-limited step: corrects a unit-height-times-2 jump.
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

/// Polynomial band-limited ramp: the integral of [`poly_blep`], used to
/// smooth the triangle's slope discontinuities.
#[inline]
fn poly_blamp(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt - 1.0;
        -x * x * x / 3.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt + 1.0;
        x * x * x / 3.0
    } else {
        0.0
    }
}

#[inline]
fn wrap01(p: f32) -> f32 {
    p - p.floor()
}

/// Smoothstep between two random values.
#[inline]
fn smooth(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t * t * (3.0 - 2.0 * t)
}

pub struct Lfo {
    sample_rate: f32,
    phase: f32,
    rng: u32,
    /// Random values for the previous, current and next cycle.
    rnd: [f32; 3],
    last_clock: f32,
    last_reset: f32,
    /// Samples since the last clock edge, and the last measured period.
    since_edge: u32,
    period: f32,
    edge_count: u32,
    have_edge: bool,
}

impl Lfo {
    #[inline]
    fn next_rand(&mut self) -> f32 {
        // xorshift32 — deterministic, no allocation, no OS entropy.
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        (x >> 8) as f32 / 8_388_608.0 - 1.0
    }

    /// Shape value in -1..1 at phase `p`. `prev_cycle` selects the older
    /// pair of random values (used by the lagging `shifted` output).
    #[inline]
    fn shape_at(&self, shape: u32, p: f32, dt: f32, pw: f32, prev_cycle: bool) -> f32 {
        let (r_a, r_b) = if prev_cycle {
            (self.rnd[0], self.rnd[1])
        } else {
            (self.rnd[1], self.rnd[2])
        };
        match shape {
            SHAPE_TRI => {
                let naive = if p < 0.5 {
                    4.0 * p - 1.0
                } else {
                    3.0 - 4.0 * p
                };
                // Slope flips by -8 per cycle at p = 0.5 and by +8 at the
                // wrap; PolyBLAMP rounds both corners.
                naive + 8.0 * dt * (poly_blamp(p, dt) - poly_blamp(wrap01(p + 0.5), dt))
            }
            SHAPE_SAW_UP => 2.0 * p - 1.0 - poly_blep(p, dt),
            SHAPE_SAW_DOWN => -(2.0 * p - 1.0 - poly_blep(p, dt)),
            SHAPE_PULSE => {
                let naive = if p < pw { 1.0 } else { -1.0 };
                naive + poly_blep(p, dt) - poly_blep(wrap01(p + 1.0 - pw), dt)
            }
            SHAPE_SH => r_a,
            SHAPE_SMOOTH => smooth(r_a, r_b, p),
            // Sine (shape 0) is also the fallback for out-of-range values.
            _ => (core::f32::consts::TAU * p).sin(),
        }
    }
}

impl Module for Lfo {
    const N_INPUTS: usize = 8;
    const N_OUTPUTS: usize = 3;

    fn new(ctx: &InitCtx) -> Self {
        let mut lfo = Lfo {
            sample_rate: ctx.sample_rate,
            phase: 0.0,
            rng: SEED,
            rnd: [0.0; 3],
            last_clock: 0.0,
            last_reset: 0.0,
            since_edge: 0,
            period: 0.0,
            edge_count: 0,
            have_edge: false,
        };
        lfo.rnd = [0.0, lfo.next_rand(), lfo.next_rand()];
        lfo
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        let clocked = io.connected_inputs.is_connected(IN_CLOCK);
        for s in 0..n {
            let shape = (io.inputs[IN_SHAPE][s] + 0.5).clamp(0.0, 6.0) as u32;
            let pw = io.inputs[IN_PW][s].clamp(0.02, 0.98);
            let ratio = RATIOS[(io.inputs[IN_RATIO][s] + 0.5).clamp(0.0, 8.0) as usize];

            // Clock tracking: measure the period, realign the phase on the
            // edge that starts a new LFO cycle.
            let clock = io.inputs[IN_CLOCK][s];
            self.since_edge = self.since_edge.saturating_add(1);
            if clock >= 1.0 && self.last_clock < 1.0 {
                if self.have_edge {
                    self.period = self.since_edge as f32;
                }
                self.have_edge = true;
                self.since_edge = 0;
                let div = if ratio < 1.0 {
                    (1.0 / ratio).round() as u32
                } else {
                    1
                };
                self.edge_count += 1;
                if self.edge_count >= div {
                    self.edge_count = 0;
                    if clocked {
                        self.phase = 0.0;
                    }
                }
            }
            self.last_clock = clock;

            let reset = io.inputs[IN_RESET][s];
            if reset >= 1.0 && self.last_reset < 1.0 {
                self.phase = 0.0;
                self.edge_count = 0;
            }
            self.last_reset = reset;

            let freq = if clocked && self.period > 0.0 {
                ratio * self.sample_rate / self.period
            } else {
                io.inputs[IN_RATE][s].clamp(0.001, 20_000.0)
                    * (2.0f32).powf(io.inputs[IN_RATE_CV][s].clamp(-10.0, 10.0))
            };
            let dt = (freq / self.sample_rate).clamp(1e-9, 0.45);

            let p = self.phase;
            let v = self.shape_at(shape, p, dt, pw, false);
            // The shifted output lags by `phase` cycles, so it can reach
            // back into the previous random step instead of guessing ahead.
            let lag = io.inputs[IN_PHASE][s].clamp(0.0, 1.0);
            let p2 = p - lag;
            let (p2, prev_cycle) = if p2 < 0.0 {
                (p2 + 1.0, true)
            } else {
                (p2, false)
            };
            let v2 = self.shape_at(shape, p2, dt, pw, prev_cycle);

            io.outputs[OUT_BI][s] = AMPLITUDE * v;
            io.outputs[OUT_UNI][s] = AMPLITUDE * (v + 1.0);
            io.outputs[OUT_SHIFTED][s] = AMPLITUDE * v2;

            self.phase += dt;
            if self.phase >= 1.0 {
                self.phase -= self.phase.floor();
                self.rnd[0] = self.rnd[1];
                self.rnd[1] = self.rnd[2];
                self.rnd[2] = self.next_rand();
            }
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(20);
        out.extend_from_slice(&self.phase.to_le_bytes());
        out.extend_from_slice(&self.rng.to_le_bytes());
        for v in self.rnd {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 20 {
            self.phase = f32::from_le_bytes(bytes[0..4].try_into().unwrap());
            self.rng = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
            for (i, v) in self.rnd.iter_mut().enumerate() {
                let o = 8 + i * 4;
                *v = f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
            }
        }
    }
}

export_module!(Lfo);
