// Collapse-to-macro UI flow (M4, PRD §6): shift-click multi-select,
// "Collapse to Macro" naming form calling the engine bridge, and the
// macro library section instantiating macros by id.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../src/types';
import type { CollapseOutcome, MacroGroup } from '../src/engine';

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

const TONE_MACRO: Manifest = {
  id: 'macro.tone',
  name: 'Tone',
  version: '1',
  abi: 'macro-1',
  inputs: [
    { id: 'pitch', name: 'pitch' },
    { id: 'level', name: 'level' },
  ],
  outputs: [{ id: 'out', name: 'out' }],
  params: [],
};

const state = {
  nodes: [] as unknown[],
  wires: [] as unknown[],
  modules: [OSC, VCA] as Manifest[],
};

const fakeEngine = {
  loadDemoPatch: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  listModules: vi.fn(async () => state.modules),
  nodes: vi.fn(async () => state.nodes),
  wires: vi.fn(async () => state.wires),
  tap: vi.fn(async () => null),
  tapAll: vi.fn(async () => ({})),
  macroGroups: vi.fn<() => Promise<MacroGroup[]>>(async () => []),
  macroLayout: vi.fn(async () => ({})),
  breakMacro: vi.fn(async () => ({})),
  addModule: vi.fn(async () => {}),
  collapseMacro: vi.fn(async (): Promise<CollapseOutcome> => ({
    instance: 'my-tone',
    conflict: null,
  })),
  renameMacro: vi.fn(async () => null),
  deleteMacro: vi.fn(async () => null),
  setParam: vi.fn(async () => {}),
  setKnobPosition: vi.fn(async () => {}),
  setKnobConfig: vi.fn(async () => {}),
  setAttenOffset: vi.fn(async () => {}),
  setKnobWireStyle: vi.fn(async () => {}),
  connectWire: vi.fn(async () => {}),
  disconnectWire: vi.fn(async () => {}),
  currentPatch: vi.fn(async () => 'demo'),
  listPatches: vi.fn(async () => ['demo']),
  savePatchAs: vi.fn(async () => {}),
  loadPatchByName: vi.fn(async () => {}),
  removeModule: vi.fn(async () => {}),
  removeModules: vi.fn(async () => {}),
  copyModules: vi.fn(async () => 'clipboard'),
  resetModules: vi.fn(async () => {}),
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
  state.wires = [];
  state.modules = [OSC, VCA];
  // clearAllMocks keeps mockResolvedValue overrides; restore defaults.
  fakeEngine.macroGroups.mockResolvedValue([]);
  fakeEngine.macroLayout.mockResolvedValue({});
  fakeEngine.breakMacro.mockResolvedValue({});
});

async function selectBoth() {
  render(<App />);
  await screen.findByTestId('module-osc1');
  fireEvent.mouseDown(screen.getByTestId('module-header-osc1'), { shiftKey: true });
  fireEvent.mouseDown(screen.getByTestId('module-header-vca1'), { shiftKey: true });
}

describe('collapse-to-macro UI', () => {
  it('shift-click selects modules and shows the collapse button', async () => {
    await selectBoth();
    expect(screen.getByTestId('module-osc1').dataset.selected).toBe('true');
    expect(screen.getByTestId('module-vca1').dataset.selected).toBe('true');
    expect(screen.getByTestId('collapse-macro-btn').textContent).toContain('(2)');
    // Shift-click again deselects.
    fireEvent.mouseDown(screen.getByTestId('module-header-vca1'), { shiftKey: true });
    expect(screen.getByTestId('module-vca1').dataset.selected).toBeUndefined();
    expect(screen.getByTestId('collapse-macro-btn').textContent).toContain('(1)');
  });

  it('plain press on an unselected module replaces the selection', async () => {
    await selectBoth();
    // Shrink the selection to vca1, then a plain press on osc1 (outside
    // the selection) must replace it with just osc1.
    fireEvent.mouseDown(screen.getByTestId('module-header-osc1'), { shiftKey: true });
    expect(screen.getByTestId('module-osc1').dataset.selected).toBeUndefined();
    fireEvent.mouseDown(screen.getByTestId('module-header-osc1'), { button: 0 });
    expect(screen.getByTestId('module-osc1').dataset.selected).toBe('true');
    expect(screen.getByTestId('module-vca1').dataset.selected).toBeUndefined();
    expect(screen.getByTestId('collapse-macro-btn').textContent).toContain('(1)');
  });

  it('naming and confirming collapses the selection via the engine', async () => {
    await selectBoth();
    fireEvent.click(screen.getByTestId('collapse-macro-btn'));
    fireEvent.change(screen.getByTestId('collapse-macro-name'), {
      target: { value: 'My Tone' },
    });
    fireEvent.click(screen.getByTestId('collapse-macro-confirm'));
    await waitFor(() =>
      expect(fakeEngine.collapseMacro).toHaveBeenCalledWith(
        ['osc1', 'vca1'],
        'My Tone',
        // Each collapsed module's rack position rides along so the macro
        // definition remembers the arrangement.
        expect.objectContaining({
          osc1: [expect.any(Number), expect.any(Number)],
          vca1: [expect.any(Number), expect.any(Number)],
        }),
        undefined,
      ),
    );
    // Selection cleared and the module library refetched (macros appear).
    await waitFor(() => expect(screen.queryByTestId('collapse-macro-btn')).toBeNull());
    expect(fakeEngine.listModules.mock.calls.length).toBeGreaterThan(1);
  });

  it('escape cancels selection and the naming form', async () => {
    await selectBoth();
    fireEvent.click(screen.getByTestId('collapse-macro-btn'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('collapse-macro-form')).toBeNull();
    expect(screen.queryByTestId('collapse-macro-btn')).toBeNull();
    expect(screen.getByTestId('module-osc1').dataset.selected).toBeUndefined();
  });

  it('macros list in their own library section and instantiate on click', async () => {
    state.modules = [OSC, VCA, TONE_MACRO];
    render(<App />);
    await screen.findByTestId('add-module-btn');
    fireEvent.click(screen.getByTestId('add-module-btn'));
    await screen.findByTestId('picker-category-Macros');
    fireEvent.click(screen.getByTestId('library-add-macro.tone'));
    await waitFor(() =>
      expect(fakeEngine.addModule).toHaveBeenCalledWith(
        expect.stringMatching(/^tone/),
        'macro.tone',
      ),
    );
  });

  it('same-named macro prompts before overwriting; confirm retries with overwrite', async () => {
    fakeEngine.collapseMacro.mockResolvedValueOnce({
      instance: null,
      conflict: { id: 'macro.my-tone', name: 'My Tone', version: 3 },
    });
    await selectBoth();
    fireEvent.click(screen.getByTestId('collapse-macro-btn'));
    fireEvent.change(screen.getByTestId('collapse-macro-name'), {
      target: { value: 'My Tone' },
    });
    fireEvent.click(screen.getByTestId('collapse-macro-confirm'));
    // Conflict: confirm dialog appears, nothing collapsed yet, the naming
    // form stays up behind it.
    await screen.findByTestId('macro-overwrite-dialog');
    expect(screen.getByTestId('collapse-macro-form')).toBeTruthy();
    fireEvent.click(screen.getByTestId('macro-overwrite-confirm'));
    await waitFor(() =>
      expect(fakeEngine.collapseMacro).toHaveBeenLastCalledWith(
        ['osc1', 'vca1'],
        'My Tone',
        expect.any(Object),
        true,
      ),
    );
    await waitFor(() => expect(screen.queryByTestId('macro-overwrite-dialog')).toBeNull());
  });

  it('cancelling the overwrite prompt keeps the macro and the naming form', async () => {
    fakeEngine.collapseMacro.mockResolvedValueOnce({
      instance: null,
      conflict: { id: 'macro.my-tone', name: 'My Tone', version: 3 },
    });
    await selectBoth();
    fireEvent.click(screen.getByTestId('collapse-macro-btn'));
    fireEvent.change(screen.getByTestId('collapse-macro-name'), {
      target: { value: 'My Tone' },
    });
    fireEvent.click(screen.getByTestId('collapse-macro-confirm'));
    await screen.findByTestId('macro-overwrite-dialog');
    fireEvent.click(screen.getByTestId('macro-overwrite-cancel'));
    expect(screen.queryByTestId('macro-overwrite-dialog')).toBeNull();
    // Only the initial (non-overwrite) attempt happened.
    expect(fakeEngine.collapseMacro).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('collapse-macro-form')).toBeTruthy();
  });

  it('right-clicking a picker macro offers rename and delete', async () => {
    state.modules = [OSC, VCA, TONE_MACRO];
    render(<App />);
    await screen.findByTestId('add-module-btn');
    fireEvent.click(screen.getByTestId('add-module-btn'));
    await screen.findByTestId('picker-category-Macros');

    // Rename: prefilled with the current name; submit hits the engine.
    fireEvent.contextMenu(screen.getByTestId('library-add-macro.tone'));
    fireEvent.click(await screen.findByTestId('picker-macro-rename'));
    const input = await screen.findByTestId<HTMLInputElement>('macro-rename-input');
    expect(input.value).toBe('Tone');
    fireEvent.change(input, { target: { value: 'Fat Tone' } });
    fireEvent.click(screen.getByTestId('macro-rename-confirm'));
    await waitFor(() =>
      expect(fakeEngine.renameMacro).toHaveBeenCalledWith('macro.tone', 'Fat Tone'),
    );

    // Delete: confirm dialog, then the engine call.
    fireEvent.contextMenu(screen.getByTestId('library-add-macro.tone'));
    fireEvent.click(await screen.findByTestId('picker-macro-delete'));
    fireEvent.click(await screen.findByTestId('macro-delete-confirm'));
    await waitFor(() => expect(fakeEngine.deleteMacro).toHaveBeenCalledWith('macro.tone'));
  });

  it('right-click on a non-macro picker entry opens no menu', async () => {
    state.modules = [OSC, VCA, TONE_MACRO];
    render(<App />);
    await screen.findByTestId('add-module-btn');
    fireEvent.click(screen.getByTestId('add-module-btn'));
    await screen.findByTestId('picker-category-Macros');
    fireEvent.contextMenu(screen.getByTestId('library-add-com.dj.oscillator'));
    expect(screen.queryByTestId('picker-macro-rename')).toBeNull();
  });
});

// The engine keeps macro internals as ordinary expanded nodes; the UI shows
// them all, with a bounding box standing in for the old collapsed panel.
describe('expanded macro view', () => {
  function setupMacroRack() {
    state.nodes = [node('tone1/osc1', OSC), node('tone1/vca1', VCA), node('osc2', OSC)];
    fakeEngine.macroGroups.mockResolvedValue([
      {
        instance: 'tone1',
        macro_id: 'macro.tone',
        name: 'Tone',
        members: ['tone1/osc1', 'tone1/vca1'],
      },
    ]);
  }

  it('renders every internal module as a normal panel plus a bounding box', async () => {
    setupMacroRack();
    render(<App />);
    await screen.findByTestId('module-tone1/osc1');
    expect(screen.getByTestId('module-tone1/vca1')).toBeTruthy();
    // No synthesized collapsed panel for the instance itself.
    expect(screen.queryByTestId('module-tone1')).toBeNull();
    const box = await screen.findByTestId('macro-box-tone1');
    expect(box.textContent).toContain('Tone');
    expect(box.textContent).toContain('tone1');
  });

  it('selecting one member selects the whole group', async () => {
    setupMacroRack();
    render(<App />);
    await screen.findByTestId('module-tone1/osc1');
    await screen.findByTestId('macro-box-tone1');
    fireEvent.mouseDown(screen.getByTestId('module-header-tone1/osc1'), { button: 0 });
    expect(screen.getByTestId('module-tone1/osc1').dataset.selected).toBe('true');
    expect(screen.getByTestId('module-tone1/vca1').dataset.selected).toBe('true');
    expect(screen.getByTestId('module-osc2').dataset.selected).toBeUndefined();
  });

  it('right-click on a member offers Break Macro, which calls the engine', async () => {
    setupMacroRack();
    fakeEngine.breakMacro.mockResolvedValue({
      'tone1/osc1': 'osc1',
      'tone1/vca1': 'vca1',
    });
    render(<App />);
    await screen.findByTestId('module-tone1/osc1');
    await screen.findByTestId('macro-box-tone1');
    fireEvent.contextMenu(screen.getByTestId('module-tone1/osc1'));
    const item = await screen.findByTestId('ctx-break-macro');
    expect(item.textContent).toContain('Tone');
    fireEvent.click(item);
    await waitFor(() => expect(fakeEngine.breakMacro).toHaveBeenCalledWith('tone1'));
  });

  it('macro boxes collide as solid rects — dragging one onto another pushes out', async () => {
    // Two single-member macros side by side (jsdom panels fall back to the
    // nominal 192×96 footprint; box rects add padding + the label tab).
    state.nodes = [node('tone1/osc1', OSC), node('tone2/osc1', OSC)];
    fakeEngine.macroGroups.mockResolvedValue([
      { instance: 'tone1', macro_id: 'macro.tone', name: 'Tone', members: ['tone1/osc1'] },
      { instance: 'tone2', macro_id: 'macro.tone', name: 'Tone', members: ['tone2/osc1'] },
    ]);
    localStorage.setItem(
      'dj-rack-positions',
      JSON.stringify({ 'tone1/osc1': { x: 48, y: 48 }, 'tone2/osc1': { x: 480, y: 48 } }),
    );
    render(<App />);
    await screen.findByTestId('macro-box-tone2');
    // Drag tone1's label right on top of tone2's panel.
    const label = screen.getByTestId('macro-box-label-tone1');
    fireEvent.mouseDown(label, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 432, clientY: 0 });
    fireEvent.mouseUp(window);
    // jsdom layout rects are zero — assert via the stored positions.
    const pos = JSON.parse(localStorage.getItem('dj-rack-positions')!) as Record<
      string,
      { x: number; y: number }
    >;
    // Solid box rects: |x1 - x2| must be at least a full box width
    // (192 panel + 2*10 padding = 212, grid-snapped upward), so the panels
    // (and their frames) cannot overlap.
    const gap = Math.abs(pos['tone2/osc1'].x - pos['tone1/osc1'].x);
    expect(gap).toBeGreaterThanOrEqual(212);
  });

  it('label drag moves the group, ends on mouseup and never arms a marquee', async () => {
    setupMacroRack();
    render(<App />);
    await screen.findByTestId('module-tone1/osc1');
    const label = await screen.findByTestId('macro-box-label-tone1');
    // Mousedown on the label must not bubble into the rack background
    // (which would arm a marquee sweep on top of the drag).
    fireEvent.mouseDown(label, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 140, clientY: 120 });
    expect(screen.queryByTestId('marquee')).toBeNull();
    const before = screen.getByTestId('module-tone1/osc1').style.left;
    fireEvent.mouseUp(window, { clientX: 140, clientY: 120 });
    // The drag is over: further pointer movement must not keep moving the
    // group (the old symptom — click once, group follows the mouse).
    fireEvent.mouseMove(window, { clientX: 400, clientY: 400 });
    expect(screen.getByTestId('module-tone1/osc1').style.left).toBe(before);
  });

  it('right-click on the bounding-box label also offers Break Macro', async () => {
    setupMacroRack();
    render(<App />);
    await screen.findByTestId('module-tone1/osc1');
    fireEvent.contextMenu(await screen.findByTestId('macro-box-label-tone1'));
    expect(await screen.findByTestId('ctx-break-macro')).toBeTruthy();
    // The whole group got selected for the menu's Copy/Delete actions.
    expect(screen.getByTestId('module-tone1/osc1').dataset.selected).toBe('true');
    expect(screen.getByTestId('module-tone1/vca1').dataset.selected).toBe('true');
  });

  it('deleting a member deletes the whole instance via its top-level id', async () => {
    setupMacroRack();
    render(<App />);
    await screen.findByTestId('module-tone1/osc1');
    await screen.findByTestId('macro-box-tone1');
    fireEvent.contextMenu(screen.getByTestId('module-tone1/vca1'));
    fireEvent.click(await screen.findByTestId('ctx-delete'));
    await waitFor(() => expect(fakeEngine.removeModules).toHaveBeenCalledWith(['tone1']));
  });

  it('instantiating a macro lays members out from the definition layout', async () => {
    state.modules = [OSC, VCA, TONE_MACRO];
    fakeEngine.macroLayout.mockResolvedValue({ osc1: [0, 0], vca1: [180, 20] });
    render(<App />);
    await screen.findByTestId('add-module-btn');
    fireEvent.click(screen.getByTestId('add-module-btn'));
    await screen.findByTestId('picker-category-Macros');
    fireEvent.click(screen.getByTestId('library-add-macro.tone'));
    await waitFor(() => expect(fakeEngine.macroLayout).toHaveBeenCalledWith('macro.tone'));
    // Relative offsets from the definition survive into the stored layout.
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('dj-rack-positions') ?? '{}');
      const ids = Object.keys(saved).filter((k) => k.startsWith('tone'));
      expect(ids.some((k) => k.endsWith('/osc1'))).toBe(true);
      const osc = saved[ids.find((k) => k.endsWith('/osc1'))!];
      const vca = saved[ids.find((k) => k.endsWith('/vca1'))!];
      expect(vca.x - osc.x).toBe(180);
      expect(vca.y - osc.y).toBe(20);
    });
  });
});
