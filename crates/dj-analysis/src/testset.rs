//! Synthetic labeled test material: steady electronic-style tracks with
//! known BPM, beatgrid and key, rendered from oscillators and drum
//! patterns. Used by the accuracy acceptance tests here and by the
//! dj-engine analysis→sync integration test (PRD M3 [A] criteria), so it
//! lives in the library rather than under `tests/`.

use crate::decode::AudioData;
use crate::key::PITCH_NAMES;

/// A generated track plus its ground truth.
pub struct LabeledTrack {
    pub audio: AudioData,
    pub bpm: f64,
    /// First beat (kick attack) time, seconds.
    pub anchor_secs: f64,
    /// Key in the detector's output format ("Am", "F#", "C").
    pub key: String,
}

/// Deterministic PRNG (splitmix64) so the "labeled set" is stable.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    fn f64(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + self.f64() * (hi - lo)
    }

    fn usize(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn midi_hz(midi: f64) -> f64 {
    440.0 * 2f64.powf((midi - 69.0) / 12.0)
}

/// Generate one steady electronic-style track: four-on-the-floor kick +
/// offbeat hats, an eighth-note bassline on the tonic/fifth, and a
/// sustained tonic-triad pad, all in the labeled key.
pub fn synth_labeled_track(seed: u64, sample_rate: u32, secs: f64) -> LabeledTrack {
    let mut rng = Rng(seed.wrapping_mul(0x2545f4914f6cdd1d).wrapping_add(1));
    let bpm = (rng.range(84.0, 172.0) * 10.0).round() / 10.0;
    let anchor = rng.range(0.15, 0.45);
    let root = rng.usize(12);
    let minor = rng.next() % 2 == 1;

    let sr = sample_rate as f64;
    let n = (secs * sr) as usize;
    let mut x = vec![0.0f32; n];
    let period = 60.0 / bpm;

    // Kick on every beat: pitched drop 150 -> 50 Hz + noise click.
    let mut noise = Rng(seed ^ 0xdeadbeef);
    let mut t = anchor;
    while t < secs {
        let start = (t * sr) as usize;
        let dur = (0.25 * sr) as usize;
        for i in 0..dur.min(n.saturating_sub(start)) {
            let tau = i as f64 / sr;
            let f_inst = 50.0 + 100.0 * (-tau / 0.02).exp();
            // Integrated phase of the exponential sweep.
            let phase = 2.0
                * std::f64::consts::PI
                * (50.0 * tau + 100.0 * 0.02 * (1.0 - (-tau / 0.02).exp()));
            let _ = f_inst;
            let mut s = phase.sin() * (-tau * 18.0).exp() * 0.9;
            if tau < 0.004 {
                s += (noise.f64() * 2.0 - 1.0) * 0.5 * (1.0 - tau / 0.004);
            }
            x[start + i] += s as f32;
        }
        t += period;
    }

    // Offbeat hats: short noise bursts.
    let mut t = anchor + period / 2.0;
    while t < secs {
        let start = (t * sr) as usize;
        let dur = (0.03 * sr) as usize;
        for i in 0..dur.min(n.saturating_sub(start)) {
            let tau = i as f64 / sr;
            x[start + i] += ((noise.f64() * 2.0 - 1.0) * 0.25 * (-tau * 250.0).exp()) as f32;
        }
        t += period;
    }

    // Bassline: eighth notes alternating tonic / fifth (octave 1-2).
    let bass_root = 24.0 + root as f64; // C1 + root
    let mut idx = 0usize;
    let mut t = anchor;
    while t < secs {
        let semis = if idx % 4 == 2 { 7.0 } else { 0.0 };
        let f = midi_hz(bass_root + 12.0 + semis);
        let start = (t * sr) as usize;
        let dur = (period / 2.0 * 0.8 * sr) as usize;
        for i in 0..dur.min(n.saturating_sub(start)) {
            let tau = i as f64 / sr;
            let env = (1.0 - (-tau * 200.0).exp()) * (-tau * 4.0).exp();
            let s = (2.0 * std::f64::consts::PI * f * tau).sin();
            x[start + i] += (s * env * 0.28) as f32;
        }
        idx += 1;
        t += period / 2.0;
    }

    // Sustained tonic triad pad + octave root (mode carries the third).
    let third = if minor { 3.0 } else { 4.0 };
    let pad_root = 60.0 + root as f64; // C4 + root
    for offset in [0.0, third, 7.0, 12.0] {
        let f = midi_hz(pad_root + offset);
        let amp = if offset == 0.0 { 0.12 } else { 0.09 };
        for (i, s) in x.iter_mut().enumerate() {
            let tau = i as f64 / sr;
            *s += ((2.0 * std::f64::consts::PI * f * tau).sin() * amp) as f32;
        }
    }

    // Normalize to 0.9 peak.
    let peak = x.iter().fold(0.0f32, |m, &v| m.max(v.abs()));
    if peak > 0.0 {
        let g = 0.9 / peak;
        for s in &mut x {
            *s *= g;
        }
    }

    let key = if minor {
        format!("{}m", PITCH_NAMES[root])
    } else {
        PITCH_NAMES[root].to_string()
    };
    LabeledTrack {
        audio: AudioData {
            channels: vec![x],
            sample_rate,
        },
        bpm,
        anchor_secs: anchor,
        key,
    }
}

/// The labeled set used by the M3 accuracy criteria.
pub fn labeled_set(n: usize, sample_rate: u32, secs: f64) -> Vec<LabeledTrack> {
    (0..n)
        .map(|i| synth_labeled_track(1000 + i as u64, sample_rate, secs))
        .collect()
}
