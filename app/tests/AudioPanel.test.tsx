// Audio module panel: status polling (transport + tempo readout), the
// waveform with its playhead, the loop toggle and loading a library track
// through the selector, against a mock AudioApi.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AudioPanel, extrapolate } from '../src/components/AudioPanel';
import type { AudioApi, AudioStatus } from '../src/audio';
import type { Track } from '../src/library';

function makeStatus(over: Partial<AudioStatus> = {}): AudioStatus {
  return {
    track: '/music/test-track.wav',
    duration_secs: 95.5,
    position_secs: 0,
    rate: 1,
    playing: false,
    bpm: 128,
    speed: 1,
    looping: true,
    ...over,
  };
}

function makeApi(status: AudioStatus): AudioApi {
  return {
    load: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue(status),
    waveform: vi.fn().mockResolvedValue([0, 0.5, 1, 0.5]),
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
  it('polls status and shows the track, its position and its tempo', async () => {
    const api = makeApi(makeStatus({ position_secs: 12 }));
    render(<AudioPanel instanceId="audio1" api={api} tracks={TRACKS} pollMs={100000} />);
    await waitFor(() =>
      expect(screen.getByTestId('audio-tempo').textContent).toBe('128.0 BPM · 1.00×'),
    );
    expect(screen.getByTestId('audio-time').textContent).toBe('0:12.0 / 1:35.5');
    expect(screen.getByText('test-track.wav')).toBeTruthy();
  });

  it('shows the tempo the BPM and speed inputs are at', async () => {
    const api = makeApi(makeStatus({ bpm: 160, speed: 1.25 }));
    render(<AudioPanel instanceId="audio1" api={api} tracks={TRACKS} pollMs={100000} />);
    await waitFor(() =>
      expect(screen.getByTestId('audio-tempo').textContent).toBe('160.0 BPM · 1.25×'),
    );
  });

  it('draws the track waveform with the playhead at the current position', async () => {
    // Parked, not playing: a playing panel extrapolates the playhead off
    // the wall clock, so the drawn x drifts with however long the render
    // took. `extrapolate` is pinned on its own below.
    const api = makeApi(makeStatus({ position_secs: 95.5 / 4, playing: false }));
    render(<AudioPanel instanceId="audio1" api={api} tracks={TRACKS} pollMs={100000} />);
    await waitFor(() => expect(api.waveform).toHaveBeenCalledWith('audio1', 600));
    const peaks = screen.getByTestId('audio-waveform').querySelector('.waveform-peaks');
    await waitFor(() => expect(peaks?.getAttribute('d')?.length).toBeGreaterThan(0));
    // A quarter of the way in = a quarter across the 1000-unit viewBox.
    const head = screen.getByTestId('audio-playhead');
    expect(Number(head.getAttribute('x1'))).toBeCloseTo(250, 3);
  });

  it('refetches the waveform only when the loaded track changes', async () => {
    const api = makeApi(makeStatus());
    render(<AudioPanel instanceId="audio1" api={api} tracks={TRACKS} pollMs={5} />);
    await waitFor(() =>
      expect((api.status as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(3),
    );
    expect(api.waveform).toHaveBeenCalledTimes(1);
  });

  it('shows looping as on by default and toggles it off', async () => {
    const api = makeApi(makeStatus());
    const onLoop = vi.fn();
    render(<AudioPanel instanceId="audio1" api={api} onLoop={onLoop} pollMs={100000} />);
    const button = screen.getByTestId('audio-loop');
    await waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('true'));
    expect(button.className).toContain('on');
    fireEvent.click(button);
    expect(onLoop).toHaveBeenCalledWith(false);
  });

  it('turns looping back on from a one-shot module', async () => {
    const api = makeApi(makeStatus({ looping: false }));
    const onLoop = vi.fn();
    render(<AudioPanel instanceId="audio1" api={api} onLoop={onLoop} pollMs={100000} />);
    const button = screen.getByTestId('audio-loop');
    await waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('false'));
    fireEvent.click(button);
    expect(onLoop).toHaveBeenCalledWith(true);
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
      waveform: vi.fn().mockResolvedValue(null),
    };
    render(<AudioPanel instanceId="audio1" api={api} pollMs={100000} />);
    expect(screen.getByTestId('audio-tempo').textContent).toBe('— BPM · —×');
    expect(screen.getByText('load track…')).toBeTruthy();
  });
});

describe('extrapolate (between-poll playhead)', () => {
  it('advances at the reported rate', () => {
    const st = makeStatus({ position_secs: 10, rate: 2, playing: true });
    expect(extrapolate(st, 0.5)).toBeCloseTo(11, 6);
  });

  it('wraps a looping track instead of stopping at the end', () => {
    const st = makeStatus({ duration_secs: 4, position_secs: 3.5, rate: 1, playing: true });
    expect(extrapolate(st, 1)).toBeCloseTo(0.5, 6);
  });

  it('clamps a one-shot track at its end', () => {
    const st = makeStatus({ duration_secs: 4, position_secs: 3.5, rate: 1, looping: false });
    expect(extrapolate(st, 1)).toBeCloseTo(4, 6);
  });
});
