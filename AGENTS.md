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
- Stems (M3) follow the same split: the FLAC stem cache under
  `<data_dir>/stems/<content_hash>/` is app-layer state auto-loaded by
  `apply_deck_metadata`; patches persist only the `stem_*` gain params.
  E2E cases carry stem files in the sidecar's `decks[].stems`.
- The ONNX separator is behind `dj-analysis --features onnx` and its smoke
  test gates on `DJ_STEMS_ONNX_MODEL` (unset/empty ⇒ skip). The tested
  default separator is the deterministic DSP `BandSeparator` — don't make
  CI depend on model files.
- Macros (M4, PRD §6): definitions are canonical in the library DB
  (`macros` table, JSON `MacroDef`); patches persist instances as
  `ext = <macro id>` + `macro_version` references and embed the used
  definitions under `macros/` as a lockfile for the version-mismatch
  update-vs-fork flow (`PatchDoc::macro_conflicts` /
  `resolve_macro_conflict`). Expanded internal nodes use `/`-prefixed
  instance ids, so `/` is reserved in user instance ids. Macros are NOT
  collapsed in the UI: every internal renders as an ordinary module panel
  and the instance is a pure UI grouping (`MacroBoxes` bounding box fed by
  the `macro_groups` command; all-or-nothing select/drag/copy/delete in
  App.tsx). `MacroDef.positions` stores the members' relative rack layout
  (UI passthrough, `skip_serializing_if empty` so old goldens stay
  byte-stable; `Engine::macro_layout` flattens nested defs for placement).
  Right-click "Break Macro" -> `Engine::break_macro`: in-place control-side
  rename lifting internals to fresh top-level ids (slots/wires/DSP state
  untouched; nested instances lift whole), instance record dissolves.
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
  fields suppressed and dial dimmed under override.
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
  `patchDirty: vi.fn(async () => false)`.
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
  fonts (926ebb9) nearly fill the bars: `.module-title` 2.75rem,
  `.macro-box-label` 2.1rem, both `line-height: 1` — resize fonts, not
  bar heights, to keep geometry constants valid. The
  `.wire-overlay` CSS must keep
  `z-index`, `overflow: visible` and `pointer-events: none`
  (WireOverlay.test.tsx pins it); knob right-clicks stopPropagation so
  the module context menu never opens over a knob
  (ContextMenu.test.tsx pins it).
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
- Structural edits are INCREMENTAL — never rebuild the engine. Node
  indices are stable slots: `Graph.nodes`/`Engine.nodes` are slot vectors
  with tombstones + a free-list (`NodeSlots`; iterate via `.iter()` /
  `.iter_slots()`, never assume dense indices), and engine side tables
  (midi/gesture/playback producers, decks) are keyed by slot.
  `Engine::remove_module` removes one module (or a whole macro instance)
  in place; `Engine::apply_doc` morphs the live engine to a `PatchDoc` by
  diffing (the undo/redo restore path in the app's `restore_doc`,
  returning the ids it had to recreate so deck metadata can be
  re-applied). Untouched modules keep DSP state AND telemetry across
  edits (`modules_sequencing` + `graph_edit` tests pin this), and a
  remove-while-running audio gap is ~1 ms vs the ~250 ms a from_doc
  rebuild costs — `Engine::from_doc` is ONLY for loading patches into a
  fresh engine. `PatchDoc::remove_module` edits the document, not a live
  engine.
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
  shows the display name prominently with the type name secondary, and
  `App.renameModule` remaps positions/selection to the returned id — a
  backend rejection resolves null (error banner) and the refresh reverts.
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
