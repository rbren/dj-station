//! Library DB tests: import, dedup, search, tags/crates, and persistence
//! across a "restart" (M1 acceptance: library and licenses persist when the
//! DB is reopened).

mod common;

use dj_library::{ImportOptions, ImportOutcome, Library, LicenseInfo};

#[test]
fn import_probes_metadata_and_queues_analysis() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = Library::open(&tmp.path().join("data")).unwrap();
    let wav = tmp.path().join("My Loop.wav");
    common::write_test_wav(&wav, 220.0, 1.0);

    let outcome = lib.import_file(&wav, ImportOptions::default()).unwrap();
    let track = match outcome {
        ImportOutcome::Added(t) => t,
        other => panic!("expected Added, got {other:?}"),
    };
    assert_eq!(track.title, "My Loop"); // filename fallback
    assert_eq!(track.format, "wav");
    assert_eq!(track.sample_rate, Some(8_000));
    assert_eq!(track.channels, Some(1));
    assert!((track.duration_secs.unwrap() - 1.0).abs() < 0.05);
    assert_eq!(track.source, "local");
    assert_eq!(track.analysis_status, "queued");
    assert_eq!(track.license.kind, "unknown");
    assert_eq!(lib.analysis_queue().unwrap().len(), 1);
}

#[test]
fn import_takes_the_artist_credit_out_of_the_title() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = Library::open(&tmp.path().join("data")).unwrap();

    // A download hands over the provider's title verbatim.
    let downloaded = tmp.path().join("boys.wav");
    common::write_test_wav(&downloaded, 220.0, 0.4);
    let track = lib
        .import_file(
            &downloaded,
            ImportOptions {
                title: Some("Lizzo - Boys (Official Video)".into()),
                artist: Some("Lizzo".into()),
                ..ImportOptions::default()
            },
        )
        .unwrap()
        .track()
        .clone();
    assert_eq!(track.title, "Boys");
    assert_eq!(track.artist, "Lizzo");

    // A file named the way a browser names one, with the artist known.
    let named = tmp.path().join("Lizzo - Juice.wav");
    common::write_test_wav(&named, 330.0, 0.4);
    let track = lib
        .import_file(
            &named,
            ImportOptions {
                artist: Some("Lizzo".into()),
                ..ImportOptions::default()
            },
        )
        .unwrap()
        .track()
        .clone();
    assert_eq!(track.title, "Juice");

    // No artist to match: the title is left exactly as it was found.
    let anon = tmp.path().join("Lizzo - Tempo.wav");
    common::write_test_wav(&anon, 440.0, 0.4);
    let track = lib
        .import_file(&anon, ImportOptions::default())
        .unwrap()
        .track()
        .clone();
    assert_eq!(track.title, "Lizzo - Tempo");
}

#[test]
fn a_track_can_be_renamed() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = Library::open(&tmp.path().join("data")).unwrap();
    let wav = tmp.path().join("take.wav");
    common::write_test_wav(&wav, 220.0, 0.4);
    let track = lib
        .import_file(&wav, ImportOptions::default())
        .unwrap()
        .track()
        .clone();

    let renamed = lib
        .set_track_names(track.id, "  Boys  ", " Lizzo ")
        .unwrap();
    assert_eq!(renamed.title, "Boys");
    assert_eq!(renamed.artist, "Lizzo");
    assert_eq!(lib.track(track.id).unwrap().title, "Boys");
    // The new name is what the library searches on.
    assert_eq!(lib.search("lizzo").unwrap().len(), 1);

    // An artist can be cleared; a title cannot.
    assert_eq!(
        lib.set_track_names(track.id, "Boys", "").unwrap().artist,
        ""
    );
    assert!(lib.set_track_names(track.id, "   ", "Lizzo").is_err());
    assert!(lib.set_track_names(track.id + 99, "Boys", "").is_err());
    assert_eq!(lib.track(track.id).unwrap().title, "Boys");
}

#[test]
fn changing_the_artist_re_tidies_the_title() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = Library::open(&tmp.path().join("data")).unwrap();
    let wav = tmp.path().join("take.wav");
    common::write_test_wav(&wav, 220.0, 0.4);
    let track = lib
        .import_file(
            &wav,
            ImportOptions {
                title: Some("Lizzo - Boys (Official Video)".into()),
                ..ImportOptions::default()
            },
        )
        .unwrap()
        .track()
        .clone();
    // Import strips the platform noise on its own, but no artist was
    // known, so the credit stayed in the title.
    assert_eq!(track.title, "Lizzo - Boys");

    // Correcting the artist re-runs the tidy: the credit goes.
    let renamed = lib
        .set_track_names(track.id, &track.title, "Lizzo")
        .unwrap();
    assert_eq!(renamed.title, "Boys");
    assert_eq!(renamed.artist, "Lizzo");

    // A title-only edit is the user's text, stored verbatim.
    let renamed = lib
        .set_track_names(track.id, "Lizzo - Boys (HQ)", "Lizzo")
        .unwrap();
    assert_eq!(renamed.title, "Lizzo - Boys (HQ)");
}

#[test]
fn identical_content_is_deduplicated_by_hash() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = Library::open(&tmp.path().join("data")).unwrap();
    let a = tmp.path().join("a.wav");
    common::write_test_wav(&a, 330.0, 0.5);
    let b = tmp.path().join("b.wav");
    std::fs::copy(&a, &b).unwrap();

    let first = lib.import_file(&a, ImportOptions::default()).unwrap();
    assert!(matches!(first, ImportOutcome::Added(_)));
    let second = lib.import_file(&b, ImportOptions::default()).unwrap();
    match second {
        ImportOutcome::Duplicate(t) => assert_eq!(t.id, first.track().id),
        other => panic!("expected Duplicate, got {other:?}"),
    }
    assert_eq!(lib.tracks().unwrap().len(), 1);
}

#[test]
fn search_matches_title_artist_and_tags() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = Library::open(&tmp.path().join("data")).unwrap();
    let wav = tmp.path().join("track.wav");
    common::write_test_wav(&wav, 440.0, 0.5);
    let track = lib
        .import_file(
            &wav,
            ImportOptions {
                title: Some("Harder Better".into()),
                artist: Some("Daft Punk".into()),
                ..ImportOptions::default()
            },
        )
        .unwrap()
        .track()
        .clone();
    lib.add_tag(track.id, "french-house").unwrap();

    assert_eq!(lib.search("harder").unwrap().len(), 1);
    assert_eq!(lib.search("daft").unwrap().len(), 1);
    assert_eq!(lib.search("french-house").unwrap().len(), 1);
    assert!(lib.search("nomatch").unwrap().is_empty());
}

#[test]
fn library_and_licenses_persist_across_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("data");
    let wav = tmp.path().join("cc-track.wav");
    common::write_test_wav(&wav, 550.0, 0.5);

    let license = LicenseInfo::from_cc_url(
        "https://creativecommons.org/licenses/by/4.0/",
        "\"CC Track\" by Someone",
    );
    let (track_id, crate_id);
    {
        // First "app run": import a track with license, tag it, crate it.
        let lib = Library::open(&data_dir).unwrap();
        let track = lib
            .import_file(
                &wav,
                ImportOptions {
                    source: "jamendo".into(),
                    source_ref: "12345".into(),
                    license: license.clone(),
                    title: Some("CC Track".into()),
                    artist: Some("Someone".into()),
                    ..ImportOptions::default()
                },
            )
            .unwrap()
            .track()
            .clone();
        track_id = track.id;
        lib.add_tag(track_id, "cc").unwrap();
        crate_id = lib.create_crate("warmup").unwrap();
        lib.add_to_crate(crate_id, track_id).unwrap();
        lib.add_watch_folder(&tmp.path().join("watched")).unwrap();
    } // library dropped = app closed

    // Second "app run": everything is still there.
    let lib = Library::open(&data_dir).unwrap();
    let track = lib.track(track_id).unwrap();
    assert_eq!(track.title, "CC Track");
    assert_eq!(track.source, "jamendo");
    assert_eq!(track.source_ref, "12345");
    assert_eq!(track.license, license);
    assert_eq!(track.license.kind, "cc-by");
    assert_eq!(lib.tags(track_id).unwrap(), vec!["cc".to_string()]);
    assert_eq!(lib.crate_tracks(crate_id).unwrap()[0].id, track_id);
    assert_eq!(lib.watch_folders().unwrap().len(), 1);
}

#[test]
fn cc_license_urls_classify() {
    let cases = [
        ("https://creativecommons.org/publicdomain/zero/1.0/", "cc0"),
        ("https://creativecommons.org/licenses/by/4.0/", "cc-by"),
        (
            "https://creativecommons.org/licenses/by-sa/3.0/",
            "cc-by-sa",
        ),
        (
            "https://creativecommons.org/licenses/by-nc/3.0/",
            "cc-by-nc",
        ),
        (
            "https://creativecommons.org/publicdomain/mark/1.0/",
            "public-domain",
        ),
        ("", "unknown"),
    ];
    for (url, kind) in cases {
        assert_eq!(LicenseInfo::from_cc_url(url, "").kind, kind, "{url}");
    }
    assert_eq!(LicenseInfo::commercial().kind, "commercial");
}

// ---------------------------------------------------------------------------
// DJ metadata (M2): hot cues, saved loops, beatgrids
// ---------------------------------------------------------------------------

#[test]
fn cues_loops_and_beatgrid_roundtrip_and_persist_across_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("data");
    let wav = tmp.path().join("deck-track.wav");
    common::write_test_wav(&wav, 261.0, 1.0);

    let track_id;
    {
        let lib = Library::open(&data_dir).unwrap();
        track_id = lib
            .import_file(&wav, ImportOptions::default())
            .unwrap()
            .track()
            .id;

        lib.set_track_cue(track_id, 0, 1.25, "intro").unwrap();
        lib.set_track_cue(track_id, 3, 32.5, "drop").unwrap();
        // Overwriting a slot replaces it.
        lib.set_track_cue(track_id, 0, 1.5, "intro2").unwrap();
        lib.set_track_cue(track_id, 7, 60.0, "").unwrap();
        lib.clear_track_cue(track_id, 7).unwrap();

        let loop_id = lib.add_track_loop(track_id, "main", 16.0, 20.0).unwrap();
        lib.add_track_loop(track_id, "outro", 90.0, 98.0).unwrap();
        lib.update_track_loop(loop_id, 16.0, 24.0).unwrap();

        lib.set_track_beatgrid(track_id, 128.0, 0.35).unwrap();
        lib.set_track_beatgrid(track_id, 126.5, 0.4).unwrap(); // replace
    } // dropped = app closed

    let lib = Library::open(&data_dir).unwrap();
    let cues = lib.track_cues(track_id).unwrap();
    assert_eq!(cues.len(), 2);
    assert_eq!(cues[0].slot, 0);
    assert_eq!(cues[0].position_secs, 1.5);
    assert_eq!(cues[0].label, "intro2");
    assert_eq!(cues[1].slot, 3);
    assert_eq!(cues[1].position_secs, 32.5);

    let loops = lib.track_loops(track_id).unwrap();
    assert_eq!(loops.len(), 2);
    assert_eq!(loops[0].name, "main");
    assert_eq!((loops[0].start_secs, loops[0].end_secs), (16.0, 24.0));
    assert_eq!(loops[1].name, "outro");

    let grid = lib.track_beatgrid(track_id).unwrap().unwrap();
    assert_eq!(grid.bpm, 126.5);
    assert_eq!(grid.anchor_secs, 0.4);

    // Deleting works and unknown tracks are empty, not errors.
    lib.delete_track_loop(loops[1].id).unwrap();
    assert_eq!(lib.track_loops(track_id).unwrap().len(), 1);
    assert!(lib.track_cues(9999).unwrap().is_empty());
    assert!(lib.track_beatgrid(9999).unwrap().is_none());
}

#[test]
fn cue_slot_and_loop_bounds_are_validated() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = Library::open(&tmp.path().join("data")).unwrap();
    let wav = tmp.path().join("t.wav");
    common::write_test_wav(&wav, 330.0, 0.5);
    let id = lib
        .import_file(&wav, ImportOptions::default())
        .unwrap()
        .track()
        .id;
    assert!(lib.set_track_cue(id, 8, 1.0, "").is_err());
    assert!(lib.add_track_loop(id, "", 5.0, 5.0).is_err());
    assert!(lib.set_track_beatgrid(id, 0.0, 0.0).is_err());
}

// ---------------------------------------------------------------------------
// Deleting a track
// ---------------------------------------------------------------------------

#[test]
fn deleting_a_track_takes_its_metadata_and_leaves_the_users_file() {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("data");
    let lib = Library::open(&data_dir).unwrap();
    let wav = tmp.path().join("mine.wav");
    common::write_test_wav(&wav, 440.0, 0.5);
    let id = lib
        .import_file(&wav, ImportOptions::default())
        .unwrap()
        .track()
        .id;
    lib.add_tag(id, "warmup").unwrap();
    let crate_id = lib.create_crate("set").unwrap();
    lib.add_to_crate(crate_id, id).unwrap();
    lib.set_track_cue(id, 0, 1.0, "intro").unwrap();
    lib.add_track_loop(id, "main", 4.0, 8.0).unwrap();
    lib.set_track_beatgrid(id, 128.0, 0.1).unwrap();

    let deleted = lib.delete_track(id).unwrap();
    assert_eq!(deleted.track.id, id);
    assert!(
        !deleted.file_removed,
        "a file outside the data dir is not ours to delete"
    );
    assert!(wav.exists());

    assert!(lib.tracks().unwrap().is_empty());
    assert!(lib.track(id).is_err());
    // Nothing hanging off the row survives it.
    assert!(lib.tags(id).unwrap().is_empty());
    assert!(lib.crate_tracks(crate_id).unwrap().is_empty());
    assert!(lib.track_cues(id).unwrap().is_empty());
    assert!(lib.track_loops(id).unwrap().is_empty());
    assert!(lib.track_beatgrid(id).unwrap().is_none());
    assert!(lib.analysis_queue().unwrap().is_empty());
}

#[test]
fn deleting_a_download_deletes_the_file_the_app_owns() {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("data");
    let lib = Library::open(&data_dir).unwrap();
    let downloads = lib.downloads_dir();
    std::fs::create_dir_all(&downloads).unwrap();
    let downloaded = downloads.join("fetched.wav");
    common::write_test_wav(&downloaded, 330.0, 0.5);
    let id = lib
        .import_file(
            &downloaded,
            ImportOptions {
                source: "freesound".into(),
                ..ImportOptions::default()
            },
        )
        .unwrap()
        .track()
        .id;

    let deleted = lib.delete_track(id).unwrap();
    assert!(deleted.file_removed);
    assert!(!downloaded.exists());
}

#[test]
fn a_deleted_path_is_remembered_until_it_is_imported_again() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = Library::open(&tmp.path().join("data")).unwrap();
    let wav = tmp.path().join("kept.wav");
    common::write_test_wav(&wav, 220.0, 0.5);
    let id = lib
        .import_file(&wav, ImportOptions::default())
        .unwrap()
        .track()
        .id;
    lib.delete_track(id).unwrap();
    assert_eq!(
        lib.deleted_files().unwrap(),
        vec![wav.canonicalize().unwrap()]
    );

    // Importing it on purpose is a change of mind: the track comes back
    // and the deletion is forgotten.
    let back = lib.import_file(&wav, ImportOptions::default()).unwrap();
    assert!(matches!(back, ImportOutcome::Added(_)));
    assert!(lib.deleted_files().unwrap().is_empty());
}
