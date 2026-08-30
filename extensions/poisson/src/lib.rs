//! Poisson Clock: a gamma renewal process as a trigger source.
//!
//! Inputs: `rate` (mean events per second), `density` (the gamma shape `k`)
//! and `clock` (a clock to take the rate from). Output: `out`, one trigger
//! per event.
//!
//! ## The process
//!
//! Each inter-event interval is an independent draw from
//! `Gamma(shape = k, mean = 1 / rate)`, which is what makes the module one
//! dial wide instead of one behaviour:
//!
//! - `k = 1` — the intervals are exponential, so the events are an exact
//!   Poisson process: memoryless, the textbook "random but at this average
//!   rate";
//! - `k > 1` — the interval distribution tightens around the mean
//!   (`CV = 1 / sqrt(k)`), walking the output toward a plain regular clock
//!   without ever locking to a grid;
//! - `k < 1` — over-dispersed: a heavier tail and a pile-up near zero, so
//!   events arrive in clumps separated by long gaps.
//!
//! The mean rate is the same at every `k` — density changes the *timing
//! texture*, never how many triggers land per minute.
//!
//! ## Rate, and following a clock
//!
//! The process runs on a phase accumulator measured in EVENTS rather than
//! seconds: `phase` advances by `rate / sample_rate` each sample and an
//! event fires when it passes `gap`, a dimensionless `Gamma(k, 1/k)` draw
//! (mean 1, `CV = 1/sqrt(k)`). A rate change therefore stretches or
//! squeezes the interval in flight instead of being ignored until the next
//! event, which is what makes the clock input usable live.
//!
//! With a wire in `clock`, the mean rate IS the incoming clock's rate —
//! measured between its last two rising edges, one event per clock pulse on
//! average — and the `rate` knob steps aside (it is the free-running rate).
//! Slaving to a division or multiple of the deck's clock is therefore a
//! Clock Multiplier away, exactly as it is for every other clock consumer
//! here. Before the second edge has arrived there is no measured rate yet,
//! so the knob still applies; a clock that stops holds the last rate it
//! measured (pull the wire to hand the rate back to the knob).
//!
//! ## Determinism
//!
//! Randomness is a fixed-seed xorshift32 driving Marsaglia–Tsang gamma
//! draws, so a patch renders identically every time, and the generator
//! state rides along in `save_state` — no allocation, no locks, no OS
//! entropy, nothing that can surprise the RT thread.
//!
//! ## Pulse width
//!
//! A fixed 5 ms high (10.0), shortened to at most 45 % of the interval that
//! was just drawn, plus one guaranteed low sample after it: a clumpy `k`
//! draws gaps shorter than a sample often enough to matter, and an event
//! that lands inside the pulse in flight WAITS for it rather than merging
//! into one long gate. The wait keeps the phase debt, so no event is ever
//! lost — which is what holds the measured rate at the set one however
//! clumpy the process gets.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_RATE: usize = 0;
const IN_DENSITY: usize = 1;
const IN_CLOCK: usize = 2;

const GATE_V: f32 = 10.0;
const PULSE_SECS: f32 = 0.005;
const SEED: u32 = 0x9E37_79B9;

const MIN_RATE: f32 = 0.001;
const MAX_RATE: f32 = 2000.0;
const MIN_K: f32 = 0.0625;
const MAX_K: f32 = 16.0;
/// Bounds on a single drawn gap, in units of the mean interval. The tails
/// they cut off are astronomically unlikely (past `k = 1/16`, beyond
/// `e^-60`); they exist so a pathological draw cannot stall the output.
const MIN_GAP: f32 = 1e-6;
const MAX_GAP: f32 = 1e4;
/// Gaps longer than this are not taken as the input clock's period (the
/// clock was stopped, not slow).
const MAX_INTERVAL_SECS: f32 = 10.0;
/// Marsaglia–Tsang acceptance is ~95 % per try; the cap only exists so the
/// RT thread can never spin on a degenerate draw.
const MAX_TRIES: u32 = 16;

pub struct Poisson {
    sample_rate: f32,
    rng: u32,
    /// Renewal phase in events since the last one; an event fires when it
    /// reaches `gap`.
    phase: f32,
    /// The gap drawn for the interval in flight, in mean intervals. Drawn
    /// on the first processed sample, when `density` is first readable.
    gap: f32,
    primed: bool,
    timer: i32,
    last_clock: f32,
    /// Samples since the last clock edge, and the last measured period.
    since_edge: f32,
    period: f32,
    have_edge: bool,
}

impl Poisson {
    /// Uniform in (0, 1) — never exactly 0, so `ln` is always finite.
    #[inline]
    fn u01(&mut self) -> f32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        ((x >> 8) as f32 + 0.5) / 16_777_216.0
    }

    /// Standard normal by Box–Muller (one of the pair; the second value is
    /// dropped rather than cached, which keeps the state one `u32` wide).
    #[inline]
    fn normal(&mut self) -> f32 {
        let u1 = self.u01();
        let u2 = self.u01();
        (-2.0 * u1.ln()).sqrt() * (core::f32::consts::TAU * u2).cos()
    }

    /// `Gamma(shape = a, scale = 1)` by Marsaglia–Tsang. Shapes below 1 use
    /// the standard boost `X_a = X_{a+1} * U^(1/a)`.
    fn gamma(&mut self, a: f32) -> f32 {
        let (a, boost) = if a < 1.0 {
            let u = self.u01();
            (a + 1.0, u.powf(1.0 / a))
        } else {
            (a, 1.0)
        };
        let d = a - 1.0 / 3.0;
        let c = 1.0 / (9.0 * d).sqrt();
        for _ in 0..MAX_TRIES {
            let x = self.normal();
            let v = 1.0 + c * x;
            if v <= 0.0 {
                continue;
            }
            let v = v * v * v;
            let u = self.u01();
            if u < 1.0 - 0.0331 * x * x * x * x || u.ln() < 0.5 * x * x + d * (1.0 - v + v.ln()) {
                return d * v * boost;
            }
        }
        a * boost
    }

    /// The next inter-event gap in units of the mean interval: a
    /// `Gamma(k, 1/k)` draw, so the mean is 1 whatever `k` is and only the
    /// spread (`CV = 1/sqrt(k)`) moves.
    #[inline]
    fn next_gap(&mut self, k: f32) -> f32 {
        (self.gamma(k) / k).clamp(MIN_GAP, MAX_GAP)
    }
}

impl Module for Poisson {
    const N_INPUTS: usize = 3;
    const N_OUTPUTS: usize = 1;

    fn new(ctx: &InitCtx) -> Self {
        Poisson {
            sample_rate: ctx.sample_rate,
            rng: SEED,
            phase: 0.0,
            gap: 1.0,
            primed: false,
            timer: 0,
            last_clock: 0.0,
            since_edge: 0.0,
            period: 0.0,
            have_edge: false,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        let clocked = io.connected_inputs.is_connected(IN_CLOCK);
        let nominal = PULSE_SECS * self.sample_rate;

        for s in 0..n {
            // Clock tracking: the rate comes from the last two rising
            // edges, like every other clock consumer here.
            let clock = io.inputs[IN_CLOCK][s];
            self.since_edge += 1.0;
            if clock >= 1.0 && self.last_clock < 1.0 {
                if self.have_edge && self.since_edge < MAX_INTERVAL_SECS * self.sample_rate {
                    self.period = self.since_edge.max(2.0);
                }
                self.have_edge = true;
                self.since_edge = 0.0;
            }
            self.last_clock = clock;

            let rate = if clocked && self.period > 0.0 {
                self.sample_rate / self.period
            } else {
                io.inputs[IN_RATE][s]
            }
            .clamp(MIN_RATE, MAX_RATE);
            let k = io.inputs[IN_DENSITY][s].clamp(MIN_K, MAX_K);

            if !self.primed {
                self.gap = self.next_gap(k);
                self.primed = true;
            }
            self.phase += rate / self.sample_rate;
            // `timer` also holds the trailing low sample, so an event that
            // lands inside the previous pulse waits instead of merging
            // with it. The phase debt is kept, so the delay costs nothing
            // in the long run: every draw still becomes exactly one
            // trigger, which is what keeps the measured rate the set one.
            if self.phase >= self.gap && self.timer == 0 {
                self.phase -= self.gap;
                self.gap = self.next_gap(k);
                // The pulse has to end before the next event, whose
                // distance is exactly the gap just drawn.
                let interval = self.gap * self.sample_rate / rate;
                self.timer = (nominal.min(0.45 * interval) as i32).max(1) + 1;
            }

            let high = self.timer > 1;
            self.timer = (self.timer - 1).max(0);
            io.outputs[0][s] = if high { GATE_V } else { 0.0 };
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(29);
        out.extend_from_slice(&self.rng.to_le_bytes());
        out.extend_from_slice(&self.phase.to_le_bytes());
        out.extend_from_slice(&self.gap.to_le_bytes());
        out.extend_from_slice(&self.timer.to_le_bytes());
        out.extend_from_slice(&self.last_clock.to_le_bytes());
        out.extend_from_slice(&self.since_edge.to_le_bytes());
        out.extend_from_slice(&self.period.to_le_bytes());
        out.push(self.have_edge as u8 | ((self.primed as u8) << 1));
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() < 29 {
            return;
        }
        let f32_at = |o: usize| f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
        self.rng = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        self.phase = f32_at(4);
        self.gap = f32_at(8).clamp(MIN_GAP, MAX_GAP);
        self.timer = i32::from_le_bytes(bytes[12..16].try_into().unwrap());
        self.last_clock = f32_at(16);
        self.since_edge = f32_at(20);
        self.period = f32_at(24);
        self.have_edge = bytes[28] & 1 != 0;
        self.primed = bytes[28] & 2 != 0;
    }
}

export_module!(Poisson);
