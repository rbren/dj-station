// Undo/redo for module MOVES and DELETES (layout restore):
// - a completed drag gesture commits to the engine as ONE move_modules
//   batch (pre-drag `from` + drop `to`; bumped neighbours and macro/group
//   members ride in the same batch — one undo step per drag);
// - a no-op drag (released where it started) commits nothing;
// - deletes seed the engine layout (sync_positions, no undo step) BEFORE
//   remove_modules, so undoing the delete has positions to restore;
// - refresh adopts engine-known positions: after undo/redo the panels move
//   to the restored spots (nodes without an engine position keep local).
//
// jsdom panels use moduleRect's nominal 4×2-cell fallback (192×96 px).

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MacroGroup, ModuleMove } from '../src/engine';
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

const state = {
  nodes: [] as unknown[],
  macroGroups: [] as MacroGroup[],
  undone: false,
};

const fakeEngine = {
  loadDemoPatch: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  listModules: vi.fn(async () => [OSC]),
  nodes: vi.fn(async () => state.nodes),
  wires: vi.fn(async () => []),
  tap: vi.fn(async () => null),
  tapAll: vi.fn(async () => ({})),
  macroGroups: vi.fn(async () => state.macroGroups),
  macroLayout: vi.fn(async () => ({})),
  breakMacro: vi.fn(async () => ({})),
  addModule: vi.fn(async () => {}),
  currentPatch: vi.fn(async () => null),
  listPatches: vi.fn(async () => []),
  savePatchAs: vi.fn(async () => {}),
  removeModule: vi.fn(async () => {}),
  removeModules: vi.fn(async () => {}),
  endEdit: vi.fn(async () => {}),
  undo: vi.fn(async () => true),
  redo: vi.fn(async () => true),
  moveModules: vi.fn(async (_moves: ModuleMove[]) => {}),
  syncPositions: vi.fn(async () => {}),
};

vi.mock('../src/engine', () => ({
  engine: new Proxy(
    {},
    { get: (_t, prop) => fakeEngine[prop as keyof typeof fakeEngine] ?? vi.fn(async () => null) },
  ),
  onMenuAction: () => () => {},
}));

import App from '../src/App';

function node(instance: string, position?: [number, number]) {
  return {
    instance_id: instance,
    type_id: OSC.id,
    manifest: OSC,
    knobs: {},
    params: {},
    wired_inputs: [],
    midi_mappings: [],
    ...(position ? { position } : {}),
  };
}

function setPositions(positions: Record<string, { x: number; y: number }>) {
  localStorage.setItem('dj-rack-positions', JSON.stringify(positions));
}

function savedPositions(): Record<string, { x: number; y: number }> {
  return JSON.parse(localStorage.getItem('dj-rack-positions') ?? '{}');
}

function panelPos(instance: string): { x: number; y: number } {
  const el = screen.getByTestId(`module-${instance}`);
  return { x: parseInt(el.style.left, 10), y: parseInt(el.style.top, 10) };
}

async function renderApp(instances: string[]) {
  state.nodes = instances.map((i) => node(i));
  render(<App />);
  for (const i of instances) {
    await waitFor(() => expect(screen.getByTestId(`module-${i}`)).toBeTruthy());
  }
}

/** mousedown on a module header at a fixed pointer origin. */
function grab(instance: string, at = { x: 500, y: 500 }) {
  fireEvent.mouseDown(screen.getByTestId(`module-header-${instance}`), {
    button: 0,
    clientX: at.x,
    clientY: at.y,
  });
  return at;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  state.nodes = [];
  state.macroGroups = [];
});

describe('drag gestures commit as one undo step', () => {
  it('a completed drag sends ONE move_modules batch with from/to', async () => {
    setPositions({ a: { x: 0, y: 0 } });
    await renderApp(['a']);
    const at = grab('a');
    // Stream several intermediate positions — still one batch on release.
    fireEvent.mouseMove(window, { clientX: at.x + 48, clientY: at.y });
    fireEvent.mouseMove(window, { clientX: at.x + 96, clientY: at.y + 48 });
    expect(fakeEngine.moveModules).not.toHaveBeenCalled();
    fireEvent.mouseUp(window);
    expect(fakeEngine.moveModules).toHaveBeenCalledTimes(1);
    expect(fakeEngine.moveModules).toHaveBeenCalledWith([
      { instance: 'a', from: [0, 0], to: [96, 48] },
    ]);

    // A second drag is its own batch (its own undo step).
    const at2 = grab('a');
    fireEvent.mouseMove(window, { clientX: at2.x, clientY: at2.y + 96 });
    fireEvent.mouseUp(window);
    expect(fakeEngine.moveModules).toHaveBeenCalledTimes(2);
    expect(fakeEngine.moveModules).toHaveBeenLastCalledWith([
      { instance: 'a', from: [96, 48], to: [96, 144] },
    ]);
  });

  it('a drag released where it started commits nothing', async () => {
    setPositions({ a: { x: 0, y: 0 } });
    await renderApp(['a']);
    const at = grab('a');
    fireEvent.mouseMove(window, { clientX: at.x + 96, clientY: at.y });
    fireEvent.mouseMove(window, { clientX: at.x, clientY: at.y });
    fireEvent.mouseUp(window);
    expect(fakeEngine.moveModules).not.toHaveBeenCalled();
  });

  it('a surviving co-operative bump rides in the same batch', async () => {
    // a | b | c packed tight: dragging a right past b bumps b left.
    setPositions({ a: { x: 0, y: 0 }, b: { x: 192, y: 0 }, c: { x: 384, y: 0 } });
    await renderApp(['a', 'b', 'c']);
    const at = grab('a');
    fireEvent.mouseMove(window, { clientX: at.x + 240, clientY: at.y });
    fireEvent.mouseUp(window);
    expect(fakeEngine.moveModules).toHaveBeenCalledTimes(1);
    const batch = fakeEngine.moveModules.mock.calls[0][0];
    expect(batch).toContainEqual({ instance: 'a', from: [0, 0], to: [192, 0] });
    expect(batch).toContainEqual({ instance: 'b', from: [192, 0], to: [0, 0] });
    expect(batch).toHaveLength(2); // c never moved
  });

  it('dragging a macro member commits the whole group in one batch', async () => {
    state.macroGroups = [
      { instance: 'm1', macro_id: 'macro.tone', name: 'Tone', members: ['m1/osc', 'm1/vca'] },
    ];
    setPositions({ 'm1/osc': { x: 0, y: 0 }, 'm1/vca': { x: 192, y: 0 } });
    await renderApp(['m1/osc', 'm1/vca']);
    const at = grab('m1/osc');
    fireEvent.mouseMove(window, { clientX: at.x, clientY: at.y + 240 });
    fireEvent.mouseUp(window);
    expect(fakeEngine.moveModules).toHaveBeenCalledTimes(1);
    const batch = fakeEngine.moveModules.mock.calls[0][0];
    expect(batch.map((m) => m.instance).sort()).toEqual(['m1/osc', 'm1/vca']);
  });
});

describe('deletes seed the engine layout for undo', () => {
  it('sync_positions carries the doomed spots BEFORE remove_modules', async () => {
    setPositions({ a: { x: 96, y: 144 } });
    await renderApp(['a']);
    const calls: string[] = [];
    fakeEngine.syncPositions.mockImplementation(async () => {
      calls.push('sync');
    });
    fakeEngine.removeModules.mockImplementation(async () => {
      calls.push('remove');
    });
    fireEvent.mouseDown(screen.getByTestId('module-header-a'), { shiftKey: true });
    fireEvent.keyDown(window, { key: 'Backspace' });
    await waitFor(() => expect(fakeEngine.removeModules).toHaveBeenCalledWith(['a']));
    expect(fakeEngine.syncPositions).toHaveBeenCalledWith({ a: [96, 144] });
    // Seed strictly before the delete (later fixup syncs may follow).
    expect(calls.slice(0, 2)).toEqual(['sync', 'remove']);
  });

  it('deleting a macro member seeds every member of the group', async () => {
    state.macroGroups = [
      { instance: 'm1', macro_id: 'macro.tone', name: 'Tone', members: ['m1/osc', 'm1/vca'] },
    ];
    setPositions({ 'm1/osc': { x: 0, y: 0 }, 'm1/vca': { x: 192, y: 0 } });
    await renderApp(['m1/osc', 'm1/vca']);
    fireEvent.mouseDown(screen.getByTestId('module-header-m1/osc'), { shiftKey: true });
    fireEvent.keyDown(window, { key: 'Backspace' });
    // The whole instance deletes (all-or-nothing), members' spots seeded.
    await waitFor(() => expect(fakeEngine.removeModules).toHaveBeenCalledWith(['m1']));
    expect(fakeEngine.syncPositions).toHaveBeenCalledWith({
      'm1/osc': [0, 0],
      'm1/vca': [192, 0],
    });
  });
});

describe('refresh adopts engine-known positions (undo/redo restore)', () => {
  it('ctrl+Z moves panels to the engine-restored spots and persists them', async () => {
    setPositions({ a: { x: 192, y: 96 } });
    await renderApp(['a']);
    expect(panelPos('a')).toEqual({ x: 192, y: 96 });
    // The undo restore puts a back at (0, 0) engine-side; the post-undo
    // refresh must adopt it.
    state.nodes = [node('a', [0, 0])];
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(fakeEngine.undo).toHaveBeenCalled());
    await waitFor(() => expect(panelPos('a')).toEqual({ x: 0, y: 0 }));
    expect(savedPositions().a).toEqual({ x: 0, y: 0 });
  });

  it('nodes without an engine position keep their local layout', async () => {
    setPositions({ a: { x: 192, y: 96 }, b: { x: 576, y: 96 } });
    await renderApp(['a', 'b']);
    state.nodes = [node('a', [0, 0]), node('b')];
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(panelPos('a')).toEqual({ x: 0, y: 0 }));
    expect(panelPos('b')).toEqual({ x: 576, y: 96 });
    expect(savedPositions().b).toEqual({ x: 576, y: 96 });
  });

  it('an undone delete brings the module back at its restored spot', async () => {
    setPositions({ a: { x: 0, y: 0 }, b: { x: 384, y: 192 } });
    await renderApp(['a', 'b']);
    // Delete b...
    fireEvent.mouseDown(screen.getByTestId('module-header-b'), { shiftKey: true });
    fireEvent.keyDown(window, { key: 'Backspace' });
    state.nodes = [node('a')];
    await waitFor(() => expect(fakeEngine.removeModules).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('module-b')).toBeNull());
    expect(savedPositions().b).toBeUndefined();
    // ...then undo: the engine restores b with its seeded position.
    state.nodes = [node('a'), node('b', [384, 192])];
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId('module-b')).toBeTruthy());
    await waitFor(() => expect(panelPos('b')).toEqual({ x: 384, y: 192 }));
  });
});
