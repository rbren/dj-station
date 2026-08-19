//! DAW bottom-bar timeline: always-present singleton node, track CRUD and
//! jack allocation (mono/stereo), clip import (incl. channel adaptation and
//! resampling), transport playback of audio and CV clips, input-jack and
//! mic recording, clip peak readout, and patch round-trip.

use dj_engine::daw::{DawRecordSource, DawTrackKind, DAW_INSTANCE};
use dj_engine::{Engine, EngineConfig};
use std::path::Path;

fn engine() -> Engine {
    Engine::new(EngineConfig::default(), crate::common::registry()).unwrap()
}

fn out_v(e: &Engine, jack: &str) -> f32 {
    e.tap_out(DAW_INSTANCE, jack).unwrap().instantaneous
}

/// Write a float WAV with the given per-channel samples.
fn write_wav(path: &Path, sample_rate: u32, channels: &[Vec<f32>]) {
    let spec = hound::WavSpec {
        channels: channels.len() as u16,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for f in 0..channels[0].len() {
        for ch in channels {
            w.write_sample(ch[f]).unwrap();
        }
    }
    w.finalize().unwrap();
}

#[test]
fn daw_is_always_present_and_unremovable() {
    let mut e = engine();
    assert!(e.nodes.iter().any(|n| n.instance_id == DAW_INSTANCE));
    assert!(e.daw().unwrap().tracks.is_empty());
    // Cannot be removed...
    assert!(e.remove_module(DAW_INSTANCE).is_err());
    // ...and cannot be added again (reserved id or any other).
    assert!(e.add_module("daw2", "builtin.daw").is_err());
    assert!(e.add_module(DAW_INSTANCE, "builtin.daw").is_err());
}

#[test]
fn track_crud_allocates_stable_jacks() {
    let mut e = engine();
    let j0 = e.daw_add_track("voice", "audio", false).unwrap(); // 1 slot
    let j1 = e.daw_add_track("stereo", "audio", true).unwrap(); // 2 slots
    let j2 = e.daw_add_track("mod", "continuous", false).unwrap(); // 1 slot
    assert_eq!((j0, j1, j2), (0, 1, 3));
    // stereo flag is ignored on continuous tracks.
    let j3 = e.daw_add_track("cv2", "continuous", true).unwrap();
    assert_eq!(j3, 4);
    assert_eq!(e.daw().unwrap().tracks[3].channels(), 1);

    assert!(
        e.daw_add_track("voice", "audio", false).is_err(),
        "dup name"
    );
    assert!(e.daw_add_track("x", "midi", false).is_err(), "unknown kind");

    // Removing the mono track frees slot 0; a stereo track needs two
    // contiguous slots so it skips it, a mono one reuses it.
    e.daw_remove_track(0).unwrap();
    let j4 = e.daw_add_track("wide", "audio", true).unwrap();
    assert_eq!(j4, 5);
    let j5 = e.daw_add_track("narrow", "audio", false).unwrap();
    assert_eq!(j5, 0);

    // Rename and reorder keep jack slots with their tracks.
    e.daw_rename_track(0, "stereo1").unwrap();
    e.daw_move_track(0, 3).unwrap();
    let st = e.daw().unwrap();
    let t = st.tracks.iter().find(|t| t.name == "stereo1").unwrap();
    assert_eq!(t.jack, 1);
    assert_eq!(st.tracks[3].name, "stereo1");
}

#[test]
fn audio_clip_plays_at_transport_position() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("clip.wav");
    // 0.5 s of DC 0.8 at the engine rate: trivially verifiable.
    write_wav(&wav, 48_000, &[vec![0.8; 24_000]]);

    let mut e = engine();
    e.daw_add_track("voice", "audio", false).unwrap();
    e.daw_import_clip(0, &wav).unwrap();
    assert_eq!(e.daw_clip_frames(0).unwrap(), 24_000);

    // Stopped transport: silence.
    e.process_blocks(4).unwrap();
    assert_eq!(out_v(&e, "t0"), 0.0);
    assert!(!e.daw_status().unwrap().playing);

    // Playing: file 0.8 -> 8 V on the track output.
    e.daw_play().unwrap();
    e.process_blocks(4).unwrap();
    assert!((out_v(&e, "t0") - 8.0).abs() < 1e-4);
    let st = e.daw_status().unwrap();
    assert!(st.playing);
    assert_eq!(st.playhead, 4 * 128);

    // Past the clip end: transport keeps rolling, output silent.
    e.daw_seek(24_000).unwrap();
    e.process_blocks(2).unwrap();
    assert_eq!(out_v(&e, "t0"), 0.0);
    assert_eq!(e.daw_status().unwrap().playhead, 24_000 + 2 * 128);

    // Stop freezes the playhead.
    e.daw_stop_transport().unwrap();
    e.process_blocks(2).unwrap();
    assert_eq!(e.daw_status().unwrap().playhead, 24_000 + 2 * 128);

    // Seek back and replay.
    e.daw_seek(0).unwrap();
    e.daw_play().unwrap();
    e.process_blocks(1).unwrap();
    assert!((out_v(&e, "t0") - 8.0).abs() < 1e-4);
}

#[test]
fn stereo_track_spans_two_jacks_and_mono_clip_feeds_both() {
    let dir = tempfile::tempdir().unwrap();
    let stereo = dir.path().join("st.wav");
    write_wav(&stereo, 48_000, &[vec![0.5; 4800], vec![-0.25; 4800]]);
    let mono = dir.path().join("mono.wav");
    write_wav(&mono, 48_000, &[vec![0.6; 4800]]);

    let mut e = engine();
    e.daw_add_track("st", "audio", true).unwrap(); // jacks 0+1
    e.daw_import_clip(0, &stereo).unwrap();
    e.daw_play().unwrap();
    e.process_blocks(2).unwrap();
    assert!((out_v(&e, "t0") - 5.0).abs() < 1e-4);
    assert!((out_v(&e, "t1") + 2.5).abs() < 1e-4);

    // A mono clip on the stereo track duplicates to both channels.
    e.daw_import_clip(0, &mono).unwrap();
    e.process_blocks(2).unwrap();
    assert!((out_v(&e, "t0") - 6.0).abs() < 1e-4);
    assert!((out_v(&e, "t1") - 6.0).abs() < 1e-4);

    // A stereo clip on a MONO track averages down.
    e.daw_add_track("m", "audio", false).unwrap(); // jack 2
    e.daw_import_clip(1, &stereo).unwrap();
    e.process_blocks(2).unwrap();
    assert!(
        (out_v(&e, "t2") - 1.25).abs() < 1e-4,
        "avg of 0.5,-0.25 = 0.125 -> 1.25 V"
    );
}

#[test]
fn import_resamples_to_engine_rate() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("slow.wav");
    // 1200 frames at 24 kHz = 50 ms = 2400 engine frames at 48 kHz.
    write_wav(&wav, 24_000, &[vec![0.4; 1200]]);

    let mut e = engine();
    e.daw_add_track("v", "audio", false).unwrap();
    e.daw_import_clip(0, &wav).unwrap();
    assert_eq!(e.daw_clip_frames(0).unwrap(), 2400);
    e.daw_play().unwrap();
    e.process_blocks(1).unwrap();
    assert!((out_v(&e, "t0") - 4.0).abs() < 1e-4);
}

#[test]
fn continuous_track_outputs_clip_voltage() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("cv.wav");
    // A CV ramp: file units scale to ±10 V (0.73 -> 7.3 V).
    let n = 4 * 128;
    let ramp: Vec<f32> = (0..n).map(|i| i as f32 / n as f32).collect();
    write_wav(&wav, 48_000, &[ramp]);

    let mut e = engine();
    e.daw_add_track("mod", "continuous", false).unwrap();
    e.daw_import_clip(0, &wav).unwrap();
    e.daw_play().unwrap();
    e.process_blocks(2).unwrap();
    // After 2 blocks the playhead is at 256/512 of the ramp; the last
    // rendered sample was index 255: 255/512 * 10 V.
    let expect = 255.0 / n as f32 * 10.0;
    assert!((out_v(&e, "t0") - expect).abs() < 0.05);
}

#[test]
fn record_from_input_jack_writes_clip_and_wav() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = engine();
    e.daw_add_track("mod", "continuous", false).unwrap();
    // Unwired plain jack: its knob position maps through the default
    // 0..10 linear config — a deterministic constant "signal".
    e.set_knob_position(DAW_INSTANCE, "i0", 0.65).unwrap();

    e.daw_record_start(0, DawRecordSource::Input).unwrap();
    e.process_blocks(8).unwrap();
    let st = e.daw_status().unwrap();
    assert_eq!(st.recording, Some(0));
    assert_eq!(st.record_frames, 8 * 128);

    let path = e.daw_record_stop(dir.path()).unwrap().expect("a take");
    assert!(path.exists());

    // The finalized clip is loaded on the track: 6.5 V in = 6.5 V out.
    assert_eq!(e.daw_clip_frames(0).unwrap(), 8 * 128);
    e.daw_seek(0).unwrap();
    e.daw_play().unwrap();
    e.process_blocks(1).unwrap();
    assert!((out_v(&e, "t0") - 6.5).abs() < 1e-3);

    // The WAV itself holds FILE units (0.65).
    let mut r = hound::WavReader::open(&path).unwrap();
    assert_eq!(r.spec().channels, 1);
    assert_eq!(r.spec().sample_rate, 48_000);
    let first = r.samples::<f32>().next().unwrap().unwrap();
    assert!((first - 0.65).abs() < 1e-3);

    let st = e.daw().unwrap();
    assert_eq!(st.tracks[0].clip.as_deref(), Some(path.to_str().unwrap()));
}

#[test]
fn record_stereo_input_interleaves_correctly() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = engine();
    e.daw_add_track("st", "audio", true).unwrap(); // i0 + i1
    e.set_knob_position(DAW_INSTANCE, "i0", 0.3).unwrap();
    e.set_knob_position(DAW_INSTANCE, "i1", 0.9).unwrap();

    e.daw_record_start(0, DawRecordSource::Input).unwrap();
    e.process_blocks(4).unwrap();
    let path = e.daw_record_stop(dir.path()).unwrap().expect("a take");

    let mut r = hound::WavReader::open(&path).unwrap();
    assert_eq!(r.spec().channels, 2);
    let samples: Vec<f32> = r.samples::<f32>().map(|s| s.unwrap()).collect();
    assert_eq!(samples.len(), 4 * 128 * 2);
    assert!((samples[0] - 0.3).abs() < 1e-3, "L first");
    assert!((samples[1] - 0.9).abs() < 1e-3, "R second");
}

#[test]
fn mic_recording_uses_control_side_feed() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = engine();
    e.daw_add_track("vox", "audio", false).unwrap();

    // Mic recording is rejected on continuous tracks.
    e.daw_add_track("cv", "continuous", false).unwrap();
    assert!(e.daw_record_start(1, DawRecordSource::Mic).is_err());

    e.daw_record_start(0, DawRecordSource::Mic).unwrap();
    // Feeding is control-side; the engine does not need to run.
    e.daw_feed_capture(&vec![0.25; 4800]).unwrap();
    let st = e.daw_status().unwrap();
    assert_eq!(st.record_frames, 4800);
    let path = e.daw_record_stop(dir.path()).unwrap().expect("a take");

    assert_eq!(e.daw_clip_frames(0).unwrap(), 4800);
    e.daw_play().unwrap();
    e.process_blocks(1).unwrap();
    assert!((out_v(&e, "t0") - 2.5).abs() < 1e-3);
    assert!(path.exists());
}

#[test]
fn empty_take_aborts_cleanly_and_cancel_discards() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = engine();
    e.daw_add_track("vox", "audio", false).unwrap();

    // Stop with zero captured frames: no file, no clip.
    e.daw_record_start(0, DawRecordSource::Mic).unwrap();
    assert!(e.daw_record_stop(dir.path()).unwrap().is_none());
    assert_eq!(e.daw_clip_frames(0).unwrap(), 0);

    // Cancel discards data.
    e.daw_record_start(0, DawRecordSource::Mic).unwrap();
    e.daw_feed_capture(&[0.5; 100]).unwrap();
    e.daw_record_cancel().unwrap();
    assert!(e.daw_status().unwrap().recording.is_none());
    // Only one recording at a time.
    e.daw_record_start(0, DawRecordSource::Mic).unwrap();
    assert!(e.daw_record_start(0, DawRecordSource::Mic).is_err());
    e.daw_record_cancel().unwrap();

    // Removing a recording track is rejected.
    e.daw_record_start(0, DawRecordSource::Input).unwrap();
    assert!(e.daw_remove_track(0).is_err());
    e.daw_record_cancel().unwrap();
    e.daw_remove_track(0).unwrap();
}

#[test]
fn clip_peaks_report_min_max_in_volts() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("peaks.wav");
    // First half -0.5, second half +1.0.
    let mut data = vec![-0.5f32; 1000];
    data.extend(vec![1.0f32; 1000]);
    write_wav(&wav, 48_000, &[data]);

    let mut e = engine();
    e.daw_add_track("v", "audio", false).unwrap();
    assert!(e.daw_clip_peaks(0, 4).unwrap().is_empty(), "no clip yet");
    e.daw_import_clip(0, &wav).unwrap();
    let peaks = e.daw_clip_peaks(0, 2).unwrap();
    assert_eq!(peaks.len(), 2);
    assert!((peaks[0].0 + 5.0).abs() < 1e-3 && (peaks[0].1 + 5.0).abs() < 1e-3);
    assert!((peaks[1].0 - 10.0).abs() < 1e-3 && (peaks[1].1 - 10.0).abs() < 1e-3);
}

#[test]
fn daw_state_roundtrips_through_save_load_with_wires() {
    let dir = tempfile::tempdir().unwrap();
    let clip_dir = tempfile::tempdir().unwrap();
    let wav = clip_dir.path().join("clip.wav");
    write_wav(&wav, 48_000, &[vec![0.5; 4800]]);

    {
        let mut e = engine();
        e.add_module("osc1", "com.dj.oscillator").unwrap();
        e.add_module("vca1", "com.dj.vca").unwrap();
        e.daw_add_track("voice", "audio", false).unwrap(); // slot 0
        e.daw_add_track("mod", "continuous", false).unwrap(); // slot 1
        e.daw_import_clip(0, &wav).unwrap();
        // Wires both directions: into a DAW input, out of a DAW output.
        e.connect("osc1", "audio", DAW_INSTANCE, "i0").unwrap();
        e.connect(DAW_INSTANCE, "t1", "vca1", "cv").unwrap();
        e.save_patch(dir.path(), "daw-patch").unwrap();
    }
    assert!(dir.path().join("modules/daw.json").exists());

    let mut loaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    let st = loaded.daw().unwrap();
    assert_eq!(st.tracks.len(), 2);
    assert_eq!(st.tracks[0].name, "voice");
    assert_eq!(st.tracks[0].kind, DawTrackKind::Audio);
    assert_eq!(st.tracks[0].clip.as_deref(), Some(wav.to_str().unwrap()));
    assert_eq!(st.tracks[1].jack, 1);
    // The clip reloaded from its path and plays.
    assert_eq!(loaded.daw_clip_frames(0).unwrap(), 4800);
    loaded.daw_play().unwrap();
    loaded.process_blocks(1).unwrap();
    assert!((out_v(&loaded, "t0") - 5.0).abs() < 1e-4);
    // Wires survived.
    assert_eq!(loaded.wire_specs().len(), 2);

    // Re-saving is byte-stable.
    let dir2 = tempfile::tempdir().unwrap();
    loaded.save_patch(dir2.path(), "daw-patch").unwrap();
    let a = std::fs::read_to_string(dir.path().join("modules/daw.json")).unwrap();
    let b = std::fs::read_to_string(dir2.path().join("modules/daw.json")).unwrap();
    assert_eq!(a, b);
}

#[test]
fn untouched_daw_stays_out_of_the_patch() {
    let dir = tempfile::tempdir().unwrap();
    let e = engine();
    e.save_patch(dir.path(), "empty").unwrap();
    assert!(
        !dir.path().join("modules/daw.json").exists(),
        "default DAW must not bloat patches"
    );
    // And loading such a patch still has the DAW.
    let loaded = Engine::load_patch(dir.path(), crate::common::registry()).unwrap();
    assert!(loaded.daw().unwrap().tracks.is_empty());
}

#[test]
fn apply_doc_diffs_daw_in_place() {
    let clip_dir = tempfile::tempdir().unwrap();
    let wav = clip_dir.path().join("clip.wav");
    write_wav(&wav, 48_000, &[vec![0.5; 480]]);

    let mut e = engine();
    let before = e.snapshot("undo"); // no tracks
    e.daw_add_track("voice", "audio", false).unwrap();
    e.daw_import_clip(0, &wav).unwrap();
    let after = e.snapshot("undo");

    // Undo: back to no tracks (the DAW node itself is never recreated).
    let created = e.apply_doc(&before).unwrap();
    assert!(created.is_empty());
    assert!(e.daw().unwrap().tracks.is_empty());

    // Redo: track + clip return, clip reloaded from its path.
    let created = e.apply_doc(&after).unwrap();
    assert!(created.is_empty());
    assert_eq!(e.daw().unwrap().tracks.len(), 1);
    assert_eq!(e.daw_clip_frames(0).unwrap(), 480);
}
