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
//!
//! The two measurement controls own one half of that each, and neither
//! touches the panel's picture — the trace and the spectrum are drawn from
//! the capture ring, which is a fixed 2048 samples wide whatever these say:
//!
//! * `hysteresis` is the Schmitt threshold as a FRACTION OF THE MEASURED
//!   PEAK (0.02..0.6, not volts): the signal has to reach +frac*peak and
//!   come back below -frac*peak to close one cycle, so the same setting
//!   means the same thing at any level. Low, the detector counts every
//!   wiggle a bright harmonic puts near the zero crossing and reads an
//!   octave (or two) high; high, cycles that never reach the threshold are
//!   missed and the reading drops an octave or stops voicing on quiet or
//!   decaying material. It decides the period only — `peak`, `rms` and
//!   `thru` do not know it exists.
//! * `window` is the TIME CONSTANT of the two level followers (seconds):
//!   `peak` jumps to a new maximum instantly and decays towards the signal
//!   with this constant, `rms` is a one-pole average of x² over it. Short
//!   (5 ms) reads individual transients — a kick reads as a spike worth
//!   triggering off; long (0.5 s) reads loudness, the smooth envelope you
//!   would duck a bassline with. It is not a buffer length and not an FFT
//!   size: pitch detection, the drawn trace and the spectrum's resolution
//!   are all unaffected by it.
//!
//! `bins` is display-only — the number of log-spaced bars the panel folds
//! its spectrum into (see `ui-src/ScopeUI.tsx`). It is an input jack so it
//! is patchable and survives a save like every other control; the DSP here
//! reads nothing from it.
//!
//! A crossing detector always measures SOMETHING — noise crosses the
//! threshold constantly, and a median of three short random gaps is a
//! perfectly plausible-looking "period" — so a measured period only counts
//! as a PITCH once the signal is shown to actually repeat at it: the
//! module keeps a delay line and tracks the normalized autocorrelation at
//! the current lag, smoothed over several periods. A tone correlates with
//! itself one period back (confidence ~1); noise does not (confidence ~0),
//! so `hz` and `trig` stay silent and a noise source reads "— Hz" instead
//! of an invented fundamental. `pitch` still holds its last reading, the
//! way a pitch tracker's sample-and-hold does.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const IN_SIGNAL: usize = 0;
const IN_HYSTERESIS: usize = 1;
const IN_WINDOW: usize = 2;
/// Read by the panel, not here — but the jack still costs an input slot,
/// and `N_INPUTS` must match the manifest or the host writes past the
/// module's input buffer.
const _IN_BINS: usize = 3;

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
/// Correlation is averaged over this many periods, clamped to the sample
/// window below — long enough that a random signal cannot average its way
/// to a high score, short enough to voice a tone within ~10 ms.
const CONFIDENCE_PERIODS: f32 = 8.0;
const CONFIDENCE_MIN_SAMPLES: f32 = 512.0;
const CONFIDENCE_MAX_SAMPLES: f32 = 4096.0;
/// Normalized autocorrelation at or above which a reading is a pitch and
/// not an accident.
const CONFIDENCE_VOICED: f32 = 0.6;
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
    /// DC-blocked history, one slowest period long, for the correlator.
    history: Vec<f32>,
    write: usize,
    /// Lag the correlator is measuring at, in samples (0 = none yet).
    lag: usize,
    /// Smoothed <y[n] y[n-lag]> and <y²>, whose ratio is `confidence`.
    corr: f32,
    energy: f32,
    /// 0..1 — normalized autocorrelation at `lag`: does the signal really
    /// repeat at the measured period? A tone reaches 1; noise stays near 0.
    confidence: f32,
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
    const N_INPUTS: usize = 4;
    const N_OUTPUTS: usize = 6;

    fn new(ctx: &InitCtx) -> Self {
        // One period of the slowest detectable tone, so the correlator can
        // always reach back a whole period.
        let history_len = (ctx.sample_rate / MIN_HZ).ceil() as usize + 1;
        Scope {
            sample_rate: ctx.sample_rate,
            dc: 0.0,
            peak: 0.0,
            mean_square: 0.0,
            high: false,
            since_edge: 0,
            periods: [0.0; 3],
            history: vec![0.0; history_len],
            write: 0,
            lag: 0,
            corr: 0.0,
            energy: 0.0,
            confidence: 0.0,
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
                        self.lag = (m.round() as usize).min(self.history.len() - 1);
                        if self.confidence >= CONFIDENCE_VOICED {
                            self.trig_left = trig_len;
                        }
                    }
                }
                self.since_edge = 0;
            }

            // Does the signal actually repeat at the measured period? The
            // normalized autocorrelation at that lag, smoothed over a few
            // periods, is the difference between a tone and a coincidence.
            let now = self.write;
            self.history[now] = y;
            self.write = (now + 1) % self.history.len();
            if self.lag > 0 {
                let back = (now + self.history.len() - self.lag) % self.history.len();
                let prev = self.history[back];
                let coeff = 1.0
                    / (CONFIDENCE_PERIODS * self.lag as f32)
                        .clamp(CONFIDENCE_MIN_SAMPLES, CONFIDENCE_MAX_SAMPLES);
                self.corr += coeff * (y * prev - self.corr);
                self.energy += coeff * (0.5 * (y * y + prev * prev) - self.energy);
                self.confidence = if self.energy > SILENCE * SILENCE {
                    (self.corr / self.energy).clamp(0.0, 1.0)
                } else {
                    0.0
                };
            }

            // Silence, a signal too slow to measure, or one that never
            // repeats (noise): no fundamental to report.
            if self.peak < SILENCE || self.since_edge as f32 > max_period {
                self.freq = 0.0;
                self.lag = 0;
                self.corr = 0.0;
                self.energy = 0.0;
                self.confidence = 0.0;
            }
            let voiced = self.freq > 0.0 && self.confidence >= CONFIDENCE_VOICED;

            if voiced {
                self.pitch = (self.freq / C4_HZ).log2().clamp(-10.0, 10.0);
            }
            // `pitch` holds its last reading while unvoiced (`hz` drops to
            // 0, which is how a patch can tell), like a pitch tracker's
            // sample-and-hold.
            io.outputs[OUT_PITCH][s] = self.pitch;
            io.outputs[OUT_HZ][s] = if voiced {
                (self.freq * 0.01).clamp(0.0, 10.0)
            } else {
                0.0
            };
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
