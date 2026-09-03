# Agent notes for dj-station

## Test discipline — be tactical

The full release test suite is a few minutes warm (it was 20+ before the
test targets were consolidated — see below; keep it that way). Do NOT use it
as an iteration loop. Measured wall-clock times for every build/test
command (cold and warm) are in `reports/TIMINGS_REPORT.md`.

- MATCH THE VERIFICATION TO THE SIZE OF THE CHANGE. A trivial change (a
  label or copy tweak, a style/token swap, a comment or doc edit, a
  constant nudge, a rename) does NOT earn a test run: check it compiles /
  typechecks, run at most the one test file that covers the thing you
  touched, and finish. Only reach for tests that could FEASIBLY have
  changed behaviour — if you cannot name the test that would catch a
  regression from your edit, don't run tests at all.
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
- ONE CARGO PROFILE PER TICKET, and it is `--release`. The debug and release
  trees are disjoint: a ticket that mixes `cargo check` (debug) with
  `cargo test --release` builds every dependency TWICE from scratch in a fresh
  worktree. Measured across 17 worker conversations: 77 `--release` invocations
  against 30 debug ones, i.e. most tickets paid for a second full artifact set
  they never used. Put `--release` on every cargo command you run — check,
  clippy, build, test — and if you catch yourself having run a debug one,
  switch back and stay there rather than alternating.
- ONLY BUILD `app/src-tauri` WHEN YOU EDITED IT. It is a separate workspace
  with its own dependency set (Tauri, webkit), so its first build in a fresh
  worktree is cold no matter what the engine workspace has already compiled:
  22 such runs cost 78 min = 40 % of all tool time in the same sample, the
  worst single cold `cargo check --release` there taking 50 minutes. Frontend
  (`app/src/**`) or engine-crate work does NOT need it — the shell only
  re-checks if you touched `app/src-tauri/**`. When you did touch it, `cargo
  check --manifest-path app/src-tauri/Cargo.toml` is enough; leave the full
  build to CI, which builds `app/dist` first for `generate_context!`.
- Run `cargo fmt` and scoped clippy (`cargo clippy -p <crate> --all-targets`)
  as you go; save workspace-wide clippy for the end.
- CI's toolchain is UNPINNED latest stable (`dtolnay/rust-toolchain@stable`),
  so a Rust release can break the lint job with brand-new clippy lints while
  an older local toolchain still passes. If lint fails in CI but not locally,
  `rustup update stable` first and reproduce on the same version CI uses.
- Frontend: run a single test file during iteration
  (`npx vitest run tests/<File>.test.tsx`), not the whole vitest suite.
- Frontend flakiness is usually CPU STARVATION, not a bug. This box has 4
  cores and several suites (ClipView above all) drive REAL timers and wait
  on them through `waitFor`; when every core is busy the poll never gets a
  timeslice and the test dies on its timeout, a different one each run. Two
  things hold it: `app/tests/setup.ts` raises `asyncUtilTimeout` to 5s, and
  `npm test` runs the heavy perf suites AFTER the others rather than
  beside them (`vitest run` on its own still includes them). Before blaming
  a flake on your change, check whether it fails when run alone.
- PERF SUITES. `npm run test:perf` (Rack/Grid/Clip UI rendering) and
  `cargo test -p dj-engine --release --test perf_m4 perf_ui` (the same
  three surfaces' audio rendering) are the perf gate; `DJ_PERF_HEAVY=1`
  runs both on the CI perf job's much bigger fixtures. Prefer a COUNT to
  a stopwatch: the frontend stages in `app/src/perf.ts` (`timedOver()`,
  also what the stress HUD shows) report how much material they touched
  as well as how long they took, and `expectStageFlat` /
  `expectStageLinear` assert on the count — exact on any machine, no
  headroom needed. Where a wall clock is unavoidable it is
  calibration-scaled with several times the measured cost in headroom —
  never tighten one to just above the current measurement. Baselines, the
  stage names and how to move a threshold: `reports/PERF_BASELINES.md`.
- LEAN ON CI. Do NOT run a full workspace/CI-equivalent sweep to be sure —
  CI runs it on every push and is there to catch what you missed. Before
  pushing, run only the scoped checks for what you touched (the crate's or
  file's tests, `cargo fmt`, scoped clippy). Once those pass and you are
  reasonably confident the tree builds, finish and push to main; let CI
  report anything else. A full `cargo test --workspace --release` /
  workspace clippy / `npm test` sweep is justified only for a change that
  is genuinely workspace-wide (a cross-crate refactor, a toolchain or
  dependency bump), not for ordinary feature work.

## Context discipline — reading is what costs, not building

Measured over the last 20 worker conversations ($210, 1,692 LLM calls, 239 M
prompt tokens — `reports/AGENT_SPEND_REPORT.md`): test/build output is 1.8 % of
spend, file reads and greps are 39 %. Every token you put in context is re-read
by every later call, so 1,000 tokens dropped early into a 300-call ticket costs
~$0.26; cost is roughly quadratic in how many calls a ticket takes.

- NEVER `cat` a whole file over ~200 lines. `grep -n` for the symbol, then
  `sed -n 'START,ENDp'` a window around it (or `file_editor view` with an
  explicit `view_range`). The files you will reach for are the big ones —
  `styles.css` 6.4k lines, `decks.rs` 3.1k, `ClipView.tsx` 2.3k.
- READ A FILE ONCE. 60 % of all file-read tokens in that sample were re-reads of
  a file already read in the same conversation (one ticket opened
  `ClipView.test.tsx` 64 times). If you must look again, re-read the range, not
  the file.
- CAP EVERY COMMAND'S OUTPUT: `| head -40` on greps, `--stat` before
  `git diff`, `| grep -E "Tests |Test Files"` on vitest, a `python3 -c` filter
  instead of dumping JSON (`vibectl.py snapshot` raw is 9k tokens). Scope greps
  (`grep -rn foo app/src --include='*.tsx'`), never the whole repo. If output
  hit the 30k-char clip, the command was wrong.
- FEWER, BIGGER STEPS. ~20k tokens of system prompt and tool schemas ride on
  every call (25 % of all spend), and an over-large context eventually triggers
  condensation, which re-writes the whole prompt cache — 1.2 % of calls did that
  and cost 7 % of the money. Batch shell commands into one action, and take a
  genuinely new ask in a fresh conversation rather than as the tenth follow-up
  on a 500-call session.

## Build cache — share the artifacts, don't recompile them

FIRST COMMAND IN A FRESH WORKTREE: `scripts/use-shared-target.sh`. It points
the three `target/` dirs (workspace, `app/src-tauri`, `extensions`) at the
machine-wide build directory `/var/cache/dj-cargo-target`, where the ~370
dependencies are already compiled. Measured in a fresh worktree on this box,
cold `cargo check -p dj-engine --release`: **1:06 with a private empty
`target/`, 0:05 linked at the shared one**; cold `cargo build --workspace
--release`: **16:00 -> 0:34**. Dependency artifacts do not depend on the
worktree path, which is what makes this work at all.

- They are symlinks, not `CARGO_TARGET_DIR`, so the hardcoded `./target/…`
  paths in `run.sh`, the extension scripts and the CI recipe keep working.
- Cargo takes an exclusive lock on a build directory, so two concurrent BUILDS
  serialize (measured: seconds each, since only the workspace crates rebuild —
  the deps are already there). Test EXECUTION does not serialize: cargo drops
  the lock before it runs the binaries.
- What is shared is also shared with the other five workers: workspace-crate
  artifacts are keyed by crate name, not by worktree, so a concurrent build can
  replace yours and your next build redoes it (seconds). `./target/release/…`
  binaries are whoever built last — rebuild right before you run one, or drop
  the symlink for that experiment (`rm target && mkdir target`).
- sccache was measured here and NOT adopted: keyed per compilation, it reuses
  almost nothing across worktrees for this dependency graph (2 hits out of 222
  compilations in a fresh worktree, ~1 %, because cache keys pick up the
  worktree path) while adding 35–50 % to a cold build. Don't set
  `RUSTC_WRAPPER` expecting it to help.
- Linking is NOT the bottleneck on this toolchain: rustc already uses its
  bundled LLD on x86_64-linux, and relinking dj-cli (wasmtime and all) costs
  ~1.3 s with it or with mold. `.cargo/config.toml` offers mold a `-B` prefix
  for the targets where rustc does not pick the linker itself, and is a no-op
  on a machine without mold. `scripts/setup-build-cache.sh` provisions a box:
  mold, the shared build directory and the GC cron.
- Old worktrees are garbage collected: `scripts/gc-worktree-targets.sh` (cron,
  every 6 h) deletes `target/` trees nobody has touched for 12 h and skips any
  worktree with a live process in it. Run it with `--apply` if the disk is
  tight; it only ever removes build output.

## Build ordering

CI builds the frontend (`app/dist`) BEFORE the Tauri shell —
`tauri::generate_context!` embeds `app/dist` at compile time and the build
fails if it's missing.

## Conventions — the explicit rules

These are the rules that must hold everywhere.

- Frontend styling goes through the design tokens in
  `app/src/styles/base.css` (`--fs-*`, `--canvas/--surface*/--line*`, inks,
  `--brand/--cue/--ok/--fault`, `--shadow-*`, `--dur-*`). Do not add a fresh
  hex literal or font-size when a token fits. Motion is colour/opacity only
  and must survive the `prefers-reduced-motion` block. `DESIGN_OVERHAUL.md`
  tracks the remaining design work — update it there, not in code comments.
  `styles.css` is only an `@import` index over `src/styles/` (one file per
  page/feature, cascade order = import order); tests that pin CSS rules
  read it through `app/tests/readStyles.ts`'s `appCss()`.
- Never delete a CSS rule because a literal grep for its class name finds no
  use. Class names are built from template literals (e.g. ModulePanel's
  `input-group-${group.kind}`, `input-cell-hfader`); grep the fragments
  before calling a selector orphaned.
- House frontend helpers — reuse, don't re-roll: `src/search.ts
  matchesQuery` for every search-box filter, `src/usePoll.ts usePoll` for
  panel status polling, `src/format.ts fixed` for number display.
- Audio decoding has ONE implementation: `dj_analysis::decode_audio`
  (symphonia). `dj-engine`'s `playback::decode_file` re-shapes its output;
  never add a second symphonia pipeline.
- Tauri IPC commands live in per-domain files under `app/src-tauri/src/`
  (`library.rs`, `deck.rs`, `decks.rs`, `choreo.rs`, `macros.rs`,
  `clip.rs`, `beat_clip.rs`, `launch_control.rs`); `main.rs` keeps only
  the shell: AppState, undo/patch plumbing, rack graph edits, audio
  device commands. New commands go in the matching domain file.
- ALL persistent state roots in ONE directory resolved by
  `dj_library::paths` (`custom/` in the repo checkout, overridable with
  `DJ_STATION_DATA_DIR`). New state goes UNDER that dir — never a fresh
  platform-dir lookup.
- RT (audio) thread: zero allocations, zero locks, no panics. Heavy work
  happens off the RT thread with lock-free handoff — the house pattern is an
  immutable program shipped over an SPSC ring with a garbage ring for the
  off-RT drop (`playback.rs`, `choreo.rs`, `math.rs`). Panel readouts come
  from `Shared` atomics the RT module publishes once per block, never from
  control-thread guesswork.
- Patches are directory trees of small JSON files and are SELF-CONTAINED;
  new state must round-trip through save/load. New serde fields take
  `#[serde(default)]` / `skip_serializing_if` so old patches and goldens
  keep their bytes.
- Every new module/engine feature ships with a serialized-patch E2E golden
  audio case (`crates/dj-engine/tests/e2e_suite/`). Existing goldens stay
  byte-identical unless intentionally regenerated and documented.
- A beat clip EDITED is filed under the id it already had, so an id alone
  cannot key a decode of it: `beat_clip_list` reports a `rev` per clip
  (`dj_analysis::clip::beat_clip_rev`) and a surface holding clip audio
  (the Grid page: `GridTransport.forget`) drops what it holds when that
  moves. The Grid re-reads the store every time it becomes the open tab —
  clips are made on another page.
- A track is not clip-editable until BOTH analysis and stem separation are
  done: the Library keeps reporting "analyzing" and blocks its Clip/edit
  entry point while a stem job for that track is still in flight.
- DJ metadata (hot cues, saved loops, beatgrids, stems) is canonical in the
  library DB / analysis cache, NOT the patch: patches persist only the
  track path and per-module params, and the app layer re-applies metadata
  on load.
- Bypass is manifest data, not per-module code: every audio-in → audio-out
  module declares a `"bypass"` route map in its manifest.
- Undo: engine edits coalesce under an `EditKey` and close with `end_edit`,
  so a burst of dragging or typing is ONE undo step.
- Typing vs installing: live text edits keep the last good program playing
  and report the error; installing saved state (patch load, undo/redo)
  installs silence rather than computing something nobody wrote. A patch
  with broken content LOADS with a `load_warnings` entry — never fails.
- Cosmetic UI state (dock heights, zoom/pan, collapsed flags, camera
  enablement) is app-layer state (localStorage or ephemeral) — never patch
  state.
- Deleting a library track is ownership-based: the audio file is removed
  only when it lives under the data dir, and the path is tombstoned so the
  watch folder doesn't hand it straight back. References pointing at the
  track degrade on their own.
- Provider smoke tests gate on env keys and treat empty-string env vars as
  unset (CI injects unconfigured secrets as `""`). Optional heavy tooling
  (ONNX models, the demucs and SCNet stem models) is skip-not-fail: CI
  never depends on model files — stem tests run against fake CLI scripts —
  and missing tooling is a reported state, never a panic.
- Native (dylib) modules are UNSANDBOXED trusted code in their own cargo
  workspace under `extensions/`; CI lints them separately.
- Macros: global base definitions live in the macro store; every instance
  owns a private copy saved in the patch, so a base edit can never change a
  saved patch's sound. Macros do not nest; `/` is reserved in instance ids.

## Glossary — high-level concepts and terms of art

- **Rack**: the modular canvas — module panels wired jack-to-jack. Pages
  that look like separate apps (Decks) are chrome around the same mounted
  rack canvas, never a second one.
- **Patch**: a saved rack (directory of small JSON files), self-contained.
- **RT / control thread**: the real-time audio callback vs everything
  else; commands flow control→RT, readouts come back via shared atomics.
- **Beat grid**: a track's analyzed beat positions; its **ones** are the
  downbeats. **Lead one**: the first one, the anchor clips align by.
- **Beat clip**: a whole-beat loop cut from a track on the **Clip page**
  and saved to the library, carrying its own cut-to-clip beat grid and
  rendered audio; it never overwrites its source track.
- **Bleed**: the audio bookends either side of a beat clip's loop,
  overlaid on the pass a clip comes in on or drops out of. A clip is
  filed as ONE capture — lead-in, loop, tail-out in one FLAC — and the
  record's `loopSpan` marks where the loop is inside it; the bleed is
  never mixed INTO the loop, and every reader takes the pieces apart
  through `load_beat_clip`. Clips written before that (no `loopSpan`,
  bleed in `<id>-bleed-{l,r}.flac` sidecars) still read, and are folded
  into one file the next time they are saved.
- **Stems**: separated sources (vocals/drums/…) cached as FLAC under
  `<data_dir>/stems/<hash>/`, keyed by separator id — the DSP fallback
  flat, every model in its own subdirectory (`htdemucs_ft`, the fast
  default, and `scnet_xl_ihf`, the better one). That directory name IS the
  per-track record of which model made them, and stems any other model
  wrote are served rather than redone. A track can be told to use a
  particular model (a `chosen-model` file beside its stems, set from the
  Library's Stems column); from then on only that model's stems count for
  it, so it separates again — but nothing is ever deleted, and switching
  back is instant. Patches persist only the stem gains.
- **Deck / bank**: `builtin.decks` — eight beat clips (decks/slots) on ONE
  clock and one shared beat position; clips are stretched to the bank
  tempo, never pitched. The Decks page is its chrome.
- **Monitor vs live**: the two output pairs — monitor is the headphone/cue
  side, live is what the room hears. A fresh clip arrives cued (audible on
  monitor, not live).
- **Cycle / seam**: the bank's whole loop (`cycle_beats` = lcm of loaded
  loop lengths); the seam is where it wraps.
- **Grid page**: a DAW-style arrangement of saved beat clips played in the
  webview, not the engine; one column is one beat, with master-tempo
  breakpoint automation.
- **Track rack**: the per-track effects rack opened from a Grid row —
  its own rack scoped to that track in that grid, with chrome jacks for
  clock/audio in-out plus Level, Pan and Wetness. The rack is rendered
  offline by the engine (`dj-engine/src/track_fx.rs`) and the Grid player
  crossfades that wet buffer against the dry clip by Wetness; bleed
  bookends ride the dry side.
- **Golden**: a checked-in E2E audio render (`tests/e2e_suite/`) pinned
  byte-for-byte.
- **Macro**: a saved, non-nesting subgraph — global base definition plus a
  private per-instance copy in each patch.
- **Chrome jacks**: real engine jacks rendered on a page's chrome (Decks
  strips/top bar) instead of a module panel.
- **Choreo**: `builtin.choreo`, a beat-indexed multi-track timeline module.
