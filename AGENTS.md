# Agent notes for dj-station

## Test discipline — be tactical

The full release test suite is a few minutes warm (it was 20+ before the
test targets were consolidated — see below; keep it that way). Do NOT use it
as an iteration loop.

- While developing, run only the tests affected by your change, scoped
  tightly: `cargo test -p <crate> --release --test <target>` or, better, a
  single test name filter (`--test integration <name>`). Never
  `cargo test --workspace` mid-iteration.
- dj-engine test targets are declared explicitly in its `Cargo.toml`
  (`autotests = false`), because every test binary statically links wasmtime
  and costs a ~18 MB link. A new suite is a new file under
  `tests/integration/` plus one `mod` line in `tests/integration/main.rs` —
  do NOT add a new top-level `tests/*.rs`, that recreates the 20-minute
  build. New golden-audio cases go in `tests/e2e_suite/` the same way. Only
  `rt_safety`, `perf_m4`, and `hot_reload` are standalone targets, for
  reasons documented at the top of `tests/integration/main.rs`.
- Suite files live below the target root, so they refer to helpers as
  `crate::common::...` and carry no `mod common;` of their own.
- The `rt_safety` stress test honors `STRESS_SECONDS`; use
  `STRESS_SECONDS=10` locally. CI runs the full 600 s version.
- Stick to one build profile (`--release`) for test runs so the `target/`
  cache stays warm; don't alternate debug/release.
- Run `cargo fmt` and scoped clippy (`cargo clippy -p <crate> --all-targets`)
  as you go; save workspace-wide clippy for the end.
- Frontend: run a single test file during iteration
  (`npx vitest run tests/<File>.test.tsx`), not the whole vitest suite.
- Do exactly ONE full CI-equivalent pass at the end of a milestone/task:
  `cargo test --workspace --release`, workspace clippy `-D warnings`,
  `cargo fmt --all --check`, `cd app && npm run lint && npm test &&
  npm run build`, then `cargo build --manifest-path app/src-tauri/Cargo.toml`.
  If a late fix lands after that pass, re-verify only the affected scope.

## Build ordering

CI builds the frontend (`app/dist`) BEFORE the Tauri shell —
`tauri::generate_context!` embeds `app/dist` at compile time and the build
fails if it's missing.

## Conventions

- ALL persistent state roots in ONE directory resolved by
  `dj_library::paths` (`crates/dj-library/src/paths.rs`): `custom/` in the
  repo checkout (`run.sh` + `.git` found by walking up from the cwd, then
  from the exe), overridable with `DJ_STATION_DATA_DIR` (`DJ_STATION_DATA`
  is the legacy spelling), falling back to `./custom` with no checkout.
  New state goes UNDER that dir (`Library::data_dir()` /
  `default_data_dir()`) — never a fresh platform-dir lookup. The app calls
  `init_data_dir()` once in `main()`, which runs the one-shot COPY of the
  old platform data dir (never move/delete), guarded by the `.migrated`
  marker plus a presence check on the target. `custom/` is tracked in git
  (saves travel with the repo); its committed `.gitignore` excludes only
  machine-local churn (stems, downloads, autosave, SQLite WAL sidecars,
  the marker). Pinned by `crates/dj-library/tests/data_dir.rs`.
- Every new module/engine feature ships with a serialized-patch E2E golden
  audio case (see `crates/dj-engine/tests/e2e_suite/`). Existing goldens
  stay byte-identical unless intentionally regenerated and documented.
- RT thread: zero allocations/locks. Heavy work happens off the RT thread
  with lock-free handoff (see `crates/dj-engine/src/playback.rs`).
- Patches are directory trees of small JSON files; new state must round-trip
  through save/load.
- Provider smoke tests gate on env keys and must treat empty-string env vars
  as unset (CI injects unconfigured secrets as `""`).
- DJ metadata (hot cues, saved loops, beatgrids) is canonical in the
  library DB, not the patch: patches persist only the deck's track path +
  sync partner, and the app layer re-applies library metadata on
  deck_load/patch load. E2E deck cases carry grid/cue/loop state in the
  `decks` section of their `events.json` sidecar for the same reason.
- The Audio module (`builtin.audio`, `src/audio.rs` + `engine/audio_api.rs`)
  is the simple "play a library track with a clock" module: its `bpm` and
  `speed` inputs are ONE tempo in two units, mirrored on the control thread
  by `tempo_link`/`apply_tempo_link` (hooked into `set_knob_value` /
  `set_knob_position`, preserving `bpm / speed` = the track's 1x tempo).
  `audio_load` resets the pair (speed 1x, BPM from the library's analysis,
  passed in by the caller — patches persist only the track path). On the RT
  thread the two jacks are independent per-sample reads, so wiring either
  one keeps meaning exactly what its unit says. Its `loop` switch is ON by
  default (a manifest `default: SIGNAL_MAX` on a `Switch` jack) and wraps
  the playhead at the end of the file, restarting the beat clock on the
  seam; the wrap is decided BEFORE the sample read, so the first sample of
  a pass and its clock trigger land on the same frame.
- Panel playheads (deck, audio) are drawn from a `Shared` atomics struct the
  RT module publishes ONCE PER BLOCK (`position`, `rate`, `playing` as
  `AtomicU64` bit patterns / `AtomicBool`) — never from control-thread
  guesswork. The panel polls it every 100 ms and extrapolates between polls
  in a rAF loop that mutates the SVG playhead directly (`useDeckPlayhead`,
  `useAudioPlayhead`); a looping module wraps the extrapolation the same way
  the engine wraps the audio (`extrapolate` in `AudioPanel.tsx`).
  Waveform peaks come from `TrackData::peaks` on the control thread, the one
  implementation behind both `Engine::deck_waveform` and
  `Engine::audio_waveform`.
- `position_for_value` (knob.rs and its TS twin in `Knob.tsx`) resolves
  `Switch`/`Button` styles to an exact end position (0 or 1), never the 0.5
  snap threshold — that's what makes a "default on" switch survive a patch
  round trip. Pinned in `app/tests/KnobMath.test.ts`.
- Stems (M3) follow the same split: the FLAC stem cache under
  `<data_dir>/stems/<content_hash>/` is app-layer state auto-loaded by
  `apply_deck_metadata`; patches persist only the `stem_*` gain params.
  E2E cases carry stem files in the sidecar's `decks[].stems`.
- The ONNX separator is behind `dj-analysis --features onnx` and its smoke
  test gates on `DJ_STEMS_ONNX_MODEL` (unset/empty ⇒ skip). The tested
  default separator is the deterministic DSP `BandSeparator` — don't make
  CI depend on model files.
- A separator's `id()` KEYS ITS CACHE: `stems_dir_for` keeps the DSP
  fallback (`DEFAULT_SEPARATOR_ID`, the deck's auto-load path) flat at
  `<data_dir>/stems/<hash>/` and gives every other backend its own
  `<hash>/<id>/` subdirectory, so a request for `htdemucs_ft` can never be
  served the band-split stems the import-time analysis already wrote.
  `DemucsSeparator` shells out to `demucs` (minutes per track, so it runs
  through `StemJobs`, a small background job manager polled by the UI);
  its plumbing is tested against a FAKE demucs script
  (`tests/stem_separation.rs`, `#[cfg(unix)]`) — missing tooling is a
  normal, reported state, never a panic.
- Macros (M4, PRD §6): macros are GLOBAL objects in the macro store —
  `<data_dir>/macros/<macro id>.json`, a sibling of `patches/`
  (`crates/dj-engine/src/macro_store.rs`, `MACROS_DIR_NAME`). One file per
  id holds the current **base** definition; there are no version counters
  and no conflict prompts. Every macro INSTANCE owns a private copy of the
  definition it adopted, saved in the patch as
  `<patch>/macros/<instance id>.json` = `MacroInstanceFile { def, state }`
  (`def` = the adopted copy, `state` = the drifted subgraph, absent when
  unmodified). Loading a patch never consults the store: patches are
  self-contained, so a base edit can never change how a saved patch
  sounds. Three explicit verbs move definitions between the two:
  `save_macro_instance` (publish this instance as the base),
  `pull_macro_instance` (destructive re-adopt of the base) and
  `reset_macro_instance` (drop live edits back to the adopted copy) —
  each a no-op when the two sides already agree. Macros do NOT nest:
  `collapse_to_macro` rejects selections containing macro instances.
  `MacroStore::import_patch_macros` migrates pre-store patches in place
  (newest embedded definition per id seeds the base, every instance gets
  a copy, retired `macro_version` keys are dropped); it runs at app
  startup along with the one-shot move of the retired `macros` DB table
  (`Library::legacy_macros` / `drop_legacy_macros`). Expanded internal
  nodes use `/`-prefixed instance ids, so `/` is reserved in user
  instance ids. Macros are NOT collapsed in the UI: every internal
  renders as an ordinary module panel and the instance is a pure UI
  grouping (`MacroBoxes` bounding box fed by the `macro_groups` command;
  all-or-nothing select/drag/copy/delete in App.tsx). `MacroDef.positions`
  stores the members' relative rack layout (UI passthrough,
  `skip_serializing_if empty` so old goldens stay byte-stable). Right-click
  "Break Macro" -> `Engine::break_macro`: in-place control-side rename
  lifting internals to fresh top-level ids (slots/wires/DSP state
  untouched), instance record dissolves.
- Native (dylib) modules (M4, PRD §5): `abi = "native-1"`, loaded by
  `native_host.rs` via libloading through a versioned C vtable. They are
  UNSANDBOXED trusted code (trust model documented in `native_host.rs`).
  The sample `extensions/gain-native` is a standalone cargo workspace
  (host-target cdylib; own `target/` so test-time rebuilds don't fight
  the locked root target dir) built by
  `scripts/build-native-extensions.sh`; conformance tests build it on
  demand. CI lints it separately (it's outside both workspaces).
- The M4 perf stress (`tests/perf_m4.rs`) honors `STRESS_SECONDS` like
  `rt_safety.rs` (default 30 s; CI 600). The strict zero-deadline-miss
  criterion is the open on-M4-hardware PRD checkbox; on shared hosts the
  test tolerates ≤ 1 % CPU-time spikes, documented inline.
- Gesture (M5, PRD §7.3): `crates/dj-gesture` is the detection pipeline
  (frame source -> `HandDetector` -> `GestureProcessor` mode/mapping
  evaluation), all off the RT thread; `builtin.gesture` in dj-engine
  mirrors MIDI (mappings = output jacks, values cross via rtrb SPSC
  events, sample-accurate RT application, frame drops hold last value).
  Mapping/mode/wheel-layout state persists per-module in the patch
  (`GestureState`). Test fixtures are small deterministic JSON landmark
  traces under `crates/dj-gesture/tests/fixtures/` pinned to their
  generators (regenerate with `REGEN_FIXTURES=1`) — never video
  binaries. The tested default detector is the deterministic
  `MarkerDetector` on synthetic trace frames; the ONNX hand model is
  behind `dj-gesture --features onnx` and its smoke test gates on
  `DJ_GESTURE_ONNX_MODEL` (unset/empty ⇒ skip) — don't make CI depend
  on model files. New gesture modes register via `ModeRegistry` /
  `Engine::gesture_register_mode`; the processor core must stay
  mode-agnostic (a stub third mode registering with zero core changes
  is an M5 acceptance test — keep it true). E2E deck-style sidecars now
  also carry `gestures` fixture specs in `events.json`. The app's mock
  feed thread (fixture -> full pipeline at 30 fps) stands in for the
  macOS camera behind the same start/stop IPC commands.
- Choreography module (`builtin.choreo`, `crates/dj-engine/src/choreo.rs` +
  `engine/choreo_api.rs`): a beat-indexed multi-track timeline. Track
  state (`ChoreoState`) is canonical control-side, persisted per instance
  in the patch `ModuleFile` (`choreo` field) and restored via
  `choreo_set_state`; every edit compiles to an immutable `ChoreoProgram`
  shipped to the RT module over an SPSC ring (garbage ring for off-RT
  drop — the playback/track-handoff pattern). Output jacks are dynamic
  slots `t<n>` from a 64-slot budget: a track keeps its slot across
  rename/reorder so wires survive, and a note track owns two contiguous
  slots (`t<n>` pitch + `t<n+1>` velocity) — `alloc_jacks` finds a free
  contiguous run. RT timing: silent until the first clock edge; the beat
  interval is unknown until the second edge (continuous-track
  interpolation holds until then). The scale table exists twice by
  design — `SCALES` in choreo.rs and `CHOREO_SCALES` in
  `app/src/components/ChoreoPanel.tsx` — and `ChoreoPanel.test.tsx`
  parses the Rust source to pin them equal. The Tauri commands are
  `choreo_*` with per-concern `EditKey` variants for undo coalescing.
- Camera module (`extensions/camera`, `com.dj.camera`): the live webcam
  feed is pure app-layer — `ui-src/CameraUI.tsx` runs `getUserMedia` and
  renders a `<video>`; the DSP side is a buffered `in -> thru`
  pass-through so the panel can sit inline (like the scope). Camera
  enablement is deliberately EPHEMERAL app state, never persisted in the
  patch (whether a camera exists/should be on is per-machine,
  per-session); the panel mounts off and releases the MediaStream on
  disable and unmount. It is independent of the gesture subsystem.
  Permission plumbing: macOS needs `NSCameraUsageDescription`
  (`app/src-tauri/Info.plist`); Linux/webkitgtk denies user-media by
  default, so `main.rs` `setup` grants `UserMediaPermissionRequest` on
  the raw webview (shell depends on `webkit2gtk =2.0.2`, pinned to wry's).
- Camera hand tracking (MediaPipe `@mediapipe/tasks-vision`, WASM in the
  webview — never bind the C++ from Rust): per-session like the camera,
  all in `extensions/camera/ui-src/`. The runtime + `hand_landmarker.task`
  model are vendored into `app/public/mediapipe/` (gitignored) by
  `app/scripts/fetch-mediapipe-assets.mjs` (runs in `npm run dev`/`build`;
  model URL is version-pinned and SHA-256-verified; offline no-op once
  present) — the packaged app never loads from a CDN. CONVENTIONS ARE
  LOAD-BEARING, canonical write-up in `handTracking.ts`: the `<video>`
  display is CSS-mirrored but the tracker sees RAW frames; on raw frames
  MediaPipe's handedness label names the PHYSICAL hand directly (verified
  live — no swap), mapped exactly once in `physicalHand`; engine coords
  are X right (mirror view), Y UP,
  origin frame-center, [-1,1], converted once in `toEngineCoords`; the
  loop is `requestVideoFrameCallback` (never rAF) and every landmark set
  carries the frame's `mediaTime`. Later CV-output phases inherit all of
  this — `app/tests/HandTracking.test.ts` pins it with a hand-authored
  known-handedness JSON fixture (`tests/fixtures/`, never video files).
  The overlay is a separate toggleable canvas over the video (never baked
  into the texture); the landmarker wrapper tries the GPU delegate,
  falls back to CPU, and surfaces which one won in the stats readout.
  jsdom tests stub `requestVideoFrameCallback`, canvas 2D contexts and
  mock `./handLandmarker` (see CameraUI.test.tsx). The vision bundle is
  a dynamic import so it stays out of the app's startup chunk; esbuild's
  camera `ui.js` marks it external, and vite resolves it via an alias
  (ui-src lives outside the app root, so node resolution misses
  `app/node_modules`).
- Hands module (`builtin.hands`, `crates/dj-engine/src/hands.rs`): CV
  outputs derived from the camera panel's tracker — a gesture-style
  builtin with a FIXED 14-jack set (centroid X/Y 0–10 V unipolar,
  frame-center = 5 V; deltas bipolar ±10 V; scale-
  invariant pinch, 2D signed-angle thumb rotation, seen gates; only
  landmark x/y are trusted — MediaPipe z is estimated depth, never used).
  Data path: camera panel `handsFeed.ts` (discovers Hands instances via
  `engine_nodes`, ~3 s poll) -> `hands_feed` IPC (engine_lock, not
  undoable) -> `Engine::hands_feed` (`engine/hands_api.rs`; control-
  thread derivation + dedup in `HandsControl`) -> SPSC ring ->
  `HandsRtModule` (holds last value; per-jack linear ramps). DROPOUT
  POLICY: visibility is DEBOUNCED (`DEBOUNCE_FRAMES` = 2 consecutive
  camera frames to confirm appear/disappear — one glitch frame holds);
  a CONFIRMED-vanished hand's value jacks (+deltas, +centroid when no
  hand remains) decay to 0 V over `DECAY_SECONDS` (10 ms) via ramp
  events while its `seen` gate falls; a `None`/dropped frame updates
  nothing. Pinch volts are `ratio*5 - 1` clamped at 0 so a full
  physical pinch reads 0 V. The camera panel AUTO-STARTS the camera
  and tracking on mount (once per mount — manual off sticks; quiet
  no-op when getUserMedia is absent). The camera `ui.js` esbuild
  bundle marks
  `@tauri-apps/api/core` external (dynamic import, absent in tests).
  E2E sidecars carry `hands` fixture specs (`HandsTrace` JSON, synthetic
  — never video); `hands_feed_trace` is the offline/golden path.
- Params vs. inputs (post-M5 refactor): ALL WASM-module controls
  (oscillator `waveform`, ADSR `attack/decay/sustain/release`, playback
  `loop`) are ordinary knob-backed input jacks — wireable, per-patch
  knob config, set via `set_knob_value`/`set_knob_position`, never
  `set_param`. `params` are reserved for mode-style toggles on builtins
  (deck `keylock`/`reverse`/`slip`/`stem_*`); macro promoted params must
  target those. After any manifest/knob change, run
  `./scripts/regen-goldens.sh` and the full workspace suite (macro and
  perf_m4 tests reference module controls).
- FM convention: every oscillator's `fm` input is LINEAR, thru-zero FM
  scaled by an `fm_index` depth knob (0..4) —
  `f = f0 * (1 + fm/5 * index)`, so index 0 (the manifest default) is no
  FM at all, index 1 is ±100 % deviation at ±5 V, and a negative factor
  runs the phase backwards instead of rectifying. The law exists three
  times (`extensions/oscillator`, `extensions/vco`,
  `extensions/wavetable`) — change them together. The basic Oscillator's
  `fm` was exponential (added to `pitch` in 1 V/oct units) until the
  linear-FM change, which intentionally re-rendered the
  `waveforms-fm-sync` golden (that case now sets `fm_index`; every other
  golden is byte-identical because index 0 leaves the frequency exactly
  `pitch_to_hz(pitch)`).
- Units & display mapping: jack values are Volts to the engine; a
  manifest input/output may carry a `display` spec (unit string —
  default "V" — plus optional `volt_per_octave` map and per-step
  labels for stepped selectors). `JackDecl`/`OutputDecl.display` is
  passthrough metadata (the engine never computes on it); the ONE app
  formatter is `app/src/display.ts` (`formatDisplay`), used by every
  knob and jack tooltip, inputs and outputs alike. Step-label lists
  must match the knob's detent count (`display_units` integration test
  pins it) and the quantizer/LFO panels' name tables (Display.test.ts
  pins those — the manifests and the exported `SCALE_NAMES`/`SHAPES`
  arrays are the same names). The TS knob curve math in `Knob.tsx`
  mirrors knob.rs EXACTLY, including the geometric exp/log branch for
  min>0 ranges (the old squared-fallback divergence was the "LFO shows
  285 at 1 Hz" bug); KnobMath.test.ts pins both sides.
- Wired-input blend (knob.rs docs are canonical): knob-backed inputs
  blend in POSITION space — `curve(clamp01(base_pos + sig·atten/10 +
  offset))`, offset in position units — so the knob's curve shapes the
  CV and the spread tracks the baseline (exp rate knobs get a geometric
  spread; a linear knob spanning 10 units reduces to the old additive
  law). Plain wire jacks (no knob declared: audio ins, gate thrus) keep
  the additive `baseline + sig·atten + offset` law with the ±10 V rail
  clip. RT side is `BlendRt`/`CurveRt` in knob.rs (Copy, custom curves
  resampled to a 33-entry table); the TS twin is
  `spreadRange`/`attenOffsetForSpread(…, plain)` in Knob.tsx, `plain`
  derived in InputCell. wire_summing.rs and KnobMath.test.ts pin both
  laws on both sides — change all four together. Third mode:
  `WireStyle::Override` (per-jack `KnobState.wire_style`, default `cv`
  omitted from saved JSON) makes the summed signal the value, clamped
  to the knob's range in VALUE space (never through the curve; plain
  jacks clamp to the rails), knob/atten/offset inert. The app auto-picks
  it for the FIRST wire into a jack when both ends' manifests carry
  `volt_per_octave` displays (`Engine::auto_wire_style_on_connect`,
  called by the `connect_wire` command; extra wires never touch the
  mode) — pitch wires SET the note, an LFO into pitch stays CV. UI:
  "Wire mode" select in KnobConfigMenu, spread arc/cmd-drag/spread
  fields suppressed and dial dimmed under override. An overridden
  control also READS OUT the wire: `LiveOverrideKnob` (Knob.tsx, picked
  by InputCell when `wired && wire_style === 'override'`) subscribes to
  the jack's telemetry and feeds `Knob.displayPosition`, so the dial and
  mixer-style level faders move with the signal while drags keep editing
  the (inert) baseline. The subscription sits in that wrapper — never in
  InputCell or the panel — to keep the tick's re-render to one control.
- App save/load lives in the native File menu (Tauri `MenuItemBuilder`
  in `app/src-tauri/src/main.rs`); the frontend listens via
  `onMenuAction` in `src/engine.ts` (menu events re-dispatched as
  `dj-menu` CustomEvents — tests drive the dialogs by firing those).
  Any test that mocks `../src/engine` must also export `onMenuAction`
  (stub: `() => () => {}`). Destructive actions (New Patch, opening a
  patch) are gated by an unsaved-changes prompt: `patch_dirty` compares
  the live snapshot to `AppState.last_saved` (set by `mark_saved` after
  every save/load/new/demo — a fixed snapshot name so renames don't
  count), the native File > New emits `request-new` instead of acting,
  and `guardUnsaved` in App.tsx shows the Save/Discard/Cancel dialog
  (`unsaved-dialog` test ids). Engine mocks in tests need
  `patchDirty: vi.fn(async () => false)`. Keyboard shortcuts
  cmd/ctrl+S/O/N live in `app/src/fileShortcuts.ts` (`useFileShortcuts`,
  also home of the shared `isEditableTarget`): they invoke the SAME
  App.tsx actions as the File menu (New/Open inherit `guardUnsaved`) and
  never fire in editable targets or while a modal dialog is open —
  pinned by `app/tests/FileShortcuts.test.tsx`.
- `rt_safety.rs`'s realtime stress can flake when run in parallel with
  the rest of the workspace on a loaded 4-core host (proc-deadline
  assert); it passes standalone — rerun
  `cargo test -p dj-engine --release --test rt_safety` before assuming a
  regression.
- Frontend rack state lives in `app/src/rackStore.ts` (hand-rolled
  external store read via `useSyncExternalStore`, no zustand), provided
  through `RackStoreContext`; each `RackModule` subscribes to its own
  node/position/selection slice. Telemetry polls one batched
  `tap_all` IPC command (read-only, mirrors `engine_nodes` keys —
  macro internals hidden, MIDI LED / macro external jacks by name) every
  100 ms — never per-jack `tap` in a loop. App-level tests that mock
  `../src/engine` need `tapAll: vi.fn(async () => ({}))` next to `tap`.
  `app/tests/KnobMath.test.ts` pins the TS knob curve math to
  `knob.rs`; if either side's mapping changes, update both plus that
  table.
- Telemetry rendering (perf-critical, pinned by
  `app/tests/RenderCounts.test.tsx`): a telemetry tick must NEVER
  re-render a `ModulePanel`. `setTelemetry` keeps object identity per
  instance AND per jack (comparing only display/volatility/is_fast at
  display resolution); jack glows subscribe per jack (`LiveJack` →
  `useLiveJackTelemetry`, output keys are `out:<id>`) and custom UIs per
  instance (`CustomUIHost` → `useLiveInstanceTelemetry` — this is what
  keeps signalTap-at-render meters/playheads live). ModulePanel's
  `telemetry` prop is a storeless fallback only. `WireOverlay` renders
  INSIDE the pan/zoom-transformed `.rack` in unzoomed rack coordinates
  (zoom prop, non-scaling-stroke) so pan/zoom never re-measure, and its
  MutationObserver ignores attribute churn under
  `.jack/.knob/.level-meter/.module-custom-ui`. The dev-only stress
  harness (`app/src/stress/`, `npm run dev` + `?stress=N&active=F`)
  measures this path; use it before/after any change to these files.
- Anti-aliased animation (frontend): the 100 ms telemetry/status poll
  POINT-SAMPLES clock-driven visuals, which aliases past a few Hz (steps
  lit for 1-vs-2 ticks semi-randomly, skipped steps) — no poll rate fixes
  this. Sequencer playheads (step_seq, seq_switch, trig_seq, grid_seq,
  euclid, ChoreoPanel) are extrapolated client-side by
  `extensions/ui-lib/stepFollower.ts` (windowed-fit rate estimate with
  honesty rules: irregular clocks/random dir stay raw, stalls freeze,
  transport jumps re-lock) via `useStepFollowers` — render shows the
  prediction, a rAF loop patches the DOM between polls, NEVER React
  state (RenderCounts discipline). The deck playhead uses the same
  pattern inline (`useDeckPlayhead` in DeckPanel.tsx: linear pos+rate
  from the poll's own fields, scrolls `<g class="waveform-scroll">` /
  moves playhead lines; `zoomWindow` in WaveformView.ts is the one
  window law). The LFO lamp is MOTION-BLURRED (`meanLevel` in LfoUI:
  frame-averaged brightness integral, converges to steady glow at fast
  rates like a real LED). The ADSR gate playhead is a third variant
  (`usePlayhead` in `extensions/adsr/ui-src/AdsrUI.tsx`): envelope
  segments are milliseconds long, so it REPLAYS the module's stage
  machine (`stepEnvelope`/`applyGate` mirror `extensions/adsr/src/lib.rs`
  — change both together) from the observed `gate`/`retrig`
  `instantaneous` taps, and treats the `out:env` tap as ground truth only
  for RE-LOCKING (`relock`: a gate pulse shorter than the poll is
  invisible otherwise), never for per-frame level correction. `is_fast`
  on `out:env` means no sample can pin the phase — the dot dims instead
  of lying. The App.tsx tapAll poll drops stale (out of
  order) responses so playheads never step backwards. Pinned by
  `app/tests/StepFollower.test.ts` + `AntiAliasing.test.tsx` +
  `AdsrUI.test.tsx`.
- Rack geometry (frontend): module positions are UNZOOMED rack
  coordinates — any pointer math must divide screen deltas by the rack
  zoom (panel drags in `ModulePanel`, drops in `App.onRackDrop`). All
  placement/collision logic is one system: `nearestFreeSpot` in
  `app/src/rackLayout.ts` (drops + post-render fixup) and
  `App.moveModule` (push-out with drag-past-to-commit, plus the
  provisional co-operative bump — a neighbour displaced to open a slot,
  reverted if the drag moves on, finalized on release via
  `endModuleDrag`). Behavior is pinned by
  `app/tests/RackCollision.test.tsx`. Title-bar sizing (78b9e15): module
  title bars are 56px min-height; macro labels are full-width 44px title
  bars styled like module ones — `MACRO_LABEL_H` in `rackLayout.ts` must
  match the macro-label CSS height or collision/placement geometry drifts
  (module panels self-measure, so their CSS can change freely). Title
  fonts: `.module-title` 1.9rem, `.macro-box-label` 1.5rem, both
  `line-height: 1`; the module title shows ONLY the name (no type text —
  the docs panel covers the type) while the macro label's instance id
  inherits the title size — resize fonts, not bar heights, to keep
  geometry constants valid.
  `.module-title` is position: absolute over the panel top (containing
  block: `.module-panel`'s position: relative — `.module-panel-placed`
  carries extra specificity to stay absolute), so long titles elide and
  can never widen a panel; `.module-panel-content`'s 64px top padding
  must match the bar height + 8px gap. Macro members' panel titles drop
  the `<macro>/` id prefix (display only, in ModulePanel's ModuleName
  callsite). The
  App shell scroll contract (pinned by `app/tests/AppShellLayout.test.tsx`):
  the PAGE never scrolls — `html`/`body`/`#root`/`.app` form a 100% height
  chain (100%, not 100vh: the webview visual viewport can differ), `body`
  is `overflow: hidden`, and `.app` is a flex column (header `flex: none`,
  `.app-body` `flex: 1; min-height: 0`). `.rack-area` must keep
  `overflow: hidden` + `min-height/min-width: 0` and NO viewport-relative
  sizing — the `.rack`'s min extents otherwise leak through its layout box,
  grow the body past the viewport, and scroll the header away. Scrolling
  surfaces are inner and explicit (`.library`, `.docs-body`,
  `.picker-body`, dialog lists).
  Keyboard scope: the rack stays MOUNTED (hidden) on other pages, so every
  rack window key listener gates on the active view — App's rack shortcut
  effect checks `view !== 'rack'` directly, and QwertyPanel/MidiPanel read
  `RackKeysContext` (`src/keyScope.ts`, provided around `.app-body`,
  default true for headless unit tests). Going inactive must RELEASE held
  gates/notes immediately (the keyup lands on the other page). ClipView
  follows the same pattern via its `active` prop (space + undo/redo keys,
  pauses playback on deactivate). Only Save/Open/New (fileShortcuts.ts)
  and per-modal handlers (ContextMenu, ModulePicker, KnobConfigMenu) stay
  page-global. Pinned by the scope cases in
  AppShortcuts/QwertyPanel/MidiPanel/ClipView tests.
  `npm run lint` runs react-hooks v6 rules: no synchronous setState in an
  effect body (async callbacks are fine) and no ref reads/writes during
  render — mirror props into a ref inside a `useEffect`, not inline. The
  `.wire-overlay` CSS must keep
  `z-index`, `overflow: visible` and `pointer-events: none`
  (WireOverlay.test.tsx pins it); knob right-clicks stopPropagation so
  the module context menu never opens over a knob
  (ContextMenu.test.tsx pins it). The Tauri webview is WebKit: a
  right-click is followed by a `click` on the same target (not
  `auxclick` like Chrome/Firefox), so any surface with both an
  add/activate onClick and an onContextMenu must swallow the paired
  click (gesture flag cleared by a fresh button-0 mousedown — see
  PickerEntry in ModulePicker.tsx; its "macro management" tests pin
  the full right-click event stream).
- Portaled menus (the input right-click `KnobConfigMenu`, rendered into
  `document.body` so panels can't clip it) still bubble their events up
  the REACT tree — through the module panel to the `.rack-area` handlers.
  Those must ignore anything that didn't land in their own DOM subtree
  (`e.currentTarget.contains(e.target)` in App.tsx's rack mousedown;
  ModulePanel's press-to-select uses an interactive-target /
  `.knob-config-menu` guard for the same reason): the marquee's
  `preventDefault()` otherwise cancels the mousedown's default action,
  and in WebKit that action is what opens a `<select>`'s option popup, so
  menu dropdowns silently refuse to open. Pinned by the "input
  right-click menu (portal)" cases in ContextMenu.test.tsx.
- Module layout (post-refactor): `engine.rs` keeps core types,
  construction, graph editing, knobs and telemetry; feature-area
  `impl Engine` blocks live under `src/engine/` (`midi`, `gesture_api`,
  `macros_api`, `lifecycle`, `deck_api`, `hot_reload` — each is
  `use super::*;` + one impl block). Likewise `deck.rs` is the deck's
  control plane; the RT-thread `DeckModule` lives in `deck/rt.rs`
  (re-exported). Put new methods in the matching submodule, not back in
  the parent file.
- Tauri shell undo discipline: commands lock the engine ONLY via
  `patch_edit(&state, EditKey::...)` (records the pre-edit snapshot;
  undoable) or `engine_lock(state)` (explicitly not undoable: queries,
  taps, backend start/stop, DJ controls canonical in the library DB).
  Raw `state.engine.lock()` in a command body is a review smell. Undo
  coalescing keys are the `EditKey` enum's `Display` strings — keep
  them stable.
- Structural edits are INCREMENTAL and LIVE — never rebuild the engine,
  never stop the backend. `add_module`/`remove_module`/`connect`/
  `disconnect`/`apply_doc` work while the RT backend runs: the control
  thread pre-allocates a `GraphEdit` (new node storage + a full
  `compute_plan` result; the engine owns slot allocation via
  `graph_slots`/`free_slots` mirrors) and ships it over the command ring;
  `Graph::apply_edit` swaps it in at a block boundary with moves only and
  the same box returns on the garbage ring (`RtGarbage`) carrying every
  replaced allocation for a control-side drop (drained in `tap_all`'s
  100 ms poll, on stop, and on the next edit). Zero audio gap — the old
  stop -> edit -> restart `with_stopped` cycle in main.rs remains ONLY
  for whole-engine swaps (New Patch, macro collapse/update rebuilds).
  `Engine::stop` drains the command ring so stopped-mode edits (applied
  directly) can never reorder behind queued ones. Node indices are stable
  slots: `Graph.nodes`/`Engine.nodes` are slot vectors with tombstones +
  a free-list (`NodeSlots`; iterate via `.iter()` / `.iter_slots()`,
  never assume dense indices), and engine side tables (midi/gesture/
  playback producers, decks) are keyed by slot. `Engine::remove_module`
  removes one module (or a whole macro instance) in place;
  `Engine::apply_doc` morphs the live engine to a `PatchDoc` by diffing
  (the undo/redo restore path in the app's `restore_doc`, returning the
  ids it had to recreate so deck metadata can be re-applied). Untouched
  modules keep DSP state AND telemetry across edits (`modules_sequencing`
  + `graph_edit` tests pin this; `live_edit` pins the running-edit path)
  — `Engine::from_doc` is ONLY for loading patches into a fresh engine.
  `PatchDoc::remove_module` edits the document, not a live engine.
- Module renaming (`engine/rename.rs`): instance ids ARE normalized names
  (`normalize_module_name`: lowercase ASCII alphanumerics, other runs
  collapse to one `_`). `Engine::rename_module` takes the user-typed form,
  keeps it as `display_name` (`NodeInfo`/`MacroInstance`; `None` when it
  equals the id) and renames the instance to the normalized form —
  rejecting empty/duplicate normalized names WITHOUT side effects. Renames
  are control-side only (wires reference slots); macro instances remap
  their `/`-prefixed internals and deck `sync_to` strings follow. Patches
  persist the typed form as `ModuleFile.name` (skip-if-none, so goldens
  are untouched); the paste path drops it (fresh id ≠ normalized name).
  The Tauri `rename_module` command records undo history only on success;
  the frontend (`ModuleName` in ModulePanel.tsx, double-click to edit)
  shows the display name as the title (type text intentionally absent
  from the bar), and
  `App.renameModule` remaps positions/selection to the returned id — a
  backend rejection resolves null (error banner) and the refresh reverts.
- Mixer mute/solo (`extensions/mixer`) are per-channel `switch` INPUT
  jacks (`mute{n}`/`solo{n}`, gate law >= 1 V), not params — the WASM
  "params vs. inputs" rule above — so they are wireable and persist as
  ordinary knob state. The law lives once, in `process`: heard =
  un-muted AND (nothing soloed OR soloed), evaluated per sample so CV
  can drive it, with a 5 ms per-channel fade (`FADE_SECONDS`) that keeps
  a toggle from clicking; the first processed sample snaps instead of
  fading (`primed`). Per-channel input stride is 6 — adding a channel
  control means updating `STRIDE`, the manifest and the channel strip in
  `panelLayouts.ts` together. Golden: `utilities-mixer-mute-solo`.
- VCA `cv` ("Gain / CV") input default is 0.0 (closed/silent) in
  `extensions/vca/manifest.json` — the manifest is the single source of
  truth for module defaults (engine derives initial knob position via
  `position_for_value`; frontend imports the same manifest). Defaults only
  affect freshly added modules: patches serialize explicit knob positions,
  so goldens are unaffected by default tweaks.
- Structural edits (add/remove module, wire changes, paste) go through the
  Tauri shell's `with_stopped` wrapper: engine.stop() → edit →
  restart_backend(). This causes an audible blip (~50–150 ms hard-cut
  silence on add): wasmtime compiles the module inside the stopped window
  (no per-path compile cache), and the dj-cpal monitor thread polls the
  stop flag only every 50 ms. The RT graph itself edits in ~2 ms. Staged
  fix options (compile hoisting/cache, faster stop poll, keeping the cpal
  stream alive across edits) are in the ticket-44cd9510c3e3 diagnosis.
- Undoable rack layout (module moves + delete restore): positions are UI
  passthrough on `NodeInfo.position` (control-side only, never RT),
  captured in `PatchDoc::layout` (macro members under their `/`-prefixed
  ids; saved as `layout.json` only when non-empty so pre-layout patches
  stay byte-identical; the clipboard doc carries no layout) and applied
  by `from_doc`/`apply_doc` — so plain snapshot-based undo/redo restores
  arrangement, and macro collapse remaps members' entries through its
  rebuild. Shell commands: `move_modules` (ONE batch per completed drag
  gesture = one undo step; frontend collects everything the gesture
  displaced — group/macro members, co-operative bumps — in App.tsx's
  `dragMoved`/`endModuleDrag`; seeds never-placed modules with the
  gesture's `from` BEFORE the undo snapshot, then ends the gesture) and
  `sync_positions` (NOT undoable: layout seeding right before a delete so
  the delete's pre-edit snapshot can restore spots, macro placement, and
  post-render fixup corrections). The frontend remains the position
  authority: `App.refresh` adopts engine-known positions into
  rackStore/localStorage (undo/redo restores land this way; nodes the
  engine has no position for keep local layout), and `patch_dirty`
  ignores layout so a mere rearrange never triggers save prompts. Pinned
  by `app/tests/UndoMoveDelete.test.tsx` and the layout cases in
  `tests/integration/undo.rs` / `macros.rs`. Engine mocks in app tests
  need `moveModules`/`syncPositions` stubs next to `endEdit`.
  Layout-entry LIFETIME around id-changing edits (macro collapse/break,
  rename, delete): the rack renders the PRE-edit snapshot until that
  edit's `refresh` lands (several IPC round-trips), and anything without
  a layout entry falls back to `defaultPosition` — so entries for the new
  ids are seeded FIRST (`App.carryPositions`, additive) and the retired
  ids are dropped only AFTER the refresh (`App.dropPositions`). Retiring
  them up front teleported the old panels — and the macro box drawn
  around them, title bar included — to the rack origin on top of other
  modules for the whole round-trip. Pinned by the mid-refresh break case
  in `app/tests/MacroCollapse.test.tsx` (its engine mock can hold the
  node snapshot in flight via `state.hold`).
- Acquisition fetches are a TRAIT METHOD, not a URL:
  `AcquisitionProvider::fetch(result, dir, progress)` defaults to the
  plain HTTP GET of `acquire()`'s `Acquire::Download`, and providers whose
  media needs an external tool return `Acquire::External` and override
  `fetch` (`providers/youtube.rs` → `yt-dlp`). ALL downloads then run
  through `dj_library::DownloadManager` (`downloads.rs`): one thread per
  job, progress into a `DownloadJob` snapshot the library view POLLS
  (`start_download` / `download_jobs` commands, 500 ms while a job runs —
  same pattern as the analysis queue, no Tauri events). Never download on
  a Tauri command thread: sync commands run on the main thread and would
  freeze the window. `search_provider` is `#[tauri::command(async)]` for
  the same reason (yt-dlp search is a subprocess). Library-view engine
  mocks need `startDownload`/`downloadJobs`.
- The YouTube provider is keyless and shells out to `yt-dlp` (OPTIONAL
  runtime dep, `DJ_YTDLP_BIN` overrides the binary, `DJ_YTDLP_ARGS` adds
  flags — e.g. `--cookies-from-browser` for YouTube's bot check): search is
  `--dump-json --flat-playlist ytsearchN:`, download is audio-only
  `bestaudio[ext=m4a]/…` into a `.yt-<id>` staging dir under
  `downloads/` (whatever file lands there is moved out and imported) —
  no ffmpeg, no transcode. The tab stays visible without the binary; the
  error carries the install hint. Its license is always `unknown` (the
  search API exposes none). Tests never touch the network or the real
  binary: parsing is pinned to `tests/fixtures/youtube_search.jsonl` and
  the plumbing runs against a FAKE yt-dlp shell script
  (`tests/youtube.rs`, `#[cfg(unix)]`); the real smoke test gates on
  `DJ_YTDLP_SMOKE` (unset/empty ⇒ skip).
- Clip page (PRD §9): the third top-level view next to Rack and Library
  (`view` union in App.tsx, `ClipView.tsx` + `src/clip.ts`). It is an
  OFFLINE editor — it never touches the engine or the RT thread; the
  `clip_*` Tauri commands (`app/src-tauri/src/clip.rs`, all
  `#[tauri::command(async)]`) decode sources (small LRU cache), render
  with `dj_analysis::clip` on a worker thread and are NOT undoable
  (`engine_lock` isn't even taken; ClipView keeps its own undo/redo
  stacks). The edit is a `ClipProgram`: regions (source index + in/out +
  reverse + gain), overlays (a region MIXED over the output timeline at
  `at_secs` instead of spliced — it can extend the clip; edges get the
  same crossfade-length declick ramp), a parametric EQ (`bands` of RBJ
  peaking bells — same filter as the EQ module; empty/all-0 dB bands are
  an exact bypass), dB level breakpoints on the OUTPUT timeline
  (automation is timeline-based, so a cut shifts audio under it —
  deliberate, like a DAW) and `crossfade_ms`.
  Adjacent regions OVERLAP by the crossfade, capped at half of either
  neighbour: that one law exists twice — `splice` in
  `crates/dj-analysis/src/clip.rs` and `regionSpans` in `app/src/clip.ts`
  — pinned on both sides (`tests/clip_edit.rs`, `app/tests/ClipEdits.test.ts`);
  change them together. Saving renders to FLAC under `<data_dir>/clips/`
  (machine-local, gitignored) and imports a NEW library track
  (`source = "clip"`, `source_ref` = comma-joined source refs,
  license AND artist inherited from the first source) — a clip NEVER
  overwrites the track it was cut from. Like the rack, ClipView stays
  MOUNTED while other pages show (App passes `active`; the component
  hides itself, pauses playback and detaches its shortcuts — space,
  ctrl/cmd+Z/shift+Z/Y). Playback streams the RENDERED edit: 60 s WAV
  windows through `clip_preview_audio`, chaining windows as they run out.
  ALL of it belongs to ONE owner, `ClipTransport` (`src/clipTransport.ts`):
  ClipView never touches an audio node, it calls commands (`play`, `pause`,
  `stop`, `seek`, `setLoop`, `refreshTone`, `invalidate`, `dispose`) and
  renders the `onStatus` it gets back. The transport owns the element src
  and object URL, the loop node, the loaded window, the playhead, the
  playhead ticker and the tone debounce; it reads the live edit back
  through its host (`duration`/`element`/`render`), so ONE instance
  survives every edit. Four rules make a second source impossible, and
  `tests/ClipTransport.test.ts` pins each with a fake host whose renders
  and decodes resolve when the test says so:
  (1) one slot — `source` is filled by `install` only ever immediately
  after `release` has emptied it, so no instant has two live sources;
  (2) epochs — every command bumps one, and each async continuation drops
  out if its epoch is stale, so a late render or decode is discarded;
  (3) nothing sounds before its last staleness check — decoding
  (`prepareLoop`) is side-effect free and the node starts synchronously
  after it, which is why `clipAudio` splits prepare from start (a
  decode-and-start call left the loser of a race playing with nobody
  holding its handle — the "playing twice, lost control of one" bug);
  (4) disposal is final, so StrictMode's mount/unmount/mount leaves
  nothing behind. The transport is therefore created AND disposed in one
  `[]` effect (never memoized: the owner must not outlive the mount), and
  that effect sits ABOVE the editing handlers in the component, because
  `react-hooks/immutability` rejects writing a ref that hooks declared
  earlier already captured. Two backends, one window: linear play uses the
  `<audio>` element, but a LOOPED range runs the same bytes through Web
  Audio (`AudioBufferSourceNode.loop`) because the media element's own
  `loop` re-seeks and drops ~100 ms at every wrap — the renderer's splice
  is already sample-exact, so any audible gap is the frontend's. What an
  edit costs playback depends on WHAT changed: a TIMELINE change
  (sources/regions/overlays/crossfade — identity-compared on the memoized
  `request`, so keep `sourceRefs` memoized separately) invalidates,
  because every output time now means something else; a TONE-ONLY change
  (EQ, level) re-renders the window in place, debounced, and resumes at
  the same loop phase, since pausing for an EQ tweak would make the
  control useless for auditioning. A re-render keeps the OLD source
  playing until the new one is ready and swaps, rather than gapping.
  Loop with NOTHING selected loops the whole clip (it used to light up and
  do nothing), so a loop range routinely outgrows the 60 s window: a range
  that fits still runs on one gapless Web Audio buffer, while a longer one
  chains element windows and wraps at the range end in `onEnded`. Arming a
  loop that already contains the playhead carries on from there instead of
  rewinding to its head.
  Selection changes re-fetch too, so a loop follows its edges live, and
  clicking the waveform `seek`s (jumping live playback, not just parking
  the cursor) — the transport owns the playhead, so nothing else may
  write it. The host reads the live edit through a ref mirror that MUST be
  refreshed in a `useLayoutEffect`, not a passive one: passive effects are
  flushed after the browser can dispatch the next click, so a play that
  landed in that gap read the PREVIOUS render's duration, computed an
  empty window and silently played nothing (~1 in 6 in the suite).
  The waveform draws from the peaks already in hand — `peaksPath` takes
  one column per bucket in view (capped at the viewBox width) and pools
  the loudest bucket per column, so zooming reveals detail instead of
  stretching a fixed 200 steps, and zooming out cannot step over a
  transient. Timing marks come from `rulerTicks` (pure, in `clip.ts`) and
  render as HTML over the stretched SVG, whose `preserveAspectRatio="none"`
  would squash text.
  A track also opens straight from the Library page: its Edit button calls
  `open(trackId)` on ClipView's imperative handle (`ClipViewHandle`) and
  switches tabs. It is a handle rather than a prop because opening is an
  ACTION, not a state — a prop would need a nonce to fire twice for the
  same track, and reacting to it would put the state updates in an effect,
  which `react-hooks/set-state-in-effect` rejects (rightly: they belong in
  the click). An edit that has been touched but not saved is asked about
  first (`clip-discard-dialog`); nothing else is at risk, since the source
  track is never written.
  Sources are `{track_id, stems}` pairs, not bare ids: a source is a
  CHOSEN SET of a track's stems (read out of the stem cache the auto-stem
  service fills, summed by `dj_analysis::mix_stems`) and edits exactly
  like a full mix —
  the set is part of the cache key, the `source_ref` (`"7:drums+bass"`)
  and the rendered result. An EMPTY set means the full mix, and that is
  also how "every stem on" is sent: the track's own file is exact and
  needs no separation, where re-summing four stems is neither. Sets are
  normalised (STEM_NAMES order, no repeats) so `{drums,vocals}` and
  `{vocals,drums}` are one cache entry.
  The stem switches apply IMMEDIATELY, swapping the loaded lane for the
  new mix instead of waiting for another Open — the old dropdown looked
  broken because picking a stem did nothing on its own. Stems are the
  same length as their track, so the program (regions, level, EQ)
  survives the swap untouched; a failed load rolls the switches back.
  Nothing on the page starts or stops a separation: stems arrive by
  themselves (see the auto-stem bullet below) and `clip_stem_status` only
  REPORTS — `ready` / `loading` / `failed` / `unavailable`, plus the
  queue length. Asking is the request, though: the command marks that
  track wanted, which jumps it ahead of the backfill. Abandoning a run
  (`AutoStemService::stop` → `StemJobs::cancel_track`,
  `StemJobState::Cancelled`) KILLS the demucs child: it is minutes of
  another program's time, and a flag alone stops nothing. Hence
  `CancelToken` owns the `Child`,
  `wait_child()` polls instead of blocking (a blocking wait would put the
  child out of the canceller's reach), and stderr is drained on its own
  thread — demucs' `-j` workers inherit that pipe and hold it open after
  their parent dies. A cancelled run writes no stems, so the track is
  left exactly as it was and can simply be separated again.
  Its golden-audio case lives in dj-analysis
  (`tests/e2e/clips/*.json` + `tests/e2e/goldens/*.wav`, second step of
  `scripts/regen-goldens.sh`) rather than the engine e2e suite, because
  the renderer is not a graph module. `decode_audio` truncates to the
  container's declared frame count — our FLAC writer zero-pads the last
  fixed-size block, and an exported clip must decode back sample-exact.
- Stems are AUTOMATIC (`dj_analysis::AutoStemService`, started in
  `AppState`): a background thread separates every track the scope covers
  — provider downloads first, newest first, then the rest — and a startup
  scan BACKFILLS history, including runs a quit interrupted. It was a
  button on the Clip page; that made every first use a multi-minute wait
  and forgot the work on exit. `DJ_AUTOSTEM=off|downloads|all` (default
  `all`) picks the scope. ONE separation at a time: demucs saturates the
  CPU alone, and a hundred-track backfill spawning a hundred models takes
  the machine down. A track is given up on after `max_attempts` failures
  so one broken file can't spin the loop, and `next_in_line` is a pure
  function so the ordering policy is testable without a library, a model
  or a thread.
  Separation itself still runs in `StemJobs` (thread per job) behind
  `DemucsSeparator`, which shells out to the external `demucs` CLI the way
  the library shells out to yt-dlp — a missing binary is a reported state,
  never a panic, and it is re-probed periodically so installing demucs
  needs no restart. The separator's id keys the cache (`stems_dir_for`),
  so a demucs request can never be served the import-time band-split
  stems, and `stems_cached` requires NON-EMPTY files: a half-written cache
  from a kill is redone rather than trusted. The plumbing is tested
  against a fake CLI script (`tests/stem_separation.rs`, `#[cfg(unix)]`) —
  never the real model.
- Clip playback has exactly ONE owner, `ClipTransport`
  (`app/src/clipTransport.ts`); ClipView holds no audio state. Four
  invariants keep it from playing twice: ONE SLOT (`install` runs only
  right after `release`), EPOCHS (every command bumps one, every
  continuation rechecks after each await and drops out if superseded),
  NOTHING SOUNDS BEFORE ITS LAST CHECK (`clipAudio.prepareLoop` is
  side-effect free, `PreparedLoop.start` is synchronous) and DISPOSAL IS
  FINAL (a disposed transport refuses every command, so a StrictMode
  remount leaves nothing behind). Loops wrap at a sample boundary via an
  `AudioBufferSourceNode` (`<audio loop>` drops ~100 ms), falling back to
  the media element where Web Audio is absent. A TIMELINE edit
  (sources/regions/overlays/crossfade) halts playback; a TONE-ONLY edit
  (EQ, level) re-renders the window in place, debounced, resuming at the
  same loop phase — keep that split, and keep the staleness identity
  checks allocation-free or every keystroke reads as a timeline change.
- Audio module (`builtin.audio`, `crates/dj-engine/src/audio.rs`): the
  `loop` switch input defaults ON (`default: SIGNAL_MAX` in the manifest);
  a pass wraps BEFORE the sample read so the first sample of the next pass
  and the clock trigger land on the same frame, and the sub-sample
  remainder carries over so long loops don't drift. Panel readout comes
  from `AudioShared` (position/rate/playing atomics published once per
  block, surfaced via `AudioStatus`, mirroring `DeckShared`) — the RT-
  observed `playing` replaced the old `audio_playing` knob read; do not
  reintroduce knob-derived transport state. `TrackData::peaks` is the ONE
  waveform-overview implementation behind both `deck_waveform` and
  `audio_waveform`; the panel extrapolates the playhead with rAF between
  polls (wrapping when looping). `position_for_value` resolves
  Switch/Button styles to an exact end position rather than the 0.5 snap
  threshold — that is what makes a default-ON switch survive a patch round
  trip; the TS twin in the app must match.
