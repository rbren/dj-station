//! M3 acceptance: auto-beatgrids from the analysis pipeline are good
//! enough that the M2 deck sync passes its phase criterion (±1 ms beat
//! alignment) with **no manual grid adjustment** — the grids applied to
//! both decks come straight out of `dj_analysis::analyze_audio`.

mod common;

use dj_analysis::testset::synth_labeled_track;
use dj_engine::{Engine, EngineConfig};
use std::path::Path;

const ENGINE_SR: u32 = 48_000;
const TRACK_SR: u32 = 44_100;

fn write_wav(path: &Path, audio: &dj_analysis::AudioData) {
    let spec = hound::WavSpec {
        channels: audio.channels.len() as u16,
        sample_rate: audio.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..audio.frames() {
        for c in &audio.channels {
            w.write_sample((c[i].clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                .unwrap();
        }
    }
    w.finalize().unwrap();
}

fn rising_edges(signal: &[f32], thresh: f32, min_gap: usize) -> Vec<usize> {
    let mut edges = Vec::new();
    let mut last: Option<usize> = None;
    for i in 1..signal.len() {
        if signal[i] >= thresh && signal[i - 1] < thresh {
            if let Some(l) = last {
                if i - l < min_gap {
                    continue;
                }
            }
            edges.push(i);
            last = Some(i);
        }
    }
    edges
}

#[test]
fn auto_beatgrids_drive_deck_sync_within_1ms() {
    // Two labeled tracks at different tempos (seeds chosen so the BPMs
    // differ; both long enough to cover the render at slowed rates).
    let ta = synth_labeled_track(11, TRACK_SR, 70.0);
    let tb = synth_labeled_track(23, TRACK_SR, 70.0);
    assert!(
        (ta.bpm - tb.bpm).abs() > 3.0,
        "want distinct tempos, got {} and {}",
        ta.bpm,
        tb.bpm
    );

    // Analysis output only — no manual grid adjustment anywhere below.
    let ga = dj_analysis::analyze_audio(&ta.audio).unwrap();
    let gb = dj_analysis::analyze_audio(&tb.audio).unwrap();

    let tmp = tempfile::tempdir().unwrap();
    let wav_a = tmp.path().join("a.wav");
    let wav_b = tmp.path().join("b.wav");
    write_wav(&wav_a, &ta.audio);
    write_wav(&wav_b, &tb.audio);

    let mut e = Engine::new(EngineConfig::default(), common::registry()).unwrap();
    e.add_module("deckA", "builtin.deck").unwrap();
    e.add_module("deckB", "builtin.deck").unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("deckA", "beat_clock", "out1", "ch1").unwrap();
    e.connect("deckB", "beat_clock", "out1", "ch2").unwrap();
    e.deck_load("deckA", &wav_a).unwrap();
    e.deck_load("deckB", &wav_b).unwrap();
    e.deck_set_beatgrid("deckA", ga.bpm, ga.anchor_secs)
        .unwrap();
    e.deck_set_beatgrid("deckB", gb.bpm, gb.anchor_secs)
        .unwrap();
    e.deck_sync("deckB", Some("deckA")).unwrap();
    e.set_knob_position("deckA", "play_gate", 1.0).unwrap();
    e.set_knob_position("deckB", "play_gate", 1.0).unwrap();

    let seconds = 61.0;
    let rendered = e
        .render_offline((seconds * ENGINE_SR as f64) as usize)
        .unwrap();
    let min_gap = (0.2 * ENGINE_SR as f64) as usize;
    let edges_a = rising_edges(&rendered[0], 5.0, min_gap);
    let edges_b = rising_edges(&rendered[1], 5.0, min_gap);
    assert!(
        edges_a.len() as f64 > seconds * ta.bpm / 60.0 * 0.9,
        "deck A produced too few beats: {}",
        edges_a.len()
    );
    assert!(
        (edges_a.len() as i64 - edges_b.len() as i64).abs() <= 1,
        "beat counts diverge: A {} vs B {}",
        edges_a.len(),
        edges_b.len()
    );

    // M2 phase criterion, driven purely by analysis grids: every deck A
    // beat after the first second has a deck B beat within ±1 ms.
    let tolerance = (0.001 * ENGINE_SR as f64) as i64;
    let mut worst = 0i64;
    for &ea in edges_a.iter().filter(|&&x| x > ENGINE_SR as usize) {
        let nearest = edges_b
            .iter()
            .map(|&eb| (eb as i64 - ea as i64).abs())
            .min()
            .unwrap();
        worst = worst.max(nearest);
        assert!(
            nearest <= tolerance,
            "beat at {:.3}s misaligned by {} samples ({:.2} ms) — auto grids: A {:.2} BPM @ {:.3}s, B {:.2} BPM @ {:.3}s",
            ea as f64 / ENGINE_SR as f64,
            nearest,
            nearest as f64 / ENGINE_SR as f64 * 1000.0,
            ga.bpm,
            ga.anchor_secs,
            gb.bpm,
            gb.anchor_secs
        );
    }
    println!(
        "analysis-driven sync: A {:.1} BPM, B {:.1} BPM, {} beats checked, worst offset {} samples ({:.3} ms)",
        ga.bpm,
        gb.bpm,
        edges_a.len(),
        worst,
        worst as f64 / ENGINE_SR as f64 * 1000.0
    );
}
