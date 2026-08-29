//! Spectral Noise: one noise source whose SPECTRUM is the instrument.
//!
//! White noise is shaped by the first two terms of a spectral polynomial
//! written about the tilt frequency `f0`, in `x = log2(f / f0)`:
//!
//! ```text
//! gain(f) dB = tilt * x  +  curve * bell(x)
//! ```
//!
//! - `tilt` is a straight line through the pivot in dB per octave, so the
//!   familiar colours are single numbers: 0 white, -3 pink, -6 red/brown,
//!   +3 blue, +6 violet.
//! - `curve` is the quadratic term, realized as a BELL centred on the
//!   pivot with bipolar gain (a boost or a scoop). A literal `x^2` term
//!   diverges at both ends of the spectrum; a bell is the same curvature
//!   about the pivot with the ends bounded.
//! - `pivot` is the frequency both terms are written about: the point the
//!   tilt turns around and the centre of the bell.
//!
//! The tilt is a cascade of first-order low shelves spaced half an octave
//! apart over +-5 octaves around the pivot, each carrying
//! `-tilt * spacing` dB, which is a straight log-frequency slope to within
//! ~0.5 dB across the audio band (it flattens outside the covered span and
//! near Nyquist, where a first-order shelf has no boost left to give).
//! The curvature bell is one RBJ peaking biquad at the pivot.
//!
//! LEVEL IS NORMALIZED, TONE IS NOT: the shaping filter's white-noise
//! power gain is integrated over a fixed log-frequency grid whenever the
//! controls move, and the output is scaled to [`TARGET_RMS`]. Switching
//! colour is therefore a change of tone, never of loudness, and no
//! setting can drive the rails (violet would otherwise run ~20 dB hot).
//! At the default settings every section is an exact identity and the
//! power gain is exactly 1, so plain white noise costs no filtering at
//! all.
//!
//! The generator is a fixed-seed xorshift32 like the Noise module, so a
//! patch renders identically every time (PRD §10.1 goldens depend on it).

use dj_module_sdk::{export_module, pitch_to_hz, InitCtx, Module, ProcessIo};

const IN_TILT: usize = 0;
const IN_PIVOT: usize = 1;
const IN_CURVE: usize = 2;
const OUT: usize = 0;

const SEED: u32 = 0x1234_5678;

/// Output level every colour is normalized to, in Volts RMS — the same
/// level the Noise module's colours land on.
const TARGET_RMS: f32 = 2.0;
/// Uniform white in [-1, 1] has RMS 1/sqrt(3).
const WHITE_RMS: f32 = 0.577_350_3;

/// Shelf grid: one shelf every half octave, five octaves either side of
/// the pivot. Shelves that would sit below [`MIN_SHELF_HZ`] or above
/// Nyquist are dropped — they would only add a constant, and the power
/// normalization removes constants anyway.
const SHELF_SPACING_OCT: f32 = 0.5;
const SHELF_SPAN_OCT: f32 = 5.0;
/// `2 * SHELF_SPAN_OCT / SHELF_SPACING_OCT + 1`, as a plain constant so
/// the array size is one.
const MAX_SHELVES: usize = 21;
const MIN_SHELF_HZ: f32 = 2.0;

/// Width of the curvature bell (RBJ Q): ~2 octaves, so it reads as
/// curvature about the pivot rather than a resonance.
const CURVE_Q: f32 = 0.7;

const MAX_TILT_DB_PER_OCT: f32 = 12.0;
const MAX_CURVE_DB: f32 = 24.0;
const MIN_PIVOT_HZ: f32 = 10.0;
/// Rails. Normalization keeps peaks well inside these; the clamp is only
/// a backstop for an extreme modulated setting.
const RAIL: f32 = 10.0;
/// Control change below this does not trigger a coefficient recompute.
const EPS: f32 = 1e-4;

/// Power-gain integration grid: log spaced from [`GRID_LO_HZ`] to Nyquist.
const GRID: usize = 96;
const GRID_LO_HZ: f32 = 5.0;

/// First-order section, direct form II transposed.
#[derive(Clone, Copy, Default)]
struct OnePole {
    b0: f32,
    b1: f32,
    a1: f32,
    z1: f32,
}

impl OnePole {
    fn set_identity(&mut self) {
        self.b0 = 1.0;
        self.b1 = 0.0;
        self.a1 = 0.0;
    }

    /// Low shelf: `gain_db` below `fc`, 0 dB above it.
    fn set_shelf(&mut self, fc: f32, gain_db: f32, sample_rate: f32) {
        let k = (core::f32::consts::PI * fc / sample_rate).tan();
        let a = 10.0f32.powf(gain_db / 20.0);
        self.b0 = (1.0 + a * k) / (1.0 + k);
        self.b1 = (a * k - 1.0) / (1.0 + k);
        self.a1 = (k - 1.0) / (1.0 + k);
    }

    #[inline]
    fn tick(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y;
        y
    }

    /// |H(w)|^2 from cos(w) alone (|b0 + b1 z|^2 = b0^2 + b1^2 + 2 b0 b1 cos w).
    #[inline]
    fn mag2(&self, cos_w: f32) -> f32 {
        let num = self.b0 * self.b0 + self.b1 * self.b1 + 2.0 * self.b0 * self.b1 * cos_w;
        let den = 1.0 + self.a1 * self.a1 + 2.0 * self.a1 * cos_w;
        num / den
    }
}

/// RBJ peaking bell, direct form II transposed.
#[derive(Clone, Copy)]
struct Bell {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Default for Bell {
    fn default() -> Self {
        Bell {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1: 0.0,
            z2: 0.0,
        }
    }
}

impl Bell {
    fn set(&mut self, f0: f32, gain_db: f32, sample_rate: f32) {
        let a = 10.0f32.powf(gain_db / 40.0);
        let w0 = core::f32::consts::TAU * f0 / sample_rate;
        let (sin, cos) = (w0.sin(), w0.cos());
        let alpha = sin / (2.0 * CURVE_Q);
        let a0 = 1.0 + alpha / a;
        self.b0 = (1.0 + alpha * a) / a0;
        self.b1 = -2.0 * cos / a0;
        self.b2 = (1.0 - alpha * a) / a0;
        self.a1 = -2.0 * cos / a0;
        self.a2 = (1.0 - alpha / a) / a0;
    }

    #[inline]
    fn tick(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    #[inline]
    fn mag2(&self, cos_w: f32, sin_w: f32) -> f32 {
        let (cos2, sin2) = (2.0 * cos_w * cos_w - 1.0, 2.0 * sin_w * cos_w);
        let nr = self.b0 + self.b1 * cos_w + self.b2 * cos2;
        let ni = self.b1 * sin_w + self.b2 * sin2;
        let dr = 1.0 + self.a1 * cos_w + self.a2 * cos2;
        let di = self.a1 * sin_w + self.a2 * sin2;
        (nr * nr + ni * ni) / (dr * dr + di * di)
    }
}

pub struct SpectralNoise {
    sample_rate: f32,
    max_hz: f32,
    rng: u32,

    // Cached controls for the change check.
    tilt: f32,
    pivot: f32,
    curve: f32,
    fresh: bool,

    shelves: [OnePole; MAX_SHELVES],
    /// Whether the shelf cascade does anything (a flat tilt skips it).
    shelves_on: bool,
    bell: Bell,
    /// Whether the bell is anything but an identity (a flat `curve` skips
    /// it entirely).
    bell_active: bool,
    gain: f32,

    /// Power-integration grid: cos/sin of each probe frequency and the
    /// `df` weight it stands for (log spacing, so the weight IS the
    /// frequency). Fixed at construction — the grid never moves.
    grid_cos: [f32; GRID],
    grid_sin: [f32; GRID],
    grid_w: [f32; GRID],
    grid_w_sum: f32,
}

impl SpectralNoise {
    #[inline]
    fn next_u32(&mut self) -> u32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        x
    }

    /// Uniform white in [-1, 1].
    #[inline]
    fn white(&mut self) -> f32 {
        self.next_u32() as f32 * (2.0 / 4_294_967_295.0) - 1.0
    }

    /// Rebuild the shaping filter when a control has moved. Runs at block
    /// rate, allocation-free.
    fn recompute(&mut self, tilt: f32, pivot: f32, curve: f32) {
        if self.fresh
            && (self.tilt - tilt).abs() < EPS
            && (self.pivot - pivot).abs() < EPS
            && (self.curve - curve).abs() < EPS
        {
            return;
        }
        self.fresh = true;
        self.tilt = tilt;
        self.pivot = pivot;
        self.curve = curve;

        let tilt = tilt.clamp(-MAX_TILT_DB_PER_OCT, MAX_TILT_DB_PER_OCT);
        let curve = curve.clamp(-MAX_CURVE_DB, MAX_CURVE_DB);
        let f0 = pitch_to_hz(pivot).clamp(MIN_PIVOT_HZ, self.max_hz);

        // A low shelf carrying `-tilt` dB per octave of its own spacing:
        // stacking them from the bottom of the span up integrates into a
        // straight `tilt` dB/octave slope through the pivot. A flat tilt
        // needs no shelves at all (they would each be an exact identity).
        let shelf_db = -tilt * SHELF_SPACING_OCT;
        self.shelves_on = shelf_db.abs() > EPS;
        for k in 0..MAX_SHELVES {
            let fc = f0 * (2.0f32).powf(-SHELF_SPAN_OCT + k as f32 * SHELF_SPACING_OCT);
            // Slot k always holds the k-th shelf of the span, in band or
            // not: a modulated pivot must never leave a slot's filter
            // state standing for a different shelf. Out-of-band shelves go
            // identity — below the band one only adds a constant, and the
            // normalization takes constants out anyway.
            if self.shelves_on && fc >= MIN_SHELF_HZ && fc <= self.max_hz {
                self.shelves[k].set_shelf(fc, shelf_db, self.sample_rate);
            } else {
                self.shelves[k].set_identity();
            }
        }
        self.bell_active = curve.abs() > EPS;
        if self.bell_active {
            self.bell.set(f0, curve, self.sample_rate);
        } else {
            self.bell = Bell::default();
        }

        // White in, shaped out: the output power is the mean of |H|^2 over
        // the band. Normalize it away so colour never means loudness.
        let mut power = 0.0f32;
        let probes = self
            .grid_cos
            .iter()
            .zip(self.grid_sin.iter())
            .zip(self.grid_w.iter());
        for ((&cos_w, &sin_w), &weight) in probes {
            let mut m2 = if self.bell_active {
                self.bell.mag2(cos_w, sin_w)
            } else {
                1.0
            };
            for shelf in &self.shelves {
                m2 *= shelf.mag2(cos_w);
            }
            power += weight * m2;
        }
        let power = (power / self.grid_w_sum).max(1e-12);
        self.gain = TARGET_RMS / WHITE_RMS / power.sqrt();
    }
}

impl Module for SpectralNoise {
    const N_INPUTS: usize = 3;
    const N_OUTPUTS: usize = 1;

    fn new(ctx: &InitCtx) -> Self {
        let sample_rate = ctx.sample_rate.max(1.0);
        let nyquist = 0.5 * sample_rate;
        let mut grid_cos = [0.0f32; GRID];
        let mut grid_sin = [0.0f32; GRID];
        let mut grid_w = [0.0f32; GRID];
        let mut grid_w_sum = 0.0f32;
        let span = (nyquist / GRID_LO_HZ).max(1.0);
        for i in 0..GRID {
            let f = GRID_LO_HZ * span.powf((i as f32 + 0.5) / GRID as f32);
            let w = core::f32::consts::TAU * f / sample_rate;
            grid_cos[i] = w.cos();
            grid_sin[i] = w.sin();
            // Log spacing: each probe stands for a `df` proportional to f.
            grid_w[i] = f;
            grid_w_sum += f;
        }
        SpectralNoise {
            sample_rate,
            max_hz: 0.45 * sample_rate,
            rng: SEED,
            tilt: 0.0,
            pivot: 0.0,
            curve: 0.0,
            fresh: false,
            shelves: [OnePole::default(); MAX_SHELVES],
            shelves_on: false,
            bell: Bell::default(),
            bell_active: false,
            gain: TARGET_RMS / WHITE_RMS,
            grid_cos,
            grid_sin,
            grid_w,
            grid_w_sum,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        self.recompute(
            io.inputs[IN_TILT][0],
            io.inputs[IN_PIVOT][0],
            io.inputs[IN_CURVE][0],
        );
        let n = io.outputs[OUT].len();
        for s in 0..n {
            let mut x = self.white();
            if self.shelves_on {
                for shelf in self.shelves.iter_mut() {
                    x = shelf.tick(x);
                }
            }
            if self.bell_active {
                x = self.bell.tick(x);
            }
            io.outputs[OUT][s] = (x * self.gain).clamp(-RAIL, RAIL);
        }
    }

    fn save_state(&self) -> Vec<u8> {
        self.rng.to_le_bytes().to_vec()
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 4 {
            // xorshift is stuck at zero, so a zero seed is never valid.
            let rng = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
            self.rng = if rng == 0 { SEED } else { rng };
        }
    }
}

export_module!(SpectralNoise);
