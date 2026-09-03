// Rendering-pipeline instrumentation, shared by the three heavy surfaces
// (Rack, Grid, Clip).
//
// Two things are measured, and they answer different questions:
//
//  - RENDER COUNTS (`makeRenderCounter`) say how MUCH of a page redraws
//    when something small changes. They are exact and machine-independent,
//    which is why the Grid's perf suite has always counted rather than
//    timed; a count is the right assertion for a memoisation contract.
//  - PHASE TIMES (`timed`) say WHERE the milliseconds of a redraw went —
//    the peaks path build, the client-side peaks recompute, the rack's
//    cable measure. A wall-clock total tells you the page got slower;
//    phases tell you which stage to look at. Read them from the perf
//    suites (`app/tests/perfHarness.ts`) and from the dev stress HUD.
//
// Timing is OFF by default and the wrapper is then a plain call, so
// production renders pay nothing but the closure.

export interface PerfPhase {
  calls: number;
  ms: number;
}

let enabled = false;
const phases = new Map<string, PerfPhase>();

/** Turn phase timing on. The stress harness (src/stress/) and the perf
 *  test suites do this; nothing else should. */
export function setPerfEnabled(on: boolean): void {
  enabled = on;
  if (!on) phases.clear();
}

export function perfEnabled(): boolean {
  return enabled;
}

/** Time `fn` under `label` when instrumentation is on. */
export function timed<T>(label: string, fn: () => T): T {
  if (!enabled) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    recordPhase(label, performance.now() - t0);
  }
}

/** Record a phase measured by hand (a rAF-spanning stage, say). */
export function recordPhase(label: string, ms: number): void {
  if (!enabled) return;
  const p = phases.get(label);
  if (p) {
    p.calls += 1;
    p.ms += ms;
  } else {
    phases.set(label, { calls: 1, ms });
  }
}

export function perfPhases(): Record<string, PerfPhase> {
  return Object.fromEntries([...phases].map(([k, v]) => [k, { ...v }]));
}

export function resetPerfPhases(): void {
  phases.clear();
}

/** Phases as one line each, dearest first — what a perf test prints when
 *  it wants the reader to see where the time went. */
export function formatPerfPhases(): string {
  return [...phases]
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([label, p]) => `${label}: ${p.ms.toFixed(1)}ms over ${p.calls} calls`)
    .join('\n');
}

export interface RenderCounter {
  n: number;
  get(): number;
  bump(): void;
  reset(): void;
}

/** A counter of "times this drew itself". Counted from an effect rather
 *  than from a render body: a render React throws away never reaches the
 *  screen and is not work the user paid for. */
export function makeRenderCounter(): RenderCounter {
  return {
    n: 0,
    get() {
      return this.n;
    },
    bump() {
      this.n += 1;
    },
    reset() {
      this.n = 0;
    },
  };
}
