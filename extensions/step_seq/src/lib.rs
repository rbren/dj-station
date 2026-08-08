//! 16-step CV/gate sequencer with ratcheting, direction modes and glide.
//!
//! Inputs: `clock`, `reset`, `length` (1..16), `dir` (0 forward, 1 reverse,
//! 2 ping-pong, 3 random), `glide` (seconds), plus per step `cv1..cv16`
//! (volts, 1 V/oct), `gate1..gate16` (on/off) and `ratchet1..ratchet16`
//! (1..4 sub-divisions inside the step). Outputs: `cv`, `gate`, `eos`.
//!
//! ## Timing
//!
//! A rising edge on `clock` advances the sequence; the step's gate is
//! re-emitted for each ratchet sub-division, high for 50 % of the
//! sub-division. Sub-division length comes from the interval measured
//! between the last two clock edges (20 ms until a second edge arrives), so
//! ratchets track the incoming tempo without needing a tempo control.
//!
//! ## Reset
//!
//! A rising edge on `reset` re-arms the sequence: the next clock plays the
//! first step (step 1 forward, step `length` in reverse) rather than
//! advancing, so the pattern is phase-locked to the reset.
//!
//! ## Direction / end of sequence
//!
//! `eos` emits a 5 ms trigger whenever the pattern starts over: forward when
//! it wraps past the last step, reverse when it wraps past the first,
//! ping-pong when it bounces back to the first step, and random every
//! `length` clocks.
//!
//! ## Glide
//!
//! `glide` is the time the CV output takes to travel from the previous step
//! value to the new one (linear portamento); 0 s steps instantly. Gates are
//! never slewed.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_CLOCK: usize = 0;
const IN_RESET: usize = 1;
const IN_LENGTH: usize = 2;
const IN_DIR: usize = 3;
const IN_GLIDE: usize = 4;
const IN_CV0: usize = 5;
const IN_GATE0: usize = 21;
const IN_RATCHET0: usize = 37;

const OUT_CV: usize = 0;
const OUT_GATE: usize = 1;
const OUT_EOS: usize = 2;

const STEPS: usize = 16;
const GATE_V: f32 = 10.0;
const EOS_SECS: f32 = 0.005;
/// Interval assumed before two clock edges have been seen.
const DEFAULT_INTERVAL_SECS: f32 = 0.02;

pub struct StepSeq {
    sample_rate: f32,
    step: usize,
    forward: bool,
    /// Steps played since the last `eos` in random mode.
    rand_count: usize,
    rng: u32,
    /// The next clock plays the current step instead of advancing.
    armed: bool,
    last_clock: f32,
    last_reset: f32,
    /// Samples between the last two clock edges.
    interval: f32,
    since_clock: f32,
    seen_clock: bool,
    /// Position inside the current step, in samples.
    step_pos: f32,
    ratchets: usize,
    step_gate: bool,
    cv_target: f32,
    cv_now: f32,
    glide_rate: f32,
    eos_timer: i32,
}

#[inline]
fn xorshift32(s: &mut u32) -> u32 {
    let mut x = *s;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *s = x;
    x
}

impl StepSeq {
    /// Advance to the next step; returns true when the pattern started over.
    fn advance(&mut self, len: usize, dir: usize) -> bool {
        if len <= 1 {
            self.step = 0;
            return true;
        }
        if self.step >= len {
            self.step = len - 1;
        }
        match dir {
            1 => {
                if self.step == 0 {
                    self.step = len - 1;
                    true
                } else {
                    self.step -= 1;
                    false
                }
            }
            2 => {
                if self.forward {
                    if self.step + 1 >= len {
                        self.forward = false;
                        self.step = len - 2;
                        self.step == 0
                    } else {
                        self.step += 1;
                        false
                    }
                } else if self.step == 0 {
                    self.forward = true;
                    self.step = 1;
                    false
                } else {
                    self.step -= 1;
                    if self.step == 0 {
                        self.forward = true;
                        true
                    } else {
                        false
                    }
                }
            }
            3 => {
                self.step = (xorshift32(&mut self.rng) % len as u32) as usize;
                self.rand_count += 1;
                if self.rand_count >= len {
                    self.rand_count = 0;
                    true
                } else {
                    false
                }
            }
            _ => {
                self.step += 1;
                if self.step >= len {
                    self.step = 0;
                    true
                } else {
                    false
                }
            }
        }
    }
}

impl Module for StepSeq {
    const N_INPUTS: usize = 53;
    const N_OUTPUTS: usize = 3;

    fn new(ctx: &InitCtx) -> Self {
        StepSeq {
            sample_rate: ctx.sample_rate,
            step: 0,
            forward: true,
            rand_count: 0,
            rng: 0x1234_5678,
            armed: true,
            last_clock: 0.0,
            last_reset: 0.0,
            interval: DEFAULT_INTERVAL_SECS * ctx.sample_rate,
            since_clock: 0.0,
            seen_clock: false,
            step_pos: 0.0,
            ratchets: 1,
            step_gate: false,
            cv_target: 0.0,
            cv_now: 0.0,
            glide_rate: 0.0,
            eos_timer: 0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        let len = (io.inputs[IN_LENGTH][0].round() as i32).clamp(1, STEPS as i32) as usize;
        let dir = (io.inputs[IN_DIR][0].round() as i32).clamp(0, 3) as usize;
        let glide = io.inputs[IN_GLIDE][0].max(0.0);
        let eos_len = (EOS_SECS * self.sample_rate) as i32;

        for s in 0..n {
            let reset = io.inputs[IN_RESET][s];
            if reset >= 1.0 && self.last_reset < 1.0 {
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
                if self.armed {
                    // First clock after a reset (or after instantiation)
                    // plays the first step of the current direction.
                    self.armed = false;
                    self.step = if dir == 1 { len - 1 } else { 0 };
                    self.forward = dir != 1;
                    self.rand_count = 0;
                } else if self.advance(len, dir) {
                    self.eos_timer = eos_len;
                }
                if self.step >= len {
                    self.step = len - 1;
                }
                self.ratchets =
                    (io.inputs[IN_RATCHET0 + self.step][s].round() as i32).clamp(1, 4) as usize;
                self.step_gate = io.inputs[IN_GATE0 + self.step][s] >= 1.0;
                self.cv_target = io.inputs[IN_CV0 + self.step][s];
                self.step_pos = 0.0;
                self.glide_rate = if glide > 0.0 {
                    (self.cv_target - self.cv_now) / (glide * self.sample_rate)
                } else {
                    0.0
                };
                if self.glide_rate == 0.0 {
                    self.cv_now = self.cv_target;
                }
            }
            self.last_clock = clock;

            // Glide toward the step's CV without overshooting.
            if self.cv_now != self.cv_target && self.glide_rate != 0.0 {
                self.cv_now += self.glide_rate;
                if (self.glide_rate > 0.0 && self.cv_now >= self.cv_target)
                    || (self.glide_rate < 0.0 && self.cv_now <= self.cv_target)
                {
                    self.cv_now = self.cv_target;
                }
            }

            // Ratcheted gate: `ratchets` pulses spread over the step, each
            // high for half its sub-division.
            let sub = (self.interval / self.ratchets as f32).max(2.0);
            let idx = (self.step_pos / sub) as usize;
            let high = self.step_gate
                && idx < self.ratchets
                && (self.step_pos - idx as f32 * sub) < 0.5 * sub;
            self.step_pos += 1.0;

            io.outputs[OUT_CV][s] = self.cv_now;
            io.outputs[OUT_GATE][s] = if high { GATE_V } else { 0.0 };
            io.outputs[OUT_EOS][s] = if self.eos_timer > 0 {
                self.eos_timer -= 1;
                GATE_V
            } else {
                0.0
            };
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(32);
        out.extend_from_slice(&(self.step as u16).to_le_bytes());
        out.extend_from_slice(&(self.rand_count as u16).to_le_bytes());
        out.extend_from_slice(&self.rng.to_le_bytes());
        out.push(self.forward as u8);
        out.push(self.armed as u8 | ((self.seen_clock as u8) << 1));
        out.push(self.step_gate as u8);
        out.push(self.ratchets as u8);
        out.extend_from_slice(&self.cv_now.to_le_bytes());
        out.extend_from_slice(&self.cv_target.to_le_bytes());
        out.extend_from_slice(&self.interval.to_le_bytes());
        out.extend_from_slice(&self.step_pos.to_le_bytes());
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() < 28 {
            return;
        }
        self.step = u16::from_le_bytes(bytes[0..2].try_into().unwrap()) as usize % STEPS;
        self.rand_count = u16::from_le_bytes(bytes[2..4].try_into().unwrap()) as usize;
        self.rng = u32::from_le_bytes(bytes[4..8].try_into().unwrap()).max(1);
        self.forward = bytes[8] != 0;
        self.armed = bytes[9] & 1 != 0;
        self.seen_clock = bytes[9] & 2 != 0;
        self.step_gate = bytes[10] != 0;
        self.ratchets = (bytes[11] as usize).clamp(1, 4);
        self.cv_now = f32::from_le_bytes(bytes[12..16].try_into().unwrap());
        self.cv_target = f32::from_le_bytes(bytes[16..20].try_into().unwrap());
        self.interval = f32::from_le_bytes(bytes[20..24].try_into().unwrap()).max(2.0);
        self.step_pos = f32::from_le_bytes(bytes[24..28].try_into().unwrap());
    }
}

export_module!(StepSeq);
