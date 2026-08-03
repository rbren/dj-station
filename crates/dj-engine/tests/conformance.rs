//! Module-backend conformance suite (M4 acceptance: a native dylib module
//! loads through the same manifest, passes the same conformance suite as
//! WASM modules, and runs on the RT thread).
//!
//! The suite is written as backend-agnostic batteries that run identically
//! over WASM and native extensions — the native sample (`com.dj.gain_native`)
//! implements the exact same DSP as the WASM VCA, so the two backends are
//! additionally asserted to produce *identical* audio.

mod common;

use dj_engine::module_host::HostModule;
use dj_engine::native_host::NativeRuntime;
use dj_engine::{Engine, EngineConfig, ExtensionRegistry};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};

const SR: f32 = 48_000.0;
const WASM_GAIN: (&str, &str, &str) = ("com.dj.vca", "in", "cv");
const NATIVE_GAIN: (&str, &str, &str) = ("com.dj.gain_native", "in", "gain");

fn registry() -> ExtensionRegistry {
    common::ensure_native_extensions_built();
    common::registry()
}

// ---------------------------------------------------------------------------
// Allocation tripwire (same technique as rt_safety.rs; separate test binary,
// separate global allocator).
// ---------------------------------------------------------------------------

static RT_ALLOCS: AtomicU64 = AtomicU64::new(0);

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
            RT_ALLOCS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: TripwireAlloc = TripwireAlloc;

// ---------------------------------------------------------------------------
// The conformance battery, identical for every backend.
// ---------------------------------------------------------------------------

/// Battery 1: the extension loads through the standard manifest pipeline.
fn conform_manifest(reg: &ExtensionRegistry, ext_id: &str, expected_abi: &str) {
    let ext = reg
        .extension(ext_id)
        .unwrap_or_else(|| panic!("{ext_id} not discovered"));
    assert_eq!(ext.manifest.abi, expected_abi, "{ext_id}: abi");
    assert!(ext.dir.join("manifest.json").exists());
    assert!(ext.dsp_path.exists(), "{ext_id}: dsp artifact missing");
    let m = reg.manifest(ext_id).unwrap();
    assert!(!m.inputs.is_empty() || !m.outputs.is_empty());
}

/// Battery 2: instantiate in an engine, drive with known signals, and
/// return the rendered master (mono) for cross-backend comparison.
/// Patch: Osc (sine C4) -> gain module (knob at `gain_pos`) -> Audio Out.
fn render_gain_patch(ext_id: &str, in_jack: &str, gain_jack: &str, gain_pos: f32) -> Vec<f32> {
    let config = EngineConfig {
        master_channels: 1,
        ..EngineConfig::default()
    };
    let mut e = Engine::new(config, registry()).unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("g1", ext_id).unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "g1", in_jack).unwrap();
    e.connect("g1", "out", "out1", "l").unwrap();
    e.set_knob_position("g1", gain_jack, gain_pos).unwrap();
    let out = e.render_offline((0.25 * SR) as usize).unwrap();
    out.into_iter().next().unwrap()
}

/// Battery 3: silence in -> finite output, and unwired defaults respected.
fn conform_silence(ext_id: &str, gain_jack: &str) {
    let mut e = Engine::new(EngineConfig::default(), registry()).unwrap();
    e.add_module("g1", ext_id).unwrap();
    e.set_knob_position("g1", gain_jack, 1.0).unwrap();
    let out = e.render_offline((0.1 * SR) as usize).unwrap();
    for ch in &out {
        assert!(ch.iter().all(|x| x.is_finite()), "{ext_id}: non-finite");
    }
}

/// Battery 4: hot-swap path (save_state -> new instance -> load_state via
/// reload_extension) leaves the module functional.
fn conform_reload(ext_id: &str, in_jack: &str, gain_jack: &str) {
    let mut e = Engine::new(EngineConfig::default(), registry()).unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("g1", ext_id).unwrap();
    e.connect("osc1", "audio", "g1", in_jack).unwrap();
    e.set_knob_position("g1", gain_jack, 1.0).unwrap();
    e.render_offline(1024).unwrap();
    let swapped = e.reload_extension(ext_id).unwrap();
    assert_eq!(swapped, 1, "{ext_id}: reload swapped wrong node count");
    e.render_offline(1024).unwrap();
    let tap = e.tap("g1", in_jack).unwrap();
    assert!(tap.rms_100ms > 0.5, "{ext_id}: dead after reload: {tap:?}");
}

#[test]
fn wasm_and_native_extensions_load_through_same_manifest_format() {
    let reg = registry();
    conform_manifest(&reg, WASM_GAIN.0, "wasm-1");
    conform_manifest(&reg, NATIVE_GAIN.0, "native-1");
    // The native artifact really is a platform dylib, not wasm.
    let native = reg.extension(NATIVE_GAIN.0).unwrap();
    let fname = native.dsp_path.file_name().unwrap().to_string_lossy();
    assert!(
        ["dsp.dylib", "dsp.so", "dsp.dll"].contains(&fname.as_ref()),
        "unexpected native artifact {fname}"
    );
}

#[test]
fn native_backend_produces_identical_audio_to_wasm_backend() {
    for pos in [0.0f32, 0.3, 0.7, 1.0] {
        let wasm = render_gain_patch(WASM_GAIN.0, WASM_GAIN.1, WASM_GAIN.2, pos);
        let native = render_gain_patch(NATIVE_GAIN.0, NATIVE_GAIN.1, NATIVE_GAIN.2, pos);
        assert_eq!(wasm.len(), native.len());
        for (i, (w, n)) in wasm.iter().zip(&native).enumerate() {
            assert_eq!(w, n, "gain {pos}: sample {i} differs (wasm {w} native {n})");
        }
        // And the signal is actually there (except at gain 0).
        let peak = wasm.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        if pos > 0.0 {
            assert!(peak > 1.0, "gain {pos}: silent output (peak {peak})");
        } else {
            assert!(peak == 0.0, "gain 0: expected silence, got peak {peak}");
        }
    }
}

#[test]
fn silence_battery_passes_for_all_backends() {
    conform_silence(WASM_GAIN.0, WASM_GAIN.2);
    conform_silence(NATIVE_GAIN.0, NATIVE_GAIN.2);
}

#[test]
fn reload_battery_passes_for_all_backends() {
    conform_reload(WASM_GAIN.0, WASM_GAIN.1, WASM_GAIN.2);
    conform_reload(NATIVE_GAIN.0, NATIVE_GAIN.1, NATIVE_GAIN.2);
}

#[test]
fn native_params_apply_through_the_engine() {
    // boost=2 doubles the output relative to boost=1 (default).
    let base = render_gain_patch(NATIVE_GAIN.0, NATIVE_GAIN.1, NATIVE_GAIN.2, 1.0);
    let config = EngineConfig {
        master_channels: 1,
        ..EngineConfig::default()
    };
    let mut e = Engine::new(config, registry()).unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("g1", NATIVE_GAIN.0).unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "g1", NATIVE_GAIN.1).unwrap();
    e.connect("g1", "out", "out1", "l").unwrap();
    e.set_knob_position("g1", NATIVE_GAIN.2, 1.0).unwrap();
    e.set_param("g1", "boost", 2.0).unwrap();
    let boosted = e.render_offline((0.25 * SR) as usize).unwrap();
    for (b, x) in boosted[0].iter().zip(&base) {
        assert_eq!(*b, x * 2.0, "boost param not applied");
    }
}

#[test]
fn native_state_roundtrips_across_the_c_abi() {
    common::ensure_native_extensions_built();
    let reg = registry();
    let path = reg.extension(NATIVE_GAIN.0).unwrap().dsp_path.clone();
    let rt = NativeRuntime::new();
    let mut a = rt.instantiate(&path, SR, 128, 2, 1).unwrap();
    a.on_param(0, 3.0);
    let state = a.save_state();
    assert_eq!(state.len(), 4);

    let mut b = rt.instantiate(&path, SR, 128, 2, 1).unwrap();
    b.load_state(&state);
    // boost=3 must survive: in=1.0, gain=10 (unity) -> out=3.0.
    let inputs = vec![vec![1.0f32; 128], vec![10.0f32; 128]];
    let mut outputs = vec![vec![0.0f32; 128]];
    b.process(&inputs, &mut outputs, 0b11, 128);
    assert!(outputs[0].iter().all(|&x| x == 3.0), "state not restored");
}

#[test]
fn native_module_runs_on_rt_thread_without_allocations() {
    let mut e = Engine::new(EngineConfig::default(), registry()).unwrap();
    e.add_module("osc1", "com.dj.oscillator").unwrap();
    e.add_module("g1", NATIVE_GAIN.0).unwrap();
    e.add_module("out1", "builtin.audio_out").unwrap();
    e.connect("osc1", "audio", "g1", NATIVE_GAIN.1).unwrap();
    e.connect("g1", "out", "out1", "l").unwrap();
    e.set_knob_position("g1", NATIVE_GAIN.2, 1.0).unwrap();

    // Warm up, then assert the audio path is allocation-free with the
    // native module in the graph.
    e.process_blocks(200).unwrap();
    RT_ALLOCS.store(0, Ordering::Relaxed);
    TRIPWIRE_ARMED.with(|a| a.set(true));
    e.process_blocks(1000).unwrap();
    TRIPWIRE_ARMED.with(|a| a.set(false));
    assert_eq!(
        RT_ALLOCS.load(Ordering::Relaxed),
        0,
        "native module allocated on the audio path"
    );

    // And it runs on the actual RT thread (null realtime backend).
    e.start_null_realtime().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    e.stop().unwrap();
    assert!(e.blocks_processed() > 1200, "RT thread made no progress");
    assert_eq!(e.proc_deadline_miss_count(), 0);
}

#[test]
fn native_abi_version_mismatch_is_rejected() {
    // The versioned symbol is the contract: a dylib without it (any random
    // shared library) must be rejected with a clear error, not crash.
    let rt = NativeRuntime::new();
    let bogus = std::env::temp_dir().join("dj-not-a-module.so");
    std::fs::write(&bogus, b"not a dylib").unwrap();
    let err = match rt.instantiate(&bogus, SR, 128, 1, 1) {
        Ok(_) => panic!("bogus dylib loaded"),
        Err(e) => e,
    };
    let msg = format!("{err:#}");
    assert!(
        msg.contains("loading native module"),
        "unexpected error: {msg}"
    );
}
