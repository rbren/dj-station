// The Rack tab and the Decks tab are two SEPARATE rack workspaces sharing
// one engine: each tab renders only its own modules, new/pasted modules
// land in the open tab's workspace, and every file action (patch title,
// Save/Save As/Open/New, the unsaved-changes guard) targets the open
// tab's own patch file.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearErrors } from '../src/errors';
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

const BANK: Manifest = {
  id: 'builtin.decks',
  name: 'Decks',
  version: '0.1.0',
  abi: 'builtin',
  inputs: [{ id: 'd1_in', name: 'Deck 1 Return' }],
  outputs: [
    { id: 'clock', name: 'Clock' },
    { id: 'd1_out', name: 'Deck 1 Send' },
  ],
  params: [],
};

function node(instance: string, manifest: Manifest, workspace: 'rack' | 'decks') {
  return {
    instance_id: instance,
    type_id: manifest.id,
    manifest,
    knobs: {},
    params: {},
    wired_inputs: [],
    midi_mappings: [],
    workspace,
  };
}

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
  tapAll: vi.fn(async () => ({})),
  macroGroups: vi.fn(async () => []),
  macroLayout: vi.fn(async () => ({})),
  addModule: vi.fn(async () => {}),
  copyModules: vi.fn(async () => 'CLIP'),
  pasteModules: vi.fn(async () => ({})),
  connectWire: vi.fn(async () => {}),
  disconnectWire: vi.fn(async () => {}),
  // Two workspaces, two working names: the mock keeps them apart the same
  // way the backend does.
  currentPatch: vi.fn(async (ws?: string) => (ws === 'decks' ? 'deck-set' : 'demo')),
  listPatches: vi.fn(async (ws?: string) =>
    ws === 'decks' ? ['deck-set', 'club-night'] : ['demo', 'live-set'],
  ),
  savePatchAs: vi.fn(async () => {}),
  loadPatchByName: vi.fn(async (): Promise<string[]> => []),
  newPatch: vi.fn(async () => {}),
  patchDirty: vi.fn(async () => false),
  removeModule: vi.fn(async () => {}),
  endEdit: vi.fn(async () => {}),
  moveModules: vi.fn(async () => {}),
  syncPositions: vi.fn(async () => {}),
};

vi.mock('../src/engine', () => ({
  engine: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        return fakeEngine[prop as keyof typeof fakeEngine] ?? vi.fn(async () => null);
      },
    },
  ),
  onMenuAction: (cb: (action: string) => void) => {
    const h = (e: Event) => cb((e as CustomEvent).detail as string);
    window.addEventListener('dj-menu', h);
    return () => window.removeEventListener('dj-menu', h);
  },
}));

const slots = Array.from({ length: 8 }, (_, i) => ({
  slot: i,
  clip: null,
  loaded: false,
  beats: 0,
  ones: [],
  lead_one: null,
  tail: 0,
  phase: 0,
  source_bpm: 120,
  ratio: 1,
  stretch: 1,
  level: 0.8,
  low: 1,
  mid: 1,
  high: 1,
  mute: true,
  monitor: false,
  wet: 1,
  insert_monitor: false,
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
        running: true,
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
      setRatio: vi.fn(async () => null),
      setBpm: vi.fn(async () => null),
      setSurface: vi.fn(async () => null),
      setRunning: vi.fn(async () => null),
      rehydrate: vi.fn(async () => 0),
      endEdit: vi.fn(async () => null),
    },
  };
});

import App from '../src/App';

const fireMenu = (action: string) =>
  fireEvent(window, new CustomEvent('dj-menu', { detail: action }));
const isSelected = (id: string) => screen.getByTestId(`module-${id}`).dataset.selected === 'true';

async function openDecksTab() {
  fireEvent.click(screen.getByTestId('tab-decks'));
  await waitFor(() => expect(screen.getByTestId('module-vca1')).toBeTruthy());
}

beforeEach(() => {
  vi.clearAllMocks();
  clearErrors();
  localStorage.clear();
  state.nodes = [
    node('osc1', OSC, 'rack'),
    node('bank1', BANK, 'decks'),
    node('vca1', VCA, 'decks'),
  ];
  state.wires = [];
});

describe('two workspaces, one canvas', () => {
  it('each tab renders only its own workspace, both ways round', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());
    expect(screen.queryByTestId('module-vca1')).toBeNull();
    expect(screen.queryByTestId('module-bank1')).toBeNull();

    await openDecksTab();
    expect(screen.queryByTestId('module-osc1')).toBeNull();
    // The bank has no panel even in its own workspace: the chrome is it.
    expect(screen.queryByTestId('module-bank1')).toBeNull();

    fireEvent.click(screen.getByTestId('tab-rack'));
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());
    expect(screen.queryByTestId('module-vca1')).toBeNull();
  });

  it('select-all means the open workspace: cmd+A on the Decks tab copies only its modules', async () => {
    render(<App />);
    await openDecksTab();
    fireEvent.keyDown(window, { key: 'a', metaKey: true });
    await waitFor(() => expect(isSelected('vca1')).toBe(true));
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    // The whole DECKS workspace (the bank is a node there, panel or not) —
    // and nothing from the rack's.
    await waitFor(() => expect(fakeEngine.copyModules).toHaveBeenCalledWith(['bank1', 'vca1']));
  });

  it('a module added on the Decks tab lands in the decks workspace', async () => {
    render(<App />);
    await openDecksTab();
    fireEvent.keyDown(window, { key: 'm', metaKey: true });
    fireEvent.click(await screen.findByTestId('library-add-com.dj.oscillator'));
    await waitFor(() =>
      expect(fakeEngine.addModule).toHaveBeenCalledWith(
        expect.stringMatching(/^oscillat/),
        'com.dj.oscillator',
        'decks',
      ),
    );
  });

  it('paste lands in the open workspace on both tabs', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());
    fireEvent.mouseDown(screen.getByTestId('module-osc1'), { button: 0 });
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    await waitFor(() => expect(fakeEngine.copyModules).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    await waitFor(() => expect(fakeEngine.pasteModules).toHaveBeenLastCalledWith('CLIP', 'rack'));

    // The clipboard survives the tab switch: copy on one rack, paste into
    // the other.
    await openDecksTab();
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    await waitFor(() => expect(fakeEngine.pasteModules).toHaveBeenLastCalledWith('CLIP', 'decks'));
  });
});

describe('per-workspace patch files', () => {
  it('the header title is the open workspace working name', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('demo'));
    await openDecksTab();
    expect(screen.getByTestId('patch-title').textContent).toBe('deck-set');
    fireEvent.click(screen.getByTestId('tab-rack'));
    await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('demo'));
  });

  it('cmd+S on the Decks tab saves the decks workspace under its own name', async () => {
    render(<App />);
    await openDecksTab();
    await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('deck-set'));
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await waitFor(() => expect(fakeEngine.savePatchAs).toHaveBeenCalledWith('deck-set', 'decks'));
  });

  it('File > Open on the Decks tab lists deck patches and loads into the decks workspace', async () => {
    render(<App />);
    await openDecksTab();
    fireMenu('open');
    const dialog = await screen.findByTestId('file-dialog');
    await waitFor(() => expect(dialog.textContent).toContain('club-night'));
    expect(dialog.textContent).not.toContain('live-set');
    fireEvent.click(screen.getByText('club-night'));
    await waitFor(() =>
      expect(fakeEngine.loadPatchByName).toHaveBeenCalledWith('club-night', 'decks'),
    );
    await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('club-night'));
    // The rack workspace's working name is untouched.
    fireEvent.click(screen.getByTestId('tab-rack'));
    await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('demo'));
  });

  it('File > New on the Decks tab guards and resets only the decks workspace', async () => {
    render(<App />);
    await openDecksTab();
    fireMenu('request-new');
    await waitFor(() => expect(fakeEngine.patchDirty).toHaveBeenCalledWith('decks'));
    await waitFor(() => expect(fakeEngine.newPatch).toHaveBeenCalledWith('decks'));
    await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('untitled'));
    fireEvent.click(screen.getByTestId('tab-rack'));
    await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('demo'));
  });
});
