//! Jack activation telemetry — PRD §4 "Input activation display".
//!
//! For every jack (inputs and outputs) the RT thread publishes:
//! - instantaneous value (last sample of the block),
//! - RMS over a 100 ms sliding window,
//! - a "fast" flag: whether the signal fluctuates faster than 10 Hz — the
//!   binary selector for which smoothed value `display` carries,
//! - the display value the UI should show: a genuinely low-pass smoothed
//!   value — the 100 ms windowed mean for slow signals (equivalent to a
//!   10 Hz smoothing interval), the 100 ms RMS for fast ones,
//! - a volatility measure in 0..1. This is NOT `is_fast` re-graded: it
//!   weighs the AC energy the smoothed display value *hides* (RMS of the
//!   signal around its window mean) by how far the dominant frequency sits
//!   beyond the 10 Hz display bandwidth. A fast but tiny ripple is not
//!   volatile (the steady display is honest); a ±5 V LFO at 11 Hz is.
//!
//! Everything is fixed-size and lock-free: the RT thread writes atomics, the
//! UI thread reads them.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

pub const RMS_WINDOW_SECONDS: f32 = 0.1;
pub const FAST_HZ_THRESHOLD: f32 = 10.0;
/// Volatility's rate term saturates here: a 60 Hz LFO reads as maximally
/// un-displayable (PRD-style acceptance: 11 Hz clearly red, 60 Hz deepest).
const VOLATILITY_SAT_HZ: f32 = 60.0;
/// AC RMS (fluctuation around the window mean) at which the amplitude
/// weight reaches 1. 2.5 V: a ±5 V sine (AC RMS ≈ 3.5 V) is full weight,
/// a ±0.1 V ripple is ~4 % — fast, but nothing meaningful is hidden.
const VOLATILITY_AC_FULL: f32 = 2.5;

/// Lock-free published values for one jack.
#[derive(Debug, Default)]
pub struct JackSlot {
    inst: AtomicU32,
    rms: AtomicU32,
    display: AtomicU32,
    volatility: AtomicU32,
    fast: AtomicBool,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct JackTelemetry {
    pub instantaneous: f32,
    pub rms_100ms: f32,
    pub display: f32,
    /// 0..1 — un-displayable AC energy: the RMS of the fluctuation the
    /// smoothed `display` hides, weighted by how far the dominant
    /// frequency exceeds the 10 Hz display bandwidth. 0 for slow signals
    /// and for fast-but-negligible ripple; ~0.4+ for a full-scale 11 Hz
    /// LFO, saturating at 60 Hz.
    #[serde(default)]
    pub volatility: f32,
    pub is_fast: bool,
}

/// Telemetry is serialized to the UI as JSON, and `serde_json` has no
/// literal for NaN/±Inf — it writes `null`, which the front end then reads
/// as a missing number. Publishing is the one choke point every jack and
/// master tap goes through, so non-finite values are scrubbed here.
fn finite(x: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        0.0
    }
}

impl JackSlot {
    fn publish(&self, t: JackTelemetry) {
        self.inst
            .store(finite(t.instantaneous).to_bits(), Ordering::Relaxed);
        self.rms
            .store(finite(t.rms_100ms).to_bits(), Ordering::Relaxed);
        self.display
            .store(finite(t.display).to_bits(), Ordering::Relaxed);
        self.volatility
            .store(finite(t.volatility).to_bits(), Ordering::Relaxed);
        self.fast.store(t.is_fast, Ordering::Relaxed);
    }

    pub fn read(&self) -> JackTelemetry {
        JackTelemetry {
            instantaneous: f32::from_bits(self.inst.load(Ordering::Relaxed)),
            rms_100ms: f32::from_bits(self.rms.load(Ordering::Relaxed)),
            display: f32::from_bits(self.display.load(Ordering::Relaxed)),
            volatility: f32::from_bits(self.volatility.load(Ordering::Relaxed)),
            is_fast: self.fast.load(Ordering::Relaxed),
        }
    }
}

/// Shared store of jack slots; index assignment happens at graph build time.
#[derive(Debug, Default)]
pub struct TelemetryStore {
    pub slots: Vec<Arc<JackSlot>>,
}

impl TelemetryStore {
    pub fn add_slot(&mut self) -> usize {
        self.slots.push(Arc::new(JackSlot::default()));
        self.slots.len() - 1
    }
}

/// RT-side sliding-window state for one jack. All buffers are allocated at
/// graph build time; `update` performs no allocation.
#[derive(Debug)]
pub struct JackAnalyzer {
    slot: Arc<JackSlot>,
    /// Per-block sum of squares, ring buffer covering the window.
    sq_ring: Vec<f64>,
    /// Per-block sum, for the window mean (used by the crossing detector).
    sum_ring: Vec<f64>,
    /// Per-block mean-crossing counts.
    zc_ring: Vec<u32>,
    /// Per-block sample counts (blocks may be partial).
    n_ring: Vec<u32>,
    pos: usize,
    total_sq: f64,
    total_sum: f64,
    total_zc: u32,
    total_n: u64,
    block_size: usize,
    sample_rate: f32,
    last_sample: f32,
}

impl JackAnalyzer {
    pub fn new(slot: Arc<JackSlot>, sample_rate: f32, block_size: usize) -> Self {
        let window_samples = (RMS_WINDOW_SECONDS * sample_rate).round() as usize;
        let n_blocks = window_samples.div_ceil(block_size).max(1);
        JackAnalyzer {
            slot,
            sq_ring: vec![0.0; n_blocks],
            sum_ring: vec![0.0; n_blocks],
            zc_ring: vec![0; n_blocks],
            n_ring: vec![0; n_blocks],
            pos: 0,
            total_sq: 0.0,
            total_sum: 0.0,
            total_zc: 0,
            total_n: 0,
            block_size,
            sample_rate,
            last_sample: 0.0,
        }
    }

    /// Called once per block with the jack's effective input buffer.
    pub fn update(&mut self, buf: &[f32]) {
        let n = buf.len().min(self.block_size);
        if n == 0 {
            return;
        }
        // Window mean from the *previous* window contents (cheap, stable).
        let mean = if self.total_n > 0 {
            (self.total_sum / self.total_n as f64) as f32
        } else {
            0.0
        };

        let mut sq = 0.0f64;
        let mut sum = 0.0f64;
        let mut zc = 0u32;
        let mut prev = self.last_sample - mean;
        for &x in &buf[..n] {
            // A module that blows up (or a denormal-ridden feedback loop)
            // must not poison the window forever: treat non-finite samples
            // as silence for measurement purposes.
            let x = if x.is_finite() { x } else { 0.0 };
            sq += (x as f64) * (x as f64);
            sum += x as f64;
            let d = x - mean;
            // Count real sign flips only (a flat run at the mean is not a
            // crossing).
            if prev != 0.0 && ((d > 0.0 && prev < 0.0) || (d < 0.0 && prev > 0.0)) {
                zc += 1;
            }
            prev = d;
        }
        self.last_sample = if buf[n - 1].is_finite() {
            buf[n - 1]
        } else {
            0.0
        };

        // Rotate ring.
        self.total_sq -= self.sq_ring[self.pos];
        self.total_sum -= self.sum_ring[self.pos];
        self.total_zc -= self.zc_ring[self.pos];
        self.total_n -= self.n_ring[self.pos] as u64;
        self.sq_ring[self.pos] = sq;
        self.sum_ring[self.pos] = sum;
        self.zc_ring[self.pos] = zc;
        self.n_ring[self.pos] = n as u32;
        self.total_sq += sq;
        self.total_sum += sum;
        self.total_zc += zc;
        self.total_n += n as u64;
        self.pos = (self.pos + 1) % self.sq_ring.len();
        // Subtracting the aged-out block from a running total cancels to a
        // tiny negative when a loud window drains to silence; `sqrt` of that
        // is NaN, which reaches the UI as JSON `null`.
        self.total_sq = self.total_sq.max(0.0);

        let rms = (self.total_sq / self.total_n.max(1) as f64).sqrt() as f32;
        // Crossings happen twice per cycle.
        let window_secs = self.total_n as f32 / self.sample_rate;
        let est_hz = self.total_zc as f32 / (2.0 * window_secs.max(1e-6));
        let is_fast = est_hz > FAST_HZ_THRESHOLD;
        let instantaneous = self.last_sample;
        // The displayed value is low-pass smoothed at the 10 Hz display
        // rate: the 100 ms windowed mean (whose first spectral null sits at
        // 10 Hz) for slow signals, the 100 ms RMS envelope for fast ones —
        // never the raw instantaneous sample, which would jitter.
        let window_mean = (self.total_sum / self.total_n.max(1) as f64) as f32;
        let display = if is_fast { rms } else { window_mean };
        // Volatility = (how much the display hides) x (how fast it moves).
        // AC RMS is the fluctuation around the window mean — exactly the
        // part a 10 Hz-smoothed display cannot show. The rate term enters
        // at 0.4 the moment the dominant frequency passes 10 Hz (an 11 Hz
        // full-scale LFO must be *clearly* flagged) and ramps to 1 on a
        // log scale at VOLATILITY_SAT_HZ.
        let ac_rms = ((self.total_sq / self.total_n.max(1) as f64)
            - (window_mean as f64) * (window_mean as f64))
            .max(0.0)
            .sqrt() as f32;
        let volatility = if is_fast {
            let ramp = (est_hz / FAST_HZ_THRESHOLD).log2()
                / (VOLATILITY_SAT_HZ / FAST_HZ_THRESHOLD).log2();
            let rate = 0.4 + 0.6 * ramp.clamp(0.0, 1.0);
            let amplitude = (ac_rms / VOLATILITY_AC_FULL).clamp(0.0, 1.0);
            rate * amplitude
        } else {
            0.0
        };
        self.slot.publish(JackTelemetry {
            instantaneous,
            rms_100ms: rms,
            display,
            volatility,
            is_fast,
        });
    }
}
