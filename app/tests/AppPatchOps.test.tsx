// File-menu driven patch save/load dialogs, module delete buttons,
// pending-wire cursor preview + background-click abandon, and overlap-free
// module placement — against a mocked engine bridge.

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
  tapAll: vi.fn(async () => ({})),
  addModule: vi.fn(async () => {}),
  connectWire: vi.fn(async () => {}),
  disconnectWire: vi.fn(async () => {}),
  setParam: vi.fn(async () => {}),
  setKnobPosition: vi.fn(async () => {}),
  setKnobConfig: vi.fn(async () => {}),
  setAttenOffset: vi.fn(async () => {}),
  currentPatch: vi.fn(async () => 'demo'),
  listPatches: vi.fn(async () => ['demo', 'live-set']),
  savePatchAs: vi.fn(async () => {}),
  loadPatchByName: vi.fn(async () => {}),
  removeModule: vi.fn(async () => {}),
  endEdit: vi.fn(async () => {}),
};

vi.mock('../src/engine', () => ({
  engine: new Proxy({}, { get: (_t, prop) => fakeEngine[prop as keyof typeof fakeEngine] }),
  onMenuAction: (cb: (action: string) => void) => {
    const h = (e: Event) => cb((e as CustomEvent).detail as string);
    window.addEventListener('dj-menu', h);
    return () => window.removeEventListener('dj-menu', h);
  },
}));

import App from '../src/App';

const fireMenu = (action: string) =>
  fireEvent(window, new CustomEvent('dj-menu', { detail: action }));

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

describe('file menu patch save/load', () => {
  it('shows the current patch name in the header (no in-app save/load controls)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('demo'));
    expect(screen.queryByTestId('patch-save')).toBeNull();
    expect(screen.queryByTestId('patch-load')).toBeNull();
  });

  it('File > Save As opens a dialog and saves under the edited name', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('demo'));

    fireMenu('save-as');
    const nameInput = (await screen.findByTestId('file-dialog-name')) as HTMLInputElement;
    expect(nameInput.value).toBe('demo');
    fireEvent.change(nameInput, { target: { value: 'my-patch' } });
    fireEvent.click(screen.getByTestId('file-dialog-confirm'));
    await waitFor(() => expect(fakeEngine.savePatchAs).toHaveBeenCalledWith('my-patch'));
    // Dialog closes; header shows the new name; patch list refreshed.
    await waitFor(() => expect(screen.queryByTestId('file-dialog')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('my-patch'));
    expect(fakeEngine.listPatches.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('cmd+S saves the patch under its current name', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('demo'));
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await waitFor(() => expect(fakeEngine.savePatchAs).toHaveBeenCalledWith('demo'));
  });

  it('File > Open lists saved patches and loads the chosen one', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());

    fireMenu('open');
    const entry = await screen.findByTestId('file-dialog-patch-live-set');
    fireEvent.click(entry);
    await waitFor(() => expect(fakeEngine.loadPatchByName).toHaveBeenCalledWith('live-set'));
    await waitFor(() => expect(screen.queryByTestId('file-dialog')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('live-set'));
  });

  it('the dialog cancel button closes without saving or loading', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());

    fireMenu('save-as');
    await screen.findByTestId('file-dialog');
    fireEvent.click(screen.getByTestId('file-dialog-cancel'));
    await waitFor(() => expect(screen.queryByTestId('file-dialog')).toBeNull());
    expect(fakeEngine.savePatchAs).not.toHaveBeenCalled();
    expect(fakeEngine.loadPatchByName).not.toHaveBeenCalled();
  });
});

describe('module delete button', () => {
  it('every module renders a delete button that removes the instance', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());
    expect(screen.getByTestId('module-remove-vca1')).toBeTruthy();

    fireEvent.click(screen.getByTestId('module-remove-osc1'));
    await waitFor(() => expect(fakeEngine.removeModule).toHaveBeenCalledWith('osc1'));
    // Removal refreshes the graph from the engine.
    await waitFor(() => expect(fakeEngine.nodes.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe('pending wire preview', () => {
  it('follows the cursor and is abandoned by a background click', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('jack-output-audio'));
    const cable = await screen.findByTestId('pending-cable');
    expect(cable).toBeTruthy();

    fireEvent.mouseMove(window, { clientX: 300, clientY: 200 });
    await waitFor(() => {
      const c = screen.getByTestId('pending-cable');
      expect(c.getAttribute('x2')).toBe('300');
      expect(c.getAttribute('y2')).toBe('200');
    });

    // Pressing empty rack background abandons the pending wire.
    fireEvent.mouseDown(screen.getByTestId('rack-area'), { button: 0 });
    await waitFor(() => expect(screen.queryByTestId('pending-cable')).toBeNull());
    expect(fakeEngine.connectWire).not.toHaveBeenCalled();
  });

  it('is not abandoned by clicks inside a module panel', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('jack-output-audio'));
    await screen.findByTestId('pending-cable');

    fireEvent.click(screen.getByTestId('module-header-osc1'));
    expect(screen.getByTestId('pending-cable')).toBeTruthy();
  });
});

describe('overlap-free module placement', () => {
  const setSize = (el: HTMLElement, w: number, h: number) => {
    Object.defineProperty(el, 'offsetWidth', { configurable: true, value: w });
    Object.defineProperty(el, 'offsetHeight', { configurable: true, value: h });
  };

  it('drags into a neighbour stop against it, deep drags jump over it', async () => {
    // osc1 sits mid-rack so there is free space on both sides of it.
    localStorage.setItem(
      'dj-rack-positions',
      JSON.stringify({ osc1: { x: 480, y: 0 }, vca1: { x: 960, y: 0 } }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());

    setSize(screen.getByTestId('module-osc1'), 192, 96);
    setSize(screen.getByTestId('module-vca1'), 192, 96);

    const header = screen.getByTestId('module-header-vca1');
    const panel = screen.getByTestId('module-vca1');

    // Shallow drag left into osc1 (480..672): vca1 never overlaps, it is
    // pushed back to rest against osc1's right edge (672).
    fireEvent.mouseDown(header, { button: 0, clientX: 960, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 624, clientY: 0 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(panel.style.left).toBe('672px'));
    expect(panel.style.top).toBe('0px');

    // Deep drag past osc1's midpoint: vca1 jumps over to its far side (288).
    fireEvent.mouseDown(header, { button: 0, clientX: 672, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 336, clientY: 0 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(panel.style.left).toBe('288px'));
    expect(panel.style.top).toBe('0px');

    // Dragging to a free spot below osc1 works.
    fireEvent.mouseDown(header, { button: 0, clientX: 288, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 480, clientY: 192 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(panel.style.top).toBe('192px'));
    expect(panel.style.left).toBe('480px');
  });

  it('a module stuck on top of another can always be dragged away', async () => {
    // Legacy/bad layout: both modules stacked at (0,0).
    localStorage.setItem(
      'dj-rack-positions',
      JSON.stringify({ osc1: { x: 0, y: 0 }, vca1: { x: 0, y: 0 } }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-vca1')).toBeTruthy());

    const panel = screen.getByTestId('module-vca1');
    const header = screen.getByTestId('module-header-vca1');
    // Even while overlapping, a drag to open space must not be rejected.
    // (The auto-nudge pass may have already moved vca1 off osc1, so pin
    // the drag delta relative to wherever it starts.)
    const startTop = Number.parseInt(panel.style.top || '0', 10);
    fireEvent.mouseDown(header, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 960, clientY: 480 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(panel.style.left).toBe('960px'));
    expect(Number.parseInt(panel.style.top || '0', 10)).toBe(startTop + 480);
  });

  it('overlapped modules are auto-nudged apart after render', async () => {
    localStorage.setItem(
      'dj-rack-positions',
      JSON.stringify({ osc1: { x: 0, y: 0 }, vca1: { x: 0, y: 0 } }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-vca1')).toBeTruthy());

    // The post-render placement pass moves vca1 clear of osc1's 192×96
    // footprint (on the infinite canvas the nearest free spot may be
    // above, i.e. negative y).
    const osc = screen.getByTestId('module-osc1');
    const vca = screen.getByTestId('module-vca1');
    await waitFor(() => {
      expect(osc.style.top).toBe('0px');
      const top = Number.parseInt(vca.style.top || '0', 10);
      const left = Number.parseInt(vca.style.left || '0', 10);
      expect(Math.abs(top) >= 96 || Math.abs(left) >= 192).toBe(true);
    });
  });
});
