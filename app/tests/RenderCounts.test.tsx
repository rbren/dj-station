// Rendering-efficiency invariants (the contract rackStore's per-jack
// identity + LiveJack subscriptions exist to provide): a telemetry tick
// NEVER re-renders a ModulePanel — not even the panel whose jack moved.
// Only the moved jack itself re-renders (its glow/tooltip update), and a
// visually-unchanged tick re-renders nothing at all. If these break, every
// 100 ms tap_all poll re-renders whole panels and large racks get choppy —
// see src/stress/ for the interactive harness that measures the same path
// in real time.

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JackTelemetry, Manifest } from '../src/types';

const OSC: Manifest = {
  id: 'com.dj.oscillator',
  name: 'Oscillator',
  version: '0.1.0',
  abi: 'wasm-1',
  inputs: [{ id: 'pitch', name: 'Pitch' }],
  outputs: [{ id: 'audio', name: 'Audio' }],
  params: [],
};

// Real VCA type id: RackModule mounts its custom UI (the meterUI level
// meters), which must stay live through CustomUIHost's subscription even
// though the panel itself no longer re-renders on telemetry ticks.
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

function node(instance: string, manifest: Manifest) {
  return {
    instance_id: instance,
    type_id: manifest.id,
    manifest,
    knobs: {},
    params: {},
    wired_inputs: [],
    midi_mappings: [],
    midi_led_mappings: [],
  };
}

function tele(display: number): JackTelemetry {
  return { instantaneous: display, rms_100ms: 0, display, volatility: 0, is_fast: false };
}

// Output jacks are keyed `out:<id>` in tap_all responses.
const state = {
  nodes: [node('osc-1', OSC), node('osc-2', OSC), node('vca-1', VCA)],
  telemetry: {
    'osc-1': { pitch: tele(0), 'out:audio': tele(1) },
    'osc-2': { pitch: tele(0), 'out:audio': tele(2) },
    'vca-1': { in: tele(0), cv: tele(0), 'out:out': tele(3) },
  } as Record<string, Record<string, JackTelemetry>>,
};

const fakeEngine = {
  loadDemoPatch: vi.fn(async () => {}),
  start: vi.fn(async () => 'null'),
  listModules: vi.fn(async () => [OSC, VCA]),
  nodes: vi.fn(async () => state.nodes),
  wires: vi.fn(async () => []),
  tap: vi.fn(async () => null),
  // Fresh outer + inner objects each tick, like a real IPC response — the
  // store must rely on VALUE comparison, not reference luck.
  tapAll: vi.fn(async () =>
    Object.fromEntries(Object.entries(state.telemetry).map(([id, jacks]) => [id, { ...jacks }])),
  ),
  currentPatch: vi.fn(async () => null),
  listPatches: vi.fn(async () => []),
  endEdit: vi.fn(async () => {}),
};

vi.mock('../src/engine', () => ({
  engine: new Proxy(
    {},
    { get: (_t, prop) => fakeEngine[prop as keyof typeof fakeEngine] ?? vi.fn(async () => null) },
  ),
  onMenuAction: () => () => {},
}));

// Count real ModulePanel renders per instance: the actual component still
// renders (so the test exercises the true panel tree), we just wrap it.
const renderCounts: Record<string, number> = {};
vi.mock('../src/components/ModulePanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/components/ModulePanel')>();
  const Real = actual.ModulePanel;
  function CountingModulePanel(props: React.ComponentProps<typeof Real>) {
    renderCounts[props.instanceId] = (renderCounts[props.instanceId] ?? 0) + 1;
    return <Real {...props} />;
  }
  return { ...actual, ModulePanel: CountingModulePanel };
});

import App from '../src/App';

async function tick(ms = 100) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function resetCounts() {
  for (const k of Object.keys(renderCounts)) delete renderCounts[k];
}

describe('telemetry tick render counts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function mount() {
    render(<App />);
    // Flush startup (loadDemoPatch → refresh) and the first telemetry tick.
    await tick(0);
    await tick(100);
    expect(screen.getByTestId('module-osc-1')).toBeTruthy();
    resetCounts();
  }

  it('re-renders nothing when telemetry values are unchanged', async () => {
    await mount();
    await tick(100);
    await tick(100);
    expect(fakeEngine.tapAll.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(renderCounts).toEqual({});
  });

  it('re-renders no panel when a jack moves — only the jack updates', async () => {
    await mount();
    const glow = () =>
      screen
        .getByTestId('module-osc-2')
        .querySelector('[data-testid="jack-glow-audio"]')
        ?.getAttribute('data-indicator');
    const before = glow();
    state.telemetry = {
      ...state.telemetry,
      'osc-2': { ...state.telemetry['osc-2'], 'out:audio': tele(7) },
    };
    await tick(100);
    // The moved jack's indicator followed the new reading...
    expect(glow()).not.toBe(before);
    // ...but no ModulePanel re-rendered to make that happen.
    expect(renderCounts).toEqual({});
  });

  it('keeps custom-UI meters live without re-rendering the panel', async () => {
    await mount();
    const meter = () => screen.getByTestId('meter-value-cv').textContent;
    expect(meter()).toBe('0.00 V');
    state.telemetry = {
      ...state.telemetry,
      'vca-1': { ...state.telemetry['vca-1'], cv: tele(4.2) },
    };
    await tick(100);
    expect(meter()).toBe('4.20 V');
    expect(renderCounts).toEqual({});
  });
});
