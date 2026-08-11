//! Aggregated dj-engine integration tests.
//!
//! Every suite here is an ordinary `mod` rather than its own `tests/*.rs`
//! file: each separate test target statically links wasmtime and pays a
//! full thin-LTO link (~18 MB, ~1 min each in CI), so one binary per suite
//! dominated total build time. Adding a suite = one file under
//! `tests/integration/` plus one `mod` line below.
//!
//! Suites that must NOT live here (keep them as standalone targets):
//!   * `rt_safety` / `perf_m4` — realtime stress; they need a quiet process,
//!     not one sharing cores with the rest of the suite.
//!   * `hot_reload` — spawns nested `cargo build` runs from a temp dir.
//!   * `e2e_suite` — golden-audio cases, run with `--test-threads=1`.

#[path = "../common/mod.rs"]
mod common;

mod analysis_sync;
mod conformance;
mod deck;
mod deck_library;
mod deck_stems;
mod envelope;
mod gesture;
mod graph_edit;
mod macros;
mod midi_led;
mod midi_poly;
mod modules_effects;
mod modules_sequencing;
mod modules_shaping;
mod modules_sources;
mod modules_utilities;
mod persistence;
mod playback;
mod telemetry;
mod undo;
mod wire_summing;
