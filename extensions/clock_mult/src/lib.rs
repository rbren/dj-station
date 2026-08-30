//! Clock Multiplier: re-times an incoming clock by a continuous ratio.
//!
//! Inputs: `clock` (the clock to follow) and `mult` (the ratio knob).
//! Output: `out` — pulses at the input rate times the selected ratio.
//!
//! ## The ratio
//!
//! `mult` is a CONTINUOUS knob spanning -64..+64 and its value IS the
//! ratio: output pulses per input pulse. Values above 1 multiply (`4` =
//! x4), values below 1 divide (`0.5` = every other pulse, `1/3` = every
//! third), and anything between is allowed (`2.5` = five pulses every two
//! input pulses). `0` freezes the grid — no pulses after the one at the
//! origin. A NEGATIVE ratio walks the grid BACKWARDS at the same rate, so
//! the audible tempo is `|mult|` times the input: the knob is symmetric
//! about its centre, and sweeping it down through zero rides the clock to
//! a standstill and back up again.
//!
//! ## Exact thirds
//!
//! The ratio is resolved to an exact rational ([`ratio_of`]) before it
//! reaches the phase math, so a division lands on the incoming edges
//! instead of drifting off them. The fractional part of the knob value
//! SNAPS to a third when it falls within [`THIRD_SNAP_EPS`] of one:
//! `0.333`, `0.334`, `0.666` and `0.667` become exactly 1/3 and 2/3 (and
//! `4.667` exactly 14/3). Taken literally, `0.333` slips a whole pulse
//! every few hundred beats, which is the difference between a triplet grid
//! and a phasing patch; the window is far too narrow to swallow a
//! deliberate `0.34`. The app's readout applies the same law and shows the
//! snapped values as `1/3` and `2/3` (`app/src/display.ts`, kept in step by
//! `app/tests/Display.test.ts`).
//!
//! ## Following the input
//!
//! The input period is measured between the last two rising edges, like
//! every other clock-consuming module here. `pos` counts input periods:
//! each edge snaps it to the next whole period, and between edges it
//! interpolates with the measured period, capped just short of the next
//! whole one so a slow or jittery clock can never manufacture an extra
//! pulse. A stream of `num/den` pulses per period fires its `i`-th pulse
//! when `pos * num / den` crosses `i`, which makes multiplication
//! predictive (the extra pulses are spaced by the last measured interval)
//! and division exact (every `den`-th input edge, phase-locked to it).
//!
//! ## Free-running at 2 Hz
//!
//! With nothing patched into `clock` — or before the first edge arrives —
//! the module free-runs as if fed a 2 Hz clock, so it is a usable clock
//! source on its own: the fallback is an assumed INPUT rate, so the knob
//! still applies and a continuous ratio makes it a clock at ANY tempo
//! (2 Hz x `mult`: `1` is 2 Hz, `2` is 240 BPM, `0.5` is 1 Hz). A clock
//! that stops is treated the same way: after `STALL_PERIODS` measured
//! periods without an edge (e.g. the wire was pulled) the module falls
//! back to free-running, and the next edge re-phases it onto the incoming
//! clock.
//!
//! ## Pulse width
//!
//! Fixed 5 ms high (10.0), shortened to at most 45 % of the module's own
//! output interval so fast ratios still produce distinct triggers.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_CLOCK: usize = 0;
const IN_MULT: usize = 1;

/// Largest ratio either way; matches the `mult` knob's manifest range.
const MAX_RATIO: f32 = 64.0;
/// How close the fractional part of the knob value must be to a third for
/// the ratio to snap to an exact one.
const THIRD_SNAP_EPS: f32 = 0.002;

const GATE_V: f32 = 10.0;
const PULSE_SECS: f32 = 0.005;
/// Rate the module runs at with no incoming clock.
const FREE_RUN_HZ: f32 = 2.0;
/// Measured periods without an edge before the input clock counts as
/// stopped and the module falls back to free-running.
const STALL_PERIODS: f32 = 4.0;
/// Gaps longer than this are not taken as the input period (the clock was
/// stopped, not slow), so a restart can't stretch the grid to minutes.
const MAX_INTERVAL_SECS: f32 = 10.0;
/// Cap on the interpolated position within one input period: the phase
/// only reaches a whole period on an actual edge.
const MAX_FRAC: f64 = 0.999;

/// Output pulses per input pulse as an exact `(numerator, denominator)`,
/// with the fractional part of the knob value snapped to a third when it
/// is within [`THIRD_SNAP_EPS`] of one.
fn ratio_of(mult: f32) -> (f64, f64) {
    let v = if mult.is_finite() {
        mult.clamp(-MAX_RATIO, MAX_RATIO)
    } else {
        0.0
    };
    let magnitude = v.abs();
    let whole = magnitude.floor();
    let frac = magnitude - whole;
    let sign = if v < 0.0 { -1.0 } else { 1.0 };
    let thirds = |n: f32| f64::from(sign * (3.0 * whole + n));
    if (frac - 1.0 / 3.0).abs() <= THIRD_SNAP_EPS {
        (thirds(1.0), 3.0)
    } else if (frac - 2.0 / 3.0).abs() <= THIRD_SNAP_EPS {
        (thirds(2.0), 3.0)
    } else {
        (f64::from(v), 1.0)
    }
}

pub struct ClockMult {
    sample_rate: f32,
    /// Position in input periods; whole values are input edges.
    pos: f64,
    /// `pos` at the last input edge (a whole number).
    edge_pos: f64,
    /// Output pulses counted so far at the current ratio (counting down
    /// while the ratio is negative).
    pulses: i64,
    timer: i32,
    /// Samples per input period; the free-run period while unlocked.
    interval: f32,
    since_clock: f32,
    /// An input clock is driving the phase (an edge arrived recently).
    locked: bool,
    /// At least one edge has ever arrived, so a gap can be measured.
    seen_clock: bool,
    last_clock: f32,
}

impl ClockMult {
    #[inline]
    fn free_interval(&self) -> f32 {
        self.sample_rate / FREE_RUN_HZ
    }
}

impl Module for ClockMult {
    const N_INPUTS: usize = 2;
    const N_OUTPUTS: usize = 1;

    fn new(ctx: &InitCtx) -> Self {
        ClockMult {
            sample_rate: ctx.sample_rate,
            pos: 0.0,
            edge_pos: 0.0,
            pulses: 0,
            timer: 0,
            interval: ctx.sample_rate / FREE_RUN_HZ,
            since_clock: 0.0,
            locked: false,
            seen_clock: false,
            last_clock: 0.0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        // The ratio lays out the whole output grid rather than one pulse,
        // so it is sampled once per block like every other mode-style
        // input; it can be wired without per-sample cost.
        let (num, den) = ratio_of(io.inputs[IN_MULT][0]);
        let rate = (num / den).abs() as f32;
        let nominal = PULSE_SECS * self.sample_rate;

        for s in 0..n {
            let clock = io.inputs[IN_CLOCK][s];
            self.since_clock += 1.0;
            if clock >= 1.0 && self.last_clock < 1.0 {
                if self.seen_clock && self.since_clock < MAX_INTERVAL_SECS * self.sample_rate {
                    self.interval = self.since_clock.max(2.0);
                }
                if self.locked {
                    self.pos = self.pos.ceil();
                } else {
                    // First edge after free-running: re-phase the whole grid
                    // onto the incoming clock so divisions start here.
                    self.pos = 0.0;
                    self.pulses = 0;
                }
                self.edge_pos = self.pos;
                self.since_clock = 0.0;
                self.seen_clock = true;
                self.locked = true;
            } else if self.locked && self.since_clock > STALL_PERIODS * self.interval {
                self.locked = false;
                self.interval = self.free_interval();
            }
            self.last_clock = clock;

            if self.locked {
                self.pos =
                    self.edge_pos + (self.since_clock as f64 / self.interval as f64).min(MAX_FRAC);
            } else {
                self.pos += 1.0 / self.interval as f64;
            }

            // A crossing in EITHER direction fires: a negative ratio walks
            // the grid backwards at the same rate, and a zero ratio never
            // crosses again (silence after the pulse at the origin).
            let count = (self.pos * num / den).floor() as i64 + 1;
            if count != self.pulses {
                let out_interval = self.interval / rate.max(1e-9);
                self.timer = (nominal.min(0.45 * out_interval) as i32).max(1);
            }
            self.pulses = count;

            io.outputs[0][s] = if self.timer > 0 {
                self.timer -= 1;
                GATE_V
            } else {
                0.0
            };
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(41);
        out.extend_from_slice(&self.pos.to_le_bytes());
        out.extend_from_slice(&self.edge_pos.to_le_bytes());
        out.extend_from_slice(&self.pulses.to_le_bytes());
        out.extend_from_slice(&self.timer.to_le_bytes());
        out.extend_from_slice(&self.interval.to_le_bytes());
        out.extend_from_slice(&self.since_clock.to_le_bytes());
        out.extend_from_slice(&self.last_clock.to_le_bytes());
        out.push(self.locked as u8 | ((self.seen_clock as u8) << 1));
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() < 41 {
            return;
        }
        let f64_at = |o: usize| f64::from_le_bytes(bytes[o..o + 8].try_into().unwrap());
        let f32_at = |o: usize| f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
        self.pos = f64_at(0);
        self.edge_pos = f64_at(8);
        self.pulses = i64::from_le_bytes(bytes[16..24].try_into().unwrap());
        self.timer = i32::from_le_bytes(bytes[24..28].try_into().unwrap());
        self.interval = f32_at(28).max(2.0);
        self.since_clock = f32_at(32);
        self.last_clock = f32_at(36);
        self.locked = bytes[40] & 1 != 0;
        self.seen_clock = bytes[40] & 2 != 0;
    }
}

export_module!(ClockMult);
