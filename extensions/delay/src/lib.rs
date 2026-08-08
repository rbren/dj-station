//! Stereo delay with tape-style time modulation.
//!
//! Up to 4 s per channel, allocated once in [`Module::new`]. The read head
//! is fractional (Catmull-Rom interpolated) and chases the target delay
//! through a one-pole slew, so moving `time` pitches the delayed audio like
//! a tape machine instead of clicking.
//!
//! Clock sync: when the `clock` jack is wired, the delay time follows the
//! measured clock period multiplied by the `div` selector; the `time` knob
//! is ignored until the clock is unpatched.
//!
//! The feedback path runs through a one-pole lowpass and a one-pole
//! highpass (the classic "each repeat gets darker and thinner" behaviour)
//! and a soft saturator, so feedback at 1.0 self-oscillates without
//! blowing up. `pingpong` crosses the feedback between channels.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_L: usize = 0;
const IN_R: usize = 1;
const IN_TIME: usize = 2;
const IN_CLOCK: usize = 3;
const IN_DIV: usize = 4;
const IN_FEEDBACK: usize = 5;
const IN_LOWPASS: usize = 6;
const IN_HIGHPASS: usize = 7;
const IN_MIX: usize = 8;
const IN_PINGPONG: usize = 9;

const MAX_DELAY_SECS: f32 = 4.0;
/// Slew time constant of the read head, seconds (the "tape inertia").
const TIME_SLEW: f32 = 0.05;
/// Clock divisions selectable on `div`, in whole-clock-period units.
const DIVISIONS: [f32; 9] = [0.125, 0.25, 1.0 / 3.0, 0.5, 2.0 / 3.0, 0.75, 1.0, 1.5, 2.0];
/// Soft-saturation ceiling in volts (audio is nominally ±5).
const CEILING: f32 = 8.0;

#[inline]
fn soft_clip(x: f32) -> f32 {
    CEILING * (x / CEILING).tanh()
}

/// One-pole coefficient for a cutoff in Hz.
#[inline]
fn one_pole_coeff(hz: f32, sample_rate: f32) -> f32 {
    let x = (-core::f32::consts::TAU * hz / sample_rate).exp();
    (1.0 - x).clamp(0.0, 1.0)
}

struct Channel {
    buf: Vec<f32>,
    write: usize,
    lp: f32,
    hp: f32,
}

impl Channel {
    fn new(len: usize) -> Self {
        Channel {
            buf: vec![0.0; len],
            write: 0,
            lp: 0.0,
            hp: 0.0,
        }
    }

    /// Catmull-Rom read `delay` samples behind the write head.
    #[inline]
    fn read(&self, delay: f32) -> f32 {
        let mask = self.buf.len() - 1;
        let d = delay.max(1.0);
        let i = d.floor();
        let frac = d - i;
        let base = self.write + self.buf.len() - i as usize;
        let s = |k: usize| -> f32 { self.buf[(base + k) & mask] };
        // Points around the read position: y1 is the sample at `i`.
        let y0 = s(1);
        let y1 = s(0);
        let y2 = s(self.buf.len() - 1);
        let y3 = s(self.buf.len() - 2);
        let a = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
        let b = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
        let c = 0.5 * (y2 - y0);
        // Interpolating backwards in time: t runs from y1 towards y2.
        let t = frac;
        ((a * t + b) * t + c) * t + y1
    }

    #[inline]
    fn write(&mut self, v: f32) {
        let mask = self.buf.len() - 1;
        self.write = (self.write + 1) & mask;
        self.buf[self.write] = v;
    }

    /// Lowpass then highpass, both one-pole, in the feedback path.
    #[inline]
    fn damp(&mut self, x: f32, lp_a: f32, hp_a: f32) -> f32 {
        self.lp += lp_a * (x - self.lp);
        self.hp += hp_a * (self.lp - self.hp);
        self.lp - self.hp
    }
}

pub struct Delay {
    sample_rate: f32,
    left: Channel,
    right: Channel,
    max_delay: f32,
    /// Slewed read-head distance in samples (the tape position).
    delay: f32,
    slew: f32,
    last_clock: f32,
    clock_counter: u32,
    clock_period: f32,
}

impl Delay {
    fn target_delay(&self, io: &ProcessIo) -> f32 {
        let clocked = io.connected_inputs.is_connected(IN_CLOCK);
        let d = if clocked && self.clock_period > 0.0 {
            let idx = (io.inputs[IN_DIV][0] + 0.5).clamp(0.0, 8.0) as usize;
            self.clock_period * DIVISIONS[idx]
        } else {
            io.inputs[IN_TIME][0].clamp(0.0005, MAX_DELAY_SECS) * self.sample_rate
        };
        d.clamp(1.0, self.max_delay)
    }
}

impl Module for Delay {
    const N_INPUTS: usize = 10;
    const N_OUTPUTS: usize = 2;

    fn new(ctx: &InitCtx) -> Self {
        let needed = (MAX_DELAY_SECS * ctx.sample_rate) as usize + 4;
        let len = needed.next_power_of_two();
        Delay {
            sample_rate: ctx.sample_rate,
            left: Channel::new(len),
            right: Channel::new(len),
            max_delay: (len - 4) as f32,
            delay: 0.25 * ctx.sample_rate,
            slew: 1.0 - (-1.0 / (TIME_SLEW * ctx.sample_rate)).exp(),
            last_clock: 0.0,
            clock_counter: 0,
            clock_period: 0.0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        let feedback = io.inputs[IN_FEEDBACK][0].clamp(0.0, 1.0);
        let lp_a = one_pole_coeff(
            io.inputs[IN_LOWPASS][0].clamp(20.0, 0.45 * self.sample_rate),
            self.sample_rate,
        );
        let hp_a = one_pole_coeff(
            io.inputs[IN_HIGHPASS][0].clamp(5.0, 0.45 * self.sample_rate),
            self.sample_rate,
        );
        let mix = io.inputs[IN_MIX][0].clamp(0.0, 1.0);
        let pingpong = io.inputs[IN_PINGPONG][0] >= 0.5;
        let clocked = io.connected_inputs.is_connected(IN_CLOCK);
        let target = self.target_delay(io);

        for s in 0..n {
            if clocked {
                let c = io.inputs[IN_CLOCK][s];
                self.clock_counter = self.clock_counter.saturating_add(1);
                if c >= 1.0 && self.last_clock < 1.0 {
                    let p = self.clock_counter as f32;
                    if p >= 16.0 {
                        self.clock_period = p.min(self.max_delay);
                    }
                    self.clock_counter = 0;
                }
                self.last_clock = c;
            }

            self.delay += self.slew * (target - self.delay);
            let dl = self.left.read(self.delay);
            let dr = self.right.read(self.delay);
            let fl = self.left.damp(dl, lp_a, hp_a);
            let fr = self.right.damp(dr, lp_a, hp_a);
            let (fb_l, fb_r) = if pingpong { (fr, fl) } else { (fl, fr) };

            let in_l = io.inputs[IN_L][s];
            let in_r = io.inputs[IN_R][s];
            self.left.write(soft_clip(in_l + feedback * fb_l));
            self.right.write(soft_clip(in_r + feedback * fb_r));

            io.outputs[0][s] = in_l * (1.0 - mix) + dl * mix;
            io.outputs[1][s] = in_r * (1.0 - mix) + dr * mix;
        }
    }
}

export_module!(Delay);
