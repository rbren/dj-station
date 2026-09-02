//! Background stem-separation jobs: the same shape as the library's
//! download jobs (thread per job, progress into a snapshot the UI polls —
//! no event plumbing).
//!
//! Separation is the slowest thing the app does: SCNet XL IHF runs for
//! minutes on CPU. It must never block the UI thread, and it is nowhere
//! near the RT thread.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use dj_library::db::Library;

use crate::decode::decode_audio;
use crate::stems::{
    cached_stems_for, ensure_stems_cancellable, stems_dir_for, CachedStems, CancelToken,
    StemSeparator,
};

/// Finished jobs kept in the snapshot so the UI can report the outcome
/// even if it polls a little late.
const KEEP_FINISHED: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StemJobState {
    Running,
    Done,
    Failed,
    /// Abandoned on request. Nothing was cached, so the track is exactly
    /// as it was before the job started and can be separated again.
    Cancelled,
}

/// One separation in flight (or recently finished).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StemJob {
    pub id: u64,
    pub track_id: i64,
    /// Separator id (= the model name), so the UI can tell which backend
    /// produced a result.
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
    /// Stop signals for the jobs still running, by job id.
    cancels: Arc<Mutex<HashMap<u64, Arc<CancelToken>>>>,
    next_id: AtomicU64,
}

impl StemJobs {
    pub fn new(library: Arc<Library>, separator: Arc<dyn StemSeparator>) -> Self {
        StemJobs {
            library,
            separator,
            jobs: Arc::new(Mutex::new(Vec::new())),
            cancels: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
        }
    }

    /// The backend these jobs run on.
    pub fn backend(&self) -> &str {
        self.separator.id()
    }

    /// Can the backend run on this machine? `Err` carries an install
    /// hint — a missing external tool is a reported state, never a panic.
    pub fn probe(&self) -> anyhow::Result<()> {
        self.separator.probe()
    }

    /// Are this track's stems already on disk (ours, or an earlier
    /// model's — see [`cached_stems_for`])?
    pub fn cached(&self, track_id: i64) -> bool {
        match self.library.track(track_id) {
            Ok(track) => self.cached_content(&track.content_hash),
            Err(_) => false,
        }
    }

    /// The same answer for a content hash already in hand — a caller
    /// walking the whole library needs no second row lookup per track.
    pub fn cached_content(&self, content_hash: &str) -> bool {
        self.cache(content_hash).is_some()
    }

    /// The cached stems for a content hash, with the model that made
    /// them: the app reports that per track, because it is not
    /// necessarily the model it would use today.
    pub fn cache(&self, content_hash: &str) -> Option<CachedStems> {
        cached_stems_for(self.library.data_dir(), content_hash, self.separator.id())
    }

    /// Cached stem files for `track_id`, or `None` when not separated yet.
    pub fn cached_paths(
        &self,
        track_id: i64,
    ) -> Option<[std::path::PathBuf; crate::stems::N_STEMS]> {
        let track = self.library.track(track_id).ok()?;
        let cached = self.cache(&track.content_hash)?;
        Some(crate::stems::stem_paths(&cached.dir))
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

        let cancel = Arc::new(CancelToken::new());
        self.cancels
            .lock()
            .expect("stem cancels poisoned")
            .insert(id, Arc::clone(&cancel));

        let library = Arc::clone(&self.library);
        let separator = Arc::clone(&self.separator);
        let jobs = Arc::clone(&self.jobs);
        let cancels = Arc::clone(&self.cancels);
        std::thread::spawn(move || {
            let outcome = separate(&library, separator.as_ref(), track_id, &jobs, id, &cancel);
            cancels.lock().expect("stem cancels poisoned").remove(&id);
            update(&jobs, id, |job| {
                // A killed run usually also reports an error (a model
                // that was shot mid-inference, say). The cancel is the real
                // story, so it wins.
                if cancel.is_cancelled() {
                    job.state = StemJobState::Cancelled;
                    job.stage = "cancelled".into();
                    return;
                }
                match &outcome {
                    Ok(()) => {
                        job.state = StemJobState::Done;
                        job.stage = "done".into();
                    }
                    Err(e) => {
                        job.state = StemJobState::Failed;
                        job.stage = "failed".into();
                        job.error = Some(format!("{e:#}"));
                    }
                }
            });
        });
        id
    }

    /// Abandon the running job for `track_id`, killing the work in
    /// progress. Returns whether there was one to stop.
    ///
    /// The job thread finishes the cancel itself: this only fires the
    /// signal, so a separator that is between checkpoints (or a child
    /// process that takes a moment to die) still lands in a consistent
    /// state rather than being torn out from under.
    pub fn cancel_track(&self, track_id: i64) -> bool {
        let ids: Vec<u64> = self
            .jobs
            .lock()
            .expect("stem jobs poisoned")
            .iter()
            .filter(|j| j.is_running() && j.track_id == track_id)
            .map(|j| j.id)
            .collect();
        let cancels = self.cancels.lock().expect("stem cancels poisoned");
        let mut stopped = false;
        for id in ids {
            if let Some(token) = cancels.get(&id) {
                token.cancel();
                stopped = true;
            }
        }
        stopped
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
    cancel: &CancelToken,
) -> anyhow::Result<()> {
    let track = library.track(track_id)?;
    // Stems from an earlier model count: a model switch leaves what is
    // already separated alone.
    if cached_stems_for(library.data_dir(), &track.content_hash, separator.id()).is_some() {
        return Ok(());
    }
    let dir = stems_dir_for(library.data_dir(), &track.content_hash, separator.id());
    update(jobs, id, |job| job.stage = "decoding".into());
    let audio = decode_audio(std::path::Path::new(&track.file_path))?;
    if cancel.is_cancelled() {
        return Ok(());
    }
    update(jobs, id, |job| job.stage = "separating".into());
    ensure_stems_cancellable(&dir, &audio, separator, cancel)?;
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
