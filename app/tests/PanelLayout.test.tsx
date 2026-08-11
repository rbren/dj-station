// Declarative panel layouts (panelLayouts.ts): per-module grouping and
// arrangement of input cells, jack-on-top-of-control cells, fader
// controls, and the normalization guarantee that every manifest jack
// renders exactly once even if a layout forgets or misnames it.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModulePanel } from '../src/components/ModulePanel';
import { resolveLayout } from '../src/components/panelLayouts';
import type { Manifest, ModuleHandle } from '../src/types';

const HANDLE: ModuleHandle = {
  paramValue: () => 0,
  setParam: () => {},
  signalTap: () => ({ instantaneous: 0, rms_100ms: 0, display: 0, volatility: 0, is_fast: false }),
  size: { w: 300, h: 150 },
};

const noop = () => {};

const baseProps = {
  knobs: {},
  wired: {},
  handle: HANDLE,
  onKnobPosition: noop,
  onKnobConfig: noop,
  onAttenOffset: noop,
};

function manifest(id: string, inputs: string[], outputs: string[]): Manifest {
  return {
    id,
    name: id,
    version: '0.1.0',
    abi: 'wasm-1',
    inputs: inputs.map((i) => ({ id: i, name: i })),
    outputs: outputs.map((o) => ({ id: o, name: o })),
    params: [],
  };
}

describe('resolveLayout', () => {
  it('unknown modules fall back to one row with all inputs and outputs', () => {
    const m = manifest('com.example.mystery', ['a', 'b'], ['out']);
    const layout = resolveLayout(m);
    expect(layout.groups).toHaveLength(1);
    expect(layout.groups[0].cells.map((c) => c.jack)).toEqual(['a', 'b']);
    expect(layout.outputGroups).toHaveLength(1);
    expect(layout.outputGroups[0].outputs).toEqual(['out']);
  });

  it('registered layouts group and title the module inputs', () => {
    const m = manifest('com.dj.vco', ['pitch', 'fine', 'fm', 'fm_index', 'pwm', 'sync'], ['saw']);
    const layout = resolveLayout(m);
    expect(layout.groups.map((g) => g.title)).toEqual(['pitch', 'fm', 'shape']);
    const all = layout.groups.flatMap((g) => g.cells.map((c) => c.jack));
    expect([...all].sort()).toEqual(['fine', 'fm', 'fm_index', 'pitch', 'pwm', 'sync'].sort());
  });

  it('appends manifest jacks the layout forgot as an extra group', () => {
    const m = manifest('com.dj.vca', ['in', 'cv', 'brand_new_jack'], ['out']);
    const layout = resolveLayout(m);
    const all = layout.groups.flatMap((g) => g.cells.map((c) => c.jack));
    expect(all).toContain('brand_new_jack');
    expect(all).toHaveLength(3);
  });

  it('drops layout cells whose jack is missing from the manifest', () => {
    const m = manifest('com.dj.vca', ['in'], ['out']);
    const layout = resolveLayout(m);
    const all = layout.groups.flatMap((g) => g.cells.map((c) => c.jack));
    expect(all).toEqual(['in']);
  });

  it('never renders the same jack twice', () => {
    const m = manifest('com.dj.mixer', ['in1', 'lvl1', 'cv1', 'master'], ['out', 'inv']);
    const layout = resolveLayout(m);
    const all = layout.groups.flatMap((g) => g.cells.map((c) => c.jack));
    expect(new Set(all).size).toBe(all.length);
  });

  it('groups outputs with titles (clock module)', () => {
    const m = manifest(
      'com.dj.clock',
      ['bpm'],
      ['clock', 'div2', 'div4', 'div8', 'div16', 'mul2', 'mul3', 'mul4', 'bar'],
    );
    const layout = resolveLayout(m);
    expect(layout.outputGroups.map((g) => g.title)).toEqual(['clock', 'div', 'mul']);
    const all = layout.outputGroups.flatMap((g) => g.outputs);
    expect(all).toHaveLength(9);
  });
});

describe('ModulePanel with layouts', () => {
  it('renders the jack directly above its control inside an input cell', () => {
    const m = manifest('com.example.simple', ['freq'], ['out']);
    render(<ModulePanel {...baseProps} instanceId="x1" manifest={m} />);
    const cell = screen.getByTestId('input-cell-freq');
    const jack = screen.getByTestId('jack-input-freq');
    const knob = screen.getByTestId('knob-freq');
    expect(cell.contains(jack)).toBe(true);
    expect(cell.contains(knob)).toBe(true);
    // Jack comes before the control in document order (stacked on top).
    expect(jack.compareDocumentPosition(knob) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders group titles from the layout', () => {
    const m = manifest('com.dj.vco', ['pitch', 'fine', 'fm', 'fm_index', 'pwm', 'sync'], ['saw']);
    render(<ModulePanel {...baseProps} instanceId="vco1" manifest={m} />);
    expect(screen.getByText('pitch', { selector: '.input-group-title' })).toBeTruthy();
    expect(screen.getByText('fm', { selector: '.input-group-title' })).toBeTruthy();
    expect(screen.getByText('shape', { selector: '.input-group-title' })).toBeTruthy();
  });

  it('the mixer renders channel-strip level faders (sliders, hidden labels)', () => {
    const inputs = [1, 2, 3, 4, 5, 6].flatMap((c) => [`in${c}`, `lvl${c}`, `cv${c}`]);
    const m = manifest('com.dj.mixer', [...inputs, 'master'], ['out', 'inv']);
    render(<ModulePanel {...baseProps} instanceId="mix1" manifest={m} />);
    for (const ch of [1, 2, 3, 4, 5, 6]) {
      const cell = screen.getByTestId(`input-cell-lvl${ch}`);
      expect(cell.className).toContain('input-cell-fader');
      expect(cell.querySelector('.fader-v')).toBeTruthy();
      // hideLabel: no visible label under the fader.
      expect(cell.querySelector('.input-cell-label')).toBeNull();
    }
    expect(screen.getByTestId('input-cell-master').querySelector('.fader-v')).toBeTruthy();
  });

  it('jack-only cells (trig_seq patterns) render the jack without a control', () => {
    const inputs = ['clock', 'reset'];
    for (let i = 1; i <= 8; i++) inputs.push(`pat${i}`, `len${i}`);
    const m = manifest('com.dj.trig_seq', inputs, ['trig1']);
    render(<ModulePanel {...baseProps} instanceId="ts1" manifest={m} />);
    const cell = screen.getByTestId('input-cell-pat1');
    expect(cell.querySelector('[data-jack]')).toBeTruthy();
    expect(cell.querySelector('.knob')).toBeNull();
  });

  it('output jacks stay clickable and unique under grouped layouts', () => {
    const m = manifest(
      'com.dj.clock',
      ['bpm'],
      ['clock', 'div2', 'div4', 'div8', 'div16', 'mul2', 'mul3', 'mul4', 'bar'],
    );
    render(<ModulePanel {...baseProps} instanceId="clk1" manifest={m} />);
    for (const id of ['clock', 'div2', 'mul4', 'bar']) {
      expect(screen.getByTestId(`jack-output-${id}`)).toBeTruthy();
    }
  });
});
