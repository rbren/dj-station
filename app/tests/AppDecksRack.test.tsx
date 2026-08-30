// The Decks tab IS the rack canvas, dressed in deck chrome: the same
// mounted .rack-area (same panels, same store, same pan/zoom) stays
// visible with the tempo bar above it and the strips below; the bank has
// no panel in the grid (the chrome is the bank), and wiring a chrome jack
// to a module goes through the same engine commands as the Rack tab.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../src/types';

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

// The bank's manifest, trimmed to the jacks this test touches.
const BANK: Manifest = {
  id: 'builtin.decks',
  name: 'Decks',
  version: '0.1.0',
  abi: 'builtin',
  inputs: [
    { id: 'bpm', name: 'BPM' },
    { id: 'reset', name: 'Reset' },
    { id: 'd1_in_l', name: 'Deck 1 Return L' },
    { id: 'd1_in_r', name: 'Deck 1 Return R' },
  ],
  outputs: [
    { id: 'audio_l', name: 'Audio L' },
    { id: 'audio_r', name: 'Audio R' },
    { id: 'clock', name: 'Clock' },
    { id: 'd1_l', name: 'Deck 1 Send L' },
    { id: 'd1_r', name: 'Deck 1 Send R' },
  ],
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
    // The Decks tab renders only its own workspace: the bank and the
    // modules racked around it live there.
    workspace: 'decks',
  };
}

const state = {
  nodes: [node('bank1', BANK), node('vca1', VCA)],
  wires: [] as unknown[],
};

const fakeEngine = {
  listModules: vi.fn(async () => [VCA]),
  nodes: vi.fn(async () => state.nodes),
  wires: vi.fn(async () => state.wires),
  tapAll: vi.fn(async () => ({})),
  macroGroups: vi.fn(async () => []),
  macroLayout: vi.fn(async () => ({})),
  connectWire: vi.fn(async () => {}),
  disconnectWire: vi.fn(async () => {}),
};

vi.mock('../src/engine', () => ({
  engine: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        return (
          fakeEngine[prop as keyof typeof fakeEngine] ??
          vi.fn(async () => {
            if (prop === 'listPatches') return [];
            return null;
          })
        );
      },
    },
  ),
  onMenuAction: () => () => {},
}));

const slots = Array.from({ length: 8 }, (_, i) => ({
  slot: i,
  clip: null,
  loaded: false,
  beats: 0,
  tail: 0,
  phase: 0,
  source_bpm: 120,
  stretch: 1,
  level: 0.8,
  low: 1,
  mid: 1,
  high: 1,
  mute: true,
  monitor: false,
  insert: false,
  tone_patched: [false, false, false] as [boolean, boolean, boolean],
  duration_secs: 0,
  position_secs: 0,
  beat: -1,
  sounding: false,
  playing: false,
  arm: 'none',
}));

vi.mock('../src/decks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/decks')>();
  return {
    ...actual,
    decks: {
      banks: vi.fn(async () => ['bank1']),
      ensure: vi.fn(async () => 'bank1'),
      status: vi.fn(async () => ({
        bpm: 128,
        beat: 0,
        cycle_beats: 0,
        surface: false,
        surface_connected: false,
        slots,
      })),
      load: vi.fn(async () => null),
      clear: vi.fn(async () => null),
      setControl: vi.fn(async () => null),
      arm: vi.fn(async () => null),
      setTail: vi.fn(async () => null),
      setPhase: vi.fn(async () => null),
      setBpm: vi.fn(async () => null),
      setSurface: vi.fn(async () => null),
      reset: vi.fn(async () => null),
      rehydrate: vi.fn(async () => 0),
      endEdit: vi.fn(async () => null),
    },
  };
});

import App from '../src/App';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  state.wires = [];
});

describe('the Decks tab wraps the real rack canvas', () => {
  it('keeps the canvas on screen, with the chrome around it and no bank panel in the grid', async () => {
    render(<App />);
    // The decks workspace is not the Rack tab's: its modules only render
    // once the Decks tab (their own rack) is up.
    await waitFor(() => expect(fakeEngine.nodes).toHaveBeenCalled());
    expect(screen.queryByTestId('module-vca1')).toBeNull();

    fireEvent.click(screen.getByTestId('tab-decks'));
    await waitFor(() => expect(screen.getByTestId('decks-io-0')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('module-vca1')).toBeTruthy());

    // The SAME rack area is visible (not display:none'd away like on the
    // Library tab), other modules keep their panels…
    const rackArea = screen.getByTestId('rack-area');
    expect(rackArea.closest('.app-body')).not.toBeNull();
    expect((rackArea.closest('.app-body') as HTMLElement).style.display).not.toBe('none');
    expect(screen.getByTestId('module-vca1')).toBeTruthy();
    // …but the bank has NO panel: the chrome is the bank, so each of its
    // jacks resolves to exactly one socket (the chrome one).
    expect(screen.queryByTestId('module-bank1')).toBeNull();
    expect(document.querySelectorAll('[data-jack="bank1:output:d1_l"]').length).toBe(1);
    // The chrome cable overlay is up.
    expect(screen.getByTestId('decks-chrome-overlay')).toBeTruthy();

    // Back on the Rack tab the chrome goes away and so does the whole
    // decks workspace: the two tabs are two separate racks.
    fireEvent.click(screen.getByTestId('tab-rack'));
    await waitFor(() => expect(screen.queryByTestId('module-vca1')).toBeNull());
    expect(screen.queryByTestId('module-bank1')).toBeNull();
    expect(screen.queryByTestId('decks-strips')).toBeNull();
  });

  it('wires a deck send to a module input through the same engine command as the rack', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('tab-decks'));
    await waitFor(() => expect(screen.getByTestId('module-vca1')).toBeTruthy());
    const io = await screen.findByTestId('decks-io-0');

    // Click the deck's OUT, then the module's IN — the Rack tab's own
    // grammar, arriving at the same connect_wire.
    const out = io.querySelector('[data-testid="jack-output-d1_l"]') as HTMLElement;
    fireEvent.click(out);
    expect(out.className).toContain('jack-selected');
    fireEvent.click(screen.getByTestId('jack-input-in'));
    await waitFor(() =>
      expect(fakeEngine.connectWire).toHaveBeenCalledWith(
        { instance: 'bank1', jack: 'd1_l' },
        { instance: 'vca1', jack: 'in' },
      ),
    );
  });

  it('wires the top-bar clock into a module input', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('tab-decks'));
    await waitFor(() => expect(screen.getByTestId('module-vca1')).toBeTruthy());
    const clock = await screen.findByTestId('decks-clock-jack');

    fireEvent.click(clock.querySelector('[data-testid="jack-output-clock"]') as HTMLElement);
    fireEvent.click(screen.getByTestId('jack-input-cv'));
    await waitFor(() =>
      expect(fakeEngine.connectWire).toHaveBeenCalledWith(
        { instance: 'bank1', jack: 'clock' },
        { instance: 'vca1', jack: 'cv' },
      ),
    );
  });
});
