// The timing side of the performance suites (Rack / Grid / Clip).
//
// WHY TIMING AT ALL. The render-count assertions next door (GridPerf's
// memoisation contract, RenderCounts' telemetry contract) are exact and
// box-independent, and they stay the primary tool: a count says what the
// code does. But a count cannot see an O(n²) layout pass inside ONE
// render, and that is the failure these suites exist to catch — the page
// that still renders once, and takes 900 ms doing it.
//
// HOW A WALL CLOCK IS MADE USABLE ON A NOISY 4-CORE BOX:
//
//  1. CALIBRATION. Every budget is scaled by how fast THIS machine ran a
//     fixed pure-JS workload, so a slow or loaded runner gets a
//     proportionally larger budget instead of a red build. The reference
//     number is what the workload cost on the development box; see
//     `reports/PERF_BASELINES.md` for how to re-measure it.
//  2. MEDIANS, NOT MEANS. One descheduled run cannot fail a budget; the
//     median of N runs has to move.
//  3. GENEROUS BUDGETS. Budgets sit ~4–6× over the measured cost, so they
//     catch "this got ten times slower", not "this got 20% slower". A
//     tight budget on shared CI is a coin flip, and a flaky gate gets
//     disabled, which is worse than no gate.
//  4. SCALING ASSERTIONS. `expectSubQuadratic` compares the same code
//     path at two fixture sizes, which normalises the box out entirely —
//     it is the assertion that actually catches an accidental n² and the
//     one to prefer when a budget feels arbitrary.
//
// Every measurement is printed as one `[perf]` line, and appended as JSON
// to `$DJ_PERF_REPORT` when that is set (CI uploads it as an artifact).

import { appendFileSync } from 'node:fs';
import { expect } from 'vitest';
import {
  formatPerfPhases,
  perfPhases,
  resetPerfPhases,
  setPerfEnabled,
  type PerfPhase,
} from '../src/perf';

/** Fixtures are sized for a normal run by default; the CI performance job
 *  sets `DJ_PERF_HEAVY=1` for the big ones (a hundred-module rack, a
 *  1024-beat arrangement, a ten-minute track). */
export const HEAVY = process.env.DJ_PERF_HEAVY === '1';

/** Pick the fixture size for this run. */
export function heavy<T>(normal: T, big: T): T {
  return HEAVY ? big : normal;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/** What `calibrationWorkload()` costs on the development box (4-core
 *  container, node 22), median of five. Re-measure with
 *  `npx vitest run tests/RackPerf.test.tsx` and read the `[perf] calibration`
 *  line — see reports/PERF_BASELINES.md. */
const CALIBRATION_REFERENCE_MS = 12;

/** A fixed, allocation-heavy, branchy workload: array building, sorting
 *  and string joins, i.e. the same kind of work a React render does. */
function calibrationWorkload(): number {
  let acc = 0;
  const values = new Array<number>(20_000);
  for (let i = 0; i < values.length; i += 1) values[i] = Math.sin(i) * 1000;
  values.sort((a, b) => a - b);
  for (let i = 0; i < values.length; i += 1) acc += values[i] * (i % 7);
  const parts: string[] = [];
  for (let i = 0; i < 5_000; i += 1) parts.push(`${i},${values[i].toFixed(2)}`);
  return acc + parts.join(' ').length;
}

let factor: number | null = null;

/** How much slower than the development box this machine is, never below
 *  1 (a faster box does not get tighter budgets — that would make the
 *  gate stricter exactly where it was never calibrated). */
export function slowdownFactor(): number {
  if (factor !== null) return factor;
  const runs: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    calibrationWorkload();
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  const cost = median(runs);
  factor = Math.max(1, cost / CALIBRATION_REFERENCE_MS);
  console.log(
    `[perf] calibration ${cost.toFixed(1)}ms (reference ${CALIBRATION_REFERENCE_MS}ms) ` +
      `→ budgets ×${factor.toFixed(2)}${HEAVY ? '  [heavy fixtures]' : ''}`,
  );
  return factor;
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

export interface BenchStats {
  name: string;
  runs: number;
  median: number;
  min: number;
  max: number;
  /** Instrumented phases (src/perf.ts) accumulated over the whole bench,
   *  dearest first — where the milliseconds went. */
  phases: string;
  /** The same phases, per run, for assertions about ONE stage. */
  phaseTotals: Record<string, PerfPhase>;
}

/** One instrumented stage's totals over the bench.
 *
 *  Throws when the stage never ran: a missing stage otherwise reports
 *  zero and sails through every assertion made about it, and the failure
 *  mode of an instrumented suite is a renamed label, not a slow one. */
function stagePhase(stats: BenchStats, label: string): PerfPhase {
  const p = stats.phaseTotals[label];
  if (!p || p.calls === 0) {
    throw new Error(
      `perf stage "${label}" never ran during "${stats.name}" — ` +
        `saw ${Object.keys(stats.phaseTotals).join(', ') || 'no stages at all'}`,
    );
  }
  return p;
}

/** Median of an ASCENDING list; the mean of the middle two when even, so
 *  a two-run bench is not reported as its slower run. */
function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface BenchOptions {
  runs?: number;
  /** Untimed preparation before each run (mounting the fixture). */
  setup?: () => unknown;
  /** Untimed cleanup after each run (unmounting it). */
  teardown?: () => unknown;
}

/** Run `fn` `runs` times and report the median. Phase instrumentation is
 *  on for the duration, so the report says where the time went. */
export async function bench(
  name: string,
  fn: () => unknown,
  opts: BenchOptions = {},
): Promise<BenchStats> {
  const runs = opts.runs ?? 3;
  const times: number[] = [];
  setPerfEnabled(true);
  resetPerfPhases();
  for (let i = 0; i < runs; i += 1) {
    await opts.setup?.();
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
    await opts.teardown?.();
  }
  const phases = formatPerfPhases();
  const phaseTotals = perfPhases();
  setPerfEnabled(false);
  const sorted = [...times].sort((a, b) => a - b);
  const stats: BenchStats = {
    name,
    runs,
    median: median(sorted),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    phases,
    phaseTotals,
  };
  report(stats);
  return stats;
}

function report(stats: BenchStats): void {
  console.log(
    `[perf] ${stats.name}: median ${stats.median.toFixed(1)}ms ` +
      `(min ${stats.min.toFixed(1)}, max ${stats.max.toFixed(1)}, n=${stats.runs})` +
      (stats.phases ? `\n${stats.phases.replace(/^/gm, '         ')}` : ''),
  );
  const path = process.env.DJ_PERF_REPORT;
  if (!path) return;
  appendFileSync(path, `${JSON.stringify({ ...stats, heavy: HEAVY, factor: slowdownFactor() })}\n`);
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/** Fail if the median run blew the (calibration-scaled) budget. This is
 *  the CI gate: budgets carry several times the measured cost, so what
 *  trips it is a severe regression, not noise. */
export function expectWithinBudget(stats: BenchStats, budgetMs: number): void {
  const budget = budgetMs * slowdownFactor();
  if (stats.median > budget) {
    throw new Error(
      `PERF REGRESSION — ${stats.name}: median ${stats.median.toFixed(1)}ms ` +
        `over the ${budget.toFixed(0)}ms budget (${budgetMs}ms × ${slowdownFactor().toFixed(2)} ` +
        `calibration).\nIf this is a deliberate, understood cost, update the budget and the ` +
        `numbers in reports/PERF_BASELINES.md.` +
        (stats.phases ? `\nPhases:\n${stats.phases}` : ''),
    );
  }
  expect(stats.median).toBeLessThanOrEqual(budget);
}

/** How much MATERIAL a stage touched per call — buckets read, sockets
 *  looked up (see `items` in src/perf.ts).
 *
 *  This is the number to assert on wherever a stage exists. It is exact
 *  and identical on every machine, so it needs no calibration, no
 *  headroom and no re-baselining, and it catches the regressions that
 *  matter (a pass that becomes two, a lookup that becomes a scan) at the
 *  size the test happens to run rather than only under load. */
export function phaseItemsPerCall(stats: BenchStats, label: string): number {
  const p = stagePhase(stats, label);
  const per = p.items / p.calls;
  console.log(
    `[perf] ${stats.name} [${label}]: ${per.toFixed(0)} items per call ` +
      `(${p.items} over ${p.calls} calls, ${(p.ms / p.calls).toFixed(2)}ms each)`,
  );
  return per;
}

/** Fail if a stage touched more material on the bigger fixture.
 *
 *  For stages that cut the material down to the viewport before doing any
 *  work: what they touch is set by the pixels on screen, so a longer file
 *  must not move it. Counted, so `tolerance` is for the odd rounded
 *  bucket, not for growth. */
export function expectStageFlat(
  small: BenchStats,
  big: BenchStats,
  label: string,
  tolerance = 1.1,
): void {
  const a = phaseItemsPerCall(small, label);
  const b = phaseItemsPerCall(big, label);
  const grew = b / Math.max(a, 1);
  console.log(`[perf] flatness ${label}: ×${grew.toFixed(2)} (must stay under ×${tolerance})`);
  if (grew > tolerance) {
    throw new Error(
      `PERF REGRESSION — ${label} touched ×${grew.toFixed(2)} the material per call on the ` +
        `bigger fixture (${a.toFixed(0)} → ${b.toFixed(0)} items). This stage is supposed to ` +
        `work off the viewport, not the file; something now walks the whole source. ` +
        `See reports/PERF_BASELINES.md.`,
    );
  }
}

/** Fail if a stage's material grew faster than the fixture: `big` holds
 *  `sizeRatio` times what `small` did, so a single pass over it touches
 *  `sizeRatio` times as much — and a pass-per-item touches its square.
 *  Counted, so the tolerance covers rounding, not a slow machine. */
export function expectStageLinear(
  small: BenchStats,
  big: BenchStats,
  label: string,
  sizeRatio: number,
  tolerance = 1.3,
): void {
  const a = phaseItemsPerCall(small, label);
  const b = phaseItemsPerCall(big, label);
  const grew = b / Math.max(a, 1);
  console.log(
    `[perf] scaling ${label}: ×${sizeRatio} fixture touched ×${grew.toFixed(2)} the material`,
  );
  if (grew > sizeRatio * tolerance) {
    throw new Error(
      `PERF REGRESSION — ${label} touched ×${grew.toFixed(2)} the material per call for a ` +
        `×${sizeRatio} fixture (${a.toFixed(0)} → ${b.toFixed(0)} items). A single pass would ` +
        `be ×${sizeRatio}; this is growing faster than the material. ` +
        `See reports/PERF_BASELINES.md.`,
    );
  }
}
