// The output picker in the top chrome: which hardware each bus plays out
// of, and — the reason it is up there — what it says when a device leaves
// under the set.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioOutputPicker } from '../src/components/AudioOutputPicker';
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

function makeApi(state: AudioOutputSettings = settings(), over: Partial<AudioOutputsApi> = {}) {
  return {
    get: vi.fn().mockResolvedValue(state),
    set: vi.fn().mockResolvedValue(null),
    ...over,
  } satisfies AudioOutputsApi;
}

afterEach(() => vi.useRealTimers());

describe('the audio output picker', () => {
  it('sends the live mix and the cue to devices of their own', async () => {
    const api = makeApi(settings({ live: 'Speakers' }));
    render(<AudioOutputPicker api={api} pollMs={NO_POLL} />);

    const live = await screen.findByTestId<HTMLSelectElement>('audio-output-live');
    await waitFor(() => expect(live.value).toBe('Speakers'));

    fireEvent.change(screen.getByTestId('audio-output-monitor'), {
      target: { value: 'Headphones' },
    });
    await waitFor(() => expect(api.set).toHaveBeenCalledWith('Speakers', 'Headphones'));
  });

  it('still shows a remembered device that is not plugged in today', async () => {
    const api = makeApi(settings({ devices: ['Speakers'], monitor: 'Old Interface' }));
    render(<AudioOutputPicker api={api} pollMs={NO_POLL} />);

    const monitor = await screen.findByTestId<HTMLSelectElement>('audio-output-monitor');
    await waitFor(() => expect(monitor.value).toBe('Old Interface'));
    expect(monitor.textContent).toContain('not found');
  });

  it('says where the sound actually went when the engine could not play where it was asked', async () => {
    const api = makeApi(
      settings({
        devices: ['Speakers'],
        live: 'Headphones',
        playing_live: 'Speakers',
        note: 'Headphones is not here — playing on the system default',
      }),
    );
    render(<AudioOutputPicker api={api} pollMs={NO_POLL} />);

    const note = await screen.findByTestId('audio-output-note');
    expect(note.textContent).toContain('Headphones is not here');
    expect(screen.getByTestId('audio-outputs').dataset.state).toBe('adrift');
  });

  it('keeps quiet while the engine is playing where it was asked to', async () => {
    render(<AudioOutputPicker api={makeApi(settings({ live: 'Speakers' }))} pollMs={NO_POLL} />);

    await screen.findByTestId('audio-output-live');
    expect(screen.queryByTestId('audio-output-note')).toBeNull();
    expect(screen.getByTestId('audio-outputs').dataset.state).toBe('ok');
  });

  it('polls, because a device can leave without the app doing anything', async () => {
    vi.useFakeTimers();
    let state = settings({ live: 'Headphones', playing_live: 'Headphones' });
    const api = makeApi(state, { get: vi.fn().mockImplementation(async () => state) });
    render(<AudioOutputPicker api={api} pollMs={1000} />);
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
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('audio-output-note').textContent).toContain('Headphones is gone');
  });
});
