// Manifest-driven auto-generated panels: every input is a single-label
// jack + knob row (no special-cased params), values only appear in hover
// tooltips, wired inputs keep their knob (baseline + spread), and jack clicks drive the
// wiring flow.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdsrUI from '../../extensions/adsr/ui-src/AdsrUI';
import { ModulePanel, snapUpToGrid } from '../src/components/ModulePanel';
import type { Manifest, ModuleHandle } from '../src/types';

const OSC_MANIFEST: Manifest = {
  id: 'com.dj.oscillator',
  name: 'Oscillator',
  version: '0.1.0',
  abi: 'wasm-1',
  inputs: [
    {
      id: 'pitch',
      name: 'Pitch',
      knob: { style: 'continuous', min: -5, max: 5, curve: 'linear' },
      display: { unit: 'Hz', map: { kind: 'volt_per_octave' } },
    },
    { id: 'fm', name: 'FM', knob: { style: 'continuous', min: -1, max: 1, curve: 'linear' } },
    { id: 'sync', name: 'Sync' },
    {
      id: 'waveform',
      name: 'Waveform',
      knob: { style: 'stepped', min: 0, max: 3, curve: 'linear', steps: 4 },
      display: { steps: ['sine', 'saw', 'square', 'tri'] },
    },
  ],
  outputs: [{ id: 'audio', name: 'Audio', display: { unit: 'Hz' } }],
  params: [],
};

const HANDLE: ModuleHandle = {
  paramValue: () => 0.5,
  setParam: () => {},
  signalTap: () => ({ instantaneous: 0, rms_100ms: 0, display: 0, volatility: 0, is_fast: false }),
  size: { w: 300, h: 150 },
};

const noop = () => {};

const baseProps = {
  instanceId: 'osc1',
  manifest: OSC_MANIFEST,
  knobs: {},
  wired: {},
  handle: HANDLE,
  onKnobPosition: noop,
  onKnobConfig: noop,
  onAttenOffset: noop,
};

describe('ModulePanel', () => {
  it('auto-generates a jack + knob for every input and a jack per output', () => {
    render(<ModulePanel {...baseProps} />);
    for (const id of ['pitch', 'fm', 'sync']) {
      expect(screen.getByTestId(`jack-input-${id}`)).toBeTruthy();
      expect(screen.getByTestId(`knob-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId('jack-output-audio')).toBeTruthy();
  });

  it('shows exactly one label per input and no inline values', () => {
    render(<ModulePanel {...baseProps} />);
    expect(screen.getAllByText('pitch')).toHaveLength(1);
    expect(screen.getAllByText('fm')).toHaveLength(1);
    // Values are tooltip-only.
    expect(screen.queryByText(/^-?\d+\.\d\d$/)).toBeNull();
  });

  it('puts telemetry in the jack hover tooltip (instantaneous vs rms)', () => {
    render(
      <ModulePanel
        {...baseProps}
        telemetry={{
          pitch: { instantaneous: 2, rms_100ms: 2, display: 2, volatility: 0, is_fast: false },
          fm: { instantaneous: 0.1, rms_100ms: 3.54, display: 3.54, volatility: 0, is_fast: true },
        }}
      />,
    );
    // pitch declares a 1 V/oct Hz display: 2 V above middle C = 1046.5 Hz.
    expect(screen.getByTestId('jack-input-pitch').getAttribute('data-tip')).toBe('pitch: 1047 Hz');
    // fm declares nothing: Volts is the default unit.
    expect(screen.getByTestId('jack-input-fm').getAttribute('data-tip')).toBe('fm: 3.54 V (rms)');
  });

  it('stepped inputs with labels show the step name inline and in tooltips', () => {
    render(
      <ModulePanel
        {...baseProps}
        knobs={{ waveform: { position: 1, atten: 1, offset: 0 } }}
        telemetry={{
          waveform: { instantaneous: 3, rms_100ms: 3, display: 3, volatility: 0, is_fast: false },
        }}
      />,
    );
    expect(screen.getByTestId('knob-step-waveform').textContent).toBe('tri');
    expect(screen.getByRole('slider', { name: 'waveform' }).getAttribute('data-tip')).toBe(
      'waveform: tri',
    );
    expect(screen.getByTestId('jack-input-waveform').getAttribute('data-tip')).toBe(
      'waveform: tri',
    );
  });

  it('shows output-jack telemetry in the tooltip, same as inputs', () => {
    render(
      <ModulePanel
        {...baseProps}
        telemetry={{
          'out:audio': {
            instantaneous: 1,
            rms_100ms: 3.5,
            display: 3.5,
            volatility: 0,
            is_fast: true,
          },
        }}
      />,
    );
    // The output declares Hz: same formatter as inputs, its unit applied.
    expect(screen.getByTestId('jack-output-audio').getAttribute('data-tip')).toBe(
      'audio: 3.50 Hz (rms)',
    );
  });

  it('uses saved knob state and per-patch config overrides', () => {
    render(
      <ModulePanel
        {...baseProps}
        knobs={{
          pitch: {
            position: 1,
            atten: 1,
            offset: 0,
            config: { style: 'continuous', min: 0, max: 2, curve: 'linear' },
          },
        }}
      />,
    );
    // Override endpoints (0..2) at position 1 -> value 2, not manifest's 5.
    const dial = screen.getByRole('slider', { name: 'pitch' });
    expect(dial.getAttribute('aria-valuenow')).toBe('2');
  });

  it('a wired input keeps its knob and gains a spread arc', () => {
    render(<ModulePanel {...baseProps} wired={{ pitch: true }} />);
    expect(screen.getByTestId('jack-input-pitch')).toBeTruthy();
    // The knob is the baseline the incoming signal adds to, so it stays.
    expect(screen.getByRole('slider', { name: 'pitch' })).toBeTruthy();
    expect(screen.getByTestId('knob-spread-pitch')).toBeTruthy();
    // Unwired inputs have no spread to show.
    expect(screen.getByRole('slider', { name: 'fm' })).toBeTruthy();
    expect(screen.queryByTestId('knob-spread-fm')).toBeNull();
  });

  it('renders formerly-special inputs (waveform) as ordinary jack + knob rows', () => {
    const onKnobPosition = vi.fn();
    render(<ModulePanel {...baseProps} onKnobPosition={onKnobPosition} />);
    // Wireable like any other input.
    expect(screen.getByTestId('jack-input-waveform')).toBeTruthy();
    const dial = screen.getByRole('slider', { name: 'waveform' });
    fireEvent.mouseDown(dial, { clientY: 100 });
    fireEvent.mouseMove(window, { clientY: 100 - 150 }); // full-range drag up
    fireEvent.mouseUp(window);
    expect(onKnobPosition).toHaveBeenCalled();
    const [id, position] = onKnobPosition.mock.lastCall!;
    expect(id).toBe('waveform');
    expect(position).toBeCloseTo(1, 5); // knob position, mapped by config
  });

  it('clicking jacks reports the wiring intent', () => {
    const onJackClick = vi.fn();
    render(<ModulePanel {...baseProps} onJackClick={onJackClick} />);
    fireEvent.click(screen.getByTestId('jack-output-audio'));
    expect(onJackClick).toHaveBeenCalledWith('output', 'audio', false);
    fireEvent.click(screen.getByTestId('jack-input-fm'));
    expect(onJackClick).toHaveBeenCalledWith('input', 'fm', false);
  });

  it('marks the pending wire source jack as selected', () => {
    render(
      <ModulePanel
        {...baseProps}
        pendingSource={{ instance: 'osc1', jack: 'audio', kind: 'output' }}
      />,
    );
    expect(screen.getByTestId('jack-output-audio').className).toContain('jack-selected');
  });

  it('renders a custom extension UI in the panel when provided', () => {
    render(
      <ModulePanel
        {...baseProps}
        instanceId="adsr1"
        manifest={{ ...OSC_MANIFEST, id: 'com.dj.adsr', name: 'ADSR' }}
        customUI={AdsrUI}
      />,
    );
    expect(screen.getByTestId('adsr-ui')).toBeTruthy();
  });

  it('differentiates input and output jacks visually', () => {
    render(<ModulePanel {...baseProps} />);
    expect(screen.getByTestId('jack-input-pitch').className).toContain('jack-input');
    expect(screen.getByTestId('jack-output-audio').className).toContain('jack-output');
  });

  it('positions the panel and drags it on the coarse 48px grid', () => {
    const onMove = vi.fn();
    render(<ModulePanel {...baseProps} position={{ x: 96, y: 48 }} onMove={onMove} />);
    const panel = screen.getByTestId('module-osc1');
    expect(panel.className).toContain('module-panel-placed');
    expect(panel.style.left).toBe('96px');
    expect(panel.style.top).toBe('48px');

    const header = screen.getByTestId('module-header-osc1');
    fireEvent.mouseDown(header, { button: 0, clientX: 200, clientY: 200 });
    // 130px right, 40px down from (96, 48) → raw (226, 88) → snapped (240, 96)
    fireEvent.mouseMove(window, { clientX: 330, clientY: 240 });
    expect(onMove).toHaveBeenLastCalledWith(240, 96);
    // after mouseup further moves are ignored
    fireEvent.mouseUp(window);
    onMove.mockClear();
    fireEvent.mouseMove(window, { clientX: 400, clientY: 400 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('drags freely past the origin (infinite canvas: negative coords)', () => {
    const onMove = vi.fn();
    render(<ModulePanel {...baseProps} position={{ x: 0, y: 0 }} onMove={onMove} />);
    fireEvent.mouseDown(screen.getByTestId('module-header-osc1'), {
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.mouseMove(window, { clientX: 0, clientY: 0 });
    expect(onMove).toHaveBeenLastCalledWith(-96, -96);
  });
});

describe('grid-conforming panel size', () => {
  it('snapUpToGrid rounds content sizes up to whole 48px cells', () => {
    expect(snapUpToGrid(1)).toBe(48);
    expect(snapUpToGrid(48)).toBe(48);
    expect(snapUpToGrid(49)).toBe(96);
    expect(snapUpToGrid(205)).toBe(240);
  });

  const observers: Array<() => void> = [];
  class FakeRO {
    constructor(cb: () => void) {
      observers.push(cb);
    }
    observe() {}
    disconnect() {}
  }

  afterEach(() => {
    observers.length = 0;
    // @ts-expect-error test polyfill cleanup
    delete globalThis.ResizeObserver;
  });

  it('sets panel width/height to grid multiples of the measured content', () => {
    // jsdom has no ResizeObserver; install a stub so the measure effect runs.
    (globalThis as Record<string, unknown>).ResizeObserver = FakeRO;
    const { container } = render(<ModulePanel {...baseProps} />);
    const content = container.querySelector('.module-panel-content') as HTMLElement;
    Object.defineProperty(content, 'offsetWidth', { configurable: true, value: 205 });
    Object.defineProperty(content, 'offsetHeight', { configurable: true, value: 150 });
    act(() => observers.forEach((cb) => cb()));
    const panel = screen.getByTestId('module-osc1');
    expect(panel.style.width).toBe(`${snapUpToGrid(205 + 2)}px`); // 240
    expect(panel.style.height).toBe(`${snapUpToGrid(150 + 2)}px`); // 192
  });

  it('renders a delete button only when onRemove is provided', () => {
    const { rerender } = render(<ModulePanel {...baseProps} />);
    expect(screen.queryByTestId('module-remove-osc1')).toBeNull();
    const onRemove = vi.fn();
    rerender(<ModulePanel {...baseProps} onRemove={onRemove} />);
    fireEvent.click(screen.getByTestId('module-remove-osc1'));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('renders a ? docs button in the title bar only when onDocs is provided', () => {
    const { rerender } = render(<ModulePanel {...baseProps} />);
    expect(screen.queryByTestId('module-docs-osc1')).toBeNull();
    const onDocs = vi.fn();
    rerender(<ModulePanel {...baseProps} onDocs={onDocs} />);
    fireEvent.click(screen.getByTestId('module-docs-osc1'));
    expect(onDocs).toHaveBeenCalledTimes(1);
  });
});

describe('module rename', () => {
  it('shows only the display name in the title bar (no type text)', () => {
    render(<ModulePanel {...baseProps} displayName="Wobble LFO" />);
    expect(screen.getByTestId('module-name-osc1').textContent).toBe('Wobble LFO');
    expect(screen.getByTestId('module-header-osc1').textContent).not.toContain('Oscillator');
  });

  it('falls back to the instance id when no display name is set', () => {
    render(<ModulePanel {...baseProps} />);
    expect(screen.getByTestId('module-name-osc1').textContent).toBe('osc1');
  });

  it('double-click edits; Enter commits the typed name', () => {
    const onRename = vi.fn();
    render(<ModulePanel {...baseProps} onRename={onRename} />);
    fireEvent.doubleClick(screen.getByTestId('module-name-osc1'));
    const input = screen.getByTestId('module-rename-osc1') as HTMLInputElement;
    expect(input.value).toBe('osc1');
    fireEvent.change(input, { target: { value: 'Main Osc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('Main Osc');
    // Editor closed again.
    expect(screen.queryByTestId('module-rename-osc1')).toBeNull();
  });

  it('Escape cancels without renaming; unchanged/empty commits are no-ops', () => {
    const onRename = vi.fn();
    render(<ModulePanel {...baseProps} onRename={onRename} />);
    fireEvent.doubleClick(screen.getByTestId('module-name-osc1'));
    let input = screen.getByTestId('module-rename-osc1') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Something Else' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByTestId('module-rename-osc1')).toBeNull();
    // Committing the unchanged name is a no-op.
    fireEvent.doubleClick(screen.getByTestId('module-name-osc1'));
    input = screen.getByTestId('module-rename-osc1') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).not.toHaveBeenCalled();
    // As is committing whitespace only.
    fireEvent.doubleClick(screen.getByTestId('module-name-osc1'));
    input = screen.getByTestId('module-rename-osc1') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(onRename).not.toHaveBeenCalled();
  });

  it('without onRename the name is inert (docs previews)', () => {
    render(<ModulePanel {...baseProps} />);
    fireEvent.doubleClick(screen.getByTestId('module-name-osc1'));
    expect(screen.queryByTestId('module-rename-osc1')).toBeNull();
  });
});

describe('input jack colors', () => {
  it('a chosen color renders a border on the input cell; none by default', () => {
    const { rerender } = render(<ModulePanel {...baseProps} />);
    const cell = screen.getByTestId('input-cell-pitch');
    expect(cell.classList.contains('input-cell-colored')).toBe(false);
    expect(cell.style.borderColor).toBe('');
    rerender(<ModulePanel {...baseProps} inputColors={{ pitch: 1 }} />);
    expect(cell.classList.contains('input-cell-colored')).toBe(true);
    expect(cell.style.borderColor).toBe('rgb(224, 92, 92)'); // WIRE_COLORS[1] = #e05c5c
    // Other inputs stay uncolored.
    expect(screen.getByTestId('input-cell-fm').classList.contains('input-cell-colored')).toBe(
      false,
    );
  });

  it('knob config menu offers the wire colors plus none and reports the pick', () => {
    const onInputColor = vi.fn();
    render(<ModulePanel {...baseProps} onInputColor={onInputColor} />);
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'pitch' }));
    const swatches = screen.getAllByRole('radio');
    expect(swatches).toHaveLength(9); // none + the 8 wire colors
    // Default is none.
    expect(screen.getByRole('radio', { name: 'no color' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('radio', { name: 'color 3' }));
    expect(onInputColor).toHaveBeenCalledWith('pitch', 2);
  });

  it('clicking none clears the color', () => {
    const onInputColor = vi.fn();
    render(<ModulePanel {...baseProps} inputColors={{ pitch: 2 }} onInputColor={onInputColor} />);
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'pitch' }));
    expect(screen.getByRole('radio', { name: 'color 3' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('radio', { name: 'no color' }));
    expect(onInputColor).toHaveBeenCalledWith('pitch', null);
  });

  it('right-click on a jack-only input opens a color-only menu', () => {
    const onInputColor = vi.fn();
    render(<ModulePanel {...baseProps} onInputColor={onInputColor} />);
    // 'sync' declares no knob: right-click the cell itself.
    fireEvent.contextMenu(screen.getByTestId('input-cell-sync'));
    // Color-only: swatches present, knob fields absent.
    expect(screen.queryByLabelText('knob style')).toBeNull();
    expect(screen.queryByLabelText('knob value')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'color 1' }));
    expect(onInputColor).toHaveBeenCalledWith('sync', 0);
  });

  it('without onInputColor no color picker renders', () => {
    render(<ModulePanel {...baseProps} />);
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'pitch' }));
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

describe('custom input labels', () => {
  it('a custom label replaces the default text; others keep theirs', () => {
    const { rerender } = render(<ModulePanel {...baseProps} />);
    expect(screen.getByTestId('input-cell-pitch').textContent).toContain('pitch');
    rerender(<ModulePanel {...baseProps} inputLabels={{ pitch: 'bass note' }} />);
    expect(screen.getByTestId('input-cell-pitch').textContent).toContain('bass note');
    expect(screen.getByTestId('input-cell-fm').textContent).toContain('fm');
  });

  it('config menu Label field commits on Enter; empty clears back to default', () => {
    const onInputLabel = vi.fn();
    render(<ModulePanel {...baseProps} onInputLabel={onInputLabel} />);
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'pitch' }));
    const field = screen.getByLabelText('jack label') as HTMLInputElement;
    // Default label surfaces as the placeholder, not as text to edit.
    expect(field.placeholder).toBe('pitch');
    expect(field.value).toBe('');
    fireEvent.change(field, { target: { value: 'bass note' } });
    expect(onInputLabel).not.toHaveBeenCalled(); // not while typing
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onInputLabel).toHaveBeenCalledWith('pitch', 'bass note');
    // Clearing the field reverts to the default.
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.blur(field);
    expect(onInputLabel).toHaveBeenLastCalledWith('pitch', null);
  });

  it('Escape cancels the draft without committing', () => {
    const onInputLabel = vi.fn();
    render(
      <ModulePanel {...baseProps} inputLabels={{ pitch: 'old' }} onInputLabel={onInputLabel} />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'pitch' }));
    const field = screen.getByLabelText('jack label') as HTMLInputElement;
    expect(field.value).toBe('old');
    fireEvent.change(field, { target: { value: 'typo' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field.value).toBe('old');
    fireEvent.blur(field);
    expect(onInputLabel).not.toHaveBeenCalled();
  });

  it('jack-only inputs get the Label field in their color-only menu', () => {
    const onInputLabel = vi.fn();
    render(<ModulePanel {...baseProps} onInputColor={() => {}} onInputLabel={onInputLabel} />);
    fireEvent.contextMenu(screen.getByTestId('input-cell-sync'));
    const field = screen.getByLabelText('jack label');
    fireEvent.change(field, { target: { value: 'clock in' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onInputLabel).toHaveBeenCalledWith('sync', 'clock in');
  });

  it('without onInputLabel no Label field renders', () => {
    render(<ModulePanel {...baseProps} />);
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'pitch' }));
    expect(screen.queryByLabelText('jack label')).toBeNull();
  });
});
