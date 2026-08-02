//! M3 [A] accuracy criteria on the synthetic labeled set (PRD §11):
//! steady electronic-style tracks with known BPM / beatgrid / key.
//!
//! - BPM exact (or ×2 / ÷2) on ≥ 95 % of the set.
//! - Key correct on ≥ 80 % of the set.
//! - Auto-beatgrid beats align with the annotated beats (this is what
//!   makes the M2 sync criterion pass with no manual adjustment; the
//!   engine-side integration lives in dj-engine tests/analysis_sync.rs).

use dj_analysis::testset::labeled_set;
use dj_analysis::{analyze_audio, tempo};

const SET_SIZE: usize = 20;
const SR: u32 = 44_100;
const SECS: f64 = 20.0;

/// BPM counts as correct when exact (or a ×2/÷2 octave) within 2 %.
fn bpm_matches(detected: f64, truth: f64) -> bool {
    [truth * 0.5, truth, truth * 2.0]
        .iter()
        .any(|&t| (detected - t).abs() / t <= 0.02)
}

#[test]
fn bpm_exact_or_octave_on_at_least_95_percent() {
    let set = labeled_set(SET_SIZE, SR, SECS);
    let mut hits = 0;
    let mut exact = 0;
    for (i, t) in set.iter().enumerate() {
        let r = analyze_audio(&t.audio).unwrap();
        let ok = bpm_matches(r.bpm, t.bpm);
        if ok {
            hits += 1;
        }
        if (r.bpm - t.bpm).abs() / t.bpm <= 0.02 {
            exact += 1;
        }
        println!(
            "track {i}: true {:.1} BPM, detected {:.2} BPM ({})",
            t.bpm,
            r.bpm,
            if ok { "ok" } else { "MISS" }
        );
    }
    println!("BPM: {hits}/{SET_SIZE} within x2 family, {exact}/{SET_SIZE} exact");
    assert!(
        hits as f64 / SET_SIZE as f64 >= 0.95,
        "BPM accuracy {hits}/{SET_SIZE} below 95%"
    );
}

#[test]
fn key_correct_on_at_least_80_percent() {
    let set = labeled_set(SET_SIZE, SR, SECS);
    let mut hits = 0;
    for (i, t) in set.iter().enumerate() {
        let r = analyze_audio(&t.audio).unwrap();
        let ok = r.key == t.key;
        if ok {
            hits += 1;
        }
        println!(
            "track {i}: true key {}, detected {} ({})",
            t.key,
            r.key,
            if ok { "ok" } else { "MISS" }
        );
    }
    println!("key: {hits}/{SET_SIZE} correct");
    assert!(
        hits as f64 / SET_SIZE as f64 >= 0.80,
        "key accuracy {hits}/{SET_SIZE} below 80%"
    );
}

#[test]
fn auto_beatgrid_aligns_to_annotated_beats() {
    let set = labeled_set(SET_SIZE, SR, SECS);
    let mut worst = 0.0f64;
    for (i, t) in set.iter().enumerate() {
        let r = tempo::detect_tempo(&t.audio.channels[0], SR).unwrap();
        // Compare in the detected grid's own tempo family: a x2 grid still
        // has a gridline on every annotated beat.
        assert!(
            bpm_matches(r.bpm, t.bpm),
            "track {i}: tempo {:.2} not in the x2 family of {:.1}",
            r.bpm,
            t.bpm
        );
        let det_period = 60.0 / r.bpm;
        // Every annotated beat must fall on a detected gridline.
        let mut track_worst = 0.0f64;
        let mut k = 0.0;
        loop {
            let truth = t.anchor_secs + k * 60.0 / t.bpm;
            if truth > SECS - 1.0 {
                break;
            }
            let mut err = (truth - r.anchor_secs).rem_euclid(det_period);
            if err > det_period / 2.0 {
                err = det_period - err;
            }
            track_worst = track_worst.max(err);
            k += 1.0;
        }
        println!(
            "track {i}: worst grid-vs-truth offset {:.2} ms",
            track_worst * 1000.0
        );
        worst = worst.max(track_worst);
        assert!(
            track_worst <= 0.010,
            "track {i}: beatgrid off by {:.2} ms (> 10 ms)",
            track_worst * 1000.0
        );
    }
    println!("beatgrid: worst offset across set {:.2} ms", worst * 1000.0);
}
