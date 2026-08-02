// Manifest-driven auto-generated panels: every input is a single-label
// jack + knob row, numeric params get generated knobs, values only appear
// in hover tooltips, wired inputs drop their knob, and jack clicks drive
// the wiring flow.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AdsrUI from '../../extensions/adsr/ui-src/AdsrUI';
import { ModulePanel } from '../src/components/ModulePanel';
import type { Manifest, ModuleHandle } from '../src/types';

const OSC_MANIFEST: Manifest = {
  id: 'com.dj.oscillator',
  name: 'Oscillator',
  version: '0.1.0',
  abi: 'wasm-1',
  inputs: [
    { id: 'pitch', name: 'Pitch', knob: { style: 'continuous', min: -5, max: 5, curve: 'linear' } },
    { id: 'fm', name: 'FM', knob: { style: 'continuous', min: -1, max: 1, curve: 'linear' } },
    { id: 'sync', name: 'Sync' },
  ],
  outputs: [{ id: 'audio', name: 'Audio' }],
  params: [{ id: 'waveform', name: 'Waveform', default: 0, min: 0, max: 3 }],
};

const HANDLE: ModuleHandle = {
  paramValue: () => 0.5,
  setParam: () => {},
  signalTap: () => ({ instantaneous: 0, rms_100ms: 0, display: 0, is_fast: false }),
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
          pitch: { instantaneous: 2, rms_100ms: 2, display: 2, is_fast: false },
          fm: { instantaneous: 0.1, rms_100ms: 3.54, display: 3.54, is_fast: true },
        }}
      />,
    );
    expect(screen.getByTestId('jack-input-pitch').getAttribute('title')).toBe('pitch: 2.00');
    expect(screen.getByTestId('jack-input-fm').getAttribute('title')).toBe('fm: 3.54 (rms)');
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

  it('a wired input keeps its jack but loses its knob dial', () => {
    render(<ModulePanel {...baseProps} wired={{ pitch: true }} />);
    expect(screen.getByTestId('jack-input-pitch')).toBeTruthy();
    expect(screen.queryByRole('slider', { name: 'pitch' })).toBeNull();
    // Unwired inputs keep theirs.
    expect(screen.getByRole('slider', { name: 'fm' })).toBeTruthy();
  });

  it('renders a generated knob per numeric param and reports edits', () => {
    const onParam = vi.fn();
    render(<ModulePanel {...baseProps} onParam={onParam} />);
    const dial = screen.getByRole('slider', { name: 'waveform' });
    fireEvent.mouseDown(dial, { clientY: 100 });
    fireEvent.mouseMove(window, { clientY: 100 - 150 }); // full-range drag up
    fireEvent.mouseUp(window);
    expect(onParam).toHaveBeenCalled();
    const [id, value] = onParam.mock.lastCall!;
    expect(id).toBe('waveform');
    expect(value).toBeCloseTo(3, 5); // max of the 0..3 param range
  });

  it('clicking jacks reports the wiring intent', () => {
    const onJackClick = vi.fn();
    render(<ModulePanel {...baseProps} onJackClick={onJackClick} />);
    fireEvent.click(screen.getByTestId('jack-output-audio'));
    expect(onJackClick).toHaveBeenCalledWith('output', 'audio');
    fireEvent.click(screen.getByTestId('jack-input-fm'));
    expect(onJackClick).toHaveBeenCalledWith('input', 'fm');
  });

  it('marks the pending wire source jack as selected', () => {
    render(<ModulePanel {...baseProps} pendingSource={{ instance: 'osc1', jack: 'audio' }} />);
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
});
