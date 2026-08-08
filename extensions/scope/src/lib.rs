//! Scope — the analysis half of an oscilloscope.
//!
//! A WASM DSP module cannot draw, and it does not need to: the app layer
//! already receives per-jack telemetry (`JackSlot`: instantaneous value,
//! 100 ms RMS, fast flag) for every wire, and the waveform / XY /
//! spectrum rendering belongs there. What the app cannot get from
//! telemetry is a sample-accurate measurement of the signal itself, so
//! this module passes the input through unchanged and emits it as CV:
//!
//! * `thru`  — the input, bit-identical, so the scope can sit inline.
//! * `pitch` — detected fundamental as 1V/oct (0 = C4), held while unvoiced.
//! * `hz`    — the same fundamental scaled at 1 V per 100 Hz (0..10 V).
//! * `peak`  — decaying peak level in volts over the `window`.
//! * `rms`   — RMS level in volts over the `window`.
//! * `trig`  — a 1 ms, 10 V pulse at the start of every detected period,
//!   so a UI (or another module) can lock a trace to the waveform.
//!
//! Detection is a hysteresis (Schmitt) zero-crossing period measurement on
//! a DC-blocked copy of the input: the threshold scales with the measured
//! peak (`hysteresis`), and the last three periods are median-filtered, so
//! harmonics and noise near the zero crossing do not double the reading.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_SIGNAL: usize = 0;
const IN_HYSTERESIS: usize = 1;
const IN_WINDOW: usize = 2;

const OUT_THRU: usize = 0;
const OUT_PITCH: usize = 1;
const OUT_HZ: usize = 2;
const OUT_PEAK: usize = 3;
const OUT_RMS: usize = 4;
const OUT_TRIG: usize = 5;

/// Detection range, Hz.
const MIN_HZ: f32 = 15.0;
const MAX_HZ: f32 = 12_000.0;
/// Level below which the input counts as silence (volts).
const SILENCE: f32 = 1e-3;
/// Sync pulse width, seconds.
const TRIG_SECS: f32 = 0.001;
const GATE_HIGH: f32 = 10.0;
/// Reference for the pitch output: 1V/oct with 0 V = C4 (PRD §4).
const C4_HZ: f32 = 261.626;

pub struct Scope {
    sample_rate: f32,
    /// DC blocker state.
    dc: f32,
    peak: f32,
    mean_square: f32,
    /// Schmitt trigger state: true once the signal went above +threshold.
    high: bool,
    since_edge: u32,
    /// Last three measured periods, in samples.
    periods: [f32; 3],
    freq: f32,
    pitch: f32,
    trig_left: u32,
}

/// Median of three.
#[inline]
fn median3(a: f32, b: f32, c: f32) -> f32 {
    a.max(b).min(a.min(b).max(c))
}

impl Module for Scope {
    const N_INPUTS: usize = 3;
    const N_OUTPUTS: usize = 6;

    fn new(ctx: &InitCtx) -> Self {
        Scope {
            sample_rate: ctx.sample_rate,
            dc: 0.0,
            peak: 0.0,
            mean_square: 0.0,
            high: false,
            since_edge: 0,
            periods: [0.0; 3],
            freq: 0.0,
            pitch: 0.0,
            trig_left: 0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        let hysteresis = io.inputs[IN_HYSTERESIS][0].clamp(0.01, 0.9);
        let window = io.inputs[IN_WINDOW][0].clamp(0.001, 2.0);
        // Level followers share the window: peak decays over it, the mean
        // square is a one-pole of the same time constant.
        let decay = (-1.0 / (window * self.sample_rate)).exp();
        let ms_coeff = 1.0 - decay;
        let dc_coeff = 1.0 - (-core::f32::consts::TAU * 5.0 / self.sample_rate).exp();
        let min_period = self.sample_rate / MAX_HZ;
        let max_period = self.sample_rate / MIN_HZ;
        let trig_len = (TRIG_SECS * self.sample_rate) as u32;

        for s in 0..n {
            let x = io.inputs[IN_SIGNAL][s];
            io.outputs[OUT_THRU][s] = x;

            // Levels.
            let a = x.abs();
            self.peak = if a > self.peak { a } else { self.peak * decay };
            self.mean_square += ms_coeff * (x * x - self.mean_square);

            // DC-blocked copy for the period detector.
            self.dc += dc_coeff * (x - self.dc);
            let y = x - self.dc;

            let threshold = (hysteresis * self.peak).max(SILENCE);
            self.since_edge = self.since_edge.saturating_add(1);
            if self.high {
                if y < -threshold {
                    self.high = false;
                }
            } else if y > threshold {
                self.high = true;
                let p = self.since_edge as f32;
                if p >= min_period && p <= max_period {
                    self.periods = [self.periods[1], self.periods[2], p];
                    let m = median3(self.periods[0], self.periods[1], self.periods[2]);
                    if m > 0.0 {
                        self.freq = self.sample_rate / m;
                    }
                    self.trig_left = trig_len;
                }
                self.since_edge = 0;
            }
            // Silence or a signal too slow to measure: drop the estimate.
            if self.peak < SILENCE || self.since_edge as f32 > max_period {
                self.freq = 0.0;
            }

            if self.freq > 0.0 {
                self.pitch = (self.freq / C4_HZ).log2().clamp(-10.0, 10.0);
            }
            // `pitch` holds its last reading while unvoiced (`hz` drops to
            // 0, which is how a patch can tell), like a pitch tracker's
            // sample-and-hold.
            io.outputs[OUT_PITCH][s] = self.pitch;
            io.outputs[OUT_HZ][s] = (self.freq * 0.01).clamp(0.0, 10.0);
            io.outputs[OUT_PEAK][s] = self.peak.min(10.0);
            io.outputs[OUT_RMS][s] = self.mean_square.max(0.0).sqrt().min(10.0);
            io.outputs[OUT_TRIG][s] = if self.trig_left > 0 {
                self.trig_left -= 1;
                GATE_HIGH
            } else {
                0.0
            };
        }
    }
}

export_module!(Scope);
