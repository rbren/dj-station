//! AUDIO-rendering benchmarks for the three heavy UI surfaces — the Rack,
//! the Grid and the Clip page — and the CI gate over them.
//!
//! The frontend suites (`app/tests/RackPerf.test.tsx`, `GridPerf.test.tsx`,
//! `ClipPerf.test.tsx`) measure what those pages cost to DRAW. These
//! measure what the same three surfaces cost to SOUND, which is a
//! different pipeline in a different language:
//!
//!   * `rack`  — the engine graph itself: many modules and wires rendered
//!               offline (`Engine::process_blocks`), the same path the RT
//!               callback runs a block at a time;
//!   * `grid`  — `dj_engine::track_fx`, the per-row effects rack the Grid
//!               bounces offline before the webview plays it;
//!   * `clip`  — `dj_analysis::clip::render_clip`, the Clip page's edit
//!               turned into audio.
//!
//! WHY THEY LIVE IN THE `perf_m4` TARGET. Every dj-engine test binary
//! statically links wasmtime (~18 MB, a full link each), so suites are
//! grouped into as few targets as possible — see `tests/integration/main.rs`.
//! These want the same quiet machine `perf_m4` does and run in the same CI
//! job, so they are modules of it rather than a fourth standalone target.
//!
//! WHAT IS ASSERTED. Throughput as a MULTIPLE OF REALTIME, never a raw
//! wall clock: 60 s of audio rendered in 3 s is 20× realtime whatever the
//! box is, so one threshold is meaningful on a laptop and on a loaded
//! runner. Thresholds carry several times the measured headroom
//! (`reports/PERF_BASELINES.md` has the numbers and how to update them),
//! because the point is to catch a tenfold regression, not a 20% one.
//!
//! Fixtures are generated here — long synthetic tones, big synthetic
//! racks — so nothing large is committed. `DJ_PERF_HEAVY=1` (set by the
//! CI perf job) makes every fixture several times bigger.

pub mod bench;

mod clip;
mod grid;
mod rack;
