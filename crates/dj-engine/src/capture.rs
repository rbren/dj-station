//! Raw sample capture for display-only jacks (the Scope's trace).
//!
//! Jack telemetry is scalar (value / RMS / fast flag), which is all a jack
//! glow or a level meter needs. An oscilloscope needs the SIGNAL: a trace
//! and a spectrum are only honest if they are drawn from the samples that
//! actually went through the wire. A manifest input jack marked
//! `"capture": true` therefore gets one of these rings, written by the RT
//! thread from the jack's effective (post-blend) input buffer and read by
//! the UI over IPC.
//!
//! Lock-free and allocation-free on the RT side: a fixed ring of `f32` bit
//! patterns plus a monotonically growing write counter. There is exactly
//! one writer (the RT thread) and readers are display code, so `read`
//! re-checks the counter and retries a few times rather than blocking; a
//! window that keeps moving under it is a window that will be re-read
//! 100 ms later anyway.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

/// Ring length in samples: 2048 at 48 kHz is 43 ms of signal — a full FFT
/// frame (23 Hz bins, so the display's 20 Hz low end has real data) that
/// is rewritten several times inside the UI's 100 ms poll, so a trace can
/// never show a stale buffer.
pub const CAPTURE_SAMPLES: usize = 2048;

#[derive(Debug)]
pub struct CaptureRing {
    samples: Box<[AtomicU32]>,
    /// Total samples ever written; the ring holds the last
    /// [`CAPTURE_SAMPLES`] of them.
    written: AtomicU64,
    sample_rate: f32,
}

/// One window of captured samples, oldest first.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CaptureWindow {
    pub sample_rate: f32,
    pub samples: Vec<f32>,
}

impl CaptureRing {
    pub fn new(sample_rate: f32) -> Self {
        CaptureRing {
            samples: (0..CAPTURE_SAMPLES)
                .map(|_| AtomicU32::new(0))
                .collect::<Vec<_>>()
                .into_boxed_slice(),
            written: AtomicU64::new(0),
            sample_rate,
        }
    }

    /// Append one block. RT thread; no allocation, no locks.
    pub fn push(&self, buf: &[f32]) {
        let start = self.written.load(Ordering::Relaxed);
        for (i, &x) in buf.iter().enumerate() {
            let idx = ((start + i as u64) % CAPTURE_SAMPLES as u64) as usize;
            let x = if x.is_finite() { x } else { 0.0 };
            self.samples[idx].store(x.to_bits(), Ordering::Relaxed);
        }
        self.written
            .store(start + buf.len() as u64, Ordering::Release);
    }

    /// The most recent window, oldest sample first. Shorter than the ring
    /// only until it has filled once; empty before anything was written.
    pub fn read(&self) -> CaptureWindow {
        let mut samples = Vec::with_capacity(CAPTURE_SAMPLES);
        for _ in 0..4 {
            let before = self.written.load(Ordering::Acquire);
            samples.clear();
            let n = (before as usize).min(CAPTURE_SAMPLES);
            let start = before - n as u64;
            for i in 0..n {
                let idx = ((start + i as u64) % CAPTURE_SAMPLES as u64) as usize;
                samples.push(f32::from_bits(self.samples[idx].load(Ordering::Relaxed)));
            }
            if self.written.load(Ordering::Acquire) == before {
                break;
            }
        }
        CaptureWindow {
            sample_rate: self.sample_rate,
            samples,
        }
    }
}
