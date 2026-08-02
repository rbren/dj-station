// DJ Deck panel: status polling, track load, transport, hot cues (set /
// jump / clear), loop controls, tap tempo / grid nudging, sync selection,
// and keylock/slip/reverse param toggles — all against a mock DeckApi.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeckPanel } from '../src/components/DeckPanel';
import type { DeckApi, DeckStatus } from '../src/deck';
import type { Track } from '../src/library';
import type { ModuleHandle } from '../src/types';

function makeStatus(over: Partial<DeckStatus> = {}): DeckStatus {
  return {
    track: '/music/test-track.wav',
    duration_secs: 120,
    position_secs: 30,
    rate: 1,
    playing: false,
    grid_bpm: 128,
    grid_anchor_secs: 0.5,
    effective_bpm: 128,
    cues: [5, null, null, null, null, null, null, null],
    loop_start_secs: 10,
    loop_end_secs: 12,
    loop_enabled: false,
    sync_to: null,
    ...over,
  };
}

function makeApi(status: DeckStatus): DeckApi {
  return {
    load: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue(status),
    waveform: vi.fn().mockResolvedValue([0.1, 0.5, 0.9]),
    seek: vi.fn().mockResolvedValue(null),
    setCue: vi.fn().mockResolvedValue(null),
    setLoop: vi.fn().mockResolvedValue(null),
    loopEnable: vi.fn().mockResolvedValue(null),
    loopHalve: vi.fn().mockResolvedValue(null),
    loopDouble: vi.fn().mockResolvedValue(null),
    saveLoop: vi.fn().mockResolvedValue(1),
    savedLoops: vi.fn().mockResolvedValue([{ id: 7, name: 'drop', start_secs: 60, end_secs: 64 }]),
    setBeatgrid: vi.fn().mockResolvedValue(null),
    tapTempo: vi.fn().mockResolvedValue([128, 0.5]),
    nudgeBeatgrid: vi.fn().mockResolvedValue(null),
    anchorHere: vi.fn().mockResolvedValue(null),
    sync: vi.fn().mockResolvedValue(null),
  };
}

const HANDLE: ModuleHandle = {
  paramValue: () => 0,
  setParam: vi.fn(),
  signalTap: () => ({ instantaneous: 0, rms_100ms: 0, display: 0, is_fast: false }),
  size: { w: 360, h: 260 },
};

const TRACKS: Track[] = [
  {
    id: 42,
    title: 'Test Track',
    artist: 'Tester',
    album: '',
    file_path: '/music/test-track.wav',
    content_hash: 'abc',
    format: 'wav',
    duration_secs: 120,
    sample_rate: 48000,
    channels: 2,
    source: 'local',
    source_ref: '',
    license: { kind: 'unknown', name: '', url: '', attribution: '' },
    analysis_status: 'queued',
    bpm: null,
    musical_key: null,
    created_at: '',
    updated_at: '',
  },
];

function renderPanel(api: DeckApi, extra: Partial<Parameters<typeof DeckPanel>[0]> = {}) {
  return render(
    <DeckPanel
      instanceId="deckA"
      handle={HANDLE}
      api={api}
      tracks={TRACKS}
      otherDecks={['deckB']}
      pollMs={100000}
      {...extra}
    />,
  );
}

describe('DeckPanel', () => {
  it('polls status and shows BPM, time, and the waveform', async () => {
    const api = makeApi(makeStatus());
    renderPanel(api);
    await waitFor(() => expect(screen.getByTestId('deck-bpm').textContent).toBe('128.0 BPM'));
    expect(screen.getByTestId('deck-time').textContent).toContain('0:30.0');
    expect(api.waveform).toHaveBeenCalledWith('deckA', expect.any(Number));
    expect(screen.getByTestId('waveform')).toBeTruthy();
  });

  it('loads a library track through the selector', async () => {
    const api = makeApi(makeStatus());
    renderPanel(api);
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('deck-track-select'), { target: { value: '42' } });
    await waitFor(() => expect(api.load).toHaveBeenCalledWith('deckA', 42));
  });

  it('play button drives the play_gate', async () => {
    const api = makeApi(makeStatus({ playing: false }));
    const onPlayGate = vi.fn();
    renderPanel(api, { onPlayGate });
    await waitFor(() => expect(screen.getByTestId('deck-play').textContent).toBe('Play'));
    fireEvent.click(screen.getByTestId('deck-play'));
    expect(onPlayGate).toHaveBeenCalledWith(true);
  });

  it('hot cues: filled slot jumps, empty slot sets at playhead, right-click clears', async () => {
    const api = makeApi(makeStatus());
    renderPanel(api);
    await waitFor(() =>
      expect(screen.getByTestId('deck-cue-1').classList.contains('set')).toBe(true),
    );
    // Slot 1 has a cue at 5 s -> click seeks there.
    fireEvent.click(screen.getByTestId('deck-cue-1'));
    await waitFor(() => expect(api.seek).toHaveBeenCalledWith('deckA', 5));
    // Slot 2 is empty -> click sets it at the playhead (30 s).
    fireEvent.click(screen.getByTestId('deck-cue-2'));
    await waitFor(() => expect(api.setCue).toHaveBeenCalledWith('deckA', 1, 30));
    // Right-click clears.
    fireEvent.contextMenu(screen.getByTestId('deck-cue-1'));
    await waitFor(() => expect(api.setCue).toHaveBeenCalledWith('deckA', 0, null));
  });

  it('loop controls: in/out sets and engages, toggle, halve/double, save, saved loops', async () => {
    const api = makeApi(makeStatus({ position_secs: 40 }));
    renderPanel(api);
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('deck-loop-in')); // in at 40
    fireEvent.click(screen.getByTestId('deck-loop-out')); // out at 40? same pos -> ignored
    expect(api.setLoop).not.toHaveBeenCalled();
    // With a distinct in point behind the playhead it engages.
    fireEvent.click(screen.getByTestId('deck-loop-toggle'));
    await waitFor(() => expect(api.loopEnable).toHaveBeenCalledWith('deckA', true));
    fireEvent.click(screen.getByTestId('deck-loop-halve'));
    await waitFor(() => expect(api.loopHalve).toHaveBeenCalledWith('deckA'));
    fireEvent.click(screen.getByTestId('deck-loop-double'));
    await waitFor(() => expect(api.loopDouble).toHaveBeenCalledWith('deckA'));
    fireEvent.click(screen.getByTestId('deck-loop-save'));
    await waitFor(() => expect(api.saveLoop).toHaveBeenCalled());
    // Saved loop from the library is listed and re-activates the region.
    const saved = await screen.findByTestId('deck-saved-loop-7');
    fireEvent.click(saved);
    await waitFor(() => expect(api.setLoop).toHaveBeenCalledWith('deckA', 60, 64));
  });

  it('beatgrid controls call tap/nudge/anchor', async () => {
    const api = makeApi(makeStatus());
    renderPanel(api);
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('deck-tap'));
    await waitFor(() => expect(api.tapTempo).toHaveBeenCalledWith('deckA'));
    fireEvent.click(screen.getByTestId('deck-nudge-back'));
    await waitFor(() => expect(api.nudgeBeatgrid).toHaveBeenCalledWith('deckA', -0.01));
    fireEvent.click(screen.getByTestId('deck-nudge-fwd'));
    await waitFor(() => expect(api.nudgeBeatgrid).toHaveBeenCalledWith('deckA', 0.01));
    fireEvent.click(screen.getByTestId('deck-anchor'));
    await waitFor(() => expect(api.anchorHere).toHaveBeenCalledWith('deckA'));
  });

  it('sync selector offers other decks and clears with off', async () => {
    const api = makeApi(makeStatus());
    renderPanel(api);
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('deck-sync-select'), { target: { value: 'deckB' } });
    await waitFor(() => expect(api.sync).toHaveBeenCalledWith('deckA', 'deckB'));
    fireEvent.change(screen.getByTestId('deck-sync-select'), { target: { value: '' } });
    await waitFor(() => expect(api.sync).toHaveBeenCalledWith('deckA', null));
  });

  it('keylock/slip/reverse buttons toggle the module params', async () => {
    const setParam = vi.fn();
    const handle: ModuleHandle = {
      ...HANDLE,
      setParam,
      paramValue: (id) => (id === 'slip' ? 1 : 0),
    };
    const api = makeApi(makeStatus());
    render(<DeckPanel instanceId="deckA" handle={handle} api={api} pollMs={100000} />);
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('deck-keylock'));
    expect(setParam).toHaveBeenCalledWith('keylock', 1);
    // slip is currently on -> toggle turns it off.
    expect(screen.getByTestId('deck-slip').classList.contains('active')).toBe(true);
    fireEvent.click(screen.getByTestId('deck-slip'));
    expect(setParam).toHaveBeenCalledWith('slip', 0);
    fireEvent.click(screen.getByTestId('deck-reverse'));
    expect(setParam).toHaveBeenCalledWith('reverse', 1);
  });
});
