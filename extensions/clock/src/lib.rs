//! Clock / transport: one master phase in beats, nine phase-locked pulse
//! outputs.
//!
//! Inputs: `bpm`, `cv` (BPM CV), `run`, `reset`, `swing`, `beats` (beats per
//! bar). Outputs: `clock` (one pulse per beat), `div2`/`div4`/`div8`/`div16`
//! (every 2/4/8/16 beats), `mul2`/`mul3`/`mul4` (2/3/4 pulses per beat) and
//! `bar` (one pulse every `beats` beats).
//!
//! ## Tempo
//!
//! `bpm` is the base tempo; `cv` scales it exponentially, one octave per
//! unit: `bpm_eff = bpm * 2^cv`, clamped to 1..3000 BPM. So +1 V doubles the
//! tempo and -1 V halves it, matching the 1 V/oct convention used elsewhere;
//! the upper clamp keeps `mul4` inside sane audio-rate territory (200 Hz).
//!
//! ## Phase lock
//!
//! Everything is derived from a single `phase` accumulator counting beats
//! since the last reset: a stream with rate `r` pulses per beat fires its
//! `i`-th pulse when `phase` crosses `i / r`. A rising edge on `reset`
//! zeroes the phase and fires every stream on the spot, so all outputs stay
//! locked to the reset regardless of tempo changes. `run` low freezes the
//! phase (no pulses); raising it resumes exactly where it stopped.
//!
//! ## Swing
//!
//! `swing` (0..1) delays the off-beats of the binary sub-beat streams
//! (`mul2` and `mul4`) only — the beat, the divisions, the triplet stream
//! and the bar output stay strictly on the grid so the swing never drags the
//! transport out of lock. Within each pair of pulses the second one moves
//! from 50 % of the pair (`swing = 0`, straight) to 75 % (`swing = 1`, the
//! maximum shuffle); `swing = 2/3` gives the triplet feel (66.7 %).
//!
//! ## Pulse width
//!
//! Every output emits a fixed 5 ms high (10.0), shortened to at most 45 % of
//! that stream's own pulse interval so fast multiplications at high tempo
//! still produce distinct triggers (`mul4` at 300 BPM has a 50 ms interval
//! and a 5 ms pulse; pushed to 2400 BPM by CV the pulse shrinks with the
//! interval instead of sticking high).

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_BPM: usize = 0;
const IN_CV: usize = 1;
const IN_RUN: usize = 2;
const IN_RESET: usize = 3;
const IN_SWING: usize = 4;
const IN_BEATS: usize = 5;

const N_STREAMS: usize = 9;
/// Pulses per beat per output; the bar stream (index 8) is variable.
const RATES: [f64; N_STREAMS] = [1.0, 0.5, 0.25, 0.125, 0.0625, 2.0, 3.0, 4.0, 0.0];
/// Which streams the swing control applies to (binary sub-beat streams).
const SWUNG: [bool; N_STREAMS] = [false, false, false, false, false, true, false, true, false];
const BAR: usize = 8;

const PULSE_SECS: f32 = 0.005;
const GATE_V: f32 = 10.0;

/// Number of pulses of a stream of `rate` pulses per beat that have started
/// at `phase` beats. `swing` > 0 delays the odd (off-beat) pulse of each
/// pair.
#[inline]
fn pulses_elapsed(phase: f64, rate: f64, swing: f64) -> i64 {
    if phase < 0.0 {
        return 0;
    }
    let x = phase * rate;
    if swing <= 0.0 {
        return x.floor() as i64 + 1;
    }
    let half = x * 0.5;
    let pair = half.floor();
    let u = half - pair;
    let off = 0.5 + 0.25 * swing;
    2 * (pair as i64) + 1 + if u >= off { 1 } else { 0 }
}

pub struct Clock {
    sample_rate: f32,
    phase: f64,
    counts: [i64; N_STREAMS],
    timers: [i32; N_STREAMS],
    last_reset: f32,
}

impl Module for Clock {
    const N_INPUTS: usize = 6;
    const N_OUTPUTS: usize = N_STREAMS;

    fn new(ctx: &InitCtx) -> Self {
        Clock {
            sample_rate: ctx.sample_rate,
            phase: 0.0,
            counts: [0; N_STREAMS],
            timers: [0; N_STREAMS],
            last_reset: 0.0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        if n == 0 {
            return;
        }
        // Tempo-domain controls are sampled once per block; run/reset are
        // read per sample so edges stay sample-accurate.
        let bpm = io.inputs[IN_BPM][0].clamp(1.0, 3000.0) as f64;
        let cv = io.inputs[IN_CV][0].clamp(-5.0, 5.0) as f64;
        let bpm_eff = (bpm * (2.0f64).powf(cv)).clamp(1.0, 3000.0);
        let swing = io.inputs[IN_SWING][0].clamp(0.0, 1.0) as f64;
        let beats = io.inputs[IN_BEATS][0].round().clamp(1.0, 16.0) as f64;
        let inc = bpm_eff / 60.0 / self.sample_rate as f64;

        let mut rates = RATES;
        rates[BAR] = 1.0 / beats;
        let mut widths = [1i32; N_STREAMS];
        let nominal = (PULSE_SECS * self.sample_rate) as f64;
        for (w, &r) in widths.iter_mut().zip(rates.iter()) {
            let interval = self.sample_rate as f64 * 60.0 / bpm_eff / r;
            *w = nominal.min(0.45 * interval).max(1.0) as i32;
        }

        for s in 0..n {
            let reset = io.inputs[IN_RESET][s];
            if reset >= 1.0 && self.last_reset < 1.0 {
                self.phase = 0.0;
                self.counts = [0; N_STREAMS];
            }
            self.last_reset = reset;

            // Stopped: the phase and all pulse counters freeze, so no new
            // pulses start (an in-flight one still finishes).
            if io.inputs[IN_RUN][s] >= 1.0 {
                for i in 0..N_STREAMS {
                    let sw = if SWUNG[i] { swing } else { 0.0 };
                    let c = pulses_elapsed(self.phase, rates[i], sw);
                    if c > self.counts[i] {
                        self.timers[i] = widths[i];
                    }
                    self.counts[i] = c;
                }
                self.phase += inc;
            }
            for i in 0..N_STREAMS {
                io.outputs[i][s] = if self.timers[i] > 0 {
                    self.timers[i] -= 1;
                    GATE_V
                } else {
                    0.0
                };
            }
        }
    }

    fn save_state(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(120);
        out.extend_from_slice(&self.phase.to_le_bytes());
        for c in &self.counts {
            out.extend_from_slice(&c.to_le_bytes());
        }
        for t in &self.timers {
            out.extend_from_slice(&t.to_le_bytes());
        }
        out.extend_from_slice(&self.last_reset.to_le_bytes());
        out
    }

    fn load_state(&mut self, bytes: &[u8]) {
        if bytes.len() < 8 + N_STREAMS * 12 + 4 {
            return;
        }
        self.phase = f64::from_le_bytes(bytes[0..8].try_into().unwrap());
        let mut off = 8;
        for c in self.counts.iter_mut() {
            *c = i64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());
            off += 8;
        }
        for t in self.timers.iter_mut() {
            *t = i32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
            off += 4;
        }
        self.last_reset = f32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
    }
}

export_module!(Clock);
