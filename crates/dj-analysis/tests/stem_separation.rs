//! DSP fallback stem separator tests (M3):
//! - energy conservation: the four stems sum back to the original signal;
//! - component separation on a synthetic mix with known parts;
//! - determinism;
//! - FLAC cache: compute-if-missing keyed by content hash (cache hits do
//!   not invoke the separator and are near-instant).

use dj_analysis::{
    ensure_stems, stem_paths, stems_cached, AudioData, BandSeparator, StemSeparator, Stems,
};
use std::sync::atomic::{AtomicUsize, Ordering};

const SR: u32 = 44_100;

/// Deterministic noise (splitmix64).
struct Rng(u64);
impl Rng {
    fn f32(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^= z >> 31;
        ((z >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    }
}

/// Synthetic stereo mix with four ground-truth components:
/// - "bass": 60 Hz sine, both channels;
/// - "vocals": 1 kHz sine, center-panned (identical L/R);
/// - "other": 3 kHz sine, hard side-panned (L = -R);
/// - "drums": broadband noise clicks every 0.25 s.
fn fixture(secs: f64) -> (AudioData, [Vec<f32>; 4]) {
    let n = (secs * SR as f64) as usize;
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    let mut bass = vec![0.0f32; n];
    let mut vox = vec![0.0f32; n];
    let mut other = vec![0.0f32; n];
    let mut drums = vec![0.0f32; n];
    let mut rng = Rng(7);
    for i in 0..n {
        let t = i as f64 / SR as f64;
        let b = (0.5 * (2.0 * std::f64::consts::PI * 60.0 * t).sin()) as f32;
        let v = (0.4 * (2.0 * std::f64::consts::PI * 1000.0 * t).sin()) as f32;
        let o = (0.3 * (2.0 * std::f64::consts::PI * 3000.0 * t).sin()) as f32;
        bass[i] = b;
        vox[i] = v;
        other[i] = o;
        l[i] = b + v + o;
        r[i] = b + v - o; // side-panned "other"
    }
    // Clicks: 6 ms noise bursts every 0.25 s.
    let mut t = 0.1;
    while t < secs {
        let start = (t * SR as f64) as usize;
        for i in 0..(0.006 * SR as f64) as usize {
            if start + i >= n {
                break;
            }
            let s = rng.f32() * 0.6 * (1.0 - i as f32 / (0.006 * SR as f32));
            drums[start + i] = s;
            l[start + i] += s;
            r[start + i] += s;
        }
        t += 0.25;
    }
    (
        AudioData {
            channels: vec![l, r],
            sample_rate: SR,
        },
        [vox, drums, bass, other],
    )
}

fn rms(x: &[f32]) -> f64 {
    (x.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>() / x.len() as f64).sqrt()
}

/// RMS of the projection error when approximating `target` from `est`:
/// how much of `target` is *missing* from `est` (both same length).
fn component_capture(est: &[f32], target: &[f32]) -> f64 {
    // Correlation-based capture: fraction of target energy present in est.
    let dot: f64 = est
        .iter()
        .zip(target)
        .map(|(&a, &b)| a as f64 * b as f64)
        .sum();
    let t_energy: f64 = target.iter().map(|&s| (s as f64).powi(2)).sum();
    if t_energy <= 0.0 {
        return 0.0;
    }
    dot / t_energy
}

#[test]
fn stems_sum_to_original_within_tolerance() {
    let (audio, _) = fixture(3.0);
    let Stems(stems) = BandSeparator.separate(&audio).unwrap();
    for ch in 0..2 {
        let orig = &audio.channels[ch];
        let mut err_max = 0.0f64;
        let mut err_sq = 0.0f64;
        for (i, &o) in orig.iter().enumerate() {
            let sum: f32 = stems.iter().map(|s| s.channels[ch][i]).sum();
            let e = (sum - o) as f64;
            err_max = err_max.max(e.abs());
            err_sq += e * e;
        }
        let err_rms = (err_sq / orig.len() as f64).sqrt();
        let orig_rms = rms(orig);
        println!(
            "ch{ch}: sum-vs-orig rms err {err_rms:.2e} (orig rms {orig_rms:.3}), max {err_max:.2e}"
        );
        assert!(
            err_rms < orig_rms * 1e-3,
            "stems do not sum to the original: rms err {err_rms}"
        );
    }
}

#[test]
fn each_component_lands_mostly_in_its_stem() {
    let (audio, [vox, drums, bass, other]) = fixture(3.0);
    let Stems(stems) = BandSeparator.separate(&audio).unwrap();
    // Compare on the left channel (all components present there).
    let targets = [&vox, &drums, &bass, &other];
    let names = dj_analysis::STEM_NAMES;
    for (s, target) in targets.iter().enumerate() {
        let own = component_capture(&stems[s].channels[0], target);
        println!("{}: captures {:.2} of its component", names[s], own);
        assert!(
            own > 0.6,
            "{} stem captures only {:.2} of its component",
            names[s],
            own
        );
        for (o, other_stem) in stems.iter().enumerate() {
            if o == s {
                continue;
            }
            let leak = component_capture(&other_stem.channels[0], target);
            assert!(
                leak < 0.35,
                "{} component leaks {:.2} into the {} stem",
                names[s],
                leak,
                names[o]
            );
        }
    }
}

#[test]
fn separation_is_deterministic() {
    let (audio, _) = fixture(1.0);
    let Stems(a) = BandSeparator.separate(&audio).unwrap();
    let Stems(b) = BandSeparator.separate(&audio).unwrap();
    for (sa, sb) in a.iter().zip(&b) {
        assert_eq!(sa.channels, sb.channels);
    }
}

/// Counting wrapper to prove cache hits never recompute.
struct Counting(BandSeparator, AtomicUsize);
impl StemSeparator for Counting {
    fn id(&self) -> &'static str {
        "counting"
    }
    fn separate(&self, audio: &AudioData) -> anyhow::Result<Stems> {
        self.1.fetch_add(1, Ordering::SeqCst);
        self.0.separate(audio)
    }
}

#[test]
fn stem_cache_hit_is_instant_and_does_not_recompute() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("stems").join("deadbeefhash");
    let (audio, _) = fixture(2.0);
    let sep = Counting(BandSeparator, AtomicUsize::new(0));

    assert!(!stems_cached(&dir));
    let computed = ensure_stems(&dir, &audio, &sep).unwrap();
    assert!(computed);
    assert_eq!(sep.1.load(Ordering::SeqCst), 1);
    assert!(stems_cached(&dir));
    for p in stem_paths(&dir) {
        assert!(p.is_file(), "missing stem {}", p.display());
        assert!(std::fs::metadata(&p).unwrap().len() > 0);
    }

    // Cache hit: no recompute, and effectively instant.
    let t0 = std::time::Instant::now();
    let computed = ensure_stems(&dir, &audio, &sep).unwrap();
    let dt = t0.elapsed();
    assert!(!computed);
    assert_eq!(sep.1.load(Ordering::SeqCst), 1, "cache hit recomputed");
    assert!(
        dt < std::time::Duration::from_millis(50),
        "cache hit took {dt:?}"
    );
}

#[test]
fn cached_stems_decode_back_to_the_same_audio() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("s");
    let (audio, _) = fixture(1.0);
    let Stems(stems) = BandSeparator.separate(&audio).unwrap();
    dj_analysis::stems::write_stems(&dir, &Stems(stems.clone())).unwrap();
    for (i, p) in stem_paths(&dir).iter().enumerate() {
        let decoded = dj_analysis::decode_audio(p).unwrap();
        assert_eq!(decoded.sample_rate, SR);
        assert_eq!(decoded.channels.len(), 2);
        // The encoder zero-pads the final FLAC block; content must match
        // for all real frames and the padding must be silent.
        assert!(decoded.frames() >= audio.frames());
        assert!(decoded.frames() < audio.frames() + 4096);
        for ch in 0..2 {
            // 16-bit quantization tolerance.
            for (a, b) in decoded.channels[ch].iter().zip(&stems[i].channels[ch]) {
                assert!((a - b).abs() < 2.0 / 32768.0 + 1e-4);
            }
            for &a in &decoded.channels[ch][audio.frames()..] {
                assert_eq!(a, 0.0);
            }
        }
    }
}
