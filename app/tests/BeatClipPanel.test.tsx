// Beat Clip module panel: the readout of what clip is loaded, what the
// clock is doing with it and which beat is playing, against a mock API.

import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BeatClipPanel } from '../src/components/BeatClipPanel';
import type { BeatClipApi, BeatClipStatus } from '../src/beatClip';

function makeStatus(over: Partial<BeatClipStatus> = {}): BeatClipStatus {
  return {
    clip: { project: 'p1', clip: '2', name: 'intro loop', stems: ['drums', 'bass'] },
    duration_secs: 3.75,
    position_secs: 0.94,
    beats: 8,
    beat: 2,
    bpm: 128,
    clock_bpm: 132.5,
    playing: true,
    ...over,
  };
}

function makeApi(status: BeatClipStatus): BeatClipApi {
  return {
    list: vi.fn().mockResolvedValue([]),
    load: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue(status),
    delete: vi.fn().mockResolvedValue([]),
    audio: vi.fn().mockResolvedValue(null),
    peaks: vi.fn().mockResolvedValue([]),
    gridSave: vi.fn().mockResolvedValue(undefined),
    gridLoad: vi.fn().mockResolvedValue(null),
    gridList: vi.fn().mockResolvedValue([]),
  };
}

describe('BeatClipPanel', () => {
  it('names the clip and reports its length, tempo and the clock driving it', async () => {
    const api = makeApi(makeStatus());
    render(<BeatClipPanel instanceId="beatclip1" api={api} pollMs={100000} />);
    await waitFor(() =>
      expect(screen.getByTestId('beat-clip-name').textContent).toBe('intro loop'),
    );
    expect(screen.getByTestId('beat-clip-length').textContent).toBe('8 beats · 128.0 BPM');
    expect(screen.getByTestId('beat-clip-clock').textContent).toBe('clock 132.5 BPM');
  });

  it('says which parts of a track the clip it plays is made of', async () => {
    const api = makeApi(makeStatus());
    render(<BeatClipPanel instanceId="beatclip1" api={api} pollMs={100000} />);
    await waitFor(() => expect(screen.getByTestId('beat-clip-stems')).toBeTruthy());
    expect(screen.getByTestId('beat-clip-stems').textContent).toBe('drumsbass');
  });

  it('shows no tags at all for a clip bound before clips said', async () => {
    const api = makeApi(makeStatus({ clip: { project: 'p1', clip: '2', name: 'intro loop' } }));
    render(<BeatClipPanel instanceId="beatclip1" api={api} pollMs={100000} />);
    await waitFor(() =>
      expect(screen.getByTestId('beat-clip-name').textContent).toBe('intro loop'),
    );
    expect(screen.queryByTestId('beat-clip-stems')).toBeNull();
  });

  it('lights the beat the engine says it is playing', async () => {
    const api = makeApi(makeStatus({ beat: 3 }));
    render(<BeatClipPanel instanceId="beatclip1" api={api} pollMs={100000} />);
    await waitFor(() => expect(screen.getByTestId('beat-clip-beat').children.length).toBe(8));
    const dots = [...screen.getByTestId('beat-clip-beat').children];
    expect(dots.filter((d) => d.className.includes('on')).length).toBe(1);
    expect(dots[3].className).toContain('on');
  });

  it('a module with no clock says so instead of showing a beat', async () => {
    const api = makeApi(makeStatus({ beat: -1, clock_bpm: 0, playing: false }));
    render(<BeatClipPanel instanceId="beatclip1" api={api} pollMs={100000} />);
    await waitFor(() =>
      expect(screen.getByTestId('beat-clip-clock').textContent).toBe('waiting for clock'),
    );
    const dots = [...screen.getByTestId('beat-clip-beat').children];
    expect(dots.some((d) => d.className.includes('on'))).toBe(false);
  });

  it('an unbound module reads as empty rather than blank', async () => {
    const api = makeApi(makeStatus({ clip: null, beats: 0, beat: -1, bpm: 120, clock_bpm: 0 }));
    render(<BeatClipPanel instanceId="beatclip1" api={api} pollMs={100000} />);
    await waitFor(() => expect(screen.getByTestId('beat-clip-name').textContent).toBe('no clip'));
    expect(screen.getByTestId('beat-clip-beat').children.length).toBe(0);
  });
});
