// Global shortcuts (undo/redo, zoom) and drag-and-drop from the module
// library onto the rack, against a mocked engine bridge.

import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const state = { nodes: [] as unknown[], wires: [] as unknown[] };

const fakeEngine = {
  loadDemoPatch: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  listModules: vi.fn(async () => [OSC]),
  nodes: vi.fn(async () => state.nodes),
  wires: vi.fn(async () => state.wires),
  tap: vi.fn(async () => null),
  tapAll: vi.fn(async () => ({})),
  addModule: vi.fn(async () => {}),
  undo: vi.fn(async () => true),
  redo: vi.fn(async () => true),
  currentPatch: vi.fn(async () => null),
  listPatches: vi.fn(async () => []),
  savePatchAs: vi.fn(async () => {}),
  loadPatchByName: vi.fn(async () => {}),
  removeModule: vi.fn(async () => {}),
  removeModules: vi.fn(async () => {}),
  copyModules: vi.fn(async () => 'CLIP'),
  pasteModules: vi.fn(async () => ({ osc1: 'osc2' })),
  endEdit: vi.fn(async () => {}),
};

vi.mock('../src/engine', () => ({
  engine: new Proxy({}, { get: (_t, prop) => fakeEngine[prop as keyof typeof fakeEngine] }),
  onMenuAction: () => () => {},
}));

import App from '../src/App';
import { MODULE_DRAG_TYPE } from '../src/components/ModuleLibrary';

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
  state.nodes = [node('osc1', OSC)];
  state.wires = [];
});

async function renderApp() {
  render(<App />);
  await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());
}

describe('undo/redo shortcuts', () => {
  it('ctrl/cmd+Z triggers undo', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(fakeEngine.undo).toHaveBeenCalledTimes(1));
    expect(fakeEngine.redo).not.toHaveBeenCalled();
  });

  it('ctrl/cmd+Y and ctrl/cmd+shift+Z trigger redo', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'y', metaKey: true });
    await waitFor(() => expect(fakeEngine.redo).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(window, { key: 'Z', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(fakeEngine.redo).toHaveBeenCalledTimes(2));
    expect(fakeEngine.undo).not.toHaveBeenCalled();
  });

  it('plain Z (no modifier) and typing targets are ignored', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'z' });
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(fakeEngine.undo).not.toHaveBeenCalled();
    input.remove();
  });
});

describe('zoom shortcuts', () => {
  const scaleOf = () => screen.getByTestId('rack').style.transform;

  it('ctrl/cmd +/-/0 zoom in, out, and reset, persisting the level', async () => {
    await renderApp();
    expect(scaleOf()).toBe('scale(1)');
    fireEvent.keyDown(window, { key: '=', ctrlKey: true });
    expect(scaleOf()).toBe('scale(1.2)');
    expect(localStorage.getItem('dj-rack-zoom')).toBe('1.2');
    fireEvent.keyDown(window, { key: '-', ctrlKey: true });
    fireEvent.keyDown(window, { key: '-', ctrlKey: true });
    expect(scaleOf()).toBe(`scale(${1.2 / 1.2 / 1.2})`);
    fireEvent.keyDown(window, { key: '0', ctrlKey: true });
    expect(scaleOf()).toBe('scale(1)');
  });

  it('zoom is clamped to sane bounds', async () => {
    await renderApp();
    for (let i = 0; i < 20; i++) fireEvent.keyDown(window, { key: '+', metaKey: true });
    expect(scaleOf()).toBe('scale(2.5)');
    for (let i = 0; i < 40; i++) fireEvent.keyDown(window, { key: '_', metaKey: true });
    expect(scaleOf()).toBe('scale(0.4)');
  });
});

describe('selection copy/paste/delete shortcuts', () => {
  const selectOsc1 = () =>
    fireEvent.click(screen.getByTestId('module-header-osc1'), { shiftKey: true });

  it('cmd+C copies the selection, cmd+V pastes it', async () => {
    await renderApp();
    selectOsc1();
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    await waitFor(() => expect(fakeEngine.copyModules).toHaveBeenCalledWith(['osc1']));
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    await waitFor(() => expect(fakeEngine.pasteModules).toHaveBeenCalledWith('CLIP'));
  });

  it('cmd+C with nothing selected does nothing; paste with an empty clipboard too', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(fakeEngine.copyModules).not.toHaveBeenCalled();
    expect(fakeEngine.pasteModules).not.toHaveBeenCalled();
  });

  it('Backspace deletes the selection', async () => {
    await renderApp();
    selectOsc1();
    fireEvent.keyDown(window, { key: 'Backspace' });
    await waitFor(() => expect(fakeEngine.removeModules).toHaveBeenCalledWith(['osc1']));
  });

  it('Backspace with no selection or in an input does nothing', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'Backspace' });
    const input = document.createElement('input');
    document.body.appendChild(input);
    selectOsc1();
    fireEvent.keyDown(input, { key: 'Backspace' });
    await new Promise((r) => setTimeout(r, 10));
    expect(fakeEngine.removeModules).not.toHaveBeenCalled();
    input.remove();
  });

  it('pasted modules become the new selection', async () => {
    await renderApp();
    selectOsc1();
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    await waitFor(() => expect(fakeEngine.copyModules).toHaveBeenCalled());
    state.nodes = [node('osc1', OSC), node('osc2', OSC)];
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    await waitFor(() => expect(fakeEngine.pasteModules).toHaveBeenCalled());
    await waitFor(() => {
      const panel = screen.getByTestId('module-osc2');
      expect(panel.dataset.selected).toBe('true');
    });
    expect(screen.getByTestId('module-osc1').dataset.selected).toBeUndefined();
  });
});

describe('drag module from library onto rack', () => {
  it('library entries are draggable and export the module type', async () => {
    await renderApp();
    const entry = screen.getByTestId('library-add-com.dj.oscillator');
    expect(entry.getAttribute('draggable')).toBe('true');
    const dataTransfer = {
      data: {} as Record<string, string>,
      setData(type: string, v: string) {
        this.data[type] = v;
      },
      effectAllowed: '',
    };
    fireEvent.dragStart(entry, { dataTransfer });
    expect(dataTransfer.data[MODULE_DRAG_TYPE]).toBe('com.dj.oscillator');
  });

  it('dropping on the rack adds the module at the snapped drop point', async () => {
    await renderApp();
    const rackArea = screen.getByTestId('rack-area');
    const dataTransfer = {
      types: [MODULE_DRAG_TYPE],
      getData: (type: string) => (type === MODULE_DRAG_TYPE ? 'com.dj.oscillator' : ''),
      dropEffect: '',
    };
    fireEvent.dragOver(rackArea, { dataTransfer });
    // jsdom's drop event has no clientX/Y; define them explicitly.
    const drop = createEvent.drop(rackArea);
    Object.defineProperties(drop, {
      dataTransfer: { value: dataTransfer },
      clientX: { value: 100 },
      clientY: { value: 60 },
    });
    fireEvent(rackArea, drop);
    await waitFor(() =>
      expect(fakeEngine.addModule).toHaveBeenCalledWith('oscillat1', 'com.dj.oscillator'),
    );
    // 100px/60px snapped to the 48px grid (jsdom rects are at 0,0), then
    // moved to the NEAREST free grid spot: (96,48) overlaps osc1's nominal
    // footprint at its default slot (0,0), and (96,96) — one cell down —
    // is the closest free cell (deliberately pins the nearest-spot search
    // that replaced the old downward-only nudge).
    await waitFor(() => {
      const positions = JSON.parse(localStorage.getItem('dj-rack-positions') ?? '{}');
      expect(positions.oscillat1).toEqual({ x: 96, y: 96 });
    });
  });
});
