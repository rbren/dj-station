//! ADSR envelope generator. Inputs: gate, retrig, attack, decay, sustain,
//! release. Output: env (0..10).
//!
//! Linear segments: attack 0 -> 10 over `attack` seconds, decay 10 ->
//! 10*sustain over `decay` seconds, sustain hold while the gate is high,
//! release from the current level to 0 over `release` seconds.
//!
//! The A/D/S/R times are ordinary inputs (jack + knob, in seconds /
//! sustain fraction), sampled once per block. A rising edge on `retrig`
//! restarts the attack from the current level while the gate is held.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_GATE: usize = 0;
const IN_RETRIG: usize = 1;
const IN_ATTACK: usize = 2;
const IN_DECAY: usize = 3;
const IN_SUSTAIN: usize = 4;
const IN_RELEASE: usize = 5;

const ENV_MAX: f32 = 10.0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

pub struct Adsr {
    sample_rate: f32,
    attack: f32,
    decay: f32,
    sustain: f32,
    release: f32,
    stage: Stage,
    level: f32,
    release_rate: f32,
    last_gate: f32,
    last_retrig: f32,
}

impl Adsr {
    fn enter_release(&mut self) {
        self.stage = Stage::Release;
        self.release_rate = self.level / (self.release.max(1e-4) * self.sample_rate);
    }
}

impl Module for Adsr {
    const N_INPUTS: usize = 6;
    const N_OUTPUTS: usize = 1;

    fn new(ctx: &InitCtx) -> Self {
        Adsr {
            sample_rate: ctx.sample_rate,
            attack: 0.01,
            decay: 0.1,
            sustain: 0.7,
            release: 0.2,
            stage: Stage::Idle,
            level: 0.0,
            release_rate: 0.0,
            last_gate: 0.0,
            last_retrig: 0.0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n > 0 {
            // A/D/S/R arrive as ordinary inputs; sample at block rate.
            self.attack = io.inputs[IN_ATTACK][0].max(0.0);
            self.decay = io.inputs[IN_DECAY][0].max(0.0);
            self.sustain = io.inputs[IN_SUSTAIN][0].clamp(0.0, 1.0);
            self.release = io.inputs[IN_RELEASE][0].max(0.0);
        }
        let attack_rate = ENV_MAX / (self.attack.max(1e-4) * self.sample_rate);
        let decay_target = ENV_MAX * self.sustain;
        let decay_rate =
            (ENV_MAX - decay_target).max(0.0) / (self.decay.max(1e-4) * self.sample_rate);

        for s in 0..n {
            let gate = io.inputs[IN_GATE][s];
            let retrig = io.inputs[IN_RETRIG][s];

            // Gate edges (high >= 1.0, low <= 0.0 per PRD §4).
            if gate >= 1.0 && self.last_gate < 1.0 {
                self.stage = Stage::Attack;
            } else if gate <= 0.0 && self.last_gate > 0.0 && self.stage != Stage::Idle {
                self.enter_release();
            }
            if retrig >= 1.0 && self.last_retrig < 1.0 && gate >= 1.0 {
                self.stage = Stage::Attack;
            }
            self.last_gate = gate;
            self.last_retrig = retrig;

            match self.stage {
                Stage::Idle => {}
                Stage::Attack => {
                    self.level += attack_rate;
                    if self.level >= ENV_MAX {
                        self.level = ENV_MAX;
                        self.stage = Stage::Decay;
                    }
                }
                Stage::Decay => {
                    self.level -= decay_rate;
                    if self.level <= decay_target {
                        self.level = decay_target;
                        self.stage = Stage::Sustain;
                    }
                }
                Stage::Sustain => {
                    self.level = decay_target;
                }
                Stage::Release => {
                    self.level -= self.release_rate;
                    if self.level <= 0.0 {
                        self.level = 0.0;
                        self.stage = Stage::Idle;
                    }
                }
            }
            io.outputs[0][s] = self.level;
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(13);
        out.extend_from_slice(&self.level.to_le_bytes());
        out.extend_from_slice(&self.release_rate.to_le_bytes());
        out.extend_from_slice(&self.last_gate.to_le_bytes());
        out.push(match self.stage {
            Stage::Idle => 0,
            Stage::Attack => 1,
            Stage::Decay => 2,
            Stage::Sustain => 3,
            Stage::Release => 4,
        });
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 13 {
            self.level = f32::from_le_bytes(bytes[0..4].try_into().unwrap());
            self.release_rate = f32::from_le_bytes(bytes[4..8].try_into().unwrap());
            self.last_gate = f32::from_le_bytes(bytes[8..12].try_into().unwrap());
            self.stage = match bytes[12] {
                1 => Stage::Attack,
                2 => Stage::Decay,
                3 => Stage::Sustain,
                4 => Stage::Release,
                _ => Stage::Idle,
            };
        }
    }
}

export_module!(Adsr);
