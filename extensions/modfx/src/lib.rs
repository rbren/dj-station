//! Chorus / flanger / phaser in one module (`mode` selector).
//!
//! * Chorus  — 12 ms modulated delay, wide swing, mild feedback.
//! * Flanger — 2.6 ms modulated delay, strong feedback, optional
//!   through-zero mode (the dry path is delayed by the sweep centre so the
//!   wet delay passes through and beyond it, giving the through-zero null).
//! * Phaser  — eight cascaded one-pole allpass stages whose coefficients
//!   are swept by the LFO, with feedback around the chain.
//!
//! `spread` offsets the right channel LFO by up to half a cycle. Both
//! delay lines are allocated once in [`Module::new`].

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_L: usize = 0;
const IN_R: usize = 1;
const IN_MODE: usize = 2;
const IN_RATE: usize = 3;
const IN_DEPTH: usize = 4;
const IN_FEEDBACK: usize = 5;
const IN_SPREAD: usize = 6;
const IN_THROUGH_ZERO: usize = 7;
const IN_MIX: usize = 8;

const MODE_CHORUS: u32 = 0;
const MODE_FLANGER: u32 = 1;

const MAX_DELAY_SECS: f32 = 0.032;
const PHASER_STAGES: usize = 8;
/// Soft-clip ceiling for the feedback path, in volts.
const CEILING: f32 = 8.0;

#[inline]
fn soft_clip(x: f32) -> f32 {
    if x.is_finite() {
        CEILING * (x / CEILING).tanh()
    } else {
        0.0
    }
}

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

    /// Linearly interpolated read `d` samples behind the write head.
    #[inline]
    fn tap_frac(&self, d: f32) -> f32 {
        let d = d.max(0.0);
        let i = d as usize;
        let f = d - i as f32;
        let a = self.buf[(self.w + self.buf.len() - (i & self.mask)) & self.mask];
        let b = self.buf[(self.w + self.buf.len() - ((i + 1) & self.mask)) & self.mask];
        a + (b - a) * f
    }
}

struct Channel {
    line: Line,
    dry_line: Line,
    feedback_state: f32,
    allpass: [f32; PHASER_STAGES],
}

impl Channel {
    fn new(max_len: usize) -> Self {
        Channel {
            line: Line::new(max_len),
            dry_line: Line::new(max_len),
            feedback_state: 0.0,
            allpass: [0.0; PHASER_STAGES],
        }
    }
}

pub struct ModFx {
    sample_rate: f32,
    left: Channel,
    right: Channel,
    phase: f32,
}

/// One sample of the delay-based modes. Returns `(dry, wet)`.
fn delay_voice(
    ch: &mut Channel,
    x: f32,
    delay_samples: f32,
    dry_delay: Option<f32>,
    feedback: f32,
) -> (f32, f32) {
    let wet = ch.line.tap_frac(delay_samples);
    ch.line.push(soft_clip(x + feedback * wet));
    let dry = match dry_delay {
        Some(d) => {
            let out = ch.dry_line.tap_frac(d);
            ch.dry_line.push(x);
            out
        }
        None => x,
    };
    (dry, wet)
}

/// One sample of the phaser chain. `a` is the shared allpass coefficient.
fn phaser_voice(ch: &mut Channel, x: f32, a: f32, feedback: f32) -> f32 {
    let mut y = soft_clip(x + feedback * ch.feedback_state);
    for state in ch.allpass.iter_mut() {
        let out = a * y + *state;
        *state = y - a * out;
        y = out;
    }
    ch.feedback_state = y;
    y
}

impl Module for ModFx {
    const N_INPUTS: usize = 9;
    const N_OUTPUTS: usize = 2;

    fn new(ctx: &InitCtx) -> Self {
        let max_len = (MAX_DELAY_SECS * ctx.sample_rate) as usize + 4;
        ModFx {
            sample_rate: ctx.sample_rate,
            left: Channel::new(max_len),
            right: Channel::new(max_len),
            phase: 0.0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        let mode = (io.inputs[IN_MODE][0] + 0.5).clamp(0.0, 2.0) as u32;
        let rate = io.inputs[IN_RATE][0].clamp(0.001, 20.0);
        let depth = io.inputs[IN_DEPTH][0].clamp(0.0, 1.0);
        let spread = io.inputs[IN_SPREAD][0].clamp(0.0, 1.0);
        let through_zero = io.inputs[IN_THROUGH_ZERO][0] >= 0.5;
        let mix = io.inputs[IN_MIX][0].clamp(0.0, 1.0);
        let fb_limit = match mode {
            MODE_CHORUS => 0.5,
            MODE_FLANGER => 0.92,
            _ => 0.9,
        };
        let feedback = io.inputs[IN_FEEDBACK][0].clamp(-1.0, 1.0) * fb_limit;

        let ms = self.sample_rate / 1000.0;
        // Sweep centre and half-swing in samples for the delay modes.
        let (centre, swing) = match mode {
            MODE_CHORUS => (12.0 * ms, depth * 6.0 * ms),
            _ => (2.6 * ms, depth * 2.3 * ms),
        };
        // Through-zero only makes sense for the flanger: delaying the dry
        // path by the sweep centre lets the wet delay cross it. The wet
        // path is inverted there, so coincident delays cancel completely.
        let dry_delay = (mode == MODE_FLANGER && through_zero).then_some(centre);
        let wet_sign = if dry_delay.is_some() { -1.0 } else { 1.0 };
        // Phaser sweep: 200 Hz up to 4 kHz at full depth.
        let phaser_lo = 200.0f32;
        let phaser_hi = phaser_lo * (20.0f32).powf(depth);

        let inc = rate / self.sample_rate;
        let offset = 0.5 * spread;

        for s in 0..n {
            self.phase += inc;
            if self.phase >= 1.0 {
                self.phase -= 1.0;
            }
            let lfo_l = (core::f32::consts::TAU * self.phase).sin();
            let lfo_r = (core::f32::consts::TAU * (self.phase + offset)).sin();
            let in_l = io.inputs[IN_L][s];
            let in_r = io.inputs[IN_R][s];

            let (l, r) = if mode == MODE_CHORUS || mode == MODE_FLANGER {
                let dl = (centre + swing * lfo_l).max(1.0);
                let dr = (centre + swing * lfo_r).max(1.0);
                let (dry_l, wet_l) = delay_voice(&mut self.left, in_l, dl, dry_delay, feedback);
                let (dry_r, wet_r) = delay_voice(&mut self.right, in_r, dr, dry_delay, feedback);
                (
                    dry_l * (1.0 - mix) + wet_sign * wet_l * mix,
                    dry_r * (1.0 - mix) + wet_sign * wet_r * mix,
                )
            } else {
                // First-order allpass with its 90-degree point at `hz`.
                let coeff = |lfo: f32| -> f32 {
                    let hz = phaser_lo * (phaser_hi / phaser_lo).powf(0.5 + 0.5 * lfo);
                    let t = (core::f32::consts::PI * hz / self.sample_rate).tan();
                    ((t - 1.0) / (t + 1.0)).clamp(-0.999, 0.999)
                };
                let wet_l = phaser_voice(&mut self.left, in_l, coeff(lfo_l), feedback);
                let wet_r = phaser_voice(&mut self.right, in_r, coeff(lfo_r), feedback);
                (
                    in_l * (1.0 - mix) + wet_l * mix,
                    in_r * (1.0 - mix) + wet_r * mix,
                )
            };
            io.outputs[0][s] = l;
            io.outputs[1][s] = r;
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

export_module!(ModFx);
