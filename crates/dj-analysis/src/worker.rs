//! Background analysis worker (PRD §8.2): drains the library's analysis
//! queue on a dedicated thread. Importing a track (watch folder, drag &
//! drop, provider download) marks it `queued`; the worker picks it up and
//! BPM / key / auto-beatgrid / stems land in the library DB and stem cache
//! with no user action.
//!
//! Caching: results are keyed by content hash. Re-importing an identical
//! file dedupes at import (`ImportOutcome::Duplicate` — the track is never
//! re-queued), and the stem cache under `<data_dir>/stems/<hash>/` is
//! compute-if-missing, so a re-run of BPM/key never recomputes stems that
//! already exist for that content.

use anyhow::Result;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dj_library::{Library, Track};

use crate::decode::decode_audio;
use crate::stems::{ensure_stems, stems_dir, BandSeparator, StemSeparator};

pub struct AnalysisSettings {
    pub poll_interval: Duration,
    /// Compute (and cache) stems as part of analysis.
    pub compute_stems: bool,
    pub separator: Arc<dyn StemSeparator>,
}

impl Default for AnalysisSettings {
    fn default() -> Self {
        AnalysisSettings {
            poll_interval: Duration::from_millis(500),
            compute_stems: true,
            separator: Arc::new(BandSeparator),
        }
    }
}

/// Handle to the worker thread; dropping it stops the worker.
pub struct AnalysisWorker {
    stop: Arc<AtomicBool>,
    current: Arc<Mutex<Option<i64>>>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl AnalysisWorker {
    /// Track id currently being analyzed, if any.
    pub fn current_track(&self) -> Option<i64> {
        *self.current.lock().unwrap()
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for AnalysisWorker {
    fn drop(&mut self) {
        self.stop();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

/// Start the background worker over a shared library handle.
pub fn start_worker(library: Arc<Library>, settings: AnalysisSettings) -> AnalysisWorker {
    let stop = Arc::new(AtomicBool::new(false));
    let current = Arc::new(Mutex::new(None));
    let stop2 = stop.clone();
    let current2 = current.clone();
    let join = std::thread::Builder::new()
        .name("dj-analysis".into())
        .spawn(move || worker_loop(&library, &settings, &stop2, &current2))
        .expect("spawning analysis worker");
    AnalysisWorker {
        stop,
        current,
        join: Some(join),
    }
}

fn worker_loop(
    library: &Library,
    settings: &AnalysisSettings,
    stop: &AtomicBool,
    current: &Mutex<Option<i64>>,
) {
    while !stop.load(Ordering::Relaxed) {
        let next = library
            .analysis_queue()
            .ok()
            .and_then(|q| q.into_iter().next());
        match next {
            Some(track) => {
                *current.lock().unwrap() = Some(track.id);
                if let Err(e) = analyze_track_now(library, &track, settings) {
                    eprintln!("[dj-analysis] track {} failed: {e:#}", track.id);
                    let _ = library.set_analysis_status(track.id, "failed");
                }
                *current.lock().unwrap() = None;
            }
            None => {
                // Sleep in short slices so stop() stays responsive.
                let mut left = settings.poll_interval;
                while !stop.load(Ordering::Relaxed) && left > Duration::ZERO {
                    let slice = left.min(Duration::from_millis(50));
                    std::thread::sleep(slice);
                    left = left.saturating_sub(slice);
                }
            }
        }
    }
}

/// Run the full analysis for one track synchronously (the worker calls
/// this; tests and the IPC layer can too). Writes BPM/key, upserts the
/// auto-beatgrid, ensures the stem cache, and sets `analysis_status`.
pub fn analyze_track_now(
    library: &Library,
    track: &Track,
    settings: &AnalysisSettings,
) -> Result<()> {
    library.set_analysis_status(track.id, "analyzing")?;
    let audio = decode_audio(Path::new(&track.file_path))?;
    let result = crate::analyze_audio(&audio)?;
    library.set_track_analysis(track.id, result.bpm, &result.key)?;
    library.set_track_beatgrid(track.id, result.bpm, result.anchor_secs)?;
    if settings.compute_stems {
        let dir = stems_dir(library.data_dir(), &track.content_hash);
        ensure_stems(&dir, &audio, settings.separator.as_ref())?;
    }
    library.set_analysis_status(track.id, "done")?;
    Ok(())
}
