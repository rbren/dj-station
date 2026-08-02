//! Minimal STFT/ISTFT (Hann window, weighted overlap-add) shared by the
//! key detector and the stem separator.

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;

pub struct Stft {
    pub win: usize,
    pub hop: usize,
    window: Vec<f32>,
    fwd: Arc<dyn Fft<f32>>,
    inv: Arc<dyn Fft<f32>>,
}

impl Stft {
    pub fn new(win: usize, hop: usize) -> Self {
        assert!(hop > 0 && hop <= win);
        let window: Vec<f32> = (0..win)
            .map(|n| {
                let x = n as f64 / win as f64;
                (0.5 - 0.5 * (2.0 * std::f64::consts::PI * x).cos()) as f32
            })
            .collect();
        let mut planner = FftPlanner::new();
        Stft {
            win,
            hop,
            window,
            fwd: planner.plan_fft_forward(win),
            inv: planner.plan_fft_inverse(win),
        }
    }

    pub fn bins(&self) -> usize {
        self.win / 2 + 1
    }

    /// Frequency (Hz) of bin `k` at `sample_rate`.
    pub fn bin_hz(&self, k: usize, sample_rate: u32) -> f64 {
        k as f64 * sample_rate as f64 / self.win as f64
    }

    /// Forward STFT: frames of `win/2 + 1` complex bins. Frame `t` covers
    /// input samples `[t*hop, t*hop + win)`; the tail is zero-padded.
    pub fn forward(&self, x: &[f32]) -> Vec<Vec<Complex<f32>>> {
        let n_frames = if x.is_empty() {
            0
        } else {
            x.len().div_ceil(self.hop)
        };
        let bins = self.bins();
        let mut frames = Vec::with_capacity(n_frames);
        let mut buf = vec![Complex::new(0.0f32, 0.0); self.win];
        for t in 0..n_frames {
            let start = t * self.hop;
            for (n, b) in buf.iter_mut().enumerate() {
                let s = x.get(start + n).copied().unwrap_or(0.0);
                *b = Complex::new(s * self.window[n], 0.0);
            }
            self.fwd.process(&mut buf);
            frames.push(buf[..bins].to_vec());
        }
        frames
    }

    /// Inverse STFT with weighted overlap-add (synthesis window = analysis
    /// window, normalized by the summed squared window), truncated/padded
    /// to `out_len` samples. Exact reconstruction away from the edges; pad
    /// the input before analysis if the edges matter.
    pub fn inverse(&self, frames: &[Vec<Complex<f32>>], out_len: usize) -> Vec<f32> {
        let mut out = vec![0.0f32; out_len];
        let mut norm = vec![0.0f32; out_len];
        let mut buf = vec![Complex::new(0.0f32, 0.0); self.win];
        let scale = 1.0 / self.win as f32;
        for (t, frame) in frames.iter().enumerate() {
            // Rebuild the full spectrum by conjugate symmetry.
            buf[..self.bins()].copy_from_slice(frame);
            for k in self.bins()..self.win {
                buf[k] = frame[self.win - k].conj();
            }
            self.inv.process(&mut buf);
            let start = t * self.hop;
            for (n, (&b, &w)) in buf.iter().zip(&self.window).enumerate() {
                let i = start + n;
                if i >= out_len {
                    break;
                }
                out[i] += b.re * scale * w;
                norm[i] += w * w;
            }
        }
        for (o, &n) in out.iter_mut().zip(&norm) {
            if n > 1e-8 {
                *o /= n;
            }
        }
        out
    }
}
