//! Oscillator module: sine/saw/square/tri. Inputs: pitch, fm, sync,
//! waveform. Output: audio (±5, modular audio level within the nominal
//! [-10,+10]).

use dj_module_sdk::{export_module, pitch_to_hz, InitCtx, Module, ProcessIo};

const AMPLITUDE: f32 = 5.0;

const IN_PITCH: usize = 0;
const IN_FM: usize = 1;
const IN_SYNC: usize = 2;
const IN_WAVEFORM: usize = 3;

pub struct Oscillator {
    sample_rate: f32,
    phase: f32,
    last_sync: f32,
}

impl Module for Oscillator {
    const N_INPUTS: usize = 4;
    const N_OUTPUTS: usize = 1;

    fn new(ctx: &InitCtx) -> Self {
        Oscillator {
            sample_rate: ctx.sample_rate,
            phase: 0.0,
            last_sync: 0.0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        for s in 0..n {
            let pitch = io.inputs[IN_PITCH][s];
            let fm = io.inputs[IN_FM][s];
            let sync = io.inputs[IN_SYNC][s];
            // waveform is an ordinary input: 0=sine 1=saw 2=square 3=tri.
            let waveform = (io.inputs[IN_WAVEFORM][s] + 0.5).clamp(0.0, 3.0) as u32;

            // Hard sync on gate-style rising edge.
            if sync >= 1.0 && self.last_sync < 1.0 {
                self.phase = 0.0;
            }
            self.last_sync = sync;

            // Exponential FM: fm adds to pitch in 1V/oct units.
            let freq = pitch_to_hz(pitch + fm);
            let dp = freq / self.sample_rate;
            let p = self.phase;
            let v = match waveform {
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

    fn save_state(&self) -> Vec<u8> {
        self.phase.to_le_bytes().to_vec()
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() >= 4 {
            self.phase = f32::from_le_bytes(bytes[0..4].try_into().unwrap());
        }
    }
}

export_module!(Oscillator);
