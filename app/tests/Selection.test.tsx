// Module selection model: plain click selects one module (replacing the
// selection), shift/cmd-click toggles membership, background click / Escape
// clears, cmd+A selects all, right-click retargets, header drags don't
// select, and engine refreshes prune selections of modules that no longer
// exist (so a stale selection can never poison the copy buffer).

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

const state = { nodes: [] as unknown[] };

const fakeEngine = {
  loadDemoPatch: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  listModules: vi.fn(async () => [OSC, VCA]),
  nodes: vi.fn(async () => state.nodes),
  wires: vi.fn(async () => []),
  tap: vi.fn(async () => null),
  tapAll: vi.fn(async () => ({})),
  currentPatch: vi.fn(async () => 'demo'),
  listPatches: vi.fn(async () => ['demo']),
  undo: vi.fn(async () => true),
  removeModule: vi.fn(async () => {}),
  removeModules: vi.fn(async () => {}),
  copyModules: vi.fn(async () => 'CLIP'),
  pasteModules: vi.fn(async () => ({ osc1: 'osc2' })),
  connectWire: vi.fn(async () => {}),
  disconnectWire: vi.fn(async () => {}),
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
});

async function renderApp() {
  render(<App />);
  await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());
}

const isSelected = (id: string) => screen.getByTestId(`module-${id}`).dataset.selected === 'true';

describe('click-to-select', () => {
  it('plain click on a panel selects it; clicking another replaces the selection', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('module-osc1'));
    expect(isSelected('osc1')).toBe(true);
    expect(isSelected('vca1')).toBe(false);

    fireEvent.click(screen.getByTestId('module-vca1'));
    expect(isSelected('osc1')).toBe(false);
    expect(isSelected('vca1')).toBe(true);
  });

  it('shift-click and cmd/ctrl-click toggle membership', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('module-osc1'));
    fireEvent.click(screen.getByTestId('module-vca1'), { shiftKey: true });
    expect(isSelected('osc1')).toBe(true);
    expect(isSelected('vca1')).toBe(true);

    fireEvent.click(screen.getByTestId('module-vca1'), { ctrlKey: true });
    expect(isSelected('osc1')).toBe(true);
    expect(isSelected('vca1')).toBe(false);
  });

  it('clicking the rack background clears the selection', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('module-osc1'));
    expect(isSelected('osc1')).toBe(true);
    fireEvent.click(screen.getByTestId('rack-area'));
    expect(isSelected('osc1')).toBe(false);
  });

  it('clicking a jack or a header button does not change the selection', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('jack-output-audio'));
    expect(isSelected('osc1')).toBe(false);

    fireEvent.click(screen.getByTestId('module-vca1'));
    fireEvent.click(screen.getByTestId('module-docs-osc1'));
    expect(isSelected('osc1')).toBe(false);
    expect(isSelected('vca1')).toBe(true);
  });

  it('a header drag does not select the module on release', async () => {
    await renderApp();
    const header = screen.getByTestId('module-header-osc1');
    fireEvent.mouseDown(header, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 120, clientY: 90 });
    fireEvent.mouseUp(window);
    fireEvent.click(header, { clientX: 120, clientY: 90 });
    expect(isSelected('osc1')).toBe(false);
  });

  it('cmd/ctrl+A selects every module', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'a', metaKey: true });
    expect(isSelected('osc1')).toBe(true);
    expect(isSelected('vca1')).toBe(true);
  });
});

describe('context-menu selection retargeting', () => {
  it('right-click outside the selection retargets it to the clicked module', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('module-osc1'));
    fireEvent.contextMenu(screen.getByTestId('module-vca1'), { clientX: 10, clientY: 10 });
    expect(isSelected('osc1')).toBe(false);
    expect(isSelected('vca1')).toBe(true);
  });

  it('right-click inside a multi-selection keeps the whole group', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('module-osc1'));
    fireEvent.click(screen.getByTestId('module-vca1'), { shiftKey: true });
    fireEvent.contextMenu(screen.getByTestId('module-osc1'), { clientX: 10, clientY: 10 });
    expect(isSelected('osc1')).toBe(true);
    expect(isSelected('vca1')).toBe(true);
    expect(screen.getByTestId('ctx-copy').textContent).toContain('2 modules');
  });
});

describe('stale-selection pruning', () => {
  it('an engine refresh drops selected modules that no longer exist', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('module-osc1'));
    fireEvent.click(screen.getByTestId('module-vca1'), { shiftKey: true });

    // The engine loses osc1 behind the app's back (undo, patch load, …).
    state.nodes = [node('vca1', VCA)];
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(screen.queryByTestId('module-osc1')).toBeNull());

    expect(isSelected('vca1')).toBe(true);
    // Copy acts on the pruned selection only — no ghost ids.
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    await waitFor(() => expect(fakeEngine.copyModules).toHaveBeenCalledWith(['vca1']));
  });

  it('paste selects exactly the pasted modules', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('module-osc1'));
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    await waitFor(() => expect(fakeEngine.copyModules).toHaveBeenCalled());

    state.nodes = [node('osc1', OSC), node('vca1', VCA), node('osc2', OSC)];
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('module-osc2')).toBeTruthy());
    await waitFor(() => expect(isSelected('osc2')).toBe(true));
    expect(isSelected('osc1')).toBe(false);
    expect(isSelected('vca1')).toBe(false);
  });
});
