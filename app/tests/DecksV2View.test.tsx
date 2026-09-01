// The Decks V2 page against a mock bank: rows only for loaded clips,
// the two grids drawn to the same LCM width, the locked live side and
// its disarm button, the gap's Jump/Crossfade, the commit a fired
// transition owes, and adding clips one at a time or a song at once.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DecksV2View } from '../src/components/DecksV2View';
import type { DecksStatus, DeckSlotStatus } from '../src/decks';
import { songsOf, type DecksV2Api } from '../src/decksV2';
import type { BeatClipApi, BeatClipEntry } from '../src/beatClip';

function emptySlot(slot: number): DeckSlotStatus {
  return {
    slot,
    clip: null,
    loaded: false,
    beats: 0,
    ones: [],
    lead_one: null,
    tail: 0,
    phase: 0,
    source_bpm: 120,
    ratio: 1,
    stretch: 1,
    level: 0.8,
    low: 1,
    mid: 1,
    high: 1,
    mute: true,
    monitor: false,
    wet: 1,
    insert_monitor: false,
    insert: false,
    tone_patched: [false, false, false],
    duration_secs: 0,
    position_secs: 0,
    beat: -1,
    sounding: false,
    playing: false,
    output_level: 0,
    arm: 'none',
    live_level: 1,
    live_mute: true,
    live_phase: 0,
    live_lead_one: null,
  };
}

function loadedSlot(slot: number, over: Partial<DeckSlotStatus> = {}): DeckSlotStatus {
  return {
    ...emptySlot(slot),
    clip: {
      project: 'p1',
      clip: `c${slot + 1}`,
      name: `clip ${slot + 1}`,
      project_name: 'set one',
      stems: ['drums'],
    },
    loaded: true,
    beats: 4,
    mute: false,
    ...over,
  };
}

function makeStatus(over: Partial<DecksStatus> = {}): DecksStatus {
  return {
    bpm: 128,
    running: true,
    beat: 4.25,
    cycle_beats: 20,
    surface: false,
    surface_connected: false,
    master_live: 1,
    master_monitor: 1,
    v2: true,
    transition: 'none',
    transition_done: false,
    xfade: 0,
    slots: Array.from({ length: 8 }, (_, i) => emptySlot(i)),
    ...over,
  };
}

function makeApi(status: DecksStatus, over: Partial<DecksV2Api> = {}): DecksV2Api {
  return {
    banks: vi.fn().mockResolvedValue([]),
    ensure: vi.fn().mockResolvedValue('decksv2_1'),
    banksV2: vi.fn().mockResolvedValue(['decksv2_1']),
    ensureV2: vi.fn().mockResolvedValue('decksv2_1'),
    status: vi.fn().mockResolvedValue(status),
    load: vi.fn().mockResolvedValue(null),
    loadV2: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue(null),
    setControl: vi.fn().mockResolvedValue(null),
    setLiveControl: vi.fn().mockResolvedValue(null),
    setMaster: vi.fn().mockResolvedValue(null),
    arm: vi.fn().mockResolvedValue(null),
    setTail: vi.fn().mockResolvedValue(null),
    setPhase: vi.fn().mockResolvedValue(null),
    setLivePhase: vi.fn().mockResolvedValue(null),
    setRatio: vi.fn().mockResolvedValue(null),
    setBpm: vi.fn().mockResolvedValue(null),
    setSurface: vi.fn().mockResolvedValue(null),
    setRunning: vi.fn().mockResolvedValue(null),
    transition: vi.fn().mockResolvedValue(null),
    commitTransition: vi.fn().mockResolvedValue(false),
    rehydrate: vi.fn().mockResolvedValue(0),
    endEdit: vi.fn().mockResolvedValue(null),
    ...over,
  };
}

// Four clips off two songs, plus one with no source left.
const CLIPS: BeatClipEntry[] = [
  {
    clipId: 'c1',
    name: 'clip 1',
    beats: 4,
    bpm: 120,
    stems: ['drums'],
    editable: true,
    ones: [],
    sources: [{ trackHash: 'song-a', title: 'Basement Loop', artist: 'Me' }],
  },
  {
    clipId: 'c2',
    name: 'clip 2',
    beats: 5,
    bpm: 120,
    stems: [],
    editable: true,
    ones: [],
    sources: [{ trackHash: 'song-a', title: 'Basement Loop', artist: 'Me' }],
  },
  {
    clipId: 'c3',
    name: 'clip 3',
    beats: 2,
    bpm: 120,
    stems: [],
    editable: true,
    ones: [],
    sources: [{ trackHash: 'song-b', title: 'Roof Cut', artist: 'You' }],
  },
  {
    clipId: 'c4',
    name: 'orphan',
    beats: 8,
    bpm: 120,
    stems: [],
    editable: false,
    ones: [],
    sources: [],
  },
];

function makeClips(entries = CLIPS): BeatClipApi {
  return {
    list: vi.fn().mockResolvedValue(entries),
    load: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue([]),
    audio: vi.fn().mockResolvedValue(null),
    peaks: vi.fn().mockResolvedValue([]),
    gridSave: vi.fn().mockResolvedValue(undefined),
    gridLoad: vi.fn().mockResolvedValue(null),
    gridList: vi.fn().mockResolvedValue([]),
  };
}

const NO_POLL = 100000;

function show(api: DecksV2Api, clips: BeatClipApi = makeClips()) {
  return render(<DecksV2View api={api} clips={clips} pollMs={NO_POLL} />);
}

describe('DecksV2View', () => {
  it('offers to make the V2 bank when the patch has none', async () => {
    const ensureV2 = vi.fn().mockResolvedValue('decksv2_1');
    const api = makeApi(makeStatus(), { banksV2: vi.fn().mockResolvedValue([]), ensureV2 });
    show(api);
    await waitFor(() => expect(screen.getByTestId('decksv2-empty')).toBeTruthy());
    fireEvent.click(screen.getByTestId('decksv2-add-bank'));
    await waitFor(() => expect(ensureV2).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('decksv2-titles')).toBeTruthy());
  });

  it('shows one row per LOADED clip, not eight strips', async () => {
    const status = makeStatus();
    status.slots[0] = loadedSlot(0);
    status.slots[3] = loadedSlot(3);
    show(makeApi(status));
    await waitFor(() => expect(screen.getByTestId('decksv2-title-0')).toBeTruthy());
    expect(screen.getByTestId('decksv2-title-3')).toBeTruthy();
    expect(screen.queryByTestId('decksv2-title-1')).toBeNull();
    expect(within(screen.getByTestId('decksv2-title-0')).getByText('clip 1')).toBeTruthy();
  });

  it('colors every clip cut from one song the same, and different songs apart', async () => {
    const status = makeStatus();
    status.slots[0] = loadedSlot(0); // c1: song-a
    status.slots[1] = loadedSlot(1); // c2: song-a
    status.slots[2] = loadedSlot(2); // c3: song-b
    show(makeApi(status));
    await waitFor(() => expect(screen.getByTestId('decksv2-chip-0')).toBeTruthy());
    const chip = (slot: number) =>
      (screen.getByTestId(`decksv2-chip-${slot}`) as HTMLElement).style.background;
    expect(chip(0)).toBe(chip(1));
    expect(chip(0)).not.toBe(chip(2));
  });

  it('draws both grids to the whole cycle — the LCM of every loop', async () => {
    const status = makeStatus({ cycle_beats: 20 });
    status.slots[0] = loadedSlot(0, { beats: 4 });
    status.slots[1] = loadedSlot(1, { beats: 5 });
    show(makeApi(status));
    await waitFor(() => expect(screen.getByTestId('decksv2-cells-live-0')).toBeTruthy());
    for (const side of ['live', 'monitor'] as const) {
      for (const slot of [0, 1]) {
        expect(screen.getByTestId(`decksv2-cells-${side}-${slot}`).children).toHaveLength(20);
      }
      expect(screen.getByTestId(`decksv2-playhead-${side}`)).toBeTruthy();
    }
  });

  it('paints ones purple, the lead one green, per side and shifted with the row', async () => {
    const status = makeStatus({ cycle_beats: 4 });
    status.slots[0] = loadedSlot(0, {
      beats: 4,
      ones: [0, 2],
      lead_one: 0,
      phase: 1, // the monitor side shifted one beat later
      live_lead_one: 0,
      live_phase: 0,
    });
    show(makeApi(status));
    await waitFor(() => expect(screen.getByTestId('decksv2-cells-live-0')).toBeTruthy());
    const kinds = (side: string) =>
      [...screen.getByTestId(`decksv2-cells-${side}-0`).children].map(
        (c) => (c as HTMLElement).dataset.kind,
      );
    expect(kinds('live')).toEqual(['lead', 'beat', 'one', 'beat']);
    expect(kinds('monitor')).toEqual(['beat', 'lead', 'beat', 'one']);
  });

  it('grays a row out on whichever side has it muted', async () => {
    const status = makeStatus();
    status.slots[0] = loadedSlot(0, { mute: false, live_mute: true });
    show(makeApi(status));
    await waitFor(() => expect(screen.getByTestId('decksv2-cells-live-0')).toBeTruthy());
    expect(screen.getByTestId('decksv2-cells-live-0').dataset.off).toBe('true');
    expect(screen.getByTestId('decksv2-cells-monitor-0').dataset.off).toBe('false');
  });

  it('keeps the live side uneditable until the disarm button opens it up', async () => {
    const status = makeStatus();
    status.slots[0] = loadedSlot(0);
    const api = makeApi(status);
    show(api);
    await waitFor(() => expect(screen.getByTestId('decksv2-mute-live-0')).toBeTruthy());
    expect((screen.getByTestId('decksv2-mute-live-0') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('decksv2-level-live-0') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('decksv2-shift-left-live-0') as HTMLButtonElement).disabled).toBe(
      true,
    );
    // The monitor side was never locked.
    expect((screen.getByTestId('decksv2-mute-monitor-0') as HTMLButtonElement).disabled).toBe(
      false,
    );

    fireEvent.click(screen.getByTestId('decksv2-disarm'));
    expect((screen.getByTestId('decksv2-mute-live-0') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('decksv2-mute-live-0'));
    expect(api.setLiveControl).toHaveBeenCalledWith('decksv2_1', 0, 'mute', 0);
    fireEvent.click(screen.getByTestId('decksv2-shift-right-live-0'));
    expect(api.setLivePhase).toHaveBeenCalledWith('decksv2_1', 0, 1);
  });

  it('writes monitor edits down the classic per-slot path', async () => {
    const status = makeStatus();
    status.slots[0] = loadedSlot(0, { phase: 2 });
    const api = makeApi(status);
    show(api);
    await waitFor(() => expect(screen.getByTestId('decksv2-mute-monitor-0')).toBeTruthy());
    fireEvent.click(screen.getByTestId('decksv2-mute-monitor-0'));
    expect(api.setControl).toHaveBeenCalledWith('decksv2_1', 0, 'mute', 10);
    fireEvent.click(screen.getByTestId('decksv2-shift-left-monitor-0'));
    expect(api.setPhase).toHaveBeenCalledWith('decksv2_1', 0, 1);
    fireEvent.change(screen.getByTestId('decksv2-level-monitor-0'), { target: { value: '0.5' } });
    expect(api.setControl).toHaveBeenCalledWith('decksv2_1', 0, 'level', 0.5);
  });

  it('arms a jump or crossfade from the gap, and pressing again takes it back', async () => {
    const api = makeApi(makeStatus());
    show(api);
    await waitFor(() => expect(screen.getByTestId('decksv2-jump')).toBeTruthy());
    fireEvent.click(screen.getByTestId('decksv2-jump'));
    expect(api.transition).toHaveBeenCalledWith('decksv2_1', 'jump');

    const armed = makeApi(makeStatus({ transition: 'jump' }));
    show(armed);
    await waitFor(() =>
      expect(screen.getAllByTestId('decksv2-jump')[1].getAttribute('aria-pressed')).toBe('true'),
    );
    fireEvent.click(screen.getAllByTestId('decksv2-jump')[1]);
    expect(armed.transition).toHaveBeenCalledWith('decksv2_1', 'none');
    fireEvent.click(screen.getAllByTestId('decksv2-crossfade')[1]);
    expect(armed.transition).toHaveBeenCalledWith('decksv2_1', 'crossfade');
  });

  it('commits a fired transition: what was in monitor has become live', async () => {
    const commitTransition = vi.fn().mockResolvedValue(true);
    const api = makeApi(makeStatus({ transition: 'jump', transition_done: true }), {
      commitTransition,
    });
    show(api);
    await waitFor(() => expect(commitTransition).toHaveBeenCalledWith('decksv2_1'));
  });

  it('adds one clip into the first free row, unmuted — it comes right in on monitor', async () => {
    const status = makeStatus();
    status.slots[0] = loadedSlot(0);
    const api = makeApi(status);
    show(api);
    // The button is disabled until the first poll lands a status.
    await waitFor(() =>
      expect((screen.getByTestId('decksv2-add-clip') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('decksv2-add-clip'));
    const rows = await screen.findAllByTestId('decks-clip-row');
    fireEvent.click(rows[0]);
    await waitFor(() => expect(api.loadV2).toHaveBeenCalledWith('decksv2_1', 1, 'c1', false));
  });

  it('adds every clip from a song at once, all muted', async () => {
    const api = makeApi(makeStatus());
    show(api);
    await waitFor(() =>
      expect((screen.getByTestId('decksv2-add-song') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('decksv2-add-song'));
    await waitFor(() => expect(screen.getByTestId('decksv2-song-picker')).toBeTruthy());
    // Both songs offered; the orphan clip has no song to be offered by.
    expect(screen.getByTestId('decksv2-song-song-a')).toBeTruthy();
    expect(screen.getByTestId('decksv2-song-song-b')).toBeTruthy();
    fireEvent.click(screen.getByTestId('decksv2-song-song-a'));
    await waitFor(() => expect(api.loadV2).toHaveBeenCalledTimes(2));
    expect(api.loadV2).toHaveBeenCalledWith('decksv2_1', 0, 'c1', true);
    expect(api.loadV2).toHaveBeenCalledWith('decksv2_1', 1, 'c2', true);
  });

  it('a single-clip song still comes in live on the monitor (unmuted)', async () => {
    const api = makeApi(makeStatus());
    show(api);
    await waitFor(() =>
      expect((screen.getByTestId('decksv2-add-song') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('decksv2-add-song'));
    fireEvent.click(await screen.findByTestId('decksv2-song-song-b'));
    await waitFor(() => expect(api.loadV2).toHaveBeenCalledWith('decksv2_1', 0, 'c3', false));
  });

  it('carries the Decks top bar: the tempo walk, the masters and the transport', async () => {
    const api = makeApi(makeStatus());
    show(api);
    await waitFor(() => expect(screen.getByTestId('decksv2-smooth')).toBeTruthy());
    expect(screen.getByTestId('decksv2-smooth-rate')).toBeTruthy();
    expect(screen.getByTestId('decksv2-bpm')).toBeTruthy();
    expect(screen.getByTestId('decksv2-master-live')).toBeTruthy();
    expect(screen.getByTestId('decksv2-master-monitor')).toBeTruthy();

    fireEvent.change(screen.getByTestId('decksv2-master-live'), { target: { value: '0.4' } });
    expect(api.setMaster).toHaveBeenCalledWith('decksv2_1', 'live', 0.4);
    fireEvent.click(screen.getByTestId('decksv2-stop'));
    expect(api.setRunning).toHaveBeenCalledWith('decksv2_1', false);

    // Each grid's own mute: the pair's fader to zero and back.
    fireEvent.click(screen.getByTestId('decksv2-side-mute-monitor'));
    expect(api.setMaster).toHaveBeenCalledWith('decksv2_1', 'monitor', 0);
  });

  it('ejecting a row clears its slot', async () => {
    const status = makeStatus();
    status.slots[0] = loadedSlot(0);
    const api = makeApi(status);
    show(api);
    await waitFor(() => expect(screen.getByTestId('decksv2-eject-0')).toBeTruthy());
    fireEvent.click(screen.getByTestId('decksv2-eject-0'));
    expect(api.clear).toHaveBeenCalledWith('decksv2_1', 0);
  });
});

describe('songsOf', () => {
  it('groups clips by their source song and leaves orphans out', () => {
    const songs = songsOf(CLIPS);
    expect(songs.map((s) => s.hash).sort()).toEqual(['song-a', 'song-b']);
    expect(songs.find((s) => s.hash === 'song-a')?.clips.map((c) => c.clipId)).toEqual([
      'c1',
      'c2',
    ]);
  });
});
