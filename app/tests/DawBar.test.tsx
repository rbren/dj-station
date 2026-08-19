// DAW bottom bar against a fake DawApi: collapsed-by-default strip that
// still renders every track's jacks (wires stay anchored), expand/collapse
// toggle, track add (mono/stereo/CV/MIDI), rename, remove, transport,
// record flow, library import, the ±10 V clip graph, and the beat-aligned
// timeline (ruler, BPM, snap grid, zoom, input knobs, MIDI note grid).

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClipGraph,
  DawBar,
  GRAPH_H,
  MidiGrid,
  MIDI_PITCH_MAX,
  SNAP_OPTIONS,
  type DawApi,
} from '../src/components/DawBar';
import type { DawStatus } from '../src/engine';
import type { Track } from '../src/library';
import { createRackStore, RackStoreContext } from '../src/rackStore';

// jsdom has no PointerEvent; without this, fireEvent.pointerDown drops
// clientX/clientY (they come out NaN in the handler).
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const LIB_TRACK: Track = {
  id: 1,
  title: 'Amen Break',
  artist: 'The Winstons',
  album: '',
  file_path: '/lib/amen.wav',
  content_hash: 'h',
  format: 'wav',
  duration_secs: 7,
  sample_rate: 48000,
  channels: 2,
  source: 'local',
  source_ref: '',
} as Track;

function makeStatus(over: Partial<DawStatus> = {}): DawStatus {
  return {
    tracks: [
      { name: 'drums', jack: 0, kind: 'audio', stereo: true, clip: null },
      { name: 'lfo take', jack: 2, kind: 'continuous', stereo: false, clip: '/rec/lfo.wav' },
    ],
    clip_frames: [0, 480],
    knobs: {
      i0: { position: 0, atten: 1, offset: 0 },
      i1: { position: 0, atten: 1, offset: 0 },
      i2: { position: 0.65, atten: 1, offset: 0 },
    },
    bpm: 120,
    playhead: 0,
    playing: false,
    recording: null,
    record_frames: 0,
    sample_rate: 48000,
    mic_running: false,
    ...over,
  };
}

function makeApi(status: DawStatus = makeStatus()): DawApi & { state: { status: DawStatus } } {
  const state = { status };
  return {
    state,
    status: vi.fn(async () => state.status),
    addTrack: vi.fn(async () => {}),
    removeTrack: vi.fn(async () => {}),
    renameTrack: vi.fn(async () => {}),
    moveTrack: vi.fn(async () => {}),
    importClip: vi.fn(async () => {}),
    clearClip: vi.fn(async () => {}),
    play: vi.fn(async () => {
      state.status = { ...state.status, playing: true };
    }),
    stop: vi.fn(async () => {
      state.status = { ...state.status, playing: false };
    }),
    seek: vi.fn(async () => {}),
    recordStart: vi.fn(async (track: number) => {
      state.status = { ...state.status, recording: track };
    }),
    recordStop: vi.fn(async () => {
      state.status = { ...state.status, recording: null };
    }),
    recordCancel: vi.fn(async () => {
      state.status = { ...state.status, recording: null };
    }),
    clipPeaks: vi.fn(async () => [[-5, 5]] as [number, number][]),
    setBpm: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    removeNote: vi.fn(async () => {}),
    setKnobPosition: vi.fn(async () => {}),
    endEdit: vi.fn(async () => {}),
  };
}

function renderBar(api: DawApi, tracks: Track[] = [LIB_TRACK]) {
  const store = createRackStore();
  const onJackClick = vi.fn();
  const onChanged = vi.fn();
  const utils = render(
    <RackStoreContext.Provider value={store}>
      <DawBar
        api={api}
        libraryTracks={tracks}
        onJackClick={onJackClick}
        onChanged={onChanged}
        pollMs={10_000}
      />
    </RackStoreContext.Provider>,
  );
  return { ...utils, store, onJackClick, onChanged };
}

beforeEach(() => {
  localStorage.clear();
});

describe('DawBar', () => {
  it('starts collapsed with every track jack present so wires stay anchored', async () => {
    renderBar(makeApi());
    await screen.findByTestId('daw-strip');
    expect(screen.queryByTestId('daw-lanes')).toBeNull();
    await waitFor(() =>
      expect(document.querySelector('[data-jack="daw:input:i0"]')).not.toBeNull(),
    );
    // Stereo audio track owns slots 0-1, continuous track slot 2: each
    // slot has an input (i<n>) and output (t<n>) socket anchor.
    for (const slot of [0, 1, 2]) {
      expect(document.querySelector(`[data-jack="daw:input:i${slot}"]`)).not.toBeNull();
      expect(document.querySelector(`[data-jack="daw:output:t${slot}"]`)).not.toBeNull();
    }
  });

  it('expands to lanes and collapses back, persisting the choice', async () => {
    const { unmount } = renderBar(makeApi());
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    await screen.findByTestId('daw-lanes');
    expect(screen.queryByTestId('daw-strip')).toBeNull();
    // Jacks are still present in the expanded lanes.
    expect(document.querySelector('[data-jack="daw:output:t2"]')).not.toBeNull();
    unmount();
    renderBar(makeApi());
    await screen.findByTestId('daw-lanes'); // persisted expanded
  });

  it('labels mono vs stereo vs CV lanes', async () => {
    renderBar(makeApi());
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    await screen.findByTestId('daw-lanes');
    expect(screen.getByTestId('daw-kind-0').textContent).toBe('audio · stereo');
    expect(screen.getByTestId('daw-kind-1').textContent).toBe('CV');
  });

  it('adds a track with the chosen kind and stereo flag', async () => {
    const api = makeApi();
    const { onChanged } = renderBar(api);
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    await screen.findByTestId('daw-add');
    fireEvent.change(screen.getByTestId('daw-add-name'), { target: { value: 'vox' } });
    fireEvent.click(screen.getByTestId('daw-add-stereo'));
    fireEvent.click(screen.getByTestId('daw-add-track'));
    await waitFor(() => expect(api.addTrack).toHaveBeenCalledWith('vox', 'audio', true));
    expect(onChanged).toHaveBeenCalled();
  });

  it('continuous tracks hide the stereo option and pass stereo=false', async () => {
    const api = makeApi();
    renderBar(api);
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    await screen.findByTestId('daw-add');
    fireEvent.change(screen.getByTestId('daw-add-kind'), { target: { value: 'continuous' } });
    expect(screen.queryByTestId('daw-add-stereo')).toBeNull();
    fireEvent.change(screen.getByTestId('daw-add-name'), { target: { value: 'mod' } });
    fireEvent.click(screen.getByTestId('daw-add-track'));
    await waitFor(() => expect(api.addTrack).toHaveBeenCalledWith('mod', 'continuous', false));
  });

  it('renames on blur and removes tracks', async () => {
    const api = makeApi();
    renderBar(api);
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    const name = await screen.findByTestId('daw-name-0');
    fireEvent.change(name, { target: { value: 'breaks' } });
    fireEvent.blur(name);
    await waitFor(() => expect(api.renameTrack).toHaveBeenCalledWith(0, 'breaks'));
    fireEvent.click(screen.getByTestId('daw-remove-1'));
    await waitFor(() => expect(api.removeTrack).toHaveBeenCalledWith(1));
  });

  it('drives the transport: play toggles to stop, rewind seeks to 0', async () => {
    const api = makeApi();
    renderBar(api);
    const play = await screen.findByTestId('daw-play');
    fireEvent.click(play);
    await waitFor(() => expect(api.play).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('daw-play').textContent).toBe('⏹'));
    fireEvent.click(screen.getByTestId('daw-play'));
    await waitFor(() => expect(api.stop).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('daw-rewind'));
    await waitFor(() => expect(api.seek).toHaveBeenCalledWith(0));
  });

  it('records: arm from input, live indicator, stop finishes the take', async () => {
    const api = makeApi();
    const { onChanged } = renderBar(api);
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    fireEvent.click(await screen.findByTestId('daw-rec-input-0'));
    await waitFor(() => expect(api.recordStart).toHaveBeenCalledWith(0, 'input'));
    await screen.findByTestId('daw-rec-live');
    // While recording, other tracks cannot arm.
    expect((screen.getByTestId('daw-rec-input-1') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('daw-rec-stop-0'));
    await waitFor(() => expect(api.recordStop).toHaveBeenCalled());
    expect(onChanged).toHaveBeenCalled();
  });

  it('mic recording is offered on audio tracks only', async () => {
    renderBar(makeApi());
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    await screen.findByTestId('daw-lanes');
    expect(screen.queryByTestId('daw-rec-mic-0')).not.toBeNull();
    expect(screen.queryByTestId('daw-rec-mic-1')).toBeNull(); // CV track
  });

  it('imports a library track as a clip and clears it', async () => {
    const api = makeApi();
    renderBar(api);
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    fireEvent.change(await screen.findByTestId('daw-import-0'), {
      target: { value: '/lib/amen.wav' },
    });
    await waitFor(() => expect(api.importClip).toHaveBeenCalledWith(0, '/lib/amen.wav'));
    fireEvent.click(screen.getByTestId('daw-clear-1'));
    await waitFor(() => expect(api.clearClip).toHaveBeenCalledWith(1));
  });

  it('fetches and draws the clip graph for tracks with clips', async () => {
    const api = makeApi();
    renderBar(api);
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    await screen.findByTestId('daw-lanes');
    // Track 1 has a clip (480 frames) → band polygon; track 0 has none.
    await waitFor(() => expect(screen.queryByTestId('daw-band-1')).not.toBeNull());
    expect(screen.queryByTestId('daw-band-0')).toBeNull();
    expect(api.clipPeaks).toHaveBeenCalledWith(1, expect.any(Number));
    expect(api.clipPeaks).not.toHaveBeenCalledWith(0, expect.any(Number));
  });

  it('clicking a jack reports the daw instance and stable jack id', async () => {
    const { onJackClick } = renderBar(makeApi());
    await waitFor(() =>
      expect(document.querySelector('[data-jack="daw:output:t2"]')).not.toBeNull(),
    );
    fireEvent.click(document.querySelector('[data-jack="daw:output:t2"]')!.closest('button')!);
    expect(onJackClick).toHaveBeenCalledWith('daw', 'output', 't2', false);
    fireEvent.click(document.querySelector('[data-jack="daw:input:i0"]')!.closest('button')!);
    expect(onJackClick).toHaveBeenCalledWith('daw', 'input', 'i0', false);
  });
});

describe('rack store × DAW', () => {
  it('a pending wire from the daw survives a nodes refresh (daw is not a rack node)', () => {
    const store = createRackStore();
    store.set({ pending: { instance: 'daw', jack: 't0', kind: 'output', color: 0 } });
    store.setNodes([]); // refresh: no rack nodes, daw hidden from engine_nodes
    expect(store.getState().pending).toEqual({
      instance: 'daw',
      jack: 't0',
      kind: 'output',
      color: 0,
    });
    // …but a pending wire from a removed rack module is still pruned.
    store.set({ pending: { instance: 'osc-1', jack: 'audio', kind: 'output', color: 0 } });
    store.setNodes([]);
    expect(store.getState().pending).toBeNull();
  });
});

describe('ClipGraph', () => {
  it('maps ±10 V to the top/bottom edges and clamps beyond the rail', () => {
    render(
      <ClipGraph
        track={9}
        peaks={[
          [-10, 10],
          [-20, 20],
          [0, 0],
        ]}
        clipFrames={300}
        width={220}
        onSeek={() => {}}
      />,
    );
    const pts = screen
      .getByTestId('daw-band-9')
      .getAttribute('points')!
      .split(' ')
      .map((p) => p.split(',').map(Number));
    // Top edge: bins 0 and 1 (max 10 and 20 → clamped) hit y=0; bin 2 sits
    // on the midline. Bottom edge mirrors at GRAPH_H.
    expect(pts[0][1]).toBe(0);
    expect(pts[1][1]).toBe(0);
    expect(pts[2][1]).toBe(GRAPH_H / 2);
    expect(pts[3][1]).toBe(GRAPH_H / 2);
    expect(pts[4][1]).toBe(GRAPH_H);
    expect(pts[5][1]).toBe(GRAPH_H);
  });

  it('reports the clicked position as a fraction of the clip', () => {
    const onSeek = vi.fn();
    render(<ClipGraph track={0} peaks={[[0, 1]]} clipFrames={200} width={200} onSeek={onSeek} />);
    const graph = screen.getByTestId('daw-graph-0');
    const w = Number(graph.getAttribute('width'));
    graph.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: GRAPH_H }) as DOMRect;
    fireEvent.pointerDown(graph, { clientX: w / 4 });
    expect(onSeek).toHaveBeenCalledWith(0.25);
  });

  it('shows an empty label without a clip', () => {
    render(<ClipGraph track={3} peaks={[]} clipFrames={0} width={220} onSeek={() => {}} />);
    expect(screen.getByText('no clip')).not.toBeNull();
    expect(screen.queryByTestId('daw-band-3')).toBeNull();
  });
});

describe('timeline', () => {
  it('shows the ruler, BPM input, snap dropdown and zoom controls when expanded', async () => {
    renderBar(makeApi());
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    await screen.findByTestId('daw-lanes');
    expect(screen.queryByTestId('daw-ruler')).not.toBeNull();
    expect((screen.getByTestId('daw-bpm') as HTMLInputElement).value).toBe('120');
    expect((screen.getByTestId('daw-snap') as HTMLSelectElement).value).toBe('1/4');
    expect(screen.queryByTestId('daw-zoom-in')).not.toBeNull();
    expect(screen.queryByTestId('daw-zoom-out')).not.toBeNull();
    expect(screen.queryByTestId('daw-playhead')).not.toBeNull();
  });

  it('collapsed bar hides the timeline controls', async () => {
    renderBar(makeApi());
    await screen.findByTestId('daw-strip');
    expect(screen.queryByTestId('daw-bpm')).toBeNull();
    expect(screen.queryByTestId('daw-snap')).toBeNull();
  });

  it('commits a BPM change on blur', async () => {
    const api = makeApi();
    renderBar(api);
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    const bpm = await screen.findByTestId('daw-bpm');
    fireEvent.change(bpm, { target: { value: '174' } });
    fireEvent.blur(bpm);
    await waitFor(() => expect(api.setBpm).toHaveBeenCalledWith(174));
  });

  it('zoom buttons scale the timeline width and persist', async () => {
    renderBar(makeApi());
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    const ruler = await screen.findByTestId('daw-ruler');
    const before = Number(ruler.getAttribute('width'));
    fireEvent.click(screen.getByTestId('daw-zoom-in'));
    const after = Number(screen.getByTestId('daw-ruler').getAttribute('width'));
    expect(after).toBeGreaterThan(before);
    expect(JSON.parse(localStorage.getItem('dj-daw-zoom')!)).toBeCloseTo(60);
  });

  it('snap dropdown offers straight and triplet resolutions', async () => {
    renderBar(makeApi());
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    const snap = (await screen.findByTestId('daw-snap')) as HTMLSelectElement;
    const labels = Array.from(snap.options).map((o) => o.value);
    expect(labels).toContain('1/8');
    expect(labels).toContain('1/8T');
    expect(labels).toContain('1/4T');
    // Triplet beats are the straight value × 2/3.
    const q = SNAP_OPTIONS.find((o) => o.label === '1/4')!.beats;
    const qt = SNAP_OPTIONS.find((o) => o.label === '1/4T')!.beats;
    expect(qt).toBeCloseTo(q * (2 / 3));
  });

  it('clicking the ruler seeks snapped to the grid', async () => {
    const api = makeApi();
    renderBar(api);
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    const ruler = await screen.findByTestId('daw-ruler');
    ruler.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 18 }) as DOMRect;
    // Default zoom 40 px/beat, snap 1/4 (1 beat): x=110 → beat 2.75 → 3.
    fireEvent.pointerDown(ruler, { clientX: 110 });
    // 3 beats at 120 bpm, 48 kHz = 3 × 24000 frames.
    await waitFor(() => expect(api.seek).toHaveBeenCalledWith(72000));
  });

  it('renders a recordable knob on every non-MIDI input jack', async () => {
    renderBar(makeApi());
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    await screen.findByTestId('daw-lanes');
    expect(screen.queryByTestId('knob-i0')).not.toBeNull();
    expect(screen.queryByTestId('knob-i1')).not.toBeNull();
    expect(screen.queryByTestId('knob-i2')).not.toBeNull();
  });
});

describe('MIDI tracks', () => {
  const midiStatus = () =>
    makeStatus({
      tracks: [
        {
          name: 'melody',
          jack: 0,
          kind: 'midi',
          stereo: false,
          clip: null,
          notes: [{ beat: 1, len: 1, pitch: 60, velocity: 1 }],
        },
      ],
      clip_frames: [0],
      knobs: {},
    });

  it('labels the lane MIDI and renders pitch/gate outputs but no inputs', async () => {
    renderBar(makeApi(midiStatus()));
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    await screen.findByTestId('daw-lanes');
    expect(screen.getByTestId('daw-kind-0').textContent).toBe('MIDI');
    expect(document.querySelector('[data-jack="daw:output:t0"]')).not.toBeNull();
    expect(document.querySelector('[data-jack="daw:output:t1"]')).not.toBeNull();
    expect(document.querySelector('[data-jack="daw:input:i0"]')).toBeNull();
    // No record/import controls on a MIDI lane.
    expect(screen.queryByTestId('daw-rec-input-0')).toBeNull();
    expect(screen.queryByTestId('daw-import-0')).toBeNull();
  });

  it('shows the note grid with existing notes', async () => {
    renderBar(makeApi(midiStatus()));
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    await screen.findByTestId('daw-midi-grid-0');
    expect(screen.queryByTestId('daw-note-0-1-60')).not.toBeNull();
  });

  it('adding a MIDI track offers no stereo option', async () => {
    const api = makeApi();
    renderBar(api);
    fireEvent.click(await screen.findByTestId('daw-toggle'));
    await screen.findByTestId('daw-add');
    fireEvent.change(screen.getByTestId('daw-add-kind'), { target: { value: 'midi' } });
    expect(screen.queryByTestId('daw-add-stereo')).toBeNull();
    fireEvent.change(screen.getByTestId('daw-add-name'), { target: { value: 'keys' } });
    fireEvent.click(screen.getByTestId('daw-add-track'));
    await waitFor(() => expect(api.addTrack).toHaveBeenCalledWith('keys', 'midi', false));
  });
});

describe('MidiGrid', () => {
  const renderGrid = (
    onToggle = vi.fn(),
    notes = [{ beat: 1, len: 1, pitch: 60, velocity: 1 }],
  ) => {
    render(
      <MidiGrid
        track={0}
        notes={notes}
        beats={8}
        pxPerBeat={40}
        snapBeats={0.5}
        onToggle={onToggle}
      />,
    );
    const grid = screen.getByTestId('daw-midi-grid-0');
    grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 252 }) as DOMRect;
    return { grid, onToggle };
  };

  it('adds a note snapped to the grid on empty-cell click', () => {
    const { grid, onToggle } = renderGrid();
    // x=130 → beat 3.25 → snapped down to 3.0; row 0 = highest pitch.
    fireEvent.pointerDown(grid, { clientX: 130, clientY: 3 });
    expect(onToggle).toHaveBeenCalledWith(3, MIDI_PITCH_MAX, undefined);
  });

  it('reports the existing note when clicking inside it', () => {
    const note = { beat: 1, len: 1, pitch: 60, velocity: 1 };
    const { grid, onToggle } = renderGrid(vi.fn(), [note]);
    const row = MIDI_PITCH_MAX - 60;
    // beat 1.5 is inside the 1-beat note starting at beat 1.
    fireEvent.pointerDown(grid, { clientX: 1.5 * 40, clientY: row * 7 + 3 });
    expect(onToggle).toHaveBeenCalledWith(1.5, 60, note);
  });
});
