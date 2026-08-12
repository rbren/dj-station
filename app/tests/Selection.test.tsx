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
  copyModules: vi.fn(async (ids: string[]) => `CLIP:${ids.join(',')}`),
  pasteModules: vi.fn(async (_clip: string) => ({ osc1: 'osc2' })),
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
const press = (testId: string, opts: object = {}) =>
  fireEvent.mouseDown(screen.getByTestId(testId), { button: 0, ...opts });

describe('press-to-select', () => {
  it('plain press on a panel selects it; pressing another replaces the selection', async () => {
    await renderApp();
    press('module-osc1');
    expect(isSelected('osc1')).toBe(true);
    expect(isSelected('vca1')).toBe(false);

    press('module-vca1');
    expect(isSelected('osc1')).toBe(false);
    expect(isSelected('vca1')).toBe(true);
  });

  it('shift-press and cmd/ctrl-press toggle membership', async () => {
    await renderApp();
    press('module-osc1');
    press('module-vca1', { shiftKey: true });
    expect(isSelected('osc1')).toBe(true);
    expect(isSelected('vca1')).toBe(true);

    press('module-vca1', { ctrlKey: true });
    expect(isSelected('osc1')).toBe(true);
    expect(isSelected('vca1')).toBe(false);
  });

  it('pressing the rack background clears the selection', async () => {
    await renderApp();
    press('module-osc1');
    expect(isSelected('osc1')).toBe(true);
    press('rack-area');
    expect(isSelected('osc1')).toBe(false);
  });

  it('pressing a jack or a header button does not change the selection', async () => {
    await renderApp();
    press('jack-output-audio');
    fireEvent.click(screen.getByTestId('jack-output-audio'));
    expect(isSelected('osc1')).toBe(false);

    press('module-vca1');
    press('module-docs-osc1');
    expect(isSelected('osc1')).toBe(false);
    expect(isSelected('vca1')).toBe(true);
  });

  it('a header drag selects the module and keeps it selected on release', async () => {
    await renderApp();
    const header = screen.getByTestId('module-header-osc1');
    fireEvent.mouseDown(header, { button: 0, clientX: 10, clientY: 10 });
    expect(isSelected('osc1')).toBe(true);
    fireEvent.mouseMove(window, { clientX: 120, clientY: 90 });
    fireEvent.mouseUp(window);
    fireEvent.click(header, { clientX: 120, clientY: 90 });
    expect(isSelected('osc1')).toBe(true);
  });

  it('a plain press on a member of a multi-selection keeps the group (drag it as one)', async () => {
    await renderApp();
    press('module-osc1');
    press('module-vca1', { shiftKey: true });
    press('module-header-osc1');
    expect(isSelected('osc1')).toBe(true);
    expect(isSelected('vca1')).toBe(true);
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
    press('module-osc1');
    fireEvent.contextMenu(screen.getByTestId('module-vca1'), { clientX: 10, clientY: 10 });
    expect(isSelected('osc1')).toBe(false);
    expect(isSelected('vca1')).toBe(true);
  });

  it('right-click inside a multi-selection keeps the whole group', async () => {
    await renderApp();
    press('module-osc1');
    press('module-vca1', { shiftKey: true });
    fireEvent.contextMenu(screen.getByTestId('module-osc1'), { clientX: 10, clientY: 10 });
    expect(isSelected('osc1')).toBe(true);
    expect(isSelected('vca1')).toBe(true);
    expect(screen.getByTestId('ctx-copy').textContent).toContain('2 modules');
  });
});

describe('copy buffer follows the selection', () => {
  it('copy A, paste, copy B, paste pastes B (regression: wobbly click on B)', async () => {
    await renderApp();

    // Copy + paste module A.
    press('module-osc1');
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    await waitFor(() => expect(fakeEngine.copyModules).toHaveBeenLastCalledWith(['osc1']));
    state.nodes = [node('osc1', OSC), node('vca1', VCA), node('osc2', OSC)];
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    await waitFor(() => expect(fakeEngine.pasteModules).toHaveBeenLastCalledWith('CLIP:osc1'));
    await waitFor(() => expect(isSelected('osc2')).toBe(true));

    // Select module B with a slightly wobbly click (mousedown, small move,
    // mouseup) — exactly the gesture that used to be swallowed, leaving the
    // pasted A-copy selected and the clipboard stuck on A.
    const headerB = screen.getByTestId('module-header-vca1');
    fireEvent.mouseDown(headerB, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 14, clientY: 12 });
    fireEvent.mouseUp(window);
    expect(isSelected('vca1')).toBe(true);
    expect(isSelected('osc2')).toBe(false);

    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    await waitFor(() => expect(fakeEngine.copyModules).toHaveBeenLastCalledWith(['vca1']));
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    await waitFor(() => expect(fakeEngine.pasteModules).toHaveBeenLastCalledWith('CLIP:vca1'));
  });
});

describe('marquee select', () => {
  const rackArea = () => screen.getByTestId('rack-area');

  it('dragging on the background sweeps a rectangle and selects intersecting modules', async () => {
    await renderApp();
    // Default positions: osc1 at (0,0), vca1 one fallback-width to the
    // right (moduleRect fallback 192x96 in jsdom).
    fireEvent.mouseDown(rackArea(), { button: 0, clientX: 0, clientY: 0 });
    expect(screen.getByTestId('marquee')).toBeTruthy();
    fireEvent.mouseMove(window, { clientX: 100, clientY: 80 });
    const m = screen.getByTestId('marquee');
    expect(m.style.width).toBe('100px');
    expect(m.style.height).toBe('80px');
    fireEvent.mouseUp(window);
    expect(screen.queryByTestId('marquee')).toBeNull();
    expect(isSelected('osc1')).toBe(true);
    expect(isSelected('vca1')).toBe(false);
  });

  it('a wide sweep catches both; shift-sweep adds to the selection', async () => {
    await renderApp();
    press('module-vca1');
    fireEvent.mouseDown(rackArea(), { button: 0, clientX: 0, clientY: 0, shiftKey: true });
    fireEvent.mouseMove(window, { clientX: 100, clientY: 80 });
    fireEvent.mouseUp(window);
    // Shift kept vca1 and the sweep added osc1.
    expect(isSelected('osc1')).toBe(true);
    expect(isSelected('vca1')).toBe(true);
  });

  it('a motionless background press just clears (no marquee selection)', async () => {
    await renderApp();
    press('module-osc1');
    fireEvent.mouseDown(rackArea(), { button: 0, clientX: 5, clientY: 5 });
    fireEvent.mouseUp(window);
    expect(isSelected('osc1')).toBe(false);
    expect(isSelected('vca1')).toBe(false);
  });

  it('marquee-select then cmd+C copies the swept modules (regression)', async () => {
    await renderApp();
    // The sweep doubles as a text-selection drag in the browser: simulate
    // the native selection it used to leave behind, which made the old
    // cmd+C guard silently skip module copy.
    fireEvent.mouseDown(rackArea(), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 100, clientY: 80 });
    const stray = document.createElement('span');
    stray.textContent = 'swept-over label text';
    document.body.appendChild(stray);
    window.getSelection()?.selectAllChildren(stray);
    expect(window.getSelection()?.toString()).not.toBe('');
    fireEvent.mouseUp(window);
    expect(isSelected('osc1')).toBe(true);

    // Resolving the sweep cleared the text selection; copy targets modules.
    expect(window.getSelection()?.toString()).toBe('');
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    await waitFor(() => expect(fakeEngine.copyModules).toHaveBeenCalledWith(['osc1']));
    stray.remove();
  });

  it('cmd+C prefers the module selection even if a text selection lingers', async () => {
    await renderApp();
    press('module-osc1');
    const stray = document.createElement('span');
    stray.textContent = 'later highlight';
    document.body.appendChild(stray);
    window.getSelection()?.selectAllChildren(stray);
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    await waitFor(() => expect(fakeEngine.copyModules).toHaveBeenCalledWith(['osc1']));
    stray.remove();
  });
});

describe('group drag', () => {
  it('dragging one member moves the whole selection rigidly', async () => {
    await renderApp();
    press('module-osc1');
    press('module-vca1', { shiftKey: true });
    // Defaults: osc1 at (0,0), vca1 at (480,0) (defaultPosition column
    // pitch). Drag osc1's header by (+48, +96): both move by that delta.
    const header = screen.getByTestId('module-header-osc1');
    fireEvent.mouseDown(header, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 48, clientY: 96 });
    fireEvent.mouseUp(window);
    const osc = screen.getByTestId('module-osc1');
    const vca = screen.getByTestId('module-vca1');
    expect({ x: osc.style.left, y: osc.style.top }).toEqual({ x: '48px', y: '96px' });
    expect({ x: vca.style.left, y: vca.style.top }).toEqual({ x: '528px', y: '96px' });
  });
});

describe('paste arrangement', () => {
  it('pasted modules keep their relative arrangement as one group', async () => {
    fakeEngine.pasteModules.mockImplementationOnce(async () => ({
      osc1: 'osc2',
      vca1: 'vca2',
    }));
    await renderApp();
    press('module-osc1');
    press('module-vca1', { shiftKey: true });
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    await waitFor(() => expect(fakeEngine.copyModules).toHaveBeenCalled());

    state.nodes = [node('osc1', OSC), node('vca1', VCA), node('osc2', OSC), node('vca2', VCA)];
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('module-osc2')).toBeTruthy());
    await waitFor(() => expect(isSelected('osc2')).toBe(true));

    // Sources sit at (0,0) and (480,0): the pasted pair must preserve the
    // 480px horizontal offset whatever anchor the group landed on.
    const osc2 = screen.getByTestId('module-osc2');
    const vca2 = screen.getByTestId('module-vca2');
    const dx = parseFloat(vca2.style.left) - parseFloat(osc2.style.left);
    const dy = parseFloat(vca2.style.top) - parseFloat(osc2.style.top);
    expect(dx).toBe(480);
    expect(dy).toBe(0);
  });
});

describe('stale-selection pruning', () => {
  it('an engine refresh drops selected modules that no longer exist', async () => {
    await renderApp();
    press('module-osc1');
    press('module-vca1', { shiftKey: true });

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
    press('module-osc1');
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
