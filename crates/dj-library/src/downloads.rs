//! Background acquisition jobs: a provider download runs on its own
//! thread and reports progress into a snapshot the UI polls (the same
//! shape as the analysis queue — no event plumbing needed).
//!
//! Every provider download goes through here, because the slow ones
//! (yt-dlp fetching a 10-minute video) must never block the shell's main
//! thread.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::db::Library;
use crate::providers::{AcquisitionHub, FetchProgress, TrackResult};

/// Finished jobs kept in the snapshot so the UI can report the outcome
/// even if it polls a little late.
const KEEP_FINISHED: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadState {
    Running,
    Done,
    Failed,
}

/// One acquisition in flight (or recently finished).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DownloadJob {
    pub id: u64,
    pub provider: String,
    /// Provider-side result id, so the UI can match a job to its row.
    pub result_id: String,
    pub title: String,
    pub state: DownloadState,
    /// Completed fraction (0..1) when known.
    pub fraction: Option<f64>,
    pub stage: String,
    pub error: Option<String>,
    /// Library track id once the download imported successfully.
    pub track_id: Option<i64>,
}

impl DownloadJob {
    pub fn is_running(&self) -> bool {
        self.state == DownloadState::Running
    }
}

pub struct DownloadManager {
    library: Arc<Library>,
    hub: Arc<AcquisitionHub>,
    jobs: Arc<Mutex<Vec<DownloadJob>>>,
    next_id: AtomicU64,
}

impl DownloadManager {
    pub fn new(library: Arc<Library>, hub: Arc<AcquisitionHub>) -> Self {
        DownloadManager {
            library,
            hub,
            jobs: Arc::new(Mutex::new(Vec::new())),
            next_id: AtomicU64::new(1),
        }
    }

    /// Start downloading `result` in the background and return the job id.
    /// A result already downloading returns its existing job (double
    /// clicks never fetch twice).
    pub fn start(&self, result: TrackResult) -> u64 {
        let mut jobs = self.jobs.lock().expect("download jobs poisoned");
        if let Some(existing) = jobs
            .iter()
            .find(|j| j.is_running() && j.provider == result.provider && j.result_id == result.id)
        {
            return existing.id;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        jobs.push(DownloadJob {
            id,
            provider: result.provider.clone(),
            result_id: result.id.clone(),
            title: result.title.clone(),
            state: DownloadState::Running,
            fraction: None,
            stage: "queued".into(),
            error: None,
            track_id: None,
        });
        prune(&mut jobs);
        drop(jobs);

        let library = Arc::clone(&self.library);
        let hub = Arc::clone(&self.hub);
        let jobs = Arc::clone(&self.jobs);
        std::thread::spawn(move || {
            let outcome = {
                let jobs = Arc::clone(&jobs);
                hub.download_to_library_with_progress(&library, &result, &mut |p: FetchProgress| {
                    update(&jobs, id, |job| {
                        job.fraction = p.fraction;
                        job.stage = p.stage.clone();
                    });
                })
            };
            update(&jobs, id, |job| match &outcome {
                Ok(track) => {
                    job.state = DownloadState::Done;
                    job.fraction = Some(1.0);
                    job.stage = "done".into();
                    job.title = track.title.clone();
                    job.track_id = Some(track.id);
                }
                Err(e) => {
                    job.state = DownloadState::Failed;
                    job.stage = "failed".into();
                    job.error = Some(format!("{e:#}"));
                    // The job snapshot only reaches the UI banner; the
                    // failure belongs in the log too (with the cause chain).
                    eprintln!("[dj-library] download failed ({}): {e:#}", job.title);
                }
            });
        });
        id
    }

    /// Snapshot of all known jobs, oldest first.
    pub fn jobs(&self) -> Vec<DownloadJob> {
        self.jobs.lock().expect("download jobs poisoned").clone()
    }
}

fn update(jobs: &Mutex<Vec<DownloadJob>>, id: u64, f: impl FnOnce(&mut DownloadJob)) {
    let mut jobs = jobs.lock().expect("download jobs poisoned");
    if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
        f(job);
    }
}

fn prune(jobs: &mut Vec<DownloadJob>) {
    let finished = jobs.iter().filter(|j| !j.is_running()).count();
    if finished <= KEEP_FINISHED {
        return;
    }
    let mut drop_count = finished - KEEP_FINISHED;
    jobs.retain(|j| {
        if j.is_running() || drop_count == 0 {
            return true;
        }
        drop_count -= 1;
        false
    });
}
