// M0 acceptance (headless-verifiable part): simulate dragging each ADSR
// segment in the custom UI and assert the underlying params change.
// (Param round-trip through patch save/load is covered engine-side by
// crates/dj-engine/tests/persistence.rs::adsr_params_roundtrip_through_save_load.)
//
// Also covers the live gate playhead: the dot that shows where along the
// curve the running envelope currently is. Its position is replayed
// locally from the gate observation (see the AdsrUI header) — the pure
// replay functions are pinned directly, and the rendered dot end to end.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdsrUI, {
  applyGate,
  idleState,
  playheadAt,
  relock,
  stepEnvelope,
  type EnvState,
} from '../../extensions/adsr/ui-src/AdsrUI';

function mockHandle(initial: Record<string, number>, taps: Record<string, number> = {}) {
  const params = { ...initial };
  const calls: Array<[string, number]> = [];
  const endEdits = { count: 0 };
  const fast = { value: false };
  return {
    params,
    calls,
    endEdits,
    taps,
    fast,
    handle: {
      paramValue: (id: string) => params[id],
      setParam: (id: string, v: number) => {
        params[id] = v;
        calls.push([id, v]);
      },
      signalTap: (jackId: string) => ({
        instantaneous: taps[jackId] ?? 0,
        display: taps[jackId] ?? 0,
        is_fast: jackId === 'out:env' ? fast.value : false,
      }),
      endEdit: () => {
        endEdits.count += 1;
      },
    },
  };
}

const INITIAL = { attack: 0.5, decay: 0.5, sustain: 0.5, release: 0.5 };

// The viz box is fixed at 360x150 (12px padding, 60px sustain plateau);
// the time axis rescales to fit. For INITIAL (1.5s total) that is:
const SCALE = (360 - 2 * 12 - 60) / 1.5; // px per second, captured at drag start

function drag(el: Element, dx: number, dy: number) {
  fireEvent.mouseDown(el, { clientX: 200, clientY: 100 });
  fireEvent.mouseMove(window, { clientX: 200 + dx / 2, clientY: 100 + dy / 2 });
  fireEvent.mouseMove(window, { clientX: 200 + dx, clientY: 100 + dy });
  fireEvent.mouseUp(window);
}

describe('AdsrUI', () => {
  it('renders the envelope path and readout from params', () => {
    const { handle } = mockHandle(INITIAL);
    render(<AdsrUI handle={handle} />);
    expect(screen.getByTestId('adsr-path')).toBeTruthy();
    expect(screen.getByTestId('adsr-readout').textContent).toContain('A 0.500s');
    expect(screen.getByTestId('adsr-readout').textContent).toContain('S 0.50');
  });

  it('keeps the viz box a fixed size while dragging horizontal params', () => {
    const { handle } = mockHandle(INITIAL);
    render(<AdsrUI handle={handle} />);
    const svg = screen.getByRole('img', { name: 'ADSR envelope' });
    const before = svg.getAttribute('viewBox');
    drag(screen.getByTestId('adsr-handle-release'), 200, 0);
    expect(svg.getAttribute('viewBox')).toEqual(before);
    expect(svg.getAttribute('width')).toBe('360');
    expect(svg.getAttribute('height')).toBe('150');
  });

  it('dragging the attack handle right increases attack', () => {
    const { handle, params } = mockHandle(INITIAL);
    render(<AdsrUI handle={handle} />);
    drag(screen.getByTestId('adsr-handle-attack'), 100, 0);
    expect(params.attack).toBeCloseTo(0.5 + 100 / SCALE, 3);
    expect(params.decay).toBe(0.5);
    expect(params.sustain).toBe(0.5);
    expect(params.release).toBe(0.5);
  });

  it('dragging the attack handle left decreases attack and clamps at ~0', () => {
    const { handle, params } = mockHandle(INITIAL);
    render(<AdsrUI handle={handle} />);
    drag(screen.getByTestId('adsr-handle-attack'), -500, 0);
    expect(params.attack).toBeCloseTo(0.001, 4);
  });

  it('dragging the decay handle changes only decay', () => {
    const { handle, params } = mockHandle(INITIAL);
    render(<AdsrUI handle={handle} />);
    drag(screen.getByTestId('adsr-handle-decay'), 50, 0);
    expect(params.decay).toBeCloseTo(0.5 + 50 / SCALE, 3);
    expect(params.attack).toBe(0.5);
    expect(params.sustain).toBe(0.5);
  });

  it('dragging the sustain handle up increases sustain', () => {
    const { handle, params } = mockHandle(INITIAL);
    render(<AdsrUI handle={handle} />);
    // Plot height is 150 with 12px padding: -63px = +0.5 sustain.
    drag(screen.getByTestId('adsr-handle-sustain'), 0, -63);
    expect(params.sustain).toBeCloseTo(1.0, 2);
    expect(params.attack).toBe(0.5);
  });

  it('dragging the sustain handle down decreases sustain and clamps at 0', () => {
    const { handle, params } = mockHandle(INITIAL);
    render(<AdsrUI handle={handle} />);
    drag(screen.getByTestId('adsr-handle-sustain'), 0, 400);
    expect(params.sustain).toBe(0);
  });

  it('dragging the release handle changes only release', () => {
    const { handle, params } = mockHandle(INITIAL);
    render(<AdsrUI handle={handle} />);
    drag(screen.getByTestId('adsr-handle-release'), 150, 0);
    expect(params.release).toBeCloseTo(0.5 + 150 / SCALE, 3);
    expect(params.sustain).toBe(0.5);
  });

  it('updates the drawn envelope while dragging', () => {
    const { handle } = mockHandle(INITIAL);
    render(<AdsrUI handle={handle} />);
    const before = screen.getByTestId('adsr-path').getAttribute('d');
    drag(screen.getByTestId('adsr-handle-attack'), 60, 0);
    const after = screen.getByTestId('adsr-path').getAttribute('d');
    expect(after).not.toEqual(before);
  });

  it('pushes every changed param through handle.setParam', () => {
    const { handle, calls } = mockHandle(INITIAL);
    render(<AdsrUI handle={handle} />);
    drag(screen.getByTestId('adsr-handle-attack'), 25, 0);
    drag(screen.getByTestId('adsr-handle-sustain'), 0, 30);
    const touched = new Set(calls.map(([id]) => id));
    expect(touched.has('attack')).toBe(true);
    expect(touched.has('sustain')).toBe(true);
    expect(touched.has('release')).toBe(false);
  });

  it('re-syncs from the engine when params change externally (panel knobs)', () => {
    const first = mockHandle(INITIAL);
    const { rerender } = render(<AdsrUI handle={first.handle} />);
    expect(screen.getByTestId('adsr-readout').textContent).toContain('A 0.500s');
    // New handle identity with a changed attack — as App produces after a
    // generated param knob moves and the snapshot refreshes.
    const second = mockHandle({ ...INITIAL, attack: 2.0 });
    rerender(<AdsrUI handle={second.handle} />);
    expect(screen.getByTestId('adsr-readout').textContent).toContain('A 2.000s');
  });

  it('signals endEdit once per completed drag gesture', () => {
    const { handle, endEdits } = mockHandle(INITIAL);
    render(<AdsrUI handle={handle} />);
    drag(screen.getByTestId('adsr-handle-attack'), 50, 0);
    expect(endEdits.count).toBe(1);
    drag(screen.getByTestId('adsr-handle-release'), 30, 0);
    expect(endEdits.count).toBe(2);
    // A stray mouseup without a drag does not fire endEdit.
    fireEvent.mouseUp(window);
    expect(endEdits.count).toBe(2);
  });
});

// ---------------------------------------------------------------- playhead

const ENV = { attack: 1, decay: 1, sustain: 0.5, release: 1 };

/** Replay from idle through `secs` of held gate, in frame-sized steps. */
function hold(env: typeof ENV, secs: number): EnvState {
  let s = applyGate(idleState(), true, false);
  for (let t = 0; t < secs; t += 0.01) s = stepEnvelope(s, env, 0.01);
  return s;
}

describe('AdsrUI envelope replay', () => {
  it('walks attack -> decay -> sustain at the module rates', () => {
    // attack 1 s to 10 V, decay 1 s down to 5 V (sustain 0.5), then holds.
    expect(hold(ENV, 0.5).stage).toBe('attack');
    expect(hold(ENV, 0.5).level).toBeCloseTo(5, 1);
    expect(hold(ENV, 1.5).stage).toBe('decay');
    expect(hold(ENV, 1.5).level).toBeCloseTo(7.5, 1);
    const sustained = hold(ENV, 3);
    expect(sustained.stage).toBe('sustain');
    expect(sustained.level).toBeCloseTo(5, 4);
  });

  it('releases from the level the gate fell at, and reaches idle', () => {
    const mid = hold(ENV, 0.5); // ~5 V, mid-attack
    let s = applyGate(mid, false, false);
    expect(s.stage).toBe('release');
    expect(s.releaseFrom).toBeCloseTo(5, 1);
    // The release ramp is fixed at gate-off: 5 V over the release time.
    for (let t = 0; t < 0.9; t += 0.01) s = stepEnvelope(s, ENV, 0.01);
    expect(s.stage).toBe('release');
    for (let t = 0; t < 0.2; t += 0.01) s = stepEnvelope(s, ENV, 0.01);
    expect(s.stage).toBe('idle');
    expect(s.level).toBe(0);
  });

  it('retrig restarts the attack from the current level', () => {
    const again = applyGate(hold(ENV, 3), true, true);
    expect(again.stage).toBe('attack');
    expect(again.level).toBeCloseTo(5, 4); // continues up, no jump to zero
  });

  it('consumes a whole frame across stage boundaries (fast envelopes)', () => {
    // A 1 ms attack + 1 ms decay inside one 16 ms frame must land in
    // sustain — not advance one stage per frame.
    const fast = { attack: 0.001, decay: 0.001, sustain: 0.4, release: 0.001 };
    const s = stepEnvelope(applyGate(idleState(), true, false), fast, 0.016);
    expect(s.stage).toBe('sustain');
    expect(s.level).toBeCloseTo(4, 4);
  });

  it('re-locks to the engine tap when a gate pulse was missed', () => {
    // Engine says the envelope is running; our replay never saw the gate.
    const locked = relock(idleState(), ENV, true, 8);
    expect(locked.stage).toBe('decay'); // above the 5 V sustain target
    expect(locked.level).toBe(8);
    // Gate already low: the missed pulse is in its release tail.
    expect(relock(idleState(), ENV, false, 3).stage).toBe('release');
    // Replay thinks it is running, engine says silent: idle wins.
    expect(relock(hold(ENV, 3), ENV, false, 0).stage).toBe('idle');
    // Both agree it is running: no correction (chasing a sample that is
    // up to a poll old would jitter the dot).
    const running = hold(ENV, 0.5);
    expect(relock(running, ENV, true, 9).level).toBe(running.level);
  });
});

describe('AdsrUI playhead geometry', () => {
  // For ENV the box packs 3 s into 276 px (92 px/s), so the corners are:
  const geoX = { x0: 12, xA: 104, xD: 196, xS: 256 };

  it('has no playhead when idle', () => {
    expect(playheadAt(idleState(), ENV)).toBeNull();
  });

  it('sits on the right limb through every stage', () => {
    const a = playheadAt(hold(ENV, 0.5), ENV)!;
    expect(a.x).toBeGreaterThan(geoX.x0);
    expect(a.x).toBeLessThan(geoX.xA);
    expect(a.label).toContain('attack');

    const d = playheadAt(hold(ENV, 1.5), ENV)!;
    expect(d.x).toBeGreaterThan(geoX.xA);
    expect(d.x).toBeLessThan(geoX.xD);

    // Sustain walks the plateau and parks at its end.
    const s1 = playheadAt(hold(ENV, 2.2), ENV)!;
    const s2 = playheadAt(hold(ENV, 2.6), ENV)!;
    expect(s2.x).toBeGreaterThan(s1.x);
    expect(playheadAt(hold(ENV, 30), ENV)!.x).toBeCloseTo(geoX.xS, 1);
  });

  it('advances right and rises with the level during attack', () => {
    const early = playheadAt(hold(ENV, 0.2), ENV)!;
    const later = playheadAt(hold(ENV, 0.8), ENV)!;
    expect(later.x).toBeGreaterThan(early.x);
    expect(later.y).toBeLessThan(early.y); // rising envelope = up the box
  });

  it('draws the release limb from where the gate actually fell', () => {
    // Gate dropped mid-attack: the dot leaves from the attack limb (left
    // of the plateau), not from the drawn release corner.
    const attackY = playheadAt(hold(ENV, 0.5), ENV)!.y;
    const p = playheadAt(applyGate(hold(ENV, 0.5), false, false), ENV)!;
    expect(p.x).toBeLessThan(geoX.xS);
    expect(p.y).toBeCloseTo(attackY, 1);
    // A held note releases from the plateau's end instead.
    const held = playheadAt(applyGate(hold(ENV, 30), false, false), ENV)!;
    expect(held.x).toBeCloseTo(geoX.xS, 1);
  });

  it('trails from the curve origin to the dot', () => {
    const p = playheadAt(hold(ENV, 1.5), ENV)!;
    expect(p.trail.startsWith('M 12.0 138.0')).toBe(true);
    expect(p.trail.endsWith(`L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)).toBe(true);
  });
});

describe('AdsrUI playhead rendering', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const fakeTime = () =>
    vi.useFakeTimers({
      toFake: ['performance', 'requestAnimationFrame', 'cancelAnimationFrame'],
    });
  const dot = () => screen.getByTestId('adsr-playhead');

  it('is hidden while the gate is closed', () => {
    const { handle } = mockHandle(INITIAL);
    render(<AdsrUI handle={handle} />);
    expect(dot().getAttribute('opacity')).toBe('0');
    expect(screen.getByTestId('adsr-stage').textContent).toBe('idle');
  });

  it('appears on gate and keeps moving BETWEEN telemetry polls', () => {
    fakeTime();
    const taps: Record<string, number> = { gate: 10 };
    const { handle } = mockHandle({ ...INITIAL, attack: 1, decay: 1, release: 1 }, taps);
    const { rerender } = render(<AdsrUI handle={handle} />);

    // One 100 ms telemetry poll later, with the gate held.
    act(() => void vi.advanceTimersByTime(100));
    rerender(<AdsrUI handle={handle} />);
    expect(dot().getAttribute('opacity')).toBe('1');
    expect(screen.getByTestId('adsr-stage').textContent).toContain('attack');
    const first = Number(dot().getAttribute('cx'));

    // No re-render at all — the rAF loop alone must advance the dot.
    act(() => void vi.advanceTimersByTime(96));
    expect(Number(dot().getAttribute('cx'))).toBeGreaterThan(first);
  });

  it('follows the gate down through release and back to hidden', () => {
    fakeTime();
    const taps: Record<string, number> = { gate: 10 };
    const { handle } = mockHandle({ attack: 0.1, decay: 0.1, sustain: 0.5, release: 0.1 }, taps);
    const { rerender } = render(<AdsrUI handle={handle} />);
    act(() => void vi.advanceTimersByTime(300));
    rerender(<AdsrUI handle={handle} />);
    expect(screen.getByTestId('adsr-stage').textContent).toContain('sustain');

    taps.gate = 0;
    taps['out:env'] = 5;
    act(() => void vi.advanceTimersByTime(16));
    rerender(<AdsrUI handle={handle} />);
    expect(screen.getByTestId('adsr-stage').textContent).toContain('release');

    act(() => void vi.advanceTimersByTime(200));
    expect(dot().getAttribute('opacity')).toBe('0');
  });

  it('shows a missed gate pulse picked up from the env tap', () => {
    // The gate opened and closed between polls: only the env tail is
    // visible, and the playhead must still show it.
    const { handle } = mockHandle(INITIAL, { gate: 0, 'out:env': 4 });
    render(<AdsrUI handle={handle} />);
    expect(dot().getAttribute('opacity')).toBe('1');
    expect(screen.getByTestId('adsr-stage').textContent).toContain('release');
  });

  it('dims the dot when the envelope moves faster than the display', () => {
    const m = mockHandle(INITIAL, { gate: 10, 'out:env': 5 });
    m.fast.value = true;
    render(<AdsrUI handle={m.handle} />);
    expect(dot().getAttribute('class')).toContain('adsr-playhead-uncertain');
    expect(screen.getByTestId('adsr-stage').textContent).toBe('retriggering');
  });

  it('works with handles that have no signalTap (docs previews)', () => {
    const params: Record<string, number> = { ...INITIAL };
    render(<AdsrUI handle={{ paramValue: (id) => params[id], setParam: () => {} }} />);
    expect(dot().getAttribute('opacity')).toBe('0');
    expect(screen.getByTestId('adsr-path')).toBeTruthy();
  });
});
