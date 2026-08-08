//! Dattorro plate reverb.
//!
//! Topology (Dattorro 1997): input bandwidth lowpass -> four cascaded
//! allpass diffusers -> a figure-of-eight tank of two branches, each
//! `modulated allpass -> delay -> damping lowpass -> allpass -> delay`,
//! cross-coupled through the `decay` coefficient. The stereo outputs are
//! the paper's multi-tap sums taken across both branches.
//!
//! All delay lines are allocated once in [`Module::new`], sized for the
//! largest `size` setting; `size` scales the read lengths at block rate.
//! Tank nodes are soft-clipped, so even `freeze` (decay = 1, input muted,
//! damping bypassed) cannot run away.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_L: usize = 0;
const IN_R: usize = 1;
const IN_SIZE: usize = 2;
const IN_DECAY: usize = 3;
const IN_DAMPING: usize = 4;
const IN_DIFFUSION: usize = 5;
const IN_FREEZE: usize = 6;
const IN_MIX: usize = 7;

/// Dattorro's delay lengths are quoted at this sample rate.
const RATE_REF: f32 = 29761.0;
const SIZE_MAX: f32 = 1.25;
/// Soft-clip ceiling for tank nodes, in volts.
const CEILING: f32 = 12.0;
/// Peak excursion of the tank modulation, in reference samples.
const MOD_DEPTH: f32 = 8.0;

// Reference lengths (samples @ RATE_REF).
const L_AP1: f32 = 142.0;
const L_AP2: f32 = 107.0;
const L_AP3: f32 = 379.0;
const L_AP4: f32 = 277.0;
const L_LAP1: f32 = 672.0;
const L_LDEL1: f32 = 4453.0;
const L_LAP2: f32 = 1800.0;
const L_LDEL2: f32 = 3720.0;
const L_RAP1: f32 = 908.0;
const L_RDEL1: f32 = 4217.0;
const L_RAP2: f32 = 2656.0;
const L_RDEL2: f32 = 3163.0;

#[inline]
fn soft_clip(x: f32) -> f32 {
    if x.is_finite() {
        CEILING * (x / CEILING).tanh()
    } else {
        0.0
    }
}

/// Power-of-two circular delay line. `tap(d)` returns the sample pushed
/// `d` steps ago (so a length-`n` delay reads `tap(n - 1)` before pushing).
struct Line {
    buf: Vec<f32>,
    mask: usize,
    w: usize,
}

impl Line {
    fn new(max_len: usize) -> Self {
        let n = (max_len + 4).next_power_of_two();
        Line {
            buf: vec![0.0; n],
            mask: n - 1,
            w: 0,
        }
    }

    #[inline]
    fn push(&mut self, v: f32) {
        self.w = (self.w + 1) & self.mask;
        self.buf[self.w] = v;
    }

    #[inline]
    fn tap(&self, d: usize) -> f32 {
        self.buf[(self.w + self.buf.len() - (d & self.mask)) & self.mask]
    }

    #[inline]
    fn tap_frac(&self, d: f32) -> f32 {
        let i = d.max(0.0) as usize;
        let f = d - i as f32;
        let a = self.tap(i);
        let b = self.tap(i + 1);
        a + (b - a) * f
    }

    /// Schroeder allpass of logical length `len` and coefficient `g`.
    #[inline]
    fn allpass(&mut self, len: usize, g: f32, x: f32) -> f32 {
        let d = self.tap(len.max(1) - 1);
        let v = x - g * d;
        self.push(v);
        d + g * v
    }

    /// Allpass with a fractional (modulated) length.
    #[inline]
    fn allpass_frac(&mut self, len: f32, g: f32, x: f32) -> f32 {
        let d = self.tap_frac((len - 1.0).max(0.0));
        let v = x - g * d;
        self.push(v);
        d + g * v
    }

    /// Pure delay of logical length `len`: read the old sample, push `x`.
    #[inline]
    fn delay(&mut self, len: usize, x: f32) -> f32 {
        let d = self.tap(len.max(1) - 1);
        self.push(x);
        d
    }
}

pub struct Reverb {
    sample_rate: f32,
    /// Host samples per reference sample.
    scale: f32,
    bandwidth: f32,
    in_lp: f32,
    ap1: Line,
    ap2: Line,
    ap3: Line,
    ap4: Line,
    lap1: Line,
    ldel1: Line,
    lap2: Line,
    ldel2: Line,
    rap1: Line,
    rdel1: Line,
    rap2: Line,
    rdel2: Line,
    damp_l: f32,
    damp_r: f32,
    tank_l: f32,
    tank_r: f32,
    lfo1: f32,
    lfo2: f32,
    lfo_inc1: f32,
    lfo_inc2: f32,
    /// Smoothed input gain (0 while frozen) and tank decay coefficient.
    in_gain: f32,
    decay: f32,
}

/// Allocation length for a reference length at the host rate.
fn max_len(reference: f32, scale: f32) -> usize {
    (reference * scale * SIZE_MAX) as usize + 8
}

impl Reverb {
    #[inline]
    fn len_of(&self, reference: f32, size: f32) -> usize {
        (reference * self.scale * size) as usize + 1
    }
}

impl Module for Reverb {
    const N_INPUTS: usize = 8;
    const N_OUTPUTS: usize = 2;

    fn new(ctx: &InitCtx) -> Self {
        let scale = ctx.sample_rate / RATE_REF;
        Reverb {
            sample_rate: ctx.sample_rate,
            scale,
            // Input bandwidth: gentle 9 kHz lowpass ahead of the diffusers.
            bandwidth: 1.0 - (-core::f32::consts::TAU * 9000.0 / ctx.sample_rate).exp(),
            in_lp: 0.0,
            ap1: Line::new(max_len(L_AP1, scale)),
            ap2: Line::new(max_len(L_AP2, scale)),
            ap3: Line::new(max_len(L_AP3, scale)),
            ap4: Line::new(max_len(L_AP4, scale)),
            lap1: Line::new(max_len(L_LAP1 + 2.0 * MOD_DEPTH, scale)),
            ldel1: Line::new(max_len(L_LDEL1, scale)),
            lap2: Line::new(max_len(L_LAP2, scale)),
            ldel2: Line::new(max_len(L_LDEL2, scale)),
            rap1: Line::new(max_len(L_RAP1 + 2.0 * MOD_DEPTH, scale)),
            rdel1: Line::new(max_len(L_RDEL1, scale)),
            rap2: Line::new(max_len(L_RAP2, scale)),
            rdel2: Line::new(max_len(L_RDEL2, scale)),
            damp_l: 0.0,
            damp_r: 0.0,
            tank_l: 0.0,
            tank_r: 0.0,
            lfo1: 0.0,
            lfo2: 0.25,
            // Slightly detuned tank modulation (Dattorro's ~1 Hz).
            lfo_inc1: 0.93 / ctx.sample_rate,
            lfo_inc2: 1.13 / ctx.sample_rate,
            in_gain: 1.0,
            decay: 0.5,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        let size = io.inputs[IN_SIZE][0].clamp(0.2, SIZE_MAX);
        let decay_ctl = io.inputs[IN_DECAY][0].clamp(0.0, 1.0);
        let damping = io.inputs[IN_DAMPING][0].clamp(0.0, 1.0);
        let diffusion = io.inputs[IN_DIFFUSION][0].clamp(0.0, 1.0);
        let frozen = io.inputs[IN_FREEZE][0] >= 0.5;
        let mix = io.inputs[IN_MIX][0].clamp(0.0, 1.0);

        let in_g1 = 0.75 * diffusion;
        let in_g2 = 0.625 * diffusion;
        let tank_g1 = 0.7 * diffusion;
        let tank_g2 = (0.5 * diffusion).clamp(0.1, 0.5);

        // Damping cutoff: bright (18 kHz) to dark (500 Hz), bypassed frozen.
        let damp_hz = 18000.0 * (500.0f32 / 18000.0).powf(damping);
        let damp_a = if frozen {
            1.0
        } else {
            (1.0 - (-core::f32::consts::TAU * damp_hz / self.sample_rate).exp()).clamp(0.0, 1.0)
        };
        let target_decay = if frozen { 1.0 } else { 0.2 + 0.79 * decay_ctl };
        let target_gain = if frozen { 0.0 } else { 1.0 };
        // ~20 ms smoothing so freeze/decay moves don't click.
        let smooth = 1.0 - (-1.0 / (0.02 * self.sample_rate)).exp();

        let l_ap1 = self.len_of(L_AP1, size);
        let l_ap2 = self.len_of(L_AP2, size);
        let l_ap3 = self.len_of(L_AP3, size);
        let l_ap4 = self.len_of(L_AP4, size);
        let l_lap1 = L_LAP1 * self.scale * size;
        let l_ldel1 = self.len_of(L_LDEL1, size);
        let l_lap2 = self.len_of(L_LAP2, size);
        let l_ldel2 = self.len_of(L_LDEL2, size);
        let l_rap1 = L_RAP1 * self.scale * size;
        let l_rdel1 = self.len_of(L_RDEL1, size);
        let l_rap2 = self.len_of(L_RAP2, size);
        let l_rdel2 = self.len_of(L_RDEL2, size);
        let mod_depth = MOD_DEPTH * self.scale;
        let tap_scale = self.scale * size;
        let tap = |reference: f32| -> usize { (reference * tap_scale) as usize };

        for s in 0..n {
            self.in_gain += smooth * (target_gain - self.in_gain);
            self.decay += smooth * (target_decay - self.decay);

            let dry_l = io.inputs[IN_L][s];
            let dry_r = io.inputs[IN_R][s];
            let x = 0.5 * (dry_l + dry_r) * self.in_gain;
            self.in_lp += self.bandwidth * (x - self.in_lp);
            let mut d = self.in_lp;
            d = self.ap1.allpass(l_ap1, in_g1, d);
            d = self.ap2.allpass(l_ap2, in_g1, d);
            d = self.ap3.allpass(l_ap3, in_g2, d);
            d = self.ap4.allpass(l_ap4, in_g2, d);

            self.lfo1 += self.lfo_inc1;
            self.lfo2 += self.lfo_inc2;
            if self.lfo1 >= 1.0 {
                self.lfo1 -= 1.0;
            }
            if self.lfo2 >= 1.0 {
                self.lfo2 -= 1.0;
            }
            let m1 = mod_depth * (core::f32::consts::TAU * self.lfo1).sin();
            let m2 = mod_depth * (core::f32::consts::TAU * self.lfo2).sin();

            // Left branch: diffused input + decayed right branch output.
            let mut a = self
                .lap1
                .allpass_frac(l_lap1 + mod_depth + m1, -tank_g1, d + self.tank_r);
            a = self.ldel1.delay(l_ldel1, a);
            self.damp_l += damp_a * (a - self.damp_l);
            a = self.damp_l * self.decay;
            a = self.lap2.allpass(l_lap2, tank_g2, a);
            a = self.ldel2.delay(l_ldel2, a);
            self.tank_l = soft_clip(a * self.decay);

            // Right branch: diffused input + decayed left branch output.
            let mut b = self
                .rap1
                .allpass_frac(l_rap1 + mod_depth + m2, -tank_g1, d + self.tank_l);
            b = self.rdel1.delay(l_rdel1, b);
            self.damp_r += damp_a * (b - self.damp_r);
            b = self.damp_r * self.decay;
            b = self.rap2.allpass(l_rap2, tank_g2, b);
            b = self.rdel2.delay(l_rdel2, b);
            self.tank_r = soft_clip(b * self.decay);

            // Dattorro's output taps, read across both branches.
            let wet_l = 0.6
                * (self.rdel1.tap(tap(266.0)) + self.rdel1.tap(tap(2974.0))
                    - self.rap2.tap(tap(1913.0))
                    + self.rdel2.tap(tap(1996.0))
                    - self.ldel1.tap(tap(1990.0))
                    - self.lap2.tap(tap(187.0))
                    - self.ldel2.tap(tap(1066.0)));
            let wet_r = 0.6
                * (self.ldel1.tap(tap(353.0)) + self.ldel1.tap(tap(3627.0))
                    - self.lap2.tap(tap(1228.0))
                    + self.ldel2.tap(tap(2673.0))
                    - self.rdel1.tap(tap(2111.0))
                    - self.rap2.tap(tap(335.0))
                    - self.rdel2.tap(tap(121.0)));

            io.outputs[0][s] = dry_l * (1.0 - mix) + soft_clip(wet_l) * mix;
            io.outputs[1][s] = dry_r * (1.0 - mix) + soft_clip(wet_r) * mix;
        }
    }
}

export_module!(Reverb);
