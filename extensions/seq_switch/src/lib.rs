//! Sequential switch, both directions at once.
//!
//! - **1 to 8**: `in` is routed to `o<step>`; the other outputs sit at 0 V.
//! - **8 to 1**: `i<step>` is routed to `out`.
//!
//! The step advances on a rising edge at `clock`, wrapping after `steps`
//! (2..8) steps, and `reset` jumps back to the first step. Muted steps are
//! skipped by the clock (if every step is muted the switch simply holds).
//!
//! Patching `cv` switches to direct addressing: 0..10 V is divided into
//! `steps` equal cells, so the step follows the voltage and the clock is
//! ignored. `step_cv` reports the current step as the centre voltage of its
//! cell, so it can address another switch's `cv` input exactly.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const STEPS_MAX: usize = 8;

const IN_SOURCE: usize = 0;
const IN_CHANNELS: usize = 1;
const IN_CLOCK: usize = 9;
const IN_RESET: usize = 10;
const IN_CV: usize = 11;
const IN_STEPS: usize = 12;
const IN_MUTES: usize = 13;

const OUT_CHANNELS: usize = 0;
const OUT_MIX: usize = 8;
const OUT_STEP_CV: usize = 9;

/// Gate reading per PRD §4: >= 1 V high, <= 0 V low, in between holds.
#[inline]
fn gate(value: f32, prev: bool) -> bool {
    if value >= 1.0 {
        true
    } else if value <= 0.0 {
        false
    } else {
        prev
    }
}

pub struct SeqSwitch {
    step: usize,
    last_clock: bool,
    last_reset: bool,
}

impl SeqSwitch {
    #[inline]
    fn muted(io: &ProcessIo, step: usize, s: usize) -> bool {
        io.inputs[IN_MUTES + step][s] >= 1.0
    }

    /// First unmuted step at or after `from`, wrapping; `from` itself when
    /// every step is muted.
    fn seek(io: &ProcessIo, from: usize, steps: usize, s: usize) -> usize {
        for k in 0..steps {
            let cand = (from + k) % steps;
            if !Self::muted(io, cand, s) {
                return cand;
            }
        }
        from
    }
}

impl Module for SeqSwitch {
    const N_INPUTS: usize = 21;
    const N_OUTPUTS: usize = 10;

    fn new(_ctx: &InitCtx) -> Self {
        SeqSwitch {
            step: 0,
            last_clock: false,
            last_reset: false,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        let steps = (io.inputs[IN_STEPS][0].round().clamp(2.0, STEPS_MAX as f32)) as usize;
        let addressed = io.connected_inputs.is_connected(IN_CV);
        if self.step >= steps {
            self.step = 0;
        }

        for s in 0..n {
            if addressed {
                let cell = (io.inputs[IN_CV][s] * 0.1 * steps as f32).floor();
                self.step = cell.clamp(0.0, (steps - 1) as f32) as usize;
            } else {
                let reset = gate(io.inputs[IN_RESET][s], self.last_reset);
                let clock = gate(io.inputs[IN_CLOCK][s], self.last_clock);
                if reset && !self.last_reset {
                    self.step = Self::seek(io, 0, steps, s);
                } else if clock && !self.last_clock {
                    self.step = Self::seek(io, (self.step + 1) % steps, steps, s);
                }
                self.last_reset = reset;
                self.last_clock = clock;
            }

            let step = self.step;
            let source = io.inputs[IN_SOURCE][s];
            let selected = io.inputs[IN_CHANNELS + step][s];
            for out in 0..STEPS_MAX {
                io.outputs[OUT_CHANNELS + out][s] = if out == step { source } else { 0.0 };
            }
            io.outputs[OUT_MIX][s] = selected;
            io.outputs[OUT_STEP_CV][s] = (step as f32 + 0.5) / steps as f32 * 10.0;
        }
    }

    fn save_state(&self) -> Vec<u8> {
        vec![
            self.step as u8,
            self.last_clock as u8,
            self.last_reset as u8,
        ]
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 3 {
            self.step = (bytes[0] as usize).min(STEPS_MAX - 1);
            self.last_clock = bytes[1] != 0;
            self.last_reset = bytes[2] != 0;
        }
    }
}

export_module!(SeqSwitch);
