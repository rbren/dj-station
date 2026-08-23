//! Background stem-separation jobs: the same shape as the library's
//! download jobs (thread per job, progress into a snapshot the UI polls —
//! no event plumbing).
//!
//! Separation is the slowest thing the app does: `htdemucs_ft` is a bag of
//! four models and runs for minutes on CPU. It must never block the UI
//! thread, and it is nowhere near the RT thread.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use dj_library::db::Library;

use crate::decode::decode_audio;
use crate::stems::{ensure_stems, stems_cached, stems_dir_for, StemSeparator};

/// Finished jobs kept in the snapshot so the UI can report the outcome
/// even if it polls a little late.
const KEEP_FINISHED: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StemJobState {
    Running,
    Done,
    Failed,
}

/// One separation in flight (or recently finished).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StemJob {
    pub id: u64,
    pub track_id: i64,
    /// Separator id (= model name for demucs), so the UI can tell which
    /// backend produced a result.
    pub backend: String,
    pub title: String,
    pub state: StemJobState,
    pub stage: String,
    pub error: Option<String>,
}

impl StemJob {
    pub fn is_running(&self) -> bool {
        self.state == StemJobState::Running
    }
}

/// Runs [`StemSeparator`] work off the UI thread, one job per track.
pub struct StemJobs {
    library: Arc<Library>,
    separator: Arc<dyn StemSeparator>,
    jobs: Arc<Mutex<Vec<StemJob>>>,
    next_id: AtomicU64,
}

impl StemJobs {
    pub fn new(library: Arc<Library>, separator: Arc<dyn StemSeparator>) -> Self {
        StemJobs {
            library,
            separator,
            jobs: Arc::new(Mutex::new(Vec::new())),
            next_id: AtomicU64::new(1),
        }
    }

    /// The backend these jobs run on.
    pub fn backend(&self) -> &str {
        self.separator.id()
    }

    /// Are this track's stems already on disk for our backend?
    pub fn cached(&self, track_id: i64) -> bool {
        match self.library.track(track_id) {
            Ok(track) => stems_cached(&self.dir(&track.content_hash)),
            Err(_) => false,
        }
    }

    /// Cached stem files for `track_id`, or `None` when not separated yet.
    pub fn cached_paths(
        &self,
        track_id: i64,
    ) -> Option<[std::path::PathBuf; crate::stems::N_STEMS]> {
        let track = self.library.track(track_id).ok()?;
        let dir = self.dir(&track.content_hash);
        stems_cached(&dir).then(|| crate::stems::stem_paths(&dir))
    }

    fn dir(&self, content_hash: &str) -> std::path::PathBuf {
        stems_dir_for(self.library.data_dir(), content_hash, self.separator.id())
    }

    /// Separate `track_id` in the background, returning the job id. A
    /// track already separating returns its existing job, so double
    /// clicks never start the same multi-minute run twice.
    pub fn start(&self, track_id: i64) -> u64 {
        let mut jobs = self.jobs.lock().expect("stem jobs poisoned");
        if let Some(existing) = jobs
            .iter()
            .find(|j| j.is_running() && j.track_id == track_id)
        {
            return existing.id;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let title = self
            .library
            .track(track_id)
            .map(|t| t.title)
            .unwrap_or_default();
        jobs.push(StemJob {
            id,
            track_id,
            backend: self.separator.id().to_string(),
            title,
            state: StemJobState::Running,
            stage: "queued".into(),
            error: None,
        });
        prune(&mut jobs);
        drop(jobs);

        let library = Arc::clone(&self.library);
        let separator = Arc::clone(&self.separator);
        let jobs = Arc::clone(&self.jobs);
        std::thread::spawn(move || {
            let outcome = separate(&library, separator.as_ref(), track_id, &jobs, id);
            update(&jobs, id, |job| match &outcome {
                Ok(()) => {
                    job.state = StemJobState::Done;
                    job.stage = "done".into();
                }
                Err(e) => {
                    job.state = StemJobState::Failed;
                    job.stage = "failed".into();
                    job.error = Some(format!("{e:#}"));
                }
            });
        });
        id
    }

    /// Snapshot of all known jobs, oldest first.
    pub fn jobs(&self) -> Vec<StemJob> {
        self.jobs.lock().expect("stem jobs poisoned").clone()
    }
}

fn separate(
    library: &Library,
    separator: &dyn StemSeparator,
    track_id: i64,
    jobs: &Mutex<Vec<StemJob>>,
    id: u64,
) -> anyhow::Result<()> {
    let track = library.track(track_id)?;
    let dir = stems_dir_for(library.data_dir(), &track.content_hash, separator.id());
    if stems_cached(&dir) {
        return Ok(());
    }
    update(jobs, id, |job| job.stage = "decoding".into());
    let audio = decode_audio(std::path::Path::new(&track.file_path))?;
    update(jobs, id, |job| job.stage = "separating".into());
    ensure_stems(&dir, &audio, separator)?;
    Ok(())
}

fn update(jobs: &Mutex<Vec<StemJob>>, id: u64, f: impl FnOnce(&mut StemJob)) {
    let mut jobs = jobs.lock().expect("stem jobs poisoned");
    if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
        f(job);
    }
}

fn prune(jobs: &mut Vec<StemJob>) {
    let finished = jobs.iter().filter(|j| !j.is_running()).count();
    if finished > KEEP_FINISHED {
        let mut drop_n = finished - KEEP_FINISHED;
        jobs.retain(|j| {
            if !j.is_running() && drop_n > 0 {
                drop_n -= 1;
                false
            } else {
                true
            }
        });
    }
}
