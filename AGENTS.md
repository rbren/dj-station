# Agent notes for dj-station

## Test discipline — be tactical

The full release test suite takes 15+ minutes. Do NOT use it as an iteration
loop.

- While developing, run only the tests affected by your change, scoped
  tightly: `cargo test -p <crate> --release --test <file>` or a single test
  name filter. Never `cargo test --workspace` mid-iteration.
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
  audio case (see `crates/dj-engine/tests/e2e_golden.rs`). Existing goldens
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
