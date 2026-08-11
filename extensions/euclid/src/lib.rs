//! Four-channel Euclidean rhythm generator (Bjorklund).
//!
//! Inputs: `clock`, `reset` and, per channel, `stepsN` (1..32), `fillN`
//! (0..32, clamped to `stepsN`) and `rotN` (0..31). Outputs: `ch1..ch4`
//! triggers plus `or`, which is high whenever any channel fires, and
//! `step1..step4` — each channel's current 0-based step index (-1 until
//! the first clock after instantiation or a reset), which drives the
//! panel's playhead display.
//!
//! ## Pattern
//!
//! Each channel runs the real Bjorklund construction (the one Toussaint
//! showed is the Euclidean rhythm E(fill, steps)), which distributes the
//! fills as evenly as the step count allows: E(3,8) = `x..x..x.`,
//! E(5,13) = `x..x.x..x.x..`. `rot` rotates the resulting pattern left, so
//! channels can share a shape but start on a different onset. Patterns are
//! rebuilt only when one of the three controls changes; the algorithm runs
//! on fixed stack arrays and never allocates.
//!
//! ## Timing
//!
//! All channels advance on the shared `clock`, each wrapping at its own
//! step count, so different lengths phase against each other. A rising
//! `reset` re-arms every channel: the next clock plays step 1 everywhere.
//! Triggers are 5 ms high (10.0), shortened to at most 45 % of the measured
//! clock interval.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_CLOCK: usize = 0;
const IN_RESET: usize = 1;
/// Per channel: steps, fill, rotation.
const IN_CH0: usize = 2;

const CHANNELS: usize = 4;
/// First of the per-channel current-step outputs (after ch1..ch4 and or).
const OUT_STEP0: usize = CHANNELS + 1;
const MAX_STEPS: usize = 32;
const GATE_V: f32 = 10.0;
const PULSE_SECS: f32 = 0.005;
const DEFAULT_INTERVAL_SECS: f32 = 0.02;

/// Write the Euclidean rhythm E(`pulses`, `steps`) into `out[..steps]`.
///
/// Bjorklund's algorithm: repeatedly divide the remainder sequence, then
/// rebuild the pattern from the recorded counts/remainders. All scratch is
/// stack-allocated, so this is safe to call from `process`.
fn bjorklund(steps: usize, pulses: usize, out: &mut [bool; MAX_STEPS]) {
    *out = [false; MAX_STEPS];
    let steps = steps.min(MAX_STEPS);
    if steps == 0 || pulses == 0 {
        return;
    }
    if pulses >= steps {
        for v in out.iter_mut().take(steps) {
            *v = true;
        }
        return;
    }
    let mut counts = [0usize; MAX_STEPS + 2];
    let mut remainders = [0usize; MAX_STEPS + 2];
    let mut divisor = steps - pulses;
    remainders[0] = pulses;
    let mut level = 0usize;
    loop {
        counts[level] = divisor / remainders[level];
        remainders[level + 1] = divisor % remainders[level];
        divisor = remainders[level];
        level += 1;
        if remainders[level] <= 1 {
            break;
        }
    }
    counts[level] = divisor;
    let mut idx = 0usize;
    build(&counts, &remainders, level as isize, out, &mut idx, steps);
    // The construction can start on a rest; rotate so the pattern begins on
    // its first onset, which is the canonical form (E(3,8) = `x..x..x.`).
    let first = out.iter().take(steps).position(|&v| v).unwrap_or(0);
    if first > 0 {
        let src = *out;
        for i in 0..steps {
            out[i] = src[(i + first) % steps];
        }
    }
}

fn build(
    counts: &[usize],
    remainders: &[usize],
    level: isize,
    out: &mut [bool; MAX_STEPS],
    idx: &mut usize,
    steps: usize,
) {
    if *idx >= steps {
        return;
    }
    if level == -1 {
        out[*idx] = false;
        *idx += 1;
    } else if level == -2 {
        out[*idx] = true;
        *idx += 1;
    } else {
        let l = level as usize;
        for _ in 0..counts[l] {
            build(counts, remainders, level - 1, out, idx, steps);
        }
        if remainders[l] != 0 {
            build(counts, remainders, level - 2, out, idx, steps);
        }
    }
}

pub struct Euclid {
    sample_rate: f32,
    patterns: [[bool; MAX_STEPS]; CHANNELS],
    /// (steps, fill, rotation) the cached pattern was built from.
    cached: [(u8, u8, u8); CHANNELS],
    step: [u8; CHANNELS],
    timers: [i32; CHANNELS],
    armed: bool,
    last_clock: f32,
    last_reset: f32,
    interval: f32,
    since_clock: f32,
    seen_clock: bool,
}

impl Module for Euclid {
    const N_INPUTS: usize = 2 + 3 * CHANNELS;
    const N_OUTPUTS: usize = 2 * CHANNELS + 1;

    fn new(ctx: &InitCtx) -> Self {
        Euclid {
            sample_rate: ctx.sample_rate,
            patterns: [[false; MAX_STEPS]; CHANNELS],
            cached: [(0, 0, 0); CHANNELS],
            step: [0; CHANNELS],
            timers: [0; CHANNELS],
            armed: true,
            last_clock: 0.0,
            last_reset: 0.0,
            interval: DEFAULT_INTERVAL_SECS * ctx.sample_rate,
            since_clock: 0.0,
            seen_clock: false,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        let mut steps = [1usize; CHANNELS];
        for (c, len) in steps.iter_mut().enumerate() {
            let base = IN_CH0 + 3 * c;
            let st = (io.inputs[base][0].round() as i32).clamp(1, MAX_STEPS as i32) as u8;
            let fill = (io.inputs[base + 1][0].round() as i32).clamp(0, st as i32) as u8;
            let rot = (io.inputs[base + 2][0].round() as i32).clamp(0, MAX_STEPS as i32 - 1) as u8;
            *len = st as usize;
            if self.cached[c] != (st, fill, rot) {
                self.cached[c] = (st, fill, rot);
                let mut raw = [false; MAX_STEPS];
                bjorklund(st as usize, fill as usize, &mut raw);
                let r = rot as usize % st as usize;
                for i in 0..st as usize {
                    self.patterns[c][i] = raw[(i + r) % st as usize];
                }
            }
        }

        for s in 0..n {
            let reset = io.inputs[IN_RESET][s];
            if reset >= 1.0 && self.last_reset < 1.0 {
                self.step = [0; CHANNELS];
                self.armed = true;
            }
            self.last_reset = reset;

            let clock = io.inputs[IN_CLOCK][s];
            self.since_clock += 1.0;
            if clock >= 1.0 && self.last_clock < 1.0 {
                if self.seen_clock && self.since_clock < 10.0 * self.sample_rate {
                    self.interval = self.since_clock.max(2.0);
                }
                self.seen_clock = true;
                self.since_clock = 0.0;
                let width =
                    ((PULSE_SECS * self.sample_rate).min(0.45 * self.interval) as i32).max(1);
                for (c, &len) in steps.iter().enumerate() {
                    if self.armed {
                        self.step[c] = 0;
                    } else {
                        self.step[c] += 1;
                    }
                    if self.step[c] as usize >= len {
                        self.step[c] = 0;
                    }
                    if self.patterns[c][self.step[c] as usize] {
                        self.timers[c] = width;
                    }
                }
                self.armed = false;
            }
            self.last_clock = clock;

            let mut any = false;
            for c in 0..CHANNELS {
                let high = self.timers[c] > 0;
                if high {
                    self.timers[c] -= 1;
                    any = true;
                }
                io.outputs[c][s] = if high { GATE_V } else { 0.0 };
                io.outputs[OUT_STEP0 + c][s] = if self.armed {
                    -1.0
                } else {
                    self.step[c] as f32
                };
            }
            io.outputs[CHANNELS][s] = if any { GATE_V } else { 0.0 };
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(CHANNELS + 17);
        out.extend_from_slice(&self.step);
        out.push(self.armed as u8 | ((self.seen_clock as u8) << 1));
        out.extend_from_slice(&self.interval.to_le_bytes());
        out.extend_from_slice(&self.since_clock.to_le_bytes());
        out.extend_from_slice(&self.last_clock.to_le_bytes());
        out.extend_from_slice(&self.last_reset.to_le_bytes());
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() < CHANNELS + 17 {
            return;
        }
        self.step.copy_from_slice(&bytes[0..CHANNELS]);
        for st in self.step.iter_mut() {
            *st %= MAX_STEPS as u8;
        }
        self.armed = bytes[CHANNELS] & 1 != 0;
        self.seen_clock = bytes[CHANNELS] & 2 != 0;
        self.interval =
            f32::from_le_bytes(bytes[CHANNELS + 1..CHANNELS + 5].try_into().unwrap()).max(2.0);
        self.since_clock =
            f32::from_le_bytes(bytes[CHANNELS + 5..CHANNELS + 9].try_into().unwrap());
        self.last_clock =
            f32::from_le_bytes(bytes[CHANNELS + 9..CHANNELS + 13].try_into().unwrap());
        self.last_reset =
            f32::from_le_bytes(bytes[CHANNELS + 13..CHANNELS + 17].try_into().unwrap());
    }
}

export_module!(Euclid);
