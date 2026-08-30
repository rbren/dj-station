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

## Sharing the build cache between worktrees (2026-08-30)

Every worker runs in its own `/tmp/conversation-worktrees/<id>/dj-station`
with an empty `target/`, so the numbers above were being paid again on every
ticket (79 % of all tool time across 17 conversations was cargo). Two ways to
stop that were measured on the same box; the winner is wired up by
`scripts/use-shared-target.sh` and described in AGENTS.md.

| Command (fresh worktree, nothing built) | Build dir | Wall time |
|---|---|---|
| `cargo check -p dj-engine --release` | private, empty | **1:00.9** idle host / 1:06, 1:25 under load |
| `cargo check -p dj-engine --release` | shared cache | **0:05.5**, 0:04.8 |
| `cargo build --workspace --release` | private, empty | 16:00 (table above) |
| `cargo build --workspace --release` | shared cache | **0:34** |
| `cargo build --workspace --release` | shared cache, every crate invalidated | 3:14 |

Only the workspace crates are recompiled in the shared case — the ~370
dependencies do not depend on the worktree path, so they are reused verbatim.
Two identical worktrees can even skip that (0:00.2 when the crate content
matched what another worktree had just built).

**Why not sccache** (the first choice, being lock-free): its cache keys pick up
the worktree path, so across worktrees it reuses almost nothing here.
Populating from one fresh worktree and then building another gave **2 cache
hits out of 222 compilations (0.9 %)** — with both the distro 0.7.7 and
upstream 0.10.0 — while the cache-write overhead made the cold check *slower*:
1:22–1:31 populating, against 1:00.9 without it. Only leaf crates hit: as soon
as a compilation has `--extern` inputs from the local target dir it keys
differently, and 28 of the 132 dependency artifacts (the cranelift/wasmtime
family) are not even bitwise reproducible between two worktrees.

**The shared directory's cost is cargo's exclusive lock.** Measured: two
concurrent builds serialize (seconds each, since only the workspace crates
rebuild), but test *execution* does not — cargo drops the build lock before
running test binaries, so a 20 s test run did not delay another worktree's
`cargo check` at all. The other cost is that workspace-crate artifacts are
keyed by crate name, not by worktree, so a concurrent worker's build replaces
yours and your next build redoes it — seconds, against the minutes saved.

**A fast linker turned out to be already installed.** rustc drives its own
bundled LLD on x86_64-unknown-linux-gnu — `readelf -p .comment` on
`target/release/dj-cli` prints `Linker: LLD 22.1.8` — and it selects that
linker itself, so a `-fuse-ld`/`-B` preference from cargo config is only
consulted on targets where it does not. Relinking dj-cli (which statically
links wasmtime) took **1.25 s and 1.27 s with the default against 1.14 s and
1.35 s forced onto mold**, measured with `cargo rustc -p dj-cli --release --
-Clink-arg=-fuse-ld=mold` so that only the final crate's flags changed. mold
is installed and `.cargo/config.toml` hands it to cc as a `-B` prefix (a no-op
where the directory or mold is missing), but nothing here justifies forcing it
machine-wide: rustflags are part of cargo's fingerprint, so that would
invalidate every warm `target/` on the box for no measurable gain. Earlier
whole-workspace rebuild comparisons (3:47 vs 2:45, 3:02 vs 2:31) look like a
mold win but are just host load — each of those runs recompiled ~370 crates
while other workers were building.

**Disk.** 60 worktrees held 133 GB of `target/` when this landed (one was
15 GB, the disk was at 74 %). `scripts/gc-worktree-targets.sh` reclaimed
106 GiB of it and now runs from cron every 6 h; worktrees linked at the shared
cache add nothing to that in the first place.
