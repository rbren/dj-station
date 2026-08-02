//! Oscillator module: sine/saw/square/tri. Inputs: pitch, fm, sync.
//! Output: audio (±5, modular audio level within the nominal [-10,+10]).

use dj_module_sdk::{export_module, pitch_to_hz, InitCtx, Module, ProcessIo};

const AMPLITUDE: f32 = 5.0;

const IN_PITCH: usize = 0;
const IN_FM: usize = 1;
const IN_SYNC: usize = 2;

pub struct Oscillator {
    sample_rate: f32,
    phase: f32,
    waveform: u32, // 0=sine 1=saw 2=square 3=tri
    last_sync: f32,
}

impl Module for Oscillator {
    const N_INPUTS: usize = 3;
    const N_OUTPUTS: usize = 1;

    fn new(ctx: &InitCtx) -> Self {
        Oscillator {
            sample_rate: ctx.sample_rate,
            phase: 0.0,
            waveform: 0,
            last_sync: 0.0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        for s in 0..n {
            let pitch = io.inputs[IN_PITCH][s];
            let fm = io.inputs[IN_FM][s];
            let sync = io.inputs[IN_SYNC][s];

            // Hard sync on gate-style rising edge.
            if sync >= 1.0 && self.last_sync < 1.0 {
                self.phase = 0.0;
            }
            self.last_sync = sync;

            // Exponential FM: fm adds to pitch in 1V/oct units.
            let freq = pitch_to_hz(pitch + fm);
            let dp = freq / self.sample_rate;
            let p = self.phase;
            let v = match self.waveform {
                0 => (core::f32::consts::TAU * p).sin(),
                1 => 2.0 * p - 1.0,
                2 => {
                    if p < 0.5 {
                        1.0
                    } else {
                        -1.0
                    }
                }
                _ => {
                    if p < 0.5 {
                        4.0 * p - 1.0
                    } else {
                        3.0 - 4.0 * p
                    }
                }
            };
            io.outputs[0][s] = AMPLITUDE * v;
            self.phase += dp;
            if self.phase >= 1.0 {
                self.phase -= self.phase.floor();
            }
        }
    }

    fn on_param(&mut self, index: u32, value: f32) {
        if index == 0 {
            self.waveform = (value.max(0.0) as u32).min(3);
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(8);
        out.extend_from_slice(&self.phase.to_le_bytes());
        out.extend_from_slice(&self.waveform.to_le_bytes());
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 8 {
            self.phase = f32::from_le_bytes(bytes[0..4].try_into().unwrap());
            self.waveform = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        }
    }
}

export_module!(Oscillator);
