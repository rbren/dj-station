//! M0 acceptance: RT-thread allocation tripwire passes; xrun counter
//! reports zero over a stress patch at 128-sample blocks.
//!
//! Environment constraint note (documented deviation): the PRD asks for a
//! 10-minute wall-clock run. Headless CI machines can't spare 10 idle
//! minutes, so per the milestone instructions this is verified as:
//!   1) a faster-than-realtime *offline* render of the stress patch covering
//!      the equivalent audio duration (default 60 s locally; CI sets
//!      STRESS_SECONDS=600 for the full 10-minute equivalent), asserting the
//!      engine sustains > 1x realtime throughput, plus
//!   2) a shorter true realtime-mode run (null backend, wall-clock paced)
//!      asserting the xrun counter stays at zero.
//!
//! The allocation tripwire installs a counting global allocator and asserts
//! zero allocations/deallocations on the audio path during steady-state
//! block processing (WASM modules included).

mod common;

use dj_engine::{Engine, EngineConfig};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static RT_ALLOCS: AtomicU64 = AtomicU64::new(0);
static RT_DEALLOCS: AtomicU64 = AtomicU64::new(0);

thread_local! {
    static TRIPWIRE_ARMED: Cell<bool> = const { Cell::new(false) };
}

struct TripwireAlloc;

unsafe impl GlobalAlloc for TripwireAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if TRIPWIRE_ARMED.with(|a| a.get()) {
            RT_ALLOCS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if TRIPWIRE_ARMED.with(|a| a.get()) {
            RT_DEALLOCS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: TripwireAlloc = TripwireAlloc;

/// Build a stress patch: `n` oscillator->VCA voices, ADSR-modulated, MIDI
/// gate, all mixed into the audio out — every M0 module type on the RT path.
fn build_stress_patch(engine: &mut Engine, voices: usize) {
    engine.add_module("midi1", "builtin.midi").unwrap();
    engine.add_module("adsr1", "com.dj.adsr").unwrap();
    engine.add_module("out1", "builtin.audio_out").unwrap();
    engine
        .add_midi_mapping("midi1", "note", 60, "pad_1")
        .unwrap();
    engine.connect("midi1", "pad_1", "adsr1", "gate").unwrap();
    for v in 0..voices {
        let osc = format!("osc{v}");
        let vca = format!("vca{v}");
        engine.add_module(&osc, "com.dj.oscillator").unwrap();
        engine.add_module(&vca, "com.dj.vca").unwrap();
        engine.set_param(&osc, "waveform", (v % 4) as f32).unwrap();
        engine.connect(&osc, "audio", &vca, "in").unwrap();
        engine.connect("adsr1", "env", &vca, "cv").unwrap();
        engine
            .connect(&vca, "out", "out1", if v % 2 == 0 { "ch1" } else { "ch2" })
            .unwrap();
    }
    // Hold a note so every voice is audible for the whole run.
    engine.inject_midi("midi1", 0, [0x90, 60, 100]).unwrap();
}

#[test]
fn rt_thread_allocation_tripwire() {
    let mut engine = common::default_engine();
    build_stress_patch(&mut engine, 8);

    // Warm up: first blocks may lazily initialize wasmtime internals.
    engine.process_blocks(200).unwrap();

    RT_ALLOCS.store(0, Ordering::Relaxed);
    RT_DEALLOCS.store(0, Ordering::Relaxed);
    TRIPWIRE_ARMED.with(|a| a.set(true));
    engine.process_blocks(2000).unwrap();
    TRIPWIRE_ARMED.with(|a| a.set(false));

    let allocs = RT_ALLOCS.load(Ordering::Relaxed);
    let deallocs = RT_DEALLOCS.load(Ordering::Relaxed);
    assert_eq!(
        (allocs, deallocs),
        (0, 0),
        "audio path allocated: {allocs} allocs / {deallocs} deallocs over 2000 blocks"
    );
}

#[test]
fn stress_patch_offline_equivalent_and_realtime_xruns() {
    let seconds: f64 = std::env::var("STRESS_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60.0);
    let config = EngineConfig::default();
    let sr = config.sample_rate as f64;
    let block = config.block_size;
    assert_eq!(block, 128, "stress run must use 128-sample blocks");

    // Part 1: offline stress equivalent, faster than realtime.
    let mut engine = Engine::new(config, common::registry()).unwrap();
    build_stress_patch(&mut engine, 16);
    let blocks = (seconds * sr / block as f64) as usize;
    let t0 = Instant::now();
    engine.process_blocks(blocks).unwrap();
    let elapsed = t0.elapsed().as_secs_f64();
    let speed = seconds / elapsed;
    println!("offline stress: {seconds}s audio in {elapsed:.2}s ({speed:.1}x realtime)");
    assert!(
        speed > 1.0,
        "engine cannot sustain realtime: {speed:.2}x over {seconds}s equivalent"
    );
    assert_eq!(engine.xrun_count(), 0);

    // Part 2: shorter true realtime run, zero xruns.
    let rt_seconds = 5.0f64;
    engine.start_null_realtime().unwrap();
    std::thread::sleep(Duration::from_secs_f64(rt_seconds));
    engine.stop().unwrap();
    let expected_blocks = (rt_seconds * sr / block as f64) as u64;
    let processed = engine.blocks_processed() - blocks as u64;
    assert!(
        processed >= expected_blocks * 95 / 100,
        "realtime run under-processed: {processed} of ~{expected_blocks} blocks"
    );
    assert_eq!(
        engine.xrun_count(),
        0,
        "xruns during {rt_seconds}s realtime stress run"
    );
}
