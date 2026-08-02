// Manifest-driven auto-generated panels: every input is jack + knob,
// outputs are jacks, telemetry drives the activation readouts, and the
// custom UI slot renders extension UIs.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
  params: [{ id: 'waveform', name: 'Waveform', default: 0 }],
};

const HANDLE: ModuleHandle = {
  paramValue: () => 0.5,
  setParam: () => {},
  signalTap: () => ({ instantaneous: 0, rms_100ms: 0, display: 0, is_fast: false }),
  size: { w: 300, h: 150 },
};

const noop = () => {};

describe('ModulePanel', () => {
  it('auto-generates a jack + knob for every input and a jack per output', () => {
    render(
      <ModulePanel
        instanceId="osc1"
        manifest={OSC_MANIFEST}
        knobs={{}}
        wired={{}}
        handle={HANDLE}
        onKnobPosition={noop}
        onKnobConfig={noop}
        onAttenOffset={noop}
      />,
    );
    for (const id of ['pitch', 'fm', 'sync']) {
      expect(screen.getByTestId(`jack-input-${id}`)).toBeTruthy();
      expect(screen.getByTestId(`knob-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId('jack-output-audio')).toBeTruthy();
  });

  it('shows telemetry readouts on jacks (instantaneous vs rms)', () => {
    render(
      <ModulePanel
        instanceId="osc1"
        manifest={OSC_MANIFEST}
        knobs={{}}
        wired={{}}
        telemetry={{
          pitch: { instantaneous: 2, rms_100ms: 2, display: 2, is_fast: false },
          fm: { instantaneous: 0.1, rms_100ms: 3.54, display: 3.54, is_fast: true },
        }}
        handle={HANDLE}
        onKnobPosition={noop}
        onKnobConfig={noop}
        onAttenOffset={noop}
      />,
    );
    expect(screen.getByTestId('jack-readout-pitch').textContent).toBe('2.00');
    expect(screen.getByTestId('jack-readout-fm').textContent).toBe('3.54 rms');
  });

  it('uses saved knob state and per-patch config overrides', () => {
    render(
      <ModulePanel
        instanceId="osc1"
        manifest={OSC_MANIFEST}
        knobs={{
          pitch: {
            position: 1,
            atten: 1,
            offset: 0,
            config: { style: 'continuous', min: 0, max: 2, curve: 'linear' },
          },
        }}
        wired={{}}
        handle={HANDLE}
        onKnobPosition={noop}
        onKnobConfig={noop}
        onAttenOffset={noop}
      />,
    );
    // Override endpoints (0..2) at position 1 -> value 2, not manifest's 5.
    expect(screen.getByTestId('knob-value-pitch').textContent).toBe('2.00');
  });

  it('renders a custom extension UI in the panel when provided', () => {
    render(
      <ModulePanel
        instanceId="adsr1"
        manifest={{ ...OSC_MANIFEST, id: 'com.dj.adsr', name: 'ADSR' }}
        knobs={{}}
        wired={{}}
        handle={HANDLE}
        customUI={AdsrUI}
        onKnobPosition={noop}
        onKnobConfig={noop}
        onAttenOffset={noop}
      />,
    );
    expect(screen.getByTestId('adsr-ui')).toBeTruthy();
  });
});
