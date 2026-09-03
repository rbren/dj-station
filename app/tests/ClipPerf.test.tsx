// Clip page performance: a LONG track on the editor — ten minutes of
// audio, a quarter of a million peak buckets, a selection dragged across
// it and an automation lane filled with breakpoints.
//
// The Clip page is the surface whose cost is set by the MATERIAL rather
// than by the arrangement: every waveform it draws is a pass over the
// source peaks, and the picture is redrawn on every edit. Two stages
// carry that and both are instrumented (src/perf.ts):
//   `clip.programPeaks`  — cutting the source peaks to the current edit;
//   `waveform.peaksPath` — turning peaks into an SVG polygon.
// The fixtures are generated here, so nothing large is committed.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClipView, __clipRenderCount } from '../src/components/ClipView';
import type { ClipClientApi, ClipSource } from '../src/clip';
import type { LibraryClientApi, Track } from '../src/library';
import { bench, expectSubQuadratic, expectWithinBudget, heavy, phaseCost } from './perfHarness';

/** A ten-minute track — a whole DJ set's worth of one file. */
const DURATION = heavy(600, 1800);
/** Peak buckets the source arrives with: the analysis cache holds a few
 *  hundred per second, so a long track is a big array. */
const PEAKS = heavy(240_000, 720_000);
/** Mounting the editor over a fixture this size, several times over. */
const TIMEOUT = heavy(120_000, 300_000);

function track(): Track {
  return {
    id: 1,
    title: 'The Long One',
    artist: 'Fixture',
    album: '',
    file_path: '/data/long.wav',
    content_hash: 'long',
    format: 'wav',
    duration_secs: DURATION,
    sample_rate: 48000,
    channels: 2,
    source: 'watch',
    source_ref: '',
    license: { kind: 'unknown', name: '', url: '', attribution: '' },
    analysis_status: 'done',
    bpm: 124,
    musical_key: 'Am',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as Track;
}

/** Deterministic peaks with real structure (a kick every beat under a
 *  slow swell), so the waveform builder takes its ordinary path rather
 *  than a degenerate flat one. */
function peaks(n: number): number[] {
  return Array.from({ length: n }, (_, i) => {
    const beat = i % 96 < 6 ? 1 : 0.35;
    return Math.min(1, beat * (0.6 + 0.4 * Math.sin(i / 5000)));
  });
}

function source(n: number): ClipSource {
  return {
    track_id: 1,
    stems: [],
    title: 'The Long One',
    artist: 'Fixture',
    duration_secs: DURATION,
    sample_rate: 48000,
    channels: 2,
    peaks: peaks(n),
  };
}

function libraryMock(): LibraryClientApi {
  return {
    tracks: vi.fn(async () => [track()]),
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

/** The backend with NO rendered preview: the page then draws the source
 *  peaks cut to the edit client-side, which is the path under test (and
 *  the one a user sees for as long as a render of ten minutes takes). */
function clipMock(n: number): ClipClientApi {
  const src = source(n);
  return {
    loadSource: vi.fn(async () => src),
    renderPreview: vi.fn(async () => null),
    previewAudio: vi.fn(async () => null),
    detectBeats: vi.fn(async () => ({ bpm: 124, beats: 1240, tracker: 'dsp' })),
    tapBeats: vi.fn(async () => ({
      times: [],
      bpm: 0,
      seed: '',
      tracker: '',
      detail: '',
      seeds: [],
    })),
    saveBeatClip: vi.fn(async () => null),
    openBeatClip: vi.fn(async () => null),
    stemBackend: vi.fn(async () => ({
      backend: 'scnet_xl_ihf',
      available: true,
      detail: null,
      stems: ['vocals', 'drums', 'bass', 'other'],
    })),
    stemStatus: vi.fn(async (trackId: number) => ({
      track_id: trackId,
      backend: 'scnet_xl_ihf',
      state: 'ready' as const,
      stage: null,
      detail: null,
      pending: 0,
    })),
  } as unknown as ClipClientApi;
}

/** Open the long track, the way a user does. */
async function openTrack(n: number) {
  render(<ClipView clip={clipMock(n)} library={libraryMock()} detectDelayMs={0} />);
  await waitFor(() => expect(screen.getByTestId('clip-track-select')).toBeTruthy());
  fireEvent.click(screen.getByTestId('clip-open-track'));
  await waitFor(() => expect(screen.getByTestId('clip-waveform')).toBeTruthy());
}

/** jsdom has no layout: give a timeline a width so time maths works. */
function sizeTimeline(testId: string, width = 1000) {
  const el = screen.getByTestId(testId);
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height: 100, right: width, bottom: 100 }) as DOMRect;
  return el;
}

afterEach(() => {
  cleanup();
});

describe('Clip page rendering performance', () => {
  it(
    'opens a long track',
    async () => {
      const stats = await bench(
        `clip open (${DURATION}s, ${PEAKS} peaks)`,
        () => openTrack(PEAKS),
        { runs: 3, teardown: () => cleanup() },
      );
      expectWithinBudget(stats, heavy(1_000, 3_000));
    },
    TIMEOUT,
  );

  it(
    'draws the waveform in time set by the peaks, not by their square',
    async () => {
      const opts = { runs: 2, teardown: () => cleanup() };
      const small = await bench(`clip open (${PEAKS / 2} peaks)`, () => openTrack(PEAKS / 2), opts);
      const big = await bench(`clip open (${PEAKS} peaks)`, () => openTrack(PEAKS), opts);

      // Both stages walk the source peaks once per picture, so twice the
      // material is twice the work — never four times it. Asserted on the
      // instrumented stages rather than on the mount, so the measurement
      // is of this repo's code and not of jsdom's.
      expectSubQuadratic(
        phaseCost(small, 'clip.programPeaks'),
        phaseCost(big, 'clip.programPeaks'),
        2,
      );
      expectSubQuadratic(
        phaseCost(small, 'waveform.peaksPath'),
        phaseCost(big, 'waveform.peaksPath'),
        2,
      );
    },
    TIMEOUT,
  );

  it(
    'drags a selection across the long track',
    async () => {
      let renders = 0;
      const stats = await bench(
        'clip selection drag (20 moves)',
        async () => {
          const wave = sizeTimeline('clip-waveform');
          __clipRenderCount.reset();
          fireEvent.mouseDown(wave, { clientX: 100 });
          for (let i = 0; i < 20; i += 1) fireEvent.mouseMove(window, { clientX: 100 + i * 20 });
          fireEvent.mouseUp(window);
          await waitFor(() => expect(screen.getByTestId('clip-sel-title')).toBeTruthy());
          renders = __clipRenderCount.get();
        },
        { runs: 3, setup: () => openTrack(PEAKS), teardown: () => cleanup() },
      );

      // A drag is 22 events, and the page redraws the selection for each
      // of them — that is the picture following the pointer. What must NOT
      // happen is a multiple of that (a render per event per subscriber),
      // which is how a drag over a long track goes to treacle.
      console.log(`[perf] selection drag: ${renders} page renders for 22 events`);
      expect(renders).toBeLessThanOrEqual(30);
      expectWithinBudget(stats, heavy(1_500, 4_000));
    },
    TIMEOUT,
  );

  it(
    'fills an automation lane with breakpoints',
    async () => {
      const stats = await bench(
        'clip automation (20 breakpoints)',
        async () => {
          const lane = sizeTimeline('clip-level-lane');
          for (let i = 0; i < 20; i += 1) {
            fireEvent.mouseDown(lane, { clientX: 100 + i * 40, clientY: 20 + (i % 5) * 8 });
            fireEvent.mouseUp(window);
          }
          await waitFor(() => expect(screen.getByTestId('clip-level-lane')).toBeTruthy());
        },
        {
          runs: 3,
          setup: async () => {
            await openTrack(PEAKS);
            const wave = sizeTimeline('clip-waveform');
            fireEvent.mouseDown(wave, { clientX: 100 });
            fireEvent.mouseMove(window, { clientX: 800 });
            fireEvent.mouseUp(window);
            await waitFor(() => expect(screen.getByTestId('clip-level-lane')).toBeTruthy());
          },
          teardown: () => cleanup(),
        },
      );

      // Every breakpoint is an edit: the program changes, so the peaks are
      // cut again and the lane and both waveforms are redrawn. Twenty of
      // them is a normal minute of work on this page.
      expectWithinBudget(stats, heavy(1_500, 4_000));
    },
    TIMEOUT,
  );
});
