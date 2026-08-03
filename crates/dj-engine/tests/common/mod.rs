//! Shared helpers for dj-engine integration tests.
#![allow(dead_code)]

use dj_engine::{Engine, EngineConfig, ExtensionRegistry};
use std::path::PathBuf;
use std::sync::Once;

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

pub fn extensions_dir() -> PathBuf {
    repo_root().join("extensions")
}

/// Build the wasm extensions once per test binary (cheap when up to date).
pub fn ensure_extensions_built() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let script = repo_root().join("scripts/build-extensions.sh");
        let status = std::process::Command::new("bash")
            .arg(&script)
            .status()
            .expect("failed to run build-extensions.sh");
        assert!(status.success(), "extension build failed");
    });
}

/// Build the native-1 sample extension once per test binary. Separate
/// workspace/target dir, so it can build while the root target is locked.
pub fn ensure_native_extensions_built() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let script = repo_root().join("scripts/build-native-extensions.sh");
        let status = std::process::Command::new("bash")
            .arg(&script)
            .status()
            .expect("failed to run build-native-extensions.sh");
        assert!(status.success(), "native extension build failed");
    });
}

pub fn registry() -> ExtensionRegistry {
    ensure_extensions_built();
    ExtensionRegistry::discover(&[extensions_dir()]).unwrap()
}

pub fn default_engine() -> Engine {
    Engine::new(EngineConfig::default(), registry()).unwrap()
}

/// Build the canonical M0 demo patch:
/// MIDI -> ADSR(gate) -> VCA(cv), Osc -> VCA -> Audio Out (ch1+ch2).
pub fn build_demo_patch(engine: &mut Engine) {
    engine.add_module("midi1", "builtin.midi").unwrap();
    engine.add_module("osc1", "com.dj.oscillator").unwrap();
    engine.add_module("adsr1", "com.dj.adsr").unwrap();
    engine.add_module("vca1", "com.dj.vca").unwrap();
    engine.add_module("out1", "builtin.audio_out").unwrap();
    engine
        .add_midi_mapping("midi1", "note", 60, "pad_1")
        .unwrap();
    engine.connect("midi1", "pad_1", "adsr1", "gate").unwrap();
    engine.connect("osc1", "audio", "vca1", "in").unwrap();
    engine.connect("adsr1", "env", "vca1", "cv").unwrap();
    engine.connect("vca1", "out", "out1", "l").unwrap();
    engine.connect("vca1", "out", "out1", "r").unwrap();
}

/// Peak absolute value per fixed-size window.
pub fn window_peaks(signal: &[f32], window: usize) -> Vec<f32> {
    signal
        .chunks(window)
        .map(|c| c.iter().fold(0.0f32, |m, &x| m.max(x.abs())))
        .collect()
}
