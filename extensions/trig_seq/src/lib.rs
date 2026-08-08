//! Polymetric trigger sequencer: 8 tracks x 16 steps, one shared clock,
//! per-track length.
//!
//! Inputs: `clock`, `reset`, `pat1..pat8` (16-bit pattern per track) and
//! `len1..len8` (1..16). Outputs: `trig1..trig8`.
//!
//! ## Why a bitmask instead of 128 jacks
//!
//! 8 tracks x 16 on/off steps is 128 values. The `wasm-1` ABI carries a
//! 64-bit connected-inputs mask, so 128 jacks is not even representable,
//! and a 128-knob panel would be unusable. Each track therefore takes one
//! ordinary input jack holding its pattern as a number in 0..65535: bit 0
//! (value 1) is step 1, bit 15 (value 32768) is step 16. The value is
//! rounded and clamped, so the jack stays wireable — patching a CV into it
//! swaps patterns, and a custom UI can present the same jack as a row of 16
//! buttons.
//!
//! ## Polymeter
//!
//! Every track advances on the same clock but wraps at its own `len`, so
//! tracks of, say, 16 and 5 steps drift against each other and the combined
//! pattern only repeats after lcm(16, 5) = 80 clocks. `reset` re-arms all
//! tracks: the next clock plays step 1 on every track (the tracks are only
//! ever phase-aligned by a reset).
//!
//! ## Trigger width
//!
//! Fixed 5 ms high (10.0), shortened to at most 45 % of the measured clock
//! interval so the triggers stay distinct at fast tempi.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_CLOCK: usize = 0;
const IN_RESET: usize = 1;
const IN_PAT0: usize = 2;
const IN_LEN0: usize = 10;

const TRACKS: usize = 8;
const STEPS: usize = 16;
const GATE_V: f32 = 10.0;
const PULSE_SECS: f32 = 0.005;
const DEFAULT_INTERVAL_SECS: f32 = 0.02;

pub struct TrigSeq {
    sample_rate: f32,
    step: [u8; TRACKS],
    timers: [i32; TRACKS],
    armed: bool,
    last_clock: f32,
    last_reset: f32,
    interval: f32,
    since_clock: f32,
    seen_clock: bool,
}

impl Module for TrigSeq {
    const N_INPUTS: usize = 18;
    const N_OUTPUTS: usize = TRACKS;

    fn new(ctx: &InitCtx) -> Self {
        TrigSeq {
            sample_rate: ctx.sample_rate,
            step: [0; TRACKS],
            timers: [0; TRACKS],
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
        let mut pattern = [0u16; TRACKS];
        let mut length = [1usize; TRACKS];
        for t in 0..TRACKS {
            pattern[t] = io.inputs[IN_PAT0 + t][0].round().clamp(0.0, 65535.0) as u16;
            length[t] = (io.inputs[IN_LEN0 + t][0].round() as i32).clamp(1, STEPS as i32) as usize;
        }

        for s in 0..n {
            let reset = io.inputs[IN_RESET][s];
            if reset >= 1.0 && self.last_reset < 1.0 {
                self.step = [0; TRACKS];
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
                for t in 0..TRACKS {
                    if self.armed {
                        self.step[t] = 0;
                    } else {
                        self.step[t] = (self.step[t] as usize + 1) as u8;
                    }
                    if self.step[t] as usize >= length[t] {
                        self.step[t] = 0;
                    }
                    if pattern[t] & (1 << self.step[t]) != 0 {
                        self.timers[t] = width;
                    }
                }
                self.armed = false;
            }
            self.last_clock = clock;

            for t in 0..TRACKS {
                io.outputs[t][s] = if self.timers[t] > 0 {
                    self.timers[t] -= 1;
                    GATE_V
                } else {
                    0.0
                };
            }
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(TRACKS + 9);
        out.extend_from_slice(&self.step);
        out.push(self.armed as u8 | ((self.seen_clock as u8) << 1));
        out.extend_from_slice(&self.interval.to_le_bytes());
        out.extend_from_slice(&self.since_clock.to_le_bytes());
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() < TRACKS + 9 {
            return;
        }
        self.step.copy_from_slice(&bytes[0..TRACKS]);
        for st in self.step.iter_mut() {
            *st %= STEPS as u8;
        }
        self.armed = bytes[TRACKS] & 1 != 0;
        self.seen_clock = bytes[TRACKS] & 2 != 0;
        self.interval =
            f32::from_le_bytes(bytes[TRACKS + 1..TRACKS + 5].try_into().unwrap()).max(2.0);
        self.since_clock = f32::from_le_bytes(bytes[TRACKS + 5..TRACKS + 9].try_into().unwrap());
    }
}

export_module!(TrigSeq);
