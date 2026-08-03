// App-level wiring flow against a mocked engine bridge: click an output
// jack then an input jack to connect, click a wired input to disconnect,
// and add modules from the library sidebar.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../src/types';

const OSC: Manifest = {
  id: 'com.dj.oscillator',
  name: 'Oscillator',
  version: '0.1.0',
  abi: 'wasm-1',
  inputs: [{ id: 'pitch', name: 'Pitch' }],
  outputs: [{ id: 'audio', name: 'Audio' }],
  params: [],
};

const VCA: Manifest = {
  id: 'com.dj.vca',
  name: 'VCA',
  version: '0.1.0',
  abi: 'wasm-1',
  inputs: [
    { id: 'in', name: 'In' },
    { id: 'cv', name: 'CV' },
  ],
  outputs: [{ id: 'out', name: 'Out' }],
  params: [],
};

const state = {
  nodes: [] as unknown[],
  wires: [] as unknown[],
};

const fakeEngine = {
  loadDemoPatch: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  listModules: vi.fn(async () => [OSC, VCA]),
  nodes: vi.fn(async () => state.nodes),
  wires: vi.fn(async () => state.wires),
  tap: vi.fn(async () => null),
  addModule: vi.fn(async () => {}),
  connectWire: vi.fn(async () => {}),
  disconnectWire: vi.fn(async () => {}),
  setParam: vi.fn(async () => {}),
  setKnobPosition: vi.fn(async () => {}),
  setKnobConfig: vi.fn(async () => {}),
  setAttenOffset: vi.fn(async () => {}),
};

vi.mock('../src/engine', () => ({
  engine: new Proxy({}, { get: (_t, prop) => fakeEngine[prop as keyof typeof fakeEngine] }),
}));

import App from '../src/App';

function node(instance: string, manifest: Manifest, wired: string[] = []) {
  return {
    instance_id: instance,
    type_id: manifest.id,
    manifest,
    knobs: {},
    params: {},
    wired_inputs: wired,
    midi_mappings: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  state.nodes = [node('osc1', OSC), node('vca1', VCA)];
  state.wires = [];
});

describe('App wiring flow', () => {
  it('output click arms a pending wire, input click connects it', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('jack-output-audio'));
    expect(screen.getByTestId('wiring-hint').textContent).toContain('osc1:audio');

    fireEvent.click(screen.getByTestId('jack-input-in'));
    await waitFor(() =>
      expect(fakeEngine.connectWire).toHaveBeenCalledWith(
        { instance: 'osc1', jack: 'audio' },
        { instance: 'vca1', jack: 'in' },
      ),
    );
    await waitFor(() => expect(screen.queryByTestId('wiring-hint')).toBeNull());
  });

  it('re-clicking the armed jack cycles the cable color; escape cancels', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('jack-output-audio'));
    const swatch = () => screen.getByTestId('wire-color-swatch').style.background;
    const first = swatch();
    fireEvent.click(screen.getByTestId('jack-output-audio'));
    const second = swatch();
    expect(second).not.toBe(first);
    // 8 colors: seven more clicks wraps back to the first.
    for (let i = 0; i < 7; i++) fireEvent.click(screen.getByTestId('jack-output-audio'));
    expect(swatch()).toBe(first);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('wiring-hint')).toBeNull();
    expect(fakeEngine.connectWire).not.toHaveBeenCalled();
  });

  it('input-first wiring: click an input jack, then an output jack', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('jack-input-in'));
    expect(screen.getByTestId('wiring-hint').textContent).toContain('vca1:in');
    expect(screen.getByTestId('wiring-hint').textContent).toContain('output');
    fireEvent.click(screen.getByTestId('jack-output-audio'));
    await waitFor(() =>
      expect(fakeEngine.connectWire).toHaveBeenCalledWith(
        { instance: 'osc1', jack: 'audio' },
        { instance: 'vca1', jack: 'in' },
      ),
    );
    await waitFor(() => expect(screen.queryByTestId('wiring-hint')).toBeNull());
  });

  it('the chosen color persists per wire and becomes the default', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('jack-output-audio'));
    fireEvent.click(screen.getByTestId('jack-output-audio')); // color 1
    fireEvent.click(screen.getByTestId('jack-input-in'));
    await waitFor(() => expect(fakeEngine.connectWire).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem('dj-wire-colors') ?? '{}')).toEqual({
      'osc1:audio->vca1:in': 1,
    });
    expect(JSON.parse(localStorage.getItem('dj-wire-last-color') ?? '0')).toBe(1);
    // Arming the next wire starts from the last used color.
    fireEvent.click(screen.getByTestId('jack-output-audio'));
    const swatch = screen.getByTestId('wire-color-swatch');
    expect(swatch.style.background).toBeTruthy();
  });

  it('clicking a wired input with nothing pending disconnects it', async () => {
    state.nodes = [node('osc1', OSC), node('vca1', VCA, ['in'])];
    state.wires = [
      { from_instance: 'osc1', from_jack: 'audio', to_instance: 'vca1', to_jack: 'in' },
    ];
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-vca1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('jack-input-in'));
    await waitFor(() =>
      expect(fakeEngine.disconnectWire).toHaveBeenCalledWith(
        { instance: 'osc1', jack: 'audio' },
        { instance: 'vca1', jack: 'in' },
      ),
    );
  });

  it('adding a module from the library generates a fresh instance id', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-library')).toBeTruthy());
    fireEvent.click(screen.getByTestId('library-add-com.dj.oscillator'));
    await waitFor(() =>
      // osc1 is taken by the existing node's instance id namespace; the
      // generator only avoids ids in use ("oscillat" prefix is free).
      expect(fakeEngine.addModule).toHaveBeenCalledWith('oscillat1', 'com.dj.oscillator'),
    );
  });
});
