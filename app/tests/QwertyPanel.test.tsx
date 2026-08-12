// QWERTY module frontend: the panel forwards alphanumeric + space key
// transitions (no repeats, no shortcuts, not while typing) and the
// module layout arranges the 37 key jacks like a physical keyboard.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { resolveLayout } from '../src/components/panelLayouts';
import { QwertyPanel } from '../src/components/QwertyPanel';
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

  it('stops capturing when the toggle is off and releases held keys', () => {
    const onKey = vi.fn();
    render(<QwertyPanel instance="kb1" onKey={onKey} />);
    fireEvent.keyDown(window, { key: 'b' });
    expect(onKey.mock.calls).toEqual([['b', true]]);
    // Disabling releases the held key so its gate doesn't stick high.
    fireEvent.click(screen.getByTestId('qwerty-capture-kb1'));
    expect(onKey.mock.calls).toEqual([
      ['b', true],
      ['b', false],
    ]);
    fireEvent.keyDown(window, { key: 'c' });
    expect(onKey).toHaveBeenCalledTimes(2);
    // Re-enabling resumes capture.
    fireEvent.click(screen.getByTestId('qwerty-capture-kb1'));
    fireEvent.keyDown(window, { key: 'c' });
    expect(onKey.mock.calls[2]).toEqual(['c', true]);
  });
});
