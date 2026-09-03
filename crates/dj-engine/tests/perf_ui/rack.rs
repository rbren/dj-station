//! RACK: the engine graph the canvas draws, rendered offline.
//!
//! A voice here is the chain the Rack page is full of — oscillator into
//! filter into VCA, an envelope on the VCA and an LFO on the cutoff —
//! repeated until the patch is as big as the fixture asks for, every
//! voice summed into the audio out. Two things are measured: BUILDING
//! that patch (what opening a big patch costs: one wasmtime
//! instantiation per module) and RENDERING it (what the RT thread does,
//! block after block).

use dj_engine::{Engine, EngineConfig, MidiMapKind};
use std::time::Instant;

use super::bench::{expect_scaling, expect_throughput, render, sized, warmup};
use crate::common::registry;

/// Modules per voice — oscillator, filter, VCA, ADSR, LFO.
const PER_VOICE: usize = 5;

/// Build `voices` voice chains into one audio out. Returns the engine and
/// how long the build took.
fn build_rack(voices: usize) -> (Engine, f64) {
    let t0 = Instant::now();
    let mut engine = Engine::new(EngineConfig::default(), registry()).unwrap();
    engine.add_module("midi1", "builtin.midi").unwrap();
    engine.add_module("out1", "builtin.audio_out").unwrap();
    engine
        .add_midi_mapping("midi1", MidiMapKind::Note, 60, "pad_1")
        .unwrap();

    for v in 0..voices {
        let (osc, filt, vca, adsr, lfo) = (
            format!("osc{v}"),
            format!("filt{v}"),
            format!("vca{v}"),
            format!("adsr{v}"),
            format!("lfo{v}"),
        );
        engine.add_module(&osc, "com.dj.oscillator").unwrap();
        engine.add_module(&filt, "com.dj.filter").unwrap();
        engine.add_module(&vca, "com.dj.vca").unwrap();
        engine.add_module(&adsr, "com.dj.adsr").unwrap();
        engine.add_module(&lfo, "com.dj.lfo").unwrap();
        engine
            .set_knob_value(&osc, "waveform", (v % 4) as f32)
            .unwrap();
        engine
            .set_knob_position(&osc, "pitch", 0.2 + 0.01 * (v % 40) as f32)
            .unwrap();
        engine.set_knob_value(&vca, "cv", 0.0).unwrap();
        engine.connect("midi1", "pad_1", &adsr, "gate").unwrap();
        engine.connect(&osc, "audio", &filt, "in").unwrap();
        engine.connect(&lfo, "bi", &filt, "cutoff").unwrap();
        engine.connect(&filt, "lp", &vca, "in").unwrap();
        engine.connect(&adsr, "env", &vca, "cv").unwrap();
        engine
            .connect(&vca, "out", "out1", if v % 2 == 0 { "l" } else { "r" })
            .unwrap();
    }
    // Hold the gate down so every voice is actually making sound for the
    // whole run: an idle patch measures nothing.
    engine.inject_midi("midi1", 0, [0x90, 60, 100]).unwrap();
    (engine, t0.elapsed().as_secs_f64() * 1e3)
}

fn render_seconds(engine: &mut Engine, secs: f64) {
    let config = EngineConfig::default();
    let blocks = (secs * config.sample_rate as f64 / config.block_size as f64) as usize;
    engine.process_blocks(blocks).unwrap();
}

#[test]
fn a_big_rack_renders_far_faster_than_realtime() {
    warmup(|| {
        let (mut engine, _) = build_rack(1);
        render_seconds(&mut engine, 0.25);
    });
    let voices = sized(12, 40);
    let secs = sized(10.0, 30.0);
    let (mut engine, build_ms) = build_rack(voices);
    let modules = voices * PER_VOICE + 2;
    println!("[perf] rack build: {modules} modules in {build_ms:.0}ms ({voices} voices)");

    // Audible: a silent patch would render at any speed at all.
    let probe = engine.render_offline(4_800).unwrap();
    let peak = probe[0].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    assert!(peak > 0.0, "rack fixture is silent");

    let (_, t) = render(
        &format!("rack render ({modules} modules)"),
        secs,
        || render_seconds(&mut engine, secs),
    );

    // Measured at ~3.5x realtime for 62 modules on the development box
    // (reports/PERF_BASELINES.md). The floor is a third of that: a patch
    // this size must stay realtime-capable even on a runner sharing its
    // cores with three other jobs.
    expect_throughput(&t, 1.2);
    assert_eq!(engine.xrun_count(), 0, "xruns during the offline render");
    // Instantiating a module is wasmtime work, and a patch load does it
    // once per module — ~60 ms each today, so a 62-module patch takes
    // about four seconds to open. That is already the dearest thing on
    // this page; the gate is there to stop it getting worse unnoticed.
    let per_module = build_ms / modules as f64;
    assert!(
        per_module < 200.0,
        "PERF REGRESSION — rack build is {per_module:.0}ms per module ({build_ms:.0}ms for \
         {modules}). See reports/PERF_BASELINES.md."
    );
}

#[test]
fn twice_the_modules_costs_about_twice_as_much() {
    warmup(|| {
        let (mut engine, _) = build_rack(1);
        render_seconds(&mut engine, 0.25);
    });
    let voices = sized(6, 20);
    let secs = sized(5.0, 15.0);

    let (mut small_engine, _) = build_rack(voices);
    let (_, small) = render(
        &format!("rack render ({} modules)", voices * PER_VOICE + 2),
        secs,
        || render_seconds(&mut small_engine, secs),
    );
    let (mut big_engine, _) = build_rack(voices * 2);
    let (_, big) = render(
        &format!("rack render ({} modules)", voices * 2 * PER_VOICE + 2),
        secs,
        || render_seconds(&mut big_engine, secs),
    );

    // Modules are processed in sequence, so the graph is linear in the
    // module count: a wire-resolution pass that walked the whole graph
    // per module (or a scheduler that re-sorted it per block) is what
    // this catches.
    expect_scaling(&small, &big, 2.0, 1.6);
}
