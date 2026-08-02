//! Jack activation telemetry — PRD §4 "Input activation display".
//!
//! For every input jack the RT thread publishes:
//! - instantaneous value (last sample of the block),
//! - RMS over a 100 ms sliding window,
//! - a "fast" flag: whether the signal fluctuates faster than 10 Hz,
//! - the display value the UI should show (RMS if fast, instantaneous if slow).
//!
//! Everything is fixed-size and lock-free: the RT thread writes atomics, the
//! UI thread reads them.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

pub const RMS_WINDOW_SECONDS: f32 = 0.1;
pub const FAST_HZ_THRESHOLD: f32 = 10.0;

/// Lock-free published values for one jack.
#[derive(Debug, Default)]
pub struct JackSlot {
    inst: AtomicU32,
    rms: AtomicU32,
    display: AtomicU32,
    fast: AtomicBool,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct JackTelemetry {
    pub instantaneous: f32,
    pub rms_100ms: f32,
    pub display: f32,
    pub is_fast: bool,
}

impl JackSlot {
    fn publish(&self, t: JackTelemetry) {
        self.inst
            .store(t.instantaneous.to_bits(), Ordering::Relaxed);
        self.rms.store(t.rms_100ms.to_bits(), Ordering::Relaxed);
        self.display.store(t.display.to_bits(), Ordering::Relaxed);
        self.fast.store(t.is_fast, Ordering::Relaxed);
    }

    pub fn read(&self) -> JackTelemetry {
        JackTelemetry {
            instantaneous: f32::from_bits(self.inst.load(Ordering::Relaxed)),
            rms_100ms: f32::from_bits(self.rms.load(Ordering::Relaxed)),
            display: f32::from_bits(self.display.load(Ordering::Relaxed)),
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
        self.last_sample = buf[n - 1];

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

        let rms = (self.total_sq / self.total_n.max(1) as f64).sqrt() as f32;
        // Crossings happen twice per cycle.
        let window_secs = self.total_n as f32 / self.sample_rate;
        let est_hz = self.total_zc as f32 / (2.0 * window_secs.max(1e-6));
        let is_fast = est_hz > FAST_HZ_THRESHOLD;
        let instantaneous = self.last_sample;
        let display = if is_fast { rms } else { instantaneous };
        self.slot.publish(JackTelemetry {
            instantaneous,
            rms_100ms: rms,
            display,
            is_fast,
        });
    }
}
