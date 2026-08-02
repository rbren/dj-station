# dj-station

A modular, extensible DJ workstation — VCV-Rack-style patching for DJs. See
[PRD.md](PRD.md) for the full product spec. This repo currently implements
**Milestone M0 (Engine + Extension System)** and **Milestone M1 (Sound
Library + Playback)**.

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

## Library & acquisition (M1)

The sound library lives in a single per-user data directory (PRD §3):
`$DJ_STATION_DATA` if set, else the platform data dir + `dj-station`
(e.g. `~/.local/share/dj-station` on Linux, `~/Library/Application
Support/dj-station` on macOS). It contains `library.sqlite` (tracks, content
hashes, licenses, tags, crates, watch folders) and `downloads/` (provider
downloads).

- **Watch folders**: folders registered in the library are polled; new
  audio files (mp3/m4a/aac/flac/wav/aiff) are content-hashed, imported, and
  queued for analysis (the analysis pipeline itself is M3).
- **Per-store search**: the library view shows one tab per enabled
  provider (plus the local library). Each tab searches that store only,
  with store-specific filters; every result is tagged by source and
  license, and the license is stored per track on import. (The Rust hub
  also still supports fanning a query out across all providers.)

| Provider | Acquire | Filters | Enabling |
|---|---|---|---|
| iTunes Search | Deep link to the store page | storefront country, exclude explicit | always on (keyless) |
| Internet Archive | Direct download — **Creative Commons material only** | collection, sort | always on (keyless) |
| Freesound | Direct download (HQ MP3 preview rendition) | CC license type, max length, sort | set `FREESOUND_API_KEY` (free key from freesound.org/apiv2) |
| Jamendo | Direct download (MP3) | sort, vocal/instrumental, tempo | set `JAMENDO_CLIENT_ID` (free key from devportal.jamendo.com) |
| Musopen | — | — | fast-follow (API requires manually approved accounts) |

Deep-link purchases (iTunes) land via the watch folder like any other file.

The **Playback module** (`builtin.playback`) plays a library track in the
patch graph: inputs `play_gate` (≥ 1.0 plays, low pauses) and `speed`
(pitch-style, +1.0 = double rate), outputs `audio_l`/`audio_r`. Decoding
(symphonia) and sample-rate conversion happen off the RT thread; the loaded
track path persists with the patch.

Real-network provider smoke tests are optional: keyless ones (iTunes,
Internet Archive) soft-skip on network failure; Freesound/Jamendo ones only
run when their env keys are present. CI relies on local mock HTTP servers.

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
                     playback.rs   Built-in Playback module (M1): plays a library
                                   track; play_gate/speed in, audio_l/r out; decode
                                   + SR conversion off the RT thread.
  dj-library       Sound library (M1): SQLite DB (tracks, hashes, licenses,
                   tags, crates, watch folders), watch-folder auto-import,
                   acquisition provider framework (iTunes deep-link,
                   Freesound/Jamendo/Internet Archive download) with
                   per-store filters and unified fan-out search.
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

M0 and M1 are implemented; see [reports/M0_REPORT.md](reports/M0_REPORT.md)
and [reports/M1_REPORT.md](reports/M1_REPORT.md) for the
acceptance-criteria → test mapping and known gaps.
