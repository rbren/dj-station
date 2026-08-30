//! BPM detection + auto-beatgrid (PRD §8.2, M3).
//!
//! Pure-DSP pipeline tuned for steady-tempo (electronic/DJ) material:
//!
//! 1. Onset-strength envelope: short-window RMS energy at a fine hop,
//!    half-wave-rectified first difference (energy flux).
//! 2. Tempo: autocorrelation of the flux over the 60–200 BPM lag range,
//!    with octave reinforcement and a mild log-normal prior centered on
//!    120 BPM; the winning lag is refined by parabolic interpolation and a
//!    long-lag harmonic (the autocorrelation peak at `m×` the period gives
//!    `m×` the precision).
//! 3. Beat phase: comb alignment of the flux against the period, then a
//!    weighted least-squares fit of interpolated per-beat flux peaks to
//!    `t_k = anchor + k·period` — this is the constant-tempo beatgrid.
//! 4. Anchor de-bias: the envelope has a systematic window-size latency,
//!    so the anchor is re-aligned to the median attack point (steepest
//!    short-term energy rise) of the raw signal around each fitted beat.
//!
//! The output feeds the M2 deck's `(bpm, anchor_secs)` beatgrid directly.

/// Onset envelope analysis window (samples at `sample_rate`), sized in
/// seconds so behavior is rate-independent.
const ENV_WIN_SECS: f64 = 0.02;
const ENV_HOP_SECS: f64 = 0.003;
/// Tempo search range (BPM). Detections outside are folded by octaves.
const BPM_MIN: f64 = 60.0;
const BPM_MAX: f64 = 200.0;
/// Log-normal tempo prior width (octaves around 120 BPM).
const PRIOR_OCTAVES: f64 = 1.1;

#[derive(Debug, Clone, PartialEq)]
pub struct TempoResult {
    pub bpm: f64,
    /// A beat position in [0, beat period), track seconds.
    pub anchor_secs: f64,
}

/// The onset-strength envelope step 1 produces, with the geometry needed
/// to map frames back to seconds. Shared with the beat tracker so
/// both read the same onset function.
#[derive(Debug, Clone)]
pub struct OnsetEnvelope {
    /// Half-wave-rectified energy flux, one value per frame.
    pub flux: Vec<f32>,
    /// Frames per second.
    pub rate: f64,
    /// Seconds of `flux[i]`: the flux window's trailing edge.
    pub frame_offset_secs: f64,
}

impl OnsetEnvelope {
    pub fn frame_secs(&self, frame: f64) -> f64 {
        frame / self.rate + self.frame_offset_secs
    }

    pub fn secs_frame(&self, secs: f64) -> f64 {
        (secs - self.frame_offset_secs) * self.rate
    }
}

/// Compute the onset-strength envelope (step 1 of [`detect_tempo`]).
pub fn onset_envelope(mono: &[f32], sample_rate: u32) -> OnsetEnvelope {
    let sr = sample_rate as f64;
    let win = ((ENV_WIN_SECS * sr) as usize).max(32);
    let hop = ((ENV_HOP_SECS * sr) as usize).max(8);
    OnsetEnvelope {
        flux: onset_flux(mono, win, hop),
        rate: sr / hop as f64,
        frame_offset_secs: win as f64 / sr,
    }
}

/// Detect tempo + beatgrid on a mono signal. Returns `None` for signals
/// too short or too flat to track (needs ~8 beats of material).
pub fn detect_tempo(mono: &[f32], sample_rate: u32) -> Option<TempoResult> {
    let sr = sample_rate as f64;
    let env = onset_envelope(mono, sample_rate);
    let (flux, env_rate) = (&env.flux, env.rate);
    let lag_min = (env_rate * 60.0 / BPM_MAX).floor() as usize;
    let lag_max = (env_rate * 60.0 / BPM_MIN).ceil() as usize;
    if flux.len() < lag_max * 3 {
        return None;
    }
    let peak = flux.iter().cloned().fold(0.0f32, f32::max);
    if peak <= 1e-6 {
        return None;
    }

    // Mean-subtracted autocorrelation up to 3x the longest beat lag (for
    // octave reinforcement and harmonic refinement).
    let mean = flux.iter().map(|&x| x as f64).sum::<f64>() / flux.len() as f64;
    let centered: Vec<f64> = flux.iter().map(|&x| x as f64 - mean).collect();
    let max_lag = (lag_max * 3 + 2).min(centered.len() / 2);
    let mut ac = vec![0.0f64; max_lag + 1];
    for (lag, a) in ac.iter_mut().enumerate() {
        let n = centered.len() - lag;
        let mut s = 0.0;
        for i in 0..n {
            s += centered[i] * centered[i + lag];
        }
        *a = s / n as f64;
    }

    // Score candidate beat lags with octave reinforcement + prior.
    let mut best_lag = 0usize;
    let mut best_score = f64::NEG_INFINITY;
    for lag in lag_min..=lag_max.min(ac.len() - 1) {
        let mut s = ac[lag];
        if 2 * lag < ac.len() {
            s += 0.5 * ac[2 * lag];
        }
        if 3 * lag < ac.len() {
            s += 0.25 * ac[3 * lag];
        }
        let bpm = env_rate * 60.0 / lag as f64;
        let prior = (-0.5 * ((bpm / 120.0).log2() / PRIOR_OCTAVES).powi(2)).exp();
        let score = s * prior;
        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }
    if best_lag == 0 || ac[best_lag] <= 0.0 {
        return None;
    }

    // Parabolic refinement, then long-lag harmonic refinement.
    let mut period = parabolic_peak(&ac, best_lag);
    let m = ((ac.len() - 2) as f64 / period).floor().min(8.0) as usize;
    if m >= 2 {
        let target = period * m as f64;
        let radius = (period / 8.0).max(2.0) as usize;
        let lo = (target as usize).saturating_sub(radius).max(1);
        let hi = ((target as usize) + radius).min(ac.len() - 2);
        if lo < hi {
            let mut peak_lag = lo;
            for lag in lo..=hi {
                if ac[lag] > ac[peak_lag] {
                    peak_lag = lag;
                }
            }
            if ac[peak_lag] > 0.0 {
                period = parabolic_peak(&ac, peak_lag) / m as f64;
            }
        }
    }

    // Fit a grid, then disambiguate the octave: if the midpoints between
    // fitted beats carry nearly as much onset energy as the beats
    // themselves, the detected period is a x2 of the true pulse (a
    // half-tempo grid would miss every other beat) -- halve and refit.
    let (mut anchor_env, mut period_fit) = fit_grid(flux, peak, period)?;
    for _ in 0..2 {
        let half = period_fit / 2.0;
        let bpm_if_halved = 60.0 * env_rate / half;
        if bpm_if_halved > BPM_MAX * 1.5 {
            break;
        }
        let on = comb_mean(flux, anchor_env, period_fit);
        let off = comb_mean(flux, anchor_env + half, period_fit);
        if off < 0.6 * on {
            break;
        }
        let (a, p) = fit_grid(flux, peak, half)?;
        anchor_env = a;
        period_fit = p;
    }
    let bpm = 60.0 * env_rate / period_fit;
    let period_secs = 60.0 / bpm;

    // Map envelope frames to seconds. flux[i] compares windows starting at
    // (i-1)*hop and i*hop; an onset registers as it enters the window tail,
    // so the raw estimate carries a ~window-length bias. De-bias against
    // the raw signal's attack points.
    let rough_anchor = env.frame_secs(anchor_env);
    let anchor = refine_anchor(mono, sr, rough_anchor, period_secs);
    let anchor_secs = anchor.rem_euclid(period_secs);

    Some(TempoResult { bpm, anchor_secs })
}

/// Comb + weighted-LSQ grid fit for a candidate period (env frames):
/// find the best comb phase, pick per-beat flux peaks, fit
/// `t_k = anchor + period*k`. Returns (anchor, period) in env frames.
fn fit_grid(flux: &[f32], peak: f32, period: f64) -> Option<(f64, f64)> {
    // Best comb alignment of the flux.
    let mut best_phase = 0.0f64;
    let mut best_comb = f64::NEG_INFINITY;
    let steps = (period * 4.0) as usize;
    for i in 0..steps {
        let phase = i as f64 * 0.25;
        let mut s = 0.0;
        let mut t = phase;
        while (t as usize) + 1 < flux.len() {
            s += interp(flux, t);
            t += period;
        }
        if s > best_comb {
            best_comb = s;
            best_phase = phase;
        }
    }

    // Per-beat flux peaks -> weighted least-squares grid fit.
    let search = (period * 0.35) as usize;
    let mut beats: Vec<(f64, f64, f64)> = Vec::new(); // (k, t_env, weight)
    let mut k = 0f64;
    loop {
        let center = best_phase + k * period;
        if center >= flux.len() as f64 {
            break;
        }
        let c = center as usize;
        let lo = c.saturating_sub(search);
        let hi = (c + search).min(flux.len() - 1);
        if lo < hi {
            let mut p = lo;
            for i in lo..=hi {
                if flux[i] > flux[p] {
                    p = i;
                }
            }
            let v = flux[p] as f64;
            if v > 0.1 * peak as f64 {
                let t = parabolic_peak_f32(flux, p);
                beats.push((k, t, v));
            }
        }
        k += 1.0;
    }
    if beats.len() < 8 {
        return None;
    }

    // Weighted LSQ: t = a + T*k.
    let wsum: f64 = beats.iter().map(|b| b.2).sum();
    let km: f64 = beats.iter().map(|b| b.0 * b.2).sum::<f64>() / wsum;
    let tm: f64 = beats.iter().map(|b| b.1 * b.2).sum::<f64>() / wsum;
    let mut num = 0.0;
    let mut den = 0.0;
    for &(bk, bt, w) in &beats {
        num += w * (bk - km) * (bt - tm);
        den += w * (bk - km) * (bk - km);
    }
    if den <= 0.0 {
        return None;
    }
    let period_fit = num / den;
    if period_fit <= 1.0 {
        return None;
    }
    Some((tm - period_fit * km, period_fit))
}

/// Mean interpolated flux sampled every `period` starting at `phase`.
fn comb_mean(flux: &[f32], phase: f64, period: f64) -> f64 {
    let mut s = 0.0;
    let mut n = 0usize;
    let mut t = phase.rem_euclid(period);
    while (t as usize) + 1 < flux.len() {
        s += interp(flux, t);
        n += 1;
        t += period;
    }
    if n == 0 {
        0.0
    } else {
        s / n as f64
    }
}

/// Onset flux: half-wave-rectified difference of short-window RMS.
fn onset_flux(x: &[f32], win: usize, hop: usize) -> Vec<f32> {
    if x.len() < win + hop {
        return Vec::new();
    }
    // Prefix sums of x^2 for O(1) window energy.
    let mut prefix = vec![0.0f64; x.len() + 1];
    for (i, &s) in x.iter().enumerate() {
        prefix[i + 1] = prefix[i] + (s as f64) * (s as f64);
    }
    let n_frames = (x.len() - win) / hop + 1;
    let mut env = Vec::with_capacity(n_frames);
    for i in 0..n_frames {
        let a = i * hop;
        let e = (prefix[a + win] - prefix[a]) / win as f64;
        env.push(e.sqrt() as f32);
    }
    let mut flux = vec![0.0f32; env.len()];
    for i in 1..env.len() {
        flux[i] = (env[i] - env[i - 1]).max(0.0);
    }
    flux
}

/// Median offset between predicted beats and raw-signal attack points
/// (steepest rise of a 3 ms RMS envelope), applied to the anchor.
fn refine_anchor(x: &[f32], sr: f64, anchor: f64, period: f64) -> f64 {
    let rms_win = (0.003 * sr) as usize;
    let radius = (0.045 * sr) as usize;
    if rms_win < 4 || x.len() < 4 * rms_win {
        return anchor;
    }
    let mut prefix = vec![0.0f64; x.len() + 1];
    for (i, &s) in x.iter().enumerate() {
        prefix[i + 1] = prefix[i] + (s as f64) * (s as f64);
    }
    let rms = |i: usize| -> f64 {
        let a = i.min(x.len() - rms_win);
        ((prefix[a + rms_win] - prefix[a]) / rms_win as f64).sqrt()
    };
    let mut offsets: Vec<f64> = Vec::new();
    let mut t = anchor;
    while t + period < x.len() as f64 / sr {
        let center = (t * sr) as usize;
        if center > radius && center + radius + rms_win < x.len() {
            // Steepest short-term energy rise near the predicted beat.
            let step = (rms_win / 2).max(1);
            let mut best_i = center;
            let mut best_d = f64::NEG_INFINITY;
            let mut i = center - radius;
            while i + step <= center + radius {
                let d = rms(i + step) - rms(i);
                if d > best_d {
                    best_d = d;
                    best_i = i + step;
                }
                i += step;
            }
            if best_d > 0.0 {
                offsets.push(best_i as f64 / sr - t);
            }
        }
        t += period;
    }
    if offsets.len() < 4 {
        return anchor;
    }
    offsets.sort_by(|a, b| a.partial_cmp(b).unwrap());
    anchor + offsets[offsets.len() / 2]
}

fn parabolic_peak(y: &[f64], i: usize) -> f64 {
    if i == 0 || i + 1 >= y.len() {
        return i as f64;
    }
    let (a, b, c) = (y[i - 1], y[i], y[i + 1]);
    let denom = a - 2.0 * b + c;
    if denom.abs() < 1e-12 {
        return i as f64;
    }
    i as f64 + 0.5 * (a - c) / denom
}

fn parabolic_peak_f32(y: &[f32], i: usize) -> f64 {
    if i == 0 || i + 1 >= y.len() {
        return i as f64;
    }
    let (a, b, c) = (y[i - 1] as f64, y[i] as f64, y[i + 1] as f64);
    let denom = a - 2.0 * b + c;
    if denom.abs() < 1e-12 {
        return i as f64;
    }
    i as f64 + 0.5 * (a - c) / denom
}

fn interp(y: &[f32], t: f64) -> f64 {
    let i = t as usize;
    if i + 1 >= y.len() {
        return y.last().copied().unwrap_or(0.0) as f64;
    }
    let frac = t - i as f64;
    y[i] as f64 * (1.0 - frac) + y[i + 1] as f64 * frac
}
