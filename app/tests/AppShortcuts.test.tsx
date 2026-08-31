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
  macroGroups: vi.fn(async () => []),
  macroLayout: vi.fn(async () => ({})),
  breakMacro: vi.fn(async () => ({})),
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
  moveModules: vi.fn(async () => {}),
  syncPositions: vi.fn(async () => {}),
  qwertyKey: vi.fn(async () => {}),
};

vi.mock('../src/engine', () => ({
  engine: new Proxy(
    {},
    { get: (_t, prop) => fakeEngine[prop as keyof typeof fakeEngine] ?? vi.fn(async () => null) },
  ),
  onMenuAction: () => () => {},
}));

import App from '../src/App';
import { MODULE_DRAG_TYPE } from '../src/components/ModulePicker';

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
  const scaled = (z: number, pan = { x: 0, y: 0 }) =>
    `translate(${pan.x}px, ${pan.y}px) scale(${z})`;

  it('ctrl/cmd +/-/0 zoom in, out, and reset, persisting the level', async () => {
    await renderApp();
    expect(scaleOf()).toBe(scaled(1));
    fireEvent.keyDown(window, { key: '=', ctrlKey: true });
    expect(scaleOf()).toBe(scaled(1.2));
    expect(localStorage.getItem('dj-rack-zoom')).toBe('1.2');
    fireEvent.keyDown(window, { key: '-', ctrlKey: true });
    fireEvent.keyDown(window, { key: '-', ctrlKey: true });
    expect(scaleOf()).toBe(scaled(1.2 / 1.2 / 1.2));
    fireEvent.keyDown(window, { key: '0', ctrlKey: true });
    expect(scaleOf()).toBe(scaled(1));
  });

  it('a focused form control swallows the edit shortcuts, never the zoom keys', async () => {
    // Zoom moves the camera, never text — so unlike undo/copy it is not a
    // shortcut a field can swallow (the Decks chrome is nothing but
    // fields, and pressing the canvas behind them does not blur).
    await renderApp();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: '=', ctrlKey: true });
    expect(scaleOf()).toBe(scaled(1.2));
    fireEvent.keyDown(input, { key: '0', ctrlKey: true });
    expect(scaleOf()).toBe(scaled(1));
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(fakeEngine.undo).not.toHaveBeenCalled();
    input.remove();
  });

  it('zoom is clamped to sane bounds', async () => {
    await renderApp();
    for (let i = 0; i < 20; i++) fireEvent.keyDown(window, { key: '+', metaKey: true });
    expect(scaleOf()).toBe(scaled(2.5));
    for (let i = 0; i < 40; i++) fireEvent.keyDown(window, { key: '_', metaKey: true });
    expect(scaleOf()).toBe(scaled(0.04));
  });

  it('the deepest zoom-out restores from storage and coarsens the dot grid', async () => {
    localStorage.setItem('dj-rack-zoom', '0.04');
    await renderApp();
    expect(scaleOf()).toBe(scaled(0.04));
    // The dot grid coarsens (doubles) at deep zoom-out instead of collapsing
    // into sub-2px moiré: spacing stays >= 12px and a power-of-two multiple
    // of the zoomed 48px lattice, so dots keep landing on grid points.
    const size = parseFloat(screen.getByTestId('rack-area').style.backgroundSize);
    expect(size).toBeGreaterThanOrEqual(12);
    expect(size).toBeLessThan(24);
    expect(Math.log2(size / (48 * 0.04))).toBeCloseTo(Math.round(Math.log2(size / (48 * 0.04))));
  });
});

describe('infinite canvas pan (overscroll)', () => {
  const transformOf = () => screen.getByTestId('rack').style.transform;

  it('wheel scrolling over the rack pans in any direction and persists', async () => {
    await renderApp();
    const area = screen.getByTestId('rack-area');
    fireEvent.wheel(area, { deltaX: 30, deltaY: 50 });
    expect(transformOf()).toBe('translate(-30px, -50px) scale(1)');
    // Panning past the origin (up-left) opens new canvas: positive pan.
    fireEvent.wheel(area, { deltaX: -100, deltaY: -100 });
    expect(transformOf()).toBe('translate(70px, 50px) scale(1)');
    expect(JSON.parse(localStorage.getItem('dj-rack-pan')!)).toEqual({ x: 70, y: 50 });
  });

  it('the saved pan is restored on load', async () => {
    localStorage.setItem('dj-rack-pan', JSON.stringify({ x: -120, y: 48 }));
    await renderApp();
    expect(transformOf()).toBe('translate(-120px, 48px) scale(1)');
  });

  it('ctrl/cmd+0 resets the pan along with the zoom', async () => {
    await renderApp();
    fireEvent.wheel(screen.getByTestId('rack-area'), { deltaY: 200 });
    fireEvent.keyDown(window, { key: '0', ctrlKey: true });
    expect(transformOf()).toBe('translate(0px, 0px) scale(1)');
    expect(JSON.parse(localStorage.getItem('dj-rack-pan')!)).toEqual({ x: 0, y: 0 });
  });

  it('the dot grid tracks the pan and zoom', async () => {
    await renderApp();
    fireEvent.wheel(screen.getByTestId('rack-area'), { deltaX: -30, deltaY: -20 });
    fireEvent.keyDown(window, { key: '=', ctrlKey: true });
    const area = screen.getByTestId('rack-area');
    expect(area.style.backgroundPosition).toBe('30px 20px');
    expect(area.style.backgroundSize).toBe(`${48 * 1.2}px ${48 * 1.2}px`);
  });
});

describe('selection copy/paste/delete shortcuts', () => {
  const selectOsc1 = () =>
    fireEvent.mouseDown(screen.getByTestId('module-header-osc1'), { shiftKey: true });

  it('cmd+C copies the selection, cmd+V pastes it', async () => {
    await renderApp();
    selectOsc1();
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    await waitFor(() => expect(fakeEngine.copyModules).toHaveBeenCalledWith(['osc1']));
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    await waitFor(() => expect(fakeEngine.pasteModules).toHaveBeenCalledWith('CLIP', 'rack'));
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

describe('cmd+M module picker', () => {
  it('cmd/ctrl+M toggles the picker modal; adding closes it', async () => {
    await renderApp();
    expect(screen.queryByTestId('module-picker')).toBeNull();
    fireEvent.keyDown(window, { key: 'm', metaKey: true });
    expect(screen.getByTestId('module-picker')).toBeTruthy();
    fireEvent.click(screen.getByTestId('library-add-com.dj.oscillator'));
    await waitFor(() =>
      expect(fakeEngine.addModule).toHaveBeenCalledWith('oscillat1', 'com.dj.oscillator', 'rack'),
    );
    expect(screen.queryByTestId('module-picker')).toBeNull();
    fireEvent.keyDown(window, { key: 'm', ctrlKey: true });
    expect(screen.getByTestId('module-picker')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'm', ctrlKey: true });
    expect(screen.queryByTestId('module-picker')).toBeNull();
  });

  it('there is no header button any more: the rack context menu opens it too', async () => {
    await renderApp();
    expect(screen.queryByTestId('add-module-btn')).toBeNull();
    fireEvent.contextMenu(screen.getByTestId('rack-area'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId('ctx-add-module'));
    expect(screen.getByTestId('module-picker')).toBeTruthy();
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
      expect(fakeEngine.addModule).toHaveBeenCalledWith('oscillat1', 'com.dj.oscillator', 'rack'),
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

describe('rack keyboard scope', () => {
  // The rack stays mounted (hidden) while another page is showing, so its
  // window key listeners must gate on the active view — and release
  // anything held at the moment of switching (the keyup lands elsewhere).
  const QWERTY: Manifest = {
    id: 'builtin.qwerty',
    name: 'QWERTY',
    version: '0.1.0',
    abi: 'native-1',
    inputs: [],
    outputs: [{ id: 'q', name: 'Q' }],
    params: [],
  };

  it('QWERTY gates and rack shortcuts go quiet on the library page', async () => {
    state.nodes = [node('osc1', OSC), node('kb1', QWERTY)];
    await renderApp();
    fireEvent.keyDown(window, { key: 'q' });
    await waitFor(() => expect(fakeEngine.qwertyKey).toHaveBeenCalledWith('kb1', 'q', true));
    fireEvent.mouseDown(screen.getByTestId('module-header-osc1'), { shiftKey: true });

    // Switching away releases the held gate...
    fireEvent.click(screen.getByTestId('tab-library'));
    await waitFor(() => expect(fakeEngine.qwertyKey).toHaveBeenLastCalledWith('kb1', 'q', false));
    // ...and neither the QWERTY module nor the rack shortcuts hear keys —
    // the zoom keys included, though they are the one pair that fires over
    // a focused form control while the canvas IS up.
    fireEvent.keyDown(window, { key: 'w' });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Backspace' });
    fireEvent.keyDown(window, { key: 'm', metaKey: true });
    fireEvent.keyDown(window, { key: '=', metaKey: true });
    fireEvent.keyDown(window, { key: '0', metaKey: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(fakeEngine.qwertyKey).toHaveBeenCalledTimes(2);
    expect(fakeEngine.undo).not.toHaveBeenCalled();
    expect(fakeEngine.removeModules).not.toHaveBeenCalled();
    expect(screen.queryByTestId('module-picker')).toBeNull();
    expect(localStorage.getItem('dj-rack-zoom')).toBeNull();
    expect(screen.getByTestId('rack').style.transform).toBe('translate(0px, 0px) scale(1)');

    // Back on the rack everything plays again.
    fireEvent.click(screen.getByTestId('tab-rack'));
    fireEvent.keyDown(window, { key: 'q' });
    await waitFor(() => expect(fakeEngine.qwertyKey).toHaveBeenLastCalledWith('kb1', 'q', true));
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(fakeEngine.undo).toHaveBeenCalledTimes(1));
  });
});
