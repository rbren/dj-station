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
- CI's toolchain is UNPINNED latest stable (`dtolnay/rust-toolchain@stable`),
  so a Rust release can break the lint job with brand-new clippy lints while
  an older local toolchain still passes. If lint fails in CI but not locally,
  `rustup update stable` first and reproduce on the same version CI uses.
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

- Frontend styling goes through the design tokens at the top of
  `app/src/styles.css` (`--fs-*` scale, `--canvas/--surface*/--line*`,
  three inks, `--brand/--cue/--ok/--fault`, `--shadow-*`, `--dur-*`,
  `--scrim`). Do not add a fresh hex literal or font-size when a token
  fits; per-module category hue lives only on a panel's inline `--accent`.
  `DESIGN_OVERHAUL.md` is the review those tokens came from and the place
  the remaining design work is tracked (completed findings struck through)
  — update it there, not in code comments. Motion is colour/opacity only
  and must survive the `prefers-reduced-motion` block at the top of the
  file.
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
- Bypass is manifest data, not per-module code: a `"bypass"` map (output
  jack id -> the input jack id it passes through) makes a module
  bypassable, and every audio in -> audio out module should declare one,
  including a single input fanned to a stereo pair. The graph then skips
  `process` and copies the routes (`GraphNode::bypass_routes`,
  resolved to indices at add time so the RT thread only ever copies
  slices); an output with no route is silent. The flag is per-module
  state — `Command::SetBypass` to the RT thread, `NodeInfo.bypassed` on
  the control thread, `bypassed` in the module's patch JSON (skipped when
  false, so old patches and unbypassed modules keep their bytes), one
  undo step (`EditKey::Bypass`). Pinned by
  `crates/dj-engine/tests/integration/bypass.rs` and the
  `bypass-resonator-thru` golden.
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
- Gesture (M5, PRD §7.3) is REMOVED: the `dj-gesture` crate,
  `builtin.gesture`, its panel and its `gesture-pinch-vca` golden are
  gone. Hand-driven control is the camera panel's in-webview MediaPipe
  tracking feeding `builtin.hands` (see the camera/hands entries below)
  — don't reintroduce a second detection pipeline in Rust.
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
- Launch Control XL module (`builtin.launchcontrol`,
  `crates/dj-engine/src/launch_control.rs` + `engine/launch_control_api.rs`):
  one KNOWN controller as a fixed 48-jack set — 8 columns × (3 knobs,
  fader, 2 buttons), column-major (`c1_a`…`c8_ctrl`, index =
  `col*6 + row`) so a column's jacks are contiguous. Knobs/faders are
  unipolar 0..10 V, buttons momentary gates; the device map is the
  factory-template CC/note numbers and the CHANNEL NIBBLE IS IGNORED (the
  device changes channel per template, and every template uses the same
  control numbers). Data path mirrors Hands: raw MIDI -> control-thread
  `decode`/dedup (`LaunchControlControl`) -> SPSC ring ->
  `LaunchControlRtModule` (holds last value; no allocations or locks).
  OWNERSHIP is exclusive and lives in the `active` PARAM (mode-style
  toggle, per the params-vs-inputs rule — never a wireable input), so it
  round-trips through the patch: `launchcontrol_set_active` deactivates
  every other module, a freshly added module claims an UNOWNED surface
  (`launchcontrol_claim_if_unowned`, so the common single-module case
  needs no ceremony) and a second one never steals it. TWO feed entry
  points, deliberately: `launchcontrol_feed` is the DEVICE feed (active
  modules only) and `launchcontrol_inject` addresses one module directly
  — the synthetic seam tests, offline renders and the
  `launchcontrol-fader-button` golden use, so CI never depends on
  hardware. Presence is a plain control-side flag
  (`launchcontrol_set_connected`, the panel's indicator light), published
  by the shell's hot-plug watcher (`app/src-tauri/src/launch_control.rs`:
  1 s port scan behind `midi-hw`; device messages cross a channel to a
  forwarder thread so midir's callback never waits on the engine lock).
  A SURFACE WIRE SETS WHAT IT LANDS ON: a module whose outputs are
  physical controls (`BuiltinKind::is_control_surface`) is the second
  auto-Override case in `auto_wire_style_on_connect`, beside the v/oct
  pitch pair — the fader in your hand IS the value, so the knob it is
  wired to goes inert rather than being added to. Same first-wire-decides
  rule, same per-patch `wire_style` a user can set back to CV. Pinned by
  `launch_control.rs`'s wire tests and the `launchcontrol-override-fader`
  golden (whose gain knob is saved wide open, so a regression to CV would
  render at full level instead of following the fader).
  The panel is a PICTURE of the device: output groups may carry a
  `control` (`OutputGroupSpec.control`, panelLayouts.ts) and per-jack
  `labels`, which draws each jack with a read-only dial / fader cap /
  lit pad above its socket (`JackReadoutVisual` in Jack.tsx, fed by the
  telemetry the jack ALREADY subscribes to — no second subscription, no
  panel re-render per tick). Readouts are drawn against the unipolar
  0..10 V a physical control puts out, gates light at the engine's ≥ 1 V,
  and the fixed `.jack-with-readout` cell width is what lines the six
  rows up into one grid.
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
- Clock Multiplier (`extensions/clock_mult`, `com.dj.clock_mult`): the
  ratio is a knob-backed `mult` INPUT (10 detents
  `/8 /4 /3 /2 1x 2x 3x 4x 6x 8x`, 1x default, exact rationals in
  `RATIOS` so `/3` can't drift), never a param. The input rate comes from
  the last two rising edges like every other clock consumer; multiplied
  pulses are predicted from that interval (the phase is capped just short
  of the next input period so a late edge can't manufacture one), while
  divisions land on the clock's own edges. With nothing wired, before the
  first edge, or after the clock has been silent for 4 measured periods,
  it FREE-RUNS as if fed a 2 Hz clock — the fallback is an assumed input
  rate, so the knob still applies (1x ⇒ 2 Hz out) and the next edge
  re-phases the grid. Its output jack is `out`, not `clock`: no other
  manifest reuses one id across both directions, so don't start.
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
  regression. `perf_m4.rs` flakes the same way and for the same reason
  ("exceeded the block deadline N times"): rerun
  `cargo test -p dj-engine --release --test perf_m4` on its own.
- Stale test binaries from OTHER git worktrees can poison
  `cargo test --workspace`: sibling checkouts under
  `/tmp/conversation-worktrees/` share this `target/` dir, and a test
  binary bakes in its build-time `CARGO_MANIFEST_DIR`, so cargo may run
  one whose fixture paths point at a worktree whose files differ. The
  tell is a fixture `NotFound`/drift failure in a crate the change never
  touched, passing standalone but failing under `--workspace` (seen on
  `dj-analysis`'s `golden_clip_edit`). `touch` the test source to force a
  relink, and check the baked path with
  `strings <binary> | grep conversation-worktrees`.
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
- Jack telemetry is SCALAR (value / rms / fast flag) and cannot describe a
  waveform. A panel that DRAWS a signal reads raw samples instead: mark
  the input jack `"capture": true` in the manifest, which gives it a
  fixed lock-free ring (`crates/dj-engine/src/capture.rs`, 2048 samples
  written by the RT thread from the jack's post-blend buffer), read via
  `Engine::jack_capture` / the `jack_capture` IPC command /
  `ModuleHandle.capture`. The Scope's `in` is the only one; keep it that
  way (one ring per capture jack per instance) and never reconstruct a
  signal from telemetry — that is exactly the bug the Scope had, drawing a
  synthesized periodic wave and a comb spectrum for white noise.
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
- Rack zoom bounds live in `ZOOM_MIN`/`ZOOM_MAX` in `app/src/App.tsx`
  (0.04–2.5); `loadZoom` validates persisted zoom against them and
  `dotGridSize()` doubles the background lattice until dots are ≥12px
  apart so deep zoom-out does not moiré. Pinned by
  `app/tests/AppShortcuts.test.tsx`.
- Rack geometry (frontend): module positions are UNZOOMED rack
  coordinates — any pointer math must divide screen deltas by the rack
  zoom (panel drags in `ModulePanel`, drops in `App.onRackDrop`). All
  placement/collision logic is one system: `nearestFreeSpot` in
  `app/src/rackLayout.ts` (drops + post-render fixup) and
  `App.moveModule` (push-out with drag-past-to-commit, plus the
  provisional co-operative bump — a neighbour displaced to open a slot,
  reverted if the drag moves on, finalized on release via
  `endModuleDrag`). An INSERT (picker click, clip import, drag-drop) aims
  at the CURSOR, not the middle of the view, and never leaves the visible
  area: `App.insertPoint` (last window-level cursor position → grid-snapped
  rack coordinates; the picker modal covers the rack, so the pointer is
  over the modal) feeds `spotInView` in `rackLayout.ts`, which clamps the
  footprint into `App.viewRect` (the `.rack-area` box mapped back through
  pan/zoom) and takes the closest free visible grid spot — the clamped
  point itself when the view is full. The insert is placed with the
  nominal fallback footprint (its panel is not in the DOM yet), so
  `App.pendingInsert` carries the aimed-at viewport into the post-render
  pass and that one module's real-size correction stays on screen too.
  Behavior is pinned by `app/tests/RackCollision.test.tsx`.
  Title-bar sizing (78b9e15): module
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
  `impl Engine` blocks live under `src/engine/` (`midi`, `hands_api`,
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
  - `graph_edit` tests pin this; `live_edit` pins the running-edit path)
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
- A gain of zero must be EXACT silence, not a rounding residue: the
  crossfader's equal-power law (`crossfader_gains` in
  `crates/dj-engine/src/mixer.rs`) clamps `cos`/`sin` at 0 because f32
  `FRAC_PI_2` rounds up and `cos` undershoots to ~-4.4e-8 — a fader hard
  over used to leak a phase-inverted copy of the closed side. Pinned by
  `crossfader_end_stops_silence_the_closed_channel_exactly` (deck.rs) and
  `mixer_level_at_zero_is_exact_silence_on_a_full_desk`
  (modules_utilities.rs); hold any new taper to the same bar.
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
  A drag on the waveform NEVER edits by itself: sweeping empty space
  makes a selection, grabbing an edge resizes it, and grabbing the inside
  slides WHICH PART is selected — the audio stays where it is. Moving the
  material itself is alt-drag (`WaveDrag.audio` → `moveRange` on release,
  the one edit in the gesture). Plain dragging used to re-splice, which
  read as the waveform coming apart under a gesture people meant as
  "select this bit instead".
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
- Beatify tab (`PRD-beatify.md`): the fourth top-level view (`view` union in
  App.tsx, `tab-beatify`). Like the Clip page it is OFFLINE — the
  `beatify_*` Tauri commands (`app/src-tauri/src/beatify.rs`, all
  `#[tauri::command(async)]`) never touch the engine, the RT thread or
  `engine_lock`, and they are not undoable. The pipeline lives in
  `crates/dj-analysis/src/beatify/`: `detect` (beat trackers), `grid`
  (fit + meters + sweep), `warp` (WSOLA renderer), `audition` (click
  track, sync check), `store` (artifacts). THE OUTPUT CONTRACT: beat n of
  a beatified track is `phase + n × period`, exactly, with `phase` = one
  period of head padding so beat 0 has audio behind it; there are no bars,
  no meter and no beat array anywhere — `ruler.group` is a display
  preference nothing else reads. Artifacts are content-hash keyed under
  `<data_dir>/beatify/<project-id>/{project.json,meta.json,warped.wav}`
  (machine-local, gitignored) plus a best-effort `<source>.beatify.json`
  sidecar; Beatify never rewrites the source file or the library DB row.
- THE IMPORT MODAL OWNS THE CHOICE AND THE PAGE (MOD-A0/A0a). "+ Import
  track" opens `BeatifyModal` with NO track: `chosen` is the modal's own
  state, every fetch is keyed on it and returns early while it is null,
  so opening the dialog costs nothing. The picker is
  `TrackPicker.tsx` — a generic searchable combobox (all typed words must
  appear in title/artist/album, ↑/↓/Enter, `idPrefix` for its testids,
  `stopPropagation` on its keydowns so the page's transports never hear
  typing) — and it stays in the modal header, so re-choosing restarts the
  analysis. There is no track `<select>` on the page, and no re-beatify
  button anywhere: a second take is a second seed. While the modal is up
  the page is `inert` (bar, shelf, and `BeatifyClipBuilder` via its
  `suspended` prop) and both window keydown handlers — the builder's and
  `BeatifyTrackView`'s — return early, after pausing what was sounding.
  Pinned by `app/tests/TrackPicker.test.tsx` and the MOD-A0 cases in
  `BeatifyView.test.tsx`. Layout invariant (CSS-pinned in the same test):
  `.track-picker` carries NO flex sizing — a flex-basis is the main axis,
  and the choose dialog is a column, so it would grow into an empty box
  with the matches stranded at its bottom; and in that dialog the match
  list is `position: static` (inline under the box) rather than floating
  over a dialog that holds nothing else.
- Beatify's frontend: `BeatifyView.tsx` (tab shell: track list,
  run/verdict state, owns which track is open), `BeatifyModal.tsx` (the
  detection report + audition) and, once a track is beatified,
  `BeatifyClipBuilder.tsx` — the clip builder, which owns
  `BeatifyClipList.tsx` (sources), `BeatifyTrackView.tsx` (the source
  pane: the same track view, shorter) and `BeatifyClipEditor.tsx` (the
  grid). The modal and the track view each render an `AudioTimeline` and
  own a `ClipTransport`; grid
  quantization is `beatSnap(grid)`, exported from BeatifyTrackView and
  handed to the timeline's `snap` hooks, so beats are the unit of every
  gesture there without the timeline knowing what a beat is.
- Beatify's shape, in one bullet (the map is "The Beatify page at a
  glance" below; the law is `PRD-beatify.md`). There is NO store: state
  is React and disk. `BeatifyView` owns which project/track is open,
  `BeatifySession` (backend) owns an analysis until Save, and
  `BeatifyClipBuilder` owns the live `ClipDraft`. A PROJECT is a tempo
  with material on it: the first imported seed sets `project.bpm`, every
  later seed is conformed to it (its warp map scaled, re-rendered ONCE
  from the source), so beat n is the same instant in all of them; stems
  are not sources but a seed with parts switched off (`seed:s2/drums`).
  Everything is written by the command that changes it, under
  `<data_dir>/beatify/<project-id>/`: `project.json` (name, bpm, seeds),
  `clips.json` (clips belong to the PROJECT), `seeds/<id>/` (`meta.json`
  record, `warped.wav`, `stems/`). INVARIANTS: a re-tempo never touches
  clips; a re-beatify keeps the seed id and directory; ids are minted
  `p<n>`/`s<n>` and nothing is keyed by a library track; older on-disk
  layouts are adopted on read, never migrated.
- TWO GRIDS, AND USING THE WRONG ONE IS SILENT. `analysis.grid` is the
  OUTPUT timebase (beat 0 is the head pad), so it says nothing about
  where a beat sits in the file; `analysis.sourceGrid`
  (`Analysis::source_grid(duration)`) is the same beats in SOURCE
  seconds, its beat 0 the first fitted line inside the file, and it spans
  the WHOLE file rather than the analyzed region — the import region is
  an input to the next detection run, so it has to be growable. Anything
  drawn over or snapped to source audio (the modal's region, ruler and
  error strip) uses `sourceGrid`; only the render and the track view use
  `grid`. Likewise `analysis.residualBeats` gives the sourceGrid beat
  each residual measures: residuals are per DETECTION, so a beat the
  tracker missed leaves a gap and `residuals[i]` is not beat `i`. The
  modal's error strip rides in the timeline's `belowWave` slot so it
  shares the waveform's width and viewport, and each dot is drawn under
  the beat it is about; its scale, sign and colour law are written beside
  it (`beatify-strip-title`/`-mark`/`-caption`) rather than left to be
  guessed. MOD-1 colour
  semantics hold throughout: AMBER is what was played (detections,
  source audio), TEAL is what the maths says (the fitted grid). All of it
  is pinned by `app/tests/BeatifyView.test.tsx` (tab + modal + track view,
  against a mocked client), `app/tests/BeatifyClipBuilder.test.tsx` (the
  builder, mounted) and `app/tests/BeatifyGrid.test.ts` (the meter law
  shared with `grid.rs`, plus `beatSnap`/`viewSpan`/`zoomView`); the
  transport underneath has its own suite in `app/tests/ClipTransport.test.ts`.
- THE CLIP BUILDER: a clip is a GRID OF BEATS — columns are beats of the
  track's grid, rows are material that sounds together — and every source
  on the page (seed render, stems, clips saved earlier) sits on that one
  grid, which is what makes assembling one arithmetic instead of another
  stretch. Three layers, and they do not overlap:
  `app/src/beatifyClip.ts` is the pure model (a `Placement` is a
  CONTIGUOUS RUN of beats from one source, never a per-cell thing;
  `placeRun` carves/splits what a drop lands on, grows columns right and
  rows down) plus the IPC client; `app/src-tauri/src/beatify_clip.rs`
  resolves sources and files clips; `dj_analysis::beatify::build`
  (`span`, `clip_secs`, `assemble`) is the audio math, declick ramps and
  all. Tested at each layer: `app/tests/BeatifyClip.test.ts`,
  `BeatifyClipBuilder.test.tsx`, `cargo test -p dj-analysis --lib
beatify::build`.
- Clip-builder invariants worth not breaking: a run dropped in stays ONE
  block (three beats read as three-wide, not three cells), runs that abut
  keep a drawn seam (`abutsLeft`), a drop that does not fit GROWS the
  grid rather than being refused, and EXACTLY ONE of the source pane and
  the clip editor ever sounds — starting either pauses the other
  (`BeatifyTrackViewHandle.pause` one way, `onPlayingChange` the other)
  and a badge says which.
- A CLIP IS AS LONG AS IT WAS SET TO BE. `draft.columns` (the `beats`
  box in the editor header, `setColumns`) is the clip's length in beats,
  trailing silence included — it is what the grid draws, what loops and
  what the backend renders (`ClipDraft::length_columns`); `usedColumns`
  is only "where the material ends". Shortening TRIMS what no longer
  fits, because a beat that cannot be heard must not be pretended about.
- The builder is ONE COLUMN: source pane above, clip grid below,
  `.beatify-builder-main`, with the source list beside both. The grid's
  geometry is therefore PERCENTAGES of that column (`pct(n, columns)` in
  BeatifyClipEditor, no fixed px-per-beat), so the beats line up under
  the waveform at any width — do not reintroduce a `COL_W`.
- THE DRAWER PICKS THE SOURCE; THE PENCIL PICKS THE EDIT. Clicking an
  entry in the left-hand list only changes what the source pane is
  showing — it never touches the editor — and the ✎ on a saved clip only
  loads it into the editor, never the source. "+ new clip" clears the
  editor (and stops the clip's transport). Doing both at once was one
  click doing two jobs.
- SAVING IS FILING, AND FILING CLEARS THE DESK. A successful save puts
  the clip in the list and leaves the editor on a FRESH empty draft —
  building a set is building clip after clip, and the filed one used to
  sit there to be cleared by hand. One `clearDesk(filed)` does it for
  both the save and "+ new clip"; it takes the shelf as an argument
  because a save clears with a list `saved` has not caught up to yet. The
  clip transport stops (the editor renders the LIVE draft, so a cleared
  desk could only play silence) and the SOURCE pane is untouched — same
  seed, zoom, selection, playhead, still sounding — because that is where
  the next clip is cut from. The desk emptying is the one thing the note
  line reports on success (`"X" is saved — the desk is clear…`): not a
  congratulation, but the material's whereabouts. Reaching a filed clip
  again is the ✎, which is also the only way to Delete it now. A fresh
  draft is named `freshClipName(shelf)` ("Untitled clip", "Untitled clip
  2", …) because clips are filed by ID and the default name is now landed
  on after every save — two rows with one name are indistinguishable.
- A DRAFT'S IDENTITY IS `ClipDraft.id`, not its name: '' until it has
  been saved (`isSaved`), which is also what enables Delete. A draft with
  an id got it from the ✎ (`fromWire`), and saving it overwrites that row
  rather than breeding a copy — the id is the frontend's half of that, so
  do not go back to matching clips up by name or by diffing the list (a
  mutated-in-place list makes that silently wrong). Deleting the open
  clip removes the FILE and leaves the material on the grid, unsaved.
- The editor has its own selection: a swept rectangle of cells
  (`CellRange`, `cellRange`), drawn per row as `.beatify-clip-marquee`,
  with ⌘/Ctrl+C copying what is inside it (`copyRange`, TRIMMED at the
  edges, positions made relative) and ⌘/Ctrl+V pasting at the current
  selection's corner (`pasteFragment`, ordinary drop rules, so it
  overwrites and can grow the clip). Escape clears it. Cell presses
  `preventDefault()`, and `.beatify-builder` is `user-select: none`
  (inputs opt back in), because a drag across the grid was selecting the
  page's text — as was a sweep on the waveform before `AudioTimeline`'s
  mousedown started preventing it.
- Beats reach the clip TWO ways and both go through `liftSelection`: the
  `⠿ N beats` handle in the transport row, and dragging the selection
  DOWN out of the waveform (`AudioTimeline.onPullOut`, fired mid-drag
  when travel is downward, past `PULL_PX` and steeper than it is wide;
  the timeline then abandons its own gesture and the page owns the
  drag). Sideways is still slide/sweep, and the edge handles still win
  near an edge — press the MIDDLE of a selection to pull it out. The editor's transport renders the LIVE draft,
  so an edit mid-playback is heard: length changes `invalidate()`,
  everything else `refreshTone()`, the same split the Clip page makes.
- Clip-builder storage: saved clips are JSON only —
  `<data_dir>/beatify/<project-id>/clips.json`, one array, overwritten by id
  (saving under an existing NAME overwrites that clip rather than
  breeding copies) — because a clip is placements, not audio; it is
  re-assembled on demand. Stems become grid-aligned sources by being
  pulled through the seed's OWN warp map (`record.warp.map`) and cached
  as `<project-id>/stems/<name>.wav`; an unseparated stem is listed but
  disabled with the Clip-page hint, like every other optional dependency
  here. Nothing is written to the library: a clip is not a track.
- Beat Clip module (`builtin.beat_clip`, `crates/dj-engine/src/beat_clip.rs`
  + `engine/beat_clip_api.rs`): a saved Beatify clip played in the rack.
  THE CLOCK OWNS TEMPO AND PHASE — the interval between the last two
  rising edges on `clock` is one clip beat (so the playhead advances
  `beat_frames / interval` per output frame, and a clock at 2x the clip's
  tempo plays it at 2x), and every edge re-anchors `pos` to
  `beat * beat_frames`, so a multi-beat clip is never heard starting
  between ticks. NOTHING PLAYS UNTIL TWO EDGES HAVE MEASURED A TEMPO: one
  edge is a phase, not a speed, so the first edge only arms and the second
  is beat 0 (a gap longer than `MAX_INTERVAL_SECS` is not a tempo either —
  it re-arms). `reset` (and a fresh load) parks at beat 0, SILENT until the
  next edge, the `armed` convention `choreo` uses, but KEEPS the measured
  interval, so a running clock restarts the clip on its very next edge.
  `bpm` is the tempo the audio was rendered at — what one clip beat means —
  written by the loader from the project's grid. Panel readout comes from
  `BeatClipShared` (position/clock BPM/beat/playing atomics published once
  per block), like `AudioShared`.
- Decks bank (`builtin.decks`, `crates/dj-engine/src/decks.rs` +
  `engine/decks_api.rs`, Tauri `app/src-tauri/src/decks.rs`, page
  `app/src/components/DecksView.tsx`): EIGHT Beatify clips on ONE clock —
  the module behind the Decks tab. The bank owns the tempo (`bpm` knob)
  and a single beat position; a slot's playback rate is
  `bank_bpm / source_bpm` through the shared `stretch.rs` granular
  stretch, so a clip is stretched, never pitched. PHASE IS NOT PER SLOT:
  every slot reads the SAME beat position modulo its own loop length
  (clip beats + silent `tail`, minus its whole-beat `phase`), which is
  what makes a 2-beat clip and an 8-beat clip start together with no
  re-triggering; `cycle_beats` is the lcm of the loaded loops (how often
  the whole bank comes round). A freshly loaded clip is MUTED, un-shifted
  and tail-free — `decks_load` resets those, `decks_supply` deliberately
  does NOT (it is the app layer handing over audio for a binding that
  already exists, after a patch load or undo). The three tone controls are
  first-order crossovers where the mid band is the REMAINDER of low and
  high, so flat (1.0 = the surface knob at 12 o'clock) is bit-exact
  bypass; level/mute/monitor ramp per block rather than stepping. MONITOR
  (not solo) is per slot: it moves that deck from the bank's live pair to
  its `mon_l`/`mon_r` pair — a cue, so it changes nothing for the other
  decks. Slot state round-trips in the patch `ModuleFile` (`decks` field);
  the clips' AUDIO does not, so `decks_pending` reports what the app layer
  still owes and `decks::hydrate` re-assembles it beside
  `beat_clip::hydrate` — the Decks page also calls `decks_rehydrate` once
  when it opens, which is what makes a bank restored with the app sound
  again instead of coming back bound and silent. Golden:
  `decks-bank-two-clips` (the mix, the stretch, the phase); the sidecar
  carries the slot mix in a `deck_slots` section (a load resets a slot, so
  the case sets the mix after the audio).
- Decks JACKS are DELIBERATELY FEW (`decks_manifest`): `bpm` and `reset`
  in; `audio_l/r`, the monitor pair `mon_l/r` and one `clock` gate (a
  pulse a beat) out. Nothing is per slot. A bank once had a send, a return
  and three CV outs per deck — a wired return made the rack that deck's
  insert and a patched tone knob stopped cutting its band — and it was
  taken back out: A DECK IS A CHANNEL STRIP, its knobs always do their one
  job, and signal is routed on the Rack tab (where the bank is an ordinary
  module card, `clock` included). Do not re-add per-slot jacks without the
  user asking twice.
- Launch Control XL + decks (`launch_control.rs`, `decks_api.rs`,
  `app/src-tauri/src/launch_control.rs`): the surface drives a bank
  COLUMN-PER-SLOT (knobs high/mid/low, fader level, the two buttons TOGGLE
  mute and monitor) without being wired to it — the shell forwards device
  messages to `decks_feed`, which only reaches banks whose `surface` param
  is on, and `decks_inject` addresses one bank directly for tests (the
  `launchcontrol_feed`/`_inject` split, for the same reason). ONE PRESS IS
  ONE CHANGE whatever the template sends: both MIDI edges toggle, except
  an off within `MOMENTARY_RELEASE_SECS` of its own on (a finger coming
  off a momentary button) — a WALL clock, not the audio frame count, so
  the surface behaves the same with the engine stopped. Acting on the
  press alone is what used to make a factory-template toggle need a
  double-tap. LEDs go the other way:
  `decks_drain_leds` returns note-on messages for slots whose state moved
  (`led_for`: mute red, monitor green, both amber) on the channel the
  device last spoke on, and the shell's hot-plug watcher pumps them to the
  device's output port every scan; `decks_relight_surface` marks every
  lamp dirty after a (re)connect, because the device forgets.
- Audio OUTPUTS (`engine/lifecycle.rs`, `audio_outputs` /
  `set_audio_outputs` in `app/src-tauri/src/main.rs`): the graph fills two
  buses, the live mix and the monitor (cue) one, and `AudioOutputs` names
  the cpal device each plays out of (`None` = the system default live, no
  cue at all for monitor). The monitor is a SECOND stream fed from the
  live callback over an `rtrb` ring — one thread holds the core, the two
  devices run on their own clocks, and whoever is late finds silence
  rather than blocking the other. A monitor device that will not open
  loses the cue, never the live output. The choice belongs to the MACHINE,
  not the patch: it is stored with the app's settings, and takes effect on
  the next backend start, so `set_audio_outputs` restarts a running
  engine.
- `crates/dj-engine/src/stretch.rs` is THE granular time-stretch: two
  voices, Hann overlap-add at 50 % hop (exact COLA, so unity rate is
  transparent), each grain WSOLA-aligned within ±`SEARCH_SECS` of the
  virtual playhead. It owns no audio — `GrainStretch::tick(pos, step, ch0)`
  returns the taps (`pos` + window gain) and the caller reads its own
  channels, which is how the deck drives four stems off one grain
  schedule. Both the deck's KEYLOCK and Beat Clip's tempo follow use it:
  the playhead moves at the stretched rate, grains read at the source's
  own, so pitch never moves with tempo. A tempo change needs no
  `reset()` — the alignment search absorbs it, and a per-beat re-anchor
  crossfades through the overlap; reset only for a load/seek/cue jump.
- What a patch persists for a Beat Clip is the BINDING, never the audio:
  `ModuleFile.clip` (`BeatClipRef` = project id + clip id + display name),
  because a clip is placements re-assembled on demand. `Engine::
  beat_clip_bind` sets the binding alone; `beat_clip_pending()` lists the
  nodes whose binding has no audio behind it, and the app layer
  (`app/src-tauri/src/beat_clip.rs::hydrate`, called after patch load and
  after `apply_doc`, i.e. undo/redo/paste) assembles them via
  `beatify_clip::render_clip` — the deck-metadata pattern. A clip whose
  project is gone leaves the module silent and logs; it never fails the
  load. E2E cases instead carry rendered audio in the `events.json`
  sidecar (`beat_clip_load_file`), like deck tracks.
- A CLIP SAYS WHAT IT IS MADE OF. Every surface that offers a clip shows
  which parts of a track it holds, through the one `StemTags` component
  (`app/src/components/StemTags.tsx`, `.stem-tag` in `styles.css`): the
  picker's Clips tab, the Beat Clip panel, and the builder's own list. The
  answer is DERIVED, never authored — `beatify_clip::stems_of_clip` reads
  it off the placements (a run naming no stems is the whole mix; a run
  taken from an earlier clip contributes what that clip holds, to
  `MAX_DEPTH`) and folds them with `dj_analysis::stem_union`, which is
  where the "empty means all four" rule is pinned. `read_clips` tags every
  clip on the way out of the store and `beatify_clip_save` on the way back
  in, so clips filed before this are tagged the moment they are read and
  the field lands in `clips.json` from the next save without a migration.
  It rides to the rack on `SavedClip.stems` → `BeatClipEntry.stems` →
  `BeatClipRef.stems` (patch, `#[serde(default)]`, display-only like
  `name`, re-read on `hydrate`). In the UI all four parts are ONE `mix`
  chip rather than four, and an empty list draws nothing at all.
- The module picker has TWO TABS, not one gallery: Modules (the panel
  gallery, with its category pills) and Clips (`PickerTab` in
  `ModulePicker.tsx`), which lists `beat_clip_list` rather than module
  types; the `builtin.beat_clip` type itself is filtered OUT of the module
  gallery, since an unbound one plays nothing. Which tab was last open
  persists in `localStorage` under `PICKER_TAB_KEY`, so the picker reopens
  where you left it. The Clips tab is a LIST (clip name + Beatify project
  + length/tempo), driven entirely from the always-focused search box:
  the first match is selected as you type, ↑/↓ walk the rows (clamped at
  the ends), Enter drops the selected clip on the rack — so cmd+M, type,
  Enter is the whole gesture. Picking one adds the module
  and calls `beat_clip_load` (undoable under `EditKey::Track`, `async`
  because assembling decodes audio — assemble BEFORE taking the engine
  lock). That command also NAMES the module after the clip ("chorus stack",
  not "beatclip1") via `rename_module`, numbering a name already in the
  rack, and RETURNS the resulting instance id — the frontend re-keys its
  rack positions onto it exactly like a user rename.
- Copy/paste of a Beat Clip carries the audio, not just the binding:
  `paste_modules` calls `Engine::beat_clip_copy(from, to)` for each
  renamed pair that is a clip module on both ends (the `Arc<TrackData>` is
  shared, so nothing re-renders and a clip whose project is gone still
  copies), then `hydrate` covers the rest — a clipboard pasted into
  another patch, where the source no longer exists.
- Beatify detection degrades like the yt-dlp provider: `beat_this` (a
  PyTorch model) is an OPTIONAL runtime dep. `detect::probe_beat_this`
  FINDS it rather than assuming `python3`: it reads the shebang of a
  `beat_this` launcher (PATH plus `~/.local/bin`, `/opt/homebrew/bin`,
  `/usr/local/bin` — a Finder-launched app has none of those on PATH),
  then known `uv tool`/`pipx` env roots, then PATH interpreters, and the
  same probe asks torch for the device (cuda > mps > cpu; `mps` runs with
  `PYTORCH_ENABLE_MPS_FALLBACK=1` and the script retries a failed
  checkpoint on the CPU). Successful probes are cached per
  `DJ_BEAT_THIS_PYTHON`, failures are not, so installing the package
  takes effect without a restart. The embedded script calls `Audio2Beats`
  with SAMPLES it decodes from our temp wav (stdlib `wave` + numpy), never
  `File2Beats`: beat_this's loader goes through `torchaudio.load`, which
  torchaudio 2.9 removed, so the path-taking API fails on every file for a
  current install. The beats come back through a REPLY FILE, not stdout
  (torch and the checkpoint loader print where they like). A model that
  fails mid-run does not cost the analysis: `FallbackTracker` re-runs the
  DSP tracker and reports `dsp (beat_this failed: ...)` as the tracker id,
  which is what the payload and the verdict line show. Overrides:
  `DJ_BEAT_THIS_PYTHON` /
  `_DEVICE` (`auto` by default) / `_CHECKPOINTS`, `DJ_BEATIFY_FORCE_DSP=1`
  pins the fallback for tests. Without it the tab runs the built-in DSP tracker — the
  tested default — and the header carries the install hint. Multi-seed
  agreement (three `beat_this` checkpoints) is what fills the verdict
  line; a single tracker reports `singleTracker`, never a fake consensus.
- Beatify's meter law exists twice: `grid.rs` (`FLAM_GREEN_MS`,
  `STRETCH_GREEN_PCT`, `IN_BAND_SECS`, `LEAD_IN_MAX`, `MIN/MAX_STRIDE`,
  `anchor_stride`) and `app/src/beatify.ts`. `app/tests/BeatifyGrid.test.ts`
  parses grid.rs to pin them equal — change both sides together, like the
  knob/choreo twins. Beatify's IPC payloads are camelCase on both sides
  (the §5 record format is specified that way; one convention per
  feature).
- Beatify's golden-audio case lives in dj-analysis alongside the clip one
  (`tests/e2e/beatify/*.json` + `tests/e2e/goldens/beatify_*.wav`, third
  step of `scripts/regen-goldens.sh`); it renders a MONO drifting click
  track to keep the wav small — the stereo path is covered by the
  in-suite warp test. Everything else about the pipeline is pinned by
  `cargo test -p dj-analysis --release --test beatify`.
- The transport DERIVES the offset it starts a window at; callers hand it
  an ABSOLUTE position. Both halves of that rule were once broken and the
  page went silent: seeking inside a loop longer than one window loaded
  the loop's HEAD window and asked the element for `at - loop.start`
  seconds into it, and the element seek was armed with a one-shot
  `loadedmetadata` listener that outlived a replaced `src` and re-applied
  its offset to the NEXT window. Either way the element lands past the end
  of what it holds, ends on the spot, and `onEnded` chains into the next
  window — a playhead marching forward in perfect silence. So: `begin`
  computes the window AND the phase together and clamps the phase into the
  window; the element's pending seek is transport state (`pendingSeek`)
  applied by ONE permanent `loadedmetadata` listener owned by
  `attach`/`detach`. Media-element semantics that a boolean fake cannot
  show (async load, dropped early seeks, seek-past-end ⇒ `ended`) are
  pinned by `StrictElement` in `tests/ClipTransport.test.ts` — reach for
  it when a playback bug is about what the element actually does.
- THE WINDOW IS A CACHE, NOT A POSITION. A rendered (and, for a loop,
  decoded) window can be re-entered anywhere inside itself at once, so
  seeking into it and resuming a pause inside it must not touch the
  backend: `withinLoaded(at)` says whether it holds the target and
  `enter(within)` moves the position — `el.currentTime` for the element,
  a fresh node off the KEPT `PreparedLoop` for the gapless path (hence
  `install(source, win, prepared)`, and `drop()` where the window is
  really gone). `seek` while playing tries that first and only renders
  for a target outside the window; `play` tries it before every fetch, so
  pause/resume is instant; `pause` therefore KEEPS its window. This is
  what "I can't click to seek during playback" was: every click cost a
  whole window of DSP, and until it landed the old source played on and
  its playhead overwrote the click. `enter` is synchronous start to
  finish, which is why it may install without an epoch check — but it
  bumps the epoch, so a render in flight for somewhere else is dropped.
- ONLY PLAYBACK MAY WRAP. `advanceTo` (the element's `timeupdate` and the
  loop ticker — playback getting somewhere by itself) is the only
  playhead write that can cross `range.end` and trigger `wrapAt`;
  `setPlayhead` is the plain one every COMMAND uses. Pausing near the end
  of a loop used to park the playhead through the wrap check, which
  started the loop again a moment after the button said "paused" —
  `invalidate` had the same shape, and a seek past the loop end jumped
  the user back to its head instead of where they clicked.
- A ⌘-FREED CUT KEEPS ITS FRACTION. The clip's grid is whole beats and
  stays whole, but a selection freed from the grid is not: the run
  (`runOfSelection`) occupies every column its audio TOUCHES — `ceil`,
  never `round` — and records how much of that is audio in
  `Placement.audioBeats`; the rest of the last column is SILENCE, drawn
  as a dimmed tail on the block. Absent `audioBeats` means audio all the
  way across, so every grid-aligned run and every clip saved before this
  is unchanged on disk (`#[serde(default, skip_serializing_if)]` on the
  Rust `audio_beats`, and `build::span` takes fractional `take_beats`).
  Carving one (a drop over it, a copied range) clamps the audio each
  piece still has, and a piece left holding none is dropped rather than
  kept as an invisible silent block. Rounding the length was throwing
  away the very part of the take the user went off the grid to catch.
- NO STOP BUTTON ON BEATIFY. Pause keeps the playhead and Play carries on
  from it, which leaves Stop as "pause, and also lose your place" —
  `AudioTimeline`'s `onStop` is optional and Beatify's three surfaces
  (track view, modal, clip editor) pass none. `ClipTransport.stop(parkAt)`
  stays: it is how the page clears the desk or hands the speakers over.
  The Clip page still shows its ■.
- A LOOP ONLY DECIDES WHERE THE WRAP IS. `setLoop` never re-renders and
  never repositions: arming Loop over a selection ahead of the playhead
  plays INTO it, and dragging a selection edge while it plays does not
  interrupt a note. Playback returns to `range.start` when it CROSSES
  `range.end` (`wrapAt`, driven from `advanceTo`), so a range left
  behind the playhead is simply met on the next pass instead of yanking
  it backwards. What `setLoop` does do is switch OFF native wrapping
  (`el.loop` / `LoopHandle.setLooping`) whenever the loaded window is no
  longer exactly the armed range — otherwise the old edges keep wrapping
  and the new ones are never reached; the window then plays out and
  `ranOut()` picks the next one from the range armed BY THEN. Before this,
  every mousemove of a drag re-fetched a window, which is a stutter per
  pixel dragged.
- ONE audition timeline, `app/src/components/AudioTimeline.tsx`: waveform
  - ruler + selection gestures (sweep / edge-resize / slide /
    shift-extend) + wheel-zoom-around-cursor + transport row, extracted
    from the Clip page and reused by Beatify's modal AND track view. It
    draws and gestures only — audio stays in the parent's `ClipTransport`
    (all three pages now share that owner), selection/viewport are
    controlled props, and testids/classes are `${idPrefix}-…` so the Clip
    page's `clip-*` DOM contract is unchanged (it also emits the `clip-*`
    layout classes for shared styling; per-prefix CSS overrides colour and
    size). Domain drawings go through `renderUnder`/`renderOver(xOf)` so
    they follow zoom; quantization goes through the `snap` hooks —
    Beatify's `beatSnap(grid)` (BeatifyTrackView.tsx) snaps seeks to the
    nearest beat (⌘ frees), selections OUTWARD to whole beats, slides by
    whole beats; the Clip page passes no snap. Zoom law is
    `viewSpan`/`zoomView` (exported, pinned in BeatifyGrid.test.ts).
    BeatifyTrackView is keyed by track+render in BeatifyView so a new
    render remounts it (fresh transport/viewport/selection) instead of
    setState-in-effect resets.
- THE VIEW NEVER MOVES ITSELF AND A SWEEP NEVER MOVES PLAYBACK. Two rules
  that both come from the same complaint — the ground shifting under a
  gesture. (a) Nothing auto-scrolls the viewport during playback: where
  the track is zoomed and scrolled to belongs to the user, and the
  playhead is allowed to travel out of the window (PRD TV-13's Follow
  toggle is WITHDRAWN, not merely off). (b) In `AudioTimeline`, only a
  CLICK seeks, and it seeks on release; a drag that swept anywhere is a
  selection and leaves the playhead alone. `WaveDrag.swept/fresh` is what
  tells them apart — do not move the seek back to mousedown. (c) A CLICK
  ALSO LEAVES THE SELECTION ALONE: a press must not touch the selection,
  because at mousedown nobody yet knows whether it is a seek or a sweep.
  `swept` is a PIXEL test (`DRAG_PX`, against the press's `anchorX`, not a
  time epsilon — one pixel of jitter is not a gesture) and the first
  `onSelectionChange` of a fresh drag comes from the mousemove that passes
  it. Selections die only by an explicit act: Escape (both the Beatify
  track view and the Clip page), an edit that consumes them, undo/redo, or
  a new sweep.
- Beatify §6 open questions, decided: (1) loops follow `ClipTransport`'s
  `setLoop` policy, which is now "arming or moving a loop NEVER moves
  playback" (`loopWrapBeat` remains as pure math but the UI no longer
  schedules group-boundary wraps; the shared transport's behavior won);
  (2) re-beatifying HAS NO UI (MOD-A31): re-rendering a seed under the
  clips cut from it is a trap, so a second take is imported as a second
  seed and the first is deleted if it is not wanted (the backend's
  replace-a-seed path survives, unused, behind `save`'s `seedId`); (3) the lead-in is
  ONE global value (median onset offset + pad, `grid::lead_in`), because
  uniformity is what keeps cuts sync-safe; (4) the phase-1 click track
  ticks the DETECTIONS (over unwarped audio that is what proves the
  metrical level), the phase-2 click ticks the GRID; (5) the tab reads
  library tracks and writes nothing back to the library — a beatified
  render is not a new library track (unlike a clip), because it is the
  same performance, not a new one.
- Error surfacing is DOUBLE-CHANNEL: nothing the user can see may be
  invisible to a developer. Frontend (`app/src/errors.ts`): `reportError`
  (banner) logs through `logError` → `console.error('[context]', err)`,
  and consecutive duplicates collapse in BOTH channels so a 10 Hz poll
  can't drown the console. Panels that render their own inline error text
  instead of the banner (LibraryView search/download, ClipView decode,
  Beatify analyze/save, the camera panel's `[camera]` messages) call
  `logError`/`console.error` next to their `setError`; quiet IPC polls
  (`ipc.ts`) stay out of the banner but log `console.debug`; window
  `error`/`unhandledrejection` are routed to the banner+console by
  `installGlobalErrorHandlers` (main.tsx). Backend: every `CmdError` logs
  once where it is born (`CmdError::new` → `log_cmd_error`,
  `[dj-ipc] <kind>: …`, same consecutive-dup collapse — so never build one
  with a struct literal), patch-load / macro-pull warnings log where they
  are produced, and a failed download job logs in
  `dj-library::downloads`. Pinned by
  `app/tests/ErrorHandling.test.tsx`.

## The Beatify page at a glance

The detail is in the `Conventions` bullets above; this is the map.

- Where the code is. Frontend: `app/src/beatify.ts` (wire types, the grid
  and slider LAWS — `beatTime`/`beatAt`/`snapSelection`/`gridLod`/
  `anchorStride`/`scopePreMs`/`cutClearanceMs` — and `BeatifyClient`),
  `app/src/beatifyClip.ts` (the pure clip model and its client), and
  `app/src/components/Beatify{View,Modal,CutScope,TrackView,ClipBuilder,
  ClipList,ClipEditor}.tsx` over the shared `AudioTimeline`/
  `WaveformView`/`clipTransport`. Backend: `app/src-tauri/src/beatify.rs`
  (analysis + projects) and `beatify_clip.rs` (clips), both thin over
  `crates/dj-analysis/src/beatify/`: `detect` (beat_this or the built-in
  DSP tracker), `grid` (fit, reading, sweep, residuals, lead-in),
  `warp` (map + render), `scope` (the cut point inspector), `audition`
  (click track, sync check), `build` (clip assembly), `store` (the
  on-disk project).
- State ownership: there is no store. `BeatifyView` owns which project or
  track is open and nothing else; the modal owns the phase-2 controls
  (strength, lead-in, ruler group, region) while the ANALYSIS itself
  lives in the backend `BeatifySession` until Save — reading changes and
  the warp slider re-query it, so the frontend never recomputes a grid.
  The builder owns the live `ClipDraft`.
- Commands, all `#[tauri::command(async)]`: `beatify_tracker_status`,
  `_analyze`, `_set_reading`, `_meters`, `_scope`, `_preview`,
  `_sync_check`, `_save`, `_warp_map`, `_cancel`; projects add
  `beatify_projects`, `_project_new`/`_open`/`_rename`/`_delete`,
  `_project_set_bpm`, `_project_audio` (by `seedId`), `_seed_delete`,
  `_seed_rename`; clips add `beatify_clip_sources`, `_open`, `_audio`,
  `_preview`, `_save`, `_delete`.
- A project's name is the user's, never a track's. `beatify_project_new`
  and the mint-from-a-save path both fall back to `default_project_name`
  ("project 4" — its number on the shelf), and the label is typed in two
  places that share one path (`renameTo` in `BeatifyView`): the shelf's
  pencil, and the open project's own header, which turns into a box on
  click and is opened ALREADY in that state for a project just made, so
  it is named at birth. Enter/blur writes through `beatify_project_rename`
  (which persists and rejects an empty name), Escape abandons; an emptied
  box is an abandoned edit, not a rename. There is no Save button because
  there is nothing to save: every change to a project — its name, its
  tempo, its seeds, its clips — is written to disk by the command that
  makes it.
- Switching a stem off or back on is a change of TONE, not of source:
  `BeatifyClipBuilder` keys the pane by the MATERIAL (seed + revision,
  never the mix) and the mix rides in on `TrackViewSource.id`, which
  `BeatifyTrackView` turns into `transport.refreshTone()`. Zoom, scroll,
  selection, loop, playhead and playback all sit through it, both ways
  round — pinned by "keeps the view, the loop and the playhead, off and
  back on" in `BeatifyClipBuilder.test.tsx`, which fails the moment the
  key picks up the mix again. A submix that fails to open leaves the pane
  on the audio it already has (`setOpen` is never handed a null, and
  `ClipTransport.begin` drops a null render without releasing what is
  sounding), so a missing stem cache costs the switch, not the session.
- Beats are the unit of every gesture, but MIND THE TIMEBASE: the modal
  snaps to `sourceGrid` (source seconds), the track view and the editor
  to `grid` (output seconds, beat 0 padded). Selections grow OUTWARD to
  whole beats; a plain click seeks to the nearest beat, ⌘ frees it.
- ⌘ FREES ANY SELECTION GESTURE from the grid (TV-14a): `AudioTimeline`
  reads the modifier LIVE in the drag handler and skips `snap.range` /
  `snap.slide`, so a sweep, an end-drag or a slide can be eased off the
  beat and back on without letting go. Downstream of that the count of
  beats is a FLOAT: `beatsBetween` (never `snapSelection`) is what
  `BeatifyTrackView` reports, `beatCount` tidies float noise and formats
  it, and `selectionLabel` drops the group line for a fraction. The clip
  end stays whole — a run lands on a column and covers
  `Math.max(1, round(beats))` of them — and the fraction survives as
  `Placement.sourceBeat`, which is `f64` on both sides of the wire
  (`build::span` takes it; integers in older `clips.json` read back
  unchanged). So: free ends buy you the OFFSET into the source, never a
  fractional column. Pinned in `BeatifyGrid.test.ts`,
  `BeatifyClipBuilder.test.tsx` ("⌘-dragging the ends of the selection
  off the grid") and `beatify::build::a_freed_cut_reads_from_part_way_into_a_beat`.
- The lead-in (§3.7) is measured, stored in the record, and applied at
  CUTS ONLY — the grid never moves for it (MOD-22). Today the cuts that
  honour it are the modal's sync check; `build::span` still cuts clips
  flush with the beat, because a clip has no head room of its own to
  reach back into and giving it one changes what a clip's beat 0 means.
  That is the open item, and it belongs to the clip builder.
- A PROJECT is a TEMPO with material on it — not a track, and not a take.
  It is minted empty (`beatify_project_new`) and tracks are imported into
  it as SEEDS, one modal pass each. INVARIANTS, do not break these: the
  first seed sets `project.bpm`; every later seed is CONFORMED to it by
  scaling its own warp map by `projectPeriod / ownPeriod` and rendering
  once from the source (never a stretch on top of a stretch), so every
  seed shares one `period`/`phase` and beat *n* means the same instant in
  all of them — which is the whole point, since a clip may hold runs from
  several seeds. A seed keeps `sourceBpm` and the derived `speed`
  (`projectBpm / sourceBpm`). `beatify_project_set_bpm` re-renders every
  seed and MUST leave clips alone (a placement is a run of beats, and a
  beat is a beat at any tempo); a seed whose source has left the library
  is re-rendered by stretching its own render instead. The backend's
  re-render-in-place path keeps the seed's id and directory so clips keep
  resolving, but no button reaches it any more; deleting a seed
  leaves the project's tempo and its clips intact. A track may appear in
  any number of projects, so nothing is keyed by the track.
- Persistence, all machine-local and gitignored, one directory per
  project: `<data_dir>/beatify/<project-id>/` holds `project.json` (id,
  name, `bpm`, `updated`, and the seed list: `id`, `dir`, `name`,
  `trackId`, `sourceHash`, `sourceBpm`, `speed`) and `clips.json` — clips
  belong to the PROJECT, not to a seed. Each seed owns
  `seeds/<seed-id>/` with `meta.json` (the §5 record — grid, warp map,
  quality; also the sidecar format), `warped.wav` and `stems/<name>.wav`.
  Ids are minted `p<n>` / `s<n>`. Two older layouts are ADOPTED on read
  and never migrated: a directory named by source hash, and a project
  whose single seed's artifacts sit in the project root — `store::project`
  synthesises the envelope, and `store::seed_dir` keeps reading them where
  they are, so old work opens untouched. Writing always uses the current
  layout. Nothing about a project reaches the library DB.
- The two halves of the page. The SOURCE pane (`BeatifyTrackView`) shows
  one source of the open project — a seed (whole, or with parts switched
  off), or a clip saved earlier — and is where beats are cut FROM. The
  CLIP EDITOR (`BeatifyClipEditor`) is the grid they are dropped INTO.
  The left
  drawer (`BeatifyClipList`) lists the seeds and clips: clicking one
  changes the source pane only, its pencil opens a clip in the editor
  only. A STEM IS NOT A SOURCE: it is a seed with parts switched off, so
  stem toggles hang off the seed row and a source id names both —
  `seed:s2/drums+bass`. Ids are built and read ONLY through
  `seedSourceId`/`seedMix`/`parseSourceId`/`seedOfSourceId`/
  `stemsOfSourceId`/`isWholeSeed` in `app/src/beatifyClip.ts`.
- WHAT A SEED PLAYS IS DERIVED FROM ITS SWITCHES (PRJ-6a/6b), and this is
  the shape to keep: the builder stores WHICH ENTRY is open (`wanted`) and
  WHICH PARTS ARE OFF per seed (`stemsOff`), and `picked` — the id the
  pane opens, the transport fetches and a dragged run carries — is a
  `useMemo` over both. It used to be stored, with the toggle writing the
  new id into it only when it matched the entry the user had last CLICKED;
  since projects are minted empty, the open seed is usually one nobody
  clicked, so the switches lit up and the audio never moved. Anything that
  can change what is sounding belongs in that derivation, not beside it.
  `stemsOff[seedId]` ABSENT means untouched (play the render, separate
  nothing); PRESENT — including `[]` — means play the parts, all four
  named (`seed:s1/drums+bass+other+vocals`), so a switch leaves everything
  it did not touch sample-for-sample as it was. Backend twin:
  `is_whole_seed` in `beatify_clip.rs` (empty OR every STEM_NAME) names
  such a source after the seed and lets the whole kit fall back to the
  render when stems cannot be had. The first switch on a seed warps its
  parts onto the grid (seconds), so while the asked-for mix has not landed
  the seed's switch group is `aria-busy` (`settling` in the builder).
- The clip model is pure and lives in `app/src/beatifyClip.ts`: a
  `ClipDraft` is `{id, name, rows, columns, placements}`, and a
  `Placement` is a CONTIGUOUS RUN of beats from one source, never a
  per-cell thing. Columns are beats of the project's grid, rows are
  material that sounds together, `draft.columns` is the clip's length
  (trailing silence included). Backend twin:
  `app/src-tauri/src/beatify_clip.rs` (resolves sources, files clips);
  audio math: `dj_analysis::beatify::build`; the IPC client sits at the
  bottom of `beatifyClip.ts` and is keyed by `projectId` throughout.
- WHAT REMOUNTS WHAT, and why it matters: a remount throws away the work
  in the panes below it, so `key` is only ever the identity of the WORK.
  `BeatifyClipBuilder` is keyed by the project id ALONE — a tempo change,
  an import, a re-render are props it fetches around (`seedRevision`
  drives the `sources`/`open` effects), never a rebuild, because the
  half-built clip on the grid is the work. The source pane is keyed by
  the open seed AND its revision: a different seed or the same seed
  re-rendered at another tempo is a different timeline, so the viewport
  (which is in seconds) starts fresh. A MIX change — a stem switched off
  — is neither: same seed, same grid, same length, so the pane stays
  mounted with its zoom, selection and playhead, and `TrackViewSource.id`
  changing makes the transport `refreshTone()` the window in flight, the
  same move the Clip page makes for an EQ tweak. Pinned by
  `BeatifyClipBuilder.test.tsx` ("switching a stem off leaves the source
  where it was", "the project tempo changing under the builder") and by
  the DOM-node-identity check in `BeatifyView.test.tsx`.
- The page does not congratulate anybody. There is no success line on it:
  a re-tempo is announced by the BPM box and the re-rendered seeds, a
  saved clip by its name appearing in the list, a deleted one by its
  absence. Failures are not silent — every beatify command goes through
  `ipc.ts`, which puts a rejection in the banner AND the console — so a
  "could not …" line next to one is the same news twice. What is left in
  the builder's note line is refusals and consequences only ("Leave at
  least one stem on", "what is on the grid is now unsaved"), and a
  refused BPM is answered by the box springing back to the tempo the
  project still has.
- Playback ownership: EXACTLY ONE of the source pane and the clip editor
  sounds at a time. Starting either pauses the other
  (`BeatifyTrackViewHandle.pause` one way, `onPlayingChange` the other)
  and a badge says which. Both drive `ClipTransport`; the editor renders
  the LIVE draft, so a length change `invalidate()`s and everything else
  `refreshTone()`s.
- Conventions for future work here: key every clip command by
  `projectId` + `seedId`, never `trackId` (the track id is for reaching
  the ORIGINAL file — stems and re-render — and everything that needs it
  degrades with a hint when it is gone; resolve it by `sourceHash` first,
  since library ids are re-minted on re-import and audio is not); let
  the backend mint ids and say what it filed (`ClipSaved.id`,
  `BeatifySeed.id`) rather than inferring them; everything in
  `beatify*.rs` is offline `#[tauri::command(async)]` and must never
  touch the engine or the RT thread. Tests:
  `app/tests/BeatifyView.test.tsx` (tab, projects, seeds, modal),
  `BeatifyClipBuilder.test.tsx` (builder, mounted),
  `BeatifyClip.test.ts` + `BeatifyGrid.test.ts` (pure model and grid
  math), and `cargo test -p dj-analysis --release --test beatify`
  (pipeline, conform, store).

## The Decks page at a glance

The engine detail is in the `Conventions` bullets above; this is the map
of the page.

- Where the code is. Frontend: `app/src/decks.ts` (`DecksApi` and the
  slot model), `app/src/audioOutputs.ts` (the live/monitor device
  pickers) and `app/src/components/Decks{View,Slot,ClipPicker}.tsx`.
  Backend: `app/src-tauri/src/decks.rs` over `Engine`'s `decks_*` API.
- Layout: a top bar (tempo, beat readout, the two output pickers, the
  surface toggle) over eight FULL-HEIGHT channel strips, and that is all.
  NO PATCHING HERE — an in-tab rack grid with per-deck sends, returns and
  knob CV was built and reverted; cables live on the Rack tab, which
  already draws the bank (clock and monitor pair included) as a module.
  A strip's lamp row draws EVERY beat of the loop, silence included.
- State ownership: `decks_status` is the single poll (the engine owns
  phase and stretch — never recompute them in the page), and the only
  local state is a DRAFT of the control being dragged, which clears
  itself when the engine's reading agrees. The page reads no graph at
  all.
- Tests: `app/tests/DecksView.test.tsx` (strips, lamps, drafts, the
  output pickers, the rehydrate-on-open), plus the engine's
  `cargo test -p dj-engine --release --test integration decks` and the
  `decks-bank-two-clips` E2E golden.
