# PRD: Modular DJ Workstation ("the app")

A desktop application for building and performing DJ sets from composable signal-processing modules, in the spirit of VCV Rack, with first-class DJ decks, local ML analysis (BPM/key/stems), and an integrated track-search-and-purchase workflow.

**Owner:** Robert
**Status:** Draft v0.1
**Platform target:** macOS (Apple Silicon, M4-class) first; architecture should not preclude Windows/Linux.

---

## 1. Goals

- Mix DJ sets with full creative control: decks, loops, beat/phase/speed manipulation, plus arbitrary signal routing between user-built modules.
- Composable extension system: users write modules (Rust → WASM by default), wire them together, and collapse subgraphs into reusable macro modules.
- Fast iteration: hot reload of modules into a running patch without app restart.
- Local ML cataloguing: BPM, key, and stem separation computed on-device with open-source models sized for an M4 MacBook.
- Easy library growth: file import, in-app track search (iTunes Search API), deep-link purchase (iTunes Store), watch-folder auto-import.

## 2. Non-goals

- Streaming-service audio playback (Tidal etc.). Metadata/browsing integrations only; audio is always local files the user owns.
- DRM circumvention of any kind.
- Sandboxing/security guarantees for third-party modules (native escape hatch is explicitly trusted code).
- Mobile.

---

## 3. Architecture Overview

- **Shell:** Tauri. React frontend (module UIs, patch canvas, library). Rust backend (audio engine, graph, module hosting, ML pipeline, file/library management).
- **Audio engine:** Rust, `cpal` for device I/O, `symphonia` for decoding. Fixed block size (default 128 samples @ 48kHz, configurable). Real-time thread runs the module graph; no allocation, no locking on the RT path (lock-free ring buffers / triple-buffered state between UI and RT threads).
- **Module backends:** two, behind one interface:
  - **WASM (default):** sandboxed-ish, portable, hot-reloadable. Runtime: `wasmtime` with SIMD enabled.
  - **Native dylib (escape hatch):** C ABI for ABI stability, for heavy DSP or code needing native libraries.
- **ML pipeline:** native, host-side, runs off the audio thread on a worker pool. Modules consume results; they never run models themselves.
- **Persistence:** patches, macro modules, library DB (SQLite), and per-track analysis stored under a single user data directory.

---

## 4. Signal & Value Conventions (host-enforced)

- All signals are `f32`, nominal range **[-10, +10]** (modular-synth style). Hard clip only at the audio device boundary; internal signals may exceed range.
- **Pitch convention:** 1 unit/octave, `0.0` = C4 (261.626 Hz). `freq_hz = 261.626 * 2^v`. Hover UI shows value → Hz → nearest note name.
- **Audio vs. control rates:** single wire type as far as the user is concerned (VCV-style). *Open question §12: whether the engine internally distinguishes block-rate control signals for performance.*
- **Gate/trigger convention:** high ≥ 1.0, low ≤ 0.0. Buttons emit down (high) / up (low) edges.

### Input activation display (host-rendered)
- Every input jack glows proportionally to its current activation.
- Signals fluctuating faster than 10 Hz display the **RMS amplitude over a 100 ms sliding window**; slower signals display instantaneous value.
- Hover on any jack or wire: numeric value, Hz/note conversion, and a live mini-oscilloscope (host samples the wire; modules do nothing).

---

## 5. Extension Format

An extension is a folder (or `.djx` zip) laid out as:

```
my-module/
  manifest.json
  dsp.wasm            # or dsp.dylib (native escape hatch)
  ui.js               # React component bundle (optional; host renders default panel if absent)
  assets/             # optional
```

### 5.1 manifest.json (schema sketch)

```json
{
  "id": "com.robert.wavefolder",
  "name": "Wavefolder",
  "version": "0.3.1",
  "abi": "wasm-1",                  // "wasm-1" | "native-1"
  "inputs": [
    { "id": "in",    "name": "In",    "default": 0.0 },
    { "id": "fold",  "name": "Fold",  "default": 1.0,
      "knob": { "style": "continuous", "min": 0.0, "max": 8.0, "curve": "exp" } }
  ],
  "outputs": [
    { "id": "out", "name": "Out" }
  ],
  "params": [
    { "id": "dc_block", "name": "DC Block", "type": "toggle", "default": true }
  ],
  "ui": "ui.js",                    // optional
  "latency_samples": 0
}
```

Notes:
- Every **input** is simultaneously a jack and a knob target. If a wire is plugged in, the knob becomes an attenuverter/offset on the incoming signal (host behavior, uniform everywhere).
- **Knob config is data, not code.** Right-click any input to reconfigure: style (`continuous` | `switch` | `button` | `stepped`), endpoint values (any two values for switch/interp range), curve (`linear` | `exp` | `log` | custom breakpoints). User overrides are saved in the patch, not the manifest.
- `params` are non-signal settings (UI-thread only, delivered to DSP as change events).

### 5.2 DSP interface (WASM and native share it conceptually)

Rust trait as seen by module authors (a thin `dj-module-sdk` crate wraps the raw ABI):

```rust
pub trait Module {
    fn new(ctx: &InitCtx) -> Self;                  // sample_rate, block_size
    fn process(&mut self, io: &mut ProcessIo);      // called per block, RT thread
    fn on_param(&mut self, id: ParamId, value: ParamValue);
    fn save_state(&self) -> Vec<u8>;                // for hot reload / patch save
    fn load_state(&mut self, bytes: &[u8]);
}

pub struct ProcessIo<'a> {
    pub inputs:  &'a [&'a [f32]],   // one slice per declared input, block_size long
    pub outputs: &'a mut [&'a mut [f32]],
    pub connected_inputs: InputMask, // which jacks actually have wires
}
```

Raw ABI (what the host actually calls; the SDK hides this):
- WASM exports: `mod_new`, `mod_process(ptr_io)`, `mod_on_param`, `mod_save`, `mod_load`, with a shared linear-memory IO struct.
- Native: identical set of `extern "C"` symbols (`abi: "native-1"`). Host never sees Rust types across the boundary.

Rules for `process`: no allocation, no blocking, no syscalls. WASM runtime enforces most of this; native modules are on the honor system.

### 5.3 UI interface

- `ui.js` default-exports a React component. **Recommendation:** host provides a single shared React instance via import map (lighter, hot-reload friendly); extensions must build against the host's React major version. *Open question §12.*
- The component receives a `ModuleHandle`:

```ts
interface ModuleHandle {
  paramValue(id: string): ParamValue;          // reactive
  setParam(id: string, v: ParamValue): void;
  signalTap(jackId: string): ReadableTap;      // ~30fps downsampled, for custom visualizers
  size: { w: number; h: number };
}
```

- The host draws all standard chrome: panel frame, jacks, knobs, activation glow, hover scopes, right-click menus. Module UIs render only the *custom* area between the jack rows. A module with no `ui.js` still gets a fully functional auto-generated panel from its manifest.

### 5.4 Hot reload

- Host watches extension folders. On `dsp.wasm` change: call `save_state` on live instances → instantiate new WASM → `load_state` → atomic swap at a block boundary. Patch and wiring untouched; audible glitch ≤ 1–2 blocks.
- On `ui.js` change: frontend module swap via Vite HMR, no audio interruption.
- Native dylibs: reload attempted via unload/reload, but a restart prompt is acceptable (v1 may just prompt).

---

## 6. Patch Graph & Macro Modules

- The patch is a directed graph of module instances and wires. Cycles allowed with a one-block delay inserted automatically (standard modular behavior).
- **Macro modules:** select modules → "Collapse to Module". User picks which internal jacks/params are promoted to the macro's external interface. Result is **pure data**: a saved subgraph + interface mapping, stored in the user library with a stable ID.
- Instances reference the macro by ID. **Editing a macro's internals edits every instance** across all patches. (Patch save records macro version; on version mismatch at load, prompt: update or fork.)
- Macros nest arbitrarily.

### Graph engine API (internal, sketch)

```rust
graph.add_module(ext_id) -> NodeId
graph.connect(from: (NodeId, OutJack), to: (NodeId, InJack)) -> WireId
graph.set_knob(node, jack, KnobConfig)
graph.collapse(nodes: &[NodeId], interface: MacroInterface) -> MacroId
graph.tap(WireId) -> RingBufferReader      // powers scopes/glow, RT-safe
```

---

## 7. DJ Deck Module (built-in, native)

The flagship built-in module. Multiple instances = multiple decks.

**Capabilities**
- Load any library track; waveform overview + zoomed view.
- **Beatgrid:** auto from analysis, hand-adjustable (tap tempo, nudge, anchor markers).
- **Cues & loops:** 8 hot cues, saved loops, loop in/out/halve/double. All stored as track metadata in the library DB (survives across patches).
- **Transport & feel:** play/pause, pitch fader (±8/16/50%), pitch bend, jog-style phase nudge, keylock (elastique-style time-stretch), reverse, slip mode.
- **Sync:** beat-sync and phase-sync to another deck or to a global clock module.
- **Stems:** when analysis is complete, four per-stem gain/mute controls (vocals / drums / bass / other), each also exposed as signal inputs.

**Jacks (abridged)**
- Inputs: `speed`, `phase_nudge`, `cue_trig[1..8]`, `loop_toggle`, `stem_gain[4]`, `play_gate`
- Outputs: `audio_l`, `audio_r`, `stem_l/r[4]`, `beat_clock` (trigger per beat), `bar_clock`, `phase` (0..10 ramp per bar), `bpm` (as pitch-style value)

This makes the deck scriptable from the patch: sequence cue jumps, sidechain off `beat_clock`, automate stem gains from an LFO module, etc.

## 7.1 MIDI Module (built-in, native)

Hardware controllers enter the patch as a module, keeping the graph the single source of truth for all control flow.

- One instance per connected MIDI device (auto-detected via `midir`; hot-plug aware).
- **Learn mode:** click an output slot → wiggle a hardware control → mapping created. Each mapped control becomes a named output jack (`fader_1`, `jog_l`, `pad_3`, ...).
- CC/note values scale to the standard [-10, +10] range; notes emit gate-style down/up like buttons. 14-bit CC and pitch bend supported. Jog wheels emit signed relative ticks scaled to a nudge-friendly range.
- Mappings are saved per device (by name/ID) in the user library and reused across patches.
- MIDI **input** jacks on the module (e.g. `led[..]`) let the patch drive controller LEDs/feedback (v1.x).
- Because it's just a module, mapping a controller to a deck is wiring: `midi.fader_1 → deck.speed`. Macros can bundle a controller + decks + mixer into one reusable "my rig" module.

## 7.2 Audio Output Module (built-in, native)

Multi-channel routing is also just modules.

- `Audio Out` module: N input jacks mapped to physical output channels of the selected device. Multiple instances allowed (e.g. main out on ch 1-2, headphone cue on ch 3-4 of a DJ interface).
- A stock `Cue Mixer` macro ships with the app: crossfader, per-deck cue buttons, cue/master blend to a headphone out — the classic DJ monitoring workflow, built from ordinary modules and fully editable.

---

## 7.3 Gesture Control Module (built-in, native)

Real-time webcam processing as a control surface — hands become another controller, no hardware required.

- Live webcam feed rendered in the module's panel, with detection results visualized on top of the video.
- On-device hand tracking (MediaPipe-Hands-class model via ONNX Runtime, CoreML EP on macOS, per the §8.2 pipeline conventions); no frames ever leave the machine.
- A **mode system**, explicitly extensible so new interaction modes can be added later. Two modes ship first:
  - **Wheel mode:** two on-screen wheels overlaid on the feed, each divided into **8 radial sections plus a ninth center section** (18 zones total). Each zone is mappable to a **switch**: hand presence inside the zone drives a gate-style output (0/1, §4 conventions). Active zones highlight on the overlay.
  - **Landmark mode:** per-hand skeletal landmarks (fingertips, knuckles, palm, wrist) are detected, **named** (e.g. `L.index.tip`, `R.thumb.tip`), and drawn with labels on the feed. Two mapping types:
    - **Presence** of a named point in frame → switch/gate output.
    - **Distance** between any two named points → continuous value output (normalized 0..1, smoothed).
- Like the MIDI module (§7.1), every mapping materializes as an **output jack** wireable into anything — VCA gain, deck crossfader, ADSR gate, playback speed, etc.
- Mappings are created with a learn-style flow from the module UI and **persist in the patch** (directory format, §12.3).
- Video capture and inference run off the RT thread; control values cross into the graph via the same lock-free path as MIDI. Target ≥ 30 fps detection; dropped/failed frames degrade gracefully (hold last value, decay gates after a timeout).
- macOS camera permission (AVFoundation) is requested on first use with a sane denial fallback (module shows a prompt, outputs stay at 0).

---

## 8. Library, Analysis & Acquisition

### 8.1 Library
- SQLite DB: tracks, file paths, analysis results, DJ metadata (grids/cues/loops), macro modules, tags, crates/playlists.
- Import: drag-and-drop, file picker, and a **watch folder** (default: `~/Downloads` and a user music folder) that auto-imports new audio files (mp3/m4a/aac/flac/wav/aiff) and queues analysis.
- Optional: import beatgrids/cues from rekordbox (XML export / `pyrekordbox`-style DB read) for users with existing libraries. (v1.x, not v1.0.)

### 8.2 Analysis pipeline (native, background workers)
- **BPM / key / beatgrid:** Essentia models (or comparable open-source, e.g. madmom-style beat tracking ported/bound to Rust via ONNX).
- **Stems:** demucs (htdemucs) via ONNX Runtime with CoreML execution provider. Target: ≤ 1× realtime on M4 for stemming; BPM/key near-instant.
- Results cached per track (content-hashed); stems stored as FLAC alongside originals in app storage.
- UI: per-track analysis status; batch queue with progress.

### 8.3 Search & acquisition

Acquisition is pluggable behind one internal trait so new sources are cheap to add:

```rust
pub trait AcquisitionProvider {
    fn search(&self, q: Query) -> Vec<TrackResult>;   // metadata, artwork, preview URL
    fn acquire(&self, t: &TrackResult) -> Acquire;    // Download(url) | DeepLink(url)
    fn license(&self, t: &TrackResult) -> LicenseInfo;
}
```

Unified in-app search fans out across enabled providers; results are tagged by source and license. `Download` providers pull the file straight into the library (auto-analyze on arrival); `DeepLink` providers open the store page and rely on the watch folder.

**v1 providers**

| Provider | Content | Acquire | Notes |
|---|---|---|---|
| **iTunes Search API** | Commercial catalog (100M+ tracks) | DeepLink | No key needed; 30s previews; the "famous songs" path |
| **Freesound** | Samples, hits, field recordings, loops | Download | OAuth2 API key (free); CC licenses; perfect for one-shots and texture material for modules |
| **Jamendo** | Full CC-licensed songs (indie artists) | Download | Free API key; direct MP3 download endpoints |
| **Internet Archive** | Live concert recordings (etree), 78s, public-domain audio | Download | Open JSON API, no key; the Live Music Archive is a goldmine for DJ material with taper-friendly bands |
| **Musopen** | Public-domain classical recordings | Download | REST API; classical stems layer beautifully over electronic beds |

- License info (CC-BY, CC0, PD, commercial) is stored per track in the library and shown in the browser — matters if a set ever gets published.
- Watch folder remains the universal fallback for any store without an API (Qobuz, Bandcamp, etc.).



---

## 9. Frontend (React in Tauri)

- **Patch canvas:** pan/zoom module board, wire dragging, right-click knob config, multi-select, collapse-to-macro.
- **Library view:** search (local + iTunes), crates, analysis status, drag tracks onto decks.
- **Hover inspector:** value readout, Hz/note conversion, oscilloscope — implemented once in the host, driven by `graph.tap`.
- Signal telemetry to UI at ~30 fps via a single shared ring buffer per tapped wire; no per-frame IPC storms.

---

## 10. Performance Targets

- End-to-end added latency ≤ 10 ms at 128-sample blocks, 48 kHz.
- 4 decks with stems + 50 modest WASM modules without glitching on M4.
- WASM overhead budget: assume 1.2–2× native for DSP; WASM SIMD (128-bit, maps to NEON) enabled.
- Zero allocations/locks on the RT thread (enforced in review; debug-mode allocation tripwire).

## 10.1 CI & Regression Testing (GitHub Actions)

All quality gates run in **GitHub Actions** from M0 onward:

- **CI workflow on every push/PR:** build (Rust workspace + frontend), lint (`cargo clippy -D warnings`, `cargo fmt --check`, ESLint/Prettier for the frontend), and the full test suite (`cargo test --workspace`, frontend unit/component tests).
- **E2E audio regression tests:** test cases are **serialized patches** (the directory-tree patch format of §12.3) checked into the repo — e.g. a set of modules wired together (`Osc → VCA → Audio Out`, MIDI-driven ADSR envelopes, etc.). CI loads each patch, renders it offline to a WAV, and compares the result against a committed golden rendering (exact hash where determinism allows; otherwise spectral/RMS comparison within tolerance). Any engine or module change that alters rendered audio fails CI until the golden files are intentionally regenerated (via a documented `regen-goldens` script) and the diff is reviewed.
- New modules and new engine features must ship with at least one serialized-patch E2E case covering them.
- Milestone acceptance tests ([A] criteria below) are wired into CI as they land, so regressions in earlier milestones are caught while later ones are built.

## 11. Milestones & Acceptance Criteria

Each criterion is tagged: **[A]** = verifiable by an agent driving the software programmatically (CLI, test harness, UI automation, offline audio render); **[H]** = requires a human using the app (ears, feel, visual judgment). The engine must support offline rendering (patch → WAV, faster than realtime) and virtual MIDI injection from M0 specifically so agents can verify audio behavior. All [A] criteria run in GitHub Actions per §10.1.

### M0 – Engine + Extension System
Tauri shell, cpal audio, graph engine, WASM ABI + SDK crate, manifest loading, hot reload, auto-generated panels, knob config, wire glow/hover scopes. Ships with five modules:
- **Oscillator** (sine/saw/square/tri; `pitch`, `fm`, `sync` in; `audio` out)
- **VCA** (`in`, `gain/cv` in; `out`)
- **ADSR** (`gate`, `retrig` in; `env` out) — **custom UI**: interactive envelope curve display (drag A/D/S/R segments directly on the graph), not the default auto-panel
- **Audio Output** (device/channel selector; N inputs → hardware)
- **MIDI** (per-device; learn mode; an output jack for every mapped control, connectable to any input)

**Acceptance:**
- [x] **[A]** Single script at the top of the README (`./run.sh` or `npm start`) builds and launches the app from a fresh clone; exits nonzero on failure.
- [x] **[A]** Patch `MIDI → ADSR(gate) → VCA(cv)`, `Osc → VCA → Audio Out`, driven by virtual MIDI and rendered offline, produces audio whose amplitude envelope matches the configured ADSR within tolerance.
- [ ] **[H]** The same patch, played live with a hardware controller, sounds right through the speakers — envelope feels responsive, no clicks.
- [x] **[A]** ADSR custom UI: automated UI test drags each segment and asserts the underlying params change; params round-trip through patch save/load.
- [ ] **[H]** The envelope display looks good and dragging feels natural.
- [x] **[A]** Hot reload: modify oscillator Rust, rebuild to WASM; harness asserts the running patch swaps it in without restart, wiring and state intact, audio stream uninterrupted (xrun counter unchanged ± tolerance).
- [x] **[A]** Right-click knob config (style/endpoints/curve) via UI automation persists in the saved patch and reloads identically.
- [x] **[A]** Jack activation values and 100 ms RMS smoothing are exposed via a telemetry API and match expected values for known test signals.
- [ ] **[H]** Glow, hover readouts, and oscilloscopes look correct and legible during live use.
- [x] **[A]** Patch saves as a directory tree; moving one knob and re-saving produces a diff touching exactly one file.
- [x] **[A]** RT-thread allocation/lock tripwire passes; xrun counter reports zero over a 10-minute stress patch at 128-sample blocks.
- [x] **[A]** GitHub Actions CI (§10.1) is green: build + lint + full test suite, plus at least three serialized-patch E2E audio regression cases (with committed goldens and a `regen-goldens` script) covering the M0 modules.

### M1 – Sound Library + Playback
SQLite library, watch-folder auto-import, drag-and-drop import, acquisition provider framework (iTunes deep-link, Freesound + Jamendo download; Internet Archive and Musopen fast-follow), license tracking, and a **Playback module**: load a library track, `play_gate`/`speed` in, `audio_l/r` out — connectable to Audio Out or anything else.

**Acceptance:**
- [x] **[A]** A file copied into the watch folder is imported and appears in the library DB within seconds.
- [ ] **[H]** Drag-and-drop import works from Finder.
- [x] **[A]** Search API fans out across enabled providers; results carry source and license tags; preview URLs resolve and play.
- [x] **[A]** A Freesound/Jamendo result downloads directly into the library (test account/keys in CI).
- [x] **[A]** An iTunes result triggers a deep-link open of the correct store URL.
- [ ] **[H]** Complete a real iTunes purchase; the downloaded file auto-imports via the watch folder.
- [x] **[A]** Playback module: offline render of a known test file matches the source (null test); `speed = +1 octave-equivalent` doubles playback rate (measured by duration and pitch analysis of the render); output routed through a VCA attenuates correctly.
- [x] **[A]** Library and licenses persist across an app restart in the test harness.

### M2 – DJ Deck
Full deck module (§7): waveform views, manual beatgrids (tap/nudge/anchor), 8 hot cues, saved loops, pitch fader, phase nudge, keylock, slip, sync between decks; plus a stock **Crossfader/Mixer module**. No MIDI work (MIDI shipped in M0 — decks are controllable by wiring).

**Acceptance:**
- [ ] **[A]** Two deck instances render simultaneously; sweeping the crossfader input produces the expected gain curves on each deck's contribution (verified in offline render).
- [ ] **[A]** Cues and loops set via API persist in the library and reappear when the track is reloaded in a fresh patch.
- [ ] **[A]** Beat-sync: with manually set beatgrids, syncing deck B to deck A aligns tempo and phase within ±1 ms sustained over 60 s of render.
- [ ] **[A]** `beat_clock` pulses land on the configured beatgrid timestamps within one audio block; driving an ADSR from it produces envelopes at beat positions.
- [ ] **[A]** Keylock: rendered output at ±8% tempo holds pitch within ±10 cents (pitch-tracked).
- [ ] **[H]** Keylock artifacts are acceptable to the ear at typical DJ tempo ranges.
- [ ] **[H]** Beat-matching two tracks by hand with pitch fader and phase nudge feels workable; waveforms and cue behavior match DJ expectations.
- [ ] **[H]** `MIDI.jog → deck.phase_nudge` with a hardware jog wheel: nudge/scratch response feels natural, with no deck-side MIDI code.

### M3 – Intelligence
On-device analysis pipeline: BPM/key/auto-beatgrid (Essentia/ONNX), demucs stems (ONNX + CoreML EP), background worker queue, per-track caching, stem jacks live on the deck.

**Acceptance:**
- [ ] **[A]** Importing a track auto-queues analysis; BPM and key land in the DB without user action; on a labeled test set of steady electronic tracks, BPM is exact (or ×/÷2) ≥ 95% and key correct ≥ 80%.
- [ ] **[A]** Auto-beatgrid on the test set aligns to annotated beats closely enough that sync passes the M2 phase criterion with no manual adjustment.
- [ ] **[A]** Stemming a 4-minute track completes at ≤ 1× realtime on M4 hardware (timed in CI on target machine); cache hit on re-request is instant; re-import of an identical file (content hash) does not re-analyze.
- [ ] **[A]** Stem gains: muting each stem in an offline render measurably removes that stem's energy; stem outputs are independently routable.
- [ ] **[H]** Stem separation quality is good enough for live layering (vocals clean enough to solo over another track).
- [ ] **[H]** Auto-beatgrids on real-world material (the Daft Punk / Nina Simone / Courtney Barnett library) are trustworthy in practice.

### M4 – Macros, Native Escape Hatch & Polish
Collapse-to-macro with library storage and edit propagation, native dylib module backend, rekordbox import, MIDI LED feedback, perf pass against §10 targets.

**Acceptance:**
- [ ] **[A]** Collapse a selection to a macro via API; instantiate it twice; edit internals; both instances reflect the change; version-mismatch prompt logic covered by tests.
- [ ] **[A]** A native (dylib) module loads through the same manifest, passes the same conformance suite as WASM modules, and runs on the RT thread.
- [ ] **[A]** Perf: 4 decks with stems + 50 WASM modules, 10-minute offline-and-live stress run, zero xruns on M4 hardware.
- [ ] **[H]** Overall feel pass: latency, UI responsiveness, and stability during a real 30-minute mixed set.

### M5 – Gesture Control (Webcam)
The Gesture Control module (§7.3): live webcam feed with detection overlay, extensible mode system, Wheel mode (2 wheels × 8 radial sections + center = 18 mappable switch zones), Landmark mode (named hand landmarks; presence → switch, point-pair distance → continuous), learn-style mapping flow, output jacks wireable into any module, mappings persisted in the patch.

**Acceptance:**
- [ ] **[A]** Detection pipeline runs on recorded test videos (fixtures checked into the repo, camera mocked as a frame source): known hand poses produce the expected named landmarks within pixel tolerance, deterministically across runs.
- [ ] **[A]** Wheel mode: synthetic/recorded input placing a hand in each of the 18 zones toggles exactly the mapped switch output for that zone and no others; zone activation events land in the graph as gate values per §4.
- [ ] **[A]** Landmark mode: presence mapping emits gate 1 when the named point is detected and decays to 0 after the configured timeout when it disappears; distance mapping between two named points produces a normalized, smoothed continuous output that tracks a scripted pinch-open/close fixture monotonically.
- [ ] **[A]** Mappings (zone → switch, presence → switch, distance → continuous) round-trip through patch save/load (directory format), including mode selection and wheel layout.
- [ ] **[A]** E2E: a serialized patch wiring `Gesture(distance) → VCA(cv)` with `Osc → VCA → Audio Out`, driven by a recorded gesture fixture, renders audio whose amplitude tracks the gesture (golden case per §10.1).
- [ ] **[A]** Inference throughput ≥ 30 fps on M4 hardware (timed in CI on target machine); frame drops hold last value, gates decay after timeout; RT thread remains allocation/lock-free (tripwire passes with the module active).
- [ ] **[A]** Mode system is registered via an extensible registry: adding a stub third mode in a test requires no changes to the module core, only registration.
- [ ] **[H]** Camera permission flow works on macOS; denial shows the fallback prompt and the app stays stable.
- [ ] **[H]** Overlay visualization (wheels, labeled landmarks) is legible and tracks hands with no perceptible lag; controlling a VCA by pinch distance feels playable in a live set.

## 12. Resolved Decisions

1. **Extension UIs use the host's shared React instance** (via import map). Lighter, HMR-friendly; extensions build against the host's React major version, which the manifest `abi` field implicitly pins.
2. **All wires are audio-rate in v1.** Simpler engine, uniform semantics. If M4-milestone perf targets miss, add transparent block-rate demotion for wires whose sources declare themselves slow — an engine optimization, invisible to users.
3. **Patches, macros, and mappings are directory trees of small JSON/TOML files** — git-friendly by design. One file per module instance and per wire bundle, stable IDs, formatted deterministically so diffs are meaningful and merges are survivable. A `.djpatch` zip export exists only for sharing, not as the working format.
4. **Multi-channel output ships in M0** via the Audio Out module (§7.2); headphone cueing is table stakes for a DJ app.
5. **MIDI is a built-in module (§7.1), shipping in M0** so hardware control works from day one — decks pick it up later purely by wiring.
