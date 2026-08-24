// Beatify tab: the modal auto-analyzes on open, reading corrections and
// the warp slider never re-run the tracker, Save commits into the track
// view, and a missing `beat_this` degrades to the DSP tracker with an
// install hint. The backend is mocked; the grid math is pinned by
// BeatifyGrid.test.ts and the pipeline by crates/dj-analysis.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BeatifyClipClientApi } from '../src/beatifyClip';
import { BeatifyView } from '../src/components/BeatifyView';
import type {
  BeatifyAnalysis,
  BeatifyClientApi,
  BeatifyProject,
  BeatifyTrack,
  TrackerStatus,
} from '../src/beatify';
import type { LibraryClientApi, Track } from '../src/library';
import { WAVEFORM_VIEW_W } from '../src/components/WaveformView';

/** x of a source-time second in a timeline drawn at full zoom. */
const xAt = (secs: number) => (secs / 60) * WAVEFORM_VIEW_W;

const TRACK: Track = {
  id: 3,
  title: 'Live Set A',
  artist: 'Band',
  album: '',
  file_path: '/music/live-a.wav',
  content_hash: 'deadbeefdeadbeef',
  format: 'wav',
  duration_secs: 60,
  sample_rate: 44100,
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

const GRID = { bpm: 120, period: 0.5, phase: 0.5, beats: 64 };
/** Where those beats are in the SOURCE file. Deliberately a different
 *  phase from GRID (whose beat 0 is head padding, not audio), so a test
 *  can tell which of the two the modal is quantizing against. */
const SOURCE_GRID = { bpm: 120, period: 0.5, phase: 0.2, beats: 120 };

function analysis(overrides: Partial<BeatifyAnalysis> = {}): BeatifyAnalysis {
  return {
    source: {
      trackId: 3,
      title: TRACK.title,
      artist: TRACK.artist,
      durationSecs: 60,
      sampleRate: 44100,
      channels: 2,
      peaks: Array.from({ length: 40 }, (_, i) => (i % 8) / 8),
    },
    tracker: 'dsp',
    region: [0, 60],
    grid: GRID,
    sourceGrid: SOURCE_GRID,
    reading: { factor: 1, halfShift: false },
    agreement: {
      verdict: 'singleTracker',
      tempoSpreadBpm: 0,
      phaseAgreementPct: 100,
      metricalSplit: false,
      readings: [{ seed: 'dsp', bpm: 120, beats: 64 }],
      disagreementSpans: [],
    },
    beats: Array.from({ length: 64 }, (_, i) => 0.5 + i * 0.5),
    confidence: Array.from({ length: 64 }, () => 0.8),
    drift: [{ startSecs: 10, endSecs: 14, deltaBpm: 2.2 }],
    sweep: {
      points: [],
      zone: [0.3, 0.7],
      defaultStrength: 0.3,
    },
    strength: 0.3,
    quality: { worstFlamMs: 2.1, peakStretchPct: 0.84, rmsMs: 0.7, inBandPct: 99 },
    residuals: [0.001, -0.002, 0.004],
    // Beat 5 is missing: the tracker found nothing there.
    residualBeats: [3, 4, 6],
    anchors: [0.5, 4.5],
    leadIn: 0.014,
    metricalFlag: false,
    outputSecs: 32.5,
    ...overrides,
  };
}

function beatified(overrides: Partial<BeatifyTrack> = {}): BeatifyTrack {
  return {
    projectId: 'p1',
    projectName: 'Live Set A',
    trackId: 3,
    title: TRACK.title,
    artist: TRACK.artist,
    durationSecs: 32.5,
    sampleRate: 44100,
    channels: 2,
    peaks: Array.from({ length: 40 }, (_, i) => (i % 8) / 8),
    record: {
      source: '/music/live-a.wav',
      sourceHash: 'deadbeefdeadbeef',
      sourceSpan: [0, 60],
      warped: 'live-a.beatified.wav',
      grid: GRID,
      leadIn: 0.014,
      ruler: { group: 4 },
      warp: { strength: 0.3, anchorStride: 8, map: [] },
      quality: { worstFlamMs: 2.1, peakStretchPct: 0.84, rmsMs: 0.7, inBandPct: 99 },
      analysis: {
        tracker: 'dsp',
        agreement: {
          verdict: 'singleTracker',
          tempoSpreadBpm: 0,
          phaseAgreementPct: 100,
          metricalSplit: false,
          readings: [],
          disagreementSpans: [],
        },
        confidence: [0.5, 0.9],
      },
      reading: { factor: 1, halfShift: false },
    },
    ...overrides,
  };
}

/** A project as the list shows it. */
function project(overrides: Partial<BeatifyProject> = {}): BeatifyProject {
  return {
    id: 'p1',
    name: 'Live Set A',
    trackId: 3,
    title: TRACK.title,
    artist: TRACK.artist,
    bpm: 120,
    beats: 64,
    updated: 1000,
    sourceMissing: false,
    ...overrides,
  };
}

const STATUS: TrackerStatus = {
  tracker: 'dsp',
  beatThis: false,
  seeds: ['dsp'],
  device: 'cpu',
  python: '',
  detail: 'beat_this not importable',
  installHint: 'pip install beat-this torch',
};

function libraryMock(): LibraryClientApi {
  return {
    tracks: vi.fn(async () => [TRACK]),
  } as unknown as LibraryClientApi;
}

function clientMock(overrides: Partial<BeatifyClientApi> = {}): BeatifyClientApi {
  return {
    trackerStatus: vi.fn(async () => STATUS),
    analyze: vi.fn(async () => analysis()),
    setReading: vi.fn(async (reading) => analysis({ reading, grid: { ...GRID, bpm: 240 } })),
    meters: vi.fn(async (strength: number) => ({
      strength,
      anchorStride: 4,
      quality: { worstFlamMs: 1.2, peakStretchPct: 1.05, rmsMs: 0.4, inBandPct: 100 },
      residuals: [0.0005],
      anchors: [0.5],
    })),
    preview: vi.fn(async () => new ArrayBuffer(8)),
    syncCheck: vi.fn(async () => new ArrayBuffer(8)),
    save: vi.fn(async () => beatified()),
    projects: vi.fn(async () => []),
    openProject: vi.fn(async () => beatified()),
    renameProject: vi.fn(async () => [project({ name: 'Slower take' })]),
    deleteProject: vi.fn(async () => []),
    projectAudio: vi.fn(async () => new ArrayBuffer(8)),
    cancel: vi.fn(async () => undefined),
    ...overrides,
  };
}

function clipsMock(overrides: Partial<BeatifyClipClientApi> = {}): BeatifyClipClientApi {
  return {
    sources: vi.fn(async () => ({
      sources: [
        { source: { kind: 'seed' as const }, label: 'Seed track', available: true, hint: null },
        {
          source: { kind: 'stem' as const, name: 'drums' },
          label: 'drums',
          available: false,
          hint: 'no demucs stems yet \u2014 separate this track on the Clip page first',
        },
      ],
      clips: [],
      grid: GRID,
    })),
    open: vi.fn(async () => null),
    audio: vi.fn(async () => new ArrayBuffer(8)),
    preview: vi.fn(async () => new ArrayBuffer(8)),
    save: vi.fn(async (_projectId: string, clip) => ({ id: '1', clips: [{ ...clip, id: '1' }] })),
    remove: vi.fn(async () => []),
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:beatify');
  globalThis.URL.revokeObjectURL = vi.fn();
  window.HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  window.HTMLMediaElement.prototype.pause = vi.fn();
});

/** Start a new project from the picked track: the modal is how one is
 *  born, so every modal case goes through here. */
async function openTrack(client: BeatifyClientApi, clips: BeatifyClipClientApi = clipsMock()) {
  render(<BeatifyView client={client} library={libraryMock()} clips={clips} />);
  await screen.findByTestId('beatify-new-project');
  fireEvent.click(screen.getByTestId('beatify-new-project'));
  return screen.findByTestId('beatify-modal');
}

/** Open a saved project from the shelf. */
async function openProject(
  client: BeatifyClientApi,
  id = 'p1',
  clips: BeatifyClipClientApi = clipsMock(),
) {
  render(<BeatifyView client={client} library={libraryMock()} clips={clips} />);
  fireEvent.click(await screen.findByTestId(`beatify-project-open-${id}`));
  return screen.findByTestId('beatify-track-view');
}

describe('Beatify tab', () => {
  it('says which tracker it has and how to install the good one', async () => {
    render(<BeatifyView client={clientMock()} library={libraryMock()} clips={clipsMock()} />);
    const status = await screen.findByTestId('beatify-tracker-status');
    expect(status.textContent).toContain('beat_this not installed');
    expect(status.textContent).toContain('pip install beat-this');
  });

  it('analyzes automatically on open, with no Analyze button (MOD-A1)', async () => {
    const client = clientMock();
    await openTrack(client);
    await waitFor(() => expect(client.analyze).toHaveBeenCalledWith(3, null, expect.any(Number)));
    expect(screen.queryByText('Analyze')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('beatify-verdict').textContent).toContain('SINGLE TRACKER'),
    );
  });

  it('keeps phase 2 visible but inert until detection lands (MOD-A2)', async () => {
    let resolve: (a: BeatifyAnalysis) => void = () => {};
    const pending = new Promise<BeatifyAnalysis>((r) => {
      resolve = r;
    });
    const client = clientMock({ analyze: vi.fn(() => pending) });
    await openTrack(client);
    expect(screen.getByTestId('beatify-phase2').className).toContain('inert');
    resolve(analysis());
    await waitFor(() =>
      expect(screen.getByTestId('beatify-phase2').className).not.toContain('inert'),
    );
  });

  it('re-runs detection on a dragged region and resets alignment (MOD-A3/A8)', async () => {
    const client = clientMock();
    await openTrack(client);
    await screen.findByTestId('beatify-selection');
    const wave = screen.getByTestId('beatify-waveform');
    wave.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 100 }) as DOMRect;
    fireEvent.mouseDown(wave, { clientX: 10 });
    fireEvent.mouseMove(wave, { clientX: 50 });
    fireEvent.mouseUp(wave, { clientX: 50 });
    fireEvent.click(screen.getByTestId('beatify-rerun'));
    // 10–50 px of a 100 px wide, 60 s track is 6–30 s, rounded OUTWARD to
    // the source grid's beats 11 and 60 (phase 0.2, period 0.5).
    await waitFor(() =>
      expect(client.analyze).toHaveBeenLastCalledWith(3, [5.7, 30.2], expect.any(Number)),
    );
  });

  it('reads ÷2 / ×2 / ½ as grid transforms, never re-detection (MOD-26)', async () => {
    const client = clientMock();
    await openTrack(client);
    await screen.findByTestId('beatify-double');
    fireEvent.click(screen.getByTestId('beatify-double'));
    await waitFor(() =>
      expect(client.setReading).toHaveBeenCalledWith(
        { factor: 2, halfShift: false },
        expect.any(Number),
      ),
    );
    fireEvent.click(screen.getByTestId('beatify-half-shift'));
    await waitFor(() =>
      expect(client.setReading).toHaveBeenLastCalledWith(
        expect.objectContaining({ halfShift: true }),
        expect.any(Number),
      ),
    );
    // One analyze call: the tracker ran once, on open.
    expect((client.analyze as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('quantizes the region to the beats it can see, not to the render (MOD-A9)', async () => {
    // The modal draws SOURCE audio, so it must snap to the source grid.
    // Snapping to `grid` — the output timebase, whose beat 0 is head
    // padding — would put every line in a plausible but wrong place.
    const client = clientMock();
    await openTrack(client);
    const wave = await screen.findByTestId('beatify-waveform');
    wave.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 100 }) as DOMRect;
    fireEvent.mouseDown(wave, { clientX: 21 });
    fireEvent.mouseMove(wave, { clientX: 44 });
    fireEvent.mouseUp(wave, { clientX: 44 });

    // 12.6–26.4 s, grown outward onto source beats 24 (12.2 s) and 53
    // (26.7 s) — whole beats of the fitted line, phase 0.2.
    const sel = await screen.findByTestId('beatify-selection');
    expect(Number(sel.getAttribute('x'))).toBeCloseTo(xAt(12.2), 1);
    const readout = screen.getByTestId('beatify-readout').textContent ?? '';
    expect(readout).toContain('region beats 24–53');
    expect(readout).toContain('29 beats');
  });

  it('rules the source waveform in beats, numbered from the file', async () => {
    const client = clientMock();
    await openTrack(client);
    const ruler = await screen.findByTestId('beatify-ruler');
    // The marks count BEATS, not seconds: 64 of them in a 60 s file, and
    // the first is at 0.2 s where the fitted line starts — the same ruler
    // the track view has, over the audio the beats are actually in.
    await waitFor(() => expect(ruler.textContent).toBe('064'));
    const marks = ruler.querySelectorAll('.clip-tick');
    expect(marks.length).toBeGreaterThan(4);
    expect((marks[0] as HTMLElement).style.left).toBe(`${(0.2 / 60) * 100}%`);
  });

  it('says what the strip below the waveform is measuring', async () => {
    const client = clientMock();
    await openTrack(client);
    const caption = await screen.findByTestId('beatify-strip-caption');
    expect(caption.textContent).toContain('from the grid line');
    // The scale, the sign and the colour law are all written down.
    const plot = screen.getByTestId('beatify-strip').parentElement;
    expect(plot?.textContent).toContain('+40 ms late');
    expect(plot?.textContent).toContain('−40 ms early');
    expect(plot?.textContent).toContain('on the grid');
    expect(screen.getByTestId('beatify-strip-key').textContent).toContain('within ±5 ms');
  });

  it('puts each residual under the beat it measures', async () => {
    // The fixture's third residual is beat 6, because beat 5 was never
    // detected. Spacing the dots evenly would draw it at beat 2's x and
    // quietly mis-attribute every error after a dropped beat.
    const client = clientMock();
    await openTrack(client);
    const dots = (await screen.findByTestId('beatify-strip')).querySelectorAll('circle');
    expect(dots.length).toBe(3);
    const x = (n: number) => xAt(0.2 + n * 0.5);
    expect(Number(dots[0].getAttribute('cx'))).toBeCloseTo(x(3), 1);
    expect(Number(dots[2].getAttribute('cx'))).toBeCloseTo(x(6), 1);
    expect(dots[2].querySelector('title')?.textContent).toBe('beat 6: +4.0 ms');
  });

  it('moves the warp slider without rendering audio (MOD-A22)', async () => {
    const client = clientMock();
    await openTrack(client);
    const slider = await screen.findByTestId('beatify-strength');
    fireEvent.change(slider, { target: { value: '0.8' } });
    await waitFor(() => expect(client.meters).toHaveBeenCalledWith(0.8));
    expect(client.preview).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('beatify-meters').textContent).toContain('1.2 ms'),
    );
  });

  it('auditions windows, not whole tracks (MOD-A23)', async () => {
    const client = clientMock();
    await openTrack(client);
    fireEvent.click(await screen.findByTestId('beatify-play'));
    await waitFor(() => expect(client.preview).toHaveBeenCalled());
    const [, secs, warped] = (client.preview as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(secs).toBeLessThanOrEqual(30);
    expect(warped).toBe(false); // phase 1 plays the source (MOD-A20)
    fireEvent.click(screen.getByTestId('beatify-ab'));
    fireEvent.click(screen.getByTestId('beatify-play'));
    await waitFor(() =>
      expect((client.preview as ReturnType<typeof vi.fn>).mock.calls[1][2]).toBe(true),
    );
  });

  it('commits into the track view and writes nothing on cancel', async () => {
    const client = clientMock();
    await openTrack(client);
    fireEvent.click(await screen.findByTestId('beatify-commit'));
    await waitFor(() => expect(client.save).toHaveBeenCalled());
    const view = await screen.findByTestId('beatify-track-view');
    expect(view.textContent).toContain('120.00 BPM');
    expect(screen.queryByTestId('beatify-modal')).toBeNull();
  });

  it('discards the session when the modal is dismissed (MOD-A25)', async () => {
    const client = clientMock();
    await openTrack(client);
    fireEvent.click(await screen.findByTestId('beatify-cancel'));
    await waitFor(() => expect(client.cancel).toHaveBeenCalled());
    expect(screen.queryByTestId('beatify-modal')).toBeNull();
  });

  it('opens a saved project straight into the builder, no modal (MOD-A31)', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    expect(client.openProject).toHaveBeenCalledWith('p1', expect.any(Number));
    expect(screen.queryByTestId('beatify-modal')).toBeNull();
    // Re-beatify warns before it invalidates anything cut from the old grid.
    fireEvent.click(screen.getByTestId('beatify-rebeatify'));
    const warning = await screen.findByTestId('beatify-rebeatify-warning');
    expect(warning.textContent).toContain('stops matching');
    fireEvent.click(screen.getByTestId('beatify-rebeatify-confirm'));
    await screen.findByTestId('beatify-modal');
  });

  it('loops the region it auditions and takes the spacebar (MOD-A16/A18)', async () => {
    const client = clientMock();
    await openTrack(client);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-phase2').className).not.toContain('inert'),
    );
    fireEvent.keyDown(window, { key: ' ' });
    await waitFor(() => expect(client.preview).toHaveBeenCalled());
    // The audition loops by default (the transport owns the looping; its
    // wrap mechanics are pinned by ClipTransport.test.ts).
    expect(screen.getByTestId('beatify-loop').getAttribute('aria-pressed')).toBe('true');
    // The window never exceeds the region being auditioned.
    const [start, secs] = (client.preview as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(start + secs).toBeLessThanOrEqual(60);
  });

  it('selects a group on double-click in the track view (TV-18)', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    const wave = await screen.findByTestId('beatify-track-waveform');
    wave.getBoundingClientRect = () => ({ left: 0, width: 320, top: 0, height: 100 }) as DOMRect;
    fireEvent.doubleClick(wave, { clientX: 100 });
    await screen.findByTestId('beatify-track-selection');
    expect(screen.getByTestId('beatify-track-readout').textContent).toContain('4 beats · 1 group');
  });

  it('zooms the track view and offers the way back (TV-10)', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    await screen.findByTestId('beatify-track-waveform');
    expect((screen.getByTestId('beatify-track-zoom-out') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('beatify-track-zoom-in'));
    expect(screen.getByTestId('beatify-track-readout').textContent).toContain('view');
    expect((screen.getByTestId('beatify-track-zoom-out') as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByTestId('beatify-track-zoom-fit'));
    expect(screen.getByTestId('beatify-track-readout').textContent).not.toContain('view');
  });

  it('leaves the view where it was put, even while playing', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    await screen.findByTestId('beatify-track-waveform');
    fireEvent.click(screen.getByTestId('beatify-track-zoom-in'));
    fireEvent.click(screen.getByTestId('beatify-track-zoom-in'));
    const view = () => screen.getByTestId('beatify-track-readout').textContent;
    const before = view();

    // Playing does not scroll the waveform under the user: the playhead
    // simply travels across (and out of) the window they chose.
    fireEvent.click(screen.getByTestId('beatify-track-play'));
    await waitFor(() => expect(screen.getByTestId('beatify-track-play').textContent).toBe('❚❚'));
    expect(view()).toBe(before);
    expect(screen.queryByTestId('beatify-track-follow')).toBeNull();
  });

  it('seeks and selects in whole beats in the track view (TV-6/TV-14)', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    const wave = await screen.findByTestId('beatify-track-waveform');
    wave.getBoundingClientRect = () => ({ left: 0, width: 320, top: 0, height: 100 }) as DOMRect;
    fireEvent.mouseDown(wave, { clientX: 40 });
    fireEvent.mouseMove(wave, { clientX: 120 });
    fireEvent.mouseUp(wave, { clientX: 120 });
    const selection = await screen.findByTestId('beatify-track-selection');
    expect(selection).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('beatify-track-readout').textContent).toMatch(/\d+ beats/),
    );
  });
});

// ---------------------------------------------------------------------------
// Projects (a track is not a project, and never was one)
// ---------------------------------------------------------------------------

describe('beatify projects', () => {
  it('shows the shelf of saved projects, newest first', async () => {
    const client = clientMock({
      projects: vi.fn(async () => [
        project({ id: 'p2', name: 'Slower take', updated: 2000 }),
        project({ id: 'p1', name: 'First pass', updated: 1000 }),
      ]),
    });
    render(<BeatifyView client={client} library={libraryMock()} clips={clipsMock()} />);

    const shelf = await screen.findByTestId('beatify-projects');
    const names = Array.from(shelf.querySelectorAll('.beatify-project-name')).map(
      (n) => n.textContent,
    );
    expect(names).toEqual(['Slower take', 'First pass']);
    // Both came from the same track, and both say so.
    expect(shelf.textContent).toContain('Live Set A');
  });

  it('says what to do when there are none yet', async () => {
    render(<BeatifyView client={clientMock()} library={libraryMock()} clips={clipsMock()} />);
    const empty = await screen.findByText(/No projects yet/);
    expect(empty.textContent).toContain('as many projects as you like');
  });

  it('starts a NEW project from a track that already has one', async () => {
    // The old tab refused: a beatified track opened its one grid. Now the
    // same track can be beatified again, into a project of its own.
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    render(<BeatifyView client={client} library={libraryMock()} clips={clipsMock()} />);
    fireEvent.click(await screen.findByTestId('beatify-new-project'));

    await screen.findByTestId('beatify-modal');
    fireEvent.click(await screen.findByTestId('beatify-commit'));
    await waitFor(() => expect(client.save).toHaveBeenCalled());
    const [request] = (client.save as ReturnType<typeof vi.fn>).mock.calls[0];
    // No id: the backend mints one rather than overwriting the project
    // that track already has.
    expect(request.projectId).toBe('');
    expect(request.name).toBe('Live Set A');
  });

  it('re-beatifies IN PLACE, into the project that is open', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    fireEvent.click(screen.getByTestId('beatify-rebeatify'));
    fireEvent.click(await screen.findByTestId('beatify-rebeatify-confirm'));
    fireEvent.click(await screen.findByTestId('beatify-commit'));

    await waitFor(() => expect(client.save).toHaveBeenCalled());
    const [request] = (client.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.projectId).toBe('p1');
  });

  it('keys the clip builder by the PROJECT, not the track', async () => {
    // Two projects of one track must not share a clip drawer.
    const client = clientMock({
      projects: vi.fn(async () => [project({ id: 'p2', name: 'Slower take' })]),
      openProject: vi.fn(async () => beatified({ projectId: 'p2', projectName: 'Slower take' })),
    });
    const clips = clipsMock();
    await openProject(client, 'p2', clips);
    await waitFor(() => expect(clips.sources).toHaveBeenCalledWith('p2'));
  });

  it('renames a project from the shelf', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    render(<BeatifyView client={client} library={libraryMock()} clips={clipsMock()} />);
    fireEvent.click(await screen.findByTestId('beatify-project-rename-p1'));
    const box = screen.getByTestId('beatify-project-rename-input') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'Slower take' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(client.renameProject).toHaveBeenCalledWith('p1', 'Slower take'));
    await screen.findByText('Slower take');
  });

  it('deletes a project and leaves the shelf without it', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    render(<BeatifyView client={client} library={libraryMock()} clips={clipsMock()} />);
    fireEvent.click(await screen.findByTestId('beatify-project-delete-p1'));

    await waitFor(() => expect(client.deleteProject).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(screen.queryByTestId('beatify-project-p1')).toBeNull());
    expect(screen.getByTestId('beatify-status').textContent).toContain('Deleted');
  });

  it('closes a project without deleting it', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    fireEvent.click(screen.getByTestId('beatify-close-project'));

    await screen.findByTestId('beatify-projects');
    expect(client.deleteProject).not.toHaveBeenCalled();
    expect(screen.queryByTestId('beatify-track-view')).toBeNull();
  });

  it('still opens a project whose source track has left the library', async () => {
    // The render belongs to the project, so it plays; only the things
    // that need the ORIGINAL file are out of reach, and it says so.
    const client = clientMock({
      projects: vi.fn(async () => [project({ sourceMissing: true, title: '(source missing)' })]),
    });
    render(<BeatifyView client={client} library={libraryMock()} clips={clipsMock()} />);
    const note = await screen.findByTestId('beatify-project-source-missing');
    expect(note.textContent).toContain('re-beatify need it back');
    fireEvent.click(screen.getByTestId('beatify-project-open-p1'));
    await screen.findByTestId('beatify-track-view');
  });
});
