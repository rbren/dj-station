//! Boolean logic, comparator, window comparator and gate-to-trigger.
//!
//! Gate inputs are read with a Schmitt rule (PRD §4): >= 1 V is high,
//! <= 0 V is low, in between holds the previous state. `c` only takes part
//! in the logic when a wire is patched into it, so the two-input functions
//! stay two-input until you need three.
//!
//! The comparator and window comparator use a small voltage hysteresis so a
//! signal sitting exactly on the threshold produces one clean edge instead
//! of a burst. Outputs are 10 V / 0 V.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_A: usize = 0;
const IN_B: usize = 1;
const IN_C: usize = 2;
const IN_CMP: usize = 3;
const IN_THRESHOLD: usize = 4;
const IN_WIN: usize = 5;
const IN_WIN_LOW: usize = 6;
const IN_WIN_HIGH: usize = 7;
const IN_G2T: usize = 8;
const IN_TRIG_MS: usize = 9;

const OUT_AND: usize = 0;
const OUT_NAND: usize = 1;
const OUT_OR: usize = 2;
const OUT_NOR: usize = 3;
const OUT_XOR: usize = 4;
const OUT_XNOR: usize = 5;
const OUT_NOT_A: usize = 6;
const OUT_NOT_B: usize = 7;
const OUT_CMP: usize = 8;
const OUT_WINDOW: usize = 9;
const OUT_TRIG: usize = 10;

const HIGH: f32 = 10.0;
/// Comparator dead band, in volts, applied either side of the threshold.
const COMPARATOR_HYSTERESIS: f32 = 0.05;

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

#[inline]
fn level(state: bool) -> f32 {
    if state {
        HIGH
    } else {
        0.0
    }
}

pub struct Logic {
    sample_rate: f32,
    gates: [bool; 3],
    g2t: bool,
    cmp_state: bool,
    window_state: bool,
    trig_left: u32,
}

impl Module for Logic {
    const N_INPUTS: usize = 10;
    const N_OUTPUTS: usize = 11;

    fn new(ctx: &InitCtx) -> Self {
        Logic {
            sample_rate: ctx.sample_rate,
            gates: [false; 3],
            g2t: false,
            cmp_state: false,
            window_state: false,
            trig_left: 0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        let use_c = io.connected_inputs.is_connected(IN_C);

        for s in 0..n {
            self.gates[0] = gate(io.inputs[IN_A][s], self.gates[0]);
            self.gates[1] = gate(io.inputs[IN_B][s], self.gates[1]);
            self.gates[2] = gate(io.inputs[IN_C][s], self.gates[2]);
            let (a, b, c) = (self.gates[0], self.gates[1], self.gates[2]);

            let and = a && b && (!use_c || c);
            let or = a || b || (use_c && c);
            let xor = a ^ b ^ (use_c && c);

            io.outputs[OUT_AND][s] = level(and);
            io.outputs[OUT_NAND][s] = level(!and);
            io.outputs[OUT_OR][s] = level(or);
            io.outputs[OUT_NOR][s] = level(!or);
            io.outputs[OUT_XOR][s] = level(xor);
            io.outputs[OUT_XNOR][s] = level(!xor);
            io.outputs[OUT_NOT_A][s] = level(!a);
            io.outputs[OUT_NOT_B][s] = level(!b);

            // Comparator with hysteresis around the threshold.
            let x = io.inputs[IN_CMP][s];
            let thr = io.inputs[IN_THRESHOLD][s];
            self.cmp_state = if self.cmp_state {
                x > thr - COMPARATOR_HYSTERESIS
            } else {
                x >= thr + COMPARATOR_HYSTERESIS
            };
            io.outputs[OUT_CMP][s] = level(self.cmp_state);

            // Window comparator: high while low <= in <= high (bounds may be
            // given in either order).
            let w = io.inputs[IN_WIN][s];
            let (lo, hi) = {
                let (l, h) = (io.inputs[IN_WIN_LOW][s], io.inputs[IN_WIN_HIGH][s]);
                if l <= h {
                    (l, h)
                } else {
                    (h, l)
                }
            };
            // Shrink the dead band for narrow windows so they can still open.
            let wh = COMPARATOR_HYSTERESIS.min((hi - lo) * 0.25);
            self.window_state = if self.window_state {
                w > lo - wh && w < hi + wh
            } else {
                w >= lo + wh && w <= hi - wh
            };
            io.outputs[OUT_WINDOW][s] = level(self.window_state);

            // Gate to trigger: fixed-width pulse on each rising edge.
            let g = gate(io.inputs[IN_G2T][s], self.g2t);
            if g && !self.g2t {
                let ms = io.inputs[IN_TRIG_MS][s].clamp(0.1, 100.0);
                self.trig_left = (ms * 0.001 * self.sample_rate).round().max(1.0) as u32;
            }
            self.g2t = g;
            io.outputs[OUT_TRIG][s] = if self.trig_left > 0 {
                self.trig_left -= 1;
                HIGH
            } else {
                0.0
            };
        }
    }
}

export_module!(Logic);
