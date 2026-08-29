// Right-click context menus: the browser menu is suppressed globally;
// right-clicking a module shows Delete / Documentation / Reset to defaults
// / a disabled stub, right-clicking the rack background mirrors the File
// menu (New / Save / Save As / Open). Documentation opens the in-app docs
// panel.

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

/** A module that ships built-in presets (manifest `presets`). */
const SPECTRAL: Manifest = {
  id: 'com.dj.spectral_noise',
  name: 'Spectral Noise',
  version: '0.1.0',
  abi: 'wasm-1',
  inputs: [
    { id: 'tilt', name: 'Tilt' },
    { id: 'pivot', name: 'Tilt Freq' },
    { id: 'curve', name: 'Curvature' },
  ],
  outputs: [{ id: 'out', name: 'Out' }],
  params: [],
  presets: [
    { name: 'White', values: { tilt: 0, pivot: 1.9344, curve: 0 } },
    { name: 'Pink', values: { tilt: -3, pivot: 1.9344, curve: 0 } },
    { name: 'Red / brown', values: { tilt: -6, pivot: 1.9344, curve: 0 } },
  ],
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
  macroGroups: vi.fn(async () => []),
  macroLayout: vi.fn(async () => ({})),
  breakMacro: vi.fn(async () => ({})),
  currentPatch: vi.fn(async () => 'demo'),
  listPatches: vi.fn(async () => ['demo']),
  savePatchAs: vi.fn(async () => {}),
  newPatch: vi.fn(async () => {}),
  patchDirty: vi.fn(async () => false),
  removeModule: vi.fn(async () => {}),
  removeModules: vi.fn(async () => {}),
  resetModule: vi.fn(async () => {}),
  resetModules: vi.fn(async () => {}),
  applyPreset: vi.fn(async () => {}),
  copyModules: vi.fn(async () => 'CLIP'),
  pasteModules: vi.fn(async () => ({})),
  endEdit: vi.fn(async () => {}),
  moveModules: vi.fn(async () => {}),
  syncPositions: vi.fn(async () => {}),
  setKnobConfig: vi.fn(async () => {}),
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
  it('opens on right-click with Copy, Paste, Delete, Documentation and Reset', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('module-osc1'), { clientX: 40, clientY: 60 });
    expect(screen.getByTestId('context-menu')).toBeTruthy();
    expect(screen.getByTestId('ctx-copy')).toBeTruthy();
    expect(screen.getByTestId('ctx-delete')).toBeTruthy();
    expect(screen.getByTestId('ctx-docs')).toBeTruthy();

    const reset = screen.getByTestId('ctx-reset') as HTMLButtonElement;
    expect(reset.disabled).toBe(false);

    // Paste is visible but disabled until something has been copied.
    const paste = screen.getByTestId('ctx-paste') as HTMLButtonElement;
    expect(paste.disabled).toBe(true);
  });

  it('Reset to defaults resets the module through the engine and closes the menu', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('module-vca1'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId('ctx-reset'));
    await waitFor(() => expect(fakeEngine.resetModules).toHaveBeenCalledWith(['vca1']));
    // Non-structural: the module itself is not removed.
    expect(fakeEngine.removeModules).not.toHaveBeenCalled();
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('Delete removes the module through the engine and closes the menu', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('module-vca1'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId('ctx-delete'));
    await waitFor(() => expect(fakeEngine.removeModules).toHaveBeenCalledWith(['vca1']));
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('disabled items do nothing and keep the menu open', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('module-osc1'), { clientX: 10, clientY: 10 });
    // Paste is disabled until something has been copied.
    fireEvent.click(screen.getByTestId('ctx-paste'));
    expect(screen.getByTestId('context-menu')).toBeTruthy();
    expect(fakeEngine.pasteModules).not.toHaveBeenCalled();
    expect(fakeEngine.removeModules).not.toHaveBeenCalled();
  });

  it('Copy then Paste round-trips through the engine clipboard', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('module-osc1'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId('ctx-copy'));
    await waitFor(() => expect(fakeEngine.copyModules).toHaveBeenCalledWith(['osc1']));

    fireEvent.contextMenu(screen.getByTestId('rack-area'), { clientX: 200, clientY: 200 });
    const paste = screen.getByTestId('ctx-paste') as HTMLButtonElement;
    expect(paste.disabled).toBe(false);
    fireEvent.click(paste);
    await waitFor(() => expect(fakeEngine.pasteModules).toHaveBeenCalledWith('CLIP'));
  });

  it('right-click inside a multi-selection acts on the whole group', async () => {
    await renderApp();
    // Shift-click both module headers to build the selection.
    fireEvent.mouseDown(screen.getByTestId('module-header-osc1'), { shiftKey: true });
    fireEvent.mouseDown(screen.getByTestId('module-header-vca1'), { shiftKey: true });
    fireEvent.contextMenu(screen.getByTestId('module-osc1'), { clientX: 10, clientY: 10 });
    expect(screen.getByTestId('ctx-copy').textContent).toContain('2 modules');
    // No per-module Documentation entry for a group.
    expect(screen.queryByTestId('ctx-docs')).toBeNull();
    fireEvent.click(screen.getByTestId('ctx-delete'));
    await waitFor(() => expect(fakeEngine.removeModules).toHaveBeenCalledWith(['osc1', 'vca1']));
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

describe('module presets submenu', () => {
  /** Rack with a preset-carrying module beside the plain ones. */
  async function renderWithPresets() {
    state.nodes = [node('osc1', OSC), node('vca1', VCA), node('snoise1', SPECTRAL)];
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('module-snoise1')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('demo'));
  }

  it('lists the manifest presets and applies the one clicked', async () => {
    await renderWithPresets();
    fireEvent.contextMenu(screen.getByTestId('module-snoise1'), { clientX: 20, clientY: 20 });
    // The submenu is closed until its parent row is opened.
    expect(screen.queryByTestId('ctx-preset-pink')).toBeNull();

    fireEvent.click(screen.getByTestId('ctx-presets'));
    expect(screen.getByTestId('ctx-presets-menu')).toBeTruthy();
    expect(screen.getByTestId('ctx-preset-white')).toBeTruthy();
    expect(screen.getByTestId('ctx-preset-red-brown').textContent).toContain('Red / brown');

    fireEvent.click(screen.getByTestId('ctx-preset-pink'));
    await waitFor(() => expect(fakeEngine.applyPreset).toHaveBeenCalledWith('snoise1', 'Pink'));
    // Recalling a preset closes the menu like any other action, and never
    // touches the module's structure.
    expect(screen.queryByTestId('context-menu')).toBeNull();
    expect(fakeEngine.resetModules).not.toHaveBeenCalled();
    expect(fakeEngine.removeModules).not.toHaveBeenCalled();
  });

  it('opens on hover and closes again when the pointer moves to another row', async () => {
    await renderWithPresets();
    fireEvent.contextMenu(screen.getByTestId('module-snoise1'), { clientX: 20, clientY: 20 });
    fireEvent.mouseEnter(screen.getByTestId('ctx-presets'));
    expect(screen.getByTestId('ctx-preset-white')).toBeTruthy();
    fireEvent.mouseEnter(screen.getByTestId('ctx-delete'));
    expect(screen.queryByTestId('ctx-preset-white')).toBeNull();
  });

  it('modules without presets get no Presets row, and neither does a group', async () => {
    await renderWithPresets();
    fireEvent.contextMenu(screen.getByTestId('module-osc1'), { clientX: 10, clientY: 10 });
    expect(screen.queryByTestId('ctx-presets')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });

    // A multi-selection acts on the whole group, and a preset belongs to
    // one module.
    fireEvent.mouseDown(screen.getByTestId('module-header-snoise1'), { shiftKey: true });
    fireEvent.mouseDown(screen.getByTestId('module-header-osc1'), { shiftKey: true });
    fireEvent.contextMenu(screen.getByTestId('module-snoise1'), { clientX: 10, clientY: 10 });
    expect(screen.getByTestId('ctx-copy').textContent).toContain('2 modules');
    expect(screen.queryByTestId('ctx-presets')).toBeNull();
  });
});

describe('background context menu', () => {
  it('mirrors the File menu (plus Add Module / Paste)', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('rack-area'), { clientX: 300, clientY: 200 });
    const menu = screen.getByTestId('context-menu');
    expect(menu).toBeTruthy();
    expect(screen.getByTestId('ctx-add-module')).toBeTruthy();
    expect(screen.getByTestId('ctx-paste')).toBeTruthy();
    expect(screen.getByTestId('ctx-new-patch')).toBeTruthy();
    expect(screen.getByTestId('ctx-save')).toBeTruthy();
    expect(screen.getByTestId('ctx-save-as')).toBeTruthy();
    expect(screen.getByTestId('ctx-open')).toBeTruthy();
    // Add Module + Paste plus exactly the File-menu items — no module
    // actions here.
    expect(menu.querySelectorAll('.context-menu-item')).toHaveLength(6);
    expect(screen.queryByTestId('ctx-delete')).toBeNull();

    fireEvent.click(screen.getByTestId('ctx-save'));
    await waitFor(() => expect(fakeEngine.savePatchAs).toHaveBeenCalledWith('demo'));
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('New Patch resets the engine and the patch name', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('rack-area'), { clientX: 300, clientY: 200 });
    fireEvent.click(screen.getByTestId('ctx-new-patch'));
    await waitFor(() => expect(fakeEngine.newPatch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('untitled'));
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('Save As / Open open the same dialogs as the File menu', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('rack-area'), { clientX: 300, clientY: 200 });
    fireEvent.click(screen.getByTestId('ctx-save-as'));
    expect(await screen.findByTestId('file-dialog-name')).toBeTruthy();
    fireEvent.click(screen.getByTestId('file-dialog-cancel'));

    fireEvent.contextMenu(screen.getByTestId('rack-area'), { clientX: 300, clientY: 200 });
    fireEvent.click(screen.getByTestId('ctx-open'));
    expect(await screen.findByTestId('file-dialog')).toBeTruthy();
    expect(screen.getByTestId('file-dialog-patch-demo')).toBeTruthy();
  });

  it('module right-click does not also open the background menu', async () => {
    await renderApp();
    fireEvent.contextMenu(screen.getByTestId('module-osc1'), { clientX: 10, clientY: 10 });
    // The module menu is showing (Delete present), not the background one.
    expect(screen.getByTestId('ctx-delete')).toBeTruthy();
    expect(screen.queryByTestId('ctx-save')).toBeNull();
  });
});

// The input right-click menu is PORTALED to document.body, but React
// dispatches its events along the React tree — so they reach the rack
// background's handlers, which must ignore them (they aren't presses on
// the background). Getting this wrong preventDefault()s the mousedown and
// the native <select> popup never opens.
describe('input right-click menu (portal)', () => {
  const openKnobMenu = () => {
    const knob = screen.getByTestId('knob-pitch');
    fireEvent.contextMenu(knob.querySelector('.knob-dial') ?? knob, { clientX: 20, clientY: 20 });
    expect(document.querySelector('.knob-config-menu')).toBeTruthy();
  };

  it('a press on a menu dropdown keeps its default action (the popup opens)', async () => {
    await renderApp();
    openKnobMenu();
    for (const label of ['knob style', 'knob curve']) {
      const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
      screen.getByLabelText(label).dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    }
    // The press also must not dismiss the menu it landed in.
    expect(document.querySelector('.knob-config-menu')).toBeTruthy();
  });

  it('a press inside the menu neither clears the selection nor sweeps a marquee', async () => {
    await renderApp();
    fireEvent.mouseDown(screen.getByTestId('module-osc1'), { button: 0 });
    expect(screen.getByTestId('module-osc1').dataset.selected).toBe('true');
    openKnobMenu();
    fireEvent.mouseDown(screen.getByLabelText('knob style'), {
      button: 0,
      clientX: 20,
      clientY: 40,
    });
    expect(screen.getByTestId('module-osc1').dataset.selected).toBe('true');
    fireEvent.mouseMove(window, { clientX: 400, clientY: 400 });
    expect(screen.queryByTestId('marquee')).toBeNull();
    fireEvent.mouseUp(window, { clientX: 400, clientY: 400 });
  });

  it('picking a dropdown value commits it to the engine', async () => {
    await renderApp();
    openKnobMenu();
    const select = screen.getByLabelText('knob style') as HTMLSelectElement;
    fireEvent.mouseDown(select, { button: 0 });
    fireEvent.change(select, { target: { value: 'stepped' } });
    await waitFor(() =>
      expect(fakeEngine.setKnobConfig).toHaveBeenCalledWith(
        'osc1',
        'pitch',
        expect.objectContaining({ style: 'stepped' }),
      ),
    );
  });
});
