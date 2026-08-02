//! Watch-folder auto-import (PRD §8.1): a polling scanner (consistent with
//! the engine's hot-reload watcher — no extra native deps) that imports new
//! audio files and queues them for analysis.
//!
//! A file is imported once its size+mtime are stable across two consecutive
//! scans, so half-copied files are not hashed mid-write. With the default
//! poll interval a new file lands in the DB well within seconds.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use crate::db::Library;
use crate::import::{is_audio_file, ImportOptions};

pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(250);
const MAX_DEPTH: usize = 8;

pub struct WatchHandle {
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl WatchHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.stop();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

#[derive(PartialEq, Eq, Hash, Clone, Copy)]
struct FileStamp {
    size: u64,
    mtime: Option<SystemTime>,
}

fn stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some(FileStamp {
        size: meta.len(),
        mtime: meta.modified().ok(),
    })
}

fn scan_dir(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_dir(&path, depth + 1, out);
        } else if is_audio_file(&path) {
            out.push(path);
        }
    }
}

/// Start the watch-folder scanner. Folders are read from the library DB on
/// every pass, so `add_watch_folder` takes effect without a restart.
pub fn start_watcher(library: Arc<Library>, poll_interval: Duration) -> WatchHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let join = std::thread::Builder::new()
        .name("dj-watch-folders".into())
        .spawn(move || {
            // Paths already in the DB (or verified duplicates) — skip them
            // without re-hashing every scan.
            let mut known: HashSet<PathBuf> = library
                .tracks()
                .map(|ts| ts.iter().map(|t| PathBuf::from(&t.file_path)).collect())
                .unwrap_or_default();
            // Files seen but not yet stable: path -> last observed stamp.
            let mut pending: HashMap<PathBuf, FileStamp> = HashMap::new();

            while !stop2.load(Ordering::Relaxed) {
                let folders = library.watch_folders().unwrap_or_default();
                let mut files = Vec::new();
                for folder in &folders {
                    scan_dir(folder, 0, &mut files);
                }
                for path in files {
                    let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
                    if known.contains(&canonical) {
                        continue;
                    }
                    let Some(now) = stamp(&path) else { continue };
                    match pending.get(&canonical) {
                        Some(prev) if *prev == now => {
                            // Stable across two scans: import.
                            pending.remove(&canonical);
                            let opts = ImportOptions {
                                source: "watch".into(),
                                ..ImportOptions::default()
                            };
                            match library.import_file(&path, opts) {
                                Ok(_) => {
                                    known.insert(canonical);
                                }
                                Err(e) => {
                                    eprintln!("watch import failed for {}: {e:#}", path.display());
                                    // Don't retry a broken file forever.
                                    known.insert(canonical);
                                }
                            }
                        }
                        _ => {
                            pending.insert(canonical, now);
                        }
                    }
                }
                std::thread::sleep(poll_interval);
            }
        })
        .expect("failed to spawn watch-folder thread");
    WatchHandle {
        stop,
        join: Some(join),
    }
}
