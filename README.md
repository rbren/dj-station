# dj-station

A modular, extensible DJ workstation — VCV-Rack-style patching for DJs. See
[PRD.md](PRD.md) for the full product spec. This repo currently implements
**Milestone M0: Engine + Extension System**.

## Quick start

```sh
./run.sh
```

That single script builds what's needed from a fresh clone (WASM
extensions, frontend, app) and launches it. It exits nonzero on any
failure.

- **macOS, or Linux with a display** (and `libwebkit2gtk-4.1-dev`
  installed): launches the Tauri GUI.
- **Headless Linux** (CI, servers — no display/audio device): launches the
  engine in headless mode via `dj-cli`, streaming a demo patch on the null
  realtime backend. Use `./run.sh --smoke` to instead render 2 s of the demo
  patch to a WAV and exit.
- `./run.sh --test` builds everything and runs the full test suite + lint
  instead of launching (`--no-launch` is an alias).

Prerequisites: Rust (rustup; `wasm32-unknown-unknown` target is added
automatically), Node ≥ 20, and on Linux `libasound2-dev` (ALSA headers).

## Tests

```sh
cargo test --workspace && (cd app && npm ci && npm test)
```

Lint: `cargo clippy --workspace --all-targets -- -D warnings && cargo fmt
--all --check && (cd app && npm run lint)`. All of this also runs in GitHub
Actions (`.github/workflows/ci.yml`) as separate build / lint / test jobs.

E2E audio golden files live in `crates/dj-engine/tests/e2e/`; regenerate
them after an intentional DSP change with `./scripts/regen-goldens.sh`.

## Architecture

```
crates/
  dj-module-sdk    Safe Rust SDK for writing modules: implement `Module`,
                   call `export_module!` → wasm-1 ABI exports (mod_new,
                   mod_process, mod_on_param, mod_save, mod_load).
  dj-engine        The audio engine:
                     graph.rs      RT-safe directed patch graph; cycles allowed
                                   (back edges read the previous block — one-block
                                   delay); preallocated buffers, no alloc/locks on
                                   the RT path.
                     engine.rs     Control-side API + backends: offline render
                                   (faster than realtime, → WAV), null realtime
                                   (paced, headless), cpal (real devices). Xrun
                                   counter, lock-free command queue to the RT core.
                     wasm_host.rs  wasmtime host (SIMD enabled) implementing the
                                   wasm-1 ABI; hot reload = save_state → new
                                   instance → load_state → atomic swap at a block
                                   boundary.
                     telemetry.rs  Jack activation: instantaneous value for slow
                                   signals, 100 ms sliding RMS for signals >10 Hz;
                                   exposed via `Engine::tap` (graph.tap API).
                     knob.rs       Data-driven knob config (style/endpoints/curve),
                                   per-patch overrides, attenuverter+offset when
                                   wired.
                     patch.rs      Patch persistence: directory tree of small,
                                   deterministically formatted JSON files — one per
                                   module instance, one per wire bundle. Moving one
                                   knob touches exactly one file.
                     builtin.rs    Native modules: Audio Output (N ch, multiple
                                   instances) and MIDI (midir hardware input, learn
                                   mode, mapped controls become output jacks,
                                   virtual MIDI injection for tests).
  dj-cli           Headless harness: create/render/run/save/load patches,
                   inject virtual MIDI, print telemetry.
extensions/        WASM extensions (each folder: manifest.json + dsp.wasm +
                   optional ui.js): oscillator, vca, adsr (custom React UI in
                   ui-src/, bundled to ui.js).
app/               React frontend (Vite + TS). Manifest-driven auto-generated
                   module panels: every input is jack + knob; right-click knob
                   config editor; telemetry-driven jack readouts; custom module
                   UIs (ADSR envelope editor with draggable segments).
  src-tauri/       Tauri 2 shell hosting the engine; IPC commands wire the UI
                   to the engine (own workspace, built when webkit is present).
```

Signal conventions (PRD §4): f32 wires, nominal [-10, +10]; pitch 1 unit/oct
with 0.0 = C4 (261.626 Hz); gate high ≥ 1.0, low ≤ 0.0. Default block size
128 @ 48 kHz (configurable).

## Milestone status

M0 is implemented; see [reports/M0_REPORT.md](reports/M0_REPORT.md) for the
acceptance-criteria → test mapping and known gaps.
