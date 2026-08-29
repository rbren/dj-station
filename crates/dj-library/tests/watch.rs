//! Watch-folder auto-import (M1 acceptance: a file copied into the watch
//! folder is imported and appears in the library DB within seconds).

mod common;

use dj_library::{start_watcher, Library};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn wait_for_tracks(lib: &Library, n: usize, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if lib.tracks().unwrap().len() >= n {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn file_copied_into_watch_folder_is_imported_within_seconds() {
    let tmp = tempfile::tempdir().unwrap();
    let watched = tmp.path().join("watched");
    std::fs::create_dir_all(&watched).unwrap();
    let lib = Arc::new(Library::open(&tmp.path().join("data")).unwrap());
    lib.add_watch_folder(&watched).unwrap();

    let _watcher = start_watcher(lib.clone(), Duration::from_millis(100));

    // "Copy" a new audio file into the watch folder while watching.
    let staged = tmp.path().join("new-track.wav");
    common::write_test_wav(&staged, 440.0, 0.5);
    std::fs::copy(&staged, watched.join("new-track.wav")).unwrap();

    assert!(
        wait_for_tracks(&lib, 1, Duration::from_secs(5)),
        "file was not imported within 5 seconds"
    );
    let track = &lib.tracks().unwrap()[0];
    assert_eq!(track.title, "new-track");
    assert_eq!(track.source, "watch");
    assert_eq!(
        track.analysis_status, "queued",
        "queued for future analysis"
    );
}

#[test]
fn watcher_imports_from_subfolders_and_skips_non_audio_and_duplicates() {
    let tmp = tempfile::tempdir().unwrap();
    let watched = tmp.path().join("watched");
    let sub = watched.join("nested/deeper");
    std::fs::create_dir_all(&sub).unwrap();
    let lib = Arc::new(Library::open(&tmp.path().join("data")).unwrap());
    lib.add_watch_folder(&watched).unwrap();

    let _watcher = start_watcher(lib.clone(), Duration::from_millis(100));

    common::write_test_wav(&sub.join("deep.wav"), 550.0, 0.5);
    std::fs::write(watched.join("notes.txt"), "not audio").unwrap();
    assert!(wait_for_tracks(&lib, 1, Duration::from_secs(5)));

    // A byte-identical copy under a different name is not imported twice.
    std::fs::copy(sub.join("deep.wav"), watched.join("copy.wav")).unwrap();
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(lib.tracks().unwrap().len(), 1, "duplicate content imported");

    // Different content is picked up.
    common::write_test_wav(&watched.join("другой.aiff"), 660.0, 0.5);
    // .aiff extension counts as audio even though the body is a wav; the
    // probe is best-effort and the import must still land.
    assert!(wait_for_tracks(&lib, 2, Duration::from_secs(5)));
}

#[test]
fn watch_folder_added_at_runtime_is_picked_up() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = Arc::new(Library::open(&tmp.path().join("data")).unwrap());
    let _watcher = start_watcher(lib.clone(), Duration::from_millis(100));

    let late = tmp.path().join("late-folder");
    std::fs::create_dir_all(&late).unwrap();
    common::write_test_wav(&late.join("late.wav"), 330.0, 0.5);
    lib.add_watch_folder(&late).unwrap(); // added after the watcher started

    assert!(wait_for_tracks(&lib, 1, Duration::from_secs(5)));
    assert_eq!(lib.tracks().unwrap()[0].title, "late");
}

#[test]
fn a_deleted_track_is_not_re_imported_by_the_watcher() {
    let tmp = tempfile::tempdir().unwrap();
    let watched = tmp.path().join("watched");
    std::fs::create_dir_all(&watched).unwrap();
    let data_dir = tmp.path().join("data");
    let lib = Arc::new(Library::open(&data_dir).unwrap());
    lib.add_watch_folder(&watched).unwrap();
    common::write_test_wav(&watched.join("unwanted.wav"), 440.0, 0.5);

    {
        let _watcher = start_watcher(lib.clone(), Duration::from_millis(100));
        assert!(wait_for_tracks(&lib, 1, Duration::from_secs(5)));
        // Deleting keeps the user's file where it is, so only the
        // remembered deletion stops the folder handing it straight back.
        let id = lib.tracks().unwrap()[0].id;
        lib.delete_track(id).unwrap();
    }

    // A restart re-reads the folder from scratch: the file is still there
    // and still must not come back.
    let _watcher = start_watcher(lib.clone(), Duration::from_millis(100));
    std::thread::sleep(Duration::from_millis(800));
    assert!(
        lib.tracks().unwrap().is_empty(),
        "deleted track was re-imported"
    );
}
