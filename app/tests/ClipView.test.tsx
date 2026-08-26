// Clip page: load a library track, edit it (select, drag, cut, reverse,
// overlay, EQ, automation), play the result and save it as a NEW library
// track. The backend is mocked; the edit math itself is pinned by
// ClipEdits.test.ts and the rendered audio by dj-analysis's golden test.

import { createRef, StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipView, type ClipViewHandle } from '../src/components/ClipView';
import type { ClipClientApi, ClipRequest, ClipSource } from '../src/clip';
import { closeAudio } from '../src/clipAudio';
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
  stems: [],
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
    loadSource: vi.fn(async (trackId: number, stems: string[]) => ({
      ...SOURCE,
      track_id: trackId,
      stems,
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
    stemBackend: vi.fn(async () => ({
      backend: 'htdemucs_ft',
      available: true,
      detail: null,
      stems: ['vocals', 'drums', 'bass', 'other'],
    })),
    // Separated already, which is the ordinary case: the shell stems
    // every download in the background long before anyone opens it.
    // Tests about the wait say so themselves.
    stemStatus: vi.fn(async (trackId: number) => ({
      track_id: trackId,
      backend: 'htdemucs_ft',
      state: 'ready' as const,
      stage: null,
      detail: null,
      pending: 0,
    })),
    ...overrides,
  };
}

/** A recorded AudioBufferSourceNode start. */
interface FakeLoop {
  loop: boolean;
  /** Whether it still wraps at the end of its buffer. */
  looping: boolean;
  offset: number;
  stopped: boolean;
  /** Play the pass out, as an un-looped node does. */
  end?: () => void;
}

/** jsdom has no Web Audio. Install just enough of it to observe how the
 *  loop transport drives an AudioBufferSourceNode. */
function installWebAudio(bufferSecs = 4): FakeLoop[] {
  const starts: FakeLoop[] = [];
  class FakeSource {
    buffer: unknown = null;
    loopStart = 0;
    loopEnd = 0;
    onended: (() => void) | null = null;
    rec: FakeLoop = { loop: false, looping: false, offset: 0, stopped: false };
    private wraps = false;
    get loop() {
      return this.wraps;
    }
    set loop(on: boolean) {
      this.wraps = on;
      this.rec.looping = on;
    }
    connect() {}
    disconnect() {}
    start(_when = 0, offset = 0) {
      this.rec.loop = this.wraps;
      this.rec.offset = offset;
      this.rec.end = () => this.onended?.();
      starts.push(this.rec);
    }
    stop() {
      this.rec.stopped = true;
    }
  }
  class FakeContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    async decodeAudioData() {
      return { duration: bufferSecs } as AudioBuffer;
    }
    createBufferSource() {
      return new FakeSource() as unknown as AudioBufferSourceNode;
    }
    async resume() {}
    async close() {}
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
  return starts;
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
    // clipAudio caches one AudioContext for the page; drop it (and any
    // stub from a previous test) so each test starts from bare jsdom.
    closeAudio();
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
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
    const trackOptions = screen.getByTestId('clip-track-select').querySelectorAll('option');
    expect([...trackOptions].map((o) => o.textContent)).toEqual([
      'Basement Loop — Me',
      'Hat Loop — Me',
    ]);
  });

  it('opens a library track as a single full-length region', async () => {
    const clip = clipMock();
    await openTrack(clip);
    expect(clip.loadSource).toHaveBeenCalledWith(7, [], expect.any(Number));
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

  it('drags the selection along the timeline without touching the audio', async () => {
    await openTrack(clipMock());
    select(2, 4);
    // Grab the middle of the selection and slide it 3 s to the right.
    const wave = sizeTimeline('clip-waveform');
    fireEvent.mouseDown(wave, { clientX: 300 });
    fireEvent.mouseMove(window, { clientX: 600 });
    fireEvent.mouseUp(window);

    // Only the selection moved: same one region, same length, nothing to
    // undo. Dragging picks what is selected; it does not re-splice.
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:05.00–0:07.00');
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:10.00 total');
    const rows = screen.getAllByTestId('clip-region');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('0:00.00');
    expect(rows[0].textContent).toContain('0:10.00');
    expect(screen.getByTestId('clip-undo')).toHaveProperty('disabled', true);
  });

  it('alt-drags the selection to re-splice the audio with it', async () => {
    await openTrack(clipMock());
    select(2, 4);
    const wave = sizeTimeline('clip-waveform');
    fireEvent.mouseDown(wave, { clientX: 300, altKey: true });
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

  it('drags either end of the selection to expand or shrink it', async () => {
    await openTrack(clipMock());
    select(2, 4);
    const wave = sizeTimeline('clip-waveform');
    expect(screen.getByTestId('clip-selection-handle-start')).toBeTruthy();

    // Grab the right-hand end and pull it out to 8 s.
    fireEvent.mouseDown(wave, { clientX: 400 });
    fireEvent.mouseMove(window, { clientX: 800 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:02.00–0:08.00');

    // Grab the left-hand end and push it in to 5 s.
    fireEvent.mouseDown(wave, { clientX: 200 });
    fireEvent.mouseMove(window, { clientX: 500 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:05.00–0:08.00');

    // Resizing only re-selects: the program is untouched, so there is
    // nothing to undo from it.
    expect(screen.getAllByTestId('clip-region')).toHaveLength(1);
    expect(screen.getByTestId('clip-undo')).toHaveProperty('disabled', true);
  });

  it('drags an end past its opposite, flipping the selection', async () => {
    await openTrack(clipMock());
    select(4, 6);
    const wave = sizeTimeline('clip-waveform');
    fireEvent.mouseDown(wave, { clientX: 600 });
    fireEvent.mouseMove(window, { clientX: 100 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:01.00–0:04.00');
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

  it('rules the timeline with marks that follow the zoom', async () => {
    await openTrack(clipMock());
    const ruler = screen.getByTestId('clip-ruler');
    const labels = () => [...ruler.querySelectorAll('.clip-tick-label')].map((n) => n.textContent);
    // Ten seconds fit: labels every two seconds, 0:00 at the left edge.
    expect(labels()).toEqual(['0:00', '0:02', '0:04', '0:06', '0:08', '0:10']);
    expect(screen.getByTestId('clip-tick-0.000').getAttribute('style')).toContain('left: 0%');
    expect(screen.getByTestId('clip-tick-4.000').getAttribute('style')).toContain('left: 40%');

    // Zoomed to 2–7 s, the marks are the ones in view, repositioned —
    // 5 s now sits 60% across, not 50%.
    select(2, 6);
    fireEvent.click(screen.getByTestId('clip-zoom-in'));
    expect(labels()).toEqual(['0:02', '0:03', '0:04', '0:05', '0:06', '0:07']);
    expect(screen.getByTestId('clip-tick-5.000').getAttribute('style')).toContain('left: 60%');
    expect(screen.queryByTestId('clip-tick-0.000')).toBeNull();
  });

  it('marks the selection ends with hairlines over a grab zone', async () => {
    await openTrack(clipMock());
    select(2, 6);
    const wave = sizeTimeline('clip-waveform');
    for (const edge of ['start', 'end'] as const) {
      const line = screen.getByTestId(`clip-selection-edge-${edge}`);
      // A hairline, not a slab: the same x both sides, and it stays a
      // hairline however far the viewBox is stretched.
      expect(line.getAttribute('x1')).toBe(line.getAttribute('x2'));
      // The zone you can hit is wider than the line you can see.
      const zone = screen.getByTestId(`clip-selection-handle-${edge}`);
      expect(Number(zone.getAttribute('width'))).toBeGreaterThan(2);
    }
    // The grab zone takes pointer events (so the cursor can change) but
    // still lets the waveform hit-test the drag.
    fireEvent.mouseDown(screen.getByTestId('clip-selection-handle-end'), { clientX: 600 });
    fireEvent.mouseMove(window, { clientX: 800 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:02.00–0:08.00');
    expect(wave).toBeTruthy();
  });

  it('opens the track the Library page asks for', async () => {
    const clip = clipMock();
    const handle = createRef<ClipViewHandle>();
    render(<ClipView ref={handle} clip={clip} library={libraryMock()} />);
    await waitFor(() => expect(screen.getByTestId('clip-track-select')).toBeTruthy());

    act(() => handle.current?.open(OTHER.id));
    await waitFor(() => expect(screen.getByTestId('clip-waveform')).toBeTruthy());
    expect(clip.loadSource).toHaveBeenCalledWith(OTHER.id, [], expect.any(Number));
    expect((screen.getByTestId('clip-name') as HTMLInputElement).value).toContain(OTHER.title);
    // The picker follows, so the page does not claim to be editing
    // something else.
    expect((screen.getByTestId('clip-track-select') as HTMLSelectElement).value).toBe(
      String(OTHER.id),
    );
  });

  it('asks before an open from the library throws away an edit', async () => {
    const clip = clipMock();
    const handle = createRef<ClipViewHandle>();
    render(<ClipView ref={handle} clip={clip} library={libraryMock()} />);
    await waitFor(() => expect(screen.getByTestId('clip-track-select')).toBeTruthy());
    act(() => handle.current?.open(SOURCE.track_id));
    await waitFor(() => expect(screen.getByTestId('clip-waveform')).toBeTruthy());

    // An untouched clip is not worth a question.
    act(() => handle.current?.open(OTHER.id));
    expect(screen.queryByTestId('clip-discard-dialog')).toBeNull();
    await waitFor(() =>
      expect((screen.getByTestId('clip-name') as HTMLInputElement).value).toContain(OTHER.title),
    );

    // An edited one is.
    select(2, 6);
    fireEvent.click(screen.getByTestId('clip-cut'));
    await waitFor(() => expect(screen.getAllByTestId('clip-region')).toHaveLength(2));
    act(() => handle.current?.open(OTHER.id));
    await waitFor(() => expect(screen.getByTestId('clip-discard-dialog')).toBeTruthy());
    expect(screen.getAllByTestId('clip-region')).toHaveLength(2);

    // Keeping the edit leaves the timeline exactly as it was...
    fireEvent.click(screen.getByTestId('clip-discard-cancel'));
    await waitFor(() => expect(screen.queryByTestId('clip-discard-dialog')).toBeNull());
    expect(screen.getAllByTestId('clip-region')).toHaveLength(2);

    // ...and discarding starts that same track over, which is what Edit
    // means the second time round.
    act(() => handle.current?.open(OTHER.id));
    await waitFor(() => expect(screen.getByTestId('clip-discard-dialog')).toBeTruthy());
    fireEvent.click(screen.getByTestId('clip-discard-confirm'));
    await waitFor(() => expect(screen.getAllByTestId('clip-region')).toHaveLength(1));
  });

  it('splices a second library track onto the end', async () => {
    const clip = clipMock();
    await openTrack(clip);
    fireEvent.change(screen.getByTestId('clip-track-select'), { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('clip-append-track'));
    await waitFor(() => expect(screen.getAllByTestId('clip-region')).toHaveLength(2));
    expect(clip.loadSource).toHaveBeenLastCalledWith(8, [], expect.any(Number));
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

  it('sets Q from the per-band knob', async () => {
    const clip = clipMock();
    await openTrack(clip);
    expect(screen.getByTestId('clip-eq-readout').textContent).toContain('Q1.0');

    // Drag the band-1 knob up: narrower band, higher Q.
    const knob = screen.getByTestId('clip-eq-q-1').querySelector('svg') as SVGElement;
    fireEvent.mouseDown(knob, { clientY: 100, button: 0 });
    fireEvent.mouseMove(window, { clientY: 40 });
    fireEvent.mouseUp(window);

    const q = await waitFor(() => {
      const calls = (clip.renderPreview as ReturnType<typeof vi.fn>).mock.calls;
      const value = calls[calls.length - 1][0].program.eq.bands[0].q;
      expect(value).toBeGreaterThan(1);
      return value as number;
    });
    expect(screen.getByTestId('clip-eq-readout').textContent).toContain(`Q${q.toFixed(1)}`);
    expect(knob.getAttribute('aria-valuenow')).toBe(String(q));

    // One gesture, one undo step.
    fireEvent.click(screen.getByTestId('clip-undo'));
    expect(screen.getByTestId('clip-eq-readout').textContent).toContain('Q1.0');
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
    expect(request.sources).toEqual([{ track_id: 7, stems: [] }]);
    expect(request.program.regions).toHaveLength(1);
    expect(title).toBe('Basement Edit');
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ title: 'Basement Edit' }));
  });

  it('seeks on a click but never on a sweep', async () => {
    const clip = clipMock();
    await openTrack(clip);
    const readout = () => screen.getByTestId('clip-playhead-readout').textContent;
    const wave = sizeTimeline('clip-waveform');

    // A click is a seek…
    fireEvent.mouseDown(wave, { clientX: 300 });
    fireEvent.mouseUp(window);
    expect(readout()).toBe('0:03.00');

    // …but choosing what to loop is not: a sweep leaves the playhead
    // exactly where it was, so playback under it is undisturbed.
    fireEvent.mouseDown(wave, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 800 });
    fireEvent.mouseUp(window);
    expect(readout()).toBe('0:03.00');
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:05.00–0:08.00');
  });

  it('keeps the selection when you click to seek', async () => {
    const clip = clipMock();
    await openTrack(clip);
    const wave = sizeTimeline('clip-waveform');
    fireEvent.mouseDown(wave, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 800 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:05.00\u20130:08.00');

    // Moving the playhead is not choosing new material: a click seeks and
    // leaves the selection — and therefore the loop — exactly as it was.
    fireEvent.mouseDown(wave, { clientX: 200 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId('clip-playhead-readout').textContent).toBe('0:02.00');
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:05.00\u20130:08.00');
    expect(screen.getByTestId('clip-selection')).toBeTruthy();

    // Escape is the way to be rid of it.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('clip-readout').textContent).toContain('no selection');
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

  it('loops the whole clip when nothing is selected', async () => {
    const starts = installWebAudio(10);
    const clip = clipMock();
    await openTrack(clip);
    // No selection: Loop used to light up and change nothing at all.
    fireEvent.click(screen.getByTestId('clip-loop'));
    fireEvent.click(screen.getByTestId('clip-play'));
    await waitFor(() => expect(clip.previewAudio).toHaveBeenCalledWith(expect.anything(), 0, 10));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0].loop).toBe(true);

    // Selecting something afterwards does not interrupt the pass that is
    // sounding — it only stops it wrapping at an end that is no longer
    // the loop's…
    const before = (clip.previewAudio as ReturnType<typeof vi.fn>).mock.calls.length;
    select(2, 6);
    await waitFor(() => expect(starts[0].looping).toBe(false));
    expect((clip.previewAudio as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(before);

    // …and the selection is what loops from the moment it runs out.
    await act(async () => starts[0].end?.());
    await waitFor(() => expect(clip.previewAudio).toHaveBeenCalledWith(expect.anything(), 2, 4));
  });

  it('loops through Web Audio so the wrap is gapless', async () => {
    const starts = installWebAudio(4);
    const clip = clipMock();
    await openTrack(clip);
    select(2, 6);
    fireEvent.click(screen.getByTestId('clip-loop'));
    fireEvent.click(screen.getByTestId('clip-play'));

    // The selection loops on a buffer source (which wraps at a sample
    // boundary) — NOT on the media element, whose loop re-seeks and drops
    // ~100 ms every pass.
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0].loop).toBe(true);
    expect(starts[0].offset).toBe(0);
    const audio = screen.getByTestId('clip-audio') as HTMLAudioElement;
    expect(audio.loop).toBe(false);

    fireEvent.click(screen.getByTestId('clip-stop'));
    await waitFor(() => expect(starts[0].stopped).toBe(true));
  });

  it('falls back to the media element where Web Audio is missing', async () => {
    const clip = clipMock();
    await openTrack(clip);
    select(2, 6);
    fireEvent.click(screen.getByTestId('clip-loop'));
    fireEvent.click(screen.getByTestId('clip-play'));
    const audio = screen.getByTestId('clip-audio') as HTMLAudioElement;
    await waitFor(() => expect(audio.loop).toBe(true));
  });

  it('takes new loop edges at the end of the pass, not under it', async () => {
    const clip = clipMock();
    await openTrack(clip);
    select(2, 6);
    fireEvent.click(screen.getByTestId('clip-loop'));
    fireEvent.click(screen.getByTestId('clip-play'));
    await waitFor(() => expect(clip.previewAudio).toHaveBeenCalledWith(expect.anything(), 2, 4));
    const audio = screen.getByTestId('clip-audio') as HTMLAudioElement;
    await waitFor(() => expect(audio.loop).toBe(true));
    const before = (clip.previewAudio as ReturnType<typeof vi.fn>).mock.calls.length;

    // Dragging the loop's right edge while it plays leaves playback
    // alone: it used to re-fetch on every mousemove, which is a stutter
    // per pixel dragged.
    const wave = sizeTimeline('clip-waveform');
    fireEvent.mouseDown(wave, { clientX: 600 });
    fireEvent.mouseMove(window, { clientX: 900 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(audio.loop).toBe(false));
    expect((clip.previewAudio as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(before);
    expect(screen.getByTestId('clip-play').textContent).toBe('❚❚');

    // The new edges take over when the pass runs out: the widened range
    // is loaded whole (it still fits one window) and re-entered where
    // playback had got to, so the wrap lands on the edge just dragged.
    fireEvent(audio, new Event('ended'));
    await waitFor(() => expect(clip.previewAudio).toHaveBeenCalledWith(expect.anything(), 2, 7));
    await waitFor(() => expect(audio.loop).toBe(true));
    expect(screen.getByTestId('clip-play').textContent).toBe('❚❚');

    // Turning it off is what carries on linearly.
    fireEvent.click(screen.getByTestId('clip-loop'));
    await waitFor(() => expect(audio.loop).toBe(false));
    expect(screen.getByTestId('clip-play').textContent).toBe('❚❚');
  });

  it('keeps playing through an EQ change, re-rendering the window', async () => {
    const clip = clipMock();
    await openTrack(clip);
    fireEvent.click(screen.getByTestId('clip-play'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('❚❚'));
    const before = (clip.previewAudio as ReturnType<typeof vi.fn>).mock.calls.length;

    fireEvent.mouseDown(screen.getByTestId('clip-eq-handle-1'), {
      clientX: 50,
      clientY: 80,
      button: 0,
    });
    fireEvent.mouseMove(window, { clientX: 50, clientY: 39 });
    fireEvent.mouseUp(window);

    // The audio is re-fetched with the new EQ and playback never stops.
    await waitFor(
      () =>
        expect((clip.previewAudio as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
          before,
        ),
      { timeout: 2000 },
    );
    expect(screen.getByTestId('clip-play').textContent).toBe('❚❚');
    const last = (clip.previewAudio as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(last?.[0].program.eq.bands[0].gain_db).toBeCloseTo(9.9, 5);
  });

  // The reported bug: "at one point the track started playing back twice
  // and I lost control over one of them". Every one of these is a way the
  // page used to end up with two sources, or one nobody could stop.
  // ClipTransport.test.ts pins the same invariants on the owner itself.
  describe('one source, always', () => {
    const liveLoops = (starts: FakeLoop[]) => starts.filter((s) => !s.stopped);

    it('starts one source however hard play is hammered', async () => {
      const starts = installWebAudio(4);
      const clip = clipMock();
      await openTrack(clip);
      select(2, 6);
      fireEvent.click(screen.getByTestId('clip-loop'));

      const play = screen.getByTestId('clip-play');
      for (let i = 0; i < 8; i++) fireEvent.click(play);
      await waitFor(() => expect(starts.length).toBeGreaterThan(0));
      await waitFor(() => expect(liveLoops(starts)).toHaveLength(1));

      // ...and the one that is live is the one the transport can stop.
      fireEvent.click(screen.getByTestId('clip-stop'));
      await waitFor(() => expect(liveLoops(starts)).toHaveLength(0));
    });

    it('keeps one source while the selection is dragged during playback', async () => {
      const starts = installWebAudio(4);
      const clip = clipMock();
      await openTrack(clip);
      select(2, 6);
      fireEvent.click(screen.getByTestId('clip-loop'));
      fireEvent.click(screen.getByTestId('clip-play'));
      await waitFor(() => expect(liveLoops(starts)).toHaveLength(1));

      // Re-sweep the loop over and over: each gesture supersedes a render
      // and a decode that are still in flight.
      const wave = sizeTimeline('clip-waveform');
      for (const x of [650, 700, 750, 800, 850]) {
        fireEvent.mouseDown(wave, { clientX: 100 });
        fireEvent.mouseMove(window, { clientX: x });
        fireEvent.mouseUp(window);
      }
      await waitFor(() => expect(liveLoops(starts)).toHaveLength(1));
      expect(screen.getByTestId('clip-play').textContent).toBe('❚❚');
    });

    it('stops the loop when the page unmounts', async () => {
      const starts = installWebAudio(4);
      const clip = clipMock();
      const library = libraryMock();
      const view = render(<ClipView clip={clip} library={library} />);
      await waitFor(() => expect(screen.getByTestId('clip-track-select')).toBeTruthy());
      fireEvent.click(screen.getByTestId('clip-open-track'));
      await waitFor(() => expect(screen.getByTestId('clip-waveform')).toBeTruthy());
      select(2, 6);
      fireEvent.click(screen.getByTestId('clip-loop'));
      fireEvent.click(screen.getByTestId('clip-play'));
      await waitFor(() => expect(liveLoops(starts)).toHaveLength(1));

      view.unmount();
      expect(liveLoops(starts)).toHaveLength(0);
    });

    it('survives StrictMode double-mounting with one live source', async () => {
      const starts = installWebAudio(4);
      const clip = clipMock();
      render(
        <StrictMode>
          <ClipView clip={clip} library={libraryMock()} />
        </StrictMode>,
      );
      await waitFor(() => expect(screen.getByTestId('clip-track-select')).toBeTruthy());
      fireEvent.click(screen.getByTestId('clip-open-track'));
      await waitFor(() => expect(screen.getByTestId('clip-waveform')).toBeTruthy());
      select(2, 6);
      fireEvent.click(screen.getByTestId('clip-loop'));
      fireEvent.click(screen.getByTestId('clip-play'));

      await waitFor(() => expect(liveLoops(starts)).toHaveLength(1));
      fireEvent.click(screen.getByTestId('clip-stop'));
      await waitFor(() => expect(liveLoops(starts)).toHaveLength(0));
    });

    it('stops playing the old track when another one is opened', async () => {
      const starts = installWebAudio(4);
      const clip = clipMock();
      await openTrack(clip);
      select(2, 6);
      fireEvent.click(screen.getByTestId('clip-loop'));
      fireEvent.click(screen.getByTestId('clip-play'));
      await waitFor(() => expect(liveLoops(starts)).toHaveLength(1));

      fireEvent.change(screen.getByTestId('clip-track-select'), { target: { value: '8' } });
      fireEvent.click(screen.getByTestId('clip-open-track'));

      await waitFor(() => expect(liveLoops(starts)).toHaveLength(0));
      expect(screen.getByTestId('clip-play').textContent).toBe('▶');
      expect(screen.getByTestId('clip-playhead-readout').textContent).toBe('0:00.00');
    });

    it('moves the playhead on a click, even mid-playback', async () => {
      const clip = clipMock();
      await openTrack(clip);
      fireEvent.click(screen.getByTestId('clip-play'));
      await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('❚❚'));

      const wave = sizeTimeline('clip-waveform');
      fireEvent.mouseDown(wave, { clientX: 400 });
      fireEvent.mouseUp(window);

      // Playback re-fetches from the click instead of carrying on from the
      // window it happened to be holding.
      await waitFor(() => expect(clip.previewAudio).toHaveBeenCalledWith(expect.anything(), 4, 6));
      expect(screen.getByTestId('clip-playhead-readout').textContent).toBe('0:04.00');
    });
  });

  it('waits for the automatic separation instead of offering to start one', async () => {
    // The background service is mid-way through this track when the page
    // opens, and finishes while it is being watched.
    let ready = false;
    const clip = clipMock({
      stemStatus: vi.fn(async (trackId: number) => ({
        track_id: trackId,
        backend: 'htdemucs_ft',
        state: ready ? ('ready' as const) : ('loading' as const),
        stage: ready ? null : 'separating',
        detail: null,
        pending: ready ? 0 : 3,
      })),
    });
    render(<ClipView clip={clip} library={libraryMock()} stemPollMs={300} />);
    await waitFor(() => expect(screen.getByTestId('clip-track-select')).toBeTruthy());
    fireEvent.change(screen.getByTestId('clip-track-select'), { target: { value: '7' } });

    // While it runs the mixer is locked and the page says why — there is
    // nothing to press, because nobody starts a separation by hand.
    await waitFor(() =>
      expect(screen.getByTestId('clip-stem-loading').textContent).toMatch(/stems are loading/i),
    );
    expect(screen.getByTestId('clip-stem-loading').textContent).toContain('separating');
    expect(screen.getByTestId('clip-stem-loading').textContent).toContain('3 tracks queued');
    expect(screen.getByTestId('clip-stem-vocals')).toHaveProperty('disabled', true);
    expect(screen.queryByTestId('clip-stem-separate')).toBeNull();
    expect(screen.queryByTestId('clip-stem-cancel')).toBeNull();
    // Asking is what puts this track at the front of the queue.
    expect(clip.stemStatus).toHaveBeenCalledWith(7);

    // The service finishes and the stems unlock on their own — the page
    // notices on its next poll, with nobody clicking anything.
    ready = true;
    await waitFor(() =>
      expect(screen.getByTestId('clip-stem-ready').textContent).toContain('htdemucs_ft'),
    );
    expect(screen.queryByTestId('clip-stem-loading')).toBeNull();
  });

  it('edits one stem in isolation once they are separated', async () => {
    const clip = clipMock();
    render(<ClipView clip={clip} library={libraryMock()} />);
    await waitFor(() => expect(screen.getByTestId('clip-track-select')).toBeTruthy());
    fireEvent.change(screen.getByTestId('clip-track-select'), { target: { value: '7' } });
    await waitFor(() => expect(screen.getByTestId('clip-stem-ready')).toBeTruthy());

    // Every stem starts switched on — the whole track, which needs no
    // stem files at all.
    fireEvent.click(screen.getByTestId('clip-open-track'));
    await waitFor(() => expect(clip.loadSource).toHaveBeenCalledWith(7, [], expect.any(Number)));
    for (const name of ['vocals', 'drums', 'bass', 'other']) {
      expect(screen.getByTestId(`clip-stem-${name}`).getAttribute('aria-pressed')).toBe('true');
    }

    // Switching one off takes effect on the spot: no second Open.
    fireEvent.click(screen.getByTestId('clip-stem-vocals'));
    await waitFor(() =>
      expect(clip.loadSource).toHaveBeenCalledWith(
        7,
        ['drums', 'bass', 'other'],
        expect.any(Number),
      ),
    );
    expect(screen.getByTestId('clip-stem-vocals').getAttribute('aria-pressed')).toBe('false');
    await waitFor(() =>
      expect(screen.getByTestId('clip-sources').textContent).toContain('Basement Loop — no vocals'),
    );

    // What plays and what saves is the chosen mix, never the full track.
    await waitFor(() => {
      const calls = (clip.renderPreview as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[calls.length - 1][0].sources).toEqual([
        { track_id: 7, stems: ['drums', 'bass', 'other'] },
      ]);
    });

    // Down to one stem, then back to the whole track. Each flip settles
    // before the next: the switches are disabled while the swap loads.
    const flip = async (name: string) => {
      await waitFor(() =>
        expect(screen.getByTestId(`clip-stem-${name}`)).toHaveProperty('disabled', false),
      );
      // The swap loads in the background, so let it settle before the
      // next flip rather than piling clicks onto a disabled switch.
      await act(async () => {
        fireEvent.click(screen.getByTestId(`clip-stem-${name}`));
      });
    };
    await flip('bass');
    await flip('other');
    await waitFor(() =>
      expect(clip.loadSource).toHaveBeenCalledWith(7, ['drums'], expect.any(Number)),
    );
    expect(screen.getByTestId('clip-sources').textContent).toContain('Basement Loop — drums');

    await flip('vocals');
    await flip('bass');
    await flip('other');
    await waitFor(() =>
      expect(screen.getByTestId('clip-sources').textContent).toBe('1. Basement Loop'),
    );
    const full = (clip.loadSource as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(full?.[1]).toEqual([]);
  });

  it('stops polling once the stems are there', async () => {
    const clip = clipMock({
      stemStatus: vi.fn(async (trackId: number) => ({
        track_id: trackId,
        backend: 'htdemucs_ft',
        state: 'ready' as const,
        stage: null,
        detail: null,
        pending: 0,
      })),
    });
    render(<ClipView clip={clip} library={libraryMock()} />);
    await waitFor(() => expect(screen.getByTestId('clip-stem-ready')).toBeTruthy());
    const asked = (clip.stemStatus as ReturnType<typeof vi.fn>).mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect((clip.stemStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBe(asked);
  });

  it('keeps the edit when the stems behind it change', async () => {
    const clip = clipMock({
      stemStatus: vi.fn(async (trackId: number) => ({
        track_id: trackId,
        backend: 'htdemucs_ft',
        state: 'ready' as const,
        stage: null,
        detail: null,
        pending: 0,
      })),
    });
    await openTrack(clip);

    // Cut a chunk out, then drop a stem: the cut stays cut. Stems are the
    // same length as their track, so the edit is still meaningful.
    select(3, 7);
    fireEvent.click(screen.getByTestId('clip-cut'));
    expect(screen.getAllByTestId('clip-region')).toHaveLength(2);

    await waitFor(() =>
      expect(screen.getByTestId('clip-stem-bass')).toHaveProperty('disabled', false),
    );
    fireEvent.click(screen.getByTestId('clip-stem-bass'));
    await waitFor(() =>
      expect(clip.loadSource).toHaveBeenCalledWith(
        7,
        ['vocals', 'drums', 'other'],
        expect.any(Number),
      ),
    );
    expect(screen.getAllByTestId('clip-region')).toHaveLength(2);
    // One lane still, swapped in place rather than added alongside.
    expect(screen.getByTestId('clip-sources').textContent).toBe('1. Basement Loop — no bass');
  });

  it('refuses to mute every stem, since that is just silence', async () => {
    const clip = clipMock({
      stemStatus: vi.fn(async (trackId: number) => ({
        track_id: trackId,
        backend: 'htdemucs_ft',
        state: 'ready' as const,
        stage: null,
        detail: null,
        pending: 0,
      })),
    });
    render(<ClipView clip={clip} library={libraryMock()} />);
    await waitFor(() => expect(screen.getByTestId('clip-track-select')).toBeTruthy());
    fireEvent.change(screen.getByTestId('clip-track-select'), { target: { value: '7' } });
    await waitFor(() =>
      expect(screen.getByTestId('clip-stem-vocals')).toHaveProperty('disabled', false),
    );
    for (const name of ['vocals', 'drums', 'bass']) {
      await waitFor(() =>
        expect(screen.getByTestId(`clip-stem-${name}`)).toHaveProperty('disabled', false),
      );
      fireEvent.click(screen.getByTestId(`clip-stem-${name}`));
    }
    await waitFor(() =>
      expect(screen.getByTestId('clip-stem-other').getAttribute('aria-pressed')).toBe('true'),
    );
    fireEvent.click(screen.getByTestId('clip-stem-other'));
    await waitFor(() =>
      expect(screen.getByTestId('clip-error').textContent).toMatch(/at least one/i),
    );
    expect(screen.getByTestId('clip-stem-other').getAttribute('aria-pressed')).toBe('true');
  });

  it('leaves the stem switches alone until the separation lands', async () => {
    const clip = clipMock({
      stemStatus: vi.fn(async (trackId: number) => ({
        track_id: trackId,
        backend: 'htdemucs_ft',
        state: 'loading' as const,
        stage: 'separating',
        detail: null,
        pending: 1,
      })),
    });
    render(<ClipView clip={clip} library={libraryMock()} />);
    await waitFor(() => expect(screen.getByTestId('clip-stem-vocals')).toBeTruthy());
    expect(screen.getByTestId('clip-stem-vocals')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('clip-stem-vocals').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('clip-stem-vocals').getAttribute('title')).toMatch(/loading/i);
  });

  it('explains itself when the separation tooling is missing', async () => {
    const detail = 'demucs was not found on PATH — pip install demucs';
    const clip = clipMock({
      stemBackend: vi.fn(async () => ({
        backend: 'htdemucs_ft',
        available: false,
        detail,
        stems: ['vocals', 'drums', 'bass', 'other'],
      })),
      stemStatus: vi.fn(async (trackId: number) => ({
        track_id: trackId,
        backend: 'htdemucs_ft',
        state: 'unavailable' as const,
        stage: null,
        detail,
        pending: 0,
      })),
    });
    render(<ClipView clip={clip} library={libraryMock()} />);
    await waitFor(() =>
      expect(screen.getByTestId('clip-stem-hint').textContent).toContain('pip install demucs'),
    );
    // Nothing claims stems are on their way, and there is nothing to press.
    expect(screen.queryByTestId('clip-stem-loading')).toBeNull();
    expect(screen.queryByTestId('clip-stem-separate')).toBeNull();
    expect(screen.getByTestId('clip-stem-vocals')).toHaveProperty('disabled', true);
  });

  it('says when a track has been given up on rather than waiting forever', async () => {
    const clip = clipMock({
      stemStatus: vi.fn(async (trackId: number) => ({
        track_id: trackId,
        backend: 'htdemucs_ft',
        state: 'failed' as const,
        stage: null,
        detail: 'demucs failed (exit status: 1): torch.cuda.OutOfMemoryError',
        pending: 0,
      })),
    });
    render(<ClipView clip={clip} library={libraryMock()} />);
    await waitFor(() =>
      expect(screen.getByTestId('clip-stem-hint').textContent).toContain('OutOfMemoryError'),
    );
    expect(screen.queryByTestId('clip-stem-loading')).toBeNull();
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
    // Coming back also re-reads the library and the stem report; let both
    // land before the test walks away from the component.
    await waitFor(() => expect(screen.getByTestId('clip-stem-ready')).toBeTruthy());
    expect(screen.getAllByTestId('clip-region')).toHaveLength(1);
  });
});
