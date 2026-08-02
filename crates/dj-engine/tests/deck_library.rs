//! M2 acceptance criterion 2: cues and loops set via API persist in the
//! library and reappear when the track is reloaded in a fresh patch.
//!
//! The engine's deck holds per-instance DJ state; the library DB is the
//! canonical cross-patch store (PRD §7: "stored as track metadata in the
//! library DB, survives across patches"). The thin glue exercised here —
//! write-through on set, re-apply on load — is exactly what the Tauri
//! shell's deck IPC commands do.

mod common;

use dj_engine::{Engine, EngineConfig};
use dj_library::{ImportOptions, Library};
use std::path::Path;

const SR: u32 = 48_000;

fn write_ramp(path: &Path, seconds: f64) -> u64 {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SR,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let total = (seconds * SR as f64) as u64;
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..total {
        let x = 0.9 * i as f64 / total as f64;
        w.write_sample((x * i16::MAX as f64) as i16).unwrap();
    }
    w.finalize().unwrap();
    total
}

fn mono_deck_engine() -> Engine {
    let config = EngineConfig {
        master_channels: 1,
        ..EngineConfig::default()
    };
    let mut e = Engine::new(config, common::registry()).unwrap();
    e.add_module("deck1", "builtin.deck").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("deck1", "audio_l", "out1", "ch1").unwrap();
    e
}

/// The app-layer glue: load a library track into a deck and re-apply its
/// persisted DJ metadata (beatgrid, hot cues, first saved loop as the
/// active region). Mirrors the Tauri shell's `deck_load` command.
fn load_track_with_metadata(e: &mut Engine, deck: &str, lib: &Library, track_id: i64) {
    let track = lib.track(track_id).unwrap();
    e.deck_load(deck, Path::new(&track.file_path)).unwrap();
    if let Some(grid) = lib.track_beatgrid(track_id).unwrap() {
        e.deck_set_beatgrid(deck, grid.bpm, grid.anchor_secs)
            .unwrap();
    }
    for cue in lib.track_cues(track_id).unwrap() {
        e.deck_set_cue(deck, cue.slot as usize, Some(cue.position_secs))
            .unwrap();
    }
    if let Some(l) = lib.track_loops(track_id).unwrap().first() {
        e.deck_set_loop(deck, l.start_secs, l.end_secs).unwrap();
    }
}

#[test]
fn cues_and_loops_set_via_api_reappear_in_a_fresh_patch() {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("library-data");
    let wav = tmp.path().join("ramp.wav");
    let total = write_ramp(&wav, 10.0);

    // --- Session 1: import the track, set cues/loops/grid via API. -----
    let track_id;
    {
        let lib = Library::open(&data_dir).unwrap();
        track_id = lib
            .import_file(&wav, ImportOptions::default())
            .unwrap()
            .track()
            .id;

        let mut e = mono_deck_engine();
        e.deck_load("deck1", &wav).unwrap();

        // Write-through: engine state + library metadata (what the shell's
        // deck_set_cue / deck_save_loop / beatgrid IPC commands do).
        e.deck_set_cue("deck1", 0, Some(1.5)).unwrap();
        lib.set_track_cue(track_id, 0, 1.5, "intro").unwrap();
        e.deck_set_cue("deck1", 4, Some(3.25)).unwrap();
        lib.set_track_cue(track_id, 4, 3.25, "drop").unwrap();
        e.deck_set_loop("deck1", 2.0, 4.0).unwrap();
        lib.add_track_loop(track_id, "main", 2.0, 4.0).unwrap();
        e.deck_set_beatgrid("deck1", 120.0, 0.5).unwrap();
        lib.set_track_beatgrid(track_id, 120.0, 0.5).unwrap();
    } // engine + library dropped: "app closed"

    // --- Session 2: fresh engine, fresh patch, fresh library handle. ---
    let lib = Library::open(&data_dir).unwrap();
    let mut e = mono_deck_engine();
    let reloaded = lib.track_by_path(&wav).unwrap().expect("track in library");
    assert_eq!(reloaded.id, track_id);
    load_track_with_metadata(&mut e, "deck1", &lib, reloaded.id);

    // The metadata reappeared on the deck.
    let cues = e.deck_cues("deck1").unwrap();
    assert_eq!(cues[0], Some(1.5));
    assert_eq!(cues[4], Some(3.25));
    assert_eq!(cues[1], None);
    let st = e.deck_status("deck1").unwrap();
    assert_eq!(st.grid_bpm, Some(120.0));
    assert_eq!(st.grid_anchor_secs, Some(0.5));
    assert_eq!(st.loop_start_secs, Some(2.0));
    assert_eq!(st.loop_end_secs, Some(4.0));

    // And it is functional, not just cosmetic: firing cue 5 (slot 4) jumps
    // playback to 3.25 s in the rendered audio.
    e.set_knob_position("deck1", "play_gate", 1.0).unwrap();
    e.render_offline(SR as usize / 2).unwrap();
    e.set_knob_position("deck1", "cue_trig5", 1.0).unwrap();
    let seg = e.render_offline((0.1 * SR as f64) as usize).unwrap();
    let pos = (seg[0][200] as f64 / 10.0 / 0.9) * total as f64 / SR as f64;
    assert!(
        (pos - 3.25).abs() < 0.02,
        "restored cue jump landed at {pos:.3}s, expected 3.25s"
    );

    // The active loop region works too.
    e.deck_loop_enable("deck1", true).unwrap();
    let seg = e.render_offline(3 * SR as usize).unwrap();
    let end_pos = (*seg[0].last().unwrap() as f64 / 10.0 / 0.9) * total as f64 / SR as f64;
    assert!(
        (2.0..4.0).contains(&end_pos),
        "restored loop not looping: playhead at {end_pos:.3}s"
    );
}
