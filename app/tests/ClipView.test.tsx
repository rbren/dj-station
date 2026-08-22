// Clip page: load a library track, edit it (select, cut, reverse, EQ,
// automation) and save the result as a NEW library track. The backend is
// mocked; the edit math itself is pinned by ClipEdits.test.ts.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipView } from '../src/components/ClipView';
import type { ClipClientApi, ClipRequest, ClipSource } from '../src/clip';
import type { LibraryClientApi, Track } from '../src/library';

const TRACK: Track = {
  id: 7,
  title: 'Basement Loop',
  artist: 'Me',
  album: '',
  file_path: '/data/loops/basement.wav',
  content_hash: 'abc',
  format: 'wav',
  duration_secs: 10,
  sample_rate: 48000,
  channels: 2,
  source: 'watch',
  source_ref: '',
  license: { kind: 'unknown', name: '', url: '', attribution: '' },
  analysis_status: 'done',
  bpm: 120,
  musical_key: 'Am',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const OTHER: Track = { ...TRACK, id: 8, title: 'Hat Loop' };

const SOURCE: ClipSource = {
  track_id: 7,
  title: TRACK.title,
  artist: TRACK.artist,
  duration_secs: 10,
  sample_rate: 48000,
  channels: 2,
  peaks: Array.from({ length: 50 }, (_, i) => (i % 10) / 10),
};

function libraryMock(): LibraryClientApi {
  return {
    tracks: vi.fn(async () => [TRACK, OTHER]),
    search: vi.fn(async () => []),
    providers: vi.fn(async () => []),
    searchProvider: vi.fn(async () => []),
    importTrack: vi.fn(async () => null),
    importRekordbox: vi.fn(async () => null),
    downloadTrack: vi.fn(async () => null),
    openStorePage: vi.fn(async () => null),
    openExternal: vi.fn(async () => null),
    playbackLoad: vi.fn(async () => null),
    analysisStatus: vi.fn(async () => null),
    analyzeTrack: vi.fn(async () => null),
  } as unknown as LibraryClientApi;
}

function clipMock(overrides: Partial<ClipClientApi> = {}): ClipClientApi {
  return {
    loadSource: vi.fn(async (trackId: number) => ({
      ...SOURCE,
      track_id: trackId,
      title: trackId === OTHER.id ? OTHER.title : SOURCE.title,
    })),
    renderPreview: vi.fn(async () => ({
      duration_secs: 10,
      sample_rate: 48000,
      channels: 2,
      peaks: SOURCE.peaks,
    })),
    previewAudio: vi.fn(async () => new ArrayBuffer(44)),
    save: vi.fn(async (_r: ClipRequest, title: string) => ({ ...TRACK, id: 99, title })),
    ...overrides,
  };
}

/** jsdom has no layout: give the editor SVG a width so time math works. */
function sizeTimeline(testId: string, width = 1000) {
  const el = screen.getByTestId(testId);
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height: 100, right: width, bottom: 100 }) as DOMRect;
  return el;
}

async function openTrack(clip: ClipClientApi, library = libraryMock()) {
  render(<ClipView clip={clip} library={library} />);
  await waitFor(() => expect(screen.getByTestId('clip-track-select')).toBeTruthy());
  fireEvent.click(screen.getByTestId('clip-open-track'));
  await waitFor(() => expect(screen.getByTestId('clip-waveform')).toBeTruthy());
}

/** Drag a selection across the output waveform, in seconds of a 10 s clip. */
function select(fromSecs: number, toSecs: number) {
  const wave = sizeTimeline('clip-waveform');
  fireEvent.mouseDown(wave, { clientX: fromSecs * 100 });
  fireEvent.mouseMove(window, { clientX: toSecs * 100 });
  fireEvent.mouseUp(window);
}

describe('ClipView', () => {
  beforeEach(() => {
    vi.useRealTimers();
    // jsdom has no blob URLs; the audition path needs them to hand WAV
    // bytes to the <audio> element.
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:clip'),
      revokeObjectURL: vi.fn(),
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: vi.fn(async () => {}),
    });
  });

  it('starts empty and explains that saving never overwrites the source', async () => {
    render(<ClipView clip={clipMock()} library={libraryMock()} />);
    expect(screen.getByTestId('clip-empty').textContent).toMatch(/never overwritten/i);
    await waitFor(() => expect(screen.getByTestId('clip-track-select')).toBeTruthy());
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Basement Loop — Me',
      'Hat Loop — Me',
    ]);
  });

  it('opens a library track as a single full-length region', async () => {
    const clip = clipMock();
    await openTrack(clip);
    expect(clip.loadSource).toHaveBeenCalledWith(7, expect.any(Number));
    const rows = screen.getAllByTestId('clip-region');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('0:00.00');
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:10.00 total');
    expect((screen.getByTestId('clip-title') as HTMLInputElement).value).toBe(
      'Basement Loop (clip)',
    );
  });

  it('drag-selects a range and cuts it, splicing the remainder', async () => {
    await openTrack(clipMock());
    select(3, 7);
    expect(screen.getByTestId('clip-selection')).toBeTruthy();
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:03.00–0:07.00');

    fireEvent.click(screen.getByTestId('clip-cut'));
    const rows = screen.getAllByTestId('clip-region');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('0:03.00');
    expect(rows[1].textContent).toContain('0:07.00');
  });

  it('trims, reverses and re-trims the level of a selection', async () => {
    await openTrack(clipMock());
    select(2, 6);
    fireEvent.click(screen.getByTestId('clip-trim'));
    expect(screen.getAllByTestId('clip-region')).toHaveLength(1);

    select(0, 2);
    fireEvent.click(screen.getByTestId('clip-reverse'));
    expect(screen.getAllByTestId('clip-region')[0].textContent).toContain('◀');

    fireEvent.click(screen.getByTestId('clip-quieter'));
    expect(screen.getAllByTestId('clip-region')[0].textContent).toContain('-3.0 dB');
  });

  it('undo restores the previous edit', async () => {
    await openTrack(clipMock());
    select(3, 7);
    fireEvent.click(screen.getByTestId('clip-cut'));
    expect(screen.getAllByTestId('clip-region')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('clip-undo'));
    expect(screen.getAllByTestId('clip-region')).toHaveLength(1);
  });

  it('splices a second library track onto the end', async () => {
    const clip = clipMock();
    await openTrack(clip);
    fireEvent.change(screen.getByTestId('clip-track-select'), { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('clip-append-track'));
    await waitFor(() => expect(screen.getAllByTestId('clip-region')).toHaveLength(2));
    expect(clip.loadSource).toHaveBeenLastCalledWith(8, expect.any(Number));
    expect(screen.getByTestId('clip-sources').textContent).toContain('2. Hat Loop');
    expect(screen.getAllByTestId('clip-region')[1].textContent).toContain('Hat Loop');
  });

  it('fades and automation points land on the level lane', async () => {
    await openTrack(clipMock());
    fireEvent.click(screen.getByTestId('clip-fade-in'));
    expect(screen.getByTestId('clip-level-point-0')).toBeTruthy();
    expect(screen.getByTestId('clip-level-point-1')).toBeTruthy();

    // Click the lane at 5 s to add a breakpoint; right-click removes it.
    const lane = sizeTimeline('clip-level-lane');
    fireEvent.mouseDown(lane, { clientX: 500, clientY: 45 });
    expect(screen.getByTestId('clip-level-point-2')).toBeTruthy();
    fireEvent.contextMenu(screen.getByTestId('clip-level-point-2'));
    expect(screen.queryByTestId('clip-level-point-2')).toBeNull();

    fireEvent.click(screen.getByTestId('clip-clear-level'));
    expect(screen.queryByTestId('clip-level-point-0')).toBeNull();
  });

  it('EQ sliders feed the rendered program', async () => {
    const clip = clipMock();
    await openTrack(clip);
    fireEvent.change(screen.getByTestId('clip-eq-low'), { target: { value: '4.5' } });
    await waitFor(() => {
      const calls = (clip.renderPreview as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[calls.length - 1][0].program.eq.low_db).toBe(4.5);
    });
  });

  it('saves the edit as a new library track and reports it', async () => {
    const clip = clipMock();
    const onSaved = vi.fn();
    render(<ClipView clip={clip} library={libraryMock()} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByTestId('clip-track-select')).toBeTruthy());
    fireEvent.click(screen.getByTestId('clip-open-track'));
    await waitFor(() => expect(screen.getByTestId('clip-waveform')).toBeTruthy());

    fireEvent.change(screen.getByTestId('clip-title'), { target: { value: 'Basement Edit' } });
    fireEvent.click(screen.getByTestId('clip-save'));
    await waitFor(() =>
      expect(screen.getByTestId('clip-status').textContent).toMatch(/new track/i),
    );

    const [request, title] = (clip.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.sources).toEqual([7]);
    expect(request.program.regions).toHaveLength(1);
    expect(title).toBe('Basement Edit');
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ title: 'Basement Edit' }));
  });

  it('auditions the rendered edit through the preview client', async () => {
    const clip = clipMock();
    await openTrack(clip);
    select(1, 4);
    fireEvent.click(screen.getByTestId('clip-audition'));
    await waitFor(() => expect(clip.previewAudio).toHaveBeenCalled());
    const [, from, secs] = (clip.previewAudio as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(from).toBeCloseTo(1, 5);
    expect(secs).toBeCloseTo(3, 5);
  });
});
