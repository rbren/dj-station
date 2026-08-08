//! Wavetable oscillator: eight procedurally generated tables, morphable
//! with a position CV, played back from per-octave mipmaps.
//!
//! The table set is built in [`Module::new`] — nothing is read from disk.
//! Tables 0..5 are a harmonic sweep from a pure sine to a full saw (1, 2, 4,
//! 12, 48 and 1024 harmonics at 1/h); tables 6 and 7 are formant-ish
//! spectra with three resonant harmonic bumps each. `pos` scans the set and
//! crossfades linearly between the two adjacent tables.
//!
//! Antialiasing: every table is stored as ten band-limited mipmaps, level
//! `L` holding `1024 >> L` harmonics, all synthesized by one inverse FFT
//! per level from the same harmonic spectrum (so a level is an exactly
//! band-limited copy, not a resampled approximation). Playback picks the
//! level whose harmonic count still fits under Nyquist at the current
//! frequency, so the top harmonic never aliases; the level index comes
//! straight out of the float exponent instead of a `log2` call.
//!
//! Inputs: `pitch` (1V/oct), `fine` (semitones), `pos` (0..1 across the
//! table set), `fm` + `fm_index` (linear thru-zero FM, same convention as
//! the VCO: `f = f0 * (1 + fm/5 * index)`), `sync` (rising edge resets the
//! phase). Output: `audio` at ±5.

use dj_module_sdk::{export_module, pitch_to_hz, InitCtx, Module, ProcessIo};

const AMPLITUDE: f32 = 5.0;
const TABLE_LEN: usize = 2048;
const TABLE_MASK: usize = TABLE_LEN - 1;
const NUM_TABLES: usize = 8;
const MIP_LEVELS: usize = 10;
/// Harmonics in mip level 0.
const MAX_HARM: usize = TABLE_LEN / 2;
const MAX_INC: f32 = 0.49;

const IN_PITCH: usize = 0;
const IN_FINE: usize = 1;
const IN_POS: usize = 2;
const IN_FM: usize = 3;
const IN_FM_INDEX: usize = 4;
const IN_SYNC: usize = 5;

/// In-place inverse DFT (`x[n] = sum_k X[k] e^{+i2*pi*k*n/N}`, unscaled),
/// radix-2 Cooley-Tukey. Construction-time only.
fn inverse_fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2usize;
    while len <= n {
        let ang = core::f64::consts::TAU / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        let half = len / 2;
        let mut base = 0usize;
        while base < n {
            let (mut cr, mut ci) = (1.0f64, 0.0f64);
            for k in 0..half {
                let (ur, ui) = (re[base + k], im[base + k]);
                let (xr, xi) = (re[base + k + half], im[base + k + half]);
                let (vr, vi) = (xr * cr - xi * ci, xr * ci + xi * cr);
                re[base + k] = ur + vr;
                im[base + k] = ui + vi;
                re[base + k + half] = ur - vr;
                im[base + k + half] = ui - vi;
                let nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
            base += len;
        }
        len <<= 1;
    }
}

/// Amplitude of harmonic `h` (1-based) in table `t`.
fn harmonic_amp(t: usize, h: usize) -> f64 {
    // Tables 0..5: sine -> saw, adding octaves of harmonics.
    const SWEEP: [usize; 6] = [1, 2, 4, 12, 48, MAX_HARM];
    if t < SWEEP.len() {
        return if h <= SWEEP[t] { 1.0 / h as f64 } else { 0.0 };
    }
    // Tables 6/7: formant-ish — three resonant bumps over a gentle tilt.
    let bumps: [(f64, f64, f64); 3] = if t == 6 {
        [(4.0, 2.0, 1.0), (10.0, 3.0, 0.55), (22.0, 6.0, 0.3)]
    } else {
        [(2.0, 1.2, 1.0), (16.0, 4.0, 0.5), (34.0, 8.0, 0.25)]
    };
    if h > 96 {
        return 0.0;
    }
    let x = h as f64;
    let mut a = 0.0;
    for (center, width, gain) in bumps {
        let d = (x - center) / width;
        a += gain * (-d * d).exp();
    }
    a / x.sqrt()
}

#[inline]
fn wrap01(p: f32) -> f32 {
    p - p.floor()
}

/// `ceil(log2(x))` from the float exponent — no libm call on the RT path.
#[inline]
fn ceil_log2(x: f32) -> i32 {
    let bits = x.to_bits();
    let exp = ((bits >> 23) & 0xFF) as i32 - 127;
    if bits & 0x007F_FFFF != 0 {
        exp + 1
    } else {
        exp
    }
}

pub struct Wavetable {
    sample_rate: f32,
    /// `[table][level][sample]`, flattened; allocated once at construction.
    tables: Vec<f32>,
    /// Frequency at which mip level 0 exactly fills the spectrum.
    base_freq: f32,
    phase: f32,
    last_sync: f32,
}

impl Wavetable {
    fn build_tables() -> Vec<f32> {
        let mut tables = vec![0.0f32; NUM_TABLES * MIP_LEVELS * TABLE_LEN];
        let mut re = vec![0.0f64; TABLE_LEN];
        let mut im = vec![0.0f64; TABLE_LEN];
        for t in 0..NUM_TABLES {
            // Level 0 sets the normalization for the whole table so that
            // darker levels stay quieter instead of being pumped back up.
            let mut scale = 1.0f64;
            for level in 0..MIP_LEVELS {
                re.iter_mut().for_each(|v| *v = 0.0);
                im.iter_mut().for_each(|v| *v = 0.0);
                let h_max = (MAX_HARM >> level).max(1);
                for h in 1..=h_max {
                    let a = harmonic_amp(t, h);
                    if a == 0.0 {
                        continue;
                    }
                    // Sine-phase harmonic: X[h] = -i a/2, X[N-h] = +i a/2.
                    im[h] = -0.5 * a;
                    im[TABLE_LEN - h] = 0.5 * a;
                }
                inverse_fft(&mut re, &mut im);
                if level == 0 {
                    let peak = re.iter().fold(0.0f64, |m, v| m.max(v.abs()));
                    scale = if peak > 0.0 { 1.0 / peak } else { 1.0 };
                }
                let base = (t * MIP_LEVELS + level) * TABLE_LEN;
                for (i, &v) in re.iter().enumerate() {
                    tables[base + i] = (v * scale) as f32;
                }
            }
        }
        tables
    }

    /// Linearly interpolated read of one table at one mip level.
    #[inline]
    fn read(&self, table: usize, level: usize, phase: f32) -> f32 {
        let x = phase * TABLE_LEN as f32;
        let i = x as usize & TABLE_MASK;
        let frac = x - x.floor();
        let base = (table * MIP_LEVELS + level) * TABLE_LEN;
        let a = self.tables[base + i];
        let b = self.tables[base + ((i + 1) & TABLE_MASK)];
        a + (b - a) * frac
    }
}

impl Module for Wavetable {
    const N_INPUTS: usize = 6;
    const N_OUTPUTS: usize = 1;

    fn new(ctx: &InitCtx) -> Self {
        let sample_rate = ctx.sample_rate.max(1.0);
        Wavetable {
            sample_rate,
            tables: Self::build_tables(),
            base_freq: 0.5 * sample_rate / MAX_HARM as f32,
            phase: 0.0,
            last_sync: 0.0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        for s in 0..n {
            let sync = io.inputs[IN_SYNC][s];
            if sync >= 1.0 && self.last_sync < 1.0 {
                self.phase = 0.0;
            }
            self.last_sync = sync;

            let pitch =
                io.inputs[IN_PITCH][s].clamp(-12.0, 12.0) + io.inputs[IN_FINE][s] * (1.0 / 12.0);
            let index = io.inputs[IN_FM_INDEX][s].max(0.0);
            let freq = pitch_to_hz(pitch) * (1.0 + io.inputs[IN_FM][s] * 0.2 * index);
            let mut inc = freq / self.sample_rate;
            if !inc.is_finite() {
                inc = 0.0;
            }
            let inc = inc.clamp(-MAX_INC, MAX_INC);

            // Mip level: the first one whose top harmonic still fits under
            // Nyquist at this frequency.
            let level =
                ceil_log2(freq.abs() / self.base_freq).clamp(0, MIP_LEVELS as i32 - 1) as usize;

            let pos = io.inputs[IN_POS][s].clamp(0.0, 1.0) * (NUM_TABLES - 1) as f32;
            let t0 = pos as usize;
            let t1 = (t0 + 1).min(NUM_TABLES - 1);
            let mix = pos - t0 as f32;

            let a = self.read(t0, level, self.phase);
            let b = self.read(t1, level, self.phase);
            io.outputs[0][s] = AMPLITUDE * (a + (b - a) * mix);

            self.phase = wrap01(self.phase + inc);
        }
    }

    fn save_state(&self) -> Vec<u8> {
        self.phase.to_le_bytes().to_vec()
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 4 {
            self.phase = f32::from_le_bytes(bytes[0..4].try_into().unwrap());
        }
    }
}

export_module!(Wavetable);
