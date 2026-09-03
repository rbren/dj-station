// Rendering-pipeline instrumentation, shared by the three heavy surfaces
// (Rack, Grid, Clip).
//
// Two things are measured, and they answer different questions:
//
//  - RENDER COUNTS (`makeRenderCounter`) say how MUCH of a page redraws
//    when something small changes. They are exact and machine-independent,
//    which is why the Grid's perf suite has always counted rather than
//    timed; a count is the right assertion for a memoisation contract.
//  - PHASES (`timedOver`) say WHERE a redraw went — the peaks path build,
//    the client-side peaks recompute, the rack's cable measure — as both
//    a time and a COUNT of the material the stage touched. The time is
//    for reading; the count is for asserting on, because a stage that
//    takes a millisecond in jsdom cannot be timed on a shared runner but
//    always walks exactly as many buckets as the code says it does.
//    Read both from the perf suites (`app/tests/perfHarness.ts`) and
//    from the dev stress HUD.
//
// Instrumentation is OFF by default and the wrapper is then a plain
// call, so a production render pays for the closure and for whatever
// counting the stage does inline (an addition per pass — the counts are
// kept unconditionally so they cannot drift from the real work).

export interface PerfPhase {
  calls: number;
  ms: number;
  /** How much MATERIAL the stage touched — peak buckets read, sockets
   *  looked up. Exact where the milliseconds are noisy: a stage that
   *  takes a millisecond cannot be timed on a busy box, but the number
   *  of buckets it walked is the same on every machine, so that is what
   *  the perf suites assert on. Zero for stages that do not report it. */
  items: number;
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

/** Time `fn` under `label` and record how much material it touched.
 *
 *  The closure returns both its value and the count, because for most
 *  stages the count is only known once the work is done (how many source
 *  buckets a cut actually read, how many sockets a measure looked up).
 *  Prefer asserting on the count: it is exact, and a millisecond stage on
 *  a shared runner is not. */
export function timedOver<T>(label: string, fn: () => { value: T; items: number }): T {
  if (!enabled) return fn().value;
  const t0 = performance.now();
  let items = 0;
  try {
    const r = fn();
    items = r.items;
    return r.value;
  } finally {
    recordPhase(label, performance.now() - t0, items);
  }
}

/** Record a phase measured by hand (a rAF-spanning stage, say). */
export function recordPhase(label: string, ms: number, items = 0): void {
  if (!enabled) return;
  const p = phases.get(label);
  if (p) {
    p.calls += 1;
    p.ms += ms;
    p.items += items;
  } else {
    phases.set(label, { calls: 1, ms, items });
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
    .map(
      ([label, p]) =>
        `${label}: ${p.ms.toFixed(1)}ms over ${p.calls} calls` +
        (p.items ? `, ${p.items} items` : ''),
    )
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
