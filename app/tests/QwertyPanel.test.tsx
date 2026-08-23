// QWERTY module frontend: the panel forwards alphanumeric + space key
// transitions (no repeats, no shortcuts, not while typing) and the
// module layout arranges the 37 key jacks like a physical keyboard.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { resolveLayout } from '../src/components/panelLayouts';
import { QwertyPanel } from '../src/components/QwertyPanel';
import { RackKeysContext } from '../src/keyScope';
import type { Manifest } from '../src/types';

const KEYS = [
  ...'1234567890'.split(''),
  ...'qwertyuiop'.split(''),
  ...'asdfghjkl'.split(''),
  ...'zxcvbnm'.split(''),
  'space',
];

function qwertyManifest(): Manifest {
  return {
    id: 'builtin.qwerty',
    name: 'QWERTY',
    version: '0.1.0',
    abi: 'native-1',
    inputs: [],
    outputs: KEYS.map((k) => ({ id: k, name: k === 'space' ? 'Space' : k.toUpperCase() })),
    params: [],
  };
}

describe('builtin.qwerty layout', () => {
  it('arranges all 37 key jacks as the physical keyboard rows', () => {
    const layout = resolveLayout(qwertyManifest());
    expect(layout.outputGroups.map((g) => g.outputs.join(''))).toEqual([
      '1234567890',
      'qwertyuiop',
      'asdfghjkl',
      'zxcvbnm',
      'space',
    ]);
    // Each row starts a new line and the lower rows are staggered like
    // real key rows.
    expect(layout.outputGroups.every((g) => g.break)).toBe(true);
    const indents = layout.outputGroups.map((g) => g.indent ?? 0);
    expect(indents[0]).toBe(0);
    for (let i = 1; i < indents.length; i++) {
      expect(indents[i]).toBeGreaterThan(indents[i - 1]);
    }
  });
});

describe('QwertyPanel', () => {
  it('forwards keydown/keyup as gate on/off, once per hold', () => {
    const onKey = vi.fn();
    render(<QwertyPanel instance="kb1" onKey={onKey} />);
    fireEvent.keyDown(window, { key: 'q' });
    fireEvent.keyDown(window, { key: 'q', repeat: true });
    fireEvent.keyDown(window, { key: 'q' }); // still held: no retrigger
    expect(onKey.mock.calls).toEqual([['q', true]]);
    fireEvent.keyUp(window, { key: 'q' });
    expect(onKey.mock.calls).toEqual([
      ['q', true],
      ['q', false],
    ]);
  });

  it('keeps the gate held across parent re-renders (fresh onKey closures)', () => {
    // The rack re-renders constantly (telemetry). If the key listeners
    // re-mounted per render, their cleanup would release held gates.
    const calls: [string, boolean][] = [];
    const { rerender } = render(
      <QwertyPanel instance="kb1" onKey={(k, d) => calls.push([k, d])} />,
    );
    fireEvent.keyDown(window, { key: 'g' });
    rerender(<QwertyPanel instance="kb1" onKey={(k, d) => calls.push([k, d])} />);
    rerender(<QwertyPanel instance="kb1" onKey={(k, d) => calls.push([k, d])} />);
    expect(calls).toEqual([['g', true]]); // no spurious release
    fireEvent.keyUp(window, { key: 'g' });
    expect(calls).toEqual([
      ['g', true],
      ['g', false],
    ]);
  });

  it('maps the space bar and uppercase letters to their jacks', () => {
    const onKey = vi.fn();
    render(<QwertyPanel instance="kb1" onKey={onKey} />);
    fireEvent.keyDown(window, { key: ' ' });
    fireEvent.keyDown(window, { key: 'A' });
    expect(onKey.mock.calls).toEqual([
      [' ', true],
      ['a', true],
    ]);
  });

  it('ignores shortcuts, non-alnum keys, and typing into fields', () => {
    const onKey = vi.fn();
    render(
      <div>
        <input data-testid="field" />
        <QwertyPanel instance="kb1" onKey={onKey} />
      </div>,
    );
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(screen.getByTestId('field'), { key: 'q' });
    expect(onKey).not.toHaveBeenCalled();
  });

  it('goes quiet while the rack page is inactive, releasing held gates', () => {
    // The rack stays mounted (hidden) when another page is showing, so
    // the panel must gate on RackKeysContext, not on being mounted.
    const onKey = vi.fn();
    const at = (active: boolean) => (
      <RackKeysContext.Provider value={active}>
        <QwertyPanel instance="kb1" onKey={onKey} />
      </RackKeysContext.Provider>
    );
    const { rerender } = render(at(true));
    fireEvent.keyDown(window, { key: 'q' });
    expect(onKey.mock.calls).toEqual([['q', true]]);

    // Switching away releases the held gate immediately (its keyup will
    // land on the other page) and further keys are ignored.
    rerender(at(false));
    expect(onKey.mock.calls).toEqual([
      ['q', true],
      ['q', false],
    ]);
    fireEvent.keyDown(window, { key: 'w' });
    fireEvent.keyUp(window, { key: 'w' });
    expect(onKey).toHaveBeenCalledTimes(2);

    // Back on the rack page the keyboard plays again.
    rerender(at(true));
    fireEvent.keyDown(window, { key: 'e' });
    expect(onKey.mock.calls).toEqual([
      ['q', true],
      ['q', false],
      ['e', true],
    ]);
  });

  it('releases held keys on unmount so gates never stick high', () => {
    const onKey = vi.fn();
    const { unmount } = render(<QwertyPanel instance="kb1" onKey={onKey} />);
    fireEvent.keyDown(window, { key: 'b' });
    expect(onKey.mock.calls).toEqual([['b', true]]);
    unmount();
    expect(onKey.mock.calls).toEqual([
      ['b', true],
      ['b', false],
    ]);
    // And the listeners are gone.
    fireEvent.keyDown(window, { key: 'c' });
    expect(onKey).toHaveBeenCalledTimes(2);
  });
});
