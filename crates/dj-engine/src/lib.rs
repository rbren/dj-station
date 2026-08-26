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

pub mod audio;
pub mod beat_clip;
pub mod builtin;
pub mod choreo;
pub mod deck;
pub mod decks;
pub mod engine;
pub mod graph;
pub mod hands;
pub mod history;
pub mod knob;
pub mod launch_control;
pub mod macro_store;
pub mod macros;
pub mod manifest;
pub mod mixer;
pub mod module_host;
pub mod native_host;
pub mod patch;
pub mod playback;
pub mod qwerty;
pub mod registry;
pub mod stretch;
pub mod telemetry;
pub mod wasm_host;

pub use builtin::{MidiMapKind, MidiOutEvent, MidiOutSink, MockMidiSink};
pub use choreo::{ChoreoState, ChoreoTrack, ChoreoTrackData, NoteStep, CHOREO_ID};
pub use engine::{
    normalize_module_name, Backend, Engine, EngineConfig, DEFAULT_BLOCK_SIZE, DEFAULT_SAMPLE_RATE,
};
pub use history::UndoHistory;
pub use knob::{Curve, KnobConfig, KnobState, KnobStyle, WireStyle};
pub use launch_control::LAUNCH_CONTROL_ID;
pub use macro_store::{MacroImport, MacroStore, MACROS_DIR_NAME};
pub use macros::{MacroDef, MacroInterface, MacroJack, MacroLibrary, MacroParam, MacroPreviewNode};
pub use manifest::Manifest;
/// Re-exported so the shell can hold a hardware MIDI connection alive
/// (`Engine::connect_launchcontrol_hardware`) without depending on midir.
#[cfg(feature = "midi-hw")]
pub use midir;
pub use patch::{MacroInstanceFile, PatchDoc};
pub use registry::ExtensionRegistry;
pub use telemetry::JackTelemetry;

/// Pitch convention: 1 unit/octave, 0.0 = C4 (261.626 Hz). PRD §4.
pub fn pitch_to_hz(v: f32) -> f32 {
    261.626 * (2.0f32).powf(v)
}
