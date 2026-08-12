// Collapse-to-macro UI flow (M4, PRD §6): shift-click multi-select,
// "Collapse to Module" naming form calling the engine bridge, and the
// macro library section instantiating macros by id.

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

const TONE_MACRO: Manifest = {
  id: 'macro.tone',
  name: 'Tone',
  version: '1',
  abi: 'macro-1',
  inputs: [
    { id: 'pitch', name: 'pitch' },
    { id: 'level', name: 'level' },
  ],
  outputs: [{ id: 'out', name: 'out' }],
  params: [],
};

const state = {
  nodes: [] as unknown[],
  wires: [] as unknown[],
  modules: [OSC, VCA] as Manifest[],
};

const fakeEngine = {
  loadDemoPatch: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  listModules: vi.fn(async () => state.modules),
  nodes: vi.fn(async () => state.nodes),
  wires: vi.fn(async () => state.wires),
  tap: vi.fn(async () => null),
  tapAll: vi.fn(async () => ({})),
  addModule: vi.fn(async () => {}),
  collapseMacro: vi.fn(async () => 'my-tone'),
  setParam: vi.fn(async () => {}),
  setKnobPosition: vi.fn(async () => {}),
  setKnobConfig: vi.fn(async () => {}),
  setAttenOffset: vi.fn(async () => {}),
  connectWire: vi.fn(async () => {}),
  disconnectWire: vi.fn(async () => {}),
  currentPatch: vi.fn(async () => 'demo'),
  listPatches: vi.fn(async () => ['demo']),
  savePatchAs: vi.fn(async () => {}),
  loadPatchByName: vi.fn(async () => {}),
  removeModule: vi.fn(async () => {}),
  endEdit: vi.fn(async () => {}),
};

vi.mock('../src/engine', () => ({
  engine: new Proxy({}, { get: (_t, prop) => fakeEngine[prop as keyof typeof fakeEngine] }),
  onMenuAction: () => () => {},
}));

import App from '../src/App';

function node(instance: string, manifest: Manifest) {
  return {
    instance_id: instance,
    type_id: manifest.id,
    manifest,
    knobs: {},
    params: {},
    wired_inputs: [],
    midi_mappings: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  state.nodes = [node('osc1', OSC), node('vca1', VCA)];
  state.wires = [];
  state.modules = [OSC, VCA];
});

async function selectBoth() {
  render(<App />);
  await screen.findByTestId('module-osc1');
  fireEvent.click(screen.getByTestId('module-header-osc1'), { shiftKey: true });
  fireEvent.click(screen.getByTestId('module-header-vca1'), { shiftKey: true });
}

describe('collapse-to-macro UI', () => {
  it('shift-click selects modules and shows the collapse button', async () => {
    await selectBoth();
    expect(screen.getByTestId('module-osc1').dataset.selected).toBe('true');
    expect(screen.getByTestId('module-vca1').dataset.selected).toBe('true');
    expect(screen.getByTestId('collapse-macro-btn').textContent).toContain('(2)');
    // Shift-click again deselects.
    fireEvent.click(screen.getByTestId('module-header-vca1'), { shiftKey: true });
    expect(screen.getByTestId('module-vca1').dataset.selected).toBeUndefined();
    expect(screen.getByTestId('collapse-macro-btn').textContent).toContain('(1)');
  });

  it('plain click selects exactly one module, replacing the selection', async () => {
    await selectBoth();
    fireEvent.click(screen.getByTestId('module-header-osc1'));
    expect(screen.getByTestId('module-osc1').dataset.selected).toBe('true');
    expect(screen.getByTestId('module-vca1').dataset.selected).toBeUndefined();
    expect(screen.getByTestId('collapse-macro-btn').textContent).toContain('(1)');
  });

  it('naming and confirming collapses the selection via the engine', async () => {
    await selectBoth();
    fireEvent.click(screen.getByTestId('collapse-macro-btn'));
    fireEvent.change(screen.getByTestId('collapse-macro-name'), {
      target: { value: 'My Tone' },
    });
    fireEvent.click(screen.getByTestId('collapse-macro-confirm'));
    await waitFor(() =>
      expect(fakeEngine.collapseMacro).toHaveBeenCalledWith(['osc1', 'vca1'], 'My Tone'),
    );
    // Selection cleared and the module library refetched (macros appear).
    await waitFor(() => expect(screen.queryByTestId('collapse-macro-btn')).toBeNull());
    expect(fakeEngine.listModules.mock.calls.length).toBeGreaterThan(1);
  });

  it('escape cancels selection and the naming form', async () => {
    await selectBoth();
    fireEvent.click(screen.getByTestId('collapse-macro-btn'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('collapse-macro-form')).toBeNull();
    expect(screen.queryByTestId('collapse-macro-btn')).toBeNull();
    expect(screen.getByTestId('module-osc1').dataset.selected).toBeUndefined();
  });

  it('macros list in their own library section and instantiate on click', async () => {
    state.modules = [OSC, VCA, TONE_MACRO];
    render(<App />);
    await screen.findByTestId('add-module-btn');
    fireEvent.click(screen.getByTestId('add-module-btn'));
    await screen.findByTestId('picker-category-Macros');
    fireEvent.click(screen.getByTestId('library-add-macro.tone'));
    await waitFor(() =>
      expect(fakeEngine.addModule).toHaveBeenCalledWith(
        expect.stringMatching(/^tone/),
        'macro.tone',
      ),
    );
  });
});
