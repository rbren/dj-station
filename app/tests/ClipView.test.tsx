// Clip page: load a library track, edit it (select, drag, cut, reverse,
// overlay, EQ, automation), play the result and save it as a NEW library
// track. The backend is mocked; the edit math itself is pinned by
// ClipEdits.test.ts and the rendered audio by dj-analysis's golden test.

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
    // jsdom has no blob URLs or media playback; the playback path needs
    // them to hand WAV bytes to the <audio> element.
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:clip'),
      revokeObjectURL: vi.fn(),
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: vi.fn(async () => {}),
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value: vi.fn(),
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
    expect((screen.getByTestId('clip-name') as HTMLInputElement).value).toBe(
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

  it('undo and redo respond to buttons and keyboard shortcuts', async () => {
    await openTrack(clipMock());
    expect(screen.getByTestId('clip-undo')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('clip-redo')).toHaveProperty('disabled', true);

    select(3, 7);
    fireEvent.click(screen.getByTestId('clip-cut'));
    expect(screen.getAllByTestId('clip-region')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('clip-undo'));
    expect(screen.getAllByTestId('clip-region')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('clip-redo'));
    expect(screen.getAllByTestId('clip-region')).toHaveLength(2);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(screen.getAllByTestId('clip-region')).toHaveLength(1);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(screen.getAllByTestId('clip-region')).toHaveLength(2);
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
    expect(screen.getAllByTestId('clip-region')).toHaveLength(2);
  });

  it('drags the selection along the timeline to re-splice it', async () => {
    await openTrack(clipMock());
    select(2, 4);
    // Grab the middle of the selection and slide it 3 s to the right.
    const wave = sizeTimeline('clip-waveform');
    fireEvent.mouseDown(wave, { clientX: 300 });
    fireEvent.mouseMove(window, { clientX: 600 });
    fireEvent.mouseUp(window);

    expect(screen.getByTestId('clip-readout').textContent).toContain('0:05.00–0:07.00');
    // Three new joins each eat one 5 ms crossfade (the splice law).
    expect(screen.getByTestId('clip-readout').textContent).toMatch(/0:09\.9\d total/);
    const rows = screen.getAllByTestId('clip-region');
    expect(rows).toHaveLength(4);
    // The moved material sits third: [0-2][4-7][2-4][7-10].
    expect(rows[2].textContent).toContain('0:02.00');
    expect(rows[2].textContent).toContain('0:04.00');

    fireEvent.click(screen.getByTestId('clip-undo'));
    expect(screen.getAllByTestId('clip-region')).toHaveLength(1);
  });

  it('zooms toward the selection and back out to fit', async () => {
    await openTrack(clipMock());
    const wave = screen.getByTestId('clip-waveform');
    expect(screen.getByTestId('clip-zoom-out')).toHaveProperty('disabled', true);
    expect(wave.getAttribute('data-vp-end')).toBe('10.000');

    select(2, 6);
    fireEvent.click(screen.getByTestId('clip-zoom-in'));
    expect(wave.getAttribute('data-vp-start')).toBe('2.000');
    expect(wave.getAttribute('data-vp-end')).toBe('7.000');

    // Selections drawn while zoomed map through the viewport (start
    // outside the old selection so this sweeps a new one).
    sizeTimeline('clip-waveform');
    fireEvent.mouseDown(wave, { clientX: 900 });
    fireEvent.mouseMove(window, { clientX: 500 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:04.50–0:06.50');

    fireEvent.click(screen.getByTestId('clip-zoom-fit'));
    expect(wave.getAttribute('data-vp-start')).toBe('0.000');
    expect(wave.getAttribute('data-vp-end')).toBe('10.000');
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

  it('overlays a second track at the selection and can remove it', async () => {
    const clip = clipMock();
    await openTrack(clip);
    select(2, 6);
    fireEvent.change(screen.getByTestId('clip-track-select'), { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('clip-overlay-track'));
    await waitFor(() => expect(screen.getByTestId('clip-overlay')).toBeTruthy());

    expect(screen.getByTestId('clip-overlay').textContent).toContain('Hat Loop (overlay)');
    expect(screen.getByTestId('clip-overlay').textContent).toContain('0:02.00');
    // A 10 s overlay starting at 2 s extends the clip to 12 s.
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:12.00 total');
    expect(screen.getByTestId('clip-overlay-span-0')).toBeTruthy();

    fireEvent.click(screen.getByTestId('clip-overlay-delete-0'));
    expect(screen.queryByTestId('clip-overlay')).toBeNull();
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:10.00 total');
  });

  it('dragging an EQ handle shapes a band and lands in the program', async () => {
    const clip = clipMock();
    await openTrack(clip);
    // Drag band 1 straight up: gain rises, frequency holds.
    fireEvent.mouseDown(screen.getByTestId('clip-eq-handle-1'), {
      clientX: 50,
      clientY: 80,
      button: 0,
    });
    fireEvent.mouseMove(window, { clientX: 50, clientY: 39 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId('clip-eq-readout').textContent).toContain('+9.9dB');

    await waitFor(() => {
      const calls = (clip.renderPreview as ReturnType<typeof vi.fn>).mock.calls;
      const bands = calls[calls.length - 1][0].program.eq.bands;
      expect(bands[0].gain_db).toBeCloseTo(9.9, 5);
      expect(bands[0].freq_hz).toBeCloseTo(99, 5);
    });

    // The gesture is one undo step.
    fireEvent.click(screen.getByTestId('clip-undo'));
    expect(screen.getByTestId('clip-eq-readout').textContent).toContain('+0.0dB');
  });

  it('saves the edit as a new library track and reports it', async () => {
    const clip = clipMock();
    const onSaved = vi.fn();
    render(<ClipView clip={clip} library={libraryMock()} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByTestId('clip-track-select')).toBeTruthy());
    fireEvent.click(screen.getByTestId('clip-open-track'));
    await waitFor(() => expect(screen.getByTestId('clip-waveform')).toBeTruthy());

    fireEvent.change(screen.getByTestId('clip-name'), { target: { value: 'Basement Edit' } });
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

  it('plays the rendered edit and tracks the playhead', async () => {
    const clip = clipMock();
    await openTrack(clip);
    const play = screen.getByTestId('clip-play');
    fireEvent.click(play);
    await waitFor(() => expect(play.textContent).toBe('❚❚'));
    // The whole 10 s edit fits in one rendered window from 0.
    expect(clip.previewAudio).toHaveBeenCalledWith(expect.anything(), 0, 10);
    const audio = screen.getByTestId('clip-audio') as HTMLAudioElement;
    expect(audio.src).toContain('blob:clip');

    // The element reports progress; the playhead follows. (The window the
    // <audio> element holds is set by the same async click handler, so
    // give the listener a tick to be wired up.)
    Object.defineProperty(audio, 'currentTime', { configurable: true, value: 3 });
    await waitFor(() => {
      fireEvent(audio, new Event('timeupdate'));
      expect(screen.getByTestId('clip-playhead-readout').textContent).toBe('0:03.00');
    });

    // ...and running out stops at the end of the clip.
    fireEvent(audio, new Event('ended'));
    await waitFor(() => expect(play.textContent).toBe('▶'));
    expect(screen.getByTestId('clip-playhead-readout').textContent).toBe('0:10.00');
  });

  it('space toggles playback and edits stop stale audio', async () => {
    const clip = clipMock();
    await openTrack(clip);
    fireEvent.keyDown(window, { key: ' ' });
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('❚❚'));

    // Cutting re-renders the audio, so the fetched window is stale: stop.
    select(3, 7);
    fireEvent.click(screen.getByTestId('clip-cut'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('▶'));
  });

  it('loops the selection when loop is armed', async () => {
    const clip = clipMock();
    await openTrack(clip);
    select(2, 6);
    fireEvent.click(screen.getByTestId('clip-loop'));
    fireEvent.click(screen.getByTestId('clip-play'));
    await waitFor(() => expect(clip.previewAudio).toHaveBeenCalledWith(expect.anything(), 2, 4));
    const audio = screen.getByTestId('clip-audio') as HTMLAudioElement;
    await waitFor(() => expect(audio.loop).toBe(true));

    // Stop parks the playhead back at the selection start.
    fireEvent.click(screen.getByTestId('clip-stop'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('▶'));
    expect(screen.getByTestId('clip-playhead-readout').textContent).toBe('0:02.00');
  });

  it('hides, pauses playback and detaches shortcuts while inactive', async () => {
    const clip = clipMock();
    const library = libraryMock();
    const { rerender } = render(<ClipView clip={clip} library={library} active />);
    await waitFor(() => expect(screen.getByTestId('clip-track-select')).toBeTruthy());
    fireEvent.click(screen.getByTestId('clip-open-track'));
    await waitFor(() => expect(screen.getByTestId('clip-waveform')).toBeTruthy());
    fireEvent.click(screen.getByTestId('clip-play'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('❚❚'));

    rerender(<ClipView clip={clip} library={library} active={false} />);
    expect((screen.getByTestId('clip-view') as HTMLElement).style.display).toBe('none');
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('▶'));

    // Space is another page's key now.
    fireEvent.keyDown(window, { key: ' ' });
    expect(clip.previewAudio).toHaveBeenCalledTimes(1);

    // Coming back, the edit is still there.
    rerender(<ClipView clip={clip} library={library} active />);
    expect((screen.getByTestId('clip-view') as HTMLElement).style.display).not.toBe('none');
    expect(screen.getAllByTestId('clip-region')).toHaveLength(1);
  });
});
