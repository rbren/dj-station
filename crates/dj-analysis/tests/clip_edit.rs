//! Clip editor (Clip page) tests: edit semantics plus one serialized-program
//! golden-audio case, mirroring the engine's E2E goldens.
//!
//! The case is `tests/e2e/clips/<case>.json` (the serialized [`ClipProgram`],
//! which therefore also pins the program's JSON round-trip) rendered against
//! deterministic synthetic sources and compared sample-exactly against
//! `tests/e2e/goldens/<case>.wav`. Regenerate intentional changes with
//! `./scripts/regen-goldens.sh` and review the diff.

use dj_analysis::beatify::detect::DspTracker;
use dj_analysis::clip::{
    beats_from_taps, clips_dir, load_beat_clip, pad_to_beats, peaks, program_duration_secs,
    read_beat_clips, render_clip, save_beat_clip, warp_time_secs, wav16_bytes, write_clip, ClipEq,
    ClipEqBand, ClipOverlay, ClipProgram, ClipRegion, LevelPoint,
};
use dj_analysis::AudioData;
use std::path::{Path, PathBuf};

const SR: u32 = 48_000;

fn e2e_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/e2e")
}

fn regen() -> bool {
    std::env::var("REGEN_GOLDENS")
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// Deterministic stereo tone: `freq` Hz left, `freq * 1.5` right.
fn tone(freq: f64, seconds: f64) -> AudioData {
    let n = (seconds * SR as f64) as usize;
    let chan = |f: f64| -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * f * i as f64 / SR as f64).sin() as f32 * 0.5)
            .collect()
    };
    AudioData {
        channels: vec![chan(freq), chan(freq * 1.5)],
        sample_rate: SR,
    }
}

fn whole(source: usize, audio: &AudioData) -> ClipRegion {
    ClipRegion {
        source,
        start_secs: 0.0,
        end_secs: audio.duration_secs(),
        ..ClipRegion::default()
    }
}

fn span(source: usize, start: f64, end: f64) -> ClipRegion {
    ClipRegion {
        source,
        start_secs: start,
        end_secs: end,
        ..ClipRegion::default()
    }
}

/// No crossfade: the assembly is then sample-exact, which makes the cut /
/// splice / reverse assertions below exact too.
fn hard_cuts(regions: Vec<ClipRegion>) -> ClipProgram {
    ClipProgram {
        regions,
        crossfade_ms: 0.0,
        ..ClipProgram::default()
    }
}

#[test]
fn trim_keeps_only_the_selected_span() {
    let src = tone(220.0, 2.0);
    let out = render_clip(&[&src], &hard_cuts(vec![span(0, 0.5, 1.25)])).unwrap();

    assert_eq!(out.sample_rate, SR);
    assert_eq!(out.frames(), (0.75 * SR as f64) as usize);
    let first = (0.5 * SR as f64) as usize;
    for i in 0..out.frames() {
        assert_eq!(out.channels[0][i], src.channels[0][first + i]);
        assert_eq!(out.channels[1][i], src.channels[1][first + i]);
    }
}

#[test]
fn cutting_a_span_splices_the_remainder() {
    let src = tone(220.0, 2.0);
    let program = hard_cuts(vec![span(0, 0.0, 0.5), span(0, 1.5, 2.0)]);
    let out = render_clip(&[&src], &program).unwrap();

    assert_eq!(out.frames(), (1.0 * SR as f64) as usize);
    let half = (0.5 * SR as f64) as usize;
    let tail = (1.5 * SR as f64) as usize;
    assert_eq!(out.channels[0][0], src.channels[0][0]);
    assert_eq!(out.channels[0][half], src.channels[0][tail]);
    // The predicted duration matches what was actually rendered.
    assert!((program_duration_secs(&program) - out.duration_secs()).abs() < 1e-9);
}

#[test]
fn splicing_two_sources_concatenates_them() {
    let a = tone(220.0, 1.0);
    let b = tone(330.0, 1.0);
    let program = hard_cuts(vec![span(0, 0.0, 0.4), span(1, 0.2, 0.6)]);
    let out = render_clip(&[&a, &b], &program).unwrap();

    assert_eq!(out.frames(), (0.8 * SR as f64) as usize);
    let join = (0.4 * SR as f64) as usize;
    assert_eq!(
        out.channels[0][join],
        b.channels[0][(0.2 * SR as f64) as usize]
    );
}

#[test]
fn reverse_plays_the_span_backwards() {
    let src = tone(220.0, 1.0);
    let region = ClipRegion {
        reverse: true,
        ..span(0, 0.25, 0.75)
    };
    let out = render_clip(&[&src], &hard_cuts(vec![region])).unwrap();

    let first = (0.25 * SR as f64) as usize;
    let n = out.frames();
    assert_eq!(n, (0.5 * SR as f64) as usize);
    for i in 0..n {
        assert_eq!(out.channels[0][i], src.channels[0][first + n - 1 - i]);
    }
}

#[test]
fn region_gain_scales_that_span_only() {
    let src = tone(220.0, 1.0);
    let program = hard_cuts(vec![
        span(0, 0.0, 0.5),
        ClipRegion {
            gain_db: -6.0,
            ..span(0, 0.5, 1.0)
        },
    ]);
    let out = render_clip(&[&src], &program).unwrap();

    let half = (0.5 * SR as f64) as usize;
    let head: f32 = out.channels[0][..half]
        .iter()
        .fold(0.0, |m, s| m.max(s.abs()));
    let tail: f32 = out.channels[0][half..]
        .iter()
        .fold(0.0, |m, s| m.max(s.abs()));
    assert!((head - 0.5).abs() < 1e-3, "head peak {head}");
    assert!((tail - 0.5 * 0.501).abs() < 5e-3, "tail peak {tail}");
}

#[test]
fn crossfade_joins_are_click_free() {
    // Two spans whose material meets a quarter cycle out of phase: a hard
    // cut steps, the default equal-power crossfade does not.
    let src = tone(220.0, 2.0);
    let regions = vec![span(0, 0.0, 0.5), span(0, 1.0 + 0.25 / 220.0, 1.5)];
    let hard = render_clip(&[&src], &hard_cuts(regions.clone())).unwrap();
    let faded = render_clip(
        &[&src],
        &ClipProgram {
            regions,
            ..ClipProgram::default()
        },
    )
    .unwrap();

    let max_step = |a: &[f32]| a.windows(2).fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()));
    assert!(max_step(&faded.channels[0]) < max_step(&hard.channels[0]));
    // Overlapping joins shorten the result by the crossfade length.
    assert!(faded.frames() < hard.frames());
}

/// A single parametric band over the whole clip.
fn one_band(freq_hz: f64, gain_db: f64, q: f64) -> ClipEq {
    ClipEq {
        bands: vec![ClipEqBand {
            freq_hz,
            gain_db,
            q,
        }],
    }
}

#[test]
fn parametric_eq_bells_boost_and_cut_at_their_frequency() {
    let low = tone(60.0, 1.0);
    let high = tone(9000.0, 1.0);
    // Peak over the second half only: the biquad's onset transient passes
    // the first cycles nearly untouched.
    let peak = |a: &AudioData| {
        let tail = a.channels[0].len() / 2;
        a.channels[0][tail..]
            .iter()
            .fold(0.0f32, |m, s| m.max(s.abs()))
    };

    let boost_low = ClipProgram {
        regions: vec![whole(0, &low)],
        eq: one_band(60.0, 9.0, 1.0),
        ..ClipProgram::default()
    };
    let out = render_clip(&[&low], &boost_low).unwrap();
    assert!(peak(&out) > peak(&low) * 1.5, "bell at 60 Hz did not boost");

    let cut_high = ClipProgram {
        regions: vec![whole(0, &high)],
        eq: one_band(9000.0, -12.0, 1.0),
        ..ClipProgram::default()
    };
    let out = render_clip(&[&high], &cut_high).unwrap();
    assert!(peak(&out) < peak(&high) * 0.5, "bell at 9 kHz did not cut");

    // A narrow bell far from the material barely touches it.
    let off_target = ClipProgram {
        regions: vec![whole(0, &low)],
        eq: one_band(8000.0, 12.0, 8.0),
        ..ClipProgram::default()
    };
    let out = render_clip(&[&low], &off_target).unwrap();
    assert!(
        (peak(&out) - peak(&low)).abs() < 0.05,
        "remote bell moved a 60 Hz tone"
    );

    // All-zero gains (and the default empty EQ) are an exact bypass.
    let flat = render_clip(&[&low], &hard_cuts(vec![whole(0, &low)])).unwrap();
    assert_eq!(flat.channels[0], low.channels[0]);
    let zeroed = ClipProgram {
        regions: vec![whole(0, &low)],
        eq: one_band(1000.0, 0.0, 1.0),
        crossfade_ms: 0.0,
        ..ClipProgram::default()
    };
    let out = render_clip(&[&low], &zeroed).unwrap();
    assert_eq!(out.channels[0], low.channels[0]);
}

#[test]
fn overlays_mix_on_top_and_extend_the_clip() {
    let base = tone(220.0, 1.0);
    let extra = tone(330.0, 1.0);
    // Overlay 0.5 s of source 1 starting at 0.75 s: the first half is the
    // base alone, the middle is a mix, and the last 0.25 s exists only
    // because the overlay extended the clip.
    let program = ClipProgram {
        regions: vec![whole(0, &base)],
        overlays: vec![ClipOverlay {
            at_secs: 0.75,
            region: span(1, 0.0, 0.5),
        }],
        crossfade_ms: 0.0,
        ..ClipProgram::default()
    };
    let out = render_clip(&[&base, &extra], &program).unwrap();

    assert_eq!(out.frames(), (1.25 * SR as f64) as usize);
    assert!((program_duration_secs(&program) - 1.25).abs() < 1e-9);
    // Before the overlay: untouched base material.
    let i = (0.5 * SR as f64) as usize;
    assert_eq!(out.channels[0][i], base.channels[0][i]);
    // Inside the overlap: the sum of both sources.
    let j = (0.9 * SR as f64) as usize;
    let k = j - (0.75 * SR as f64) as usize;
    assert!((out.channels[0][j] - (base.channels[0][j] + extra.channels[0][k])).abs() < 1e-6);
    // Past the base clip's end: overlay material alone.
    let l = (1.1 * SR as f64) as usize;
    let m = l - (0.75 * SR as f64) as usize;
    assert!((out.channels[0][l] - extra.channels[0][m]).abs() < 1e-6);
}

#[test]
fn overlay_edges_are_ramped_when_crossfade_is_set() {
    let base = tone(220.0, 1.0);
    let extra = tone(330.0, 1.0);
    // Start the overlay mid-waveform: without the declick ramp the mix
    // would step at the entry point.
    let overlay = ClipOverlay {
        at_secs: 0.3,
        region: span(1, 0.2501, 0.7501),
    };
    let ramped = ClipProgram {
        regions: vec![whole(0, &base)],
        overlays: vec![overlay.clone()],
        ..ClipProgram::default()
    };
    let hard = ClipProgram {
        crossfade_ms: 0.0,
        ..ramped.clone()
    };
    let max_step = |a: &[f32]| a.windows(2).fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()));
    let out_ramped = render_clip(&[&base, &extra], &ramped).unwrap();
    let out_hard = render_clip(&[&base, &extra], &hard).unwrap();
    assert!(max_step(&out_ramped.channels[0]) < max_step(&out_hard.channels[0]));
}

#[test]
fn level_automation_fades_over_time() {
    let src = tone(220.0, 2.0);
    let program = ClipProgram {
        regions: vec![whole(0, &src)],
        level: vec![
            LevelPoint {
                time_secs: 0.0,
                gain_db: -60.0,
            },
            LevelPoint {
                time_secs: 1.0,
                gain_db: 0.0,
            },
            LevelPoint {
                time_secs: 2.0,
                gain_db: -60.0,
            },
        ],
        ..ClipProgram::default()
    };
    let out = render_clip(&[&src], &program).unwrap();

    let window = |a: &AudioData, t: f64| {
        let i = (t * SR as f64) as usize;
        a.channels[0][i..i + 2000]
            .iter()
            .fold(0.0f32, |m, s| m.max(s.abs()))
    };
    assert!(window(&out, 0.0) < 0.01, "fade-in did not start silent");
    assert!(window(&out, 0.5) < window(&out, 0.9), "fade-in not rising");
    assert!((window(&out, 0.98) - 0.5).abs() < 0.02, "peak not unity");
    assert!(
        window(&out, 1.9) < window(&out, 1.5),
        "fade-out not falling"
    );
}

#[test]
fn empty_and_bad_programs_are_rejected() {
    let src = tone(220.0, 0.5);
    assert!(render_clip(&[&src], &ClipProgram::default()).is_err());
    assert!(render_clip(&[], &hard_cuts(vec![span(0, 0.0, 0.1)])).is_err());
    assert!(render_clip(&[&src], &hard_cuts(vec![span(3, 0.0, 0.1)])).is_err());
    // Zero-length regions leave nothing to render.
    assert!(render_clip(&[&src], &hard_cuts(vec![span(0, 0.2, 0.2)])).is_err());
}

/// Silence with a short burst of energy at each `at` (seconds): the beat
/// material tap-warp tests move around.
fn clicks(at: &[f64], seconds: f64) -> AudioData {
    let n = (seconds * SR as f64) as usize;
    let mut chan = vec![0.0f32; n];
    for &t in at {
        let first = (t * SR as f64) as usize;
        for s in chan.iter_mut().take((first + 96).min(n)).skip(first) {
            *s = 0.8;
        }
    }
    AudioData {
        channels: vec![chan.clone(), chan],
        sample_rate: SR,
    }
}

/// Centre of energy of `audio` within `lo..hi` seconds.
fn burst_at(audio: &AudioData, lo: f64, hi: f64) -> f64 {
    let (a, b) = ((lo * SR as f64) as usize, (hi * SR as f64) as usize);
    let (mut num, mut den) = (0.0f64, 0.0f64);
    for i in a..b.min(audio.frames()) {
        let e = (audio.channels[0][i] as f64).abs();
        num += e * i as f64;
        den += e;
    }
    assert!(den > 0.0, "no energy in {lo}..{hi}");
    num / den / SR as f64
}

#[test]
fn tap_warp_evens_out_the_beats_and_leaves_the_rest_alone() {
    // Unevenly played beats at 1.0/1.4/2.1/3.0 s, tapped into an even
    // grid: 1.0 + n * (2.0 / 3). The endpoints are fixed (the average
    // preserves the covered span), so the length must not change.
    let played = [1.0, 1.4, 2.1, 3.0];
    let period = 2.0 / 3.0;
    let src = clicks(&played, 4.0);
    let warp: Vec<[f64; 2]> = played
        .iter()
        .enumerate()
        .map(|(i, &t)| [t, 1.0 + i as f64 * period])
        .collect();
    let program = ClipProgram {
        regions: vec![whole(0, &src)],
        crossfade_ms: 0.0,
        warp,
        ..ClipProgram::default()
    };
    assert!((program_duration_secs(&program) - 4.0).abs() < 1e-9);

    let out = render_clip(&[&src], &program).unwrap();
    assert_eq!(out.frames(), src.frames());
    for n in 0..4 {
        let want = 1.0 + n as f64 * period;
        let got = burst_at(&out, want - 0.2, want + 0.2);
        assert!(
            (got - want).abs() < 0.03,
            "beat {n}: burst at {got:.3}, wanted {want:.3}"
        );
    }
}

#[test]
fn identity_warp_is_a_sample_exact_passthrough() {
    let src = tone(220.0, 1.0);
    let plain = render_clip(&[&src], &hard_cuts(vec![whole(0, &src)])).unwrap();
    let warped = render_clip(
        &[&src],
        &ClipProgram {
            regions: vec![whole(0, &src)],
            crossfade_ms: 0.0,
            warp: vec![[0.25, 0.25], [0.75, 0.75]],
            ..ClipProgram::default()
        },
    )
    .unwrap();
    assert_eq!(plain.channels, warped.channels);
}

#[test]
fn malformed_warps_are_rejected() {
    let src = tone(220.0, 1.0);
    for warp in [vec![[0.5, 0.5]], vec![[0.5, 0.5], [0.2, 0.6]]] {
        let program = ClipProgram {
            regions: vec![whole(0, &src)],
            warp,
            ..ClipProgram::default()
        };
        assert!(render_clip(&[&src], &program).is_err());
    }
}

#[test]
fn warp_time_maps_inside_the_anchors_and_is_identity_outside() {
    let warp = vec![[1.0, 1.0], [2.0, 3.0], [4.0, 4.0]];
    assert_eq!(warp_time_secs(&warp, 0.5), 0.5);
    assert_eq!(warp_time_secs(&warp, 1.5), 2.0);
    assert_eq!(warp_time_secs(&warp, 3.0), 3.5);
    assert_eq!(warp_time_secs(&warp, 5.0), 5.0);
    assert_eq!(warp_time_secs(&[], 2.5), 2.5);
}

#[test]
fn pad_to_beats_cuts_to_exactly_the_asked_count() {
    // 1.75 s at 120 BPM is 3.5 beats: asked for 4, the clip becomes 4
    // whole beats, the last half-beat of it silence.
    let src = tone(220.0, 1.75);
    let padded = pad_to_beats(&src, 120.0, 4).unwrap();
    assert_eq!(padded.frames(), 2 * SR as usize);
    let tail_start = (1.75 * SR as f64) as usize;
    assert!(padded.channels[0][tail_start..].iter().all(|&s| s == 0.0));
    assert_eq!(&padded.channels[0][..tail_start], &src.channels[0][..]);

    // A span that already IS whole beats gains nothing.
    let whole_src = tone(220.0, 2.0);
    let kept = pad_to_beats(&whole_src, 120.0, 4).unwrap();
    assert_eq!(kept.frames(), whole_src.frames());

    // A hair of overhang — flam kept by the tapped grid, or sample
    // rounding — is TRIMMED, never rounded up to a fifth beat of
    // silence: two selected beats file as two.
    let long = tone(220.0, 2.01);
    let trimmed = pad_to_beats(&long, 120.0, 4).unwrap();
    assert_eq!(trimmed.frames(), 2 * SR as usize);

    // A count more than a beat away from the audio is a mismatched
    // call, and so is no count at all.
    assert!(pad_to_beats(&src, 120.0, 6).is_err());
    assert!(pad_to_beats(&src, 120.0, 0).is_err());
    assert!(pad_to_beats(&src, 0.0, 4).is_err());
}

/// A percussive burst on every beat over a quiet tonal bed — the same
/// material the Beatify tests track (theirs at 44.1 kHz, this at SR).
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

#[test]
fn taps_bound_the_span_and_the_trackers_beats_become_the_grid() {
    // Clicks at 120 BPM from 0.5 s; the hand taps eight beats between
    // 4.5 and 8 s, a constant 40 ms LATE (motor latency). The grid must
    // be the DETECTED beats over that span — not the taps.
    let clicks: Vec<f64> = (0..24).map(|i| 0.5 + i as f64 * 0.5).collect();
    let audio = click_track(&clicks, 1.0);
    let taps: Vec<f64> = (0..8).map(|i| 4.54 + i as f64 * 0.5).collect();

    let heard = beats_from_taps(&audio, &DspTracker, &taps).unwrap();
    assert_eq!(heard.seed, "dsp");
    assert!((heard.bpm - 120.0).abs() < 2.0, "bpm {}", heard.bpm);
    assert_eq!(heard.times.len(), 8, "times {:?}", heard.times);
    for (t, want) in heard.times.iter().zip((0..8).map(|i| 4.5 + i as f64 * 0.5)) {
        assert!((t - want).abs() < 0.05, "beat at {t}, wanted {want}");
    }

    // Fewer than two taps bound nothing.
    assert!(beats_from_taps(&audio, &DspTracker, &[1.0]).is_err());
}

#[test]
fn tapping_every_other_beat_chooses_the_half_time_reading() {
    // Same 120 BPM clicks, but the taps run one per TWO beats: the taps
    // choose the ÷2 reading, so the grid lands at 60 BPM on the beats
    // the user was actually marking.
    let clicks: Vec<f64> = (0..24).map(|i| 0.5 + i as f64 * 0.5).collect();
    let audio = click_track(&clicks, 1.0);
    let taps: Vec<f64> = (0..4).map(|i| 4.54 + i as f64).collect();

    let heard = beats_from_taps(&audio, &DspTracker, &taps).unwrap();
    assert!((heard.bpm - 60.0).abs() < 1.0, "bpm {}", heard.bpm);
    assert_eq!(heard.times.len(), 4, "times {:?}", heard.times);
    for (t, want) in heard.times.iter().zip((0..4).map(|i| 4.5 + i as f64)) {
        assert!((t - want).abs() < 0.05, "beat at {t}, wanted {want}");
    }
}

#[test]
fn beat_clip_store_round_trips_and_mints_ids_in_order() {
    let tmp = tempfile::tempdir().unwrap();

    // Nothing filed yet is an empty list, not an error.
    assert!(read_beat_clips(tmp.path()).is_empty());
    assert!(load_beat_clip(tmp.path(), "b1").is_err());

    // 1.75 s at 120 BPM: filed as 4 whole beats (2.0 s).
    let first = save_beat_clip(
        tmp.path(),
        "kick pattern",
        &tone(220.0, 1.75),
        120.0,
        4,
        vec!["drums".into()],
    )
    .unwrap();
    assert_eq!((first.id.as_str(), first.beats), ("b1", 4));
    let second =
        save_beat_clip(tmp.path(), "bass run", &tone(110.0, 2.0), 120.0, 4, vec![]).unwrap();
    assert_eq!(second.id, "b2");
    assert!(save_beat_clip(tmp.path(), "  ", &tone(220.0, 1.0), 120.0, 2, vec![]).is_err());

    let clips = read_beat_clips(tmp.path());
    assert_eq!(
        clips.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["kick pattern", "bass run"]
    );

    // The audio decodes back at the padded whole-beat length, silence
    // where the fractional last beat was filled.
    let (meta, audio) = load_beat_clip(tmp.path(), "b1").unwrap();
    assert_eq!(meta.bpm, 120.0);
    assert_eq!(meta.stems, ["drums"]);
    assert_eq!(audio.frames(), 2 * SR as usize);
    let tail = (1.75 * SR as f64) as usize;
    assert!(audio.channels[0][tail + 16..].iter().all(|&s| s == 0.0));
}

#[test]
fn peaks_and_wav_encoding_describe_the_render() {
    let src = tone(220.0, 1.0);
    let out = render_clip(&[&src], &hard_cuts(vec![span(0, 0.0, 1.0)])).unwrap();

    let p = peaks(&out, 100);
    assert_eq!(p.len(), 100);
    assert!(p.iter().all(|v| (0.4..=0.51).contains(v)), "peaks {p:?}");
    assert!(peaks(&out, 0).is_empty());

    let wav = wav16_bytes(&out);
    assert_eq!(&wav[..4], b"RIFF");
    assert_eq!(&wav[8..12], b"WAVE");
    assert_eq!(wav.len(), 44 + out.frames() * 2 * 2);
}

#[test]
fn rendering_a_clip_imports_a_new_track_and_leaves_the_source_alone() {
    let dir = tempfile::tempdir().unwrap();
    let library = dj_library::Library::open(dir.path()).unwrap();

    // A source file on disk, imported like any other library track.
    let source_path = dir.path().join("source.wav");
    let source = tone(220.0, 1.0);
    std::fs::write(&source_path, wav16_bytes(&source)).unwrap();
    let original = library
        .import_file(&source_path, dj_library::ImportOptions::default())
        .unwrap()
        .track()
        .clone();
    let source_bytes = std::fs::read(&source_path).unwrap();

    let decoded = dj_analysis::decode_audio(&source_path).unwrap();
    let rendered = render_clip(
        &[&decoded],
        &hard_cuts(vec![
            span(0, 0.0, 0.2),
            ClipRegion {
                reverse: true,
                ..span(0, 0.5, 0.8)
            },
        ]),
    )
    .unwrap();

    let clip_path = clips_dir(library.data_dir()).join("edit.flac");
    write_clip(&clip_path, &rendered).unwrap();
    let clip_track = library
        .import_file(
            &clip_path,
            dj_library::ImportOptions {
                source: "clip".into(),
                title: Some("Edit".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .track()
        .clone();

    assert_ne!(clip_track.id, original.id, "clip must be a new track");
    assert_eq!(clip_track.title, "Edit");
    assert_eq!(clip_track.source, "clip");
    assert_eq!(clip_track.analysis_status, "queued");
    assert_eq!(library.tracks().unwrap().len(), 2);
    // The source file and its library row are untouched.
    assert_eq!(std::fs::read(&source_path).unwrap(), source_bytes);
    assert_eq!(
        library.track(original.id).unwrap().file_path,
        original.file_path
    );

    // The clip decodes back to the rendered edit.
    let back = dj_analysis::decode_audio(&clip_path).unwrap();
    assert_eq!(back.sample_rate, rendered.sample_rate);
    assert_eq!(back.frames(), rendered.frames());
}

// ---------------------------------------------------------------------------
// Golden-audio case
// ---------------------------------------------------------------------------

/// The committed case: every edit operation at once, over two sources.
fn golden_program() -> ClipProgram {
    ClipProgram {
        regions: vec![
            span(0, 0.10, 0.45),
            ClipRegion {
                reverse: true,
                gain_db: -3.0,
                ..span(1, 0.20, 0.50)
            },
            span(0, 0.60, 0.85),
        ],
        overlays: vec![ClipOverlay {
            at_secs: 0.30,
            region: ClipRegion {
                gain_db: -6.0,
                ..span(1, 0.55, 0.95)
            },
        }],
        eq: ClipEq {
            bands: vec![
                ClipEqBand {
                    freq_hz: 99.0,
                    gain_db: 4.0,
                    q: 1.0,
                },
                ClipEqBand {
                    freq_hz: 990.0,
                    gain_db: -5.0,
                    q: 2.5,
                },
                ClipEqBand {
                    freq_hz: 6300.0,
                    gain_db: 2.5,
                    q: 0.7,
                },
            ],
        },
        level: vec![
            LevelPoint {
                time_secs: 0.0,
                gain_db: -60.0,
            },
            LevelPoint {
                time_secs: 0.15,
                gain_db: 0.0,
            },
            LevelPoint {
                time_secs: 0.6,
                gain_db: -4.0,
            },
            LevelPoint {
                time_secs: 0.9,
                gain_db: -60.0,
            },
        ],
        crossfade_ms: 8.0,
        ..ClipProgram::default()
    }
}

fn read_wav(path: &Path) -> (hound::WavSpec, Vec<i16>) {
    let mut reader = hound::WavReader::open(path)
        .unwrap_or_else(|e| panic!("cannot open {}: {e}", path.display()));
    let spec = reader.spec();
    (spec, reader.samples::<i16>().map(|s| s.unwrap()).collect())
}

#[test]
fn golden_clip_edit() {
    let case = "clip-cut-splice-overlay-eq-level";
    let program_path = e2e_dir().join("clips").join(format!("{case}.json"));
    let golden_path = e2e_dir().join("goldens").join(format!("{case}.wav"));

    if regen() {
        std::fs::create_dir_all(program_path.parent().unwrap()).unwrap();
        let mut json = serde_json::to_string_pretty(&golden_program()).unwrap();
        json.push('\n');
        std::fs::write(&program_path, json).unwrap();
    }

    // The committed JSON is the program under test, so the case doubles as
    // a serialization round-trip check.
    let program: ClipProgram =
        serde_json::from_str(&std::fs::read_to_string(&program_path).unwrap()).unwrap();
    assert_eq!(
        program,
        golden_program(),
        "{case}: serialized program drift"
    );

    let rendered = render_clip(&[&tone(220.0, 1.0), &tone(330.0, 1.0)], &program).unwrap();
    let bytes = wav16_bytes(&rendered);
    if regen() {
        std::fs::create_dir_all(golden_path.parent().unwrap()).unwrap();
        std::fs::write(&golden_path, &bytes).unwrap();
        println!("regenerated golden {}", golden_path.display());
        return;
    }

    let tmp = std::env::temp_dir().join(format!("dj-{case}.wav"));
    std::fs::write(&tmp, &bytes).unwrap();
    let (gspec, golden) = read_wav(&golden_path);
    let (rspec, samples) = read_wav(&tmp);
    assert_eq!(gspec, rspec, "{case}: WAV spec changed");
    assert_eq!(golden.len(), samples.len(), "{case}: length changed");
    let worst = golden
        .iter()
        .zip(&samples)
        .map(|(g, r)| (g - r).abs())
        .max()
        .unwrap_or(0);
    assert!(
        worst <= 1,
        "{case}: rendered audio deviates from the golden (max {worst} LSB).\n\
         If this change is intentional, run ./scripts/regen-goldens.sh and review the diff."
    );
    let _ = std::fs::remove_file(&tmp);
}
