//! Beatify pipeline tests (PRD §7 step 1): detection → fit → warp → emit,
//! plus one serialized-plan golden-audio case mirroring the Clip page's.
//!
//! The case is `tests/e2e/beatify/<case>.json` (the plan, which therefore
//! pins its JSON round-trip) rendered against a deterministic synthetic
//! source and compared sample-exactly against
//! `tests/e2e/goldens/<case>.wav`. Regenerate intentional changes with
//! `./scripts/regen-goldens.sh` and review the diff.
//!
//! Every test drives [`DspTracker`] explicitly: `beat_this` is optional
//! and must never be a CI dependency (same rule as the ONNX separator).

use dj_analysis::beatify::{
    self, audition, detect::BeatTracker, detect::DspTracker, grid, scope, store, warp::WarpMap,
    Reading, Ruler, Verdict,
};
use dj_analysis::AudioData;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const SR: u32 = 44_100;

fn e2e_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/e2e")
}

fn regen() -> bool {
    std::env::var("REGEN_GOLDENS")
        .map(|v| v == "1")
        .unwrap_or(false)
}

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

/// Onset positions in rendered audio: the steepest short-term energy rise
/// within `radius` of each expected time. This is how the tests hear the
/// result — beats that land on the grid, or not.
fn measured_offsets(audio: &AudioData, expected: &[f64], radius: f64) -> Vec<f64> {
    let mono = audio.mono_mix();
    let sr = SR as f64;
    let win = (0.002 * sr) as usize;
    let r = (radius * sr) as usize;
    let energy = |i: usize| -> f64 {
        let end = (i + win).min(mono.len());
        mono[i.min(mono.len())..end]
            .iter()
            .map(|s| (*s as f64) * (*s as f64))
            .sum::<f64>()
    };
    let mut out = Vec::new();
    for &t in expected {
        let center = (t * sr) as usize;
        if center <= r || center + r + win >= mono.len() {
            continue;
        }
        let mut best = center;
        let mut best_rise = f64::NEG_INFINITY;
        for i in (center - r)..(center + r) {
            let rise = energy(i + win) - energy(i);
            if rise > best_rise {
                best_rise = rise;
                best = i + win;
            }
        }
        out.push(best as f64 / sr - t);
    }
    out
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

fn analyze_drifting(bpm_start: f64, bpm_end: f64, beats: usize) -> (AudioData, beatify::Analysis) {
    let times = drifting_beats(bpm_start, bpm_end, beats, 0.5);
    let audio = click_track(&times, 1.0);
    let analysis =
        beatify::analyze(&audio, &DspTracker, None, Reading::default()).expect("analyze");
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
fn warping_puts_the_beats_on_the_grid() {
    let (audio, analysis) = analyze_drifting(120.0, 127.0, 48);
    let strength = analysis.sweep.default_strength;
    let (warped, _map) = beatify::render(&audio, &analysis, strength);

    assert_eq!(warped.channels.len(), 2);
    let expected_frames = (analysis.output_secs() * SR as f64).round() as usize;
    assert_eq!(warped.frames(), expected_frames);

    // The acceptance test of PRD §7: clips cut from opposite ends of the
    // track must layer without flam, i.e. every beat sits on its grid
    // line. Skip the padding beats at each end (they can be silence).
    let expected: Vec<f64> = (1..analysis.grid.beats - 1)
        .map(|n| analysis.grid.beat_time(n as f64))
        .collect();
    let offsets = measured_offsets(&warped, &expected, 0.030);
    assert!(offsets.len() > 40, "measured {} beats", offsets.len());
    // The grid arithmetic lands inside a millisecond; the extra couple of
    // milliseconds are the overlap-add engine's own transient placement
    // (see OFFSET_PENALTY in warp.rs).
    assert!(
        spread(&offsets) < 0.008,
        "warped beat spread {:.4}s",
        spread(&offsets)
    );
    assert!(
        analysis.quality_at(strength).worst_flam_ms < grid::FLAM_GREEN_MS,
        "meters disagree with the audio"
    );

    // Same measurement on the source: the drift the warp removed.
    let unwarped = beatify::render(&audio, &analysis, 0.0).0;
    let raw = measured_offsets(&unwarped, &expected, 0.060);
    assert!(
        spread(&raw) > spread(&offsets) * 3.0,
        "warp did not tighten the grid: raw {:.4}s vs warped {:.4}s",
        spread(&raw),
        spread(&offsets)
    );
}

/// The second seed of a project: played at one tempo, landing on
/// another's grid. This is the whole promise of a multi-seed project —
/// two records, two performances, one set of beat times.
#[test]
fn a_conformed_seed_lands_on_the_projects_grid() {
    // The project's tempo comes from a first seed at 120.
    let (_, first) = analyze_drifting(120.0, 120.0, 32);
    let period = first.grid.period;
    assert!((first.grid.bpm - 120.0).abs() < 0.5);

    // The second was played at 132 and drifts on top of that.
    let (audio, analysis) = analyze_drifting(132.0, 137.0, 48);
    let strength = analysis.sweep.default_strength;
    let (warped, map, grid) = beatify::render_at(&audio, &analysis, strength, period);

    assert!(
        (grid.bpm - 60.0 / period).abs() < 1e-9,
        "the project's tempo"
    );
    assert_eq!(grid.beats, analysis.grid.beats, "same beats, longer ones");
    assert!(
        (grid.phase - grid.period).abs() < 1e-12,
        "OUT-1a still holds"
    );
    let expected_frames = ((grid.beats as f64 + 1.0) * grid.period * SR as f64).round() as usize;
    assert_eq!(warped.frames(), expected_frames);

    // Every beat is on the PROJECT's line, not on the tempo it was
    // played at: 120 BPM lines, from 132 BPM material.
    let expected: Vec<f64> = (1..grid.beats - 1)
        .map(|n| grid.beat_time(n as f64))
        .collect();
    let offsets = measured_offsets(&warped, &expected, 0.030);
    assert!(offsets.len() > 40, "measured {} beats", offsets.len());
    assert!(
        spread(&offsets) < 0.008,
        "conformed beat spread {:.4}s",
        spread(&offsets)
    );

    // And it is ONE stretch: the map is the warp's, with its output
    // times scaled, rather than a second pass over the render.
    let own = analysis.map_at(strength);
    assert_eq!(map.points.len(), own.points.len());
    let k = period / analysis.grid.period;
    for ((s0, d0), (s1, d1)) in own.points.iter().zip(map.points.iter()) {
        assert!((s0 - s1).abs() < 1e-12, "source times are untouched");
        assert!((d0 * k - d1).abs() < 1e-9, "output times are scaled by k");
    }
}

/// Conforming to the tempo the material was already at changes nothing —
/// the first seed of a project is never stretched for the project's sake.
#[test]
fn the_first_seed_sets_the_tempo_and_is_not_conformed() {
    let (audio, analysis) = analyze_drifting(124.0, 124.0, 40);
    let strength = analysis.sweep.default_strength;
    let (a, map, grid) = beatify::render_at(&audio, &analysis, strength, analysis.grid.period);
    let (b, own) = beatify::render(&audio, &analysis, strength);

    assert_eq!(grid, analysis.grid);
    assert_eq!(map.pairs(), own.pairs());
    assert_eq!(a.frames(), b.frames());
    assert_eq!(a.channels[0][SR as usize], b.channels[0][SR as usize]);
}

/// Changing the project's tempo is a scale of the seed's stored map, so a
/// beat stays the same beat and lands where the new grid says.
#[test]
fn conforming_scales_output_times_and_nothing_else() {
    let map = beatify::WarpMap {
        points: vec![(0.0, 0.5), (10.0, 10.5), (20.0, 20.0)],
    };
    let out = beatify::conform(&map, 1.25);
    assert_eq!(
        out.pairs(),
        vec![[0.0, 0.625], [10.0, 13.125], [20.0, 25.0]]
    );
    // A nonsense ratio is refused rather than turning the map into NaN.
    for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert_eq!(beatify::conform(&map, bad).pairs(), map.pairs());
    }
}

#[test]
fn the_no_warp_position_only_trims() {
    let (audio, analysis) = analyze_drifting(124.0, 124.0, 40);
    let map = analysis.map_at(0.0);
    assert!(map.is_identity());
    let (warped, _) = beatify::render(&audio, &analysis, 0.0);
    // A pure trim reproduces source samples exactly (no overlap-add).
    let offset = (map.source_time(0.0) * SR as f64).round() as usize;
    for i in [0usize, 5_000, 20_000] {
        assert!((warped.channels[0][i] - audio.channels[0][offset + i]).abs() < 1e-9);
    }
}

#[test]
fn a_region_is_the_import() {
    let times = drifting_beats(120.0, 120.0, 64, 0.5);
    let audio = click_track(&times, 1.0);
    let region = (10.0, 22.0);
    let analysis = beatify::analyze(&audio, &DspTracker, Some(region), Reading::default())
        .expect("analyze region");
    // Only the region's beats survive: 12 s at 120 BPM is 24 beats.
    assert!(analysis
        .beats
        .iter()
        .all(|b| *b >= region.0 && *b <= region.1));
    assert!(
        (analysis.grid.beats as i64 - 24).abs() <= 2,
        "beats {}",
        analysis.grid.beats
    );

    let (warped, map) = beatify::render(&audio, &analysis, analysis.sweep.default_strength);
    assert!((warped.duration_secs() - analysis.output_secs()).abs() < 0.01);
    // Provenance: the imported span sits inside the region plus its
    // one-beat padding.
    let span = [
        map.source_time(0.0),
        map.source_time(analysis.output_secs()),
    ];
    assert!(
        span[0] > region.0 - 1.0 && span[1] < region.1 + 1.0,
        "span {span:?}"
    );
}

#[test]
fn the_source_grid_says_where_the_beats_are_in_the_file() {
    // The modal draws and snaps against the SOURCE timebase: `grid` is the
    // output one, whose beat 0 is head padding, and using it over the
    // source waveform puts every line in the wrong place.
    let times = drifting_beats(120.0, 120.0, 64, 0.7);
    let audio = click_track(&times, 1.0);
    let analysis =
        beatify::analyze(&audio, &DspTracker, None, Reading::default()).expect("analyze");
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
    let analysis =
        beatify::analyze(&audio, &DspTracker, None, Reading::default()).expect("analyze");
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
    let analysis =
        beatify::analyze(&audio, &DspTracker, None, Reading::default()).expect("analyze");
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

#[test]
fn the_sync_check_cuts_at_the_lead_in() {
    // The sync check is made of cuts, so it is where the lead-in becomes
    // audible: the take starts `lead_in` before the beat, which puts the
    // beat that far into the loop instead of at its very seam.
    let times = drifting_beats(120.0, 120.0, 40, 0.5);
    let audio = click_track(&times, 1.0);
    let analysis =
        beatify::analyze(&audio, &DspTracker, None, Reading::default()).expect("analyze");
    let strength = analysis.sweep.default_strength;

    let flush = audition::sync_check(&audio, &analysis, strength, 0.0);
    let led = audition::sync_check(&audio, &analysis, strength, 0.100);
    let onset = |a: &AudioData| -> f64 {
        let mono = a.mono_mix();
        let peak = mono.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        mono.iter().position(|s| s.abs() > peak * 0.5).unwrap_or(0) as f64 / a.sample_rate as f64
    };
    let moved = onset(&led) - onset(&flush);
    assert!(
        (moved - 0.100).abs() < 0.010,
        "the first attack should sit 100 ms into the take, moved {moved} s"
    );
}

#[test]
fn the_inspector_finds_the_attack_the_cut_has_to_clear() {
    // §3.5: the traces exist so the user can SEE the cut land in front of
    // the attack. That only works if the window really is centred on the
    // grid line and the attack really is where the lead-in says it is.
    let times = drifting_beats(120.0, 120.0, 64, 0.7);
    let audio = click_track(&times, 1.0);
    let analysis =
        beatify::analyze(&audio, &DspTracker, None, Reading::default()).expect("analyze");
    let s = scope::scope(
        &audio,
        &analysis,
        analysis.sweep.default_strength,
        200,
        scope::SCOPE_PRE,
    );

    assert_eq!(s.pre_secs, scope::SCOPE_PRE);
    assert_eq!(s.traces.len(), scope::SCOPE_TRACES);
    assert!(s.traces.iter().all(|t| t.samples.len() == 200));
    // Sampled ACROSS the song (MOD-8): comparing the first beats with the
    // last is the whole point.
    assert!(s.traces[0].beat < s.traces[s.traces.len() - 1].beat / 2);
    // A click track's transient is at the beat, so a locked grid leaves
    // no lead and no smear worth speaking of.
    assert!(s.attack_lead.abs() < 0.010, "attack lead {}", s.attack_lead);
    assert!(s.spread < 0.010, "spread {}", s.spread);
    // Clearance is what the slider buys: room in front of the attack.
    assert!(s.clearance(0.020) > s.clearance(0.0));
    assert!(s.clearance(0.020) > 0.0);

    // A lead-in can now reach back further than the PRD's 40 ms window,
    // and a cut drawn off-screen would be worse than no drawing at all,
    // so the window opens on request — around the same line, so what it
    // says about the attack does not change with how wide it is.
    let wide = scope::scope(
        &audio,
        &analysis,
        analysis.sweep.default_strength,
        200,
        0.200,
    );
    assert!((wide.pre_secs - 0.200).abs() < 1e-9);
    assert!((wide.attack_lead - s.attack_lead).abs() < 1e-9);
    let capped = scope::scope(&audio, &analysis, analysis.sweep.default_strength, 200, 9.0);
    assert_eq!(capped.pre_secs, scope::SCOPE_PRE_MAX);
}

#[test]
fn the_traces_converge_as_the_warp_pulls_the_beats_in() {
    // MOD-9, and the reason the inspector is worth drawing: at no warp a
    // drifting track's attacks scatter across the window; with the warp
    // on they land on the line together.
    let (audio, analysis) = analyze_drifting(120.0, 126.0, 64);
    let spread_of = |strength: f64| {
        let s = scope::scope(&audio, &analysis, strength, 64, scope::SCOPE_PRE);
        let offs: Vec<f64> = s.traces.iter().filter_map(|t| t.attack).collect();
        let lo = offs.iter().cloned().fold(f64::INFINITY, f64::min);
        let hi = offs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        (hi - lo, offs.len())
    };
    let (loose, loose_found) = spread_of(0.0);
    let (tight, tight_found) = spread_of(1.0);
    assert!(
        tight < loose,
        "warped spread {tight} should beat unwarped {loose}"
    );
    // And with the warp on, every sampled beat HAS a findable attack near
    // its line — at no warp some have drifted out of the search radius
    // altogether, which is the same story told by absence.
    assert_eq!(tight_found, scope::SCOPE_TRACES);
    assert!(loose_found <= tight_found);
}

#[test]
fn head_padding_is_silence_when_the_source_starts_at_zero() {
    let times = drifting_beats(120.0, 120.0, 40, 0.02);
    let audio = click_track(&times, 1.0);
    let analysis =
        beatify::analyze(&audio, &DspTracker, None, Reading::default()).expect("analyze");
    let (warped, _) = beatify::render(&audio, &analysis, 0.0);
    // MOD-A14: a beat of padding exists even at the very start of a file —
    // real audio where it exists, silence where it does not.
    assert!(warped.duration_secs() > analysis.grid.beats as f64 * analysis.grid.period);
}

#[test]
fn an_audition_window_renders_only_what_is_heard() {
    let (audio, analysis) = analyze_drifting(120.0, 126.0, 48);
    let strength = analysis.sweep.default_strength;
    let window = beatify::render_window(&audio, &analysis, strength, 4.0, 2.0);
    assert!((window.duration_secs() - 2.0).abs() < 0.01);
    // It is the same audio as the full render at that offset.
    let (full, _) = beatify::render(&audio, &analysis, strength);
    let at = (4.0 * SR as f64) as usize;
    let a: f64 = window.channels[0][..1000]
        .iter()
        .map(|s| (*s as f64).abs())
        .sum();
    let b: f64 = full.channels[0][at..at + 1000]
        .iter()
        .map(|s| (*s as f64).abs())
        .sum();
    assert!((a - b).abs() < 0.15 * b.max(1e-6), "window {a} vs full {b}");
}

// ---------------------------------------------------------------------------
// Record + store (§3.11, §5)
// ---------------------------------------------------------------------------

#[test]
fn the_record_round_trips_through_the_store() {
    let (audio, analysis) = analyze_drifting(120.0, 125.0, 40);
    let strength = analysis.sweep.default_strength;
    let (warped, map) = beatify::render(&audio, &analysis, strength);
    let record = beatify::record(
        &analysis,
        &beatify::Commit {
            source: std::path::Path::new("/music/boys.wav"),
            source_hash: "0123456789abcdef0123456789abcdef",
            warped_name: "boys.beatified.wav",
            strength,
            lead_in: analysis.lead_in,
            ruler: Ruler::default(),
            grid: analysis.grid,
        },
        &map,
    );
    assert_eq!(record.ruler.group, 4);
    assert!(record.warp.map.len() >= 2);
    assert_eq!(record.analysis.tracker, "dsp");

    let json = serde_json::to_string(&record).expect("serialize");
    // The §5 payload is camelCase, exactly as the PRD specifies it.
    assert!(json.contains("\"sourceSpan\""));
    assert!(json.contains("\"leadIn\""));
    assert!(json.contains("\"worstFlamMs\""));
    assert!(json.contains("\"anchorStride\""));

    let dir = tempfile::tempdir().expect("tempdir");
    let mut project = store::Project::new("p1".into(), "boys".into());
    let seed = a_seed("s1", &record, 7);
    project.bpm = Some(record.grid.bpm);
    project.seeds.push(seed.clone());
    store::save_seed(dir.path(), &project, &seed, &record, &warped).expect("save");
    let loaded = store::load_seed(dir.path(), "p1", &seed)
        .expect("load")
        .expect("record exists");
    assert_eq!(loaded.grid, record.grid);
    assert_eq!(loaded.source_hash, record.source_hash);
    assert!(store::seed_warped_path(dir.path(), "p1", &seed).exists());
    // Keyed by the PROJECT, and inside it by the SEED: one project holds
    // several tracks, and one track can be in several projects.
    assert!(store::project_dir(dir.path(), "p1").ends_with("p1"));
    assert!(store::seed_dir(dir.path(), "p1", &seed).ends_with("seeds/s1"));

    let reopened = store::project(dir.path(), "p1")
        .expect("project")
        .expect("exists");
    assert_eq!(reopened.seeds.len(), 1);
    assert_eq!(reopened.bpm, Some(record.grid.bpm));

    store::remove(dir.path(), "p1").expect("remove");
    assert!(store::project(dir.path(), "p1").expect("project").is_none());
}

/// A project is a place, not a take on a track: it exists before anything
/// has been imported, and it has no tempo until the first seed sets one.
#[test]
fn a_project_can_be_started_with_nothing_in_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let project = store::Project::new("p1".into(), "tuesday".into());
    assert!(project.bpm.is_none());
    assert!(project.period().is_none());
    store::save_project(dir.path(), &project).expect("save");

    let list = store::list(dir.path()).expect("list");
    assert_eq!(list.len(), 1, "an empty project is still a project");
    assert!(list[0].seeds.is_empty());
    assert!(list[0].bpm.is_none());
    // And the next seed id does not depend on there being seeds.
    assert_eq!(list[0].new_seed_id(), "s1");
}

/// Several tracks, one tempo. Each seed keeps its own render and its own
/// stem cache; the project keeps the BPM they all agree on.
#[test]
fn a_project_holds_more_than_one_seed() {
    let (record, warped) = a_saved_record();
    let dir = tempfile::tempdir().expect("tempdir");
    let mut project = store::Project::new("p1".into(), "tuesday".into());
    project.bpm = Some(128.0);

    for (id, name, track_id, source_bpm) in [
        ("s1", "boys", 7, 128.0),
        ("s2", "girls", 9, 122.0),
        ("s3", "drums", 11, 174.0),
    ] {
        let seed = store::Seed {
            id: id.into(),
            name: name.into(),
            track_id,
            source_hash: format!("hash-{id}"),
            dir: store::seed_dir_name(id),
            source_bpm,
            speed: 128.0 / source_bpm,
        };
        project.seeds.push(seed.clone());
        store::save_seed(dir.path(), &project, &seed, &record, &warped).expect("save");
    }

    let reopened = store::project(dir.path(), "p1")
        .expect("project")
        .expect("exists");
    assert_eq!(reopened.seeds.len(), 3);
    assert_eq!(reopened.new_seed_id(), "s4");
    // The seed that set the tempo runs at 1.0; the others are conformed.
    assert!((reopened.seeds[0].speed - 1.0).abs() < 1e-9);
    assert!(reopened.seeds[1].speed > 1.0, "122 has to speed up to 128");
    assert!(reopened.seeds[2].speed < 1.0, "174 has to slow down");
    assert!((reopened.seeds[2].speed_pct() + 26.4).abs() < 0.1);

    // Each seed's artifacts are its own.
    for seed in &reopened.seeds {
        assert!(store::seed_warped_path(dir.path(), "p1", seed).exists());
        assert!(store::load_seed(dir.path(), "p1", seed)
            .expect("load")
            .is_some());
    }

    // Dropping one leaves the others, and the project, alone.
    let gone = reopened.seeds[1].clone();
    store::remove_seed(dir.path(), "p1", &gone).expect("remove seed");
    assert!(!store::seed_warped_path(dir.path(), "p1", &gone).exists());
    assert!(store::seed_warped_path(dir.path(), "p1", &reopened.seeds[0]).exists());
    assert!(store::project(dir.path(), "p1").expect("project").is_some());
}

/// One track, two projects: still true, and still nothing shared but the
/// source hash.
#[test]
fn a_track_can_be_in_more_than_one_project() {
    let (record, warped) = a_saved_record();
    let dir = tempfile::tempdir().expect("tempdir");

    for (id, name, updated) in [("p1", "first pass", 100), ("p2", "slower take", 200)] {
        let seed = a_seed("s1", &record, 7);
        let mut project = store::Project::new(id.into(), name.into());
        project.updated = updated;
        project.bpm = Some(record.grid.bpm);
        project.seeds.push(seed.clone());
        store::save_seed(dir.path(), &project, &seed, &record, &warped).expect("save");
    }

    let list = store::list(dir.path()).expect("list");
    // Newest first: the list is a place you continue work from.
    assert_eq!(
        list.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        ["p2", "p1"]
    );
    assert_eq!(list[0].name, "slower take");
    assert!(list
        .iter()
        .all(|p| p.seeds[0].source_hash == record.source_hash));
    assert_eq!(store::new_id(&list), "p3");

    // Deleting one leaves the other's artifacts alone.
    store::remove(dir.path(), "p2").expect("remove");
    let left = store::project(dir.path(), "p1")
        .expect("project")
        .expect("exists");
    assert!(store::seed_warped_path(dir.path(), "p1", &left.seeds[0]).exists());
    assert_eq!(store::list(dir.path()).expect("list").len(), 1);
}

/// A project written when one project meant one track opens as a project
/// with ONE seed, whose artifacts stay exactly where they are. Nobody has
/// to migrate anything, and nothing is rewritten to read it.
#[test]
fn a_single_track_project_is_adopted_as_one_seed() {
    let (record, warped) = a_saved_record();
    let dir = tempfile::tempdir().expect("tempdir");
    let root = store::project_dir(dir.path(), "p1");
    std::fs::create_dir_all(&root).expect("mkdir");
    std::fs::write(
        root.join(store::META_NAME),
        serde_json::to_string(&record).expect("json"),
    )
    .expect("write meta");
    std::fs::write(
        root.join(store::WARPED_NAME),
        dj_analysis::clip::wav16_bytes(&warped),
    )
    .expect("write wav");
    // The pre-seeds envelope: a name, the track it came from, no seeds.
    std::fs::write(
        root.join(store::PROJECT_NAME),
        serde_json::json!({
            "id": "p1",
            "name": "boys",
            "trackId": 7,
            "sourceHash": record.source_hash,
            "updated": 1000,
        })
        .to_string(),
    )
    .expect("write project");

    let project = store::project(dir.path(), "p1")
        .expect("project")
        .expect("exists");
    assert_eq!(project.name, "boys");
    assert_eq!(project.seeds.len(), 1);
    let seed = &project.seeds[0];
    // Its artifacts are the project root — that is what an empty dir is.
    assert!(seed.dir.is_empty());
    assert_eq!(seed.track_id, 7, "it remembers which track it came from");
    assert_eq!(
        store::seed_warped_path(dir.path(), "p1", seed),
        root.join(store::WARPED_NAME)
    );
    assert!(store::load_seed(dir.path(), "p1", seed)
        .expect("load")
        .is_some());
    // Its render's tempo is the project's tempo: it was the first seed.
    assert_eq!(project.bpm, Some(record.grid.bpm));
    assert!((seed.speed - 1.0).abs() < 1e-9);
    // Adoption is read-only: the file on disk still has no seed list.
    let on_disk: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join(store::PROJECT_NAME)).unwrap())
            .unwrap();
    assert!(on_disk.get("seeds").is_none());

    // A second seed can be imported alongside it, and the adopted one is
    // left where it lies rather than being moved under `seeds/`.
    let mut project = project;
    let next = store::Seed {
        id: "s2".into(),
        name: "girls".into(),
        track_id: 9,
        source_hash: "otherhash".into(),
        dir: store::seed_dir_name("s2"),
        source_bpm: 122.0,
        speed: record.grid.bpm / 122.0,
    };
    project.seeds.push(next.clone());
    store::save_seed(dir.path(), &project, &next, &record, &warped).expect("save");
    let reopened = store::project(dir.path(), "p1")
        .expect("project")
        .expect("exists");
    assert_eq!(reopened.seeds.len(), 2);
    assert!(reopened.seeds[0].dir.is_empty());
    assert!(root.join(store::WARPED_NAME).exists());
    assert!(store::seed_warped_path(dir.path(), "p1", &next).exists());
}

/// A directory written before projects existed is a project: same files,
/// its name is the hash prefix, and the envelope is inferred. Nobody has
/// to migrate anything by hand, and nothing is rewritten to read it.
#[test]
fn a_legacy_hash_keyed_record_is_adopted_as_a_project() {
    let (record, warped) = a_saved_record();
    let dir = tempfile::tempdir().expect("tempdir");
    let hash_dir = store::project_dir(dir.path(), &store::short_hash(&record.source_hash));
    std::fs::create_dir_all(&hash_dir).expect("mkdir");
    std::fs::write(
        hash_dir.join(store::META_NAME),
        serde_json::to_string(&record).expect("json"),
    )
    .expect("write meta");
    std::fs::write(
        hash_dir.join(store::WARPED_NAME),
        dj_analysis::clip::wav16_bytes(&warped),
    )
    .expect("write wav");

    let list = store::list(dir.path()).expect("list");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, "0123456789abcdef");
    // Named for the file it came from, and it knows its full hash.
    assert_eq!(list[0].name, "boys");
    assert_eq!(list[0].seeds.len(), 1);
    assert_eq!(list[0].seeds[0].source_hash, record.source_hash);
    // Adoption is read-only: no envelope is written behind the user's back.
    assert!(!hash_dir.join(store::PROJECT_NAME).exists());
    // A minted id cannot collide with it.
    assert_eq!(store::new_id(&list), "p2");
}

/// The seed the store tests file.
fn a_seed(id: &str, record: &beatify::BeatifyRecord, track_id: i64) -> store::Seed {
    store::Seed {
        id: id.into(),
        name: "boys".into(),
        track_id,
        source_hash: record.source_hash.clone(),
        dir: store::seed_dir_name(id),
        source_bpm: record.grid.bpm,
        speed: 1.0,
    }
}

/// The record + render the store tests share.
fn a_saved_record() -> (beatify::BeatifyRecord, dj_analysis::AudioData) {
    let (audio, analysis) = analyze_drifting(120.0, 125.0, 40);
    let (warped, map) = beatify::render(&audio, &analysis, analysis.sweep.default_strength);
    let record = beatify::record(
        &analysis,
        &beatify::Commit {
            source: std::path::Path::new("/music/boys.wav"),
            source_hash: "0123456789abcdef0123456789abcdef",
            warped_name: "boys.beatified.wav",
            strength: analysis.sweep.default_strength,
            lead_in: analysis.lead_in,
            ruler: Ruler::default(),
            grid: analysis.grid,
        },
        &map,
    );
    (record, warped)
}

// ---------------------------------------------------------------------------
// Optional dependency handling (beat_this)
// ---------------------------------------------------------------------------

#[test]
fn a_missing_interpreter_degrades_to_the_dsp_tracker() {
    // No panic, no crash: the status object carries the install hint so
    // the tab can annotate itself (same contract as the yt-dlp provider).
    let tracker = beatify::detect::BeatThisTracker::with_python("dj-station-no-such-python");
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
    let tracker = beatify::detect::BeatThisTracker::with_python(fake.to_str().unwrap());
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
    let tracker = beatify::detect::FallbackTracker::with_python("dj-station-no-such-python");
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
    let tracker = beatify::detect::BeatThisTracker::with_python(python.to_str().unwrap());
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
    let expected = 4.0 + 2.0 * beatify::detect::CONTEXT_SECS;
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

    let found = beatify::detect::interpreters_from_launcher(&bin);
    assert_eq!(found, vec![venv_python]);
    // No launcher, nothing claimed.
    assert!(beatify::detect::interpreters_from_launcher(dir.path()).is_empty());
}

#[test]
fn tracker_status_reports_the_install_hint() {
    let status = beatify::detect::tracker_status();
    assert!(status.install_hint.contains("pip install beat-this"));
    if status.beat_this {
        assert!(status.tracker.starts_with("beat_this/"));
        assert_eq!(status.seeds.len(), 3);
    } else {
        assert_eq!(status.tracker, "dsp");
        assert!(!status.detail.is_empty());
    }
}

// ---------------------------------------------------------------------------
// Golden audio case
// ---------------------------------------------------------------------------

/// A serialized Beatify case: the synthetic source plus the plan the modal
/// would have committed.
#[derive(Debug, Serialize, Deserialize)]
struct BeatifyCase {
    bpm_start: f64,
    bpm_end: f64,
    beats: usize,
    offset_secs: f64,
    region: Option<[f64; 2]>,
    strength: f64,
    reading: Reading,
    ruler_group: u32,
}

#[test]
fn golden_warped_render() {
    let case_path = e2e_dir().join("beatify/drifting_live.json");
    let golden_path = e2e_dir().join("goldens/beatify_drifting_live.wav");
    let case: BeatifyCase = if regen() || !case_path.exists() {
        let case = BeatifyCase {
            bpm_start: 118.0,
            bpm_end: 123.5,
            beats: 40,
            offset_secs: 0.5,
            region: Some([2.0, 10.0]),
            strength: 0.6,
            reading: Reading::default(),
            ruler_group: 4,
        };
        std::fs::create_dir_all(case_path.parent().unwrap()).expect("case dir");
        std::fs::write(&case_path, serde_json::to_string_pretty(&case).unwrap()).expect("write");
        case
    } else {
        serde_json::from_str(&std::fs::read_to_string(&case_path).expect("read case"))
            .expect("parse case")
    };

    let times = drifting_beats(case.bpm_start, case.bpm_end, case.beats, case.offset_secs);
    let stereo = click_track(&times, 1.0);
    // Mono keeps the golden small; the multi-channel path is covered by
    // `warping_puts_the_beats_on_the_grid`.
    let audio = AudioData {
        channels: vec![stereo.mono_mix()],
        sample_rate: stereo.sample_rate,
    };
    let region = case.region.map(|r| (r[0], r[1]));
    let analysis = beatify::analyze(&audio, &DspTracker, region, case.reading).expect("analyze");
    let (warped, map) = beatify::render(&audio, &analysis, case.strength);
    let bytes = dj_analysis::clip::wav16_bytes(&warped);

    if regen() || !golden_path.exists() {
        std::fs::create_dir_all(golden_path.parent().unwrap()).expect("golden dir");
        std::fs::write(&golden_path, &bytes).expect("write golden");
        eprintln!("regenerated {}", golden_path.display());
    } else {
        let expected = std::fs::read(&golden_path).expect("read golden");
        assert_eq!(
            bytes.len(),
            expected.len(),
            "warped render length changed — regenerate with scripts/regen-goldens.sh"
        );
        assert!(
            bytes == expected,
            "warped render changed — regenerate with scripts/regen-goldens.sh"
        );
    }

    // The payload travels with the audio and stays legible.
    let record = beatify::record(
        &analysis,
        &beatify::Commit {
            source: std::path::Path::new("boys.wav"),
            source_hash: "feedfacefeedfacefeedfacefeedface",
            warped_name: "boys.beatified.wav",
            strength: case.strength,
            lead_in: analysis.lead_in,
            ruler: Ruler {
                group: case.ruler_group,
            },
            grid: analysis.grid,
        },
        &map,
    );
    let json = serde_json::to_string(&record).expect("serialize");
    let back: dj_analysis::beatify::BeatifyRecord = serde_json::from_str(&json).expect("parse");
    assert_eq!(back.grid, record.grid);
    assert_eq!(back.warp.map.len(), record.warp.map.len());
    assert_eq!(
        WarpMap::from_anchors(&analysis.anchors_at(case.strength)).pairs(),
        record.warp.map
    );
}
