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
  instance ids, so `/` is reserved in user instance ids and UI snapshots
  filter internals via `Engine::snapshot`.
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
- Params vs. inputs (post-M5 refactor): ALL WASM-module controls
  (oscillator `waveform`, ADSR `attack/decay/sustain/release`, playback
  `loop`) are ordinary knob-backed input jacks — wireable, per-patch
  knob config, set via `set_knob_value`/`set_knob_position`, never
  `set_param`. `params` are reserved for mode-style toggles on builtins
  (deck `keylock`/`reverse`/`slip`/`stem_*`); macro promoted params must
  target those. After any manifest/knob change, run
  `./scripts/regen-goldens.sh` and the full workspace suite (macro and
  perf_m4 tests reference module controls).
- App save/load lives in the native File menu (Tauri `MenuItemBuilder`
  in `app/src-tauri/src/main.rs`); the frontend listens via
  `onMenuAction` in `src/engine.ts` (menu events re-dispatched as
  `dj-menu` CustomEvents — tests drive the dialogs by firing those).
  Any test that mocks `../src/engine` must also export `onMenuAction`
  (stub: `() => () => {}`).
- `rt_safety.rs`'s realtime stress can flake when run in parallel with
  the rest of the workspace on a loaded 4-core host (proc-deadline
  assert); it passes standalone — rerun
  `cargo test -p dj-engine --release --test rt_safety` before assuming a
  regression.
- Frontend rack state lives in `app/src/rackStore.ts` (hand-rolled
  external store read via `useSyncExternalStore`, no zustand), provided
  through `RackStoreContext`; each `RackModule` subscribes to its own
  node/position/selection/telemetry slice. Telemetry polls one batched
  `tap_all` IPC command (read-only, mirrors `engine_nodes` keys —
  macro internals hidden, MIDI LED / macro external jacks by name) every
  100 ms — never per-jack `tap` in a loop. App-level tests that mock
  `../src/engine` need `tapAll: vi.fn(async () => ({}))` next to `tap`.
  `app/tests/KnobMath.test.ts` pins the TS knob curve math to
  `knob.rs`; if either side's mapping changes, update both plus that
  table.
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
