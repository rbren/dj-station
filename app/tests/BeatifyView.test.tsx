// Beatify tab: the modal auto-analyzes on open, reading corrections and
// the warp slider never re-run the tracker, Save commits into the track
// view, and a missing `beat_this` degrades to the DSP tracker with an
// install hint. The backend is mocked; the grid math is pinned by
// BeatifyGrid.test.ts and the pipeline by crates/dj-analysis.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BeatifyView } from '../src/components/BeatifyView';
import type {
  BeatifyAnalysis,
  BeatifyClientApi,
  BeatifyTrack,
  TrackerStatus,
} from '../src/beatify';
import type { LibraryClientApi, Track } from '../src/library';

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
    anchors: [0.5, 4.5],
    leadIn: 0.014,
    metricalFlag: false,
    outputSecs: 32.5,
    ...overrides,
  };
}

function beatified(): BeatifyTrack {
  return {
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
    load: vi.fn(async () => null),
    trackAudio: vi.fn(async () => new ArrayBuffer(8)),
    cancel: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:beatify');
  globalThis.URL.revokeObjectURL = vi.fn();
  window.HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  window.HTMLMediaElement.prototype.pause = vi.fn();
});

async function openTrack(client: BeatifyClientApi) {
  render(<BeatifyView client={client} library={libraryMock()} />);
  await screen.findByTestId('beatify-open');
  fireEvent.click(screen.getByTestId('beatify-open'));
  return screen.findByTestId('beatify-modal');
}

describe('Beatify tab', () => {
  it('says which tracker it has and how to install the good one', async () => {
    render(<BeatifyView client={clientMock()} library={libraryMock()} />);
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
    await screen.findByTestId('beatify-region');
    const wave = screen.getByTestId('beatify-wave');
    wave.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 100 }) as DOMRect;
    fireEvent.mouseDown(wave, { clientX: 10 });
    fireEvent.mouseMove(wave, { clientX: 50 });
    fireEvent.mouseUp(wave, { clientX: 50 });
    fireEvent.click(screen.getByTestId('beatify-rerun'));
    await waitFor(() =>
      expect(client.analyze).toHaveBeenLastCalledWith(3, [6, 30], expect.any(Number)),
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

  it('skips the modal for an already-beatified track (MOD-A31)', async () => {
    const client = clientMock({ load: vi.fn(async () => beatified()) });
    render(<BeatifyView client={client} library={libraryMock()} />);
    fireEvent.click(await screen.findByTestId('beatify-open'));
    await screen.findByTestId('beatify-track-view');
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
    const audio = screen.getByTestId('beatify-audio') as HTMLAudioElement;
    expect(audio.loop).toBe(true);
    // The window never exceeds the region being auditioned.
    const [start, secs] = (client.preview as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(start + secs).toBeLessThanOrEqual(60);
  });

  it('selects a group on double-click in the track view (TV-18)', async () => {
    const client = clientMock({ load: vi.fn(async () => beatified()) });
    render(<BeatifyView client={client} library={libraryMock()} />);
    fireEvent.click(await screen.findByTestId('beatify-open'));
    const wave = await screen.findByTestId('beatify-track-wave');
    wave.getBoundingClientRect = () => ({ left: 0, width: 320, top: 0, height: 100 }) as DOMRect;
    fireEvent.doubleClick(wave, { clientX: 100 });
    await screen.findByTestId('beatify-selection');
    expect(screen.getByTestId('beatify-readout').textContent).toContain('4 beats · 1 group');
  });

  it('seeks and selects in whole beats in the track view (TV-6/TV-14)', async () => {
    const client = clientMock({ load: vi.fn(async () => beatified()) });
    render(<BeatifyView client={client} library={libraryMock()} />);
    fireEvent.click(await screen.findByTestId('beatify-open'));
    const wave = await screen.findByTestId('beatify-track-wave');
    wave.getBoundingClientRect = () => ({ left: 0, width: 320, top: 0, height: 100 }) as DOMRect;
    fireEvent.mouseDown(wave, { clientX: 40 });
    fireEvent.mouseMove(wave, { clientX: 120 });
    fireEvent.mouseUp(wave, { clientX: 120 });
    const selection = await screen.findByTestId('beatify-selection');
    expect(selection).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('beatify-readout').textContent).toMatch(/\d+ beats/),
    );
  });
});
