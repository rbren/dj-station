//! Clip editor (Clip page) tests: edit semantics plus one serialized-program
//! golden-audio case, mirroring the engine's E2E goldens.
//!
//! The case is `tests/e2e/clips/<case>.json` (the serialized [`ClipProgram`],
//! which therefore also pins the program's JSON round-trip) rendered against
//! deterministic synthetic sources and compared sample-exactly against
//! `tests/e2e/goldens/<case>.wav`. Regenerate intentional changes with
//! `./scripts/regen-goldens.sh` and review the diff.

use dj_analysis::clip::{
    clips_dir, peaks, program_duration_secs, render_clip, wav16_bytes, write_clip, ClipEq,
    ClipProgram, ClipRegion, LevelPoint,
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

#[test]
fn eq_bands_boost_and_cut_their_own_range() {
    let low = tone(60.0, 1.0);
    let high = tone(9000.0, 1.0);
    let peak = |a: &AudioData| a.channels[0].iter().fold(0.0f32, |m, s| m.max(s.abs()));

    let boost_low = ClipProgram {
        regions: vec![whole(0, &low)],
        eq: ClipEq {
            low_db: 9.0,
            ..ClipEq::default()
        },
        ..ClipProgram::default()
    };
    let out = render_clip(&[&low], &boost_low).unwrap();
    assert!(peak(&out) > peak(&low) * 1.5, "low shelf did not boost");

    let cut_high = ClipProgram {
        regions: vec![whole(0, &high)],
        eq: ClipEq {
            high_db: -12.0,
            ..ClipEq::default()
        },
        ..ClipProgram::default()
    };
    let out = render_clip(&[&high], &cut_high).unwrap();
    assert!(peak(&out) < peak(&high) * 0.5, "high shelf did not cut");

    // Flat EQ is an exact bypass.
    let flat = render_clip(&[&low], &hard_cuts(vec![whole(0, &low)])).unwrap();
    assert_eq!(flat.channels[0], low.channels[0]);
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
        eq: ClipEq {
            low_db: 4.0,
            mid_db: -5.0,
            high_db: 2.5,
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
    let case = "clip-cut-splice-eq-level";
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
