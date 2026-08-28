// The rack's half of module bypass: the title-bar toggle calls the
// engine and the refreshed snapshot is what paints the panel red — the UI
// never guesses the state locally.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../src/types';

const DELAY: Manifest = {
  id: 'com.dj.delay',
  name: 'Delay',
  version: '0.1.0',
  abi: 'wasm-1',
  inputs: [
    { id: 'in_l', name: 'In L' },
    { id: 'in_r', name: 'In R' },
  ],
  outputs: [
    { id: 'out_l', name: 'Out L' },
    { id: 'out_r', name: 'Out R' },
  ],
  params: [],
  bypass: { out_l: 'in_l', out_r: 'in_r' },
};

const OSC: Manifest = {
  id: 'com.dj.oscillator',
  name: 'Oscillator',
  version: '0.1.0',
  abi: 'wasm-1',
  inputs: [{ id: 'pitch', name: 'Pitch' }],
  outputs: [{ id: 'audio', name: 'Audio' }],
  params: [],
};

const bypassed = { value: false };

const nodes = () => [
  {
    instance_id: 'osc-1',
    type_id: OSC.id,
    manifest: OSC,
    knobs: {},
    params: {},
    wired_inputs: [],
    midi_mappings: [],
    midi_led_mappings: [],
  },
  {
    instance_id: 'dly-1',
    type_id: DELAY.id,
    manifest: DELAY,
    knobs: {},
    params: {},
    wired_inputs: [],
    midi_mappings: [],
    midi_led_mappings: [],
    bypassed: bypassed.value,
  },
];

const fakeEngine = {
  loadDemoPatch: vi.fn(async () => {}),
  start: vi.fn(async () => 'null'),
  listModules: vi.fn(async () => [OSC, DELAY]),
  nodes: vi.fn(async () => nodes()),
  wires: vi.fn(async () => []),
  tap: vi.fn(async () => null),
  tapAll: vi.fn(async () => ({})),
  macroGroups: vi.fn(async () => []),
  macroLayout: vi.fn(async () => ({})),
  currentPatch: vi.fn(async () => null),
  listPatches: vi.fn(async () => []),
  endEdit: vi.fn(async () => {}),
  syncPositions: vi.fn(async () => {}),
  setModuleBypass: vi.fn(async (_instance: string, bypass: boolean) => {
    bypassed.value = bypass;
  }),
};

vi.mock('../src/engine', () => ({
  engine: new Proxy(
    {},
    { get: (_t, prop) => fakeEngine[prop as keyof typeof fakeEngine] ?? vi.fn(async () => null) },
  ),
  onMenuAction: () => () => {},
}));

import App from '../src/App';

describe('rack bypass toggle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    bypassed.value = false;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function tick(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('bypasses through the engine and shows the state the engine reports', async () => {
    render(<App />);
    await tick(0);
    await tick(100);

    // Only the module that declares routes offers the toggle.
    expect(screen.queryByTestId('module-bypass-osc-1')).toBeNull();
    const toggle = screen.getByTestId('module-bypass-dly-1');
    expect(screen.getByTestId('module-dly-1').dataset.bypassed).toBeUndefined();

    fireEvent.click(toggle);
    await tick(0);
    expect(fakeEngine.setModuleBypass).toHaveBeenCalledWith('dly-1', true);
    expect(screen.getByTestId('module-dly-1').dataset.bypassed).toBe('true');

    fireEvent.click(screen.getByTestId('module-bypass-dly-1'));
    await tick(0);
    expect(fakeEngine.setModuleBypass).toHaveBeenLastCalledWith('dly-1', false);
    expect(screen.getByTestId('module-dly-1').dataset.bypassed).toBeUndefined();
  });
});
