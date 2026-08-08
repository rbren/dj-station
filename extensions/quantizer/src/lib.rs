//! Scale quantizer for 1 V/oct pitch (0.0 = C4, PRD §4).
//!
//! The input is snapped to the nearest note of the selected scale rooted at
//! `root` (0 = C, 1 = C#, …), then transposed by `semitones` + 12 *
//! `octaves`. `trig` emits a 5 ms 10 V pulse whenever the emitted note
//! changes — a free "note changed" clock for envelopes.
//!
//! A small hysteresis (`HYSTERESIS_SEMI`) keeps a drifting or noisy input
//! from chattering between adjacent notes: a new note has to be closer than
//! the held one by that margin before the quantizer moves. This works for
//! unevenly spaced scales too (pentatonic, blues) because the comparison is
//! on absolute distance, not on a fixed cell width.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_PITCH: usize = 0;
const IN_SCALE: usize = 1;
const IN_ROOT: usize = 2;
const IN_SEMI: usize = 3;
const IN_OCT: usize = 4;

const OUT_PITCH: usize = 0;
const OUT_TRIG: usize = 1;

const GATE_HIGH_V: f32 = 10.0;
const TRIG_SECONDS: f32 = 0.005;
/// Extra distance (in semitones) a competing note must win by before the
/// quantizer leaves the note it is holding. ~10 cents of dead band.
const HYSTERESIS_SEMI: f32 = 0.1;
const RAIL: f32 = 10.0;

/// Scale degrees in semitones from the root. Index = `scale` input value.
const SCALES: [&[u8]; 10] = [
    &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], // chromatic
    &[0, 2, 4, 5, 7, 9, 11],                 // major (ionian)
    &[0, 2, 3, 5, 7, 8, 10],                 // natural minor (aeolian)
    &[0, 2, 3, 5, 7, 8, 11],                 // harmonic minor
    &[0, 2, 4, 7, 9],                        // pentatonic major
    &[0, 3, 5, 7, 10],                       // pentatonic minor
    &[0, 3, 5, 6, 7, 10],                    // blues
    &[0, 2, 3, 5, 7, 9, 10],                 // dorian
    &[0, 2, 4, 5, 7, 9, 10],                 // mixolydian
    &[0, 2, 4, 6, 8, 10],                    // whole tone
];

pub struct Quantizer {
    sample_rate: f32,
    /// Quantized input note in absolute semitones (pre-transpose).
    held: f32,
    has_held: bool,
    /// Last emitted note in semitones, for change detection.
    last_out_semi: f32,
    trig_left: u32,
    scale_idx: usize,
    root: i32,
}

impl Quantizer {
    /// Nearest note of `scale` (rooted at `root` semitones) to `x`.
    fn snap(x: f32, scale: &[u8], root: i32) -> f32 {
        let rel = x - root as f32;
        let oct = (rel / 12.0).floor();
        let frac = rel - oct * 12.0;
        let mut best = scale[0] as f32;
        let mut best_d = (frac - best).abs();
        for &deg in &scale[1..] {
            let d = (frac - deg as f32).abs();
            if d < best_d {
                best_d = d;
                best = deg as f32;
            }
        }
        // The wrap-around candidate: the root of the next octave up.
        let wrap = scale[0] as f32 + 12.0;
        if (frac - wrap).abs() < best_d {
            best = wrap;
        }
        root as f32 + oct * 12.0 + best
    }
}

impl Module for Quantizer {
    const N_INPUTS: usize = 5;
    const N_OUTPUTS: usize = 2;

    fn new(ctx: &InitCtx) -> Self {
        Quantizer {
            sample_rate: ctx.sample_rate,
            held: 0.0,
            has_held: false,
            last_out_semi: 0.0,
            trig_left: 0,
            scale_idx: 0,
            root: 0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        // Selectors are stepped controls: sample once per block.
        let scale_idx = (io.inputs[IN_SCALE][0].round().clamp(0.0, 9.0)) as usize;
        let root = (io.inputs[IN_ROOT][0].round().clamp(0.0, 11.0)) as i32;
        if scale_idx != self.scale_idx || root != self.root {
            // The held note may not exist in the new scale.
            self.has_held = false;
            self.scale_idx = scale_idx;
            self.root = root;
        }
        let scale = SCALES[scale_idx];
        let trig_len = (TRIG_SECONDS * self.sample_rate) as u32;

        for s in 0..n {
            let x = io.inputs[IN_PITCH][s].clamp(-RAIL, RAIL) * 12.0;
            let candidate = Self::snap(x, scale, root);
            // A fresh note (startup, or a scale/root change) always
            // re-triggers, even when it lands on the same pitch as before.
            let mut fresh = false;
            if !self.has_held {
                self.held = candidate;
                self.has_held = true;
                fresh = true;
            } else if candidate != self.held
                && (x - candidate).abs() + HYSTERESIS_SEMI < (x - self.held).abs()
            {
                self.held = candidate;
            }

            let transpose = io.inputs[IN_SEMI][s].round() + 12.0 * io.inputs[IN_OCT][s].round();
            let out_semi = self.held + transpose;
            if fresh || out_semi != self.last_out_semi {
                self.last_out_semi = out_semi;
                self.trig_left = trig_len;
            }

            io.outputs[OUT_PITCH][s] = (out_semi / 12.0).clamp(-RAIL, RAIL);
            io.outputs[OUT_TRIG][s] = if self.trig_left > 0 {
                self.trig_left -= 1;
                GATE_HIGH_V
            } else {
                0.0
            };
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(13);
        out.extend_from_slice(&self.held.to_le_bytes());
        out.extend_from_slice(&self.last_out_semi.to_le_bytes());
        out.extend_from_slice(&self.trig_left.to_le_bytes());
        out.push(self.has_held as u8);
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 13 {
            self.held = f32::from_le_bytes(bytes[0..4].try_into().unwrap());
            self.last_out_semi = f32::from_le_bytes(bytes[4..8].try_into().unwrap());
            self.trig_left = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
            self.has_held = bytes[12] != 0;
        }
    }
}

export_module!(Quantizer);
