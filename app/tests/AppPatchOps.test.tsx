// Patch save/load header controls, module delete buttons, pending-wire
// cursor preview + background-click abandon, and overlap-free module
// placement — against a mocked engine bridge.

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
  currentPatch: vi.fn(async () => 'demo'),
  listPatches: vi.fn(async () => ['demo', 'live-set']),
  savePatchAs: vi.fn(async () => {}),
  loadPatchByName: vi.fn(async () => {}),
  removeModule: vi.fn(async () => {}),
  endEdit: vi.fn(async () => {}),
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

describe('patch save/load header controls', () => {
  it('shows the current patch name and saves under an edited name', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());

    const nameInput = screen.getByTestId('patch-name') as HTMLInputElement;
    await waitFor(() => expect(nameInput.value).toBe('demo'));

    fireEvent.change(nameInput, { target: { value: 'my-patch' } });
    fireEvent.click(screen.getByTestId('patch-save'));
    await waitFor(() => expect(fakeEngine.savePatchAs).toHaveBeenCalledWith('my-patch'));
    // Save refreshes the saved-patch list.
    expect(fakeEngine.listPatches.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('cmd+S saves the patch', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await waitFor(() => expect(fakeEngine.savePatchAs).toHaveBeenCalledWith('demo'));
  });

  it('selecting a saved patch loads it and updates the name', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());

    const select = screen.getByTestId('patch-load') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3)); // placeholder + 2
    fireEvent.change(select, { target: { value: 'live-set' } });
    await waitFor(() => expect(fakeEngine.loadPatchByName).toHaveBeenCalledWith('live-set'));
    await waitFor(() =>
      expect((screen.getByTestId('patch-name') as HTMLInputElement).value).toBe('live-set'),
    );
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

    // Clicking empty rack background abandons the pending wire.
    fireEvent.click(screen.getByTestId('rack-area'));
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

  it('rejects drags that would overlap another module', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());

    // osc1 defaults to (0,0), vca1 to (480,0); give both real footprints.
    setSize(screen.getByTestId('module-osc1'), 192, 96);
    setSize(screen.getByTestId('module-vca1'), 192, 96);

    const header = screen.getByTestId('module-header-vca1');
    const panel = screen.getByTestId('module-vca1');

    // Drag vca1 onto osc1 (0,0): the move is rejected, position unchanged.
    fireEvent.mouseDown(header, { button: 0, clientX: 480, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 0, clientY: 0 });
    fireEvent.mouseUp(window);
    expect(panel.style.left).toBe('480px');
    expect(panel.style.top).toBe('0px');

    // Dragging to a free spot below osc1 works.
    fireEvent.mouseDown(header, { button: 0, clientX: 480, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 480, clientY: 192 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(panel.style.top).toBe('192px'));
  });
});
