//! Random CV: Turing-machine style looping shift register.
//!
//! Inputs: `clock`, `prob`, `length` (1..16), `range` (output volts),
//! `scale`, `root`. Outputs: `cv` (raw register voltage), `bit1`/`bit2`
//! (gates from register bits 0 and 1), `quant` (`cv` quantized to the
//! selected scale, 1 V/oct) and `reg` — the raw 16-bit register value
//! (0..65535, f32-exact), which drives the panel's bit-lamp display.
//!
//! ## Register
//!
//! A 16-bit shift register shifts one place on every rising clock edge. The
//! bit that wraps around is the one at position `length - 1`, so the pattern
//! repeats every `length` clocks; bits above the tap keep shifting, holding
//! older copies of the loop exactly like the hardware original. The initial
//! contents are a fixed constant and the randomness comes from an inline
//! xorshift32 seeded from a constant, so a patch renders identically every
//! time.
//!
//! ## Probability mapping
//!
//! `prob` is a centre-detented knob, 0..1, mapped to the chance that the
//! recycled bit is flipped before it re-enters the register:
//!
//! - fully counter-clockwise (0.0): flip chance 0.5 — every recycled bit is
//!   a fresh coin toss, i.e. maximum randomness, the loop never settles;
//! - centre (0.5): flip chance 0 — the loop is locked and repeats forever;
//! - fully clockwise (1.0): flip chance 1.0 — the loop is locked but
//!   inverts on every pass, the classic "locked, one octave of variation"
//!   behaviour with a period of `2 * length`.
//!
//! In between the chance interpolates linearly, so just off centre the loop
//! mutates one bit every so often.
//!
//! ## Outputs
//!
//! `cv` is the low 8 bits of the register scaled to 0..`range` volts.
//! `quant` snaps `cv` to the nearest note of `scale` transposed by `root`
//! (0 = C), rounding to the nearest semitone first, so it can drive a
//! 1 V/oct pitch input directly.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_CLOCK: usize = 0;
const IN_PROB: usize = 1;
const IN_LENGTH: usize = 2;
const IN_RANGE: usize = 3;
const IN_SCALE: usize = 4;
const IN_ROOT: usize = 5;

const OUT_CV: usize = 0;
const OUT_BIT1: usize = 1;
const OUT_BIT2: usize = 2;
const OUT_QUANT: usize = 3;
const OUT_REG: usize = 4;

const GATE_V: f32 = 10.0;
const SEED: u32 = 0x1D3B_7A55;
const INIT_REG: u16 = 0xACE1;

/// Scale pitch-class masks (bit i set = semitone i belongs to the scale).
const SCALES: [u16; 10] = [
    0b1111_1111_1111, // chromatic
    0b1010_1011_0101, // major
    0b0101_1010_1101, // natural minor
    0b0110_1010_1101, // dorian
    0b0110_1011_0101, // mixolydian
    0b0010_1001_0101, // major pentatonic
    0b0100_1010_1001, // minor pentatonic
    0b0100_1110_1001, // blues
    0b0101_0101_0101, // whole tone
    0b1001_1010_1101, // harmonic minor
];

#[inline]
fn xorshift32(s: &mut u32) -> u32 {
    let mut x = *s;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *s = x;
    x
}

/// Snap `volts` (1 V/oct) to the nearest semitone that belongs to `mask`
/// transposed by `root`.
fn quantize(volts: f32, mask: u16, root: i32) -> f32 {
    let semi = (volts * 12.0).round() as i32;
    for d in 0..12 {
        for cand in [semi + d, semi - d] {
            let pc = (cand - root).rem_euclid(12);
            if mask & (1 << pc) != 0 {
                return cand as f32 / 12.0;
            }
        }
    }
    volts
}

pub struct Turing {
    reg: u16,
    rng: u32,
    last_clock: f32,
}

impl Module for Turing {
    const N_INPUTS: usize = 6;
    const N_OUTPUTS: usize = 5;

    fn new(_ctx: &InitCtx) -> Self {
        Turing {
            reg: INIT_REG,
            rng: SEED,
            last_clock: 0.0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        let prob = io.inputs[IN_PROB][0].clamp(0.0, 1.0);
        let flip_chance = if prob < 0.5 {
            0.5 - prob
        } else {
            2.0 * prob - 1.0
        };
        let length = (io.inputs[IN_LENGTH][0].round() as i32).clamp(1, 16) as u32;
        let range = io.inputs[IN_RANGE][0].clamp(0.0, 10.0);
        let scale = (io.inputs[IN_SCALE][0].round() as i32).clamp(0, SCALES.len() as i32 - 1);
        let mask = SCALES[scale as usize];
        let root = (io.inputs[IN_ROOT][0].round() as i32).clamp(0, 11);

        for s in 0..n {
            let clock = io.inputs[IN_CLOCK][s];
            if clock >= 1.0 && self.last_clock < 1.0 {
                let mut bit = (self.reg >> (length - 1)) & 1;
                // xorshift32 / 2^32 in [0, 1): fixed-seed, deterministic.
                let r = xorshift32(&mut self.rng) as f32 / 4_294_967_296.0;
                if r < flip_chance {
                    bit ^= 1;
                }
                self.reg = (self.reg << 1) | bit;
            }
            self.last_clock = clock;

            let cv = (self.reg & 0xFF) as f32 / 255.0 * range;
            io.outputs[OUT_CV][s] = cv;
            io.outputs[OUT_BIT1][s] = if self.reg & 1 != 0 { GATE_V } else { 0.0 };
            io.outputs[OUT_BIT2][s] = if self.reg & 2 != 0 { GATE_V } else { 0.0 };
            io.outputs[OUT_QUANT][s] = quantize(cv, mask, root);
            io.outputs[OUT_REG][s] = self.reg as f32;
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(10);
        out.extend_from_slice(&self.reg.to_le_bytes());
        out.extend_from_slice(&self.rng.to_le_bytes());
        out.extend_from_slice(&self.last_clock.to_le_bytes());
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() < 10 {
            return;
        }
        self.reg = u16::from_le_bytes(bytes[0..2].try_into().unwrap());
        self.rng = u32::from_le_bytes(bytes[2..6].try_into().unwrap()).max(1);
        self.last_clock = f32::from_le_bytes(bytes[6..10].try_into().unwrap());
    }
}

export_module!(Turing);
