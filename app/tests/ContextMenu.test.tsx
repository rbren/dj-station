// Right-click context menus: the browser menu is suppressed globally;
// right-clicking a module shows Delete / Documentation / Reset to defaults
// / a disabled stub, right-clicking the rack background shows Save (the
// File-menu save action). Documentation opens the in-app docs panel.

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
};

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
  savePatchAs: vi.fn(async () => {}),
  removeModule: vi.fn(async () => {}),
  resetModule: vi.fn(async () => {}),
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

async function renderApp() {
  render(<App />);
  await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('demo'));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  state.nodes = [node('osc1', OSC), node('vca1', VCA)];
});

describe('global right-click override', () => {
  it('suppresses the default context menu everywhere in the app', async () => {
    await renderApp();
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    const notCancelled = screen.getByTestId('engine-status').dispatchEvent(ev);
    expect(notCancelled).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('module context menu', () => {
  it('opens on right-click with Delete, Documentation, Reset and a disabled stub', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('module-osc1'), { clientX: 40, clientY: 60 });
    expect(screen.getByTestId('context-menu')).toBeTruthy();
    expect(screen.getByTestId('ctx-delete')).toBeTruthy();
    expect(screen.getByTestId('ctx-docs')).toBeTruthy();

    const reset = screen.getByTestId('ctx-reset') as HTMLButtonElement;
    expect(reset.disabled).toBe(false);

    // Save patch is visible but disabled with a hint.
    const savePatch = screen.getByTestId('ctx-save-patch') as HTMLButtonElement;
    expect(savePatch.disabled).toBe(true);
    expect(savePatch.textContent).toContain('not implemented');
  });

  it('Reset to defaults resets the module through the engine and closes the menu', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('module-vca1'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId('ctx-reset'));
    await waitFor(() => expect(fakeEngine.resetModule).toHaveBeenCalledWith('vca1'));
    // Non-structural: the module itself is not removed.
    expect(fakeEngine.removeModule).not.toHaveBeenCalled();
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('Delete removes the module through the engine and closes the menu', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('module-vca1'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId('ctx-delete'));
    await waitFor(() => expect(fakeEngine.removeModule).toHaveBeenCalledWith('vca1'));
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('disabled items do nothing and keep the menu open', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('module-osc1'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId('ctx-save-patch'));
    expect(screen.getByTestId('context-menu')).toBeTruthy();
    expect(fakeEngine.removeModule).not.toHaveBeenCalled();
    expect(fakeEngine.savePatchAs).not.toHaveBeenCalled();
  });

  it('Documentation opens the docs panel for the module type', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('module-osc1'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId('ctx-docs'));
    const panel = await screen.findByTestId('docs-panel');
    expect(panel.textContent).toContain('Oscillator');
    expect(panel.textContent).toContain('com.dj.oscillator');
    expect(screen.getByTestId('docs-summary').textContent).toMatch(/oscillator/i);
    // Jack rows derived from the manifest.
    expect(screen.getByTestId('docs-row-pitch')).toBeTruthy();
    expect(screen.getByTestId('docs-row-audio')).toBeTruthy();

    fireEvent.click(screen.getByTestId('docs-close'));
    expect(screen.queryByTestId('docs-panel')).toBeNull();
  });

  it('right-clicking a knob does NOT open the module context menu', async () => {
    await renderApp();
    // The knob's own right-click gesture (config menu) must not also pop
    // the module menu on top of it.
    const knob = screen.getByTestId('knob-pitch');
    fireEvent.contextMenu(knob.querySelector('.knob-dial') ?? knob, {
      clientX: 20,
      clientY: 20,
    });
    expect(screen.queryByTestId('context-menu')).toBeNull();
    // The knob config menu (the knob-specific gesture) still opens.
    expect(document.querySelector('.knob-config-menu')).toBeTruthy();
  });

  it('module-body right-click still opens the module menu after a knob click', async () => {
    await renderApp();
    const knob = screen.getByTestId('knob-pitch');
    fireEvent.contextMenu(knob.querySelector('.knob-dial') ?? knob);
    expect(screen.queryByTestId('context-menu')).toBeNull();
    fireEvent.contextMenu(screen.getByTestId('module-header-osc1'), { clientX: 5, clientY: 5 });
    expect(screen.getByTestId('ctx-delete')).toBeTruthy();
  });

  it('closes on Escape and on an outside mousedown', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('module-osc1'), { clientX: 10, clientY: 10 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('context-menu')).toBeNull();

    fireEvent.contextMenu(screen.getByTestId('module-osc1'), { clientX: 10, clientY: 10 });
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });
});

describe('background context menu', () => {
  it('shows just Save and saves under the current patch name', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('rack-area'), { clientX: 300, clientY: 200 });
    const menu = screen.getByTestId('context-menu');
    expect(menu).toBeTruthy();
    expect(screen.getByTestId('ctx-save')).toBeTruthy();
    // Only the one item — no module actions on the background.
    expect(menu.querySelectorAll('.context-menu-item')).toHaveLength(1);
    expect(screen.queryByTestId('ctx-delete')).toBeNull();

    fireEvent.click(screen.getByTestId('ctx-save'));
    await waitFor(() => expect(fakeEngine.savePatchAs).toHaveBeenCalledWith('demo'));
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('module right-click does not also open the background menu', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('module-osc1'), { clientX: 10, clientY: 10 });
    // The module menu is showing (Delete present), not the background one.
    expect(screen.getByTestId('ctx-delete')).toBeTruthy();
    expect(screen.queryByTestId('ctx-save')).toBeNull();
  });
});
