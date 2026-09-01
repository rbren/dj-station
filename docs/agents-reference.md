# dj-station agent reference (archive)

Detailed per-feature engineering notes, page walkthroughs and the manager
change log formerly in the root AGENTS.md. This file is ~40k tokens: do NOT
`cat` it — `grep -n` for the module/page you care about and read that window.
The code and its tests are the source of truth; treat this as a map.

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
- DELETING A LIBRARY TRACK is OWNERSHIP-BASED, and one verb:
  `Library::delete_track` drops the row (tags, crate membership, cues,
  loops and beatgrid follow it by `ON DELETE CASCADE`) and deletes the
  audio file ONLY when it lives under the data dir — a provider download
  or a rendered clip is the app's, a file in the user's own folders is
  never touched (`DeletedTrack.file_removed` says which happened, and the
  Library page's status line reports it). Either way the path is
  tombstoned in `deleted_files`, because otherwise the watch folder hands
  a deleted track straight back on the next launch; an explicit
  `import_file` of that path clears the tombstone (a change of mind).
  The shell's `delete_track` command composes the rest: cancel a stem
  separation in flight FIRST (it would write into the cache dir about to
  go), then `dj_analysis::remove_stems` (the whole `stems/<hash>/`, every
  backend's) and `ClipCache::forget` (SQLite re-uses the freed rowid, so a
  kept decode would answer for a different track). Nothing chases the
  references pointing AT the track — a beat clip's source, a saved
  patch's deck each degrade on their own, and a patch whose track
  file is gone now LOADS with a `load_warnings` entry and an empty module
  instead of failing (the undo/redo restore path logs and carries on).
  Pinned by `crates/dj-library/tests/{library,watch}.rs`,
  `dj-analysis`'s `stem_separation.rs`, the engine's `persistence.rs` and
  `app/tests/LibraryView.test.tsx`.
- A TRACK'S NAME IS THE USER'S, in two halves. At IMPORT the title is
  tidied once, in `dj_library::naming::tidy_title` (called by
  `import_file`, so downloads, the watch folder and rekordbox's local
  files all get it): the artist credit comes out (`strip_artist` —
  `Lizzo - Boys` with artist `Lizzo` files as `Boys`) and video-platform
  parentheticals go (`strip_noise` — `(Official *)`, `(HQ)`, `(HD)`,
  `(4K)`, `(Lyrics)`-style tags, an ALLOW-LIST so `(Remix)`, `(feat. X)`
  and `(Live)` survive). Both are deliberately timid — the credit must
  match the artist character for character (case aside) at the START or
  the END of the title, the join must contain real punctuation
  (`Lizzo Boys` and `Lizzo's Boys` are titles, not credits), and neither
  ever empties a title.
  There is no "raw title" column: a wrong guess is fixed by EDITING, the
  other half — `Library::set_track_names` (trims both, refuses a blank
  title, allows a blank artist) behind the `set_track_names` command and
  the click-to-edit title/artist cells in the Library page's rows, which
  patch the returned row in place instead of re-running the query the
  user is looking at. An edit that CHANGES THE ARTIST re-runs
  `tidy_title` on the title (the corrected credit is what lets a stale
  `Lizzo - …` be recognised); a title-only edit is stored verbatim, so
  hand-edits stick. Pinned by
  `crates/dj-library/tests/library.rs`, the `naming.rs` unit tests and
  `app/tests/LibraryView.test.tsx`.
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
- Math module (`builtin.math`, `crates/dj-engine/src/math.rs` +
  `engine/math_api.rs`): EIGHT OUTPUTS, ONE EXPRESSION — a line of
  Rust-flavoured arithmetic over `x` (the module's -10..+10 V input knob,
  wireable like any other) and `i` (the output jack's own index 0..7),
  evaluated per sample per jack. Rust is NOT compiled and never could be
  on the audio thread: the text is parsed CONTROL-side into a
  `MathProgram` (flat postfix `Vec<Op>` over a fixed 32-deep stack, depth
  and op count proven at compile time) and shipped as an `Arc` over an
  SPSC ring with a garbage ring for the off-RT drop — the choreography
  handoff, so `eval` allocates nothing, locks nothing and cannot panic.
  The accepted grammar is a SUBSET of Rust: `+ - * / %`, unary minus,
  parens, literals with `_`/exponent/`f32` suffixes, method calls
  (`x.sin()`, `x.pow(i)`, `x.clamp(a, b)`) and the same names as free
  functions, casts (`i as f32` is a no-op, `as i32` truncates, unsigned
  saturates at 0 like Rust), the variables `x`/`i` and the constants
  `pi`/`tau`/`e` plus `n` (= `MATH_OUTPUTS`). Results are clamped to the
  ±10 V rails and a non-finite value reads as 0 V — a wild expression
  must not blast or NaN what it is patched into. TWO VERBS, and the
  difference is what a broken text leaves running: `math_set_expr` is
  TYPING (state keeps the text, the error goes back for the panel, the
  last program that compiled plays on — a half-typed edit never glitches
  audio) and `math_set_state` is INSTALLING a saved state (patch load,
  undo/redo, macro adopt), which pushes `MathProgram::silent()` instead,
  because a module must not compute something nobody wrote; a patch
  holding an unparseable expression LOADS, silent, with a
  `load_warnings` entry. The expression is per-instance state in the
  patch (`ModuleFile.math`, skipped when absent so other goldens keep
  their bytes); the compile error is DERIVED and never persisted. Tauri:
  `math_status` (`engine_lock`, quiet) and `math_set_expr` under
  `EditKey::MathExpr(instance)`, so a burst of typing coalesces into one
  undo step — the panel (`MathPanel.tsx`) debounces keystrokes into one
  IPC and commits + `end_edit`s on blur. Pinned by `math.rs`'s unit
  tests (grammar/rails), `tests/integration/math.rs` and the
  `utilities-math-intervals` golden.
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
- Clock Multiplier (`extensions/clock_mult`, `com.dj.clock_mult`) is the
  rack's ONLY clock source, and its ratio is a knob-backed `mult` INPUT
  (never a param): a CONTINUOUS -64..+64, 1.0 default, whose value IS the
  ratio (output pulses per input pulse — `0.5` halves, `2.5` is five
  pulses every two). It is CV-able like any other input and read once per
  block. `0` freezes the grid; a NEGATIVE ratio walks it backwards at
  `|mult|` times the input rate, so the knob is symmetric about its
  centre. `ratio_of` resolves the value to an exact `(num, den)` and the
  pulse count is `floor(pos * num / den)`, firing on a crossing in EITHER
  direction, which keeps divisions phase-locked instead of drifting.
  Decimal thirds SNAP: a fractional part within `THIRD_SNAP_EPS`
  (0.002) of 1/3 or 2/3 becomes the exact rational (`0.333` ⇒ 1/3,
  `4.667` ⇒ 14/3), because a literal `0.333` slips a pulse every few
  hundred beats. The readout mirrors that law in `formatClockRatio`
  (`app/src/display.ts`, reached by `"map": { "kind": "clock_ratio" }` —
  `DisplayMap::ClockRatio` in `manifest.rs`) and shows `4x`, `2.50x`,
  `1/3`; `app/tests/Display.test.ts` greps the DSP constant so the two
  epsilons can't drift apart. The input rate comes from the last two
  rising edges like every other clock consumer; multiplied pulses are
  predicted from that interval (the phase is capped just short of the
  next input period so a late edge can't manufacture one), while
  divisions land on the clock's own edges. With nothing wired, before the
  first edge, or after the clock has been silent for 4 measured periods,
  it FREE-RUNS as if fed a 2 Hz clock — the fallback is an assumed input
  rate, so the knob still applies and a continuous ratio makes one on its
  own a clock at ANY tempo (`FREE_RUN_HZ * mult`: `2` ⇒ 4 Hz/240 BPM),
  and the next edge re-phases the grid. Tests and goldens build clocks
  that way: `add_clock(&mut e, "clk", hz)` in
  `crates/dj-engine/tests/common/mod.rs` adds one and sets
  `mult = hz / 2.0`; chain a second at `0.25` for a bar reset. Its output
  jack is `out`, not `clock`: no other manifest reuses one id across both
  directions, so don't start.
- There is NO dedicated Clock module: `com.dj.clock` (BPM/swing/bar with
  div/mul outputs) was deleted, and the Clock Multiplier free-running or
  chained covers what it did. A patch that still names it — or any module
  this build lacks — loads WITHOUT that instance and its wires, with a
  `load_warnings` entry, rather than failing (`patch.rs`, pinned by
  `persistence::a_patch_naming_a_module_this_build_lacks_loads_without_it`).
- Poisson Clock (`extensions/poisson`, `com.dj.poisson`): a GAMMA RENEWAL
  process, not a per-tick coin flip — every inter-event interval is a draw
  from `Gamma(shape = k, mean = 1/rate)`, so the `density` knob `k` is the
  one dial that walks from clumpy through exact Poisson to nearly regular
  (`k = 1` exponential gaps, `CV = 1/sqrt(k)` either side of it) WITHOUT
  moving the mean rate — density is texture, never tempo, and the tests
  pin that at every `k`. It runs on a phase accumulator measured in
  EVENTS (`phase += rate/sr`; an event when it passes a dimensionless
  `Gamma(k, 1/k)` draw), so a rate change stretches the interval in
  flight instead of being ignored until the next event. A wire into
  `clock` makes the incoming clock's measured rate the mean rate (one
  event per pulse) and parks the `rate` knob, the LFO's clock-sync
  arrangement; sub-multiples are a Clock Multiplier away, like every
  other clock consumer here. Draws are Marsaglia–Tsang gammas on a
  fixed-seed xorshift32 (reproducible renders; the rejection loop is
  capped so the RT thread can never spin), and the pulse carries one
  guaranteed LOW sample after it — at low `k` the process draws gaps
  shorter than a sample often enough to matter, and an event landing
  inside the pulse in flight WAITS, keeping its phase debt, instead of
  fusing into one long gate. That waiting is what keeps the measured rate
  honest: a merged burst would silently delete events (it read 20 % slow
  before the fix). Bypass hands the clock input straight to `out`
  (`"bypass": { "out": "clock" }`) — the randomiser steps aside and the
  clock walks through. Golden: `seq-poisson-gamma`.
- Sample & Hold (`extensions/sample_hold`, `com.dj.sample_hold`) ALREADY
  EXISTS — read `ls extensions` before writing a "new" module; several of
  the obvious utility names are taken. It is both classics in one panel:
  `mode` picks sample & hold (capture `in` on each rising edge of `trig`)
  or track & hold (follow while `trig` is high, freeze when it falls),
  and `slew` is a one-pole glide in seconds (0 = instant steps) that
  doubles as a lag processor in track mode. Its white noise is NORMALLED
  to the signal input — nothing patched to `in` makes the module the
  clocked random-voltage source, and patching `in` takes the noise off
  the sampler while leaving it on its own `noise` jack (the normal is
  `ProcessIo::connected_inputs`, which is how any module asks whether a
  jack is wired rather than guessing from its value). The PRNG is a
  fixed-seed xorshift32 stepped once per frame whatever the controls do,
  so renders are reproducible, and `save_state`/`load_state` carry
  (rng, target, level) across a graph edit. There is deliberately NO
  internal clock: with `trig` unwired the output simply holds, because
  the Clock Multiplier free-running is the rack's one clock source.
  Tests: the `sample_hold_*` cases in
  `tests/integration/modules_shaping.rs`; golden `mod-function-sh-voice`.
- Band Pass (`extensions/bandpass`, `com.dj.bandpass`) is the DEDICATED
  band-pass, next to the Filter's `bp` tap rather than instead of it: its
  band-pass sections are CONSTANT PEAK GAIN (the TPT/Cytomic SVF's `bp`
  tap scaled by `1/Q`), so `q` — 0.5 to 40 — is width and never level,
  which is what makes it a sweepable isolator instead of a volume pedal.
  `slope` runs the same section twice for 24 dB/oct skirts (unity peak
  either way, correspondingly tighter for the same `q`), `freq` is 1 V/oct
  read PER SAMPLE so an audio-rate modulator sweeps rather than steps, and
  `mix` blends the band back with the dry signal (0 = untouched,
  bit-exact). Nothing in it saturates and it never self-oscillates — that
  is `com.dj.filter`'s job, and the two are deliberately different
  instruments. Tests: the `bandpass_*` cases in
  `tests/integration/modules_shaping.rs`; golden `shaping-bandpass-sweep`.
- Comb Filter (`extensions/comb`, `com.dj.comb`): a delay line short
  enough to be a pitch, `tune`d in 1 V/oct like the Filter's cutoff, so
  the delay is one cycle of the tuning and the teeth land on its
  multiples. `feedback` is BIPOLAR (-0.98..0.98): positive peaks on
  multiples of the tuning, negative moves them to odd multiples of half of
  it (the hollow comb), and `mode` swaps the feedback (IIR, resonant
  peaks) loop for a feedforward (FIR, flanger notches) one on the same
  line. THE PEAK IS PINNED AT UNITY by trimming the INPUT (`1 - |fb|`,
  or `1/(1 + |fb|)` feedforward) rather than turning the output down after
  the comb: the loop then runs at signal level, so feedback is texture
  and never loudness, and — the trap — what guards the line is a HARD
  clamp, not a tanh: a soft saturator is already several percent down at
  ±5 V, and giving that back every pass flattened the resonance to 0.7 of
  where the maths said it should be. TUNING IS COMPENSATED, not
  approximate: the `damping` one-pole's group delay AND the sample between
  write head and read are taken off the requested distance, so darkening
  the comb does not flatten its pitch. `mix` at 0 is the dry signal
  bit-exact. Tests: the `comb_*` cases in
  `tests/integration/modules_shaping.rs`; golden `shaping-comb-sweep`.
- Module PRESETS are manifest DATA, not code, so any module can adopt
  them: `"presets": [{ "name": …, "values": { <input jack id>: value } }]`
  (`PresetDecl` in `manifest.rs`, values in the jack's own units, jacks
  the preset omits keep what the user set; `Extension::load` rejects a
  preset naming a jack the manifest lacks). `Engine::apply_preset` walks
  them through `set_knob_value`, so recalling one MOVES KNOBS AND NOTHING
  ELSE — wires, spread (atten/offset), wire mode and per-patch knob
  config overrides survive, and the result is ordinary knob state that
  round-trips through the patch (there is no "current preset" field, and
  a patch never records which preset it came from). The Tauri command is
  `apply_preset` under `EditKey::Preset` (one undo step); the frontend
  reads `manifest.presets` off the node it right-clicked and renders a
  "Presets" submenu — `ContextMenuItem.items` (one level deep,
  hover-or-click flyout, `.context-menu-sub`/`-flyout`). User-defined
  presets are NOT implemented; when they are, they belong beside this
  list, not inside it. Pinned by `tests/integration/presets.rs` and the
  "module presets submenu" cases in `app/tests/ContextMenu.test.tsx`.
- Spectral Noise (`extensions/spectral_noise`, `com.dj.spectral_noise`):
  white noise shaped by the first two terms of a spectral polynomial
  about the tilt frequency — `gain(f) dB = tilt·log2(f/f0) + curve·bell`.
  `tilt` IS the colour in dB/oct (0 white, -3 pink, -6 red/brown, +3
  blue, +6 violet — the built-in presets are just tilt values, plus grey
  and green which use the curvature term), `pivot` is the frequency both
  terms are written about, `curve` is the quadratic term realized as a
  bounded RBJ bell on the pivot (a literal x² diverges at both ends).
  The slope is a cascade of half-octave-spaced first-order low shelves
  over ±5 octaves around the pivot (straight to ~0.5 dB across the band;
  it flattens outside that span and near Nyquist, which is what makes the
  pivot audible for a pure tilt), and LEVEL IS NORMALIZED: the shaping
  filter's white-noise power gain is integrated on a fixed log grid at
  block rate and divided out, so a colour change is tone, never loudness,
  and violet cannot run 20 dB hot. At the defaults every section is an
  exact identity and the power gain is exactly 1.0, so white is white
  with no filtering at all — the tests lean on that (and on the fixed-seed
  PRNG being stepped once per frame whatever the controls do, which makes
  two renders' per-band ratio the filter's response rather than an
  estimate of it). Golden: `sources-spectral-noise`.
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
  `app/tests/AppShortcuts.test.tsx` — and, for the Decks tab's copy of the
  same view (keys + wheel pan under `dj-decks-zoom`/`dj-decks-pan`), by
  `app/tests/AppDecksRack.test.tsx`.
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
  effect checks the view directly (`rack` OR `decks`: the Decks tab shows
  the same canvas, so it gets the same shortcuts), and QwertyPanel/MidiPanel
  read `RackKeysContext` (`src/keyScope.ts`, provided around `.app-body`,
  default true for headless unit tests). Inside that scope the EDIT
  shortcuts (undo/redo, copy/paste, select-all, Backspace, cmd+M) stand
  down for a focused form control (`isEditableTarget`), but the VIEW keys
  (cmd/ctrl +, -, 0) deliberately do NOT: they move the camera, never text,
  and the Decks chrome is made of form controls whose focus a press on the
  canvas cannot take back (that mousedown preventDefaults, to keep the
  marquee out of a text selection) — gating them there left the Decks tab
  with dead zoom keys. Going inactive must RELEASE held
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
- The MIXER FAMILY is ONE desk at several widths: `com.dj.mixer4`,
  `com.dj.mixer8` and `com.dj.mixer16` are thin cdylib crates
  (`extensions/mixer{4,8,16}`) over the shared generic DSP in
  `extensions/mixer_core` — `Mixer<CHANNELS, FULL>`, an rlib, the ONLY
  crate under `extensions/` that is not a module (the workspace takes it
  as a member; `build-extensions.sh` skips any crate whose
  `crate-type` has no `cdylib`). A new width is a `Cargo.toml`, an
  `export_module!(Mixer<N, full>)` line and a manifest — never a copy of
  `process`.
  WIDTH COSTS CONTROLS: a module may declare at most 64 input jacks
  (the `connected_mask` is a `u64`, enforced by `Extension::load` and by
  a const assert on `Mixer::N_INPUTS`), so a FULL strip (`in{n}_l`,
  `in{n}_r`, `lvl{n}`, `pan{n}`, `mute{n}`, `solo{n}` — stride 6) tops
  out at 8 channels + master = 49 jacks, and the 16 is a LEVEL-ONLY
  summing desk (stride 3, no pan/mute/solo; 16 full strips would need
  97). `FULL` is the only thing that differs in the DSP, and a
  level-only strip is exactly a centred, un-muted full one, so both
  widths sum through the same arithmetic — adding a channel control
  means updating `FULL_STRIDE`, the manifest and `mixerLayout` in
  `panelLayouts.ts` together. The new widths declare
  `"bypass": {"out_l": "in1_l", "out_r": "in1_r"}` (channel 1 straight
  through, normals and master out of the picture, like the other stereo
  effects). Docs are one function too (`mixerDoc` in `moduleDocs.ts`),
  and every width shares `MixerUI`'s master meters.
  Mute/solo are per-channel `switch` INPUT jacks (`mute{n}`/`solo{n}`,
  gate law >= 1 V), not params — the WASM "params vs. inputs" rule above
  — so they are wireable and persist as ordinary knob state. The law
  lives once, in `process`: heard = un-muted AND (nothing soloed OR
  soloed), evaluated per sample so CV can drive it, with a 5 ms
  per-channel fade (`FADE_SECONDS`) that keeps a toggle from clicking;
  the first processed sample snaps instead of fading (`primed`).
  The 6-channel `com.dj.mixer` is RETIRED (`"deprecated": true`), not
  deleted or changed: it renders through the same shared DSP and its
  goldens (`utilities-mixer-mute-solo`, `utilities-mixer-stereo-pan`)
  are byte-identical, which is the proof the generic version did not
  move a sample. It gained no bypass map either — a retired module grows
  no new controls. Goldens for the rest: `utilities-mixer4-stereo-desk`,
  `utilities-mixer8-solo-chord`, `utilities-mixer16-summing`; the laws
  are pinned once per family in `modules_utilities.rs` (`MIXER_FAMILY`
  drives every mixer test).
- VCA `cv` ("Gain / CV") input default is 0.0 (closed/silent) in
  `extensions/vca/manifest.json` — the manifest is the single source of
  truth for module defaults (engine derives initial knob position via
  `position_for_value`; frontend imports the same manifest). Defaults only
  affect freshly added modules: patches serialize explicit knob positions,
  so goldens are unaffected by default tweaks.
- A `stepped` knob's DEFAULT is only reachable when `steps - 1` is a POWER
  OF TWO. `position_for_value` binary-searches a staircase, so it lands on
  the BOUNDARY between the detent below the asked-for value and the detent
  itself; only a boundary that is an exact binary fraction snaps back up to
  the detent that was asked for, and any other spacing silently starts the
  module one detent low. The Scope's `bins` (16..144, 17 detents) is sized
  for that and pinned by `integration scope
  the_bins_knob_steps_through_whole_band_counts`.
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
  mocks need `startDownload`/`downloadJobs`. The Library page RENDERS only
  a slice of that list: `visibleJobs()` in `LibraryView.tsx` shows the
  `RECENT_DOWNLOADS_SHOWN` (3) newest finished jobs plus EVERY in-flight
  one (queued jobs are `running` with `stage == "queued"`); polling,
  announcements and per-result matching still use the full list. Pinned by
  `app/tests/LibraryView.test.tsx`.
- The Library page's tabs are SOURCES (the local tracks — everything a
  clip can be cut from; its per-row button says `Clip`, since that is
  what it makes), BEAT CLIPS, then one per enabled store provider. The
  Beat Clips tab lists what `beat_clip_list` answers — one store, one
  list — and deletes through `beat_clip_delete`, which takes a clip id
  and answers with the list as it now stands (always confirmed:
  `beat-clip-delete-dialog`, like the track delete). Each clip row also
  carries an `Edit` button (`onEditClip`, absent when the host wires
  none) that opens it back on the Clip page; it is DISABLED on a clip
  filed before edits were kept (`BeatClipEntry.editable`), which is the
  one thing the store can say about a clip it cannot take apart. Every
  clip filter runs CLIENT-side over the list already in hand
  (`filterClips`/`sortClips` in `beatClip.ts`): the search box over the
  names a row shows, the stem chips, and the one FIELD filter a click
  sets — a Sources row's clip count, or a track/artist cell in a clip
  row. That count (`track-clip-count`) matches on `content_hash`, so it
  follows a rename, and clicking it opens the Beat Clips tab filtered to
  that one track (`clip-source-filter`, cleared by its own button or by
  clicking the tab itself, which always means "all of them"). The tab
  needs a `clips` prop; without one there is no tab and no count column.
- ONE TABLE LISTS THE SAVED CLIPS, in both places they are offered:
  `BeatClipTable` (`app/src/components/BeatClipTable.tsx`) draws the
  Library page's Beat Clips tab and the deck bank's load dialog
  (`DecksClipPicker`, which is that table in a `file-dialog` wide enough
  for it), so a column added on one is a column on both. The columns are
  name, TRACK and ARTIST apart (a clip can name several sources; each
  cell is one row of names), BPM, beats and stems as `StemTags` chips.
  Clicking a column title sorts by it — ascending, descending, then OFF,
  because `beat_clip_list` answers oldest first and that order is worth
  getting back — and the host owns the sort state, since the picker's
  ↑/↓ walk the same array the table draws. What a surface LETS YOU DO
  with a row is a prop that is simply absent where it does not belong:
  `onEdit`/`onDelete` (Library only — side by side in one
  `.row-actions` cell), `onFilterTrack`/`onFilterArtist` (Library only:
  in the picker a click already means "load this"), `onActivate` +
  `selectedClipId` (the picker's pick and keyboard cursor). Test ids
  come off one `testId` root: `<root>-row`, `<root>-<clipId>` (the name
  cell), `<root>-sort-<field>`, `<root>-stems-<clipId>`,
  `<root>-edit`/`-delete`, and the stem chips of `ClipStemFilter`
  (`<root>-filter-<part>`, `-filter-all`). Pinned by
  `app/tests/BeatClipTable.test.tsx` plus the two hosts' suites.
- THE DECK'S LOAD DIALOG ASKS FOR THE SONG FIRST. Given a `bankBpm`
  (`DecksView` passes the bank's ACTUAL tempo, not what a walk is aiming
  at), `DecksClipPicker` opens on a list of SONGS ordered by tempo,
  slowest first (`songsByBpm` in `beatClip.ts`: one row per source
  track, its tempo the MEDIAN of its clips, and one heading for the
  clips that name no source at all), scrolled so the song nearest the
  bank's tempo sits in the MIDDLE of the dialog and already picked —
  ↑ is slower, ↓ is faster, Enter drills into that song's clips, and
  `decks-song-back` (or Backspace on an empty search box) comes back
  out. The cursor is `index: number | null`, null meaning "wherever the
  list wants it", so narrowing the songs re-aims at the nearest tempo
  instead of parking on row 0 (and keeps the lint rule against setState
  in an effect happy). Without `bankBpm` — Decks V2, which adds a clip
  to a grid rather than to a running bank — the dialog is the flat clip
  table it always was. Test ids `decks-song-row` (`aria-selected` marks
  the cursor), `decks-song-back`, `decks-song-note`.
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
  reverse + gain), a parametric EQ (`bands` of RBJ peaking bells — same
  filter as the EQ module; empty/all-0 dB bands are an exact bypass), dB
  level breakpoints on the OUTPUT timeline (automation is timeline-based,
  so a cut shifts audio under it — deliberate, like a DAW),
  `crossfade_ms`, and a beat-tap `warp` + `beat_grid` (below).
  The page edits ONE source: `Open` REPLACES what is loaded, and there is
  no "splice on end" and no overlay lane — both were removed, model and
  all (the program has no `overlays`, and `ClipOverlay` is gone from
  `dj_analysis::clip`). `region.source` and the request's `sources` stay
  a LIST because that is the saved beat clip's format
  (`BeatClipEdit.sources`) and the renderer's own ability, not a UI one.
  Adjacent regions OVERLAP by the crossfade, capped at half of either
  neighbour: that one law exists twice — `splice` in
  `crates/dj-analysis/src/clip.rs` and `regionSpans` in `app/src/clip.ts`
  — pinned on both sides (`tests/clip_edit.rs`, `app/tests/ClipEdits.test.ts`);
  change them together. The same twinning holds for the tap warp:
  `warp_time_secs`/`warpTime` map output times through the anchors
  (identity outside them; the renderer stretches through the WSOLA
  `beats::warp::render` as its LAST stage). BEAT TAPS: right-shift during
  playback marks beats at the live element position; when playback stops
  the tapped span is MEASURED — `clip_tap_beats` runs the tracker over
  it and the taps choose the seed AND metrical reading that fit them
  best (`clip::beats_from_taps` → `grid::tapped_fits`, the lenient
  sibling of `grid::reconcile_taps`: no minimum count, no
  self-consistency gate, same candidate scan; `choose_tapped_fit` is that
  ranked list's head), so the grid is the chosen seed's beat times; a
  refusal comes back with empty `times` + a `detail` line and the raw
  taps make the grid themselves. EVERY seed's hearing rides back with the
  answer (`TappedSeed`/`ClipTapSeed`, best fit first) and the toolbar's
  seed picker re-derives the grid from another one without measuring
  again — the taps AUTOSELECT, they do not decide. LEFT shift is the
  ONE, and it is never a beat of its own: each left-shift tap is pulled
  onto the RIGHT-shift tap nearest it (the beat the hand meant) and from
  there onto the beat that tap landed on, so what is stored is a FLAG —
  `ClipGrid.ones`/`BeatGrid.ones`, indices into `times`, absent when
  nobody marked one and on every grid tapped before they existed. It
  rides in the program like the rest of the grid (undo, and
  `BeatClipMeta.edit` files it with the clip), moves with `extendGrid`'s
  renumbering, and is drawn over its hairline in `--ok`
  (`.clip-one-line`). Either way
  ClipView builds a grid covering ONLY the tapped span (`tapGrid` —
  average BPM of the beat list, first and last pinned; the toolbar's +/−
  buttons extend/shrink it a beat at a time via `extendGrid`) and
  composes the warp into the program (`composeWarp` for re-taps). The
  stretch correction happens every `sectionBeats` beats (toolbar slider,
  default 4): only every Nth beat is a warp anchor, and the beats between
  keep their tapped feel — `ClipGrid.times` holds the ACTUAL beat
  positions (its twin `BeatGrid.times` in `dj_analysis::clip`), the
  toolbar shows max/average flam, stretch and TAP MISS (`TapStats` —
  the miss is the hand against the beats the chosen seed heard, which is
  what says whether another seed is worth trying), and the waveform
  washes each correction section by its stretch ratio (`stretchBands`,
  `.clip-stretch-slower/-faster`, the section AVERAGE, drawn from the
  SESSION's own warp so a re-tap's washes replace the last one's rather
  than piling up on the composed program warp). A section's rate
  would otherwise be rectangular and STEP at each anchor, which clicks:
  `warp_smoothing` (program field, 0…1, second toolbar slider
  `clip-grid-smooth`, default `DEFAULT_WARP_SMOOTHING` = 0.3, 0 = the old
  hard step) eases it with a raised cosine over the section —
  `rate(u) = 1 + e·((1−s) + s·(1 − cos 2πu))`, mean `ratio` whatever `s`
  is, so ANCHORS AND SECTION DURATIONS ARE UNTOUCHED and at s = 1 the
  rate meets its neighbour's at the boundary. It is a MAP-TIME
  parameter, not baked into `warp`: `smooth_warp`/`smoothWarp`
  (twins, `SMOOTH_STEPS` sub-segments a section, `MIN_EASED_RATE` floors
  a wild one) densify the anchors inside `warp_map` and
  `warpTime`/`warpSource`, so the anchor list stays the beat structure
  the wash, `composeWarp` and the timeline edits read. The WHOLE session
  — taps, slider moves, seed picks, extensions — is ONE undo step:
  ClipView's `tapSession` re-derives
  the program from the same taps and REPLACES the present (no history
  push). Its controls are live while the GRID IT MADE is still the
  program's (`program.beat_grid === tapSession.grid`), NOT while the
  whole program object matches: tone edits (EQ, level automation) keep
  the grid and must keep the controls, and the timeline edits that would
  invalidate it drop it anyway. Taps are collected in a REF as well as
  state (`tapRun`) because stopping fires two status callbacks — a state
  mirror still holds the taps on the second and measures the span twice.
  Selections then quantize outward to the grid's actual beats
  through AudioTimeline's `snap` hooks — nothing snaps beyond the covered
  span, ⌘ frees the gesture, and the readout counts the beats selected
  (`beatSpan`); a TIMELINE edit (cut/trim/move/splice/gain — anything
  through ClipView's `applyTimeline`) maps its times back through the
  warp and DROPS grid+warp (`dropGrid`), since the anchors would point at
  moved audio. RENDERS ARE MEMOIZED in the shell (`ClipCache.rendered` +
  a render gate in `app/src-tauri/src/clip.rs`, keyed by the request sans
  `beat_grid`): preview windows, waveform peaks, detection and the save
  all render the same program, and a warped render is seconds of WSOLA —
  without the memo, play after an edit stalls for exactly that long.
  SAVING makes a BEAT CLIP, not a library track: `clip_detect_beats`
  measures an untapped span with the beat tracker; `clip_save_beat_clip`
  renders the selected span and cuts it to EXACTLY the beat count the
  save row showed — the UI sends `beats` (from `beatSpan` against a
  grid, ceil of span×bpm otherwise) and `pad_to_beats` fills a
  fractional tail with silence or trims a flam/rounding overhang, so two
  selected beats file as two — and files it in
  `dj_analysis::clip`'s store (`<data_dir>/beat-clips/`, `b<n>.flac` +
  `b<n>.json`, ignored by `custom/.gitignore` like `clips/`). A SECOND
  SAVE REVISES WHAT THE FIRST FILED: the page keeps the clip it made
  (`editing` in ClipView) and sends it back as `replace`, so
  `clip::update_beat_clip` rewrites that id's record, audio and bleed
  (a revision that dropped its bleed deletes the file, rather than
  leaving the old one to be played) instead of minting `b<n+1>`. The
  binding lasts until the top row opens a different track — a new source
  is a new clip — and every deck binding that names the id keeps
  working. A beat clip
  wears ONE label, its own name; where it came from is a POINTER, not a
  copied title. `BeatClipMeta.edit` (`BeatClipEdit`) files the whole edit
  — the program (so each region's source timestamps, EQ, level, stretch
  and beat grid survive), the filed span, and
  `sources: [{trackHash, stems}]` — so the clip can be reopened in the
  Clip page, and so a renamed track keeps its clips. THE GRID IT KEEPS IS
  ITS OWN: `BeatGrid::cut_to(a, b)` trims the tapped grid to the beats
  inside the saved span (the `ones` flags follow the beats they mark)
  before it is filed, because the beats either side of the clip were
  never in it. The pointer is `dj_library::content_hash` (SHA-256 of the
  audio file): a row id is re-assigned on re-import, a title/artist is
  the user's to edit.
  `beat_clip::source_info` resolves it through `Library::track_by_hash`
  and answers `title: None` when nothing matches — a source that was
  never recorded or has since been deleted is a normal state the UI says
  out loud, never a reason to hide the clip. `BeatClipMeta` still READS
  the legacy `sourceTitle` (`legacy_source_title`, never serialized):
  `adopt_legacy_name` folds it into the one name (`"clip · source"`) on
  every read, and `migrate_beat_clips` (called once at startup from
  `main`) rewrites the records in place. `BEAT_CLIPS_PROJECT_NAME`
  ("Clip tab") names the STORE a clip came from — what a deck shows over
  the clip's own name — and `clip::BEAT_CLIPS_PROJECT` ("beat-clips") is
  the store id every binding written now carries.
  REOPENING one is `clip_open_beat_clip` → `ClipViewHandle.openClip`:
  it hands back the filed program, span and bleed with every source hash
  resolved to the library row that holds that audio TODAY
  (`Library::track_by_hash`). A clip that records no edit, or one whose
  track the library has lost, comes back as a `problem` LINE rather than
  an error — the page shows it (`clip-unopenable`) where the editor would
  have been, because there is nothing there to cut; the clip's audio
  still plays.
  A beat clip NEVER overwrites the track it was cut from. Like the rack,
  ClipView stays
  MOUNTED while other pages show (App passes `active`; the component
  hides itself, pauses playback and detaches its shortcuts — space,
  ctrl/cmd+Z/shift+Z/Y).
  TWO PANES, TWO JOBS. The SOURCE TRACK at the top is the reference: the
  material as it was cut, with the beat grid, the splice joins, the taps
  and the selection on it. Its waveform is the DRY render — the timeline
  with no EQ and no level — so it NEVER moves under a tone edit; that is
  what makes it something to cut against. Under it, the SELECTION PANE
  (`ClipSelectionPane.tsx`) shows the selected span as it actually
  sounds, with the level automation lane beneath it (the lane's x-axis is
  the SELECTION's — plus its bleed bookends where it has them, see LOOP
  BLEED below — though the breakpoints it writes are still absolute
  output-timeline times), and it LOOPS. Clearing the selection — Escape,
  or the pane's own ✕ (`clip-sel-clear`, beside its play button) —
  takes the pane away and hands playback back to the source track; the
  BEAT GRID stays, because it was tapped against the material, not
  against the span. Above the selection waveform is a strip of BEAT
  FLAGS: one down-pointing triangle per grid beat, joined to the top of
  that beat's marker (`clip-sel-beat-flag`, `clip-sel-one-flag` when the
  beat is a one), and clicking one toggles whether that beat counts as a
  one (`toggleGridOne` in `clip.ts`, applied through ClipView's undoable
  `apply` and mirrored into a live tap session's grid) — the mouse
  saying what a left-shift tap says during playback. The strip is drawn
  only when the host passes `onToggleOne`; the pane's viewBox opens
  upward (`0 -HEAD`) so the flags hang above y=0 and nothing drawn on
  the audio had to move.
  Playback therefore has two owners, never both at once: a selection is
  auditioned by `ClipLivePlayer` (`src/clipLive.ts`) and everything else
  by `ClipTransport`. The transport streams the RENDERED edit: 60 s WAV
  windows through `clip_preview_audio`, chaining windows as they run out.
  THAT path belongs entirely to ONE owner, `ClipTransport`
  (`src/clipTransport.ts`):
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
  edit costs playback depends on WHAT changed (in the transport's path —
  a selection's tone costs it nothing, see the live player below): a
  TIMELINE change (sources/regions/crossfade — identity-compared on the
  memoized `request`, so keep `sourceRefs` memoized separately) invalidates,
  because every output time now means something else; a TONE-ONLY change
  (EQ, level) re-renders the window in place, debounced, and resumes at
  the same loop phase, since pausing for an EQ tweak would make the
  control useless for auditioning. A re-render keeps the OLD source
  playing until the new one is ready and swaps, rather than gapping.
  A SELECTION ALWAYS LOOPS (picking a span is asking to hear it round and
  round while you shape it); the Loop button only decides the case with
  nothing selected, where it loops the whole clip (it used to light up
  and do nothing), so a loop range routinely outgrows the 60 s window: a
  range that fits still runs on one gapless Web Audio buffer, while a longer
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
  A track also opens straight from the Library page: its `Clip` button calls
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
- TONE IS NOT A RENDER on the Clip page. An EQ knob or a level point
  used to cost a full offline re-render of the program, a WAV window over
  IPC, a decode and a source restart — measured on a 5-minute clip that
  is ~0.5 s of DSP for EQ alone and ~7 s once a tap warp is in the
  program, on top of a 350 ms debounce: several seconds before a knob was
  audible. The split that fixes it: the BACKEND renders the TIMELINE
  (regions, crossfades, the WSOLA warp — what audio exists and when) and
  the WEBVIEW applies TONE (parametric EQ, level automation —
  a filter coefficient and a gain). `ClipLivePlayer` (`app/src/clipLive.ts`)
  fetches the DRY selection once, loops it on an `AudioBufferSourceNode`
  through peaking biquads into a gain, and moves those params under the
  running audio: no fetch, no gap, continuous while dragging. Level
  automation is SCHEDULED, not sampled (`levelSchedule` lays the next
  ~400 ms of breakpoints onto the gain param every 100 ms, ramping to the
  span's last value at the loop seam and STEPPING back to its first) —
  sampling from a timer smears a hard cut across the tick. Material
  changes (a stem swap, a timeline edit) still cost a render, but the
  running loop keeps playing until the new buffer is decoded and the two
  are cross-faded at the SAME phase (~20 ms), so nothing ever stops for
  an edit. The preview is a very close TWIN of the saved render, not a
  bit-exact copy (float32 biquads, ramped envelope); what SAVES is always
  the Rust render, so keep `dj_analysis::clip` the authority and keep
  ClipView's `dryRequest`/`request` split — the dry one is what the
  source waveform, the audition and beat detection use, the full one is
  what the save files. Where a runtime has no Web Audio, or a selection
  is longer than one 60 s window, the page falls back to the transport
  and says so in the pane ("rendered" instead of "live").
- Clip playback has exactly TWO owners, `ClipTransport`
  (`app/src/clipTransport.ts`) for the source track and `ClipLivePlayer`
  (`app/src/clipLive.ts`) for the selection; ClipView holds no audio
  state and hands over in ONE effect (stop the outgoing owner first,
  `publish()` from the incoming one so the readout follows). Four
  invariants keep either from playing twice: ONE SLOT (`install` runs only
  right after `release`), EPOCHS (every command bumps one, every
  continuation rechecks after each await and drops out if superseded),
  NOTHING SOUNDS BEFORE ITS LAST CHECK (`clipAudio.prepareLoop` is
  side-effect free, `PreparedLoop.start` is synchronous) and DISPOSAL IS
  FINAL (a disposed transport refuses every command, so a StrictMode
  remount leaves nothing behind). Loops wrap at a sample boundary via an
  `AudioBufferSourceNode` (`<audio loop>` drops ~100 ms), falling back to
  the media element where Web Audio is absent. A TIMELINE edit
  (sources/regions/crossfade) halts playback; a MATERIAL edit (a stem
  swapped) re-renders the window in place and swaps without
  stopping; a TONE-ONLY edit (EQ, level) costs the transport a debounced
  re-render (and the live player nothing at all) — keep that split, and
  keep the staleness identity checks allocation-free or every keystroke
  reads as a timeline change. A re-render resumes where playback has got
  to BY THE TIME IT LANDS (`begin`'s `resumeAt`), not where it was when
  the render was asked for, or every swap replays the second it took.
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
- Beat Clip module (`builtin.beat_clip`, `crates/dj-engine/src/beat_clip.rs`
  + `engine/beat_clip_api.rs`): a saved beat clip played in the rack.
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
- LOOP BLEED is METADATA, never baked into the loop: a beat clip may
  carry `leftBleedMs`/`rightBleedMs` (`dj_analysis::clip::BeatClipMeta`,
  `#[serde(default)]`, so a clip saved before the field reads back as 0
  with no migration) with the spans themselves filed BESIDE the loop
  (`b<n>-bleed-l.flac` / `-r.flac`, `load_beat_clip` returning a
  `BleedAudio` and a missing file costing the overlay, not the clip). The
  loop stays exactly the beats that were selected. The Clip page asks for
  it with the selection's BOOKENDS — `clip-bleed-left`/`-right`, ms,
  default 0, drawn flanking the selection waveform through
  `ClipSelectionPane`'s `bookends`, so each control sits at the edge its
  material comes from — and `clip_save_beat_clip` cuts them out of the
  same render, clamped to what the edit can give.
  THE PANE DRAWS THREE PIECES, NOT A SUM: the bleed EXTENDS the selection
  waveform either side of the loop (`ClipSelectionPane`'s `bleed`, a
  region apiece with a seam line at each loop edge), because the pane is
  where the level is drawn and a picture of the overlay would hide which
  piece a move is about to change. The pane's x-axis is therefore the
  loop PLUS its bookends, and the level lane under it shares that axis
  (ClipView's `laneRange`, from `bleedWindows` — the drawn regions are
  exactly the windows that get fetched, so picture and audio cannot
  drift). That one point-and-click lane levels all three pieces
  INDEPENDENTLY for free: they are disjoint stretches of one timeline
  (`[start-L, start)`, `[start, end)`, `[end, end+R)`), automation is
  absolute-time, so a breakpoint belongs to whichever piece it lands in
  however they overlap when played. Saving needs nothing extra for that —
  `clip_save_beat_clip` slices the bleed out of the FULLY RENDERED edit,
  at its own place on the timeline, so each bookend's own level is
  already baked into the FLAC a deck loads. Whoever PLAYS the clip
  lays them over the seam (`playback::ClipBleed::tap`, read by the same
  grains as the loop so a bleed stretches with it): the RIGHT bleed (the
  audio that followed the clip) over the loop's START, the LEFT (the audio
  before it) over its END. That is what keeping it out of the audio buys —
  the FIRST pass goes without the right bleed, having no pass behind it to
  carry over, and the LAST pass without the left, which leans into a pass
  that is not coming. Both players count their own passes: the Beat Clip
  module counts seams since it was armed (a reset or a fresh load starts
  over; the count rides through a hot reload in `save_state`) and never
  has a last pass, while a Decks slot counts a pass only while it is being
  heard — so a queued deck comes in on a first pass — and takes no left
  bleed while it is armed to DROP. The Clip page's LIVE SELECTION is the
  third such player, so a bleed is set by ear rather than by saving one
  and loading a deck: `ClipLivePlayer` fetches the two bookend windows
  (`bleedWindows`, clamped to what the edit has — an empty window is an
  error at the other end, not silence) alongside the span itself. THE MIX
  IS THE GRAPH'S, ON PLAYBACK: each bookend gets a VOICE of its own
  (`bleedVoiceBuffer` lays it in a loop-length buffer at the place in the
  pass where it is heard — the right at the head, the left at the tail —
  and all three sources are started in one breath by `startVoice`, so
  they wrap in step). The loop buffer is handed to the host BARE, with
  the decoded bookends beside it (`onBuffer(loop, bleed)`), which is what
  the pane draws its three regions from. Each part carries its OWN level
  gain, scheduled from where its material sits on the timeline
  (`VoicePart.levelStart`: the loop at `span.start`, the right bleed at
  `span.end`, the left bleed at `span.start - len`, all through the same
  `levelSchedule`) — that, and nothing else, is what makes a fade over a
  bookend leave the loop it lands on alone. EQ stays shared (it is the
  clip's tone); the old single `levelGain` in the chain tail is now a
  unity `master`. Every pass an auditioned selection plays is a MIDDLE
  one — both bookends over the seam — since it loops for as long as it is
  watched. Pinned by `clip_edit.rs`'s
  `a_clips_bleed_is_filed_beside_its_loop_never_inside_it`, decks.rs's
  `the_bleed_skips_the_pass_a_deck_comes_in_on_and_the_pass_a_drop_ends`,
  the `beat_clip` integration suite, `ClipLive.test.ts`'s "the live loop
  plays its bleed" and `ClipView.test.tsx`.
- Decks bank (`builtin.decks`, `crates/dj-engine/src/decks.rs` +
  `engine/decks_api.rs`, Tauri `app/src-tauri/src/decks.rs`, page
  `app/src/components/DecksView.tsx`): EIGHT beat clips on ONE clock —
  the module behind the Decks tab. The bank owns the tempo (`bpm` knob)
  and a single beat position; a slot's playback rate is
  `bank_bpm / source_bpm` through the shared `stretch.rs` granular
  stretch, so a clip is stretched, never pitched. PHASE IS NOT PER SLOT:
  every slot reads the SAME beat position modulo its own loop length
  (clip beats + silent `tail`, minus its whole-beat `phase`), which is
  what makes a 2-beat clip and an 8-beat clip start together with no
  re-triggering; `cycle_beats` is the lcm of the loaded loops (how often
  the whole bank comes round). A NEW CLIP IS A NEW DECK. A freshly loaded clip
  arrives CUED (un-muted with monitor on, so it is audible in the
  headphones but not the live pair — see `hand_slot_clip`'s `fresh`
  path) and with EVERYTHING the last clip was played with put back:
  tail, ratio, shift, level, the three tone controls, wet,
  `insert_monitor` and `live_level` all return to
  `DeckSlotState::default()`, because a fader pulled down or a band cut
  was said about the clip that has gone. `decks_load` does that reset;
  `decks_supply` deliberately does NOT (it is the app layer handing over
  audio for a binding that already exists, after a patch load or undo).
  The deck's CABLES go with the clip too, but one level up:
  `Engine::decks_unplug_slot` pulls the slot's own send, return and
  three tone CVs, and it is the SHELL's `decks_load` (`app/src-tauri`)
  that calls it — a patch load hands a slot audio for a graph it has
  just read, and must not rewire it. Only the slot's jacks: the bank's
  outputs, clock and tempo input belong to the bank, not to what is in
  deck three.
  A LOAD LINES THE CLIP UP BY ITS ONES, not by its first beat
  (`DeckSlotState::align_phase`): a clip's grid marks which of its beats
  are downbeats (`BeatGrid::ones`, cut to the clip when it is saved and
  carried into the engine on the BINDING — `BeatClipRef::ones`, refreshed
  on every load/hydrate like `stems`, and the one field there that is not
  display only), and the fresh shift puts the FIRST of them on the bank's
  beat 0, so two clips that pick up before their downbeat still hit those
  downbeats together. Loops whose lengths do not divide each other only
  ever share beat 0 — the relaxation one clock has always made — and a
  clip that marks no ones lands unshifted, exactly as before.
  `DeckSlotState::lead_one` is which one a deck is lined up BY at any
  moment: the clip's first until a SHIFT hands the job to whichever one
  now comes round first after the bank's downbeat. Status carries both
  ratio-divided, like `beats` (`DeckSlotStatus.ones`/`lead_one`).
  The three tone controls are
  first-order crossovers where the mid band is the REMAINDER of low and
  high, so flat (1.0 = the surface knob at 12 o'clock) is bit-exact
  bypass; level/mute/monitor ramp per block rather than stepping. A
  SLOT'S LEVEL IS UNITY AT MID-TRAVEL, like a tone knob's flat
  (`LEVEL_UNITY` = 1, `LEVEL_MAX` = 2 in decks.rs, mirrored in
  `app/src/decks.ts`): a clip plays exactly as imported with the fader
  halfway up and the half above is up to +6 dB for a clip cut quiet — on
  the strip AND on the Launch Control XL fader, which spans the same
  0..`LEVEL_MAX`. The stored level is a plain GAIN MULTIPLIER and always
  was, so a patch saved when the fader stopped at unity plays back
  identically; all that moved is where those gains sit on the travel (a
  saved 1.0 is now mid-fader, not the top). Double-clicking the fader
  (Knob's `onReset`) puts a deck back to unity; a load still leaves the
  level the user set alone. Each deck's OUTPUT LEVEL is metered on the
  RT thread — the peak of what that deck actually put on its bus,
  decaying exponentially over `METER_WINDOW_SECS` (1 s), published as
  `DecksShared::slot_output_level` / `DeckSlotStatus.output_level` — so
  the page tints a strip with the reading instead of point-sampling it
  at 100 ms (`--deck-level`, see the Decks page section). MONITOR
  (not solo) is per slot: it moves that deck from the bank's live pair to
  its `mon_l`/`mon_r` pair — a cue, so it changes nothing for the other
  decks. QUEUE/DROP (`DeckArm`, `Engine::decks_arm`, page buttons under
  mute/monitor) are the mute taken on the bank's grid: the mute is
  written THEN AND THERE (queue unmutes, drop mutes — so the patch and
  every mirror already hold the destination) and the RT thread holds the
  gain the old side until the beat: a queued deck comes in when its
  clip's own FIRST beat next comes round (the loop seam — so it always
  enters from the top of its loop, never mid-clip; it was "the bank's
  next beat" for one commit, and the user asked for the seam), a
  dropping one plays its clip's last beat out (the tail does not stall
  it). An arm is TRANSPORT,
  not patch state — nothing serializes it, a load/clear/restore clears
  it, `DeckArm::None` cancels (putting the mute back), and the mute
  button overrules any pending arm. Serials on `DecksCmd::Arm` published
  back through `DecksShared` let `live_arm` tell "fired" from "not seen
  yet". Slot state round-trips in the patch `ModuleFile` (`decks` field);
  the clips' AUDIO does not, so `decks_pending` reports what the app layer
  still owes and `decks::hydrate` re-assembles it beside
  `beat_clip::hydrate` — the Decks page also calls `decks_rehydrate` once
  when it opens, which is what makes a bank restored with the app sound
  again instead of coming back bound and silent. A BANK MUST HAVE
  SOMEWHERE TO PLAY: `decks_connect_outputs` gives a LOOSE live pair an
  Audio Output and a loose cue pair a Monitor Output, adding whichever
  the patch lacks (`decks_loose_outputs` says which pairs go nowhere), and
  `decks_ensure` calls it when the page opens as well as when it makes a
  bank. The live pair used to be wired only if the patch happened to own
  an Audio Output while the cue pair always got one, so a bank in a patch
  without one played into the headphones and nowhere else. A pair the
  user has routed is never touched, and nothing to do is not an undo
  step. EACH OUTPUT PAIR HAS A MASTER FADER (`MasterBus`,
  `Engine::decks_set_master`, `master_live`/`master_monitor` in
  `DecksState` so they ride in the patch): the last thing a pair passes
  through, ramped like a slot's gain and starting AT unity so an untouched
  bank multiplies by exactly 1.0 (old goldens stay byte-identical). The
  two are independent — pulling the room down never touches what is being
  cued. Goldens:
  `decks-bank-two-clips` (the mix, the stretch, the phase) and
  `decks-master-mix` (the live master, and the cued deck staying out of
  the room; the faders ride in that case's saved patch, so it pins the
  round trip too); the sidecar
  carries the slot mix in a `deck_slots` section (a load resets a slot, so
  the case sets the mix after the audio).
- A DECK CAN RUN AT A RATIO OF THE BANK'S GRID (`DeckSlotState::ratio`,
  `Engine::decks_set_ratio`, the strip's clickable BPM label): ×2 is
  double time, ×1/2 half time, ×1 back on the grid — the page offers 3,
  2, 1, 2/3, 1/2, 1/3 (`DECK_RATIOS` in `app/src/decks.ts`). The whole
  of it is ONE DIVISION on the control side: the deck's BASELINE tempo
  becomes `source_bpm / ratio` (`grid_bpm`) and its clip takes
  `beats / ratio` of the bank's beats (`grid_beats`, rounded — a clip
  whose beat count does not divide leaves a sliver of silence at the
  seam), so the same clock, the same phase alignment and the same
  granular stretch play it faster or slower without moving its pitch.
  THE RT THREAD KNOWS NOTHING ABOUT RATIOS: `DecksCmd::Timing` carries
  the already-divided grid (that is why `beats`/`source_bpm` moved off
  `DecksCmd::Load`, which now only hands over audio), and
  `DeckSlotStatus.beats`/`stretch` are the divided ones too — the lamp
  row is the loop as the bank counts it and the stretch is what the
  audio is really doing. It is patch state (`#[serde(default)]`, skipped
  at 1 so old patches keep their bytes) and grid state like the tail and
  the shift: `decks_load`/`decks_clear` put a deck back on the grid,
  `decks_supply` does not, and the edit coalesces under
  `EditKey::DeckSlot`. The strip's label says the baseline and the ratio
  that put it there (`70 bpm ×2 +82.9%` for a 140 BPM clip in double
  time), and its menu is a PORTAL because the strip row scrolls. Pinned
  by `integration decks` (`a_deck_can_run_at_a_ratio_of_the_banks_grid`,
  the patch round trip), `DecksView.test.tsx` and the
  `decks-ratio-double` golden (two decks on one clip, one of them
  double time with a beat of rest, so both still come round together).
- THE BANK HAS A TRANSPORT AND STARTS STOPPED (`DecksCmd::Transport`,
  `Engine::decks_set_running`, `DecksStatus.running`, the page's
  Start/Stop pair): a bank is created — and restored from a patch —
  STOPPED, parked on beat 0 with its clock still, because opening the
  Decks tab is not a reason to make a noise (the tab used to be playing
  the moment it was opened, with only a "restart" button to press). The
  transport is TRANSPORT, not patch state: nothing serializes it (only
  the hot-reload state blob carries it, so a module rebuild does not
  stop a set), so every test that wants to HEAR a bank has to start it —
  see `bank()` in the integration tests and the e2e harness, which
  starts every bank in the case's patch. Stopping FADES: the slots ramp
  to silence through their own gain smoothing and the beat counter parks
  only once they are out (`SILENT_GAIN`), so a stop neither clicks nor
  jumps, and the next start comes in from the top of every clip. A
  started bank keeps running while another tab is on screen — that is
  the audio-focus rule's job, not the transport's.
- Decks JACKS (`decks_manifest`): `bpm` and `reset` in, plus ONE RETURN
  per deck (`d<N>_in`); `audio_l/r`, the monitor pair `mon_l/r`,
  one `clock` gate (a pulse a beat) and per deck ONE SEND (`d<N>_out`)
  and the three tone controls as CV (`d<N>_high/mid/low`) out. A DECK'S
  LOOP IS MONO — one cable each way (the send is the deck's two channels
  summed, what comes back is heard on both sides), because a stereo pair
  of sockets per deck was four cables of chrome for a loop that is nearly
  always one box. THE RACK IS THE BANK'S EFFECTS LOOP: a deck's send
  always carries its audio; a wired return makes the modules in between
  that deck's INSERT (read off the block's input mask, so the RT thread
  never walks the wire list) while fader/mute/monitor stay
  the deck's; and a PATCHED tone CV takes that band off the deck (it
  sits flat — a knob doing two jobs is a knob you cannot read) and the
  knob drives the jack instead. `sync_decks_routing` pushes the patched
  set to the RT thread after every wire change (`DecksCmd::Tone`);
  `DeckSlotStatus.insert`/`tone_patched` report it to the page. The
  per-slot jacks were built (f11c2a4), reverted (c82217c — the bespoke
  in-tab mini-rack around them "turned out horribly"), and REBUILT on an
  explicit second ask, this time with the real rack canvas (see the
  Decks page section below). Goldens: `decks-rack-insert` (a deck routed
  out through a VCA and back, full wet) and `decks-insert-wet` (the same
  loop half wet through a waveshaper, with the insert cued — the room's
  side is unchanged by the cue).
- HOW MUCH OF AN INSERT IS HEARD IS A KNOB, NOT A SWITCH
  (`DeckSlotState::wet`, `SlotControl::Wet`, the strip's WET dial): the
  deck's own path and what came back are crossfaded per sample, so 0 is
  the deck dry — a bypass in everything but name, which is what the ask
  started as — and 1 is only the rack's answer. A slot with nothing in
  its return has nothing to fade into, so the knob has no say there. It
  defaults to 1.0 and is `#[serde(default)]`, so patches saved before it
  reload hearing their insert in full. CUEING AN INSERT
  (`DeckSlotState::insert_monitor`, the small square M beside the
  sockets) sends what came back to the MONITOR pair: a deck that is not
  itself cued keeps playing into the room while the rack's answer is
  auditioned in the headphones, and one that IS cued hears that answer in
  place of its own mix rather than twice. Neither control is on the
  Launch Control XL — the surface's six rows are still the six mix
  controls.
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
  engine (re-picking the device already chosen is a no-op UNLESS nothing
  is playing, which makes the picker a "try again" button).
- A DEVICE CAN LEAVE MID-SET (the headphones come out), and the `dj-cpal`
  thread is a SUPERVISOR, not a one-shot setup, because of it. It watches
  the streams it opened — `StreamWatch`: cpal's `DeviceNotAvailable`, or
  the callback counter standing still for `DEVICE_STALL` (CoreAudio just
  stops pulling, with no error to wait for) — drops them when one is
  gone, and re-opens every `DEVICE_RETRY` (a named live device that is not
  there falls back to the system DEFAULT; the cue never falls back, since
  a private mix in the room's speakers is worse than no cue). The two
  streams are ONE session, rebuilt as a pair, because the ring between
  them is built with them. WHILE THERE IS NO DEVICE THE GRAPH STILL RUNS:
  `pace_silent` processes blocks at wall-clock pace into nothing. That is
  the whole fix for "unplugging the headphones freezes everything" — a
  graph nobody processes never drains the RT command ring, so every
  control-thread edit behind it blocked (`dispatch_edit`'s 500 ms
  deadline, once per command, with the engine mutex held) and the app
  froze. What actually reached hardware is published as
  `AudioDeviceStatus` (`Engine::audio_device_status`, `playing_live` /
  `playing_monitor` / `note` on the `audio_outputs` command) — never
  guessed by the UI. Pinned by `lifecycle.rs`'s own unit tests (the stall
  clock) and `--test integration telemetry`
  (`a_backend_with_no_device_claims_no_output`).
- The OUTPUT PICKERS live in the DECKS TOP BAR, one per master fader row
  (`app/src/components/AudioOutputSelect.tsx`: the `useAudioOutputs`
  hook + a per-bus `AudioOutputSelect`, both consumed by `DecksView`'s
  `.decks-out` rows — one hook instance, so a choice on either bus writes
  a complete live+monitor assignment; there must never be two pollers).
  The hook polls `audio_outputs` every 2 s, because devices come and go
  without the app doing anything, and the bar shows the engine's `note`
  verbatim rather than inventing an explanation. The app header carries
  no picker (and no patch title, engine-status pill or Add Module button
  — File menu, ⌘M and the rack context menu own those verbs; tests read
  the working name from the Save As dialog's default, which derives live
  from the workspace's patch name). Tests:
  `app/tests/AudioOutputSelect.test.tsx`.
- WORKSPACES (`Workspace` in `crates/dj-engine/src/engine.rs`): the Rack
  tab and the Decks tab are TWO SEPARATE RACKS sharing one engine. Every
  top-level module carries a `workspace` tag (`NodeInfo.workspace`,
  `rack`/`decks`; `rack` is the serde default and is skipped when
  serialized, so pre-workspace patches and hand-written test docs load
  unchanged). Macro members inherit their instance's tag; `collapse_to_
  macro` keeps the members' workspace and `break_macro` frees them into
  the instance's (`macros_api.rs`). `Engine::set_module_workspace` /
  `module_workspace` move/read tags with one replan. PATCH FILES ARE
  WORKSPACE-NEUTRAL: a named save writes ONE workspace as a standalone
  doc with tags stripped (`PatchDoc::retain_workspace` +
  `strip_workspaces`, composed by `workspace_doc` in `main.rs`), and a
  load re-tags what it merges (`PatchDoc::merge_workspace`, which keeps
  the resident workspace's ids and renames incoming collisions away) —
  which rack a file loads into is the FOLDER it lives in: rack patches
  under `patches/`, deck patches under the sibling `deck_patches/`
  (`workspace_patches_dir`). The shell keeps one working name + saved
  baseline PER workspace (`ws_name`, `mark_saved_ws`, `patch_dirty`), so
  New/Open/Save on one tab never dirty or reset the other; the autosave
  is the ONE full-engine snapshot that keeps tags (its `deck_name.txt`
  sidecar restores the decks working name on restart). All patch/file
  commands take an optional `workspace` arg; absent means rack, so every
  pre-workspace caller keeps its meaning (`ws_arg`). The frontend mirrors
  this: the rack store holds ONLY the open tab's workspace (App filters
  the engine snapshot through `inWorkspace`; `allNodes` keeps the full
  list for instance-id uniqueness), `addModule`/`pasteModules` tag the
  open workspace, zoom/pan/patch-name are per-workspace state, and the
  header patch title, cmd+S/O/N, the File menu (backend `file_save`
  routes by audio focus) and the context menu all act on the open tab's
  patch. Tests: `cargo test -p dj-engine --release --test integration
  workspaces`, the `workspace-focus-split` E2E golden,
  `app/tests/AppWorkspaces.test.tsx`.
- AUDIO FOCUS (`AudioFocus`/`Engine::set_audio_focus`, `Plan::focus` in
  `graph.rs`, `set_audio_focus` in `main.rs`, `audioFocusForView` in
  `app/src/App.tsx`): ONE PAGE SOUNDS AT A TIME — each page plays its own
  WORKSPACE: the Rack tab the rack-tagged modules (the default tag, so
  tests, offline renders and pre-workspace patches stay wide open), the
  Decks tab the decks-tagged modules plus every bank and everything
  DOWNSTREAM of one whatever its tag (a bank played through a rack effect
  is still the decks — reachability is per NODE, so a rack source that
  meets the bank inside a shared mixer rides out with it), and a page
  that makes its own sound (Clip)
  or none (Library) leaves the engine silent. The graph is NOT torn down
  for this: a hidden page keeps running, so clocks keep time and coming
  back is instant. The gate is a
  per-slot gain in the PLAN, applied only where a wire enters an Audio or
  Monitor Output module's audio jacks (never its `channel_offset`/`mute`
  jacks), and it ramps across one block so a page change fades. It rides
  on every plan (`Engine::plan_for`), so a wire edit cannot reopen a page
  nobody is looking at. It is SESSION state, not patch state: never
  serialized, not an undo step, restored across a patch load, and
  `Rack` (everything sounds) is the default every offline render and test
  gets. Tests: `--test integration audio_focus`,
  `app/tests/AppAudioFocus.test.tsx`.
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
  `ModuleFile.clip` (`BeatClipRef` = store id + clip id + display name),
  because seconds of samples do not belong in a patch. `Engine::
  beat_clip_bind` sets the binding alone; `beat_clip_pending()` lists the
  nodes whose binding has no audio behind it, and the app layer
  (`app/src-tauri/src/beat_clip.rs::hydrate`, called after patch load and
  after `apply_doc`, i.e. undo/redo/paste) loads them via
  `beat_clip::render_clip` — the deck-metadata pattern. A clip that has
  been deleted leaves the module silent and logs; it never fails the
  load. E2E cases instead carry rendered audio in the `events.json`
  sidecar (`beat_clip_load_file`), like deck tracks.
- A CLIP SAYS WHAT IT IS MADE OF. Every surface that offers a clip shows
  which parts of a track it holds, through the one `StemTags` component
  (`app/src/components/StemTags.tsx`, `.stem-tag` in `styles.css`): the
  picker's Clips tab, the Beat Clip panel, and the builder's own list. The
  answer is DERIVED, never authored — `clip_save_beat_clip` folds the
  stems of every source the span actually uses with
  `dj_analysis::stem_union`, which is where the "empty means all four"
  rule is pinned, and files them on `BeatClipMeta.stems`.
  It rides to the rack on `BeatClipEntry.stems` →
  `BeatClipRef.stems` (patch, `#[serde(default)]`, display-only like
  `name`, re-read on `hydrate`). In the UI all four parts are ONE `mix`
  chip rather than four, and an empty list draws nothing at all. A column
  with no room to spell them out asks for `short` (the deck strip does):
  same chips, same test ids, printed VOX/DRM/BAS/OTH (MIX) and held to
  one line.
- The module picker has TWO TABS, not one gallery: Modules (the panel
  gallery, with its category pills) and Clips (`PickerTab` in
  `ModulePicker.tsx`), which lists `beat_clip_list` rather than module
  types; the `builtin.beat_clip` type itself is filtered OUT of the module
  gallery, since an unbound one plays nothing. Which tab was last open
  persists in `localStorage` under `PICKER_TAB_KEY`, so the picker reopens
  where you left it. The Clips tab is a LIST (clip name + where it came
  from + length/tempo), driven entirely from the always-focused search box:
  the first match is selected as you type, ↑/↓ walk the rows (clamped at
  the ends), Enter drops the selected clip on the rack — so cmd+M, type,
  Enter is the whole gesture. BOTH tabs work that way: one cursor
  (`cursor`/`activeIndex` in `ModulePicker.tsx`) serves the clip rows and
  the gallery, which ↑/↓ read as ONE row-major sequence flattened across
  the category headings (`shownModules`) — Enter adds the highlighted
  module type, and the highlight is a `.picker-entry.active` tile plus a
  `scrollIntoView` on the picker body. The cursor is held against the list
  it points into (tab + pill + query, `cursorKey`), so typing, a pill or a
  tab switch re-aims it at the best match BY DERIVATION rather than by an
  effect, and the focus never leaves the search box (pills hand it back).
  The keys the picker consumes stop at its capture-phase window listener,
  like Escape, so nothing reaches the rack behind it. Pinned by the
  "keyboard navigation" cases in `app/tests/ModulePicker.test.tsx`.
  Picking a clip adds the module
  and calls `beat_clip_load` (undoable under `EditKey::Track`, `async`
  because loading decodes audio — decode BEFORE taking the engine
  lock). That command also NAMES the module after the clip ("chorus stack",
  not "beatclip1") via `rename_module`, numbering a name already in the
  rack, and RETURNS the resulting instance id — the frontend re-keys its
  rack positions onto it exactly like a user rename.
- RETIRING a module is manifest DATA too: `"deprecated": true`
  (`Manifest.deprecated`, `skip_serializing_if` false so old manifests and
  goldens keep their bytes). The engine does not care — the type loads and
  instantiates as before, because the patches that use it must keep
  working — the picker does: `taggedModules` in `ModulePicker.tsx` keeps a
  deprecated module out of the default gallery, out of the search AND out
  of its own category pill, and offers it only under the `DEPRECATED_TAG`
  pill at the end of the pill row (which only exists when something in the
  library is deprecated; a category with nothing but retired modules loses
  its pill too). The tag is selected like a category and is mutually
  exclusive with one; entries listed under it carry a `deprecated` chip,
  and the docs panel shows the same word beside the category. One picker
  serves the Rack and Decks tabs, so this is one rule, not two. Pinned by
  the "deprecated modules" cases in `app/tests/ModulePicker.test.tsx`,
  `ModuleDocs.test.tsx` and `manifest.rs`'s unit test. The 6-channel
  Mixer (`com.dj.mixer`, superseded by the mixer family above) is the
  first module shipped this way.
- Copy/paste of a Beat Clip carries the audio, not just the binding:
  `paste_modules` calls `Engine::beat_clip_copy(from, to)` for each
  renamed pair that is a clip module on both ends (the `Arc<TrackData>` is
  shared, so nothing re-renders and a clip whose project is gone still
  copies), then `hydrate` covers the rest — a clipboard pasted into
  another patch, where the source no longer exists.
- Beat detection degrades like the yt-dlp provider: `beat_this` (a
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
  `_DEVICE` (`auto` by default) / `_CHECKPOINTS`, `DJ_BEATS_FORCE_DSP=1`
  pins the fallback for tests. Without it the built-in DSP tracker runs —
  the tested default. Multi-seed agreement (three `beat_this`
  checkpoints) is what fills the `Agreement` verdict; a single tracker
  reports `singleTracker`, never a fake consensus.
- A TAP IS A VOTE, NOT A DATA POINT (§3.8a, `grid::reconcile_taps`). A
  hand keeps time to ±30–50 ms where the models are inside 5–10 ms
  (`IN_BAND_SECS`), so taps must NEVER reach `fit_beats`: twenty of them
  against six hundred detections would only add noise to a line that is
  already better than they are. What the models get wrong is not
  milliseconds but WHICH PULSE — half-time, double-time, the offbeat —
  and that a tapping hand settles at once. So the taps CHOOSE among the
  grids the seeds already produced: every (seed × `TAP_LEVELS` reading)
  candidate is scored by the circular concentration of the taps against
  it, weighted by `level_weight` (Gaussian in octaves, so ×2 and ÷2 are
  punished alike), and the winner is adopted whole. Three refusals come
  before any of that and each says why: fewer than `MIN_TAPS`, taps that
  disagree with THEMSELVES (`TAP_SELF_R_MIN`, measured against a
  `fit_beats` line through the taps — never a median gap and a first tap,
  whose error accumulates over the sequence), and a best score under
  `TAP_MATCH_MIN`; a refusal changes nothing at all. The tap LATENCY is
  measured, reported and DISCARDED — applying it would render the user's
  reaction time into the file, where every clip cut from it inherits the
  lag and nothing downstream can see it. Ties prefer the candidate that
  needed no reading correction (the seed that heard the pulse, not one
  being doubled back), and a no-match reports the ratio of the grid the
  taps actually LAND on, which is what makes "you were tapping bars"
  sayable. Pinned by the tap cases in
  `crates/dj-analysis/tests/beats.rs`.
- Which SEED the grid is fitted to is a choice, not a given: `Analysis`
  keeps every `BeatRun` plus the selected `seed`, `analyze` takes the
  first run (a position in a list, not a merit) and `Analysis::with_seed`
  re-fits to another one — what the Clip page's seed picker calls after a
  tap run. Like the ÷2/×2 readings that is a re-fit of detections already
  in hand and NEVER a second detection pass (MOD-26). Each seed also
  reports its RAW interval statistics (`SeedReading`'s
  `ibi_mean/min/max/variance`): the fitted BPM is a line through the
  detections and hides how they got there, where a doubled beat shows in
  the minimum and a missed one in the maximum without either moving the
  fit.
- The meter law lives in Rust alone (`grid.rs`: `FLAM_GREEN_MS`,
  `STRETCH_GREEN_PCT`, `IN_BAND_SECS`, `LEAD_IN_MAX`, `MIN/MAX_STRIDE`,
  `anchor_stride`) and the Clip page reads it off the payloads rather
  than keeping a twin of it. The pipeline is pinned by `cargo test -p
  dj-analysis --test beats`; the clip renderer's golden case
  (`tests/e2e/clips/*.json` + `tests/e2e/goldens/*.wav`) is what covers
  the warp render end to end. Clip/beat IPC payloads are camelCase on
  both sides.
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
- `AudioTimeline`'s `onStop` is OPTIONAL: pause keeps the playhead and
  Play carries on from it, which leaves Stop as "pause, and also lose
  your place" — a surface that does not want that passes none. The Clip
  page shows its ■, and `ClipTransport.stop(parkAt)` is how it clears the
  desk or hands the speakers over.
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
    shift-extend) + wheel-zoom-around-cursor + transport row, used by the
    Clip page's source track and its selection pane. It
    draws and gestures only — audio stays in the parent's `ClipTransport`
    (or `ClipLivePlayer`), selection/viewport are
    controlled props, and testids/classes are `${idPrefix}-…` so the Clip
    page's `clip-*` DOM contract is unchanged (it also emits the `clip-*`
    layout classes for shared styling; per-prefix CSS overrides colour and
    size). Domain drawings go through `renderUnder`/`renderOver(xOf)` so
    they follow zoom; quantization goes through the `snap` hooks, which
    the Clip page passes once a grid has been tapped (built from
    `quantizeRange`/`nearestBeat` in ClipView) and not before: seeks snap
    to the nearest beat (⌘ frees), selections OUTWARD to whole beats.
    Zoom law is `viewSpan`/`zoomView` (exported).
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
  it. Selections die only by an explicit act: Escape, an edit that
  consumes them, undo/redo, or a new sweep.
- ARMING OR MOVING A LOOP NEVER MOVES PLAYBACK (`ClipTransport.setLoop`).
  The lead-in stays ONE global value (median onset offset + pad,
  `grid::lead_in`), because uniformity is what keeps cuts sync-safe.
- Error surfacing is DOUBLE-CHANNEL: nothing the user can see may be
  invisible to a developer. Frontend (`app/src/errors.ts`): `reportError`
  (banner) logs through `logError` → `console.error('[context]', err)`,
  and consecutive duplicates collapse in BOTH channels so a 10 Hz poll
  can't drown the console. Panels that render their own inline error text
  instead of the banner (LibraryView search/download, ClipView decode and
  save, the camera panel's `[camera]` messages) call
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

## The Decks page at a glance

The engine detail is in the `Conventions` bullets above; this is the map
of the page.

- Where the code is. Frontend: `app/src/decks.ts` (`DecksApi`, the slot
  model and the jack-name helpers `sendJack`/`returnJack`/`toneJack`/
  `CLOCK_JACK`) and `app/src/components/Decks{View,Slot,ClipPicker}.tsx`
  (the live/monitor device pickers sit in this page's top bar, one at
  the end of each master fader row — see the OUTPUT PICKERS bullet).
  Backend: `app/src-tauri/src/decks.rs` over `Engine`'s `decks_*` API.
- Tone knobs have TWO orders: `TONES` (`high, mid, low`) is canonical —
  CV jack indices, `tone_patched` and the Launch Control XL row mapping
  (high on top) all read it — while `TONES_ACROSS` (`low, mid, high`) is
  the DISPLAY order across a strip. Index into `tone_patched` by the
  `TONES` position, never by the rendered cell.
- Layout: the page is CHROME AROUND THE REAL RACK CANVAS. App keeps the
  one `.app-body`/`.rack-area` (panels, store, WireOverlay, pan/zoom,
  marquee, picker, shortcuts) mounted and VISIBLE on this tab —
  `.app-body` is a flex COLUMN and flex `order` places the tempo bar
  above the canvas and the strip row below it, so the canvas element
  never reparents (a reparent remounts every panel). `DecksView` renders
  only the chrome (`.decks-view { display: contents }`); rack keyboard
  scope (`RackKeysContext`, App's shortcut effect) covers `rack` AND
  `decks`. Do NOT rebuild a bespoke mini-rack here — that was f11c2a4
  and it was reverted whole.
- The strip row is a DOCK the user sizes (`.decks-dock`): a grip on its
  top edge drags its height (pointer or arrow keys, clamped between
  `DOCK_MIN_HEIGHT` and 70 % of the app body) and its label collapses it
  to that bar alone. Height and collapsed flag are cosmetic app state in
  localStorage (`dj-decks-dock-height` / `dj-decks-dock-collapsed`), like
  the rack's zoom and pan — never patch state. The dock is `flex: none`
  with an inline height, so every pixel it gives up goes to `.rack-area`.
  Both moves MOVE THE CHROME JACKS, and an inline style on a
  `.decks-chrome` element is exactly what the wire overlay's mutation
  filter ignores by design, so the dock's geometry is folded into the
  chrome overlay's `layoutKey` — that is what re-measures the cables
  frame by frame during a drag. Collapsed, the strips leave the DOM and
  their cables simply stop resolving (the same rule as the bpm/reset
  inputs, which have no socket at all); the top bar's clock jack stays
  wired.
- The chrome IS the bank: on this tab App renders no panel for any
  `DECKS_HIDDEN_TYPES` module (the bank, `builtin.audio_out`,
  `builtin.monitor_out` — the outputs `decks_ensure` wires are IMPLIED
  furniture; they stay in the patch and keep playing, they just draw no
  box), and the strips/top bar carry the bank's real jacks (`data-jack`
  on the bank instance) — send/return at the top of each strip, a CV
  jack under each tone knob (with `is-patched` state from
  `tone_patched`), and in the top bar the clock beside the tempo. The
  OUTPUT PAIRS have NO chrome jacks: where the bank comes out is
  implied, so `audio_l/r` and `mon_l/r` are unreachable from this tab
  and their cables to the hidden outputs resolve at neither end. Jack
  clicks go through App's `onJackClick` (one grammar, one color set).
- The top bar reads left to right as one thought: the tempo is ONE
  control in ONE unit, so the number and its slider stack under a single
  `BPM` label (`.decks-tempo-stack`) with the clock jack — the tempo made
  audible — right beside them; then the beat readout, which dims
  (`data-state='stopped'` on `.decks-beat`) while the bank is parked, so
  a count that is not moving does not read as one that is; then where the
  bank COMES OUT, `.decks-outs`, a row per pair (live over monitor, keyed
  by `data-bus`) carrying just that pair's master fader — no L/R jacks. The
  bar's right-hand end is the TRANSPORT, `Start` and `Stop` beside
  `Follow surface`: two buttons, whichever one is the bank's current
  state lit (Start in the "playing" green), rather than one "restart"
  that assumed the bank was already playing. The
  masters are engine state, not chrome: `decks_set_master` ->
  `Engine::decks_set_master`, drafted while dragged exactly like the
  tempo, and `end_edit` on release closes the undo window
  (`EditKey::DeckMaster`, coalesced per bus).
- A TEMPO CHANGE IS A MOVE, NOT A JUMP: the tick box left of the BPM box
  (ON by default, app-layer UI state — never patch state) makes the
  number a TARGET, and the bank WALKS to it at the rate in the box under
  the tick — the two share one label, `bpm / min`, because the rate is
  what the tick turns on. `DEFAULT_BPM_PER_MIN` = 5 to start, bounded by
  `MIN/MAX_BPM_PER_MIN` (`clampBpmPerMin`: a rate of nothing is a walk
  that never arrives), and the step is `rampBpm` in `decks.ts` — a
  `decks_set_bpm` write every 100 ms down the ordinary path, one
  coalesced undo step (`EditKey::Knob`), closed with `end_edit` when it
  lands. The reading right of the box (`.decks-bpm-actual`) is where the
  bank ACTUALLY is: `decks_status.bpm` and nothing local, so a tempo
  moved from the surface shows up in it too. The target is a draft like
  the faders' — it clears itself once the engine's reading agrees — and
  unticking mid-walk applies the target whole, which is also how the box
  behaved before there was a walk. The engine knows nothing about any of
  this: `bpm` stays a per-sample input jack, so a wired LFO still means
  what it says.
- CHROME-TO-CANVAS CABLES are the tricky part, and they have their own
  layer: chrome jacks sit OUTSIDE the pan/zoom transform, so DecksView
  draws every wire touching the bank with a SECOND WireOverlay in screen
  coordinates over the whole `.app-body` (`overlayContainer`, zoom 1,
  `.decks-chrome-overlay`), re-measured on pan/zoom via
  `overlayLayoutKey` (the rack overlay keeps its no-re-measure pan/zoom
  path), on inner scrolls (capture-phase listener in WireOverlay) and on
  chrome childList changes (attribute churn under `.decks-chrome` — beat
  lamps, pills — is ignored like telemetry). The pending preview moves to
  the chrome overlay on this tab so it is never clipped at the
  `.rack-area` edge; a bank jack with no chrome socket (the `bpm` and
  `reset` inputs, which the bar drives as a number and a slider, and the
  two output pairs, whose destination is implied) resolves nowhere and
  its cable simply is not drawn here.
  Endpoint GEOMETRY is pinned by `app/tests/DecksChromeWires.test.tsx` —
  keep pinning numbers, not just "a wire exists".
- A strip is LIT BY ITS OWN OUTPUT: `DecksSlot` maps `output_level` (the
  engine's decaying 1 s peak, above) through `deckGlow`/
  `DECK_GLOW_FULL` in `decks.ts` to a `--deck-level` custom property on
  the section, and `.decks-slot` mixes that share of `--ok` into its
  background, border and inner glow. The fade is the ENGINE's meter —
  a mute, a drop, a silent beat or a stopped deck all decay to black on
  their own, so the page never decides when the green ends. The tint is
  colour only (the transition dies in the `prefers-reduced-motion`
  block) and the background keeps a small share of `--ok`, because the
  strip's `--ink-dim` text has to stay readable on it.
- THE BEAT LAMPS FILL A FIXED FIELD, so a clip's length never moves the
  controls under it: `.decks-beats` is 128 x 32 px (4:1) whatever the
  loop, and `beatGridLayout` in `decks.ts` decides what goes in it —
  columns are a power of two, the first that keeps the block at least
  4:1 wide (`cols² = 4n`, so only the WIDTH ever binds), and the lamp
  size and the gap fall out of the field's width, capped so short loops
  are drawn generously (8 beats = one row of 9 px lamps, 1024 = 64 x 16
  of 2 px with no gap). The numbers reach CSS as `--beat-*` custom
  properties on the div — decks.ts is the one source for the geometry,
  the stylesheet only spends it. The row is always in the CLIP's OWN
  ORDER (a shift never rotates it — the picture would stop being the
  clip): what a shift moves is the MARKING. Every ONE beat the clip's
  grid knows about is drawn in `--loop` (`.decks-beat-one`) and the one
  the deck is currently lined up by in `--ok` (`.decks-beat-lead-one`,
  the engine's `lead_one`), so a shifted deck says which of its ones the
  bank is now hearing on its downbeat; both sit below `.on`, so the
  playhead still reads over them. Which beats those are is the ENGINE's
  one derivation, `DeckSlotState::grid_ones` (this row and the V2 grids
  only ever read `slot.ones`): it takes the clip's ones through the
  deck's ratio AND folds a one at the clip's END boundary onto its beat
  0 — `BeatGrid::cut_to` keeps the beat that closes the span, so an
  8-beat clip tapped four-to-the-bar stores ones 0, 4 AND 8, and beat 8
  is the next pass's downbeat, never the clip's last beat. Pinned by
  `DecksView.test.tsx` and the engine's `integration decks`
  (`a_one_closing_the_clip_marks_its_first_beat_not_its_last`).
- SFT IS ALSO A TAP: a strip's shift label is a button, and pressing it
  puts that deck's FIRST BEAT on the beat nearest the press
  (`phaseForBeat` in `decks.ts` — the slot's playhead is `beat - phase`,
  so the shift IS the bank beat the press rounds to, wrapped into one
  loop length the way `decks_set_phase` wraps it) — applied down the same
  `onPhase` path as the arrows either side, which stay the beat-at-a-time
  trim. "Now" is NOT the poll's reading: `DecksView` keeps the last
  reading and the moment it landed in a ref and carries it forward at the
  bank's tempo (`beatNow`, handed to the strip), because a status 100 ms
  old is a fifth of a beat at 120 bpm — enough to round onto the wrong
  beat. A stopped bank is parked, so its reading is already now.
- State ownership: `decks_status` is the single poll (the engine owns
  phase, stretch, `insert` and `tone_patched` — never recompute them in
  the page), and the only local state is a DRAFT of the control being
  dragged, which clears itself when the engine's reading agrees. The
  graph (nodes/wires/pending) is App's rack store, handed down as props.
- The tab is its OWN WORKSPACE (see the WORKSPACES bullet): its modules
  are decks-tagged, the Rack tab never shows them (and vice versa), and
  it has its own patch files under `deck_patches/` with its own working
  name in the header — File > Save/Open/New on this tab save, list and
  reset only the decks rack. `decks_ensure` tags the bank it creates,
  App remounts `DecksView` (keyed on `decksEpoch`) after a decks New/Open
  so the chrome re-runs its ensure/rehydrate/wire-to-output pass.
- Sound: the bank keeps RUNNING on other tabs but is held at the output
  modules (audio focus, above); opening the page also makes sure the bank
  is WIRED to an output (`decks_ensure`), so a bank added to a patch with
  no Audio Output is not left cue-only. Graph edits made by the chrome
  (ensure, jack clicks) flow back through `onGraphChange`/App.refresh.
- Tests: `app/tests/DecksView.test.tsx` (strips, lamps, drafts, the
  the rehydrate-on-open, the wiring-on-open, the chrome
  jacks), `DecksChromeWires.test.tsx` (cable endpoint geometry),
  `DecksDock.test.tsx` (collapse/resize, their persistence and the
  cables through both),
  `AppDecksRack.test.tsx` (the canvas on the tab, no bank panel,
  chrome-to-module wiring), `AppWorkspaces.test.tsx` (workspace
  isolation and the per-workspace file ops), plus the engine's
  `cargo test -p dj-engine --release --test integration decks` /
  `integration workspaces` and the `decks-bank-two-clips` /
  `decks-master-mix` / `decks-rack-insert` / `workspace-focus-split`
  E2E goldens.

## The Decks V2 page at a glance

- One `builtin.decks` bank flagged `v2` (`DecksState::v2`, patch state)
  plays TWO ARRANGEMENTS of its slots on one clock: the classic per-slot
  fields are the MONITOR side (editable, on the monitor pair), the
  `live_*` fields (`live_level/live_mute/live_phase`, serde-skipped at
  defaults so classic patches keep their bytes) are what the room hears.
  RT: `process_v2` in `crates/dj-engine/src/decks.rs` -- each side has its
  own `RtSide` reader/ramp; no EQ, inserts or arms on this path; sends
  carry the monitor side. The classic path is untouched (goldens pin it).
- Transitions are TRANSPORT, not edits: `DeckTransition` (jump/crossfade)
  is armed with a serial (`DecksCmd::Transition`), fires on the bank's
  CYCLE SEAM (jump swaps the blend target, crossfade ramps over one whole
  cycle), and the RT thread publishes `transition_fired`; the page's poll
  sees `transition_done` and calls `decks_transition_commit`, which
  copies monitor -> live and rests the blend (inaudible; one undo step,
  `EditKey::DeckCommit`). The blend itself is smoothed by the fader
  one-pole so a jump lands without a click.
- The two tabs SHARE the decks workspace but never a bank:
  `decks_banks`/`decks_ensure` filter v2 banks OUT, `decks_v2_banks`/
  `decks_v2_ensure` filter them in (a fresh V2 bank is created with
  surface off and id stem `decksv2_`). `decks_v2_load` takes a `muted`
  flag: a single add lands audible in the monitor, a whole-song batch
  lands muted everywhere.
- Frontend: `app/src/decksV2.ts` (`DecksV2Client extends DecksClient`,
  rows/LCM/zoom arithmetic, song grouping + FNV hue -- every clip cut
  from one song wears one color, keyed by source `trackHash`) and
  `app/src/components/DecksV2View.tsx` (top bar copied from DecksView --
  deliberately copied, not shared; titles column; two `V2Grid`s zooming
  and scrolling independently, both drawn to `cycle_beats` columns
  (capped at `V2_MAX_COLS`), one playhead path; the 100 px gap holds
  Jump/Crossfade; live side locked behind the `disarm` button; a row
  muted on one side is grayed on that side). App: view `'decks2'`, tab
  label "Decks V2", audio focus/workspace both map like `'decks'`.
- Deliberately absent for now: rack integration (no chrome jacks, no
  canvas under the page), cue/drop, Launch Control, hi/mid/low knobs.
- Tests: `app/tests/DecksV2View.test.tsx`; engine
  `integration decks` (`a_v2_*`, jump/crossfade/commit, patch
  round-trip + classic-bytes pin) and the `decks-v2-jump` E2E golden
  (sidecar grew `live_*` slot fields and `deck_transitions`).

## The Grid page at a glance

- A DAW-style ARRANGEMENT of saved beat clips, played IN THE WEBVIEW —
  not through the engine. It holds no engine state at all: rows point at
  saved clips by id, and `beat_clip_audio` (new command, `beat_clip.rs`)
  hands back a clip's LOOP as WAV bytes (bleed deliberately excluded)
  which `GridTransport` decodes and schedules, the way the Clip page
  auditions a render. Nothing about it touches `DecksState` or a patch.
- One column is one BEAT OF THE GRID. A row is one loaded clip and
  arrives EMPTY; clicking a cell PLACES the clip anchored on its first
  one (`leadOne`), so a 4-beat clip whose one is beat 2, clicked at
  column 10, fills 9..12. A placement's `start` can therefore be
  negative — the anchor is the musical fact, the left edge follows from
  it. Clicking a filled cell removes that copy; a new copy displaces what
  it overlaps (a row is ONE voice).
- Clips expose their downbeats through `BeatClipEntry.ones` (new field,
  from the clip's own cut-to-clip `BeatGrid`, empty for a clip filed
  before the edit was kept — `clip_ones` in `beat_clip.rs`, shared with
  `render_clip`). Cells are `data-kind` `empty|beat|one|lead`.
- MASTER TEMPO is breakpoint automation over beats, drawn with
  `components/AutomationLane.tsx` — the Clip page's level-lane grammar
  generalized (click to add, drag to move, right-click to remove), keyed
  on a point's POSITION not its index because the envelope re-sorts under
  a drag. Beat<->time is therefore an INTEGRAL, not a division:
  `beatToSecs`/`secsToBeat` in `src/grid.ts` use the log-mean closed form
  for a linear ramp, so 120->240 over 4 beats is 60×4×ln2/120 s, not the
  average's 4/3.
- `src/grid.ts` is PURE (rows/grouping/placement/tempo/loop/
  `scheduleRange`); `src/gridTransport.ts` owns the sound. Passes are
  scheduled on a 250 ms lookahead re-run every 100 ms so a loop wraps
  seamlessly, and the playhead is DERIVED from the clock every poll
  (never counted), so a slow frame cannot drift it off the sound. With no
  AudioContext it falls back to `performance.now()` and plays silently —
  which is how the transport is tested headless.
- Rows are GROUPED by source track and the title is drawn ONCE per group
  (`groupRows`); the picker (`GridClipPicker`) lists TRACKS first, each
  clickable directly (takes every clip cut from it, one row each) or
  expandable to its clips.
- App: view `'grid'`, tab label "Grid", audio focus falls through to
  quiet like Clip/Library. The page stays MOUNTED and hides itself so the
  arrangement survives a tab switch, and stops its own playback when
  `active` goes false.
- PITCH IS PRESERVED: a clip is TIME-STRETCHED to the grid's tempo, never
  resampled. `beat_clip_audio` takes an optional `bpm` and runs the
  existing WSOLA stretcher (`crates/dj-analysis/src/beats/warp.rs`
  `render` over a single-segment `WarpMap`); the webview plays the buffer
  at rate 1.0. `ScheduledClip` therefore carries `bpm`, NOT a playback
  `rate` — a rate is what used to transpose every clip up with the tempo.
  Tempos are quantized to whole bpm (`renderBpm`) so a ramp needs a
  bounded number of renders, and buffers are cached keyed `clipId@bpm`.
- A PLACED CLIP IS ONE BLOCK, drawn behind the cells (`.grid-clip`,
  positioned over its span) with its waveform inside it
  (`beat_clip_peaks`, a new command) and its ones marked as hairlines.
  Only the block's two ends are rounded, so a clip reads as one thing.
  The cells above stay the click targets and keep `data-kind`
  (`empty|beat|one|lead`) plus `data-edge` (`start|mid|end|none`).
- Bar lines sit on the LEFT of a bar's first beat, in the ruler and the
  cells alike (`border-left`). On the right they fell between beats 1 and
  2, which drew the first bar a beat short.
- EVERY ROW HAS A LEVEL LINE through its middle: 1 = unity, `MAX_LEVEL` =
  2, and a resting row draws a dimmed flat line and hands the player a
  single unity point. cmd/ctrl+click writes a breakpoint (the gesture is
  on the ROW, not the line — a 1 px line is not a hit target), drag moves
  it, right-click removes it. The first point on a resting row brings a
  unity point at beat 0 with it, so the line BENDS from the middle rather
  than jumping. Levels reach the sound as a `GainNode` ramp per copy
  (`ScheduledClip.levels`). A WRITTEN LINE IS DRAWN LIKE A RESTING ONE —
  the same gray, the same weight, only its handles picked out: in the
  accent it shouted over the clips it belongs to.
- DRAG-SELECT across cells marks ANY n x m rectangle (rows by id in the
  order they are DRAWN — `groups.flatMap`, not `grid.rows` — columns as a
  range); cmd+C copies the placements ANCHORED inside it, measured from
  the selection's left edge, and cmd+V pastes at the PLAYHEAD's beat.
  Paste replaces rather than toggles. Backspace clears the selection's
  copies, Escape drops the selection. Placing stays on `onClick`, which
  fires only when press and release share a cell.
- A DRAG BELONGS TO THE WINDOW, not to the element it started on. Both
  the cell drag and the LOOP drag listen on `window` for move/up: hung
  off the row's `onMouseLeave` a selection died as soon as it crossed
  into the next row, and hung off the 26 px ruler the loop died the
  moment the pointer strayed vertically. Only the LEVEL drag still ends
  at its row's edge — that line is the row's.
- THE RULER: a drag marks the loop, a CLICK (press and release on one
  column) seeks the playhead there and marks nothing — it used to leave a
  one-beat loop behind. `loopDrag.moved` is what tells the two apart, and
  it turns true only once the pointer has reached a different column. A
  press on a loop EDGE is not a drag either: it only chooses the pivot
  (the loop's other end), so a click that happens to land on an edge
  still seeks and leaves the loop alone.
- THE PLAYHEAD IS DRAWN WHILE STOPPED, dimmed (`data-playing="false"` on
  `.grid-playhead` and `.grid-now`). It is not a picture of the sound: it
  is where play will start and where a paste lands, so a marker that
  appeared only once the music ran made a click on the ruler look like it
  had done nothing — which is exactly how it was reported.
- A SEEK IS CLAMPED TO THE CURSOR'S RANGE, not to the loop. Stopped, the
  playhead goes anywhere on the grid (`{0, columns}`): a loop is
  something you mark on the music, not a pen the cursor is kept in, and
  it is the paste anchor as well. PLAYING, it is clamped to `playRange` —
  the transport cues inside the loop whatever it is asked for, so the
  page would otherwise report a beat the sound is not on.
- THE LOOP IS AN EDGE ON THE GRID, a wash only on the ruler. The ruler
  keeps `data-loop` per column; the cells carry `data-loop-edge`
  (`start|end|both|none`) and draw the loop's first column's LEFT border
  and its last column's RIGHT border in `--loop` — the bright purple of
  the ruler's handles. Tinting every looped column buried the clips.
- RIGHT-CLICK ON THE RULER, with a loop marked, is BEAT SURGERY over its
  N columns: insert / copy N beats left or right, delete N beats
  (`insertBeats`/`copyBeats`/`deleteBeats` in `grid.ts`, drawn with the
  app's `ContextMenu`). All three are measured by a placement's ANCHOR,
  and they carry the tempo and level breakpoints and the grid's length
  along with them; a clip straddling the cut keeps its place (its anchor
  is before the cut). An insert whose column IS the loop's end leaves the
  loop over its own beats; a delete that swallows the loop clears it.
- UNDO/REDO (`src/gridHistory.ts`, cmd+Z / cmd+shift+Z / cmd+Y, and the
  file menu) covers the page because there is ONE recorded setter: the
  page holds a `GridHistory` (past/present/future) and every edit goes
  through `setGrid(update, gesture?)`. A GESTURE IS ONE STEP — a drag or
  a field being typed into names itself (`loop`, `tempo`, `level:<row>`,
  `bpm`…) and consecutive edits under that name replace the present
  instead of stacking; the window's mouse-up (and a field's blur) calls
  `endEdit` to close it. New/Open start a fresh history rather than let
  undo walk back into the document that was replaced.
- KEYS (guarded by `isEditableTarget`, and off while a dialog is open):
  space = play/pause, left/right = one beat, cmd+arrow = a bar,
  ctrl+arrow = to the ends, cmd+C/V, cmd+Z / cmd+shift+Z, cmd +/− (zoom),
  Backspace, Escape.
- THE GRID IS LIVE WHILE IT PLAYS. `GridTransport.update` takes a new
  state after every edit: a new placement is spliced into the pass in
  flight and fires on its own beat (copies are remembered per pass by
  `rowId:start`, so nothing re-triggers). A TEMPO or LOOP change cannot
  be spliced — every start time is measured through the envelope from the
  pass's beginning — so it re-cues from the playhead. `#cueing` keeps
  `playing` true across that async re-cue; an explicit `stop()` cancels
  the cue and wins.
- `pause()` keeps the place (`seek()` parks it while stopped); that is
  the only difference from `stop()`.
- SAVE / SAVE AS / OPEN / NEW: `grid_save`/`grid_load`/`grid_list` in
  `beat_clip.rs` file JSON under `<data dir>/grids/<name>.json`, name-
  validated by the patch rule. The document is the frontend's
  (`toDocument`/`fromDocument`, version 1) and NAMES its clips by id
  rather than embedding audio, so a re-cut clip is heard in every grid
  that uses it. `fromDocument` defaults every missing field — an older
  file still opens — and throws only for input that is not a grid at all.
  New/Open warn when there is work to lose; `isEmptyGrid` is what New
  makes, so it needs no warning.
- The picker orders tracks by MEDIAN clip tempo, slowest first: the grid
  runs at one master tempo, so how far a track must be stretched to sit
  on it is the useful sort. Median, not mean — one half-time clip should
  not drag its track's number down.
- ZOOM IS A CSS VARIABLE AND A FRAME. Cell width is published once as
  `--grid-cell-w` on `.grid-lanes` and everything below measures itself
  in beats off it (`beatsWide` -> `calc(var(--grid-cell-w) * n)`), so a
  zoom re-lays the grid out with NO row re-rendering at all — the memo
  holds because `cellW` is no longer a prop. The wheel is CONTINUOUS in
  `deltaY` (a 100-unit notch is the 15 % step the buttons and cmd +/−
  take) and coalesced into one `requestAnimationFrame`, because a step
  per event is what made it feel clicky. Pinned by the zoom cases in
  `GridPerf.test.tsx` (`__pageRenderCount`, `__rowRenderCount`).
- THE SCROLLPORT IS `.grid-body`, the element with the `overflow` —
  `.grid-scroll` inside it is only the column the lanes sit in, and a
  `scrollLeft` read or written there is silently nothing. The zoom holds
  the pointer's beat still by putting that scroll back afterwards
  (`zoomAnchor` -> `scrollLeft = beat * cellW - x`), measured against the
  RULER, whose left edge is beat 0 at any scroll; `x` has the scroll
  taken out of it, or a zoom on a scrolled grid throws the view sideways.
  At the left end the clamp wins and the view simply stays put.
- CHROME BEATS CONTENT, in z-order and in layout: `.grid-body` carries NO
  top padding (a sticky element sticks to the top of the scrollport's
  PADDING box, so the padding was a strip the rows peeked through above
  the ruler), the ruler sits at z-index 5 and the pinned gutter at 6 —
  above the cells (2) and the level lines (3), which come after them in
  the DOM and used to paint straight over the row titles.
- EVERY TRACK HAS AN EFFECTS RACK (`src/gridFx.ts` — pure state;
  `components/GridFxModal.tsx` — the modal; the `fx` button in the row's
  gutter). The rack belongs to THIS row of THIS grid, so it hangs off
  `GridRow.fx` and travels in the document. It is the app's own rack:
  real `ModulePanel`s over the engine's manifests, cables drawn by the
  same `WireOverlay`, and the Rack page's patching grammar (arm an
  output, click an input; shift+click unplugs; a click on a wired input
  picks the cable up — `fxJackClick`). The panels are INERT (the picker's
  `previewHandle`/`previewKnobs`, now exported from `ModulePicker`)
  because the Grid plays its clips in the webview and there is no engine
  graph behind these modules; only VALUES are stored (a knob POSITION
  means nothing without a manifest, and a value put back to the
  manifest's default stores nothing at all), and knob config / CV spread
  are deliberately not persisted. Above the rack, chrome IS the track:
  the grid's clock, the track's audio out and the way back in (L/R, mono
  is just L), and Level / Pan / Wet. LEVEL IS THE BASELINE the row's
  level automation is read against (`levelRamp` multiplies the two, so
  turning it down halves a fade instead of fading to half of what the
  fade wrote); Pan reaches the sound through a `StereoPannerNode` a
  centred row never grows. The DEFAULT rack — EQ on the L path, a scope
  between it and the way back, a clock multiplier at 2x driving an
  unaimed LFO — is what an absent `fx` plays through, so an untouched row
  costs the document nothing; `isTrackFxModified` is a COMPARISON against
  it rather than a flag, which is what lights the row's button `--brand`
  and lets it go gray again when the change is undone.
- Deliberately absent for now: engine routing, per-row mute, and a track
  rack that actually PROCESSES audio — Wetness is stored and the modules
  are drawn, but nothing renders through them yet.
- Tests: `app/tests/Grid.test.ts` (arithmetic, levels, selection/paste,
  beat surgery, the history, the document), `GridFx.test.tsx` (the
  default rack, what counts as modified, patching, the Level and Pan the
  player is handed, the document round trip, the button's colour and the
  modal's chrome), `GridTransport.test.ts`
  (clock, live edits, pause — fake timers), `GridView.test.tsx` (picker
  order, placement, clip blocks, levels, selection across rows, the ruler
  gesture, beat surgery, undo, files, keys, and a CSS-LEVEL PIN over the
  paint jsdom cannot see — the level line's weight, the loop's edges, the
  chrome's z-order — read out of `styles.css` the way
  `AppShellLayout.test.tsx` reads the shell), `GridPerf.test.tsx`
  (renders per edit, per poll and per zoom).

## Manager

- 2026-08-30 — "change AGENTS.md to tell the agents to spend less time
  verifying trivial changes. only run tests that have feasibly changed
  rather than full test suites". Added a rule at the top of "Test
  discipline — be tactical": match verification to the size of the change,
  no test run for trivial edits, only tests that could feasibly have
  changed behaviour.
- 2026-08-30 — "analyze recent conversations. what is taking the agents so
  long? build time? test time? LLM time? too much verification?". Measured
  the event timelines of the most recent worker conversations (tool wall
  time vs. LLM think time, broken down by command type) and reported the
  breakdown in chat; no code changes.
- 2026-08-30 — "remove 'splice on end' and 'overlay' from the clip UI",
  "also remove any leftover/dead logic". Both went end to end: the two
  buttons and `loadTrack`'s modes, the `overlays` program field with
  `ClipOverlay`/`addOverlay`/`removeOverlay`/`apply_overlay` and the
  now-unused `sameSource`, their tests, the `.clip-overlay-span` rule and
  the golden case (regenerated as `clip-cut-splice-eq-level`).
- 2026-08-30 — "worker builds are slow because every ticket pays a cold Rust
  compile": share artifacts across worktrees, install a fast linker, two new
  AGENTS.md rules (only build `app/src-tauri` when you edited it, one profile
  per ticket), garbage-collect old worktree `target/` dirs. Measured both
  sharing options before choosing (see the new section in
  `reports/TIMINGS_REPORT.md`): sccache reused 0.9 % across worktrees and made
  cold builds slower, so the machine-wide build directory won —
  `scripts/use-shared-target.sh`, cold `cargo check -p dj-engine --release`
  1:06 -> 0:05. mold is wired in through `.cargo/config.toml` in a way that is
  a no-op without it, and `scripts/gc-worktree-targets.sh` (cron, every 6 h)
  reclaimed 106 GiB.
