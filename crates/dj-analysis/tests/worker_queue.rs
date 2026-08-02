//! Background worker queue tests (M3): importing a track auto-queues
//! analysis, BPM/key/beatgrid land in the DB with no user action, and
//! per-track caching keyed by content hash means a re-import of an
//! identical file never re-analyzes.

use dj_analysis::testset::synth_labeled_track;
use dj_analysis::worker::{analyze_track_now, start_worker, AnalysisSettings};
use dj_analysis::{stems_cached, stems_dir, AudioData, BandSeparator, StemSeparator, Stems};
use dj_library::{ImportOptions, ImportOutcome, Library};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn write_wav(path: &Path, audio: &AudioData) {
    let spec = hound::WavSpec {
        channels: audio.channels.len() as u16,
        sample_rate: audio.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..audio.frames() {
        for c in &audio.channels {
            w.write_sample((c[i].clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                .unwrap();
        }
    }
    w.finalize().unwrap();
}

struct Counting(BandSeparator, Arc<AtomicUsize>);
impl StemSeparator for Counting {
    fn id(&self) -> &'static str {
        "counting"
    }
    fn separate(&self, audio: &AudioData) -> anyhow::Result<Stems> {
        self.1.fetch_add(1, Ordering::SeqCst);
        self.0.separate(audio)
    }
}

fn wait_for_status(library: &Library, track_id: i64, status: &str, timeout: Duration) {
    let t0 = Instant::now();
    loop {
        let s = library.track(track_id).unwrap().analysis_status;
        if s == status {
            return;
        }
        assert!(
            t0.elapsed() < timeout,
            "track {track_id} stuck in status {s:?} (wanted {status:?})"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn import_auto_queues_and_results_land_in_the_db() {
    let tmp = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::open(tmp.path()).unwrap());
    let t = synth_labeled_track(42, 44_100, 15.0);
    let wav = tmp.path().join("track.wav");
    write_wav(&wav, &t.audio);

    let counter = Arc::new(AtomicUsize::new(0));
    let _worker = start_worker(
        library.clone(),
        AnalysisSettings {
            poll_interval: Duration::from_millis(25),
            compute_stems: true,
            separator: Arc::new(Counting(BandSeparator, counter.clone())),
        },
    );

    // Import (as the watch folder / drag & drop / downloads do) — this is
    // the *only* user action; analysis must follow automatically.
    let outcome = library.import_file(&wav, ImportOptions::default()).unwrap();
    let track = outcome.track().clone();
    assert_eq!(track.analysis_status, "queued");

    wait_for_status(&library, track.id, "done", Duration::from_secs(60));
    let done = library.track(track.id).unwrap();
    let bpm = done.bpm.expect("bpm missing");
    assert!(
        (bpm - t.bpm).abs() / t.bpm <= 0.02
            || (bpm - 2.0 * t.bpm).abs() / (2.0 * t.bpm) <= 0.02
            || (bpm - 0.5 * t.bpm).abs() / (0.5 * t.bpm) <= 0.02,
        "bpm {bpm} vs truth {}",
        t.bpm
    );
    assert_eq!(done.musical_key.as_deref(), Some(t.key.as_str()));

    // Auto-beatgrid landed as track metadata (the deck re-applies it).
    let grid = library.track_beatgrid(track.id).unwrap().expect("no grid");
    assert!(grid.bpm > 0.0);

    // Stems cached as FLAC under the content-hashed dir.
    let dir = stems_dir(library.data_dir(), &track.content_hash);
    assert!(stems_cached(&dir));
    assert_eq!(counter.load(Ordering::SeqCst), 1);

    // Re-import of the identical file (content hash): deduped, never
    // re-queued, nothing recomputed.
    let copy = tmp.path().join("copy.wav");
    std::fs::copy(&wav, &copy).unwrap();
    let outcome = library
        .import_file(&copy, ImportOptions::default())
        .unwrap();
    assert!(matches!(outcome, ImportOutcome::Duplicate(_)));
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(library.track(track.id).unwrap().analysis_status, "done");
    assert_eq!(counter.load(Ordering::SeqCst), 1, "duplicate re-analyzed");
}

#[test]
fn rerun_recomputes_bpm_key_but_reuses_cached_stems() {
    let tmp = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::open(tmp.path()).unwrap());
    let t = synth_labeled_track(7, 44_100, 15.0);
    let wav = tmp.path().join("track.wav");
    write_wav(&wav, &t.audio);
    let track = library
        .import_file(&wav, ImportOptions::default())
        .unwrap()
        .track()
        .clone();

    let counter = Arc::new(AtomicUsize::new(0));
    let settings = AnalysisSettings {
        poll_interval: Duration::from_millis(25),
        compute_stems: true,
        separator: Arc::new(Counting(BandSeparator, counter.clone())),
    };
    analyze_track_now(&library, &track, &settings).unwrap();
    assert_eq!(counter.load(Ordering::SeqCst), 1);
    assert_eq!(library.track(track.id).unwrap().analysis_status, "done");

    // Explicit re-run: BPM/key/grid recomputed, stem cache hit (identical
    // content -> identical stems, keyed by hash).
    library.requeue_analysis(track.id).unwrap();
    assert_eq!(library.track(track.id).unwrap().analysis_status, "queued");
    let track = library.track(track.id).unwrap();
    analyze_track_now(&library, &track, &settings).unwrap();
    assert_eq!(library.track(track.id).unwrap().analysis_status, "done");
    assert_eq!(counter.load(Ordering::SeqCst), 1, "re-run recomputed stems");
    assert!(library.track(track.id).unwrap().bpm.is_some());
}

#[test]
fn undecodable_file_is_marked_failed_and_does_not_wedge_the_queue() {
    let tmp = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::open(tmp.path()).unwrap());

    // A "wav" that isn't audio.
    let bad = tmp.path().join("bad.wav");
    std::fs::write(&bad, b"not really audio at all").unwrap();
    let bad_track = library
        .import_file(&bad, ImportOptions::default())
        .unwrap()
        .track()
        .clone();

    // A good track queued behind it.
    let t = synth_labeled_track(9, 44_100, 15.0);
    let wav = tmp.path().join("good.wav");
    write_wav(&wav, &t.audio);
    let good_track = library
        .import_file(&wav, ImportOptions::default())
        .unwrap()
        .track()
        .clone();

    let _worker = start_worker(
        library.clone(),
        AnalysisSettings {
            poll_interval: Duration::from_millis(25),
            compute_stems: false,
            ..Default::default()
        },
    );
    wait_for_status(&library, bad_track.id, "failed", Duration::from_secs(30));
    wait_for_status(&library, good_track.id, "done", Duration::from_secs(60));
}
