// Audio module panel: status polling (length + tempo readout) and loading
// a library track through the selector, against a mock AudioApi.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AudioPanel } from '../src/components/AudioPanel';
import type { AudioApi, AudioStatus } from '../src/audio';
import type { Track } from '../src/library';

function makeStatus(over: Partial<AudioStatus> = {}): AudioStatus {
  return {
    track: '/music/test-track.wav',
    duration_secs: 95.5,
    bpm: 128,
    speed: 1,
    ...over,
  };
}

function makeApi(status: AudioStatus): AudioApi {
  return {
    load: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue(status),
  };
}

const TRACKS: Track[] = [
  {
    id: 42,
    title: 'Test Track',
    artist: 'Tester',
    album: '',
    file_path: '/music/test-track.wav',
    content_hash: 'abc',
    format: 'wav',
    duration_secs: 95.5,
    sample_rate: 48000,
    channels: 2,
    source: 'local',
    source_ref: '',
    license: { kind: 'unknown', name: '', url: '', attribution: '' },
    analysis_status: 'done',
    bpm: 128,
    musical_key: null,
    created_at: '',
    updated_at: '',
  },
];

describe('AudioPanel', () => {
  it('polls status and shows the track, its length and its tempo', async () => {
    const api = makeApi(makeStatus());
    render(<AudioPanel instanceId="audio1" api={api} tracks={TRACKS} pollMs={100000} />);
    await waitFor(() =>
      expect(screen.getByTestId('audio-tempo').textContent).toBe('128.0 BPM · 1.00×'),
    );
    expect(screen.getByTestId('audio-length').textContent).toBe('1:35.5');
    expect(screen.getByText('test-track.wav')).toBeTruthy();
  });

  it('shows the tempo the BPM and speed inputs are at', async () => {
    const api = makeApi(makeStatus({ bpm: 160, speed: 1.25 }));
    render(<AudioPanel instanceId="audio1" api={api} tracks={TRACKS} pollMs={100000} />);
    await waitFor(() =>
      expect(screen.getByTestId('audio-tempo').textContent).toBe('160.0 BPM · 1.25×'),
    );
  });

  it('loads a library track and refreshes the rack (load moves the knobs)', async () => {
    const api = makeApi(makeStatus());
    const onLoaded = vi.fn();
    render(
      <AudioPanel
        instanceId="audio1"
        api={api}
        tracks={TRACKS}
        onLoaded={onLoaded}
        pollMs={100000}
      />,
    );
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('audio-track-select'), { target: { value: '42' } });
    await waitFor(() => expect(api.load).toHaveBeenCalledWith('audio1', 42));
    await waitFor(() => expect(onLoaded).toHaveBeenCalled());
  });

  it('renders placeholders before the first status arrives', () => {
    const api: AudioApi = {
      load: vi.fn().mockResolvedValue(null),
      status: vi.fn().mockResolvedValue(null),
    };
    render(<AudioPanel instanceId="audio1" api={api} pollMs={100000} />);
    expect(screen.getByTestId('audio-tempo').textContent).toBe('— BPM · —×');
    expect(screen.getByText('load track…')).toBeTruthy();
  });
});
