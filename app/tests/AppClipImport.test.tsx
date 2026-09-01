// Importing a beat clip from the picker's Clips tab: a Beat Clip
// module lands in the rack loaded with that clip and WEARING ITS NAME —
// the backend renames the module as it loads, so the frontend has to
// follow the module to its new instance id (its rack position is keyed by
// it), exactly like a user rename.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../src/types';
import type { BeatClipEntry } from '../src/beatClip';

const BEAT_CLIP: Manifest = {
  id: 'builtin.beat_clip',
  name: 'Beat Clip',
  version: '0.1.0',
  abi: 'native',
  category: 'Sources',
  inputs: [{ id: 'clock', name: 'Clock' }],
  outputs: [{ id: 'audio_l', name: 'L' }],
  params: [],
};

const CLIP: BeatClipEntry = {
  clipId: '3',
  name: 'chorus stack',
  bpm: 92.5,
  beats: 4,
  stems: ['drums', 'bass'],
  editable: true,
  ones: [],
  sources: [{ trackHash: 'abc123', title: 'Sunroom Take', artist: 'Me' }],
};

const state = { nodes: [] as unknown[] };

function node(instance: string, manifest: Manifest, displayName?: string) {
  return {
    instance_id: instance,
    type_id: manifest.id,
    manifest,
    display_name: displayName ?? null,
    knobs: {},
    params: {},
    wired_inputs: [],
    midi_mappings: [],
  };
}

const fakeEngine = {
  loadDemoPatch: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  listModules: vi.fn(async () => [BEAT_CLIP]),
  nodes: vi.fn(async () => state.nodes),
  wires: vi.fn(async () => []),
  tap: vi.fn(async () => null),
  tapAll: vi.fn(async () => ({})),
  macroGroups: vi.fn(async () => []),
  macroLayout: vi.fn(async () => ({})),
  currentPatch: vi.fn(async () => null),
  listPatches: vi.fn(async () => []),
  moveModules: vi.fn(async () => {}),
  syncPositions: vi.fn(async () => {}),
  endEdit: vi.fn(async () => {}),
  addModule: vi.fn(async (instance: string) => {
    state.nodes = [...state.nodes, node(instance, BEAT_CLIP)];
  }),
};

// The load renames the module after the clip, like the backend does.
const beatClipMock = {
  list: vi.fn(async () => [CLIP]),
  load: vi.fn(async (instance: string) => {
    state.nodes = state.nodes.map((n) =>
      (n as { instance_id: string }).instance_id === instance
        ? node('chorus_stack', BEAT_CLIP, 'chorus stack')
        : n,
    );
    return 'chorus_stack';
  }),
  status: vi.fn(async () => null),
};

vi.mock('../src/engine', () => ({
  engine: new Proxy(
    {},
    { get: (_t, prop) => fakeEngine[prop as keyof typeof fakeEngine] ?? vi.fn(async () => null) },
  ),
  onMenuAction: () => () => {},
}));

// Proxied like the engine mock: the factory is hoisted above the consts
// it reads, so every lookup has to happen at call time.
vi.mock('../src/beatClip', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/beatClip')>()),
  beatClip: new Proxy({}, { get: (_t, prop) => beatClipMock[prop as keyof typeof beatClipMock] }),
}));

import App from '../src/App';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  state.nodes = [];
});

describe('importing a clip from the picker', () => {
  it('adds a Beat Clip module loaded with the clip and named after it', async () => {
    render(<App />);
    await waitFor(() => expect(fakeEngine.listModules).toHaveBeenCalled());

    fireEvent.keyDown(window, { key: 'm', metaKey: true });
    await waitFor(() => expect(beatClipMock.list).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('picker-tab-clips'));
    fireEvent.click(await screen.findByTestId('picker-clip-3'));

    await waitFor(() => expect(beatClipMock.load).toHaveBeenCalledWith('beatclip1', '3'));
    // The panel that lands is the renamed one, titled with the clip.
    const title = await screen.findByTestId('module-name-chorus_stack');
    expect(title.textContent).toBe('chorus stack');
    expect(screen.queryByTestId('module-beatclip1')).toBeNull();
  });
});
