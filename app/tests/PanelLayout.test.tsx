// Declarative panel layouts (panelLayouts.ts): per-module grouping and
// arrangement of input cells, jack-on-top-of-control cells, fader
// controls, and the normalization guarantee that every manifest jack
// renders exactly once even if a layout forgets or misnames it.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import GridSeqUI from '../../extensions/grid_seq/ui-src/GridSeqUI';
import StepSeqUI from '../../extensions/step_seq/ui-src/StepSeqUI';
import { ModulePanel } from '../src/components/ModulePanel';
import { resolveLayout } from '../src/components/panelLayouts';
import type { JackTelemetry, Manifest, ModuleHandle } from '../src/types';

const HANDLE: ModuleHandle = {
  paramValue: () => 0,
  setParam: () => {},
  signalTap: () => ({ instantaneous: 0, rms_100ms: 0, display: 0, volatility: 0, is_fast: false }),
  size: { w: 300, h: 150 },
};

const noop = () => {};

const tele = (display: number): JackTelemetry => ({
  instantaneous: display,
  rms_100ms: 0,
  display,
  volatility: 0,
  is_fast: false,
});

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

  it('groups outputs with titles (mult module)', () => {
    const m = manifest(
      'com.dj.mult',
      ['a_in', 'b_in'],
      ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4', 'merge', 's1', 's2', 's3', 's4'],
    );
    const layout = resolveLayout(m);
    expect(layout.outputGroups.map((g) => g.title)).toEqual(['a', 'b', 'merge', 'split']);
    const all = layout.outputGroups.flatMap((g) => g.outputs);
    expect(all).toHaveLength(13);
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

  // A level wired in override mode is set by the signal, not the fader:
  // the cap has to ride the incoming level instead of the inert baseline.
  it('a mixer level in override mode rides the wire, not its baseline', () => {
    const m = manifest('com.dj.mixer', ['lvl1', 'master'], ['out_l', 'out_r']);
    const capPct = () =>
      parseFloat(
        (screen.getByTestId('input-cell-lvl1').querySelector('.fader-cap') as HTMLElement).style
          .bottom,
      );
    const { rerender } = render(
      <ModulePanel
        {...baseProps}
        instanceId="mix1"
        manifest={m}
        knobs={{ lvl1: { position: 0.1, atten: 1, offset: 0, wire_style: 'override' } }}
        wired={{ lvl1: true }}
        telemetry={{ lvl1: tele(6) }}
      />,
    );
    expect(capPct()).toBeCloseTo(60, 3);
    // Back in CV mode the fader is the baseline again, wire or no wire.
    rerender(
      <ModulePanel
        {...baseProps}
        instanceId="mix1"
        manifest={m}
        knobs={{ lvl1: { position: 0.1, atten: 1, offset: 0, wire_style: 'cv' } }}
        wired={{ lvl1: true }}
        telemetry={{ lvl1: tele(6) }}
      />,
    );
    expect(capPct()).toBeCloseTo(10, 3);
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
      'com.dj.mult',
      ['a_in', 'b_in'],
      ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4', 'merge', 's1', 's2', 's3', 's4'],
    );
    render(<ModulePanel {...baseProps} instanceId="mult1" manifest={m} />);
    for (const id of ['a1', 'b4', 'merge', 's3']) {
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

  it('the single-channel attenuverter is one in->atten->offset->out row', () => {
    const m = manifest('com.dj.attenuverter1', ['in', 'atten', 'offset'], ['out']);
    const layout = resolveLayout(m);
    expect(layout.groups).toHaveLength(1);
    const g = layout.groups[0];
    expect(g.kind).toBe('row');
    expect(g.cells.map((c) => c.jack)).toEqual(['in', 'atten', 'offset', 'out']);
    expect(g.cells[3].output).toBe(true);
    expect(layout.outputGroups).toHaveLength(0);

    render(<ModulePanel {...baseProps} instanceId="att1" manifest={m} />);
    const out = screen.getByTestId('jack-output-out');
    const group = out.closest('.input-group');
    expect(group).toBeTruthy();
    expect(group!.querySelector('[data-jack="att1:input:in"]')).toBeTruthy();
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

// The grid sequencer's row outputs (out1..out8) render as a column beside
// the cell grid, one jack per grid row (output groups with `besideUI`);
// `pos` stays in the bottom strip.
describe('grid sequencer row-output alignment', () => {
  const gridSeqManifest = () => {
    const inputs = ['clock', 'reset'];
    for (let i = 1; i <= 8; i++) inputs.push(`row${i}`);
    inputs.push('level', 'mode');
    for (let i = 1; i <= 8; i++) inputs.push(`rata${i}`);
    for (let i = 1; i <= 8; i++) inputs.push(`ratb${i}`);
    const outputs = [];
    for (let i = 1; i <= 8; i++) outputs.push(`out${i}`);
    outputs.push('pos');
    return manifest('com.dj.grid_seq', inputs, outputs);
  };

  it('renders out1..out8 in a beside-UI column, in row order, pos in the strip', () => {
    render(
      <ModulePanel
        {...baseProps}
        instanceId="grid1"
        manifest={gridSeqManifest()}
        customUI={GridSeqUI}
      />,
    );
    const beside = document.querySelector<HTMLElement>('.custom-ui-with-outputs');
    expect(beside).toBeTruthy();
    // The grid UI and the jack column share the flex row.
    expect(beside!.querySelector('.gridseq-ui')).toBeTruthy();
    const col = beside!.querySelector<HTMLElement>('.beside-ui-outputs');
    expect(col).toBeTruthy();
    const jacks = [...col!.querySelectorAll('[data-jack]')].map((el) =>
      el.getAttribute('data-jack'),
    );
    expect(jacks).toEqual(Array.from({ length: 8 }, (_, i) => `grid1:output:out${i + 1}`));
    // pos stays in the bottom output strip, outside the beside column.
    const pos = screen.getByTestId('jack-output-pos');
    expect(pos.closest('.module-outputs')).toBeTruthy();
    expect(pos.closest('.beside-ui-outputs')).toBeNull();
  });

  it('falls back to the output strip when the panel has no custom UI', () => {
    render(<ModulePanel {...baseProps} instanceId="grid2" manifest={gridSeqManifest()} />);
    const out1 = screen.getByTestId('jack-output-out1');
    expect(out1.closest('.module-outputs')).toBeTruthy();
    expect(document.querySelector('.custom-ui-with-outputs')).toBeNull();
  });

  it('styles.css sizes the grid rows and the jack column from the same tokens', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    const rule = (selector: string) => {
      const m = css.match(new RegExp(`${selector.replace(/[.\s]/g, '\\$&')}\\s*{[^}]*}`));
      if (!m) throw new Error(`missing rule ${selector}`);
      return m[0];
    };
    // The flex row defines the row-pitch tokens...
    expect(rule('.custom-ui-with-outputs')).toContain('--ui-row-h:');
    expect(rule('.custom-ui-with-outputs')).toContain('--ui-row-gap:');
    // ...the grid cells and the jack column both consume them.
    expect(rule('.gridseq-ui .trigseq-cell')).toContain('height: var(--ui-row-h');
    expect(rule('.gridseq-ui')).toContain('gap: var(--ui-row-gap');
    expect(rule('.beside-ui-outputs .jack')).toContain('height: var(--ui-row-h');
    expect(rule('.beside-ui-outputs')).toContain('gap: var(--ui-row-gap');
  });
});

// A module that IS a piece of hardware draws its outputs as the controls
// they come off (`OutputGroupSpec.control`): the Launch Control XL's panel
// is six rows of eight — three of knobs, the faders, then the two button
// rows — each jack wearing a live readout of its own signal and labelled
// by its column number, so the panel reads like the surface.
describe('control-surface output readouts', () => {
  const ROWS = ['a', 'b', 'pan', 'fader', 'focus', 'ctrl'];
  const lcManifest = () => {
    const outputs: string[] = [];
    for (let c = 1; c <= 8; c++) for (const r of ROWS) outputs.push(`c${c}_${r}`);
    return manifest('builtin.launchcontrol', [], outputs);
  };

  it('lays the surface out as six eight-wide rows of knobs, faders and buttons', () => {
    const layout = resolveLayout(lcManifest());
    expect(layout.outputGroups.map((g) => g.control)).toEqual([
      'knob',
      'knob',
      'knob',
      'fader',
      'button',
      'button',
    ]);
    for (const g of layout.outputGroups) {
      expect(g.columns).toBe(8);
      // A row is one control ACROSS the surface, though the jack ids are
      // column-major (c1_a…c8_ctrl).
      expect(g.outputs).toHaveLength(8);
      // Columns are numbered on the panel; the ids stay in the tooltip.
      expect(g.outputs.map((id) => g.labels?.[id])).toEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
      ]);
    }
    expect(layout.outputGroups[0].outputs[0]).toBe('c1_a');
    expect(layout.outputGroups[3].outputs[7]).toBe('c8_fader');
    // Every jack of the surface is rendered exactly once.
    expect(layout.outputGroups.flatMap((g) => g.outputs)).toHaveLength(48);
  });

  it('draws each control at its live value', () => {
    render(
      <ModulePanel
        {...baseProps}
        instanceId="lcxl1"
        manifest={lcManifest()}
        telemetry={{
          'out:c1_a': tele(10), // knob fully clockwise
          'out:c2_a': tele(5), // knob at noon
          'out:c1_fader': tele(2.5), // fader a quarter up
          'out:c1_focus': tele(10), // button held
          'out:c2_focus': tele(0), // button up
        }}
      />,
    );
    // Knobs: 0..10 V over the dial's own −135°…+135° sweep.
    expect(screen.getByTestId('jack-readout-c1_a').getAttribute('data-level')).toBe('1.000');
    expect(
      screen.getByTestId('jack-readout-c1_a').querySelector<HTMLElement>('.jack-readout-pointer')!
        .style.transform,
    ).toBe('rotate(135deg)');
    expect(
      screen.getByTestId('jack-readout-c2_a').querySelector<HTMLElement>('.jack-readout-pointer')!
        .style.transform,
    ).toBe('rotate(0deg)');
    // An untouched control sits at the bottom of its travel, not blank.
    expect(screen.getByTestId('jack-readout-c3_a').getAttribute('data-level')).toBe('0.000');

    // Faders: the cap rides the track.
    const fader = screen.getByTestId('jack-readout-c1_fader');
    expect(fader.getAttribute('class')).toContain('jack-readout-fader');
    expect(fader.querySelector<HTMLElement>('.jack-readout-cap')!.style.bottom).toBe('25%');

    // Buttons: a pad lit while the gate is high (>= 1 V), dark otherwise.
    expect(screen.getByTestId('jack-readout-c1_focus').getAttribute('data-on')).toBe('yes');
    expect(screen.getByTestId('jack-readout-c1_focus').getAttribute('class')).toContain(
      'jack-readout-pad-on',
    );
    expect(screen.getByTestId('jack-readout-c2_focus').getAttribute('data-on')).toBe('no');
    expect(screen.getByTestId('jack-readout-c2_focus').getAttribute('class')).not.toContain(
      'jack-readout-pad-on',
    );
  });

  it('follows the display reading, the one the rack store propagates', () => {
    // `instantaneous` is excluded from the store's per-jack equality check
    // (rackStore.jackTelemetryEqual), so a readout reading it would only
    // ever update by coincidence.
    render(
      <ModulePanel
        {...baseProps}
        instanceId="lcxl1"
        manifest={lcManifest()}
        telemetry={{
          'out:c1_focus': { ...tele(0), instantaneous: 10 },
          'out:c1_a': { ...tele(0), instantaneous: 10 },
        }}
      />,
    );
    expect(screen.getByTestId('jack-readout-c1_focus').getAttribute('data-on')).toBe('no');
    expect(screen.getByTestId('jack-readout-c1_a').getAttribute('data-level')).toBe('0.000');
  });

  it('leaves the jack itself a jack: labels, tooltips and wiring clicks', () => {
    const clicks: string[] = [];
    render(
      <ModulePanel
        {...baseProps}
        instanceId="lcxl1"
        manifest={lcManifest()}
        telemetry={{ 'out:c3_pan': tele(7.5) }}
        onJackClick={(_kind, jack) => clicks.push(jack)}
      />,
    );
    const jack = screen.getByTestId('jack-output-c3_pan');
    expect(jack.querySelector('.jack-name')!.textContent).toBe('3');
    // The id (and its value) stay one hover away.
    expect(jack.getAttribute('data-tip')).toContain('c3_pan');
    // The readout is decoration inside the jack button: a press on it is
    // still a press on the jack, which is how a wire gets made.
    fireEvent.click(screen.getByTestId('jack-readout-c3_pan'));
    expect(clicks).toEqual(['c3_pan']);
  });

  it('ordinary modules keep plain output jacks', () => {
    render(
      <ModulePanel
        {...baseProps}
        instanceId="lfo1"
        manifest={manifest('com.dj.lfo', [], ['bi'])}
      />,
    );
    expect(screen.queryByTestId('jack-readout-bi')).toBeNull();
    expect(screen.getByTestId('jack-output-bi').getAttribute('class')).not.toContain(
      'jack-with-readout',
    );
    expect(document.querySelector('.output-group-surface')).toBeNull();
  });

  it('styles.css gives readout cells one fixed width so the rows line up', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    const rule = (selector: string) => {
      const m = css.match(new RegExp(`${selector.replace(/[.\s]/g, '\\$&')}\\s*{[^}]*}`));
      if (!m) throw new Error(`missing rule ${selector}`);
      return m[0];
    };
    expect(rule('.jack-with-readout')).toContain('width: 40px');
    // ...including inside the output strip, which otherwise frees jack
    // widths (`.module-outputs .jack { width: auto }`).
    expect(rule('.module-outputs .jack-with-readout')).toContain('width: 40px');
  });
});
