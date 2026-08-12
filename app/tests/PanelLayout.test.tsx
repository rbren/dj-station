// Declarative panel layouts (panelLayouts.ts): per-module grouping and
// arrangement of input cells, jack-on-top-of-control cells, fader
// controls, and the normalization guarantee that every manifest jack
// renders exactly once even if a layout forgets or misnames it.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import StepSeqUI from '../../extensions/step_seq/ui-src/StepSeqUI';
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
    const m = manifest(
      'com.dj.mixer',
      ['in1_l', 'in1_r', 'lvl1', 'pan1', 'cv1', 'master'],
      ['out_l', 'out_r'],
    );
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
    const inputs = [1, 2, 3, 4, 5, 6].flatMap((c) => [
      `in${c}_l`,
      `in${c}_r`,
      `lvl${c}`,
      `pan${c}`,
    ]);
    const m = manifest('com.dj.mixer', [...inputs, 'master'], ['out_l', 'out_r']);
    render(<ModulePanel {...baseProps} instanceId="mix1" manifest={m} />);
    for (const ch of [1, 2, 3, 4, 5, 6]) {
      const cell = screen.getByTestId(`input-cell-lvl${ch}`);
      expect(cell.className).toContain('input-cell-fader');
      expect(cell.querySelector('.fader-v')).toBeTruthy();
      // hideLabel: no visible label under the fader.
      expect(cell.querySelector('.input-cell-label')).toBeNull();
      // Pan renders as an ordinary dial.
      expect(screen.getByTestId(`input-cell-pan${ch}`).querySelector('.knob')).toBeTruthy();
    }
    expect(screen.getByTestId('input-cell-master').querySelector('.fader-v')).toBeTruthy();
  });

  it('audio-flagged inputs render as plain jacks with no control (mixer ins)', () => {
    const m: Manifest = {
      ...manifest('com.dj.mixer', ['lvl1', 'master'], ['out_l', 'out_r']),
      inputs: [
        { id: 'in1_l', name: 'In 1 L', audio: true },
        { id: 'in1_r', name: 'In 1 R', audio: true },
        { id: 'lvl1', name: 'Level 1' },
        { id: 'master', name: 'Master' },
      ],
    };
    render(<ModulePanel {...baseProps} instanceId="mix1" manifest={m} />);
    for (const jack of ['in1_l', 'in1_r']) {
      const cell = screen.getByTestId(`input-cell-${jack}`);
      expect(cell.querySelector('[data-jack]')).toBeTruthy();
      expect(cell.querySelector('.knob')).toBeNull();
    }
    // Non-audio inputs keep their controls.
    expect(screen.getByTestId('input-cell-master').querySelector('.knob')).toBeTruthy();
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

  it('the attenuverter pairs each output with its inputs in one short column', () => {
    const inputs: string[] = [];
    const outputs: string[] = [];
    for (let ch = 1; ch <= 8; ch++) {
      inputs.push(`in${ch}`, `atten${ch}`, `offset${ch}`);
      outputs.push(`out${ch}`);
    }
    const m = manifest('com.dj.attenuverter', inputs, outputs);
    const layout = resolveLayout(m);
    // Eight channel columns, each in -> atten -> offset -> out.
    expect(layout.groups).toHaveLength(8);
    for (const [i, g] of layout.groups.entries()) {
      const ch = i + 1;
      expect(g.kind).toBe('column');
      expect(g.cells.map((c) => c.jack)).toEqual([
        `in${ch}`,
        `atten${ch}`,
        `offset${ch}`,
        `out${ch}`,
      ]);
      expect(g.cells[3].output).toBe(true);
    }
    // The inline outputs are consumed: no separate output strip remains.
    expect(layout.outputGroups).toHaveLength(0);

    render(<ModulePanel {...baseProps} instanceId="att1" manifest={m} />);
    for (let ch = 1; ch <= 8; ch++) {
      const out = screen.getByTestId(`jack-output-out${ch}`);
      // Rendered inside its channel's input group, under the same column
      // as the channel inputs.
      const group = out.closest('.input-group');
      expect(group).toBeTruthy();
      expect(group!.querySelector(`[data-jack="att1:input:in${ch}"]`)).toBeTruthy();
    }
  });
});

// The playhead strip (custom StepSeqUI) must line up with the per-step
// cv/gate/ratchet columns: the step grid is the FIRST input group (right
// under the custom UI), both grids use 16 columns sized by the shared
// --cell-w token, and lamp N sits over the column holding cvN/gateN/
// ratchetN.
describe('step sequencer strip alignment', () => {
  const stepSeqManifest = () => {
    const inputs = ['clock', 'reset', 'length', 'dir', 'glide'];
    for (let i = 1; i <= 16; i++) inputs.push(`cv${i}`);
    for (let i = 1; i <= 16; i++) inputs.push(`gate${i}`);
    for (let i = 1; i <= 16; i++) inputs.push(`ratchet${i}`);
    return manifest('com.dj.step_seq', inputs, ['cv', 'gate', 'step']);
  };

  it('the 16-column step grid is the first group; column s holds cv/gate/ratchet s', () => {
    const layout = resolveLayout(stepSeqManifest());
    const grid = layout.groups[0];
    expect(grid.kind).toBe('grid');
    expect(grid.columns).toBe(16);
    // Row-major grid fill: row 1 = cv1..cv16, row 2 = gates, row 3 =
    // ratchets — so column s stacks cvS over gateS over ratchetS.
    const jacks = grid.cells.map((c) => c.jack);
    for (let s = 1; s <= 16; s++) {
      expect(jacks[s - 1]).toBe(`cv${s}`);
      expect(jacks[16 + s - 1]).toBe(`gate${s}`);
      expect(jacks[32 + s - 1]).toBe(`ratchet${s}`);
    }
    // Transport moved below the step grid.
    expect(layout.groups[1].title).toBe('transport');
  });

  it('renders the strip before the step grid with the shared column template', () => {
    render(
      <ModulePanel
        {...baseProps}
        instanceId="seq1"
        manifest={stepSeqManifest()}
        customUI={StepSeqUI}
      />,
    );
    const strip = screen.getByTestId('stepseq-ui');
    const grid = document.querySelector<HTMLElement>('.input-group-grid .input-group-cells');
    expect(grid).toBeTruthy();
    // 16 numbered lamps, one per column.
    expect(strip.querySelectorAll('.stepseq-lamp')).toHaveLength(16);
    // Strip sits above (before) the step grid in document order.
    expect(strip.compareDocumentPosition(grid!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The panel grid's columns are the shared --cell-w token — the same
    // token .stepseq-ui uses for its own 16 columns (pinned below).
    expect(grid!.style.gridTemplateColumns).toBe('repeat(16, var(--cell-w, max-content))');
  });

  it('styles.css sizes the strip and the input cells from the same tokens', () => {
    // vitest runs with the app directory as cwd. (A `?raw` import would
    // be nicer, but vitest's css handling returns '' for .css imports.)
    const css = readFileSync('src/styles.css', 'utf8');
    const rule = (selector: string) => {
      const m = css.match(new RegExp(`\\${selector}\\s*{[^}]*}`));
      if (!m) throw new Error(`missing rule ${selector}`);
      return m[0];
    };
    expect(rule('.stepseq-ui')).toContain('grid-template-columns: repeat(16, var(--cell-w))');
    expect(rule('.stepseq-ui')).toContain('gap: var(--cell-gap)');
    expect(rule('.input-cell')).toContain('width: var(--cell-w)');
    expect(rule('.input-group-cells')).toContain('gap: var(--cell-gap)');
  });
});
