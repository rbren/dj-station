//! M0 acceptance: modify oscillator Rust source, rebuild to WASM; the
//! running patch swaps it in without restart, wiring and state intact,
//! audio stream uninterrupted (xrun counter unchanged ± tolerance).
//!
//! The test copies the oscillator extension into a temp folder, runs the
//! engine live on the null-realtime backend with the folder watcher active,
//! edits the Rust source (amplitude 5.0 -> 2.5), rebuilds dsp.wasm, and
//! asserts the running audio switches to the new DSP without the engine
//! restarting, while the waveform param (state) survives the swap.

mod common;

use dj_engine::{Engine, EngineConfig, ExtensionRegistry};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Copy the oscillator extension into `dir` as a standalone crate.
fn setup_live_extension(dir: &Path) -> PathBuf {
    let src = common::extensions_dir().join("oscillator");
    let ext_dir = dir.join("oscillator");
    std::fs::create_dir_all(ext_dir.join("src")).unwrap();
    std::fs::copy(src.join("manifest.json"), ext_dir.join("manifest.json")).unwrap();
    std::fs::copy(src.join("src/lib.rs"), ext_dir.join("src/lib.rs")).unwrap();
    std::fs::copy(src.join("dsp.wasm"), ext_dir.join("dsp.wasm")).unwrap();
    let sdk = common::repo_root().join("crates/dj-module-sdk");
    std::fs::write(
        ext_dir.join("Cargo.toml"),
        format!(
            "[package]\nname = \"dj-ext-oscillator\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n\
             [lib]\ncrate-type = [\"cdylib\"]\n\n\
             [dependencies]\ndj-module-sdk = {{ path = \"{}\" }}\n\n\
             [workspace]\n\n\
             [profile.release]\nopt-level = 3\n",
            sdk.display()
        ),
    )
    .unwrap();
    ext_dir
}

/// Rebuild the modified extension crate to wasm and install dsp.wasm.
fn rebuild_extension(ext_dir: &Path) {
    let status = std::process::Command::new("cargo")
        .args(["build", "--release", "--target", "wasm32-unknown-unknown"])
        .current_dir(ext_dir)
        .status()
        .expect("cargo build failed to start");
    assert!(status.success(), "wasm rebuild failed");
    let artifact = ext_dir.join("target/wasm32-unknown-unknown/release/dj_ext_oscillator.wasm");
    // Copy via temp + rename so the watcher never sees a partial file.
    let tmp = ext_dir.join("dsp.wasm.tmp");
    std::fs::copy(&artifact, &tmp).unwrap();
    std::fs::rename(&tmp, ext_dir.join("dsp.wasm")).unwrap();
}

fn master_rms(engine: &Engine) -> f32 {
    engine.tap_master(0).unwrap().rms_100ms
}

#[test]
fn hot_reload_swaps_running_module_without_restart() {
    common::ensure_extensions_built();
    let tmp = tempfile::tempdir().unwrap();
    let ext_dir = setup_live_extension(tmp.path());

    let registry = ExtensionRegistry::discover(&[tmp.path()]).unwrap();
    let mut engine = Engine::new(EngineConfig::default(), registry).unwrap();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    engine.add_module("out1", "builtin.audio_out").unwrap();
    engine.connect("osc1", "audio", "out1", "ch1").unwrap();
    // Square wave: RMS == amplitude, making the swap observable, and the
    // param must survive the reload (re-applied to the new instance).
    engine.set_param("osc1", "waveform", 2.0).unwrap();

    engine.start_null_realtime().unwrap();
    let watcher = engine.start_watcher(Duration::from_millis(100)).unwrap();

    // Let the stream settle; amplitude 5.0 square -> RMS 5.0.
    std::thread::sleep(Duration::from_millis(500));
    let rms_before = master_rms(&engine);
    assert!(
        (rms_before - 5.0).abs() < 0.1,
        "pre-reload RMS {rms_before} != 5.0"
    );
    let blocks_before = engine.blocks_processed();

    // Modify the Rust source (amplitude 5.0 -> 2.5) and rebuild to WASM
    // while the engine keeps running.
    let lib_rs = ext_dir.join("src/lib.rs");
    let source = std::fs::read_to_string(&lib_rs).unwrap();
    let modified = source.replace("const AMPLITUDE: f32 = 5.0;", "const AMPLITUDE: f32 = 2.5;");
    assert_ne!(source, modified, "amplitude constant not found");
    std::fs::write(&lib_rs, modified).unwrap();
    rebuild_extension(&ext_dir);

    // Measure xruns across the swap itself (the wasm rebuild above may
    // starve CPUs on small CI machines, which is environmental, not a
    // property of the swap).
    let xruns_before = engine.xrun_count();

    // The watcher should pick up the change; pump until the swap happens.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut swapped = 0;
    while swapped == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
        swapped += engine.pump_watcher(&watcher).unwrap();
    }
    assert_eq!(swapped, 1, "watcher did not hot-reload the oscillator");

    // Give the 100 ms RMS window time to reflect the new amplitude.
    std::thread::sleep(Duration::from_millis(500));
    let rms_after = master_rms(&engine);
    assert!(
        (rms_after - 2.5).abs() < 0.1,
        "post-reload RMS {rms_after} != 2.5 (new DSP not active or wiring lost)"
    );

    // The audio stream never stopped: blocks kept advancing and the xrun
    // counter is unchanged within tolerance.
    let blocks_after = engine.blocks_processed();
    assert!(
        blocks_after > blocks_before + 100,
        "engine stalled: {blocks_before} -> {blocks_after}"
    );
    let xruns_after = engine.xrun_count();
    assert!(
        xruns_after <= xruns_before + 2,
        "xruns increased across reload: {xruns_before} -> {xruns_after}"
    );

    engine.stop().unwrap();
}

/// State transfer during swap: save_state -> new instance -> load_state.
/// Verified at the engine level with a stopped engine (deterministic):
/// the oscillator phase continues seamlessly across the swap.
#[test]
fn reload_preserves_module_state() {
    let mut engine = common::default_engine();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    engine.add_module("out1", "builtin.audio_out").unwrap();
    engine.connect("osc1", "audio", "out1", "ch1").unwrap();

    // Render half a cycle so the phase is mid-waveform, swap, keep rendering.
    let out1 = engine.render_offline(4096).unwrap();
    engine.reload_extension("com.dj.oscillator").unwrap();
    let out2 = engine.render_offline(4096).unwrap();

    // A fresh (state-less) instance would restart at phase 0 and jump;
    // with state transfer the waveform continues: compare against an
    // uninterrupted render.
    let mut reference = common::default_engine();
    reference.add_module("osc1", "com.dj.oscillator").unwrap();
    reference.add_module("out1", "builtin.audio_out").unwrap();
    reference.connect("osc1", "audio", "out1", "ch1").unwrap();
    let full = reference.render_offline(8192).unwrap();

    for (i, (&a, &b)) in out1[0]
        .iter()
        .chain(out2[0].iter())
        .zip(&full[0])
        .enumerate()
    {
        assert!(
            (a - b).abs() < 1e-4,
            "sample {i} diverged after reload: {a} vs {b}"
        );
    }
}
