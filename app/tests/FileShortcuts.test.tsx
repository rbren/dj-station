// File-menu keyboard shortcuts (cmd/ctrl+S/O/N -> Save / Open… / New Patch,
// src/fileShortcuts.ts): they reuse the File-menu actions (so New inherits
// the unsaved-changes prompt) and stay quiet while typing in a form control
// or while a modal dialog owns the keyboard.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearErrors } from '../src/errors';
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
  currentPatch: vi.fn(async () => 'demo'),
  listPatches: vi.fn(async () => ['demo', 'live-set']),
  savePatchAs: vi.fn(async () => {}),
  loadPatchByName: vi.fn(async (): Promise<string[]> => []),
  newPatch: vi.fn(async () => {}),
  patchDirty: vi.fn(async () => false),
  endEdit: vi.fn(async () => {}),
  moveModules: vi.fn(async () => {}),
  syncPositions: vi.fn(async () => {}),
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
  clearErrors();
  localStorage.clear();
  state.nodes = [node('osc1', OSC)];
  state.wires = [];
});

async function renderApp() {
  render(<App />);
  await waitFor(() => expect(screen.getByTestId('module-osc1')).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId('patch-title').textContent).toBe('demo'));
}

describe('file shortcuts', () => {
  it('cmd/ctrl+S saves the patch under its current name', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(fakeEngine.savePatchAs).toHaveBeenCalledWith('demo'));
  });

  it('cmd/ctrl+O opens the Open Patch dialog', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'o', metaKey: true });
    await screen.findByTestId('file-dialog-patch-live-set');
  });

  it('cmd/ctrl+N on a clean patch starts a new patch immediately', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'n', metaKey: true });
    await waitFor(() => expect(fakeEngine.newPatch).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('unsaved-dialog')).toBeNull();
  });

  it('cmd/ctrl+N with unsaved changes runs the prompt flow first', async () => {
    fakeEngine.patchDirty.mockResolvedValue(true);
    await renderApp();
    fireEvent.keyDown(window, { key: 'n', metaKey: true });
    await screen.findByTestId('unsaved-dialog');
    expect(fakeEngine.newPatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('unsaved-discard'));
    await waitFor(() => expect(fakeEngine.newPatch).toHaveBeenCalledTimes(1));
  });

  it('stays quiet while typing in a text input', async () => {
    await renderApp();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: 's', metaKey: true });
    fireEvent.keyDown(input, { key: 'o', metaKey: true });
    fireEvent.keyDown(input, { key: 'n', metaKey: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(fakeEngine.savePatchAs).not.toHaveBeenCalled();
    expect(fakeEngine.newPatch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('file-dialog')).toBeNull();
    input.remove();
  });

  it('stays quiet while a modal dialog owns the keyboard', async () => {
    fakeEngine.patchDirty.mockResolvedValue(true);
    await renderApp();
    fireEvent.keyDown(window, { key: 'o', metaKey: true });
    await screen.findByTestId('file-dialog');
    // The Open dialog is up: S/N on the window must not save or stack the
    // unsaved-changes prompt on top of it.
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    fireEvent.keyDown(window, { key: 'n', metaKey: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(fakeEngine.savePatchAs).not.toHaveBeenCalled();
    expect(screen.queryByTestId('unsaved-dialog')).toBeNull();
  });

  it('leaves modified combos (cmd+shift+S) alone', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'S', metaKey: true, shiftKey: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(fakeEngine.savePatchAs).not.toHaveBeenCalled();
  });
});
