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
