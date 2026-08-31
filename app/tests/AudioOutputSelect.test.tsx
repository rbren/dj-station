// The output pickers in the Decks top bar: which hardware each bus plays
// out of, one select beside each master fader — and what they say when a
// device leaves under the set.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecksView } from '../src/components/DecksView';
import type { DecksApi, DecksStatus, DeckSlotStatus } from '../src/decks';
import type { AudioOutputSettings, AudioOutputsApi } from '../src/audioOutputs';

const NO_POLL = 100000;

function settings(over: Partial<AudioOutputSettings> = {}): AudioOutputSettings {
  return {
    devices: ['Speakers', 'Headphones'],
    live: null,
    monitor: null,
    playing_live: 'Speakers',
    playing_monitor: null,
    note: null,
    ...over,
  };
}

function makeOutputs(state: AudioOutputSettings = settings(), over: Partial<AudioOutputsApi> = {}) {
  return {
    get: vi.fn().mockResolvedValue(state),
    set: vi.fn().mockResolvedValue(null),
    ...over,
  } satisfies AudioOutputsApi;
}

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

const STATUS: DecksStatus = {
  bpm: 128,
  running: true,
  beat: 4.25,
  cycle_beats: 8,
  surface: true,
  surface_connected: true,
  master_live: 1,
  master_monitor: 1,
  v2: false,
  transition: 'none',
  transition_done: false,
  xfade: 0,
  slots: Array.from({ length: 8 }, (_, i) => emptySlot(i)),
};

function makeDecks(): DecksApi {
  return {
    banks: vi.fn().mockResolvedValue(['decks1']),
    ensure: vi.fn().mockResolvedValue('decks1'),
    status: vi.fn().mockResolvedValue(STATUS),
    load: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue(null),
    setControl: vi.fn().mockResolvedValue(null),
    setMaster: vi.fn().mockResolvedValue(null),
    arm: vi.fn().mockResolvedValue(null),
    setTail: vi.fn().mockResolvedValue(null),
    setPhase: vi.fn().mockResolvedValue(null),
    setRatio: vi.fn().mockResolvedValue(null),
    setBpm: vi.fn().mockResolvedValue(null),
    setSurface: vi.fn().mockResolvedValue(null),
    setRunning: vi.fn().mockResolvedValue(null),
    rehydrate: vi.fn().mockResolvedValue(0),
    endEdit: vi.fn().mockResolvedValue(null),
  };
}

function renderBar(outputs: AudioOutputsApi) {
  render(<DecksView api={makeDecks()} outputs={outputs} pollMs={NO_POLL} />);
}

afterEach(() => vi.useRealTimers());

describe('the output device pickers in the decks bar', () => {
  it('sit one beside each master fader, in that pair\u2019s own row', async () => {
    renderBar(makeOutputs());

    const live = await screen.findByTestId('audio-output-live');
    expect(live.closest('[data-testid="decks-out-live"]')).not.toBeNull();
    expect(
      screen.getByTestId('audio-output-monitor').closest('[data-testid="decks-out-monitor"]'),
    ).not.toBeNull();
  });

  it('send the live mix and the cue to devices of their own', async () => {
    const api = makeOutputs(settings({ live: 'Speakers' }));
    renderBar(api);

    const live = await screen.findByTestId<HTMLSelectElement>('audio-output-live');
    await waitFor(() => expect(live.value).toBe('Speakers'));

    fireEvent.change(screen.getByTestId('audio-output-monitor'), {
      target: { value: 'Headphones' },
    });
    await waitFor(() => expect(api.set).toHaveBeenCalledWith('Speakers', 'Headphones'));
  });

  it('still show a remembered device that is not plugged in today', async () => {
    const api = makeOutputs(settings({ devices: ['Speakers'], monitor: 'Old Interface' }));
    renderBar(api);

    const monitor = await screen.findByTestId<HTMLSelectElement>('audio-output-monitor');
    await waitFor(() => expect(monitor.value).toBe('Old Interface'));
    expect(monitor.textContent).toContain('not found');
  });

  it('say where the sound actually went when the engine could not play where it was asked', async () => {
    const api = makeOutputs(
      settings({
        devices: ['Speakers'],
        live: 'Headphones',
        playing_live: 'Speakers',
        note: 'Headphones is not here — playing on the system default',
      }),
    );
    renderBar(api);

    const note = await screen.findByTestId('audio-output-note');
    expect(note.textContent).toContain('Headphones is not here');
    expect(screen.getByTestId('decks-outs').dataset.state).toBe('adrift');
  });

  it('keep quiet while the engine is playing where it was asked to', async () => {
    renderBar(makeOutputs(settings({ live: 'Speakers' })));

    await screen.findByTestId('audio-output-live');
    expect(screen.queryByTestId('audio-output-note')).toBeNull();
    expect(screen.getByTestId('decks-outs').dataset.state).toBe('ok');
  });

  it('poll, because a device can leave without the app doing anything', async () => {
    vi.useFakeTimers();
    let state = settings({ live: 'Headphones', playing_live: 'Headphones' });
    const api = makeOutputs(state, { get: vi.fn().mockImplementation(async () => state) });
    render(<DecksView api={makeDecks()} outputs={api} pollMs={1000} />);
    await act(async () => {});
    expect(screen.queryByTestId('audio-output-note')).toBeNull();

    // The headphones come out: the engine falls back on its own, and the
    // picker finds out on its next read.
    state = settings({
      devices: ['Speakers'],
      live: 'Headphones',
      playing_live: 'Speakers',
      note: 'Headphones is gone — playing on the system default',
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('audio-output-note').textContent).toContain('Headphones is gone');
  });
});
