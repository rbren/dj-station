//! dj-station audio engine (Milestone M0).
//!
//! - Fixed block size (default 128 @ 48 kHz, configurable).
//! - RT-safe directed patch graph (cycles allowed via one-block delay).
//! - WASM module hosting (`wasm-1` ABI) via wasmtime with SIMD.
//! - Built-in native modules: Audio Output, MIDI (virtual injection + learn).
//! - Offline (faster-than-realtime) rendering, null-realtime, and cpal backends.
//! - Jack activation telemetry (instantaneous + 100 ms RMS).
//! - Patch persistence as a directory tree of deterministic JSON files.
//! - Hot reload: watch extension folders, save/load state, atomic block-boundary swap.

pub mod builtin;
pub mod engine;
pub mod graph;
pub mod knob;
pub mod manifest;
pub mod module_host;
pub mod patch;
pub mod playback;
pub mod registry;
pub mod telemetry;
pub mod wasm_host;

pub use engine::{Engine, EngineConfig, DEFAULT_BLOCK_SIZE, DEFAULT_SAMPLE_RATE};
pub use knob::{Curve, KnobConfig, KnobState, KnobStyle};
pub use manifest::Manifest;
pub use registry::ExtensionRegistry;
pub use telemetry::JackTelemetry;

/// Pitch convention: 1 unit/octave, 0.0 = C4 (261.626 Hz). PRD §4.
pub fn pitch_to_hz(v: f32) -> f32 {
    261.626 * (2.0f32).powf(v)
}
