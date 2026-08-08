//! Function generator — a Maths/Rampage style rise/fall unit that is also
//! the patch's slew limiter, lag processor and envelope follower.
//!
//! **Function mode** (nothing patched to `in`). A trigger starts a rise; if
//! `gate` is high when the rise finishes the output holds at +10 V until
//! the gate drops (AR/ASR), otherwise it falls immediately (AD). A gate
//! falling edge always starts the fall, from wherever the output happens to
//! be. With `cycle` on, the fall rolls straight into the next rise, which
//! turns the module into a second LFO whose frequency is
//! `1 / (rise + fall)` and whose waveform is set by the curve.
//!
//! **Slew mode** (a wire in `in`). The output chases the input, limited to
//! `10 V / rise` volts per second going up and `10 V / fall` going down.
//! That single behaviour covers three jobs and no extra switch is needed:
//!
//! * equal rise and fall — portamento / lag for pitch CV,
//! * short rise, long fall on an audio signal — envelope follower, because
//!   the output snaps up to each positive peak and then decays,
//! * long times on a stepped CV — smoothing / glide.
//!
//! **Curve** bends both segments together. At 0 they are straight lines.
//! Positive is the RC shape (fast start, slow approach) for the rise and an
//! exponential decay for the fall; negative is the mirror image. In slew
//! mode positive curve crossfades the linear slew into a one-pole lag, so
//! the top of the range is a classic RC glide.
//!
//! **EOR** is a gate that goes high when the rise completes and stays high
//! through the hold and the fall — cycling, that makes it a square wave in
//! sync with the function. **EOC** is a 2 ms trigger at the end of the
//! fall (in slew mode: when the output catches the input), which chains
//! straight into another Function's trigger input.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_SIGNAL: usize = 0;
const IN_TRIG: usize = 1;
const IN_GATE: usize = 2;
const IN_RISE: usize = 3;
const IN_FALL: usize = 4;
const IN_CURVE: usize = 5;
const IN_CYCLE: usize = 6;

const OUT_MAIN: usize = 0;
const OUT_EOR: usize = 1;
const OUT_EOC: usize = 2;

const PEAK: f32 = 10.0;
const GATE_HIGH: f32 = 10.0;
/// Shortest rise/fall time, in seconds.
const MIN_TIME: f32 = 1e-4;
/// EOC trigger width.
const PULSE_SECS: f32 = 0.002;
/// Slew mode counts as "arrived" within this many volts of the input.
const ARRIVED: f32 = 1e-4;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Idle,
    Rise,
    Hold,
    Fall,
}

pub struct Function {
    sample_rate: f32,
    pulse_samples: u32,
    stage: Stage,
    /// Position within the current segment, 0..1.
    u: f32,
    level: f32,
    eor: bool,
    eoc_left: u32,
    last_trig: f32,
    last_gate: f32,
    /// Slew mode: whether the output was moving on the previous sample.
    moving: bool,
}

impl Function {
    /// Rise exponent. Positive curve gives the RC shape (fast start).
    #[inline]
    fn rise_exp(curve: f32) -> f32 {
        (2.0f32).powf(-3.0 * curve)
    }

    #[inline]
    fn rise_level(u: f32, curve: f32) -> f32 {
        PEAK * u.clamp(0.0, 1.0).powf(Self::rise_exp(curve))
    }

    #[inline]
    fn fall_level(u: f32, curve: f32) -> f32 {
        PEAK * (1.0 - u.clamp(0.0, 1.0)).powf(1.0 / Self::rise_exp(curve))
    }

    /// Segment position that reproduces `level`, so a retrigger or an
    /// early gate release continues from where the output already is.
    #[inline]
    fn enter_rise(&mut self, curve: f32) {
        let n = (self.level / PEAK).clamp(0.0, 1.0);
        self.u = n.powf(1.0 / Self::rise_exp(curve));
        self.stage = Stage::Rise;
        self.eor = false;
    }

    #[inline]
    fn enter_fall(&mut self, curve: f32) {
        let n = (self.level / PEAK).clamp(0.0, 1.0);
        self.u = 1.0 - n.powf(Self::rise_exp(curve));
        self.stage = Stage::Fall;
    }

    #[inline]
    fn end_of_cycle(&mut self) {
        self.level = 0.0;
        self.stage = Stage::Idle;
        self.eor = false;
        self.eoc_left = self.pulse_samples;
    }
}

impl Module for Function {
    const N_INPUTS: usize = 7;
    const N_OUTPUTS: usize = 3;

    fn new(ctx: &InitCtx) -> Self {
        Function {
            sample_rate: ctx.sample_rate,
            pulse_samples: ((PULSE_SECS * ctx.sample_rate) as u32).max(1),
            stage: Stage::Idle,
            u: 0.0,
            level: 0.0,
            eor: false,
            eoc_left: 0,
            last_trig: 0.0,
            last_gate: 0.0,
            moving: false,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        let slew = io.connected_inputs.is_connected(IN_SIGNAL);
        for s in 0..n {
            let rise = io.inputs[IN_RISE][s].max(MIN_TIME);
            let fall = io.inputs[IN_FALL][s].max(MIN_TIME);
            let curve = io.inputs[IN_CURVE][s].clamp(-1.0, 1.0);
            let cycle = io.inputs[IN_CYCLE][s] >= 0.5;
            let trig = io.inputs[IN_TRIG][s];
            let gate = io.inputs[IN_GATE][s];

            if slew {
                let target = io.inputs[IN_SIGNAL][s].clamp(-PEAK, PEAK);
                let delta = target - self.level;
                let time = if delta >= 0.0 { rise } else { fall };
                let linear = PEAK / (time * self.sample_rate);
                // Positive curve crossfades the constant-rate slew into a
                // one-pole lag with the same time constant.
                let blend = curve.max(0.0);
                let pole = 1.0 - (-1.0 / (time * self.sample_rate)).exp();
                let step =
                    (1.0 - blend) * linear.min(delta.abs()) * delta.signum() + blend * delta * pole;
                let was_moving = self.moving;
                if delta.abs() <= ARRIVED {
                    self.level = target;
                    self.moving = false;
                    if was_moving {
                        self.eoc_left = self.pulse_samples;
                    }
                } else {
                    self.level += step;
                    self.moving = true;
                }
                self.eor = delta < 0.0 && self.moving;
            } else {
                let trig_edge = trig >= 1.0 && self.last_trig < 1.0;
                let gate_rise = gate >= 1.0 && self.last_gate < 1.0;
                let gate_drop = gate <= 0.0 && self.last_gate > 0.0;
                if trig_edge || gate_rise {
                    self.enter_rise(curve);
                } else if gate_drop && matches!(self.stage, Stage::Rise | Stage::Hold) {
                    self.enter_fall(curve);
                }

                match self.stage {
                    Stage::Idle => {
                        self.level = 0.0;
                        if cycle {
                            self.enter_rise(curve);
                        }
                    }
                    Stage::Rise => {
                        self.u += 1.0 / (rise * self.sample_rate);
                        if self.u >= 1.0 {
                            self.level = PEAK;
                            self.eor = true;
                            self.u = 0.0;
                            self.stage = if gate >= 1.0 {
                                Stage::Hold
                            } else {
                                Stage::Fall
                            };
                        } else {
                            self.level = Self::rise_level(self.u, curve);
                        }
                    }
                    Stage::Hold => {
                        self.level = PEAK;
                    }
                    Stage::Fall => {
                        self.u += 1.0 / (fall * self.sample_rate);
                        if self.u >= 1.0 {
                            self.end_of_cycle();
                            if cycle {
                                self.enter_rise(curve);
                            }
                        } else {
                            self.level = Self::fall_level(self.u, curve);
                        }
                    }
                }
            }
            self.last_trig = trig;
            self.last_gate = gate;

            io.outputs[OUT_MAIN][s] = self.level.clamp(-PEAK, PEAK);
            io.outputs[OUT_EOR][s] = if self.eor { GATE_HIGH } else { 0.0 };
            io.outputs[OUT_EOC][s] = if self.eoc_left > 0 {
                self.eoc_left -= 1;
                GATE_HIGH
            } else {
                0.0
            };
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(18);
        out.push(match self.stage {
            Stage::Idle => 0,
            Stage::Rise => 1,
            Stage::Hold => 2,
            Stage::Fall => 3,
        });
        out.push(self.eor as u8);
        out.extend_from_slice(&self.u.to_le_bytes());
        out.extend_from_slice(&self.level.to_le_bytes());
        out.extend_from_slice(&self.last_trig.to_le_bytes());
        out.extend_from_slice(&self.last_gate.to_le_bytes());
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 18 {
            self.stage = match bytes[0] {
                1 => Stage::Rise,
                2 => Stage::Hold,
                3 => Stage::Fall,
                _ => Stage::Idle,
            };
            self.eor = bytes[1] != 0;
            self.u = f32::from_le_bytes(bytes[2..6].try_into().unwrap());
            self.level = f32::from_le_bytes(bytes[6..10].try_into().unwrap());
            self.last_trig = f32::from_le_bytes(bytes[10..14].try_into().unwrap());
            self.last_gate = f32::from_le_bytes(bytes[14..18].try_into().unwrap());
        }
    }
}

export_module!(Function);
