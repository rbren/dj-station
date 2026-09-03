// Rack page performance: a BIG patch — dozens of module panels, hundreds
// of jacks, wires between them — mounted, polled and re-measured.
//
// The fixture is the dev stress harness's own mock engine
// (`src/stress/mockEngine.ts`), fabricated from the REAL extension
// manifests, so the panels, jack counts and custom UIs are production's
// and the numbers here are comparable with what the interactive harness
// (`npm run dev -- ?stress=48`) shows. Nothing is committed: the patch is
// generated per run.
//
// What is asserted, in order of trustworthiness:
//   1. counts — a telemetry tick must not re-measure the cable overlay
//      (its mutation filter is the only thing keeping a 10 Hz poll off
//      every jack's bounding box);
//   2. scaling — twice the modules must not cost four times the mount;
//   3. wall clock — a calibration-scaled budget with several times the
//      measured cost in headroom (see tests/perfHarness.ts).

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { perfPhases, resetPerfPhases, setPerfEnabled } from '../src/perf';
import { createMockEngine } from '../src/stress/mockEngine';
import {
  bench,
  expectSubQuadratic,
  expectWithinBudget,
  heavy,
  phaseCost,
  slowdownFactor,
} from './perfHarness';
import App from '../src/App';

/** Modules in the big fixture. 24 is a busy patch; the CI perf job's 96
 *  is one nobody would call reasonable, which is the point. */
const MODULES = heavy(16, 48);
/** Mounting a rack of panels in jsdom costs seconds, and a bench mounts
 *  it several times over; vitest's 5 s default would fail the suite for
 *  doing exactly what it was asked to do. */
const TIMEOUT = heavy(90_000, 300_000);
/** Telemetry poll of the rack, as App drives it. */
const POLL_MS = 100;

function installMockEngine(modules: number) {
  const engine = createMockEngine({ modules, activeFraction: 0.6 });
  window.__DJ_STRESS_INVOKE__ = engine.invoke;
  return engine;
}

/** Mount the whole App against a rack of `modules` mock modules and wait
 *  until the last panel is on screen. */
async function mountRack(modules: number) {
  const engine = installMockEngine(modules);
  render(<App />);
  const last = `module-stress-${modules - 1}-`;
  await waitFor(() =>
    expect(screen.getAllByTestId(new RegExp(`^${last}`)).length).toBeGreaterThan(0),
  );
  return engine;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  delete window.__DJ_STRESS_INVOKE__;
  vi.useRealTimers();
  setPerfEnabled(false);
});

describe('Rack rendering performance', () => {
  it(
    `mounts a ${MODULES}-module rack`,
    async () => {
      const stats = await bench(`rack mount ×${MODULES}`, () => mountRack(MODULES), {
        runs: 3,
        teardown: () => {
          cleanup();
          localStorage.clear();
        },
      });

      const counts = installMockEngine(MODULES).counts();
      console.log(
        `[perf] rack fixture: ${counts.modules} modules, ${counts.wires} wires, ${counts.jacks} jacks`,
      );
      // jsdom mounts every panel eagerly (no layout, no compositor), so
      // this is the React + DOM cost alone. Budget: ~5× the measured cost.
      expectWithinBudget(stats, heavy(4_000, 12_000));
    },
    TIMEOUT,
  );

  it(
    'measures the cables in one pass, not one pass per wire',
    async () => {
      // Both fixtures are whole multiples of the manifest cycle, so they
      // hold the same MIX of panels — halving the count instead would drop
      // the two monsters at the end of the cycle (mixer8's 49 inputs,
      // step_seq's 56) and measure the fixture rather than the page.
      const opts = {
        runs: 2,
        teardown: () => {
          cleanup();
          localStorage.clear();
        },
      };
      const small = await bench(`rack mount ×${MODULES}`, () => mountRack(MODULES), opts);
      const big = await bench(`rack mount ×${MODULES * 2}`, () => mountRack(MODULES * 2), opts);

      // The SCALING assertion is made against an instrumented stage rather
      // than the whole mount: the mount is mostly jsdom (which is itself
      // superlinear in DOM size on a small heap), while `rack.wireMeasure`
      // is code this repo owns. Looking each socket up by its own
      // `querySelector` made it quadratic — ×25 the cost at 16 modules —
      // and this is the assertion that catches that coming back.
      expectSubQuadratic(
        phaseCost(small, 'rack.wireMeasure'),
        phaseCost(big, 'rack.wireMeasure'),
        2,
      );
      // The mount itself is reported, not gated: the budget above is the
      // gate on it.
      console.log(
        `[perf] mount growth ×${MODULES}→×${MODULES * 2}: ` +
          `${(big.median / small.median).toFixed(2)}×`,
      );
    },
    TIMEOUT,
  );

  it(
    'keeps a telemetry tick off the cable overlay',
    async () => {
      const engine = await mountRack(MODULES);
      // The poll runs on REAL timers (mounting the rack needs `waitFor`,
      // which cannot advance a fake clock it does not own), so what is
      // asserted here is a COUNT over a few real ticks rather than a
      // wall-clock reading dominated by the waiting.
      let ticks = 0;
      const inner = engine.invoke;
      window.__DJ_STRESS_INVOKE__ = async (cmd, args) => {
        if (cmd === 'tap_all') ticks += 1;
        return inner(cmd, args);
      };

      setPerfEnabled(true);
      resetPerfPhases();
      const before = perfPhases()['rack.wireMeasure']?.calls ?? 0;
      await act(async () => {
        await new Promise((done) => setTimeout(done, POLL_MS * 4));
      });
      const measures = (perfPhases()['rack.wireMeasure']?.calls ?? 0) - before;
      setPerfEnabled(false);

      expect(ticks).toBeGreaterThanOrEqual(2);
      // The overlay's MutationObserver deliberately ignores the attribute
      // churn telemetry causes (glows, dials, meter fills). If that filter
      // breaks, every 100 ms poll walks every jack's bounding box — the
      // one thing on this page that forces layout, and the stage the mount
      // bench above shows is the dearest of all.
      expect(measures).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'reports where a mount spends its time',
    async () => {
      setPerfEnabled(true);
      resetPerfPhases();
      await mountRack(MODULES);
      const phases = perfPhases();
      setPerfEnabled(false);

      // Not a budget — a REPORT, and the proof that the instrumentation is
      // wired up on this page at all. `rack.wireMeasure` is the rack's own
      // stage; in a browser each call forces layout for every wire end.
      console.log(
        `[perf] rack mount phases (×${MODULES}, calibration ×${slowdownFactor().toFixed(2)}):`,
        JSON.stringify(phases),
      );
      expect(phases['rack.wireMeasure']?.calls ?? 0).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});
