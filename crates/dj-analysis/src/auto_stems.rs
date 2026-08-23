//! Automatic stem separation: a background service that keeps the stem
//! cache filled so nobody has to ask for it.
//!
//! Stemming used to be a button on the Clip page. That put a multi-minute
//! wait between "I want the vocals out" and being able to do it, and it
//! forgot everything the moment the app quit. This service instead treats
//! stems as something the library simply *has*, eventually:
//!
//! - every track downloaded from a provider (YouTube) is separated;
//! - a scan at startup BACKFILLS history — tracks downloaded before this
//!   existed, and tracks whose separation was interrupted by a quit;
//! - the results live in the on-disk stem cache
//!   ([`stems_dir_for`](crate::stems::stems_dir_for)), so a restart picks
//!   up where it left off instead of redoing minutes of work.
//!
//! One separation runs at a time. Demucs saturates the CPU by itself, and
//! a backfill of a hundred tracks that spawned a hundred models would take
//! the machine down with it.
//!
//! Nothing here is fast, and nothing here is on the UI thread — the loop
//! owns its own thread and the work happens in [`StemJobs`], which spawns
//! one more per separation.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dj_library::Library;

use crate::stem_jobs::{StemJobState, StemJobs};

/// Which tracks the service separates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoStemScope {
    /// No automatic separation at all.
    Off,
    /// Only tracks acquired from a provider (`source` is neither "local"
    /// nor "watch") — the YouTube downloads the feature was asked for.
    Downloads,
    /// Every track in the library, provider downloads first.
    All,
}

impl AutoStemScope {
    fn wants(self, source: &str) -> bool {
        match self {
            AutoStemScope::Off => false,
            AutoStemScope::Downloads => is_download(source),
            AutoStemScope::All => true,
        }
    }
}

/// A track that came from a provider rather than the user's own disk.
/// Import records the provider id in `source` ("youtube"); local files and
/// watch folders use these two reserved names.
fn is_download(source: &str) -> bool {
    !matches!(source, "local" | "watch" | "")
}

/// Env override for [`AutoStemScope`]: `off`, `downloads`, or `all`.
pub const ENV_AUTOSTEM: &str = "DJ_AUTOSTEM";

pub struct AutoStemSettings {
    pub scope: AutoStemScope,
    /// How long to wait after finding nothing to do before looking again.
    pub poll_interval: Duration,
    /// How often to re-check for the separator's tooling once it is known
    /// to be missing (installing demucs shouldn't need a restart).
    pub probe_interval: Duration,
    /// Give up on a track after this many failed separations, so one
    /// broken file can't spin the loop forever.
    pub max_attempts: u32,
}

impl Default for AutoStemSettings {
    fn default() -> Self {
        AutoStemSettings {
            scope: AutoStemScope::All,
            poll_interval: Duration::from_secs(5),
            probe_interval: Duration::from_secs(60),
            max_attempts: 3,
        }
    }
}

impl AutoStemSettings {
    /// Defaults, with the scope taken from [`ENV_AUTOSTEM`]. An
    /// unrecognised value is reported and ignored rather than fatal —
    /// this is a background nicety, not a reason to refuse to start.
    pub fn from_env() -> Self {
        let raw = std::env::var(ENV_AUTOSTEM).unwrap_or_default();
        let scope = match raw.trim().to_ascii_lowercase().as_str() {
            "" => AutoStemScope::All,
            "off" | "none" | "0" => AutoStemScope::Off,
            "downloads" | "youtube" => AutoStemScope::Downloads,
            "all" => AutoStemScope::All,
            other => {
                eprintln!("[auto-stems] ignoring {ENV_AUTOSTEM}={other:?} (off|downloads|all)");
                AutoStemScope::All
            }
        };
        AutoStemSettings {
            scope,
            ..Default::default()
        }
    }
}

/// What the Clip page needs to know about one track's stems.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrackStems {
    /// Separated and on disk: the stem mixer can be used.
    Ready,
    /// Not yet, but it is coming. `stage` is the running job's stage when
    /// this is the track being worked on.
    Loading { stage: Option<String> },
    /// Tried and failed enough times to stop trying.
    Failed { detail: String },
    /// Nothing will produce these stems: the tooling is missing, or
    /// automatic separation is switched off for this track.
    Unavailable { detail: String },
}

#[derive(Debug, Clone, Default)]
struct Failure {
    attempts: u32,
    detail: String,
}

#[derive(Debug, Clone)]
struct Availability {
    ok: bool,
    detail: Option<String>,
}

struct Shared {
    /// Tracks somebody is waiting on, served before the backfill scan.
    wanted: Mutex<VecDeque<i64>>,
    failures: Mutex<HashMap<i64, Failure>>,
    availability: Mutex<Availability>,
    /// Track being separated right now, or -1.
    current: AtomicI64,
    /// Tracks still missing stems as of the last scan.
    pending: AtomicUsize,
}

/// Handle to the service thread; dropping it stops the loop and abandons
/// the separation in flight (rather than leaving a demucs behind).
pub struct AutoStemService {
    library: Arc<Library>,
    jobs: Arc<StemJobs>,
    shared: Arc<Shared>,
    scope: AutoStemScope,
    max_attempts: u32,
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

/// Service-wide snapshot (what the app can report about the whole queue).
#[derive(Debug, Clone, PartialEq)]
pub struct AutoStemStatus {
    pub enabled: bool,
    pub available: bool,
    pub detail: Option<String>,
    pub backend: String,
    /// Track being separated right now.
    pub current: Option<i64>,
    /// Tracks still missing stems as of the last scan.
    pub pending: usize,
}

impl AutoStemService {
    /// Start the loop over a shared library and job manager.
    pub fn start(library: Arc<Library>, jobs: Arc<StemJobs>, settings: AutoStemSettings) -> Self {
        let shared = Arc::new(Shared {
            wanted: Mutex::new(VecDeque::new()),
            failures: Mutex::new(HashMap::new()),
            availability: Mutex::new(Availability {
                ok: false,
                detail: None,
            }),
            current: AtomicI64::new(-1),
            pending: AtomicUsize::new(0),
        });
        let stop = Arc::new(AtomicBool::new(false));
        let scope = settings.scope;
        let max_attempts = settings.max_attempts;
        let join = (scope != AutoStemScope::Off).then(|| {
            let library = Arc::clone(&library);
            let jobs = Arc::clone(&jobs);
            let shared = Arc::clone(&shared);
            let stop = Arc::clone(&stop);
            std::thread::Builder::new()
                .name("dj-auto-stems".into())
                .spawn(move || run(&library, &jobs, &shared, &settings, &stop))
                .expect("spawning the auto-stem service")
        });
        AutoStemService {
            library,
            jobs,
            shared,
            scope,
            max_attempts,
            stop,
            join,
        }
    }

    /// Ask for `track_id` next. The backfill works newest-first through a
    /// whole library, so a track somebody is actually looking at would
    /// otherwise wait behind everything else.
    ///
    /// Idempotent: asking twice does not queue it twice.
    pub fn want(&self, track_id: i64) {
        if self.scope == AutoStemScope::Off || self.jobs.cached(track_id) {
            return;
        }
        let mut wanted = self.shared.wanted.lock().expect("auto-stem queue poisoned");
        if !wanted.contains(&track_id) {
            wanted.push_front(track_id);
        }
    }

    /// Where one track stands. This is what the Clip page renders, so it
    /// answers for tracks the service will never touch too.
    pub fn track_stems(&self, track_id: i64) -> TrackStems {
        if self.jobs.cached(track_id) {
            return TrackStems::Ready;
        }
        if self.scope == AutoStemScope::Off {
            return TrackStems::Unavailable {
                detail: format!("automatic stem separation is off ({ENV_AUTOSTEM}=off)"),
            };
        }
        // A track outside the scope is not "loading": nothing is coming
        // for it, and saying otherwise would leave the editor waiting on
        // a separation that will never be queued.
        let source = self.library.track(track_id).map(|t| t.source);
        if source.is_ok_and(|s| !self.scope.wants(&s)) {
            return TrackStems::Unavailable {
                detail: format!(
                    "automatic stem separation covers downloaded tracks ({ENV_AUTOSTEM}=downloads)"
                ),
            };
        }
        let failed = {
            let failures = self
                .shared
                .failures
                .lock()
                .expect("auto-stem state poisoned");
            failures.get(&track_id).cloned()
        };
        if let Some(f) = failed.filter(|f| f.attempts >= self.max_attempts) {
            return TrackStems::Failed { detail: f.detail };
        }
        let availability = self
            .shared
            .availability
            .lock()
            .expect("auto-stem state poisoned")
            .clone();
        if !availability.ok {
            if let Some(detail) = availability.detail {
                return TrackStems::Unavailable { detail };
            }
        }
        let stage = self
            .jobs
            .jobs()
            .into_iter()
            .filter(|j| j.track_id == track_id && j.is_running())
            .map(|j| j.stage)
            .next_back();
        TrackStems::Loading { stage }
    }

    pub fn status(&self) -> AutoStemStatus {
        let availability = self
            .shared
            .availability
            .lock()
            .expect("auto-stem state poisoned")
            .clone();
        let current = self.shared.current.load(Ordering::Relaxed);
        AutoStemStatus {
            enabled: self.scope != AutoStemScope::Off,
            available: availability.ok,
            detail: availability.detail,
            backend: self.jobs.backend().to_string(),
            current: (current >= 0).then_some(current),
            pending: self.shared.pending.load(Ordering::Relaxed),
        }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        let current = self.shared.current.load(Ordering::Relaxed);
        if current >= 0 {
            // Kill the model rather than orphan it: this is another
            // process holding a CPU, and it writes nothing until it
            // finishes anyway.
            self.jobs.cancel_track(current);
        }
    }
}

impl Drop for AutoStemService {
    fn drop(&mut self) {
        self.stop();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

fn run(
    library: &Library,
    jobs: &StemJobs,
    shared: &Shared,
    settings: &AutoStemSettings,
    stop: &AtomicBool,
) {
    // Tracks known to have stems already: a library scan is a handful of
    // stat calls per track, and the answer for a finished track never
    // changes while we run.
    let mut done: HashSet<i64> = HashSet::new();
    let mut probed: Option<Instant> = None;

    while !stop.load(Ordering::Relaxed) {
        let Some(track_id) = next_track(library, jobs, shared, settings, &mut done) else {
            nap(settings.poll_interval, stop);
            continue;
        };
        if !probe_ok(jobs, shared, settings, &mut probed) {
            nap(settings.poll_interval, stop);
            continue;
        }
        separate(jobs, shared, settings, stop, track_id, &mut done);
    }
}

/// One track's place in the queue, as the ordering policy sees it.
pub struct Candidate {
    pub track_id: i64,
    /// `source` from the library row ("youtube", "local", "watch", ...).
    pub source: String,
}

/// The ordering policy, pure so it can be tested without a library, a
/// model or a thread: whatever somebody is waiting on first, then the
/// backfill — provider downloads before the rest, newest first within
/// each (the caller passes tracks newest-first).
///
/// Downloads come first because they are what the feature was asked for:
/// a track that arrived from YouTube a minute ago is far likelier to be
/// the one about to be opened than a local file that has sat there for a
/// year. Returns the pick and how many tracks still need stems.
pub fn next_in_line(
    wanted: &[i64],
    tracks: &[Candidate],
    scope: AutoStemScope,
    mut needs_stems: impl FnMut(i64) -> bool,
) -> (Option<i64>, usize) {
    let mut pending = 0usize;
    let mut first_download = None;
    let mut first_any = None;
    for track in tracks {
        if !scope.wants(&track.source) || !needs_stems(track.track_id) {
            continue;
        }
        pending += 1;
        if first_any.is_none() {
            first_any = Some(track.track_id);
        }
        if first_download.is_none() && is_download(&track.source) {
            first_download = Some(track.track_id);
        }
    }
    let asked_for = wanted.iter().copied().find(|id| needs_stems(*id));
    (asked_for.or(first_download).or(first_any), pending)
}

/// The next track needing stems, and the queue length behind it.
fn next_track(
    library: &Library,
    jobs: &StemJobs,
    shared: &Shared,
    settings: &AutoStemSettings,
    done: &mut HashSet<i64>,
) -> Option<i64> {
    // Requests stay queued until they no longer need doing, so a second
    // one behind the pick is not forgotten.
    let wanted: Vec<i64> = {
        let mut queue = shared.wanted.lock().expect("auto-stem queue poisoned");
        queue.retain(|id| needs_stems(jobs, shared, settings, done, *id));
        queue.iter().copied().collect()
    };
    let tracks: Vec<Candidate> = match library.tracks() {
        Ok(tracks) => tracks
            .into_iter()
            .map(|t| Candidate {
                track_id: t.id,
                source: t.source,
            })
            .collect(),
        Err(e) => {
            eprintln!("[auto-stems] reading the library failed: {e:#}");
            return None;
        }
    };
    let (pick, pending) = next_in_line(&wanted, &tracks, settings.scope, |id| {
        needs_stems(jobs, shared, settings, done, id)
    });
    shared.pending.store(pending, Ordering::Relaxed);
    pick
}

fn needs_stems(
    jobs: &StemJobs,
    shared: &Shared,
    settings: &AutoStemSettings,
    done: &mut HashSet<i64>,
    track_id: i64,
) -> bool {
    if done.contains(&track_id) {
        return false;
    }
    if jobs.cached(track_id) {
        done.insert(track_id);
        return false;
    }
    let failures = shared.failures.lock().expect("auto-stem state poisoned");
    failures
        .get(&track_id)
        .is_none_or(|f| f.attempts < settings.max_attempts)
}

/// Is the separator's tooling installed? Probing spawns the tool, so the
/// answer is cached and only re-checked every `probe_interval` — but only
/// ever when there is work, so an idle app never shells out at all.
fn probe_ok(
    jobs: &StemJobs,
    shared: &Shared,
    settings: &AutoStemSettings,
    probed: &mut Option<Instant>,
) -> bool {
    let known = shared
        .availability
        .lock()
        .expect("auto-stem state poisoned")
        .clone();
    let fresh = probed.is_some_and(|t| t.elapsed() < settings.probe_interval);
    if known.ok && fresh {
        return true;
    }
    if !known.ok && fresh && known.detail.is_some() {
        return false;
    }
    let result = jobs.probe();
    *probed = Some(Instant::now());
    let availability = match &result {
        Ok(()) => Availability {
            ok: true,
            detail: None,
        },
        Err(e) => {
            let detail = format!("{e:#}");
            if known.detail.as_deref() != Some(detail.as_str()) {
                eprintln!("[auto-stems] separation unavailable: {detail}");
            }
            Availability {
                ok: false,
                detail: Some(detail),
            }
        }
    };
    let ok = availability.ok;
    *shared
        .availability
        .lock()
        .expect("auto-stem state poisoned") = availability;
    ok
}

/// Run one separation to completion, recording what happened.
fn separate(
    jobs: &StemJobs,
    shared: &Shared,
    settings: &AutoStemSettings,
    stop: &AtomicBool,
    track_id: i64,
    done: &mut HashSet<i64>,
) {
    shared.current.store(track_id, Ordering::Relaxed);
    let id = jobs.start(track_id);
    let outcome = loop {
        let job = jobs.jobs().into_iter().find(|j| j.id == id);
        match job {
            Some(job) if !job.is_running() => break Some(job),
            // Pruned out of the snapshot before we looked: the only way
            // that happens is a finished job, and the cache below is the
            // real answer anyway.
            None => break None,
            Some(_) => {
                if stop.load(Ordering::Relaxed) {
                    jobs.cancel_track(track_id);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    };
    shared.current.store(-1, Ordering::Relaxed);

    match outcome.map(|j| (j.state, j.error)) {
        Some((StemJobState::Failed, error)) => {
            let detail = error.unwrap_or_else(|| "stem separation failed".into());
            let mut failures = shared.failures.lock().expect("auto-stem state poisoned");
            let entry = failures.entry(track_id).or_default();
            entry.attempts += 1;
            entry.detail = detail.clone();
            if entry.attempts >= settings.max_attempts {
                eprintln!(
                    "[auto-stems] giving up on track {track_id} after {} attempts: {detail}",
                    entry.attempts
                );
            }
        }
        _ => {
            if jobs.cached(track_id) {
                done.insert(track_id);
                shared
                    .failures
                    .lock()
                    .expect("auto-stem state poisoned")
                    .remove(&track_id);
            }
        }
    }
}

/// Sleep in slices so stopping stays responsive.
fn nap(total: Duration, stop: &AtomicBool) {
    let mut left = total;
    while !stop.load(Ordering::Relaxed) && left > Duration::ZERO {
        let slice = left.min(Duration::from_millis(50));
        std::thread::sleep(slice);
        left = left.saturating_sub(slice);
    }
}
