// Beatify tab: the modal auto-analyzes on open, reading corrections and
// the warp slider never re-run the tracker, Save commits into the track
// view, and a missing `beat_this` degrades to the DSP tracker with an
// install hint. The backend is mocked; the grid math is pinned by
// BeatifyGrid.test.ts and the pipeline by crates/dj-analysis.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BeatifyClipClientApi } from '../src/beatifyClip';
import { BeatifyView } from '../src/components/BeatifyView';
import { MAX_PROJECT_BPM, MIN_PROJECT_BPM } from '../src/beatify';
import type {
  BeatifyAnalysis,
  BeatifyClientApi,
  BeatifyProject,
  BeatifyProjectSummary,
  BeatifyScope,
  BeatifySeed,
  BeatifyTapResult,
  SeedReading,
  TapVerdict,
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

/** The three checkpoints a `beat_this` run produces. */
const SEEDS = ['final0', 'final1', 'final2'];

/** One seed's row in the agreement: a steady 120 BPM pass unless told
 *  otherwise. The interval stats are RAW, so a test can hand a seed a
 *  doubled or missed beat without touching its fitted BPM. */
function seedReading(seed: string, overrides: Partial<SeedReading> = {}): SeedReading {
  return {
    seed,
    bpm: 120,
    beats: 64,
    ibiMean: 0.5,
    ibiMin: 0.5,
    ibiMax: 0.5,
    ibiVariance: 0,
    ...overrides,
  };
}

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
      readings: [seedReading('dsp')],
      disagreementSpans: [],
    },
    seed: 'dsp',
    seeds: ['dsp'],
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

/** A `beat_this` analysis: three seeds, the second of which doubled a
 *  beat and missed another — same fitted BPM, different raw intervals. */
function threeSeeds(overrides: Partial<BeatifyAnalysis> = {}): BeatifyAnalysis {
  return analysis({
    tracker: 'beat_this/final0+final1+final2',
    seed: 'final0',
    seeds: SEEDS,
    agreement: {
      verdict: 'mostlyAgreed',
      tempoSpreadBpm: 0.31,
      phaseAgreementPct: 94.5,
      metricalSplit: false,
      readings: [
        seedReading('final0'),
        seedReading('final1', {
          beats: 65,
          ibiMean: 0.492,
          ibiMin: 0.25,
          ibiMax: 1.0,
          ibiVariance: 0.0081,
        }),
        seedReading('final2', { bpm: 119.7, ibiMean: 0.501 }),
      ],
      disagreementSpans: [[12, 15]],
    },
    ...overrides,
  });
}

function tapVerdict(overrides: Partial<TapVerdict> = {}): TapVerdict {
  return {
    outcome: 'chose',
    taps: 12,
    tapBpm: 119.4,
    selfConcentration: 0.93,
    seed: 'final1',
    reading: { factor: 1, halfShift: false },
    concentration: 0.95,
    offsetSecs: 0.048,
    levelRatio: 1.01,
    detail: '12 taps at 119.4 BPM chose seed final1 · your taps run 48 ms late (not applied)',
    ...overrides,
  };
}

function tapResult(overrides: Partial<BeatifyTapResult> = {}): BeatifyTapResult {
  const verdict = overrides.verdict ?? tapVerdict();
  return {
    verdict,
    analysis: overrides.analysis ?? threeSeeds({ seed: verdict.seed || 'final0' }),
  };
}

function beatified(overrides: Partial<BeatifySeed> = {}): BeatifySeed {
  return {
    projectId: 'p1',
    projectName: 'Live Set A',
    id: 's1',
    sourceBpm: 120,
    speed: 1,
    sourceMissing: false,
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

/** A project as the SHELF shows it. */
function project(overrides: Partial<BeatifyProjectSummary> = {}): BeatifyProjectSummary {
  return {
    id: 'p1',
    name: 'Live Set A',
    bpm: 120,
    seeds: [TRACK.title],
    updated: 1000,
    sourceMissing: false,
    ...overrides,
  };
}

/** A project as it is OPEN: the tempo, and the seeds on it. */
function opened(overrides: Partial<BeatifyProject> = {}): BeatifyProject {
  return {
    id: 'p1',
    name: 'Live Set A',
    bpm: 120,
    seeds: [beatified()],
    ...overrides,
  };
}

/** A cut point inspector payload: attacks 6 ms before the line, with a
 *  couple of milliseconds of smear between the traces. */
function scopeOf(preSecs = 0.04, points = 8): BeatifyScope {
  return {
    preSecs,
    postSecs: 0.07,
    traces: Array.from({ length: 4 }, (_, i) => ({
      beat: i * 10,
      samples: Array.from({ length: points }, (_, j) => (j % 2 ? 0.4 : -0.4)),
      attack: -0.006 + i * 0.0005,
    })),
    attackLead: 0.006,
    spread: 0.0015,
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
    setSeed: vi.fn(async (seed: string) => analysis({ seed, seeds: SEEDS })),
    taps: vi.fn(async () => tapResult()),
    meters: vi.fn(async (strength: number) => ({
      strength,
      anchorStride: 4,
      quality: { worstFlamMs: 1.2, peakStretchPct: 1.05, rmsMs: 0.4, inBandPct: 100 },
      residuals: [0.0005],
      anchors: [0.5],
    })),
    preview: vi.fn(async () => new ArrayBuffer(8)),
    syncCheck: vi.fn(async () => new ArrayBuffer(8)),
    scope: vi.fn(async (_strength: number, points: number, preSecs: number) =>
      scopeOf(preSecs, points),
    ),
    save: vi.fn(async () => opened()),
    projects: vi.fn(async () => []),
    newProject: vi.fn(async () => opened({ bpm: null, seeds: [] })),
    openProject: vi.fn(async () => opened()),
    setProjectBpm: vi.fn(async (_id: string, bpm: number) => opened({ bpm })),
    renameProject: vi.fn(async () => [project({ name: 'Slower take' })]),
    deleteProject: vi.fn(async () => []),
    deleteSeed: vi.fn(async () => opened({ bpm: null, seeds: [] })),
    renameSeed: vi.fn(async () => opened()),
    projectAudio: vi.fn(async () => new ArrayBuffer(8)),
    cancel: vi.fn(async () => undefined),
    ...overrides,
  };
}

function clipsMock(overrides: Partial<BeatifyClipClientApi> = {}): BeatifyClipClientApi {
  return {
    sources: vi.fn(async () => ({
      sources: [
        {
          source: { kind: 'seed' as const, id: 's1', stems: [] },
          seedId: 's1',
          label: TRACK.title,
          beats: 64,
          sourceBpm: 120,
          speed: 1,
          available: true,
          hint: null,
          stems: ['drums', 'bass', 'other', 'vocals'].map((name) => ({
            name,
            available: false,
            hint: 'no demucs stems yet \u2014 separate this track on the Clip page first',
          })),
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

/** The import modal opens with nothing loaded (MOD-A0): say which track
 *  before anything can happen. */
async function chooseTrack(id: number = TRACK.id) {
  fireEvent.focus(await screen.findByTestId('beatify-import-search'));
  fireEvent.click(await screen.findByTestId(`beatify-import-option-${id}`));
}

/** Start a project and import a track into it: the modal is how material
 *  gets in, so every modal case goes through here. */
async function openTrack(client: BeatifyClientApi, clips: BeatifyClipClientApi = clipsMock()) {
  render(<BeatifyView client={client} library={libraryMock()} clips={clips} />);
  fireEvent.click(await screen.findByTestId('beatify-new-project'));
  fireEvent.click(await screen.findByTestId('beatify-import-track'));
  await chooseTrack();
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

  // The track is chosen INSIDE the modal, and choosing it is what starts
  // the work: opening the modal must cost nothing, so that changing your
  // mind about importing at all costs nothing either.
  it('asks which track before it loads anything (MOD-A0)', async () => {
    const client = clientMock();
    render(<BeatifyView client={client} library={libraryMock()} clips={clipsMock()} />);
    fireEvent.click(await screen.findByTestId('beatify-new-project'));
    fireEvent.click(await screen.findByTestId('beatify-import-track'));

    await screen.findByTestId('beatify-modal-choose');
    expect(client.analyze).not.toHaveBeenCalled();
    // Nothing to inspect yet, so none of the report is on show.
    expect(screen.queryByTestId('beatify-verdict')).toBeNull();
    expect(screen.queryByTestId('beatify-commit')).toBeNull();

    fireEvent.focus(screen.getByTestId('beatify-import-search'));
    fireEvent.change(screen.getByTestId('beatify-import-search'), { target: { value: 'live' } });
    fireEvent.click(screen.getByTestId(`beatify-import-option-${TRACK.id}`));

    await waitFor(() => expect(client.analyze).toHaveBeenCalledWith(3, null, expect.any(Number)));
    await screen.findByTestId('beatify-commit');
  });

  it('has no track picker on the page itself', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    expect(screen.queryByTestId('beatify-track-select')).toBeNull();
    expect(screen.queryByTestId('beatify-import-search')).toBeNull();
  });

  // While the modal is up it is the only thing on the page that can be
  // played, typed at or clicked: two transports answering one spacebar is
  // how you end up auditioning a decision against the wrong audio.
  it('takes the keyboard and the speakers from the page below it', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    fireEvent.keyDown(window, { key: ' ' });
    await waitFor(() => expect(screen.getByTestId('beatify-track-play').textContent).toBe('❚❚'));

    fireEvent.click(screen.getByTestId('beatify-import-track'));
    await screen.findByTestId('beatify-modal-choose');

    await waitFor(() => expect(screen.getByTestId('beatify-track-play').textContent).toBe('▶'));
    expect(screen.getByTestId('beatify-builder').hasAttribute('inert')).toBe(true);
    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.getByTestId('beatify-track-play').textContent).toBe('▶');

    // Dismissed, the page has itself back.
    fireEvent.click(screen.getByTestId('beatify-cancel'));
    await waitFor(() =>
      expect(screen.getByTestId('beatify-builder').hasAttribute('inert')).toBe(false),
    );
    fireEvent.keyDown(window, { key: ' ' });
    await waitFor(() => expect(screen.getByTestId('beatify-track-play').textContent).toBe('❚❚'));
  });

  it('starts over when the track is changed under it', async () => {
    const other = { ...TRACK, id: 9, title: 'Second Set' };
    const library = { tracks: vi.fn(async () => [TRACK, other]) } as unknown as LibraryClientApi;
    const client = clientMock();
    render(<BeatifyView client={client} library={library} clips={clipsMock()} />);
    fireEvent.click(await screen.findByTestId('beatify-new-project'));
    fireEvent.click(await screen.findByTestId('beatify-import-track'));
    await chooseTrack();
    await screen.findByTestId('beatify-commit');

    fireEvent.focus(screen.getByTestId('beatify-import-search'));
    fireEvent.click(screen.getByTestId('beatify-import-option-9'));
    await waitFor(() => expect(client.analyze).toHaveBeenCalledWith(9, null, expect.any(Number)));
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

  // --- seeds and taps (§3.8a) -------------------------------------------

  it('shows every seed with its RAW interval statistics', async () => {
    const client = clientMock({ analyze: vi.fn(async () => threeSeeds()) });
    await openTrack(client);
    await screen.findByTestId('beatify-seed-table');

    // The doubled beat is in the minimum, the missed one in the maximum,
    // and neither has moved the fitted BPM — which is the whole reason
    // the raw intervals are shown beside it.
    const row = screen.getByTestId('beatify-seed-row-final1');
    const cells = Array.from(row.querySelectorAll('td')).map((c) => c.textContent);
    expect(cells).toEqual(['final1', '65', '120.00', '492.0', '250.0', '1000.0', '90.0']);

    // A steady seed's spread is zero, and its gap is the period.
    const steady = screen.getByTestId('beatify-seed-row-final0');
    const steadyCells = Array.from(steady.querySelectorAll('td')).map((c) => c.textContent);
    expect(steadyCells.slice(3)).toEqual(['500.0', '500.0', '500.0', '0.0']);
  });

  it('fits the grid to a chosen seed without re-running the tracker (MOD-26)', async () => {
    const client = clientMock({ analyze: vi.fn(async () => threeSeeds()) });
    await openTrack(client);
    const picker = (await screen.findByTestId('beatify-seed')) as HTMLSelectElement;
    expect(picker.value).toBe('final0');
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(SEEDS);

    fireEvent.change(picker, { target: { value: 'final2' } });
    await waitFor(() => expect(client.setSeed).toHaveBeenCalledWith('final2', expect.any(Number)));
    // The tracker ran once, on open — switching seeds is a re-fit of
    // detections already in hand.
    expect((client.analyze as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    await waitFor(() =>
      expect((screen.getByTestId('beatify-seed') as HTMLSelectElement).value).toBe('final2'),
    );
  });

  it('offers no seed choice when there is only one seed', async () => {
    const client = clientMock();
    await openTrack(client);
    // The DSP fallback is one tracker: a picker with a single option is
    // a control that cannot do anything.
    await waitFor(() =>
      expect((screen.getByTestId('beatify-seed') as HTMLSelectElement).disabled).toBe(true),
    );
  });

  it('records taps at the transport position and hands them over on Use taps', async () => {
    const client = clientMock({ analyze: vi.fn(async () => threeSeeds()) });
    await openTrack(client);
    const tapButton = await screen.findByTestId('beatify-tap');

    fireEvent.click(tapButton);
    fireEvent.click(tapButton);
    fireEvent.keyDown(window, { key: 't' });
    expect(screen.getByTestId('beatify-tap-count').textContent).toBe('3 taps');
    // Auto-repeat is the keyboard's tempo, not the user's.
    fireEvent.keyDown(window, { key: 't', repeat: true });
    expect(screen.getByTestId('beatify-tap-count').textContent).toBe('3 taps');

    fireEvent.click(screen.getByTestId('beatify-tap-use'));
    await waitFor(() =>
      expect(client.taps).toHaveBeenCalledWith(
        [expect.any(Number), expect.any(Number), expect.any(Number)],
        expect.any(Number),
      ),
    );
  });

  it('adopts the analysis the taps chose and reports the discarded latency', async () => {
    const client = clientMock({ analyze: vi.fn(async () => threeSeeds()) });
    await openTrack(client);
    fireEvent.click(await screen.findByTestId('beatify-tap'));
    fireEvent.click(screen.getByTestId('beatify-tap-use'));

    await waitFor(() =>
      expect((screen.getByTestId('beatify-seed') as HTMLSelectElement).value).toBe('final1'),
    );
    // The lag is told, and told that it was not used: a grid that had
    // absorbed it would be late in every clip cut from it, for ever,
    // with nothing downstream able to notice.
    const note = screen.getByTestId('beatify-tap-note').textContent ?? '';
    expect(note).toContain('48 ms late');
    expect(note).toContain('not applied');
  });

  it('leaves the grid alone when the taps are refused, and says why', async () => {
    const refused = tapResult({
      verdict: tapVerdict({
        outcome: 'uneven',
        seed: '',
        detail: 'those taps were too uneven to read — nothing changed',
      }),
    });
    const client = clientMock({
      analyze: vi.fn(async () => threeSeeds()),
      taps: vi.fn(async () => refused),
    });
    await openTrack(client);
    fireEvent.click(await screen.findByTestId('beatify-tap'));
    fireEvent.click(screen.getByTestId('beatify-tap-use'));

    await waitFor(() =>
      expect(screen.getByTestId('beatify-tap-note').textContent).toContain('too uneven'),
    );
    // Still the seed the analysis opened on: a refusal changes nothing.
    expect((screen.getByTestId('beatify-seed') as HTMLSelectElement).value).toBe('final0');
  });

  it('draws the taps on the waveform and clears them with the track', async () => {
    const client = clientMock({ analyze: vi.fn(async () => threeSeeds()) });
    await openTrack(client);
    fireEvent.click(await screen.findByTestId('beatify-tap'));
    fireEvent.click(screen.getByTestId('beatify-tap'));
    expect(screen.getAllByTestId('beatify-tap-mark')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('beatify-tap-clear'));
    expect(screen.queryAllByTestId('beatify-tap-mark')).toHaveLength(0);
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

  it('moves the cut line as the lead-in moves (MOD-20)', async () => {
    // The complaint this answers: the lead-in "does not seem to do
    // anything". It cannot move the waveform — the grid is not allowed to
    // move (MOD-22) — so what has to move is the CUT, in a window zoomed
    // far enough in for a millisecond to be a distance.
    const client = clientMock();
    await openTrack(client);
    const cutX = async () =>
      Number((await screen.findByTestId('beatify-scope-cut')).getAttribute('x1'));
    // The window is −40..+70 ms across 1000 units; the analysis measured
    // 14 ms, so the cut starts 14 ms before the line.
    await waitFor(async () => expect(await cutX()).toBeCloseTo(((-0.014 + 0.04) / 0.11) * 1000, 1));
    fireEvent.change(screen.getByTestId('beatify-leadin'), { target: { value: '30' } });
    await waitFor(async () => expect(await cutX()).toBeCloseTo(((-0.03 + 0.04) / 0.11) * 1000, 1));
    // And what it discards grows with it.
    expect(Number(screen.getByTestId('beatify-scope-drop').getAttribute('width'))).toBeCloseTo(
      ((-0.03 + 0.04) / 0.11) * 1000,
      1,
    );
  });

  it('says whether the cut clears the attack or slices it (MOD-11)', async () => {
    const client = clientMock();
    await openTrack(client);
    const readout = await screen.findByTestId('beatify-scope-clearance');
    // Attacks begin 6 ms early; the measured 14 ms lead-in clears them.
    await waitFor(() => expect(readout.textContent).toContain('clears them by 8.0 ms'));
    expect(readout.className).toContain('good');
    fireEvent.change(screen.getByTestId('beatify-leadin'), { target: { value: '0' } });
    await waitFor(() =>
      expect(screen.getByTestId('beatify-scope-clearance').textContent).toContain(
        '6.0 ms INSIDE the attack',
      ),
    );
    expect(screen.getByTestId('beatify-scope-clearance').className).toContain('bad');
  });

  it('reaches 250 ms, and opens the window so the cut stays in view', async () => {
    const client = clientMock();
    await openTrack(client);
    const slider = await screen.findByTestId('beatify-leadin');
    expect(slider.getAttribute('max')).toBe('250');
    fireEvent.change(slider, { target: { value: '250' } });
    // A cut a quarter of a second back is outside the PRD's 40 ms window,
    // so the inspector asks for a wider one instead of drawing the line
    // off the edge of itself.
    await waitFor(() =>
      expect(client.scope).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), 0.275),
    );
    await waitFor(() => {
      const x = Number(screen.getByTestId('beatify-scope-cut').getAttribute('x1'));
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(1000);
    });
  });

  it('cuts the sync check at the lead-in, so it can be heard (§3.7)', async () => {
    const client = clientMock();
    await openTrack(client);
    fireEvent.change(await screen.findByTestId('beatify-leadin'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('beatify-sync'));
    await waitFor(() => expect(client.syncCheck).toHaveBeenCalledWith(0.3, 0.03));
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
    // And no way to re-render the seed under the clips cut from it: a
    // second take on a track is a second seed, imported like any other.
    expect(screen.queryByTestId('beatify-rebeatify')).toBeNull();
  });

  // The verdict and the flam figures are how the IMPORT is decided; once
  // it is decided they are just a red line over a track that is already
  // on the grid, so the track view carries the tempo and nothing else.
  it('does not re-litigate the analysis in the track view', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    const head = await screen.findByTestId('beatify-track-view');
    expect(screen.queryByTestId('beatify-track-quality')).toBeNull();
    expect(head.textContent).not.toContain('AGREED');
    expect(head.textContent).not.toContain('flam');
    expect(head.textContent).toContain('120.00 BPM');
  });

  it('says nothing at all after a successful import', async () => {
    const client = clientMock();
    await openTrack(client);
    fireEvent.click(await screen.findByTestId('beatify-commit'));
    await screen.findByTestId('beatify-track-view');
    expect(screen.queryByTestId('beatify-status')).toBeNull();
  });

  // Nothing on this page congratulates the user: the page IS the receipt.
  // Failures are not silent either — every beatify command goes through
  // `ipc.ts`, which puts a failed one in the banner and the console.
  it('has no success line to congratulate anybody with', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    fireEvent.click(screen.getByTestId('beatify-close-project'));
    await screen.findByTestId('beatify-projects');
    fireEvent.click(await screen.findByTestId('beatify-project-delete-p1'));
    fireEvent.click(await screen.findByTestId('beatify-delete-confirm'));
    await waitFor(() => expect(client.deleteProject).toHaveBeenCalled());
    expect(screen.queryByTestId('beatify-status')).toBeNull();
    expect(document.body.textContent).not.toContain('Deleted');
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
    // A project says what it runs at and what is on it.
    expect(shelf.textContent).toContain('120.00 BPM');
    expect(shelf.textContent).toContain('Live Set A');
  });

  it('says what to do when there are none yet', async () => {
    render(<BeatifyView client={clientMock()} library={libraryMock()} clips={clipsMock()} />);
    const empty = await screen.findByText(/No projects yet/);
    expect(empty.textContent).toContain('import a track to set its BPM');
  });

  // A project is a place to put material, not a take on one track: it is
  // started empty, and material is imported into it afterwards.
  it('starts a project with nothing in it, and no modal', async () => {
    const client = clientMock();
    render(<BeatifyView client={client} library={libraryMock()} clips={clipsMock()} />);
    fireEvent.click(await screen.findByTestId('beatify-new-project'));

    await waitFor(() => expect(client.newProject).toHaveBeenCalled());
    expect(screen.queryByTestId('beatify-modal')).toBeNull();
    // Nothing to build with yet, and the page says how to fix that.
    expect((await screen.findByTestId('beatify-builder-empty')).textContent).toContain(
      'sets the tempo',
    );
    // No tempo either, so the BPM box has nothing to offer.
    expect((screen.getByTestId('beatify-project-bpm') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('beatify-project-bpm') as HTMLInputElement).disabled).toBe(true);
  });

  it('imports a track into the project that is open, as a new seed', async () => {
    const client = clientMock({ newProject: vi.fn(async () => opened({ bpm: null, seeds: [] })) });
    await openTrack(client);
    fireEvent.click(await screen.findByTestId('beatify-commit'));

    await waitFor(() => expect(client.save).toHaveBeenCalled());
    const [request] = (client.save as ReturnType<typeof vi.fn>).mock.calls[0];
    // Into THIS project, as a new seed — not replacing one.
    expect(request.projectId).toBe('p1');
    expect(request.seedId).toBe('');
  });

  // The first import decides the tempo; every one after it is conformed,
  // and the modal says so before anything is rendered.
  it('tells an import what tempo it is joining', async () => {
    const client = clientMock({
      projects: vi.fn(async () => [project()]),
      analyze: vi.fn(async () => analysis({ grid: { ...GRID, bpm: 132, period: 60 / 132 } })),
    });
    render(<BeatifyView client={client} library={libraryMock()} clips={clipsMock()} />);
    fireEvent.click(await screen.findByTestId('beatify-project-open-p1'));
    fireEvent.click(await screen.findByTestId('beatify-import-track'));
    await chooseTrack();

    const note = await screen.findByTestId('beatify-conform');
    expect(note.textContent).toContain('132.00 BPM');
    expect(note.textContent).toContain("project's 120.00");
  });

  it('does not tell the FIRST import it is joining anything', async () => {
    const client = clientMock();
    await openTrack(client);
    await screen.findByTestId('beatify-quality');
    expect(screen.queryByTestId('beatify-conform')).toBeNull();
  });

  // A project is a place to work, so it gets a name of its own — not the
  // title of whatever happened to be imported into it first.
  it('offers the name for typing the moment a project is made', async () => {
    const client = clientMock({
      newProject: vi.fn(async () => opened({ name: 'project 1', bpm: null, seeds: [] })),
      renameProject: vi.fn(async () => [project({ name: 'Warehouse' })]),
    });
    render(<BeatifyView client={client} library={libraryMock()} clips={clipsMock()} />);
    fireEvent.click(await screen.findByTestId('beatify-new-project'));

    const box = (await screen.findByTestId('beatify-project-name-input')) as HTMLInputElement;
    expect(box.value).toBe('project 1');
    fireEvent.change(box, { target: { value: 'Warehouse' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(client.renameProject).toHaveBeenCalledWith('p1', 'Warehouse'));
    expect((await screen.findByTestId('beatify-open-project')).textContent).toContain('Warehouse');
  });

  it('renames the open project from its own header, shelf and all', async () => {
    const client = clientMock({
      projects: vi.fn(async () => [project()]),
      renameProject: vi.fn(async () => [project({ name: 'Warehouse' })]),
    });
    await openProject(client);
    fireEvent.click(screen.getByTestId('beatify-open-project'));

    const box = screen.getByTestId('beatify-project-name-input') as HTMLInputElement;
    expect(box.value).toBe('Live Set A');
    fireEvent.change(box, { target: { value: 'Warehouse' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(client.renameProject).toHaveBeenCalledWith('p1', 'Warehouse'));
    expect(screen.getByTestId('beatify-open-project').textContent).toContain('Warehouse');
    // The shelf is the same project seen from outside: it agrees.
    fireEvent.click(screen.getByTestId('beatify-close-project'));
    expect(await screen.findByText('Warehouse')).toBeTruthy();
  });

  it('keeps the name it had when the typing is abandoned', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    fireEvent.click(screen.getByTestId('beatify-open-project'));
    const box = screen.getByTestId('beatify-project-name-input');
    fireEvent.change(box, { target: { value: 'Warehouse' } });
    fireEvent.keyDown(box, { key: 'Escape' });

    expect(client.renameProject).not.toHaveBeenCalled();
    expect(screen.getByTestId('beatify-open-project').textContent).toContain('Live Set A');
  });

  it('will not let a project be left with no name at all', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    fireEvent.click(screen.getByTestId('beatify-open-project'));
    const box = screen.getByTestId('beatify-project-name-input');
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.blur(box);

    expect(client.renameProject).not.toHaveBeenCalled();
    expect(screen.getByTestId('beatify-open-project').textContent).toContain('Live Set A');
  });

  it('re-tempos the whole project from the BPM box, leaving clips alone', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    const box = screen.getByTestId('beatify-project-bpm');
    fireEvent.change(box, { target: { value: '128' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() =>
      expect(client.setProjectBpm).toHaveBeenCalledWith('p1', 128, expect.any(Number)),
    );
    // The box now reads 128 and every seed is re-rendered: no banner
    // announces what the page is already showing.
    await waitFor(() =>
      expect((screen.getByTestId('beatify-project-bpm') as HTMLInputElement).value).toBe('128'),
    );
    expect(screen.queryByTestId('beatify-status')).toBeNull();
  });

  it('re-tempos without throwing away the clip on the bench', async () => {
    const seed = beatified();
    const client = clientMock({
      projects: vi.fn(async () => [project()]),
      setProjectBpm: vi.fn(async (_id: string, bpm: number) =>
        opened({
          bpm,
          seeds: [
            { ...seed, record: { ...seed.record, grid: { ...GRID, bpm, period: 60 / bpm } } },
          ],
        }),
      ),
    });
    await openProject(client);
    const grid = await screen.findByTestId('beatify-clip-grid');

    const box = screen.getByTestId('beatify-project-bpm');
    fireEvent.change(box, { target: { value: '128' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(client.setProjectBpm).toHaveBeenCalled());

    // THE SAME NODE. The builder is handed the new tempo, not torn down
    // and rebuilt — a rebuild takes the half-built clip with it, and the
    // clip is the work.
    expect(screen.getByTestId('beatify-clip-grid')).toBe(grid);
  });

  it('refuses a tempo that is not a tempo, by springing back to the one it has', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    const box = screen.getByTestId('beatify-project-bpm') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '4' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(client.setProjectBpm).not.toHaveBeenCalled();
    // The box says no by showing the tempo the project still runs at —
    // and carries the range it will take in its own min/max.
    expect(box.value).toBe('120');
    expect(box.min).toBe(String(MIN_PROJECT_BPM));
    expect(box.max).toBe(String(MAX_PROJECT_BPM));
  });

  it('drops a seed from the project without touching the project', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    await openProject(client);
    fireEvent.click(await screen.findByTestId('beatify-seed-delete-s1'));

    await waitFor(() =>
      expect(client.deleteSeed).toHaveBeenCalledWith('p1', 's1', expect.any(Number)),
    );
    expect(client.deleteProject).not.toHaveBeenCalled();
    await screen.findByTestId('beatify-builder-empty');
  });

  it('keys the clip builder by the PROJECT, not the track', async () => {
    // Two projects of one track must not share a clip drawer.
    const client = clientMock({
      projects: vi.fn(async () => [project({ id: 'p2', name: 'Slower take' })]),
      openProject: vi.fn(async () => opened({ id: 'p2', name: 'Slower take' })),
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

  it('deletes a project only after the warning is accepted', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    render(<BeatifyView client={client} library={libraryMock()} clips={clipsMock()} />);
    fireEvent.click(await screen.findByTestId('beatify-project-delete-p1'));

    // Nothing is deleted yet — the warning is up instead.
    await screen.findByTestId('beatify-delete-warning');
    expect(client.deleteProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('beatify-delete-confirm'));
    await waitFor(() => expect(client.deleteProject).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(screen.queryByTestId('beatify-project-p1')).toBeNull());
    expect(screen.queryByTestId('beatify-delete-warning')).toBeNull();
  });

  it('cancelling the delete warning leaves the project untouched', async () => {
    const client = clientMock({ projects: vi.fn(async () => [project()]) });
    render(<BeatifyView client={client} library={libraryMock()} clips={clipsMock()} />);
    fireEvent.click(await screen.findByTestId('beatify-project-delete-p1'));
    await screen.findByTestId('beatify-delete-warning');

    fireEvent.click(screen.getByTestId('beatify-delete-cancel'));
    expect(screen.queryByTestId('beatify-delete-warning')).toBeNull();
    expect(client.deleteProject).not.toHaveBeenCalled();
    expect(screen.getByTestId('beatify-project-p1')).toBeTruthy();
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
      projects: vi.fn(async () => [project({ sourceMissing: true })]),
    });
    render(<BeatifyView client={client} library={libraryMock()} clips={clipsMock()} />);
    const note = await screen.findByTestId('beatify-project-source-missing');
    expect(note.textContent).toContain('stems need it back');
    fireEvent.click(screen.getByTestId('beatify-project-open-p1'));
    await screen.findByTestId('beatify-track-view');
  });
});
