//! Drum Voice: kick, snare and hat in one module, 808/909 flavoured.
//!
//! Each voice has its own trigger jack (rising gate edge), tune, decay and
//! tone control, its own output, and all three sum into `mix` at -6 dB so
//! a simultaneous hit still fits the nominal ±10.
//!
//! Voices peak around ±8 V rather than the sustained sources' ±5: drums are
//! transient, so at equal peak they read several dB quieter than a tone —
//! the hotter peak brings their perceived level in line with the rest of
//! the rack.
//!
//! - **Kick** — sine with a fast exponential pitch sweep (starting four
//!   octaves-ish above the tuned frequency and settling in ~25 ms) plus a
//!   noise click transient; `kick_tone` is the click amount.
//! - **Snare** — two detuned sine bodies (f and 1.83 f, the classic
//!   inharmonic 808 pair) with a short decay, plus bandpassed noise with its
//!   own longer decay; `snare_tone` is the body/noise (snappy) balance.
//! - **Hat** — noise through a resonant bandpass blended toward a highpass
//!   by `hat_tone`, with a short decay; `hat_tune` moves the filter.
//!
//! Noise comes from a fixed-seed xorshift32 so renders are reproducible.
//! Filters are TPT state-variable filters (Zavalishin), stable across the
//! whole cutoff range.

use dj_module_sdk::{export_module, InitCtx, Module, ProcessIo};

const AMPLITUDE: f32 = 8.0;
const SEED: u32 = 0x9E37_79B9;
/// -60 dB in nepers: an envelope with time constant `decay / LN_1000`
/// reaches -60 dB exactly at `decay` seconds.
const LN_1000: f32 = 6.907_755;
const MIX_GAIN: f32 = 0.5;

const KICK_BASE_HZ: f32 = 52.0;
const SNARE_BASE_HZ: f32 = 185.0;
const SNARE_NOISE_HZ: f32 = 1_800.0;
const HAT_BASE_HZ: f32 = 6_500.0;

const IN_KICK_TRIG: usize = 0;
const IN_KICK_TUNE: usize = 1;
const IN_KICK_DECAY: usize = 2;
const IN_KICK_TONE: usize = 3;
const IN_SNARE_TRIG: usize = 4;
const IN_SNARE_TUNE: usize = 5;
const IN_SNARE_DECAY: usize = 6;
const IN_SNARE_TONE: usize = 7;
const IN_HAT_TRIG: usize = 8;
const IN_HAT_TUNE: usize = 9;
const IN_HAT_DECAY: usize = 10;
const IN_HAT_TONE: usize = 11;

const OUT_KICK: usize = 0;
const OUT_SNARE: usize = 1;
const OUT_HAT: usize = 2;
const OUT_MIX: usize = 3;

#[inline]
fn wrap01(p: f32) -> f32 {
    p - p.floor()
}

#[inline]
fn sine(p: f32) -> f32 {
    (core::f32::consts::TAU * p).sin()
}

/// Per-sample multiplier for an exponential envelope reaching -60 dB after
/// `seconds`.
#[inline]
fn decay_coeff(seconds: f32, sample_rate: f32) -> f32 {
    (-LN_1000 / (seconds.max(1e-3) * sample_rate)).exp()
}

/// Rising gate edge (PRD §4: high >= 1.0).
#[inline]
fn rising(now: f32, last: &mut f32) -> bool {
    let edge = now >= 1.0 && *last < 1.0;
    *last = now;
    edge
}

/// Topology-preserving state-variable filter (Zavalishin). Returns
/// (lowpass, bandpass, highpass).
#[derive(Default)]
struct Svf {
    ic1: f32,
    ic2: f32,
}

impl Svf {
    #[inline]
    fn process(&mut self, x: f32, g: f32, k: f32) -> (f32, f32, f32) {
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;
        let v3 = x - self.ic2;
        let v1 = a1 * self.ic1 + a2 * v3;
        let v2 = self.ic2 + a2 * self.ic1 + a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        (v2, v1, x - k * v1 - v2)
    }
}

pub struct Drum {
    sample_rate: f32,
    /// Nyquist-safe upper bound for filter cutoffs.
    max_cutoff: f32,
    rng: u32,

    kick_phase: f32,
    kick_env: f32,
    kick_pitch_env: f32,
    kick_click_env: f32,
    kick_last: f32,

    snare_p1: f32,
    snare_p2: f32,
    snare_body_env: f32,
    snare_noise_env: f32,
    snare_svf: Svf,
    snare_last: f32,

    hat_env: f32,
    hat_svf: Svf,
    hat_last: f32,
}

impl Drum {
    #[inline]
    fn white(&mut self) -> f32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        x as f32 * (2.0 / 4_294_967_295.0) - 1.0
    }

    /// TPT cutoff coefficient for `hz`.
    #[inline]
    fn g_for(&self, hz: f32) -> f32 {
        let f = hz.clamp(20.0, self.max_cutoff);
        (core::f32::consts::PI * f / self.sample_rate).tan()
    }
}

impl Module for Drum {
    const N_INPUTS: usize = 12;
    const N_OUTPUTS: usize = 4;

    fn new(ctx: &InitCtx) -> Self {
        let sample_rate = ctx.sample_rate.max(1.0);
        Drum {
            sample_rate,
            max_cutoff: 0.45 * sample_rate,
            rng: SEED,
            kick_phase: 0.0,
            kick_env: 0.0,
            kick_pitch_env: 0.0,
            kick_click_env: 0.0,
            kick_last: 0.0,
            snare_p1: 0.0,
            snare_p2: 0.0,
            snare_body_env: 0.0,
            snare_noise_env: 0.0,
            snare_svf: Svf::default(),
            snare_last: 0.0,
            hat_env: 0.0,
            hat_svf: Svf::default(),
            hat_last: 0.0,
        }
    }

    fn process(&mut self, io: &mut ProcessIo) {
        let n = io.outputs[0].len();
        // Fixed envelope shapes (independent of the decay knobs).
        let pitch_coeff = decay_coeff(0.055, self.sample_rate);
        let click_coeff = decay_coeff(0.006, self.sample_rate);
        for s in 0..n {
            let noise = self.white();

            // --- Kick -----------------------------------------------------
            if rising(io.inputs[IN_KICK_TRIG][s], &mut self.kick_last) {
                self.kick_phase = 0.0;
                self.kick_env = 1.0;
                self.kick_pitch_env = 1.0;
                self.kick_click_env = 1.0;
            }
            let kick_tune = io.inputs[IN_KICK_TUNE][s].clamp(-4.0, 4.0);
            let kick_hz =
                KICK_BASE_HZ * (2.0f32).powf(kick_tune) * (1.0 + 4.0 * self.kick_pitch_env);
            self.kick_phase = wrap01(self.kick_phase + kick_hz / self.sample_rate);
            let click = io.inputs[IN_KICK_TONE][s].clamp(0.0, 1.0);
            let kick = 0.92 * self.kick_env * sine(self.kick_phase)
                + 0.5 * click * self.kick_click_env * self.kick_click_env * noise;
            self.kick_env *= decay_coeff(io.inputs[IN_KICK_DECAY][s], self.sample_rate);
            self.kick_pitch_env *= pitch_coeff;
            self.kick_click_env *= click_coeff;

            // --- Snare ----------------------------------------------------
            if rising(io.inputs[IN_SNARE_TRIG][s], &mut self.snare_last) {
                self.snare_p1 = 0.0;
                self.snare_p2 = 0.0;
                self.snare_body_env = 1.0;
                self.snare_noise_env = 1.0;
            }
            let snare_hz =
                SNARE_BASE_HZ * (2.0f32).powf(io.inputs[IN_SNARE_TUNE][s].clamp(-4.0, 4.0));
            self.snare_p1 = wrap01(self.snare_p1 + snare_hz / self.sample_rate);
            self.snare_p2 = wrap01(self.snare_p2 + 1.83 * snare_hz / self.sample_rate);
            let body = 0.62 * sine(self.snare_p1) + 0.38 * sine(self.snare_p2);
            let (_, bp, hp) = self
                .snare_svf
                .process(noise, self.g_for(SNARE_NOISE_HZ), 1.2);
            let snappy = io.inputs[IN_SNARE_TONE][s].clamp(0.0, 1.0);
            let snare = (1.0 - snappy) * 1.1 * body * self.snare_body_env
                + snappy * 1.6 * (0.7 * bp + 0.3 * hp) * self.snare_noise_env;
            let snare_decay = io.inputs[IN_SNARE_DECAY][s];
            self.snare_body_env *= decay_coeff(0.45 * snare_decay, self.sample_rate);
            self.snare_noise_env *= decay_coeff(snare_decay, self.sample_rate);

            // --- Hat ------------------------------------------------------
            if rising(io.inputs[IN_HAT_TRIG][s], &mut self.hat_last) {
                self.hat_env = 1.0;
            }
            let hat_hz = HAT_BASE_HZ * (2.0f32).powf(io.inputs[IN_HAT_TUNE][s].clamp(-4.0, 4.0));
            let (_, bp, hp) = self.hat_svf.process(noise, self.g_for(hat_hz), 0.6);
            let tone = io.inputs[IN_HAT_TONE][s].clamp(0.0, 1.0);
            let hat = (1.0 - tone) * 1.5 * bp * self.hat_env + tone * 1.2 * hp * self.hat_env;
            self.hat_env *= decay_coeff(io.inputs[IN_HAT_DECAY][s], self.sample_rate);

            io.outputs[OUT_KICK][s] = AMPLITUDE * kick;
            io.outputs[OUT_SNARE][s] = AMPLITUDE * snare;
            io.outputs[OUT_HAT][s] = AMPLITUDE * hat;
            io.outputs[OUT_MIX][s] = AMPLITUDE * MIX_GAIN * (kick + snare + hat);
        }
    }
}

export_module!(Drum);
