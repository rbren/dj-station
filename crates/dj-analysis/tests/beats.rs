//! Beat analysis tests: detection → grid fit → tap reconciliation →
//! warp anchors, the pipeline the Clip page taps beats through.
//!
//! Every test drives [`DspTracker`] explicitly: `beat_this` is optional
//! and must never be a CI dependency (same rule as the ONNX separator).

use dj_analysis::beats::{self, detect::BeatTracker, detect::DspTracker, grid, Reading, Verdict};
use dj_analysis::AudioData;

const SR: u32 = 44_100;

/// Beat times of a track whose tempo ramps linearly from `bpm_start` to
/// `bpm_end` over `beats` beats, starting at `offset` seconds.
fn drifting_beats(bpm_start: f64, bpm_end: f64, beats: usize, offset: f64) -> Vec<f64> {
    let mut times = Vec::with_capacity(beats);
    let mut t = offset;
    for i in 0..beats {
        times.push(t);
        let frac = i as f64 / (beats.max(2) - 1) as f64;
        let bpm = bpm_start + (bpm_end - bpm_start) * frac;
        t += 60.0 / bpm;
    }
    times
}

/// A click track: a percussive burst on every beat over a quiet tonal bed,
/// so the material has both transients to track and tone to degrade if the
/// stretch were doing something silly.
fn click_track(beats: &[f64], tail_secs: f64) -> AudioData {
    let end = beats.last().copied().unwrap_or(0.0) + tail_secs;
    let n = (end * SR as f64) as usize;
    let mut left = vec![0.0f32; n];
    for (i, sample) in left.iter_mut().enumerate() {
        let t = i as f64 / SR as f64;
        *sample = (2.0 * std::f64::consts::PI * 110.0 * t).sin() as f32 * 0.05;
    }
    for &b in beats {
        let start = (b * SR as f64) as usize;
        let len = (0.030 * SR as f64) as usize;
        for j in 0..len {
            if start + j >= n {
                break;
            }
            let t = j as f64 / SR as f64;
            let env = (-t / 0.006).exp();
            let click = (2.0 * std::f64::consts::PI * 1400.0 * t).sin() * env * 0.8;
            left[start + j] += click as f32;
        }
    }
    let right = left.clone();
    AudioData {
        channels: vec![left, right],
        sample_rate: SR,
    }
}

fn spread(values: &[f64]) -> f64 {
    let lo = values.iter().cloned().fold(f64::INFINITY, f64::min);
    let hi = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    hi - lo
}

// ---------------------------------------------------------------------------
// Grid fit
// ---------------------------------------------------------------------------

#[test]
fn fit_recovers_a_clean_grid() {
    let beats = drifting_beats(120.0, 120.0, 32, 1.25);
    let fit = grid::fit_beats(&beats).expect("fit");
    assert!((fit.bpm() - 120.0).abs() < 0.01, "bpm {}", fit.bpm());
    assert!((fit.line(0.0) - 1.25).abs() < 1e-6);
    assert_eq!(fit.beats.len(), 32);
    assert_eq!(fit.rejected, 0);
}

#[test]
fn fit_rejects_a_doubled_beat() {
    // A spurious detection halfway between two beats must not drag the
    // line (ANL-6): the fit keeps the tempo and drops the outlier.
    let mut beats = drifting_beats(128.0, 128.0, 24, 0.5);
    beats.insert(9, beats[8] + 0.5 * 60.0 / 128.0);
    let fit = grid::fit_beats(&beats).expect("fit");
    assert!((fit.bpm() - 128.0).abs() < 0.2, "bpm {}", fit.bpm());
    assert_eq!(fit.rejected, 1);
}

#[test]
fn fit_measures_drift_as_residual() {
    let beats = drifting_beats(120.0, 126.0, 48, 0.0);
    let fit = grid::fit_beats(&beats).expect("fit");
    let residuals = fit.residuals();
    // A drifting song does not sit on a straight line; that gap is exactly
    // what the warp removes.
    assert!(spread(&residuals) > 0.05, "spread {}", spread(&residuals));
}

// ---------------------------------------------------------------------------
// Reading corrections (§3.8) — pure grid transforms, no re-detection
// ---------------------------------------------------------------------------

#[test]
fn double_and_halve_change_only_the_metrical_level() {
    let beats = drifting_beats(120.0, 120.0, 32, 0.5);
    let fit = grid::fit_beats(&beats).expect("fit");

    let doubled = grid::apply_reading(
        &fit,
        Reading {
            factor: 2.0,
            half_shift: false,
        },
    );
    assert!((doubled.bpm() - 240.0).abs() < 0.05);
    assert_eq!(doubled.beats.len(), fit.beats.len());
    // Every detection keeps its position in time; only its index changed.
    assert!((doubled.beats[3].time - fit.beats[3].time).abs() < 1e-9);

    let halved = grid::apply_reading(
        &fit,
        Reading {
            factor: 0.5,
            half_shift: false,
        },
    );
    assert!((halved.bpm() - 60.0).abs() < 0.05);
    assert_eq!(halved.beats.len(), 16, "odd detections leave the grid");
}

#[test]
fn half_shift_moves_the_grid_not_the_audio() {
    let beats = drifting_beats(120.0, 120.0, 16, 0.5);
    let fit = grid::fit_beats(&beats).expect("fit");
    let shifted = grid::apply_reading(
        &fit,
        Reading {
            factor: 1.0,
            half_shift: true,
        },
    );
    assert!((shifted.period - fit.period).abs() < 1e-9);
    assert!((shifted.phase - (fit.phase + fit.period / 2.0)).abs() < 1e-9);
    // Detections now sit on half-integer indices — and still at the same
    // times, so the fitted line through them is unchanged.
    assert!((shifted.beats[0].index + 0.5).abs() < 1e-9);
    assert!((shifted.line(shifted.beats[0].index) - fit.line(0.0)).abs() < 1e-9);
}

#[test]
fn bimodal_intervals_flag_the_metrical_level() {
    let steady = drifting_beats(120.0, 120.0, 32, 0.0);
    assert!(!grid::ibi_bimodal(&steady));
    let mut doubled = steady.clone();
    for (i, _) in steady.iter().enumerate().take(16) {
        doubled.push(steady[i] + 0.25);
    }
    doubled.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert!(grid::ibi_bimodal(&doubled));
}

// ---------------------------------------------------------------------------
// Seed agreement (§3.0.1)
// ---------------------------------------------------------------------------

#[test]
fn three_agreeing_seeds_are_unanimous() {
    let base = drifting_beats(124.0, 124.0, 40, 0.3);
    let jitter = |offset: f64| -> Vec<f64> {
        base.iter()
            .enumerate()
            .map(|(i, t)| t + offset * ((i % 3) as f64 - 1.0))
            .collect()
    };
    let runs = vec![
        ("final0".to_string(), jitter(0.0)),
        ("final1".to_string(), jitter(0.002)),
        ("final2".to_string(), jitter(0.003)),
    ];
    let agreement = grid::score_agreement(&runs);
    assert_eq!(agreement.verdict, Verdict::Unanimous);
    assert!(agreement.tempo_spread_bpm < 0.1);
    assert!(agreement.phase_agreement_pct > 98.0);
    assert!(agreement.disagreement_spans.is_empty());
}

#[test]
fn a_double_time_seed_is_a_metrical_split() {
    let base = drifting_beats(124.0, 124.0, 40, 0.3);
    let fast = drifting_beats(248.0, 248.0, 80, 0.3);
    let runs = vec![
        ("final0".to_string(), base.clone()),
        ("final1".to_string(), base),
        ("final2".to_string(), fast),
    ];
    let agreement = grid::score_agreement(&runs);
    assert_eq!(agreement.verdict, Verdict::MetricalSplit);
    assert!(agreement.metrical_split);
}

#[test]
fn disagreeing_seeds_mark_spans() {
    let base = drifting_beats(120.0, 120.0, 40, 0.0);
    let mut wobbly = base.clone();
    for t in wobbly.iter_mut().skip(20).take(8) {
        *t += 0.12;
    }
    let runs = vec![("final0".to_string(), base), ("final1".to_string(), wobbly)];
    let agreement = grid::score_agreement(&runs);
    assert!(agreement.phase_agreement_pct < 90.0);
    assert!(!agreement.disagreement_spans.is_empty());
    let span = agreement.disagreement_spans[0];
    assert!(span[0] >= 9.0 && span[1] <= 15.0, "span {span:?}");
}

#[test]
fn one_tracker_reports_single_rather_than_faking_agreement() {
    let runs = vec![("dsp".to_string(), drifting_beats(120.0, 120.0, 16, 0.0))];
    let agreement = grid::score_agreement(&runs);
    assert_eq!(agreement.verdict, Verdict::SingleTracker);
    assert_eq!(agreement.readings.len(), 1);
}

#[test]
fn each_seed_reports_its_raw_interval_statistics() {
    // A doubled beat and a missed one, both in a run whose fitted BPM is
    // unchanged by either: the stats are what tells them apart.
    let clean = drifting_beats(120.0, 120.0, 24, 0.0);
    let mut ragged = clean.clone();
    ragged.insert(10, (ragged[9] + ragged[10]) / 2.0);
    ragged.remove(18);
    let runs = vec![
        ("final0".to_string(), clean),
        ("final1".to_string(), ragged),
    ];
    let readings = grid::score_agreement(&runs).readings;

    let steady = &readings[0];
    assert!((steady.ibi_mean - 0.5).abs() < 1e-9);
    assert!((steady.ibi_min - 0.5).abs() < 1e-9);
    assert!((steady.ibi_max - 0.5).abs() < 1e-9);
    assert!(steady.ibi_variance < 1e-12);

    let messy = &readings[1];
    assert!((messy.ibi_min - 0.25).abs() < 1e-9, "the doubled beat");
    assert!((messy.ibi_max - 1.0).abs() < 1e-9, "the missed beat");
    assert!(messy.ibi_variance > steady.ibi_variance);
    // Both still fit the same tempo — which is the point.
    assert!((messy.bpm - steady.bpm).abs() < 0.5);
}

// ---------------------------------------------------------------------------
// Tap reconciliation (§3.8a)
// ---------------------------------------------------------------------------

/// Taps on `times`, each late by `lag` and jittered deterministically by
/// up to `jitter` — a human hand, without a random number generator.
fn tapped(times: &[f64], lag: f64, jitter: f64) -> Vec<f64> {
    times
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let wobble = ((i * 7 % 5) as f64 / 4.0 - 0.5) * 2.0;
            t + lag + wobble * jitter
        })
        .collect()
}

#[test]
fn taps_choose_the_seed_that_heard_the_same_pulse() {
    let truth = drifting_beats(120.0, 120.0, 40, 0.25);
    let half = drifting_beats(60.0, 60.0, 20, 0.25);
    let runs = vec![
        // The first run is the half-time misread — which `analyze` would
        // have taken as reference purely for being first.
        ("final0".to_string(), half),
        ("final1".to_string(), truth.clone()),
    ];
    let verdict = grid::reconcile_taps(&runs, &tapped(&truth[..16], 0.045, 0.012));
    assert_eq!(verdict.outcome, grid::TapOutcome::Chose);
    assert_eq!(verdict.seed, "final1");
    assert!((verdict.reading.factor - 1.0).abs() < 1e-9);
    assert!(!verdict.reading.half_shift);
    assert!(verdict.concentration > 0.9, "{verdict:?}");
}

#[test]
fn every_seed_is_offered_with_the_chosen_one_first() {
    // The Clip page autoselects but does not decide: `tapped_fits` ranks
    // EVERY seed's best reading, so a hearing can be overruled by ear
    // without measuring the span again.
    let truth = drifting_beats(120.0, 120.0, 40, 0.25);
    let half = drifting_beats(60.0, 60.0, 20, 0.25);
    let runs = vec![
        ("final0".to_string(), half),
        ("final1".to_string(), truth.clone()),
    ];
    let fits = grid::tapped_fits(&runs, &tapped(&truth[..16], 0.045, 0.012));
    let seeds: Vec<&str> = fits.iter().map(|f| f.seed.as_str()).collect();
    assert_eq!(seeds, ["final1", "final0"]);
    assert!(fits[0].score >= fits[1].score);
    // Its head is exactly what the single-answer chooser returns.
    let (seed, fit) = grid::choose_tapped_fit(&runs, &tapped(&truth[..16], 0.045, 0.012)).unwrap();
    assert_eq!(seed, "final1");
    assert!((fit.bpm() - fits[0].fit.bpm()).abs() < 1e-9);
    // Even two taps are enough to rank them; none at all is no list.
    assert_eq!(grid::tapped_fits(&runs, &truth[..2]).len(), 2);
    assert!(grid::tapped_fits(&runs, &truth[..1]).is_empty());
}

#[test]
fn taps_fix_a_half_time_reading_without_touching_the_tempo() {
    // One seed, read half-time. The taps cannot change its period —
    // only which multiple of it is called a beat.
    let half = drifting_beats(60.0, 60.0, 24, 0.1);
    let runs = vec![("final0".to_string(), half.clone())];
    let doubled: Vec<f64> = (0..24).map(|i| 0.1 + i as f64 * 0.5).collect();
    let verdict = grid::reconcile_taps(&runs, &tapped(&doubled[..16], 0.04, 0.01));
    assert_eq!(verdict.outcome, grid::TapOutcome::Chose);
    assert!((verdict.reading.factor - 2.0).abs() < 1e-9, "{verdict:?}");
    // The fitted period is the seed's own; the reading renames it.
    let fit = grid::fit_beats(&half).expect("fit");
    let read = grid::apply_reading(&fit, verdict.reading);
    assert!((read.period - fit.period / 2.0).abs() < 1e-6);
}

#[test]
fn taps_on_the_offbeat_shift_the_grid_half_a_beat() {
    let beats = drifting_beats(120.0, 120.0, 40, 0.2);
    let offbeats: Vec<f64> = beats.iter().map(|t| t + 0.25).collect();
    let runs = vec![("final0".to_string(), beats)];
    let verdict = grid::reconcile_taps(&runs, &tapped(&offbeats[..16], 0.03, 0.008));
    assert_eq!(verdict.outcome, grid::TapOutcome::Chose);
    assert!(verdict.reading.half_shift, "{verdict:?}");
    assert!((verdict.reading.factor - 1.0).abs() < 1e-9);
}

#[test]
fn the_tap_latency_is_measured_and_never_applied() {
    let beats = drifting_beats(120.0, 120.0, 40, 0.2);
    let runs = vec![("final0".to_string(), beats.clone())];
    let lag = 0.055;
    let verdict = grid::reconcile_taps(&runs, &tapped(&beats[..16], lag, 0.006));
    assert_eq!(verdict.outcome, grid::TapOutcome::Chose);
    // Reported…
    assert!(
        (verdict.offset_secs - lag).abs() < 0.008,
        "offset {}",
        verdict.offset_secs
    );
    // …and absent from the reading, which is all the grid is told.
    assert_eq!(verdict.reading, Reading::default());
    assert!(verdict.detail.contains("not applied"));
}

#[test]
fn a_late_hand_never_becomes_an_offbeat_reading() {
    // 90 ms late at 150 BPM is a fifth of a beat: plainly a slow hand,
    // and shifting the grid for it would be wrong.
    let beats = drifting_beats(150.0, 150.0, 40, 0.2);
    let runs = vec![("final0".to_string(), beats.clone())];
    let verdict = grid::reconcile_taps(&runs, &tapped(&beats[..16], 0.09, 0.01));
    assert_eq!(verdict.outcome, grid::TapOutcome::Chose);
    assert!(!verdict.reading.half_shift, "{verdict:?}");
}

#[test]
fn uneven_taps_are_refused_rather_than_believed() {
    let beats = drifting_beats(120.0, 120.0, 40, 0.2);
    let runs = vec![("final0".to_string(), beats)];
    // Taps at wildly varying intervals: no tempo, no phase, no opinion.
    let ragged = [0.2, 0.9, 1.05, 2.4, 2.6, 4.1, 4.15, 5.9, 7.7, 7.75];
    let verdict = grid::reconcile_taps(&runs, &ragged);
    assert_eq!(verdict.outcome, grid::TapOutcome::Uneven);
    assert!(verdict.seed.is_empty());
    assert_eq!(verdict.reading, Reading::default());
}

#[test]
fn too_few_taps_say_so_instead_of_guessing() {
    let beats = drifting_beats(120.0, 120.0, 40, 0.2);
    let runs = vec![("final0".to_string(), beats.clone())];
    let verdict = grid::reconcile_taps(&runs, &beats[..4]);
    assert_eq!(verdict.outcome, grid::TapOutcome::TooFew);
    assert_eq!(verdict.taps, 4);
}

#[test]
fn tapping_bars_is_reported_as_tapping_bars() {
    // Steady taps, one per four beats: consistent with themselves and
    // with nothing on offer, since this crate knows beats and no bars.
    let beats = drifting_beats(120.0, 120.0, 64, 0.2);
    let runs = vec![("final0".to_string(), beats.clone())];
    let bars: Vec<f64> = beats.iter().step_by(4).copied().collect();
    let verdict = grid::reconcile_taps(&runs, &tapped(&bars[..12], 0.04, 0.01));
    assert_eq!(verdict.outcome, grid::TapOutcome::NoMatch);
    assert!(verdict.detail.contains("not bars"), "{}", verdict.detail);
}

#[test]
fn taps_reseat_the_analysis_on_the_seed_they_chose() {
    // The whole path: a first-run half-time misread, corrected by taps,
    // through `Analysis` rather than the scoring function alone.
    let truth = drifting_beats(120.0, 120.0, 48, 0.3);
    let audio = click_track(&truth, 1.0);
    let analysis = beats::analyze(&audio, &DspTracker, None, Reading::default()).expect("analyze");

    let mut stubbed = analysis.clone();
    stubbed.runs = vec![
        beats::BeatRun {
            seed: "final0".into(),
            beats: truth.iter().step_by(2).copied().collect(),
        },
        beats::BeatRun {
            seed: "final1".into(),
            beats: truth.clone(),
        },
    ];
    stubbed.seed = "final0".into();

    let taps = tapped(&truth[..20], 0.05, 0.012);
    let (next, verdict) = stubbed.with_taps(&taps, &audio).expect("taps");
    assert_eq!(verdict.outcome, grid::TapOutcome::Chose);
    assert_eq!(next.seed, "final1");
    assert!((next.grid.bpm - 120.0).abs() < 1.0, "{}", next.grid.bpm);
    // The runs travel with the analysis, so the choice can be revisited.
    assert_eq!(next.runs.len(), 2);
}

#[test]
fn refused_taps_leave_the_analysis_exactly_as_it_was() {
    let truth = drifting_beats(120.0, 120.0, 48, 0.3);
    let audio = click_track(&truth, 1.0);
    let analysis = beats::analyze(&audio, &DspTracker, None, Reading::default()).expect("analyze");
    let (next, verdict) = analysis.with_taps(&[0.1, 0.2], &audio).expect("taps");
    assert_eq!(verdict.outcome, grid::TapOutcome::TooFew);
    assert_eq!(next.grid, analysis.grid);
    assert_eq!(next.seed, analysis.seed);
}

#[test]
fn a_seed_can_be_chosen_by_hand_without_re_running_the_tracker() {
    let truth = drifting_beats(126.0, 126.0, 48, 0.3);
    let audio = click_track(&truth, 1.0);
    let analysis = beats::analyze(&audio, &DspTracker, None, Reading::default()).expect("analyze");
    let mut stubbed = analysis.clone();
    stubbed.runs = vec![
        beats::BeatRun {
            seed: "final0".into(),
            beats: truth.clone(),
        },
        beats::BeatRun {
            seed: "final1".into(),
            beats: truth.iter().step_by(2).copied().collect(),
        },
    ];
    stubbed.seed = "final0".into();
    let half = stubbed
        .with_seed("final1", &audio, Reading::default())
        .expect("seed");
    assert_eq!(half.seed, "final1");
    assert!((half.grid.bpm - 63.0).abs() < 1.0, "{}", half.grid.bpm);
    assert!(stubbed
        .with_seed("nope", &audio, Reading::default())
        .is_err());
}

// ---------------------------------------------------------------------------
// Warp meters and the recommended zone (§3.6)
// ---------------------------------------------------------------------------

#[test]
fn denser_anchors_trade_flam_for_stretch() {
    let beats = drifting_beats(120.0, 128.0, 64, 0.0);
    let fit = grid::fit_beats(&beats).expect("fit");
    let (first, last) = (fit.first_index(), fit.last_index());
    let pad = fit.period;

    let none = grid::quality(
        &fit,
        &grid::no_warp_anchors(&fit, first, last, pad),
        first,
        pad,
    );
    let sparse = grid::quality(&fit, &grid::anchors(&fit, first, last, 16, pad), first, pad);
    let dense = grid::quality(&fit, &grid::anchors(&fit, first, last, 2, pad), first, pad);

    assert!(none.worst_flam_ms > sparse.worst_flam_ms);
    assert!(sparse.worst_flam_ms > dense.worst_flam_ms);
    assert!(dense.peak_stretch_pct >= sparse.peak_stretch_pct);
    assert!(none.peak_stretch_pct < 1e-6, "no warp bends nothing");
}

#[test]
fn the_sweep_recommends_the_left_edge_of_the_passing_zone() {
    // A gently drifting track: tractable, so both meters can pass
    // somewhere. (A 5 %-drift track has no passing zone at all — the peak
    // stretch cannot be under 1.2 % — and the slider correctly ends up
    // pushed right with an amber stretch, MOD-16.)
    let beats = drifting_beats(120.0, 122.0, 64, 0.0);
    let fit = grid::fit_beats(&beats).expect("fit");
    let sweep = grid::sweep(&fit, fit.first_index(), fit.last_index(), fit.period);
    let zone = sweep
        .zone
        .expect("a drifting-but-tractable track has a zone");
    assert!((sweep.default_strength - zone[0]).abs() < 1e-9);
    let at_default = sweep
        .points
        .iter()
        .find(|p| (p.strength - sweep.default_strength).abs() < 1e-9)
        .expect("default is a sweep point");
    assert!(at_default.quality.passes());
}

#[test]
fn strength_zero_is_the_no_warp_position() {
    assert_eq!(grid::anchor_stride(0.0), None);
    assert_eq!(grid::anchor_stride(1.0), Some(1));
    let mid = grid::anchor_stride(0.5).expect("mid stride");
    assert!((1..=64).contains(&mid));
}

// ---------------------------------------------------------------------------
// End-to-end: detect → fit → warp
// ---------------------------------------------------------------------------

fn analyze_drifting(bpm_start: f64, bpm_end: f64, beats: usize) -> (AudioData, beats::Analysis) {
    let times = drifting_beats(bpm_start, bpm_end, beats, 0.5);
    let audio = click_track(&times, 1.0);
    let analysis = beats::analyze(&audio, &DspTracker, None, Reading::default()).expect("analyze");
    (audio, analysis)
}

#[test]
fn the_dsp_tracker_follows_a_drifting_track() {
    let times = drifting_beats(120.0, 127.0, 48, 0.5);
    let audio = click_track(&times, 1.0);
    let runs = DspTracker.detect(&audio, None).expect("detect");
    assert_eq!(runs.len(), 1);
    let beats = &runs[0].beats;
    assert!(beats.len() >= 40, "found {} beats", beats.len());
    // Detections must track the material, not a constant grid: each one
    // lands near a real click. The tracker keeps counting through the
    // track's silent tail, so only the clicked span is checked.
    let last_click = *times.last().unwrap();
    let mut worst: f64 = 0.0;
    for &b in beats.iter().filter(|b| **b <= last_click) {
        let nearest = times
            .iter()
            .map(|t| (t - b).abs())
            .fold(f64::INFINITY, f64::min);
        worst = worst.max(nearest);
    }
    assert!(worst < 0.030, "worst detection error {worst:.4}s");
}

#[test]
fn analysis_emits_a_beat_only_grid_with_padding() {
    let (_audio, analysis) = analyze_drifting(120.0, 124.0, 48);
    let g = analysis.grid;
    assert!((g.bpm - 122.0).abs() < 3.0, "bpm {}", g.bpm);
    assert!((g.period - 60.0 / g.bpm).abs() < 1e-9);
    // OUT-1a: phase is one period, never zero.
    assert!((g.phase - g.period).abs() < 1e-12);
    assert!(g.beats >= 40);
    assert!((analysis.output_secs() - (g.beats as f64 + 1.0) * g.period).abs() < 1e-9);
    assert_eq!(analysis.agreement.verdict, Verdict::SingleTracker);
    assert_eq!(analysis.confidence.len(), analysis.beats.len());
    assert!(analysis.lead_in >= 0.0 && analysis.lead_in <= grid::LEAD_IN_MAX);
}

#[test]
fn the_source_grid_says_where_the_beats_are_in_the_file() {
    // The modal draws and snaps against the SOURCE timebase: `grid` is the
    // output one, whose beat 0 is head padding, and using it over the
    // source waveform puts every line in the wrong place.
    let times = drifting_beats(120.0, 120.0, 64, 0.7);
    let audio = click_track(&times, 1.0);
    let analysis = beats::analyze(&audio, &DspTracker, None, Reading::default()).expect("analyze");
    let source = analysis.source_grid(audio.duration_secs());

    assert!((source.bpm - 120.0).abs() < 0.5, "bpm {}", source.bpm);
    // Beat 0 is the first line inside the file, and the lattice covers it
    // to the end — the region can be swept anywhere, not just where the
    // detections were.
    assert!(source.phase >= 0.0 && source.phase < source.period);
    let last = source.beat_time((source.beats - 1) as f64);
    assert!(
        last <= audio.duration_secs() && last > audio.duration_secs() - source.period,
        "last line {last} of {}",
        audio.duration_secs()
    );
    // Every detection sits on a line of it, which is what makes snapping
    // to the lattice the same thing as snapping to the beats.
    for &t in &analysis.beats {
        let n = ((t - source.phase) / source.period).round();
        assert!(
            (source.beat_time(n) - t).abs() < 0.02,
            "detection {t} is {} from its line",
            (source.beat_time(n) - t).abs()
        );
    }
}

#[test]
fn every_residual_knows_which_beat_it_is_about() {
    // The error strip is drawn over the waveform, so each dot needs the
    // beat it belongs to — and a beat the tracker never found leaves a
    // GAP rather than shifting everything after it along by one.
    let times = drifting_beats(120.0, 126.0, 48, 0.4);
    let audio = click_track(&times, 1.0);
    let analysis = beats::analyze(&audio, &DspTracker, None, Reading::default()).expect("analyze");
    let source = analysis.source_grid(audio.duration_secs());
    let beats = analysis.residual_beats();

    assert_eq!(beats.len(), analysis.residuals_at(0.5).len());
    assert!(
        beats.windows(2).all(|w| w[1] - w[0] >= 1.0),
        "indices ascend by whole beats: {beats:?}"
    );
    let fitted: Vec<&grid::FittedBeat> = analysis
        .fit
        .beats
        .iter()
        .filter(|b| b.index >= analysis.first_index)
        .collect();
    for (n, b) in beats.iter().zip(&fitted) {
        // The dot sits on the grid line of the beat it measures...
        let line = analysis.fit.line(b.index);
        assert!(
            (source.beat_time(*n) - line).abs() < 1e-9,
            "beat {n} sits at {} but its grid line is at {line}",
            source.beat_time(*n)
        );
        // ...and it is numbered by the FIT's index, so a beat the tracker
        // never found leaves a hole in the strip instead of sliding every
        // later dot under the wrong beat.
        assert_eq!(n - beats[0], b.index - fitted[0].index);
    }
}

#[test]
fn the_lead_in_is_measured_within_a_beat_not_within_the_sliders_range() {
    // MOD-18 vs MOD-20: the slider reaches 250 ms so that material which
    // wants a long reach-back can have it, but what the ANALYSIS reports
    // is a fact about the attacks and stays inside the search radius. If
    // widening the control ever widened the measurement, a click track
    // would suddenly claim a fifth of a second of lead-in.
    let times = drifting_beats(120.0, 120.0, 48, 0.5);
    let audio = click_track(&times, 1.0);
    let analysis = beats::analyze(&audio, &DspTracker, None, Reading::default()).expect("analyze");
    assert!(
        analysis.lead_in <= grid::ATTACK_RADIUS + grid::LEAD_IN_PAD,
        "measured {} s",
        analysis.lead_in
    );
    // The slider reaches far past anything a measurement will produce:
    // its range is for material with a swell in front of the beat, not
    // for the drum hits the measurement is calibrated on.
    const _: () = assert!(grid::LEAD_IN_MAX > grid::ATTACK_RADIUS * 4.0);
}

// ---------------------------------------------------------------------------
// Optional dependency handling (beat_this)
// ---------------------------------------------------------------------------

#[test]
fn a_missing_interpreter_degrades_to_the_dsp_tracker() {
    // No panic, no crash: the status object carries the install hint so
    // the tab can annotate itself (same contract as the yt-dlp provider).
    let tracker = beats::detect::BeatThisTracker::with_python("dj-station-no-such-python");
    let audio = click_track(&drifting_beats(120.0, 120.0, 16, 0.5), 0.5);
    let err = tracker.detect(&audio, None).expect_err("no interpreter");
    let text = err.to_string();
    assert!(text.contains("not found"), "{text}");
    assert!(text.contains("pip install beat-this"), "{text}");
}

#[cfg(unix)]
#[test]
fn beat_this_output_is_parsed_and_context_trimmed() {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    // A fake interpreter standing in for `python -c <script>`: it ignores
    // the script and writes two seeds' worth of beats to the reply file
    // (`$6`), spanning more than the requested region so the context trim
    // (ANL-2a) is exercised. It also chatters on stdout, which the reply
    // file exists to make harmless.
    let dir = tempfile::tempdir().expect("tempdir");
    let fake = dir.path().join("fake-python");
    let mut f = std::fs::File::create(&fake).expect("create");
    writeln!(
        f,
        "#!/bin/sh\necho 'Downloading: final0.ckpt'\ncat > \"$6\" <<'JSON'\n\
         {{\"runs\":[{{\"seed\":\"final0\",\"beats\":[0.0,0.5,1.0,1.5,2.0,2.5,3.0,3.5,4.0,4.5,5.0,5.5,6.0,6.5,7.0,7.5,8.0,8.5,9.0]}},\
         {{\"seed\":\"final1\",\"beats\":[0.01,0.51,1.01,1.51,2.01,2.51,3.01,3.51,4.01,4.51,5.01,5.51,6.01,6.51,7.01,7.51,8.01,8.51,9.01]}}]}}\nJSON"
    )
    .expect("write");
    drop(f);
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let audio = click_track(&drifting_beats(120.0, 120.0, 24, 0.5), 1.0);
    let tracker = beats::detect::BeatThisTracker::with_python(fake.to_str().unwrap());
    // The fake reports beats relative to the context clip, which starts
    // CONTEXT_SECS before the region; only beats inside the region survive.
    let runs = tracker.detect(&audio, Some((4.0, 8.0))).expect("detect");
    assert_eq!(runs.len(), 2);
    for run in &runs {
        assert!(!run.beats.is_empty());
        assert!(run
            .beats
            .iter()
            .all(|b| *b >= 4.0 - 1e-9 && *b <= 8.0 + 1e-9));
    }
}

#[test]
fn a_model_that_fails_at_run_time_falls_back_to_dsp_and_says_so() {
    // Installed but broken (here: the interpreter is gone) must not cost
    // the analysis — but the tracker id has to admit what happened, since
    // that string is the tab's verdict line.
    let tracker = beats::detect::FallbackTracker::with_python("dj-station-no-such-python");
    let audio = click_track(&drifting_beats(120.0, 120.0, 32, 0.5), 0.5);
    let runs = tracker.detect(&audio, None).expect("dsp beats");
    assert_eq!(runs.len(), 1);
    assert!(runs[0].beats.len() > 8);
    let id = tracker.id();
    assert!(id.starts_with("dsp (beat_this failed:"), "{id}");
    assert!(id.contains("not found"), "{id}");
}

/// The embedded inference script, against a stand-in for the package.
///
/// The script decodes the temp wav ITSELF and hands `Audio2Beats` samples,
/// because `File2Beats` goes through `torchaudio.load`, which torchaudio
/// 2.9 removed — a current `beat_this` install cannot open any file. The
/// stand-in checks what the model would receive and reports it back.
///
/// Needs a python3 with numpy; skipped when there is none (nothing in the
/// suite may depend on the optional dependency being installed).
#[cfg(unix)]
#[test]
fn the_inference_script_hands_the_model_samples_not_a_path() {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    let numpy = Command::new("python3")
        .args(["-c", "import numpy"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !numpy {
        eprintln!("skipping: no python3 with numpy");
        return;
    }

    let dir = tempfile::tempdir().expect("tempdir");
    let pkg = dir.path().join("beat_this");
    std::fs::create_dir_all(&pkg).expect("mkdir");
    std::fs::write(pkg.join("__init__.py"), "").expect("init");
    let report = dir.path().join("seen.json");
    std::fs::write(
        pkg.join("inference.py"),
        format!(
            r#"
import json
import numpy as np


class Audio2Beats:
    def __init__(self, checkpoint_path="final0", device="cpu", float16=False, dbn=False):
        self.ckpt = checkpoint_path
        self.device = device

    def __call__(self, signal, sr):
        assert signal.dtype == np.float64, signal.dtype
        assert abs(signal).max() <= 1.0, abs(signal).max()
        with open({report:?}, "w") as f:
            json.dump({{"sr": sr, "samples": int(signal.shape[0]),
                        "channels": int(signal.shape[1]) if signal.ndim == 2 else 1,
                        "device": self.device}}, f)
        beats = np.arange(0.0, signal.shape[0] / sr, 0.5)
        return beats, beats[::4]
"#,
            report = report.to_str().unwrap()
        ),
    )
    .expect("inference");
    // The script asks torch for a device when none was forced.
    std::fs::write(
        dir.path().join("torch.py"),
        "import types\n\
         cuda = types.SimpleNamespace(is_available=lambda: False)\n\
         backends = types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False))\n",
    )
    .expect("torch");

    // An interpreter that only differs from python3 by seeing the fake.
    let python = dir.path().join("python-with-fake");
    let mut f = std::fs::File::create(&python).expect("create");
    writeln!(
        f,
        "#!/bin/sh\nPYTHONPATH={} exec python3 \"$@\"",
        dir.path().display()
    )
    .expect("write");
    drop(f);
    std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let audio = click_track(&drifting_beats(120.0, 120.0, 24, 0.5), 1.0);
    let tracker = beats::detect::BeatThisTracker::with_python(python.to_str().unwrap());
    let runs = tracker.detect(&audio, Some((4.0, 8.0))).expect("detect");
    assert_eq!(runs.len(), 3, "one run per seeded checkpoint");
    assert!(runs.iter().all(|r| !r.beats.is_empty()));

    let seen: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&report).expect("report")).expect("json");
    assert_eq!(seen["sr"].as_u64().unwrap() as u32, audio.sample_rate);
    assert_eq!(
        seen["channels"].as_u64().unwrap() as usize,
        audio.channels.len()
    );
    assert_eq!(seen["device"].as_str(), Some("cpu"));
    // The region plus the context read around it (ANL-2a), never the file.
    let secs = seen["samples"].as_f64().unwrap() / audio.sample_rate as f64;
    let expected = 4.0 + 2.0 * beats::detect::CONTEXT_SECS;
    assert!((secs - expected).abs() < 0.05, "{secs} vs {expected}");
}

#[cfg(unix)]
#[test]
fn a_launcher_script_names_the_interpreter_that_owns_the_package() {
    use std::io::Write;

    // What `uv tool install beat_this` / `pipx install beat-this` leave
    // behind: a console script whose shebang points at the environment's
    // own python. That interpreter — not `python3` — is the one that can
    // import the package, so discovery has to read it out.
    let dir = tempfile::tempdir().expect("tempdir");
    let venv_bin = dir.path().join("tools/beat-this/bin");
    std::fs::create_dir_all(&venv_bin).expect("mkdir");
    let venv_python = venv_bin.join("python3");
    std::fs::write(&venv_python, "").expect("python");
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).expect("mkdir");
    let mut launcher = std::fs::File::create(bin.join("beat_this")).expect("create");
    writeln!(
        launcher,
        "#!{}\n# -*- coding: utf-8 -*-",
        venv_python.display()
    )
    .expect("write");
    drop(launcher);

    let found = beats::detect::interpreters_from_launcher(&bin);
    assert_eq!(found, vec![venv_python]);
    // No launcher, nothing claimed.
    assert!(beats::detect::interpreters_from_launcher(dir.path()).is_empty());
}

#[test]
fn tracker_status_reports_the_install_hint() {
    let status = beats::detect::tracker_status();
    assert!(status.install_hint.contains("pip install beat-this"));
    if status.beat_this {
        assert!(status.tracker.starts_with("beat_this/"));
        assert_eq!(status.seeds.len(), 3);
    } else {
        assert_eq!(status.tracker, "dsp");
        assert!(!status.detail.is_empty());
    }
}
