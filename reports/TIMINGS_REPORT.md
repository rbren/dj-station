# Build & Test Timings Report

Measured on `main` (100d43a), 2026-05-21, on headless Linux: 4 cores,
15 GB RAM, rustc/cargo 1.98.0, node v23.8.0, npm 10.9.2. Wall-clock times
from `/usr/bin/time -v` in a fresh git worktree (no `target/`, no
`node_modules`), so "cold" really is from scratch.

**Caveat — shared host.** Other agents were compiling concurrently during
these runs (load average swung between ~3.6 and ~15.5 on 4 cores). Cold
builds got ~90 % CPU, so those numbers are only mildly inflated, but
*test run* times vary run-to-run by ±40 %, and two timing-sensitive tests
flaked under load (see notes below the table). Outliers were re-measured;
where runs disagreed a range is given.

## Timings

| Command | Cache state | Wall time |
|---|---|---|
| `cargo build --workspace --release` | cold | **16:00** |
| `cargo build --workspace --release` | warm (no-op) | 0.6 s |
| `STRESS_SECONDS=10 cargo test --workspace --release` | release build warm, test bins cold | **11:12** ¹ |
| `STRESS_SECONDS=10 cargo test --workspace --release` | warm | 3:37 |
| `cargo test --workspace --release` (default stress 60 s/30 s) | warm | 2:26 – 3:23 ² |
| `cargo test -p dj-engine --release` (all targets) | warm | 3:51 |
| `cargo test -p dj-engine --release --test integration` | warm | 2:02 |
| `cargo test -p dj-engine --release --test e2e_suite` | warm | 0:30 |
| `STRESS_SECONDS=10 cargo test -p dj-engine --release --test rt_safety` | warm | 15 s |
| `STRESS_SECONDS=10 cargo test -p dj-engine --release --test perf_m4` | warm | 13 s |
| `cargo test -p dj-engine --release --test hot_reload` | warm | 5 s ³ |
| `cargo test -p dj-engine --release --test integration bypass` (one filter) | warm | 3 s |
| `cargo test -p dj-analysis --release` | warm, first `-p` run | 1:46 ⁴ |
| `cargo test -p dj-analysis --release` | warm, steady state | 17 s |
| `cargo test -p dj-library --release` | warm, first `-p` run | 38 s ⁴ |
| `cargo test -p dj-library --release` | warm, steady state | 3 s |
| `cargo clippy --workspace --all-targets -- -D warnings` | cold | 1:51 |
| `cargo clippy --workspace --all-targets -- -D warnings` | warm | 0.5 s |
| `cargo fmt --all --check` | — | 0.8 s |
| `cargo build --workspace` (debug) | cold ⁵ | 4:01 |
| `cargo build --workspace` (debug) | warm (no-op) | 0.6 s |
| `cd app && npm ci` | no `node_modules`, warm npm cache | 9 s |
| `npm run lint` | — | 1:04 |
| `npm test` (vitest, 62 files / 1040 tests) | — | 2:45 – 4:37 ⁶ |
| `npm run build` | first run | 45 s |
| `npm run build` | repeat (tsc incremental, assets fetched) | 18 s |
| `npx vitest run tests/KnobMath.test.ts` (one file) | — | 3.6 s |
| `cargo build --manifest-path app/src-tauri/Cargo.toml` | cold (own workspace/target; `app/dist` present) | 4:50 |
| `cargo build --manifest-path app/src-tauri/Cargo.toml` | warm (no-op) | 0.6 s |

¹ Includes linking every dj-engine test binary (each statically links
wasmtime). This first pass also hit the `hot_reload` flake (³) and
exited 101; the timing still covers a full build + run.

² The stress tests render offline faster than realtime, so the default
durations (rt_safety 60 s, perf_m4 30 s) only cost ~20 s wall each; the
suite is dominated by `integration` (~2 min) and host load, hence the
range. One additional run aborted at 0:52 on the `hot_reload` flake.

³ `hot_reload` asserts xruns do not increase across a reload and failed
3 of 6 runs while the host load average was >10 ("xruns increased across
reload: 13 -> 16"); with load ~4 it passes consistently. Same class of
flake once hit dj-library's `import_auto_queues_and_results_land_in_the_db`
(watch-folder timing). Treat single failures of these under heavy load as
suspect and re-run before debugging.

⁴ The first `cargo test -p <crate>` after a `--workspace` build re-links
that crate's test binaries (feature unification differs from the
workspace build); subsequent scoped runs are cheap. Budget the one-time
relink when switching from workspace to scoped runs.

⁵ Measured after cold clippy, which had already populated the dev-profile
build scripts and proc macros; a truly from-scratch debug build would sit
between this and the release number.

⁶ vitest's own Duration for the clean run was 2:39. One run failed
(exit 1) under load >10 and passed 1040/1040 on immediate re-run — same
shared-host caveat.

## What this means for the loop

The AGENTS.md test discipline is confirmed by these numbers, not
contradicted. **Iteration-loop-safe** (seconds, run freely): warm no-op
builds, `cargo fmt --all --check`, warm workspace clippy, a single
engine test target (`--test hot_reload` 5 s, `--test e2e_suite` 30 s,
stress targets with `STRESS_SECONDS=10` ~15 s) and especially a single
test-name filter (~3 s), steady-state scoped crate tests
(dj-library 3 s, dj-analysis 17 s), and one vitest file (~4 s).
**Mid-weight** (minutes — end of a work session, not every edit):
`--test integration` (2 min), `cargo test -p dj-engine --release`
(4 min), the full vitest suite (~3 min), `npm run lint` (1 min),
`npm run build` (18–45 s). **Expensive, end-of-milestone only**: anything
cold — the 16-minute cold release build, the 11-minute first
`cargo test --workspace --release` (test-binary links), cold clippy
(2 min), the cold debug and Tauri builds (4–5 min each). The full
CI-equivalent pass from AGENTS.md, run once at the end on a warm cache,
totals roughly 8–10 minutes; from a cold checkout budget ~45 minutes.
Keep the release `target/` warm by never alternating profiles
mid-iteration — the debug and release trees are disjoint and each costs
minutes to refill.
