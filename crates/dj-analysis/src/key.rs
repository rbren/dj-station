//! Musical key detection: chromagram + Krumhansl-Schmuckler key profiles
//! (PRD §8.2, M3). Pure DSP, deterministic, no models.

use crate::stft::Stft;

/// Pitch-class names indexed from C. Minor keys append "m" ("Am").
pub const PITCH_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

// Krumhansl-Kessler probe-tone profiles (C major / C minor).
const MAJOR_PROFILE: [f64; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE: [f64; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

/// Chroma analysis frequency range (Hz).
const F_LO: f64 = 55.0;
const F_HI: f64 = 4200.0;
/// Above this frequency, harmonics blur pitch classes; taper their weight.
const F_TAPER: f64 = 1200.0;

/// Detect the musical key of a mono signal; returns e.g. "Am", "F#", "C".
pub fn detect_key(mono: &[f32], sample_rate: u32) -> String {
    let chroma = chromagram(mono, sample_rate);
    let (root, minor, _) = best_key(&chroma);
    if minor {
        format!("{}m", PITCH_NAMES[root])
    } else {
        PITCH_NAMES[root].to_string()
    }
}

/// 12-dim average chroma vector (C=0), magnitude-weighted.
pub fn chromagram(mono: &[f32], sample_rate: u32) -> [f64; 12] {
    // Long windows for semitone resolution in the bass register.
    let win = 8192.min(mono.len().next_power_of_two());
    let stft = Stft::new(win, win / 2);
    let frames = stft.forward(mono);
    let mut chroma = [0.0f64; 12];
    for frame in &frames {
        for (k, c) in frame.iter().enumerate() {
            let f = stft.bin_hz(k, sample_rate);
            if !(F_LO..=F_HI).contains(&f) {
                continue;
            }
            let mag = c.norm() as f64;
            if mag <= 0.0 {
                continue;
            }
            // Taper high frequencies (harmonic blur).
            let w = if f <= F_TAPER {
                1.0
            } else {
                (F_TAPER / f).sqrt()
            };
            // MIDI pitch -> pitch class (C = 0).
            let midi = 69.0 + 12.0 * (f / 440.0).log2();
            let pc = (midi.round() as i64).rem_euclid(12) as usize;
            // sqrt compression tames a dominant bass line.
            chroma[pc] += mag.sqrt() * w;
        }
    }
    chroma
}

/// Best of 24 keys by Pearson correlation against rotated K-K profiles.
/// Returns (root pitch class, is_minor, correlation).
pub fn best_key(chroma: &[f64; 12]) -> (usize, bool, f64) {
    let mut best = (0usize, false, f64::NEG_INFINITY);
    for root in 0..12 {
        for (minor, profile) in [(false, &MAJOR_PROFILE), (true, &MINOR_PROFILE)] {
            let mut rotated = [0.0f64; 12];
            for (i, r) in rotated.iter_mut().enumerate() {
                *r = profile[(i + 12 - root) % 12];
            }
            let r = pearson(chroma, &rotated);
            if r > best.2 {
                best = (root, minor, r);
            }
        }
    }
    best
}

fn pearson(a: &[f64; 12], b: &[f64; 12]) -> f64 {
    let ma = a.iter().sum::<f64>() / 12.0;
    let mb = b.iter().sum::<f64>() / 12.0;
    let mut num = 0.0;
    let mut da = 0.0;
    let mut db = 0.0;
    for i in 0..12 {
        let xa = a[i] - ma;
        let xb = b[i] - mb;
        num += xa * xb;
        da += xa * xa;
        db += xb * xb;
    }
    if da <= 0.0 || db <= 0.0 {
        return 0.0;
    }
    num / (da * db).sqrt()
}
