# dj-station

A modular, extensible DJ workstation — VCV-Rack-style patching for DJs. See
[PRD.md](PRD.md) for the full product spec. This repo currently implements
**Milestone M0 (Engine + Extension System)**, **Milestone M1 (Sound
Library + Playback)**, and **Milestone M2 (DJ Deck)**.

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

Optional at runtime: **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** for the
library's YouTube tab (`brew install yt-dlp`, `pipx install yt-dlp`, or your
package manager). Nothing else needs it — without it the tab is still there
and reports the missing binary when you search.

Also optional: a **stem separation model**, in two flavours.
`scripts/install-demucs.sh` provisions `htdemucs_ft` (the demucs CLI) under
`custom/demucs/`, and `scripts/install-scnet.sh` provisions **SCNet XL
IHF** under `custom/scnet/` (a venv with
[MSST](https://github.com/ZFTurbo/Music-Source-Separation-Training) and
torch, plus the ~214 MB checkpoint; both take `--cuda` for CUDA wheels).
Demucs is the default because it is much the faster; SCNet separates
better (MUSDB18 SDR 10.09 vs 9.0) and is picked per track from the
Library's **Stems** column, which names the model behind each track's
stems — changing it puts the track back into "analyzing" until the new
model has run, and nothing is thrown away, so switching back is instant.
With a model installed, tracks are separated on their own in the
background — anything downloaded from YouTube first, then the rest of the
library — so the Clip page can drop the vocals out of a track without
anyone waiting on a model or pressing anything. Without one the Clip page
says so and the stem switches stay off; the decks' stem controls are
unaffected (they use the built-in DSP band split). Tracks separated by a
model that is no longer on the menu keep those stems and are not redone.
`DJ_AUTOSTEM=off|downloads|all` (default `all`) chooses what gets
separated automatically, `DJ_DEMUCS_BIN` / `DJ_DEMUCS_MODEL` /
`DJ_DEMUCS_ARGS` point demucs elsewhere, and `DJ_SCNET_PYTHON`,
`DJ_SCNET_CONFIG` / `DJ_SCNET_CKPT`, `DJ_SCNET_MODEL` and `DJ_SCNET_ARGS`
(e.g. `--device_ids 0`) do the same for SCNet.

## App icon / logo

The app icon is the single file **`app/src-tauri/icons/icon.png`** (512×512
RGBA PNG — Tauri requires RGBA), referenced from `bundle.icon` in
`app/src-tauri/tauri.conf.json`. Replace that file and rebuild the shell
(`cargo build --manifest-path app/src-tauri/Cargo.toml --release`, or just
`./run.sh`) — the icon is embedded at compile time by `tauri-build`, so a
frontend-only rebuild won't pick it up. There is no tray icon, no favicon
and no in-app logo asset. Bundling is currently off (`bundle.active:
false`); if you turn it on, generate the full multi-format set (`.ico`,
`.icns`, sized PNGs) with `npx @tauri-apps/cli icon <source.png>` from
`app/` (the CLI is not a repo dependency) and list the results in
`bundle.icon`.

**Linux dock/taskbar caveat:** the embedded PNG only sets the per-window
icon. GNOME (especially on Wayland) ignores that and resolves the
dock/alt-tab icon via the window's app-id (`dj-station`, from the binary
name) → an installed `.desktop` file → its `Icon=`. Running the bare
binary via `./run.sh` installs neither, so you get the generic "exec"
square. Fix without bundling: install the icon as
`~/.local/share/icons/hicolor/512x512/apps/dj-station.png` plus a
`~/.local/share/applications/dj-station.desktop` with `Icon=dj-station`
and `StartupWMClass=dj-station`.

## State & saves — `custom/`

All persistent state lives in **`custom/` inside this checkout** (the repo
`./run.sh` runs from), so saves travel with the repo:

| Path | What |
|---|---|
| `custom/patches/` | named saved patches (directory trees of JSON) |
| `custom/autosave/` | crash-recovery autosave of the live patch |
| `custom/library.sqlite` | track DB, DJ metadata (cues/loops/grids), user macros, watch folders |
| `custom/downloads/` | provider downloads |
| `custom/stems/<hash>/` | AAC stem-separation cache (DSP flat, one subdirectory per model); FLAC caches from older builds are converted in the background |
| `custom/demucs/` | stem model: demucs venv (`htdemucs_ft`, the default) |
| `custom/scnet/` | stem model: MSST venv, config and checkpoint |

Set **`DJ_STATION_DATA_DIR`** to put state somewhere else
(`DJ_STATION_DATA` is honored as the older spelling). If no checkout can be
located — a packaged bundle, say — the app falls back to `custom/` under
its working directory.

`custom/` is tracked in git on purpose; its committed `.gitignore` excludes
only machine-local churn (`stems/`, `demucs/`, `scnet/`, `downloads/`, `autosave/`,
the SQLite WAL sidecars and the migration marker) — regenerable caches, not saves.

**Migration.** The first launch that uses `custom/` **copies** the old
platform data dir (`~/.local/share/dj-station`, `~/Library/Application
Support/dj-station`) into it — nothing is moved or deleted. A `.migrated`
marker in `custom/` makes this one-shot: later launches never re-copy, and
a `custom/` that already holds state is left alone even without a marker.

## Tests

```sh
cargo test --workspace && (cd app && npm ci && npm test)
```

Lint: `cargo clippy --workspace --all-targets -- -D warnings && cargo fmt
--all --check && (cd app && npm run lint)`. All of this also runs in GitHub
Actions (`.github/workflows/ci.yml`) as separate build / lint / test jobs.

E2E audio golden files live in `crates/dj-engine/tests/e2e/`; regenerate
them after an intentional DSP change with `./scripts/regen-goldens.sh`.

**Performance.** The Rack, Grid and Clip pages are benchmarked on both
sides of the IPC boundary — how long they take to DRAW (`cd app && npm run
test:perf`, jsdom) and how fast they RENDER AUDIO (`cargo test -p dj-engine
--release --test perf_m4 perf_ui`, reported as a multiple of realtime).
Both run in CI on every push; `DJ_PERF_HEAVY=1` blows the fixtures up to
the size the main-only `perf` job uses. The render pipeline is
instrumented, and the UI gates are counts rather than stopwatches
wherever a count will do — buckets read, sockets looked up, cells left in
the DOM — so they mean the same thing on a loaded CI runner as on a quiet
desk. Measured figures, the stages each bench attributes its time to, and
how to move a threshold:
[`reports/PERF_BASELINES.md`](reports/PERF_BASELINES.md).

## Library & acquisition (M1)

The sound library lives in the single data directory described under
[State & saves](#state--saves--custom) — `custom/` in the checkout, or
`$DJ_STATION_DATA_DIR`. It contains `library.sqlite` (tracks, content
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
| YouTube | Audio download via `yt-dlp` | sort (relevance/date), length | always on (keyless); needs `yt-dlp` installed |
| Freesound | Direct download (HQ MP3 preview rendition) | CC license type, max length, sort | set `FREESOUND_API_KEY` (free key from freesound.org/apiv2) |
| Jamendo | Direct download (MP3) | sort, vocal/instrumental, tempo | set `JAMENDO_CLIENT_ID` (free key from devportal.jamendo.com) |
| Musopen | — | — | fast-follow (API requires manually approved accounts) |

Deep-link purchases (iTunes) land via the watch folder like any other file.

**Downloads run in the background.** Hitting Download queues a job on a
backend thread; the button shows its progress and the track appears in the
local list (queued for analysis) when it lands. Nothing blocks the UI, and
a failed job reports its error in the library view.

**YouTube tab.** Searching runs
`yt-dlp --dump-json --flat-playlist "ytsearch<N>:<query>"` and lists
title/channel/duration/thumbnail; Download fetches the best *audio-only*
stream (m4a/mp3 preferred, so **no ffmpeg needed** — nothing is
transcoded) into `custom/downloads/` and imports it as a normal track that
analyzes and loads onto a deck like any other. The binary defaults to
`/usr/local/bin/yt-dlp_macos` (point `DJ_YTDLP_BIN` at a different one to
override); when it is missing, search and download
fail with an install hint instead of the tab disappearing. YouTube results
are tagged license `unknown` on purpose — the search API exposes no
license, so check the video's terms before using its audio.
`DJ_YTDLP_ARGS` adds flags to every yt-dlp call — set it to
`--cookies-from-browser firefox` (or another browser) if YouTube answers
with *"Sign in to confirm you're not a bot"*.

The **Playback module** (`builtin.playback`) plays a library track in the
patch graph: inputs `play_gate` (≥ 1.0 plays, low pauses) and `speed`
(pitch-style, +1.0 = double rate), outputs `audio_l`/`audio_r`. Decoding
(symphonia) and sample-rate conversion happen off the RT thread; the loaded
track path persists with the patch.

The **Audio module** (`builtin.audio`) plays any library track and clocks the
rack from it: inputs `play`, `bpm`, `speed` and `loop`, outputs
`audio_l`/`audio_r` plus `clock` (a trigger per beat, free-running while
paused). BPM and speed are one tempo in two units — move either and the
other follows, so pushing the BPM up plays the track faster and the clock
stays locked to what you hear. Loading a track adopts the BPM the library
analyzed and sets speed back to 1x. Tracks loop by default (the ⟳ button on
the panel, or the `loop` jack), with the beat clock restarting on every
pass. The panel picks the track and draws it as a waveform with a live
playhead; the rest is ordinary knob-backed inputs you can wire, MIDI-map or
automate.

The **DJ Deck module** (`builtin.deck`, M2) is the full DJ deck (PRD §7):
transport with pitch fader (`speed` × `pitch_range` param, default ±8 %) and
`phase_nudge`, 8 hot cues (`cue_trig1..8` jacks), loops (`loop_toggle` jack,
halve/double, saved loops), manual beatgrids (tap tempo / nudge / re-anchor),
keylock (WSOLA-aligned granular time-stretch), slip mode, reverse, and
beat-sync to another deck (tempo + phase lock). Outputs `audio_l/r` plus
`beat_clock`, `bar_clock`, `beat_phase`, and `bpm_cv` for driving the rest of
the rack. Hot cues, saved loops, and beatgrids live in the library DB as
track metadata and follow the track across patches; the loaded track and
sync partner persist with the patch. The stock **Crossfader**
(`builtin.crossfader`) mixes two stereo pairs with an equal-power law
(`xfade` input, −10 = full A, +10 = full B).

Real-network provider smoke tests are optional: keyless ones (iTunes,
Internet Archive) soft-skip on network failure; Freesound/Jamendo ones only
run when their env keys are present; the YouTube one needs
`DJ_YTDLP_SMOKE=1` (it wants both the network and a real `yt-dlp`). CI
relies on local mock HTTP servers and, for YouTube, a recorded `yt-dlp`
JSON fixture plus a fake binary (`crates/dj-library/tests/youtube.rs`).

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
                     deck.rs       DJ Deck module (M2/M3): hot cues, loops, manual
                                   beatgrid, keylock (WSOLA), slip/reverse,
                                   beat-sync between decks; beat_clock/bar_clock/
                                   phase/bpm outputs; RT-safe command rings; four
                                   routable stem jacks with per-stem gain params.
                     mixer.rs      Crossfader module (M2): equal-power two-channel
                                   stereo crossfade.
  dj-library       Sound library (M1): SQLite DB (tracks, hashes, licenses,
                   tags, crates, watch folders), watch-folder auto-import,
                   acquisition provider framework (iTunes deep-link,
                   Freesound/Jamendo/Internet Archive download) with
                   per-store filters and unified fan-out search.
  dj-analysis      Analysis pipeline (M3): pure-Rust BPM/auto-beatgrid
                   (onset + comb-filter tempo) and key detection
                   (chromagram + Krumhansl profiles); stem separation
                   behind a StemSeparator trait (deterministic HPSS-style
                   band separator always available; htdemucs_ft through
                   the demucs CLI and SCNet XL IHF through MSST's
                   inference CLI when installed, per track; optional ONNX
                   Runtime backend — CoreML EP on macOS, CPU EP elsewhere
                   — loads a model file when configured); background
                   worker that drains the library's analysis queue; stems
                   cached as AAC keyed by content hash and separator.
  dj-cli           Headless harness: create/render/run/save/load patches,
                   inject virtual MIDI, print telemetry.
extensions/        WASM extensions (each folder: manifest.json + dsp.wasm +
                   optional ui.js): oscillator, vca, adsr (custom React UI in
                   ui-src/, bundled to ui.js).
app/               React frontend (Vite + TS). Manifest-driven auto-generated
                   module panels: every input is jack + knob; right-click knob
                   config editor; telemetry-driven jack readouts; custom module
                   UIs (ADSR envelope editor with draggable segments; DJ deck
                   panel with waveform overview + zoom, hot cues, loops,
                   beatgrid and sync controls).
  src-tauri/       Tauri 2 shell hosting the engine; IPC commands wire the UI
                   to the engine (own workspace, built when webkit is present).
```

Signal conventions (PRD §4): f32 wires, nominal [-10, +10]; pitch 1 unit/oct
with 0.0 = C4 (261.626 Hz); gate high ≥ 1.0, low ≤ 0.0. Default block size
128 @ 48 kHz (configurable).

## Milestone status

M0, M1, M2, M3, and M4 are implemented; see
[reports/M0_REPORT.md](reports/M0_REPORT.md),
[reports/M1_REPORT.md](reports/M1_REPORT.md),
[reports/M2_REPORT.md](reports/M2_REPORT.md),
[reports/M3_REPORT.md](reports/M3_REPORT.md), and
[reports/M4_REPORT.md](reports/M4_REPORT.md) for the
acceptance-criteria → test mapping and known gaps. M5 (webcam gesture
control) was delivered and later removed — the camera module's in-webview
MediaPipe hand tracking feeding the `Hands` module replaces it.

M4 adds: collapse-to-macro (multi-select in the rack, macros stored in
the library DB with versioning and an update-vs-fork prompt on
mismatch, arbitrary nesting), the native (dylib) module backend
(`abi = "native-1"`, same manifest + conformance suite as WASM;
unsandboxed trusted code — sample in `extensions/gain-native`),
MIDI LED feedback (module outputs drive controller LEDs as note/CC out
messages), rekordbox XML import (tracks, beatgrids, hot cues, loops
into the library DB), and the PRD §10 perf stress test
(`crates/dj-engine/tests/perf_m4.rs`).

