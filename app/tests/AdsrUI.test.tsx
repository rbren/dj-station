// M0 acceptance (headless-verifiable part): simulate dragging each ADSR
// segment in the custom UI and assert the underlying params change.
// (Param round-trip through patch save/load is covered engine-side by
// crates/dj-engine/tests/persistence.rs::adsr_params_roundtrip_through_save_load.)

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AdsrUI from '../../extensions/adsr/ui-src/AdsrUI';

function mockHandle(initial: Record<string, number>) {
  const params = { ...initial };
  const calls: Array<[string, number]> = [];
  return {
    params,
    calls,
    handle: {
      paramValue: (id: string) => params[id],
      setParam: (id: string, v: number) => {
        params[id] = v;
        calls.push([id, v]);
      },
    },
  };
}

const INITIAL = { attack: 0.5, decay: 0.5, sustain: 0.5, release: 0.5 };

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

  it('dragging the attack handle right increases attack', () => {
    const { handle, params } = mockHandle(INITIAL);
    render(<AdsrUI handle={handle} />);
    drag(screen.getByTestId('adsr-handle-attack'), 100, 0); // +100px = +2s
    expect(params.attack).toBeCloseTo(2.5, 3);
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
    drag(screen.getByTestId('adsr-handle-decay'), 50, 0); // +1s
    expect(params.decay).toBeCloseTo(1.5, 3);
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
    drag(screen.getByTestId('adsr-handle-release'), 150, 0); // +3s
    expect(params.release).toBeCloseTo(3.5, 3);
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
});
