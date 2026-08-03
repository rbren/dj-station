//! rekordbox XML import (PRD §8.1, M4): tracks, beatgrids, cues and loops
//! from a rekordbox export land in the library DB.

use dj_library::{parse_rekordbox_xml, Library};
use std::path::{Path, PathBuf};

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/rekordbox.xml")
}

#[test]
fn parses_tracks_grids_cues_and_loops() {
    let tracks = parse_rekordbox_xml(&std::fs::read_to_string(fixture()).unwrap()).unwrap();
    assert_eq!(tracks.len(), 3);

    let t = &tracks[0];
    assert_eq!(t.title, "Night Drive");
    assert_eq!(t.artist, "Neon Runner");
    assert_eq!(t.album, "City Lights");
    // Percent-decoding of the Location URL.
    assert_eq!(t.location, Path::new("/Users/dj/Music/Night Drive.mp3"));
    assert_eq!(t.format, "mp3");
    assert_eq!(t.bpm, Some(118.0));
    assert_eq!(t.key.as_deref(), Some("8A"));
    assert_eq!(t.duration_secs, Some(240.0));
    assert_eq!(t.beatgrid, Some((118.0, 0.412)));
    // Memory cue (Num=-1) is skipped; hot cues 0 and 1 survive.
    assert_eq!(t.cues, vec![(0, 0.412), (1, 61.432)]);
    assert_eq!(t.loops, vec![("Loop 8".to_string(), 61.432, 77.702)]);

    let t = &tracks[1];
    assert_eq!(t.location, Path::new("/Users/dj/Music/tech/Deep Below.wav"));
    // First TEMPO wins (single-tempo beatgrid model).
    assert_eq!(t.beatgrid, Some((124.5, 0.05)));
    assert_eq!(t.key.as_deref(), Some("Am"));
    assert_eq!(t.cues, vec![(3, 30.25)]);
    assert!(t.loops.is_empty());

    let t = &tracks[2];
    assert_eq!(t.title, ""); // untitled in the XML; import falls back to file stem
    assert_eq!(t.bpm, None); // AverageBpm="0.00" is treated as unset
    assert_eq!(t.key, None);
    assert_eq!(t.beatgrid, None);
}

#[test]
fn imports_into_the_library_db_and_deduplicates() {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path()).unwrap();

    let report = lib.import_rekordbox_xml(&fixture()).unwrap();
    assert_eq!(report.imported.len(), 3);
    assert!(report.duplicates.is_empty());

    // Track metadata (files don't exist locally; XML metadata is used).
    let t = lib
        .track_by_path(Path::new("/Users/dj/Music/Night Drive.mp3"))
        .unwrap()
        .expect("imported track");
    assert_eq!(t.title, "Night Drive");
    assert_eq!(t.artist, "Neon Runner");
    assert_eq!(t.source, "rekordbox");
    assert_eq!(t.bpm, Some(118.0));
    assert_eq!(t.musical_key.as_deref(), Some("8A"));
    assert_eq!(t.duration_secs, Some(240.0));

    // Beatgrid, cues, loops are canonical in the library DB (M2 model).
    let grid = lib.track_beatgrid(t.id).unwrap().expect("beatgrid");
    assert_eq!((grid.bpm, grid.anchor_secs), (118.0, 0.412));
    let cues = lib.track_cues(t.id).unwrap();
    assert_eq!(cues.len(), 2);
    assert_eq!((cues[0].slot, cues[0].position_secs), (0, 0.412));
    assert_eq!((cues[1].slot, cues[1].position_secs), (1, 61.432));
    let loops = lib.track_loops(t.id).unwrap();
    assert_eq!(loops.len(), 1);
    assert_eq!(loops[0].name, "Loop 8");
    assert_eq!((loops[0].start_secs, loops[0].end_secs), (61.432, 77.702));

    // Untitled track falls back to the file stem.
    let t3 = lib
        .track_by_path(Path::new("/Users/dj/Music/untagged-take.flac"))
        .unwrap()
        .expect("untagged track");
    assert_eq!(t3.title, "untagged-take");

    // Re-importing the same export adds nothing.
    let again = lib.import_rekordbox_xml(&fixture()).unwrap();
    assert!(again.imported.is_empty());
    assert_eq!(again.duplicates.len(), 3);
    assert_eq!(lib.tracks().unwrap().len(), 3);
}

#[test]
fn rejects_non_rekordbox_xml() {
    let err = parse_rekordbox_xml("<foo/>").unwrap_err();
    assert!(format!("{err:#}").contains("not a rekordbox export"));
}
