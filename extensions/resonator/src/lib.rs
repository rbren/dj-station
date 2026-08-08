//! Rings-style resonator: a modal bank and a Karplus-Strong string mode.
//!
//! * Modal (mode 0): 32 tuned two-pole resonators. `structure` bends the
//!   partial ratios from harmonic (n) towards inharmonic/bell-like
//!   (n^1.6), `brightness` tilts the partial amplitudes, `damping` sets
//!   the decay time and `position` applies the plucked-string excitation
//!   law (partial n is scaled by |sin(pi n position)|).
//! * String (mode 1): up to four Karplus-Strong strings (delay line +
//!   damping lowpass in the loop), spread from unison detune towards
//!   fifths and octaves by `structure`.
//!
//! The `in` jack excites the resonator. With nothing patched there, a
//! rising edge on `trig` fires an internal exciter: a short filtered noise
//! burst from a seeded xorshift32 (deterministic, no OS RNG).
//!
//! Pitch is 1V/oct (0 = C4). All delay lines and state arrays are
//! allocated in [`Module::new`].

use dj_module_sdk::{export_module, pitch_to_hz, InitCtx, Module, ProcessIo};

const IN_EXCITER: usize = 0;
const IN_TRIG: usize = 1;
const IN_PITCH: usize = 2;
const IN_STRUCTURE: usize = 3;
const IN_BRIGHTNESS: usize = 4;
const IN_DAMPING: usize = 5;
const IN_POSITION: usize = 6;
const IN_MODE: usize = 7;
const IN_VOICES: usize = 8;
const IN_MIX: usize = 9;

const N_PARTIALS: usize = 32;
const N_STRINGS: usize = 4;
/// Lowest note the string delay lines are sized for.
const MIN_STRING_HZ: f32 = 20.0;
/// Internal exciter burst length, seconds.
const EXCITER_SECS: f32 = 0.003;
const CEILING: f32 = 8.0;
/// Input trim for the modal bank: a few-millisecond strike keeps feeding a
/// high-Q partial while it rings up, so full-scale drive would slam the
/// saturator. Chosen so a ±5 V strike rings at roughly ±5 V.
const MODAL_DRIVE: f32 = 0.1;

/// String detune/interval spread in octaves, from unison to fifths+octaves.
const UNISON: [f32; N_STRINGS] = [0.0, 0.004, -0.006, 0.009];
const CHORD: [f32; N_STRINGS] = [0.0, 7.0 / 12.0, 1.0, 19.0 / 12.0];

#[inline]
fn soft_clip(x: f32) -> f32 {
    if x.is_finite() {
        CEILING * (x / CEILING).tanh()
    } else {
        0.0
    }
}

/// Deterministic xorshift32 for the internal exciter.
struct Rng(u32);

impl Rng {
    #[inline]
    fn next_bipolar(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x >> 8) as f32 / 8_388_608.0 - 1.0
    }
}

struct KsString {
    buf: Vec<f32>,
    mask: usize,
    w: usize,
    lp: f32,
}

impl KsString {
    fn new(max_len: usize) -> Self {
        let n = (max_len + 4).next_power_of_two();
        KsString {
            buf: vec![0.0; n],
            mask: n - 1,
            w: 0,
            lp: 0.0,
        }
    }

    #[inline]
    fn read(&self, delay: f32) -> f32 {
        let d = delay.clamp(2.0, (self.buf.len() - 2) as f32);
        let i = d as usize;
        let f = d - i as f32;
        let a = self.buf[(self.w + self.buf.len() - i) & self.mask];
        let b = self.buf[(self.w + self.buf.len() - i - 1) & self.mask];
        a + (b - a) * f
    }

    #[inline]
    fn push(&mut self, v: f32) {
        self.w = (self.w + 1) & self.mask;
        self.buf[self.w] = v;
    }
}

pub struct Resonator {
    sample_rate: f32,
    // Modal bank state and per-block coefficients.
    y1: Vec<f32>,
    y2: Vec<f32>,
    a1: Vec<f32>,
    a2: Vec<f32>,
    gain: Vec<f32>,
    strings: Vec<KsString>,
    rng: Rng,
    last_trig: f32,
    exciter_left: u32,
    exciter_lp: f32,
}

impl Resonator {
    /// Recompute the modal bank coefficients for this block.
    #[allow(clippy::too_many_arguments)]
    fn update_partials(
        &mut self,
        f0: f32,
        structure: f32,
        brightness: f32,
        damping: f32,
        position: f32,
    ) {
        let nyquist = 0.45 * self.sample_rate;
        // 0.05 s (heavy damping) to 8 s (long ring).
        let t60_base = 0.05 * (160.0f32).powf(1.0 - damping);
        let stretch = 1.0 + 0.6 * structure;
        let tilt = 1.5 - 1.4 * brightness;
        let pos = position.clamp(0.02, 0.98);
        let mut norm = 0.0f32;
        for i in 0..N_PARTIALS {
            let n = (i + 1) as f32;
            let f = f0 * n.powf(stretch);
            if f >= nyquist || f <= 0.0 {
                self.gain[i] = 0.0;
                self.a1[i] = 0.0;
                self.a2[i] = 0.0;
                continue;
            }
            let t60 = (t60_base / n.powf(0.4)).max(0.005);
            let r = (-6.91 / (t60 * self.sample_rate)).exp().clamp(0.0, 0.99995);
            let w = core::f32::consts::TAU * f / self.sample_rate;
            self.a1[i] = 2.0 * r * w.cos();
            self.a2[i] = -r * r;
            let amp = (core::f32::consts::PI * n * pos).sin().abs() / n.powf(tilt);
            // Impulse-normalized: a struck partial answers at `amp`,
            // independently of its Q (a sustained drive still builds up,
            // which is what the output saturator is there for).
            self.gain[i] = amp;
            norm += amp;
        }
        if norm > 0.0 {
            let scale = 1.0 / norm.max(1e-6);
            for g in self.gain.iter_mut() {
                *g *= scale;
            }
        }
    }

    /// Internal exciter sample: a short filtered noise burst.
    #[inline]
    fn exciter_sample(&mut self, brightness: f32) -> f32 {
        if self.exciter_left == 0 {
            return 0.0;
        }
        self.exciter_left -= 1;
        let hz = 400.0 * (40.0f32).powf(brightness);
        let a = (1.0 - (-core::f32::consts::TAU * hz / self.sample_rate).exp()).clamp(0.0, 1.0);
        let noise = self.rng.next_bipolar();
        self.exciter_lp += a * (noise - self.exciter_lp);
        // Restore the level the one-pole took out of the noise.
        5.0 * self.exciter_lp * ((2.0 - a) / a).sqrt()
    }
}

impl Module for Resonator {
    const N_INPUTS: usize = 10;
    const N_OUTPUTS: usize = 2;

    fn new(ctx: &InitCtx) -> Self {
        let max_len = (ctx.sample_rate / MIN_STRING_HZ) as usize + 4;
        Resonator {
            sample_rate: ctx.sample_rate,
            y1: vec![0.0; N_PARTIALS],
            y2: vec![0.0; N_PARTIALS],
            a1: vec![0.0; N_PARTIALS],
            a2: vec![0.0; N_PARTIALS],
            gain: vec![0.0; N_PARTIALS],
            strings: (0..N_STRINGS).map(|_| KsString::new(max_len)).collect(),
            rng: Rng(0x9E37_79B9),
            last_trig: 0.0,
            exciter_left: 0,
            exciter_lp: 0.0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        let pitch = io.inputs[IN_PITCH][0].clamp(-5.0, 5.0);
        let structure = io.inputs[IN_STRUCTURE][0].clamp(0.0, 1.0);
        let brightness = io.inputs[IN_BRIGHTNESS][0].clamp(0.0, 1.0);
        let damping = io.inputs[IN_DAMPING][0].clamp(0.0, 1.0);
        let position = io.inputs[IN_POSITION][0].clamp(0.0, 1.0);
        let string_mode = io.inputs[IN_MODE][0] >= 0.5;
        let voices = (io.inputs[IN_VOICES][0] + 0.5).clamp(1.0, N_STRINGS as f32) as usize;
        let mix = io.inputs[IN_MIX][0].clamp(0.0, 1.0);
        let external = io.connected_inputs.is_connected(IN_EXCITER);
        let f0 = pitch_to_hz(pitch).clamp(MIN_STRING_HZ, 0.45 * self.sample_rate);

        if string_mode {
            // Loop damping filter: brightness sets the cutoff.
            let hz = 800.0 * (20.0f32).powf(brightness);
            let lp_a =
                (1.0 - (-core::f32::consts::TAU * hz / self.sample_rate).exp()).clamp(0.0, 1.0);
            let t60 = 0.05 * (160.0f32).powf(1.0 - damping);
            let mut delays = [0.0f32; N_STRINGS];
            let mut gains = [0.0f32; N_STRINGS];
            for k in 0..voices {
                let interval = UNISON[k] + structure * (CHORD[k] - UNISON[k]);
                let f = pitch_to_hz(pitch + interval).clamp(MIN_STRING_HZ, 0.45 * self.sample_rate);
                let len = (self.sample_rate / f).clamp(2.0, (self.strings[k].buf.len() - 4) as f32);
                delays[k] = len;
                // Round-trip loss for the requested decay time.
                gains[k] = (10.0f32)
                    .powf(-3.0 * len / (t60 * self.sample_rate))
                    .clamp(0.0, 0.9995);
            }
            let voice_norm = 1.0 / (voices as f32).sqrt();

            for s in 0..n {
                let trig = io.inputs[IN_TRIG][s];
                if trig >= 1.0 && self.last_trig < 1.0 {
                    self.exciter_left = (EXCITER_SECS * self.sample_rate) as u32;
                    self.exciter_lp = 0.0;
                }
                self.last_trig = trig;
                let drive = if external {
                    io.inputs[IN_EXCITER][s]
                } else {
                    self.exciter_sample(brightness)
                };

                let (mut l, mut r) = (0.0f32, 0.0f32);
                for k in 0..voices {
                    let st = &mut self.strings[k];
                    let out = st.read(delays[k]);
                    st.lp += lp_a * (out - st.lp);
                    st.push(soft_clip(drive + gains[k] * st.lp));
                    // Strings alternate across the stereo field.
                    if k % 2 == 0 {
                        l += out;
                    } else {
                        r += out;
                    }
                }
                if voices == 1 {
                    r = l;
                }
                let wet_l = soft_clip(l * voice_norm);
                let wet_r = soft_clip(r * voice_norm);
                io.outputs[0][s] = drive * (1.0 - mix) + wet_l * mix;
                io.outputs[1][s] = drive * (1.0 - mix) + wet_r * mix;
            }
        } else {
            self.update_partials(f0, structure, brightness, damping, position);
            for s in 0..n {
                let trig = io.inputs[IN_TRIG][s];
                if trig >= 1.0 && self.last_trig < 1.0 {
                    self.exciter_left = (EXCITER_SECS * self.sample_rate) as u32;
                    self.exciter_lp = 0.0;
                }
                self.last_trig = trig;
                let drive = if external {
                    io.inputs[IN_EXCITER][s]
                } else {
                    self.exciter_sample(brightness)
                };

                let struck = drive * MODAL_DRIVE;
                let (mut l, mut r) = (0.0f32, 0.0f32);
                for i in 0..N_PARTIALS {
                    if self.gain[i] == 0.0 {
                        continue;
                    }
                    let y =
                        self.gain[i] * struck + self.a1[i] * self.y1[i] + self.a2[i] * self.y2[i];
                    self.y2[i] = self.y1[i];
                    self.y1[i] = y;
                    // Odd partials left, even partials right (Rings' odd/even).
                    if i % 2 == 0 {
                        l += y;
                    } else {
                        r += y;
                    }
                }
                let wet_l = soft_clip(l);
                let wet_r = soft_clip(r);
                io.outputs[0][s] = drive * (1.0 - mix) + wet_l * mix;
                io.outputs[1][s] = drive * (1.0 - mix) + wet_r * mix;
            }
        }
    }
}

export_module!(Resonator);
