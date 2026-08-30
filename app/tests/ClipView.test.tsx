// Clip page: load a library track, edit it (select, drag, cut, reverse,
// overlay, EQ, automation), tap out a beat grid, play the result and save
// a span of it as a BEAT CLIP the decks can load. The backend is mocked;
// the edit math itself is pinned by ClipEdits.test.ts and the rendered
// audio by dj-analysis's golden test.

import { createRef, StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipView, type ClipViewHandle } from '../src/components/ClipView';
import type { ClipClientApi, ClipProgram, ClipRequest, ClipSource } from '../src/clip';
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

/** What `clip_tap_beats` answers for a measured span: two hearings of the
 *  same three taps, the one they fit best (final0) first. */
const HEARD = {
  times: [1.0, 1.5, 2.0, 2.5, 3.0],
  bpm: 120,
  seed: 'final0',
  tracker: 'beat_this/final0',
  detail: 'beat_this/final0 heard 5 beats at 120.0 BPM over the tapped span (seed final0 of 2)',
  seeds: [
    { seed: 'final0', bpm: 120, times: [1.0, 1.5, 2.0, 2.5, 3.0], fit: 0.912 },
    { seed: 'final1', bpm: 60, times: [1.0, 2.0, 3.0], fit: 0.437 },
  ],
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
    detectBeats: vi.fn(async () => ({ bpm: 120, beats: 20, tracker: 'dsp' })),
    // The tracker refusing is the fallback path: the taps themselves
    // become the grid. Tests about the measured grid override this.
    tapBeats: vi.fn(async () => ({
      times: [],
      bpm: 0,
      seed: '',
      tracker: '',
      detail: '',
      seeds: [],
    })),
    saveBeatClip: vi.fn(
      async (
        _r: ClipRequest,
        title: string,
        sourceTitle: string,
        _startSecs: number,
        _endSecs: number,
        bpm: number,
        beats: number,
      ) => ({
        id: 'b1',
        name: title,
        sourceTitle,
        bpm,
        beats,
        file: 'b1.flac',
        stems: [],
      }),
    ),
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

/** A recorded AudioParam: the live tone chain moves these instead of
 *  re-rendering, so what they hold IS the audible EQ. */
class FakeParam {
  value = 0;
  setValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number) {
    this.value = v;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class FakeFilter {
  type = '';
  frequency = new FakeParam();
  Q = new FakeParam();
  gain = new FakeParam();
  connect() {}
  disconnect() {}
}

class FakeGain {
  gain = new FakeParam();
  connect() {}
  disconnect() {}
}

interface FakeAudio {
  /** Every buffer source that was started. */
  starts: FakeLoop[];
  /** The live tone chain's peaking bells, in order. */
  filters: FakeFilter[];
  /** Every gain node built (the level gain is the first). */
  gains: FakeGain[];
}

/** jsdom has no Web Audio. Install just enough of it to observe how the
 *  loop transport drives an AudioBufferSourceNode, and what the live
 *  selection player's tone chain is set to. */
function installWebAudio(bufferSecs = 4): FakeAudio {
  const starts: FakeLoop[] = [];
  const filters: FakeFilter[] = [];
  const gains: FakeGain[] = [];
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
    sampleRate = 48000;
    async decodeAudioData() {
      return { duration: bufferSecs, sampleRate: 48000 } as AudioBuffer;
    }
    createBufferSource() {
      return new FakeSource() as unknown as AudioBufferSourceNode;
    }
    createBiquadFilter() {
      const filter = new FakeFilter();
      filters.push(filter);
      return filter as unknown as BiquadFilterNode;
    }
    createGain() {
      const gain = new FakeGain();
      gains.push(gain);
      return gain as unknown as GainNode;
    }
    async resume() {}
    async close() {}
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
  return { starts, filters, gains };
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
function select(fromSecs: number, toSecs: number, keys: { metaKey?: boolean } = {}) {
  const wave = sizeTimeline('clip-waveform');
  fireEvent.mouseDown(wave, { clientX: fromSecs * 100, ...keys });
  fireEvent.mouseMove(window, { clientX: toSecs * 100, ...keys });
  fireEvent.mouseUp(window, { ...keys });
}

/** The splice joins drawn on the waveform: one line per region. */
function joins() {
  return screen.queryAllByTestId(/^clip-join-/);
}

/** The program of the NEXT preview render satisfying `test` — how a test
 *  reads the edit now that the page shows no region table. */
async function programNow(
  clip: ClipClientApi,
  test: (p: ClipProgram) => boolean = () => true,
): Promise<ClipProgram> {
  const fn = clip.renderPreview as ReturnType<typeof vi.fn>;
  await waitFor(
    () => {
      const calls = fn.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect(test(calls[calls.length - 1][0].program)).toBe(true);
    },
    { timeout: 3000 },
  );
  const calls = fn.mock.calls;
  return calls[calls.length - 1][0].program;
}

/** The full program a SAVE would file. The preview render is the DRY
 *  edit now — tone is applied live in the webview — so this is where a
 *  test reads EQ and level automation back out of the page. */
async function savedProgram(clip: ClipClientApi): Promise<ClipProgram> {
  fireEvent.change(screen.getByTestId('clip-name'), { target: { value: 'Edit' } });
  const save = screen.getByTestId('clip-save') as HTMLButtonElement;
  await waitFor(() => expect(save.disabled).toBe(false), { timeout: 3000 });
  fireEvent.click(save);
  await waitFor(() => expect(clip.saveBeatClip).toHaveBeenCalled());
  const calls = (clip.saveBeatClip as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][0].program as ClipProgram;
}

/** Tap right-shift with playback at `secs` (the transport reads the time
 *  LIVE off the media element, not from the last status tick). */
function tapAt(secs: number) {
  const audio = screen.getByTestId('clip-audio') as HTMLAudioElement;
  Object.defineProperty(audio, 'currentTime', { configurable: true, value: secs });
  fireEvent.keyDown(window, { code: 'ShiftRight', key: 'Shift' });
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
    expect(joins()).toHaveLength(1);
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:10.00 total');
    expect((screen.getByTestId('clip-name') as HTMLInputElement).value).toBe(
      'Basement Loop (clip)',
    );
  });

  it('drag-selects a range and cuts it, splicing the remainder', async () => {
    const clip = clipMock();
    await openTrack(clip);
    select(3, 7);
    expect(screen.getByTestId('clip-selection')).toBeTruthy();
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:03.00–0:07.00');

    fireEvent.click(screen.getByTestId('clip-cut'));
    expect(joins()).toHaveLength(2);
    const p = await programNow(clip, (p) => p.regions.length === 2);
    expect(p.regions.map((r) => [r.start_secs, r.end_secs])).toEqual([
      [0, 3],
      [7, 10],
    ]);
  });

  it('trims, reverses and re-trims the level of a selection', async () => {
    const clip = clipMock();
    await openTrack(clip);
    select(2, 6);
    fireEvent.click(screen.getByTestId('clip-trim'));
    expect(joins()).toHaveLength(1);
    await programNow(clip, (p) => p.regions.length === 1 && p.regions[0].start_secs === 2);

    select(0, 2);
    fireEvent.click(screen.getByTestId('clip-reverse'));
    await programNow(clip, (p) => p.regions.some((r) => r.reverse));

    fireEvent.click(screen.getByTestId('clip-quieter'));
    await programNow(clip, (p) => p.regions.some((r) => r.gain_db === -3));
  });

  it('undo and redo respond to buttons and keyboard shortcuts', async () => {
    await openTrack(clipMock());
    expect(screen.getByTestId('clip-undo')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('clip-redo')).toHaveProperty('disabled', true);

    select(3, 7);
    fireEvent.click(screen.getByTestId('clip-cut'));
    expect(joins()).toHaveLength(2);

    fireEvent.click(screen.getByTestId('clip-undo'));
    expect(joins()).toHaveLength(1);
    fireEvent.click(screen.getByTestId('clip-redo'));
    expect(joins()).toHaveLength(2);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(joins()).toHaveLength(1);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(joins()).toHaveLength(2);
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
    expect(joins()).toHaveLength(2);
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
    expect(joins()).toHaveLength(1);
    expect(screen.getByTestId('clip-undo')).toHaveProperty('disabled', true);
  });

  it('alt-drags the selection to re-splice the audio with it', async () => {
    const clip = clipMock();
    await openTrack(clip);
    select(2, 4);
    const wave = sizeTimeline('clip-waveform');
    fireEvent.mouseDown(wave, { clientX: 300, altKey: true });
    fireEvent.mouseMove(window, { clientX: 600 });
    fireEvent.mouseUp(window);

    expect(screen.getByTestId('clip-readout').textContent).toContain('0:05.00–0:07.00');
    // Three new joins each eat one 5 ms crossfade (the splice law).
    expect(screen.getByTestId('clip-readout').textContent).toMatch(/0:09\.9\d total/);
    expect(joins()).toHaveLength(4);
    // The moved material sits third: [0-2][4-7][2-4][7-10].
    const p = await programNow(clip, (p) => p.regions.length === 4);
    expect([p.regions[2].start_secs, p.regions[2].end_secs]).toEqual([2, 4]);

    fireEvent.click(screen.getByTestId('clip-undo'));
    expect(joins()).toHaveLength(1);
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
    expect(joins()).toHaveLength(1);
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
    await waitFor(() => expect(joins()).toHaveLength(2));
    act(() => handle.current?.open(OTHER.id));
    await waitFor(() => expect(screen.getByTestId('clip-discard-dialog')).toBeTruthy());
    expect(joins()).toHaveLength(2);

    // Keeping the edit leaves the timeline exactly as it was...
    fireEvent.click(screen.getByTestId('clip-discard-cancel'));
    await waitFor(() => expect(screen.queryByTestId('clip-discard-dialog')).toBeNull());
    expect(joins()).toHaveLength(2);

    // ...and discarding starts that same track over, which is what Edit
    // means the second time round.
    act(() => handle.current?.open(OTHER.id));
    await waitFor(() => expect(screen.getByTestId('clip-discard-dialog')).toBeTruthy());
    fireEvent.click(screen.getByTestId('clip-discard-confirm'));
    await waitFor(() => expect(joins()).toHaveLength(1));
  });

  it('splices a second library track onto the end', async () => {
    const clip = clipMock();
    await openTrack(clip);
    fireEvent.change(screen.getByTestId('clip-track-select'), { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('clip-append-track'));
    await waitFor(() => expect(joins()).toHaveLength(2));
    expect(clip.loadSource).toHaveBeenLastCalledWith(8, [], expect.any(Number));
    expect(screen.getByTestId('clip-sources').textContent).toContain('2. Hat Loop');
  });

  it('fades and automation points land on the level lane', async () => {
    await openTrack(clipMock());
    // The lane lives under the SELECTION now: it is drawn against the
    // span being auditioned, so there has to be one.
    select(0, 10);
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

  it('overlays a second track at the selection and undo removes it', async () => {
    const clip = clipMock();
    await openTrack(clip);
    select(2, 6);
    fireEvent.change(screen.getByTestId('clip-track-select'), { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('clip-overlay-track'));
    await waitFor(() => expect(screen.getByTestId('clip-overlay-span-0')).toBeTruthy());

    // A 10 s overlay starting at 2 s extends the clip to 12 s.
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:12.00 total');
    const p = await programNow(clip, (p) => p.overlays.length === 1);
    expect(p.overlays[0].at_secs).toBe(2);
    expect(screen.getByTestId('clip-sources').textContent).toContain('2. Hat Loop');

    fireEvent.click(screen.getByTestId('clip-undo'));
    expect(screen.queryByTestId('clip-overlay-span-0')).toBeNull();
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

    const bands = (await savedProgram(clip)).eq.bands;
    expect(bands[0].gain_db).toBeCloseTo(9.9, 5);
    expect(bands[0].freq_hz).toBeCloseTo(99, 5);

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

    const q = (await savedProgram(clip)).eq.bands[0].q;
    expect(q).toBeGreaterThan(1);
    expect(screen.getByTestId('clip-eq-readout').textContent).toContain(`Q${q.toFixed(1)}`);
    expect(knob.getAttribute('aria-valuenow')).toBe(String(q));

    // One gesture, one undo step.
    fireEvent.click(screen.getByTestId('clip-undo'));
    expect(screen.getByTestId('clip-eq-readout').textContent).toContain('Q1.0');
  });

  it('measures an untapped selection and saves it as a beat clip', async () => {
    const clip = clipMock();
    render(<ClipView clip={clip} library={libraryMock()} detectDelayMs={0} />);
    await waitFor(() => expect(screen.getByTestId('clip-track-select')).toBeTruthy());
    fireEvent.click(screen.getByTestId('clip-open-track'));
    await waitFor(() => expect(screen.getByTestId('clip-waveform')).toBeTruthy());

    // No taps yet, so the whole clip is measured (mock: 120 BPM), which
    // is exactly 20 beats of the 10 s edit — nothing to pad.
    await waitFor(() =>
      expect(screen.getByTestId('clip-save-meta').textContent).toBe(
        '120.0 BPM · 20 beats · measured',
      ),
    );
    expect(clip.detectBeats).toHaveBeenCalledWith(expect.anything(), 0, 10);

    // The source-track title is prefilled from the opened track and
    // editable — it files with the clip, the way a Beatify clip carries
    // its project name.
    const sourceInput = screen.getByTestId('clip-source-title') as HTMLInputElement;
    expect(sourceInput.value).toBe('Basement Loop');
    fireEvent.change(sourceInput, { target: { value: 'Basement Loop (VIP)' } });

    fireEvent.change(screen.getByTestId('clip-name'), { target: { value: 'Basement Edit' } });
    fireEvent.click(screen.getByTestId('clip-save'));
    await waitFor(() =>
      expect(screen.getByTestId('clip-status').textContent).toMatch(/20 beats at 120\.0 BPM/),
    );

    const [request, title, sourceTitle, start, end, bpm, beats] = (
      clip.saveBeatClip as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(request.sources).toEqual([{ track_id: 7, stems: [] }]);
    expect(request.program.regions).toHaveLength(1);
    expect(title).toBe('Basement Edit');
    expect(sourceTitle).toBe('Basement Loop (VIP)');
    expect([start, end, bpm, beats]).toEqual([0, 10, 120, 20]);
  });

  it('says when a fractional selection will be padded to whole beats', async () => {
    const clip = clipMock();
    render(<ClipView clip={clip} library={libraryMock()} detectDelayMs={0} />);
    await waitFor(() => expect(screen.getByTestId('clip-track-select')).toBeTruthy());
    fireEvent.click(screen.getByTestId('clip-open-track'));
    await waitFor(() => expect(screen.getByTestId('clip-waveform')).toBeTruthy());

    // 2–5.75 s at the measured 120 BPM is 7.5 beats: the save row rounds
    // up and says the last beat is silence-filled.
    select(2, 5.75);
    await waitFor(() =>
      expect(screen.getByTestId('clip-save-meta').textContent).toBe(
        '120.0 BPM · 8 beats (last beat filled with silence) · measured',
      ),
    );
    await waitFor(() => expect(clip.detectBeats).toHaveBeenCalledWith(expect.anything(), 2, 5.75));

    // The save covers the SELECTION at that tempo and sends the count
    // the row showed; the backend pads to exactly that.
    fireEvent.click(screen.getByTestId('clip-save'));
    await waitFor(() => expect(clip.saveBeatClip).toHaveBeenCalled());
    const call = (clip.saveBeatClip as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call.slice(3)).toEqual([2, 5.75, 120, 8]);
  });

  it('turns right-shift taps during playback into a beat grid over the tapped span', async () => {
    const clip = clipMock();
    await openTrack(clip);
    const play = screen.getByTestId('clip-play');
    fireEvent.click(play);
    await waitFor(() => expect(play.textContent).toBe('❚❚'));

    // Tap four beats, slightly unevenly (2 s covered → 3 gaps).
    tapAt(1.0);
    tapAt(1.6);
    tapAt(2.2);
    tapAt(3.0);
    expect(screen.getAllByTestId('clip-tap-line')).toHaveLength(4);

    // Stopping playback commits them: the tracker is asked about the
    // tapped span first (the mock refuses, so the taps themselves are
    // the grid), covering ONLY that span — four beats, not the whole
    // clip.
    fireEvent.click(screen.getByTestId('clip-stop'));
    await waitFor(() => expect(play.textContent).toBe('▶'));
    expect(screen.queryAllByTestId('clip-tap-line')).toHaveLength(0);
    await waitFor(() => expect(screen.getAllByTestId('clip-beat-line')).toHaveLength(4));
    expect(clip.tapBeats).toHaveBeenCalledWith(expect.anything(), [1.0, 1.6, 2.2, 3.0]);

    // At the default correction length (every 4 beats) this run is one
    // section pinned at its ends — which define the 90 BPM average, so
    // nothing stretches and the inner beats keep their tapped feel.
    expect(screen.getByTestId('clip-save-meta').textContent).toBe('90.0 BPM · 15 beats');
    // The session's controls are LIVE the moment it commits (a disabled
    // slider or +/− pair means the present fell out of the session).
    expect(screen.getByTestId('clip-grid-section')).toHaveProperty('disabled', false);
    expect(screen.getByTestId('clip-grid-fwd-plus')).toHaveProperty('disabled', false);
    expect(screen.getByTestId('clip-grid-section-readout').textContent).toBe('4 beats');
    // The debug line reads max/average throughout. The taps ARE the grid
    // here, so nothing stretches and nothing was missed by definition.
    expect(screen.getByTestId('clip-grid-stats').textContent).toBe(
      'flam 133/50 ms · stretch 0.0/0.0% · tap miss 0/0 ms · 4 beats from 4 taps',
    );
    // Nothing fit the taps, so there is no seed to choose between.
    expect(screen.queryByTestId('clip-grid-seed')).toBeNull();
    const p = await programNow(clip, (p) => p.warp.length === 2);
    expect(p.beat_grid?.bpm).toBeCloseTo(90, 6);
    expect(p.beat_grid?.times).toEqual([1.0, 1.6, 2.2, 3.0]);
    expect(p.warp).toEqual([
      [1, 1],
      [3, 3],
    ]);

    // A selection between the grid's ACTUAL beats counts ITS beats: 1.6
    // to 3.0 s is two of them, even though 1.4 s at 90 BPM is 2.1 ideal
    // periods — the count that used to grow a third beat of silence.
    select(1.6, 3.0);
    expect(screen.getByTestId('clip-save-meta').textContent).toBe('90.0 BPM · 2 beats');

    // Saving needs no measuring pass — the grid's tempo is the clip's —
    // and it sends exactly the count the row showed.
    fireEvent.change(screen.getByTestId('clip-name'), { target: { value: 'Tapped' } });
    fireEvent.click(screen.getByTestId('clip-save'));
    await waitFor(() => expect(clip.saveBeatClip).toHaveBeenCalled());
    const call = (clip.saveBeatClip as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call.slice(3, 5)).toEqual([1.6, 3.0]);
    expect(call[5]).toBeCloseTo(90, 6);
    expect(call[6]).toBe(2);
    expect(clip.detectBeats).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });

    // Sliding the correction down to every beat pins each tap to the
    // ideal grid: no flam left, the stretch made visible per section.
    fireEvent.change(screen.getByTestId('clip-grid-section'), { target: { value: '1' } });
    expect(screen.getByTestId('clip-grid-section-readout').textContent).toBe('every beat');
    expect(screen.getByTestId('clip-grid-stats').textContent).toBe(
      'flam 0/0 ms · stretch 16.7/13.0% · tap miss 0/0 ms · 4 beats from 4 taps',
    );
    expect(screen.getAllByTestId(/^clip-stretch-/)).toHaveLength(3);
    const p1 = await programNow(clip, (p) => p.warp.length === 4);
    expect(p1.warp.map(([, to]) => to.toFixed(4))).toEqual([
      '1.0000',
      '1.6667',
      '2.3333',
      '3.0000',
    ]);

    // The whole session — taps AND the slider move — is one undo step.
    fireEvent.click(screen.getByTestId('clip-undo'));
    expect(screen.queryAllByTestId('clip-beat-line')).toHaveLength(0);
    expect(screen.queryByTestId('clip-grid-tools')).toBeNull();
  });

  it('smooths the correction across each section without moving a beat', async () => {
    const clip = clipMock();
    await openTrack(clip);
    fireEvent.click(screen.getByTestId('clip-play'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('❚❚'));
    tapAt(1.0);
    tapAt(1.6);
    tapAt(2.2);
    tapAt(3.0);
    fireEvent.click(screen.getByTestId('clip-stop'));
    await waitFor(() => expect(screen.getAllByTestId('clip-beat-line')).toHaveLength(4));

    // Correct every beat, so each section really does stretch — the case
    // where the rate steps at a boundary.
    fireEvent.change(screen.getByTestId('clip-grid-section'), { target: { value: '1' } });
    const hard = await programNow(clip, (p) => p.warp.length === 4);

    // The slider starts subtle; sliding it to nothing is the old
    // behaviour, and the anchors never move whatever it says.
    expect(screen.getByTestId('clip-grid-smooth-readout').textContent).toBe('30%');
    fireEvent.change(screen.getByTestId('clip-grid-smooth'), { target: { value: '0' } });
    expect(screen.getByTestId('clip-grid-smooth-readout').textContent).toBe('hard');
    const off = await programNow(clip, (p) => p.warp_smoothing === 0);
    expect(off.warp).toEqual(hard.warp);

    fireEvent.change(screen.getByTestId('clip-grid-smooth'), { target: { value: '0.8' } });
    expect(screen.getByTestId('clip-grid-smooth-readout').textContent).toBe('80%');
    const eased = await programNow(clip, (p) => p.warp_smoothing === 0.8);
    expect(eased.warp).toEqual(hard.warp);
    expect(eased.beat_grid?.times).toEqual(hard.beat_grid?.times);

    // And the whole session — taps, both sliders — is still ONE undo.
    fireEvent.click(screen.getByTestId('clip-undo'));
    expect(screen.queryByTestId('clip-grid-tools')).toBeNull();
  });

  it('builds the grid from the tracker beats the taps chose', async () => {
    // The tapped span is MEASURED: clip_tap_beats runs the tracker over
    // it and the taps pick a seed — the grid is the seed's beat times,
    // not the sloppy taps.
    const clip = clipMock({ tapBeats: vi.fn(async () => HEARD) });
    await openTrack(clip);
    fireEvent.click(screen.getByTestId('clip-play'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('❚❚'));
    tapAt(1.05);
    tapAt(2.1);
    tapAt(2.95);
    fireEvent.click(screen.getByTestId('clip-stop'));

    // Five detected beats, not three tapped ones — measured ONCE, however
    // many status changes stopping makes.
    await waitFor(() => expect(screen.getAllByTestId('clip-beat-line')).toHaveLength(5));
    expect(clip.tapBeats).toHaveBeenCalledWith(expect.anything(), [1.05, 2.1, 2.95]);
    expect((clip.tapBeats as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const p = await programNow(clip, (p) => (p.beat_grid?.times.length ?? 0) === 5);
    expect(p.beat_grid?.times).toEqual([1.0, 1.5, 2.0, 2.5, 3.0]);
    expect(p.beat_grid?.bpm).toBeCloseTo(120, 6);
    expect(screen.getByTestId('clip-save-meta').textContent).toContain('120.0 BPM');
    expect(screen.getByTestId('clip-status').textContent).toContain('heard 5 beats');

    // The debug line now has something to say about the HAND: the taps
    // sat up to 100 ms off the beats the seed heard.
    expect(screen.getByTestId('clip-grid-stats').textContent).toBe(
      'flam 0/0 ms · stretch 0.0/0.0% · tap miss 100/67 ms · 5 beats from 3 taps',
    );

    // Still one undo step: taps, measurement and all.
    fireEvent.click(screen.getByTestId('clip-undo'));
    expect(screen.queryAllByTestId('clip-beat-line')).toHaveLength(0);
  });

  it('autoselects the best seed and re-derives the grid when another is picked', async () => {
    const clip = clipMock({ tapBeats: vi.fn(async () => HEARD) });
    await openTrack(clip);
    fireEvent.click(screen.getByTestId('clip-play'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('❚❚'));
    tapAt(1.05);
    tapAt(2.1);
    tapAt(2.95);
    fireEvent.click(screen.getByTestId('clip-stop'));
    await waitFor(() => expect(screen.getAllByTestId('clip-beat-line')).toHaveLength(5));

    // Every hearing is offered, best fit first, with the chosen one
    // selected — the taps autoselect, they do not decide.
    const picker = screen.getByTestId('clip-grid-seed') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      'final0 · 120.0 BPM · fit 91%',
      'final1 · 60.0 BPM · fit 44%',
    ]);
    expect(picker.value).toBe('final0');

    // Picking the half-time hearing rebuilds the grid from ITS beats,
    // with no second measurement…
    fireEvent.change(picker, { target: { value: 'final1' } });
    await waitFor(() => expect(screen.getAllByTestId('clip-beat-line')).toHaveLength(3));
    expect((clip.tapBeats as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const p = await programNow(clip, (p) => (p.beat_grid?.times.length ?? 0) === 3);
    expect(p.beat_grid?.times).toEqual([1.0, 2.0, 3.0]);
    expect(p.beat_grid?.bpm).toBeCloseTo(60, 6);
    // …and the miss is measured against the beats now chosen.
    expect(screen.getByTestId('clip-grid-stats').textContent).toBe(
      'flam 0/0 ms · stretch 0.0/0.0% · tap miss 100/67 ms · 3 beats from 3 taps',
    );

    // Overruling the choice is still part of the SAME undo step.
    fireEvent.click(screen.getByTestId('clip-undo'));
    expect(screen.queryAllByTestId('clip-beat-line')).toHaveLength(0);
    expect(screen.queryByTestId('clip-grid-tools')).toBeNull();
  });

  it('keeps the grid controls live through a tone edit', async () => {
    // The session belongs to the GRID, not to the program object: an EQ
    // move or a level point keeps the grid, so the slider, the seed
    // picker and the +/− buttons must survive one. (They used to go dead
    // at the first tone edit and only come back after another tapping
    // pass.)
    const clip = clipMock({ tapBeats: vi.fn(async () => HEARD) });
    await openTrack(clip);
    fireEvent.click(screen.getByTestId('clip-play'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('❚❚'));
    tapAt(1.05);
    tapAt(2.1);
    tapAt(2.95);
    fireEvent.click(screen.getByTestId('clip-stop'));
    await waitFor(() => expect(screen.getAllByTestId('clip-beat-line')).toHaveLength(5));

    // The level lane hangs under the SELECTION now, so there has to be
    // one to drop a point on.
    select(0, 10);
    const lane = sizeTimeline('clip-level-lane');
    fireEvent.mouseDown(lane, { clientX: 500, clientY: 30 });
    await waitFor(() => expect(screen.getByTestId('clip-level-point-0')).toBeTruthy());
    expect(screen.getAllByTestId('clip-beat-line')).toHaveLength(5);
    expect(screen.getByTestId('clip-grid-section')).toHaveProperty('disabled', false);
    expect(screen.getByTestId('clip-grid-fwd-plus')).toHaveProperty('disabled', false);

    // And tuning the correction keeps the automation it was made over.
    fireEvent.change(screen.getByTestId('clip-grid-section'), { target: { value: '1' } });
    const p = await programNow(clip, (p) => p.warp.length === 5);
    expect(p.beat_grid?.times).toHaveLength(5);
    expect((await savedProgram(clip)).level).toHaveLength(1);
  });

  it('washes only the current tapping session, not the one before it', async () => {
    // A re-tap composes its warp onto the last one (the audio was already
    // stretched), but the SECTIONS drawn belong to the session in hand:
    // the first grid's washes went with its grid.
    const clip = clipMock({ tapBeats: vi.fn(async () => HEARD) });
    await openTrack(clip);
    fireEvent.click(screen.getByTestId('clip-play'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('❚❚'));
    tapAt(1.05);
    tapAt(2.1);
    tapAt(2.95);
    fireEvent.click(screen.getByTestId('clip-stop'));
    await waitFor(() => expect(screen.getAllByTestId('clip-beat-line')).toHaveLength(5));
    fireEvent.change(screen.getByTestId('clip-grid-section'), { target: { value: '1' } });
    expect(screen.getAllByTestId(/^clip-stretch-/).length).toBe(4);

    // A second pass over a LATER span, which the tracker refuses: the
    // taps themselves are the grid, one section wide.
    (clip.tapBeats as ReturnType<typeof vi.fn>).mockResolvedValue({
      times: [],
      bpm: 0,
      seed: '',
      tracker: '',
      detail: '',
      seeds: [],
    });
    fireEvent.click(screen.getByTestId('clip-play'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('❚❚'));
    tapAt(6.0);
    tapAt(7.0);
    tapAt(8.0);
    fireEvent.click(screen.getByTestId('clip-stop'));
    await waitFor(() => expect(screen.getAllByTestId('clip-beat-line')).toHaveLength(3));
    // The first session's four washes are gone with its grid: what is
    // drawn is the two sections of the pass in hand.
    expect(screen.getAllByTestId(/^clip-stretch-/).length).toBe(2);
  });

  it('extends the grid a beat at a time with the toolbar buttons', async () => {
    const clip = clipMock();
    await openTrack(clip);
    fireEvent.click(screen.getByTestId('clip-play'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('❚❚'));
    // Taps at 1 and 3 s: 30 BPM, two beats, covering 1–3 s only.
    tapAt(1.0);
    tapAt(3.0);
    fireEvent.click(screen.getByTestId('clip-stop'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('▶'));
    await waitFor(() => expect(screen.getAllByTestId('clip-beat-line')).toHaveLength(2));

    // Forward: beats at 5 and 7 s land; a step back would sit before 0,
    // so that button has nowhere to go.
    fireEvent.click(screen.getByTestId('clip-grid-fwd-plus'));
    fireEvent.click(screen.getByTestId('clip-grid-fwd-plus'));
    expect(screen.getAllByTestId('clip-beat-line')).toHaveLength(4);
    expect(screen.getByTestId('clip-grid-back-plus')).toHaveProperty('disabled', true);

    // − retracts what + added…
    fireEvent.click(screen.getByTestId('clip-grid-fwd-minus'));
    expect(screen.getAllByTestId('clip-beat-line')).toHaveLength(3);

    // …and the whole grown grid is still ONE undo step.
    fireEvent.click(screen.getByTestId('clip-undo'));
    expect(screen.queryAllByTestId('clip-beat-line')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('clip-redo'));
    expect(screen.getAllByTestId('clip-beat-line')).toHaveLength(3);
  });

  it('quantizes selections to the covered beats unless ⌘ frees them', async () => {
    const clip = clipMock();
    await openTrack(clip);
    fireEvent.click(screen.getByTestId('clip-play'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('❚❚'));
    // Taps at 1 and 3 s: a 30 BPM grid covering 1–3 s.
    tapAt(1.0);
    tapAt(3.0);
    fireEvent.click(screen.getByTestId('clip-stop'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('▶'));
    await waitFor(() => expect(screen.getAllByTestId('clip-beat-line')).toHaveLength(2));

    // Beyond the covered span nothing snaps — the grid is not there.
    select(3.4, 4.2);
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:03.40–0:04.20');

    // Extend the grid over that area and the same sweep quantizes
    // OUTWARD to whole beats, and the readout counts them.
    fireEvent.click(screen.getByTestId('clip-grid-fwd-plus'));
    fireEvent.keyDown(window, { key: 'Escape' });
    select(3.4, 4.2);
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:03.00–0:05.00');
    expect(screen.getByTestId('clip-readout').textContent).toContain('1 beat selected');
    // ⌘ keeps the window exactly where the hand put it. (A press inside
    // the old selection would slide it, so let that one go first.)
    fireEvent.keyDown(window, { key: 'Escape' });
    select(3.4, 4.2, { metaKey: true });
    expect(screen.getByTestId('clip-readout').textContent).toContain('0:03.40–0:04.20');
  });

  it('drops the tapped grid when a timeline edit re-splices the audio', async () => {
    const clip = clipMock();
    await openTrack(clip);
    fireEvent.click(screen.getByTestId('clip-play'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('❚❚'));
    tapAt(1.0);
    tapAt(3.0);
    fireEvent.click(screen.getByTestId('clip-stop'));
    await waitFor(() => expect(screen.getByTestId('clip-play').textContent).toBe('▶'));
    await waitFor(() => expect(screen.getAllByTestId('clip-beat-line').length).toBeGreaterThan(0));

    // The warp's anchors point at audio a cut moves: the grid goes with
    // it (undo brings both back together).
    select(5, 7);
    fireEvent.click(screen.getByTestId('clip-cut'));
    expect(screen.queryAllByTestId('clip-beat-line')).toHaveLength(0);
    await programNow(clip, (p) => p.warp.length === 0 && p.beat_grid === null);
    fireEvent.click(screen.getByTestId('clip-undo'));
    expect(screen.getAllByTestId('clip-beat-line').length).toBeGreaterThan(0);
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
    const { starts } = installWebAudio(10);
    const clip = clipMock();
    await openTrack(clip);
    // No selection: Loop used to light up and change nothing at all.
    fireEvent.click(screen.getByTestId('clip-loop'));
    fireEvent.click(screen.getByTestId('clip-play'));
    await waitFor(() => expect(clip.previewAudio).toHaveBeenCalledWith(expect.anything(), 0, 10));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0].loop).toBe(true);

    // Sweeping a selection hands playback to the live player, which
    // loops that span instead — and the pass that was sounding is
    // stopped as the new one starts, never left running beside it.
    select(2, 6);
    await waitFor(() => expect(clip.previewAudio).toHaveBeenCalledWith(expect.anything(), 2, 4));
    await waitFor(() => expect(starts.filter((x) => !x.stopped)).toHaveLength(1));
    expect(screen.getByTestId('clip-play').textContent).toBe('❚❚');
  });

  it('loops through Web Audio so the wrap is gapless', async () => {
    const { starts } = installWebAudio(4);
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

    // A selection always loops, so clearing it is what carries on
    // linearly — the Loop button only decides the no-selection case.
    fireEvent.click(screen.getByTestId('clip-loop'));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(audio.loop).toBe(false));
    expect(screen.getByTestId('clip-play').textContent).toBe('❚❚');
  });

  // The reported jam: "several seconds before the audio changes". Tone
  // is no longer something the backend bakes in — the selection loops in
  // a Web Audio graph whose EQ and level move under the audio.
  describe('the selection is live', () => {
    /** Drag EQ band 1 up to about +9.9 dB. */
    function dragBand() {
      fireEvent.mouseDown(screen.getByTestId('clip-eq-handle-1'), {
        clientX: 50,
        clientY: 80,
        button: 0,
      });
      fireEvent.mouseMove(window, { clientX: 50, clientY: 39 });
      fireEvent.mouseUp(window);
    }

    it('sends an EQ move into the running graph, with no render and no gap', async () => {
      const { starts, filters } = installWebAudio(4);
      const clip = clipMock();
      await openTrack(clip);
      select(2, 6);
      fireEvent.click(screen.getByTestId('clip-sel-play'));
      await waitFor(() => expect(starts.filter((x) => !x.stopped)).toHaveLength(1));
      const fetched = (clip.previewAudio as ReturnType<typeof vi.fn>).mock.calls.length;

      dragBand();

      // The band lands on a live filter node…
      await waitFor(() => expect(filters[0]?.gain.value).toBeCloseTo(9.9, 5));
      expect(filters[0].frequency.value).toBeCloseTo(99, 5);
      expect(filters[0].type).toBe('peaking');
      // …with no re-render, and the very same source still sounding.
      expect((clip.previewAudio as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(fetched);
      expect(starts.filter((x) => !x.stopped)).toHaveLength(1);
      expect(screen.getByTestId('clip-sel-play').textContent).toBe('❚❚');
      expect(screen.getByTestId('clip-sel-live').textContent).toBe('live');
    });

    it('renders the selection dry and leaves the source waveform alone', async () => {
      const { filters } = installWebAudio(4);
      const clip = clipMock();
      await openTrack(clip);
      select(2, 6);
      dragBand();
      await waitFor(() => expect(filters[0]?.gain.value).toBeCloseTo(9.9, 5));

      // Every render the page asks for is the DRY edit: the source track
      // above is the material as it was cut, and tone never moves it.
      const calls = (clip.renderPreview as ReturnType<typeof vi.fn>).mock.calls;
      for (const [request] of calls) {
        expect(request.program.eq.bands.every((b: { gain_db: number }) => b.gain_db === 0)).toBe(
          true,
        );
        expect(request.program.level).toEqual([]);
      }
      const audition = (clip.previewAudio as ReturnType<typeof vi.fn>).mock.calls;
      for (const [request] of audition) {
        expect(request.program.eq.bands.every((b: { gain_db: number }) => b.gain_db === 0)).toBe(
          true,
        );
      }
    });

    it('automates level in the graph and draws the lane under the selection', async () => {
      const { gains } = installWebAudio(4);
      const clip = clipMock();
      await openTrack(clip);
      select(2, 6);

      // The lane spans the SELECTION, so a click halfway across it is a
      // breakpoint in the middle of that span, not of the whole clip.
      const lane = sizeTimeline('clip-level-lane');
      fireEvent.mouseDown(lane, { clientX: 500, clientY: 85 });
      const level = (await savedProgram(clip)).level;
      expect(level).toHaveLength(1);
      expect(level[0].time_secs).toBeCloseTo(4, 5);
      expect(level[0].gain_db).toBeLessThan(0);

      // …and it is heard: the level gain follows the envelope live.
      fireEvent.click(screen.getByTestId('clip-sel-play'));
      await waitFor(() => expect(gains.length).toBeGreaterThan(0));
      await waitFor(() => expect(gains[0].gain.value).toBeGreaterThan(0));
    });

    it('swaps stems under the loop without stopping it', async () => {
      const { starts } = installWebAudio(4);
      const clip = clipMock();
      await openTrack(clip);
      select(2, 6);
      fireEvent.click(screen.getByTestId('clip-sel-play'));
      await waitFor(() => expect(starts.filter((x) => !x.stopped)).toHaveLength(1));

      // Switching drums off swaps the material under the loop.
      fireEvent.click(screen.getByTestId('clip-stem-drums'));
      await waitFor(() =>
        expect(clip.previewAudio).toHaveBeenCalledWith(
          expect.objectContaining({
            sources: [{ track_id: 7, stems: ['vocals', 'bass', 'other'] }],
          }),
          2,
          4,
        ),
      );
      // One source still sounding, and the transport never fell back to ▶.
      await waitFor(() => expect(starts.filter((x) => !x.stopped)).toHaveLength(1));
      expect(screen.getByTestId('clip-sel-play').textContent).toBe('❚❚');
    });

    it('hands playback back to the source track when the selection goes', async () => {
      const { starts } = installWebAudio(4);
      const clip = clipMock();
      await openTrack(clip);
      select(2, 6);
      expect(screen.getByTestId('clip-selection-pane')).toBeTruthy();
      fireEvent.click(screen.getByTestId('clip-sel-play'));
      await waitFor(() => expect(starts.filter((x) => !x.stopped)).toHaveLength(1));

      fireEvent.keyDown(window, { key: 'Escape' });
      // The pane goes with the selection, the live loop stops, and the
      // source track's transport is parked (not resumed) where it was.
      await waitFor(() => expect(screen.queryByTestId('clip-selection-pane')).toBeNull());
      expect(starts.filter((x) => !x.stopped)).toHaveLength(0);
      expect(screen.getByTestId('clip-play').textContent).toBe('▶');
      expect(screen.getByTestId('clip-selection-empty')).toBeTruthy();
    });

    it('does not hand the source track back audio that predates the tone', async () => {
      installWebAudio(10);
      const clip = clipMock();
      await openTrack(clip);
      // Play the whole clip first, so the transport really is holding a
      // rendered window when the selection takes playback off it.
      fireEvent.click(screen.getByTestId('clip-play'));
      await waitFor(() => expect(clip.previewAudio).toHaveBeenCalledWith(expect.anything(), 0, 10));
      select(2, 6);
      dragBand();

      // The EQ was applied in the graph, so the window the transport is
      // still holding is the clip WITHOUT it. Clearing the selection must
      // not resume from that: the next play renders the tone in.
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.click(screen.getByTestId('clip-play'));
      await waitFor(() => {
        const last = (clip.previewAudio as ReturnType<typeof vi.fn>).mock.calls.at(-1);
        expect(last?.[0].program.eq.bands[0].gain_db).toBeCloseTo(9.9, 5);
      });
    });

    it('says so when there is no live audio to be had', async () => {
      const clip = clipMock();
      await openTrack(clip);
      select(2, 6);
      // No AudioContext in this test's jsdom: the pane still shows the
      // span, and says its tone comes from a render instead.
      expect(screen.getByTestId('clip-sel-live').textContent).toBe('rendered');
      fireEvent.click(screen.getByTestId('clip-sel-play'));
      await waitFor(() => expect(clip.previewAudio).toHaveBeenCalledWith(expect.anything(), 2, 4));
      const audio = screen.getByTestId('clip-audio') as HTMLAudioElement;
      await waitFor(() => expect(audio.loop).toBe(true));
    });
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
      const { starts } = installWebAudio(4);
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
      const { starts } = installWebAudio(4);
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
      const { starts } = installWebAudio(4);
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
      const { starts } = installWebAudio(4);
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
      const { starts } = installWebAudio(4);
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

      const fetched = (clip.previewAudio as ReturnType<typeof vi.fn>).mock.calls.length;
      const wave = sizeTimeline('clip-waveform');
      fireEvent.mouseDown(wave, { clientX: 400 });
      fireEvent.mouseUp(window);

      // Answered out of the window already in hand — the whole six
      // seconds of this edit — rather than by fetching it all over again
      // and only jumping once that lands, which is what made a click
      // during playback feel ignored.
      await waitFor(() =>
        expect(screen.getByTestId('clip-playhead-readout').textContent).toBe('0:04.00'),
      );
      expect((clip.previewAudio as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(fetched);
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
    expect(joins()).toHaveLength(2);

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
    expect(joins()).toHaveLength(2);
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
    expect(joins()).toHaveLength(1);
  });
});
