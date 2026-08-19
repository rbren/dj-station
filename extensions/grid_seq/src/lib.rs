//! Grid sequencer: 8 rows x 16 columns, one output per row.
//!
//! Inputs: `clock`, `reset`, `row1..row8` (16-bit pattern per row, bit 0 =
//! column 1 — same bitmask-jack convention as the trigger sequencer, so
//! the panel grid, wires and patches all address one number per row),
//! `level` (output voltage in gate mode, default 10 V) and `mode`
//! (0 = gate, 1 = scale). Outputs: `out1..out8` plus `pos` — clocks played
//! since the last reset (-1 until the first clock), from which the current
//! column is `pos mod 16`.
//!
//! When the playhead reaches a column, every row whose cell is on in that
//! column emits on its output for half the measured clock interval:
//!
//! - **gate** mode: `level` volts (default 10 V) — drum triggers, resets,
//!   envelope gates.
//! - **scale** mode: the row's pitch on a C major scale, 1 V/oct with row 1
//!   as C4 (0 V) ascending to row 8 an octave up — the grid becomes a
//!   melody: patch one row output (or a sum) into an oscillator pitch.
//!
//! Half-interval gates (rather than the trigger sequencer's 5 ms pulses)
//! keep pitch CVs readable in scale mode while staying distinct per column.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_CLOCK: usize = 0;
const IN_RESET: usize = 1;
const IN_ROW0: usize = 2;
const IN_LEVEL: usize = 10;
const IN_MODE: usize = 11;

pub const ROWS: usize = 8;
pub const COLS: usize = 16;
const OUT_POS: usize = ROWS;

/// Interval assumed before two clock edges have been seen.
const DEFAULT_INTERVAL_SECS: f32 = 0.02;
/// `pos` wraps where both 16 divides it and f32 stays exact (2^24-safe).
const POS_WRAP: u32 = 720_720;

/// Major scale, one octave over the 8 rows (semitones from the root).
const MAJOR_SEMITONES: [f32; ROWS] = [0.0, 2.0, 4.0, 5.0, 7.0, 9.0, 11.0, 12.0];

pub struct GridSeq {
    sample_rate: f32,
    col: usize,
    /// Samples remaining in the current column's gate window.
    gate_timer: i32,
    /// Latched per-row on/off for the current column.
    active: [bool; ROWS],
    pos: u32,
    armed: bool,
    last_clock: f32,
    last_reset: f32,
    interval: f32,
    since_clock: f32,
    seen_clock: bool,
}

impl Module for GridSeq {
    const N_INPUTS: usize = 12;
    const N_OUTPUTS: usize = ROWS + 1;

    fn new(ctx: &InitCtx) -> Self {
        GridSeq {
            sample_rate: ctx.sample_rate,
            col: 0,
            gate_timer: 0,
            active: [false; ROWS],
            pos: 0,
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
        let mut pattern = [0u16; ROWS];
        for (r, p) in pattern.iter_mut().enumerate() {
            *p = io.inputs[IN_ROW0 + r][0].round().clamp(0.0, 65535.0) as u16;
        }
        let level = io.inputs[IN_LEVEL][0].clamp(-10.0, 10.0);
        let scale_mode = io.inputs[IN_MODE][0].round() >= 1.0;

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
                    self.armed = false;
                    self.col = 0;
                    self.pos = 0;
                } else {
                    self.col = (self.col + 1) % COLS;
                    self.pos = (self.pos + 1) % POS_WRAP;
                }
                for r in 0..ROWS {
                    self.active[r] = pattern[r] & (1 << self.col) != 0;
                }
                self.gate_timer = ((0.5 * self.interval) as i32).max(1);
            }
            self.last_clock = clock;

            let open = self.gate_timer > 0;
            if open {
                self.gate_timer -= 1;
            }
            for r in 0..ROWS {
                io.outputs[r][s] = if open && self.active[r] {
                    if scale_mode {
                        MAJOR_SEMITONES[r] / 12.0
                    } else {
                        level
                    }
                } else {
                    0.0
                };
            }
            io.outputs[OUT_POS][s] = if self.armed { -1.0 } else { self.pos as f32 };
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(ROWS + 27);
        out.push(self.col as u8);
        out.push(self.armed as u8 | ((self.seen_clock as u8) << 1));
        for a in &self.active {
            out.push(*a as u8);
        }
        out.extend_from_slice(&self.gate_timer.to_le_bytes());
        out.extend_from_slice(&self.interval.to_le_bytes());
        out.extend_from_slice(&self.since_clock.to_le_bytes());
        out.extend_from_slice(&self.last_clock.to_le_bytes());
        out.extend_from_slice(&self.last_reset.to_le_bytes());
        out.extend_from_slice(&self.pos.to_le_bytes());
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() < ROWS + 26 {
            return;
        }
        self.col = (bytes[0] as usize) % COLS;
        self.armed = bytes[1] & 1 != 0;
        self.seen_clock = bytes[1] & 2 != 0;
        for (r, a) in self.active.iter_mut().enumerate() {
            *a = bytes[2 + r] != 0;
        }
        let f = |o: usize| f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
        let base = 2 + ROWS;
        self.gate_timer = i32::from_le_bytes(bytes[base..base + 4].try_into().unwrap());
        self.interval = f(base + 4).max(2.0);
        self.since_clock = f(base + 8);
        self.last_clock = f(base + 12);
        self.last_reset = f(base + 16);
        self.pos = u32::from_le_bytes(bytes[base + 20..base + 24].try_into().unwrap()) % POS_WRAP;
    }
}

export_module!(GridSeq);
