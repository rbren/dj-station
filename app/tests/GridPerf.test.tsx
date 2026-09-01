// The Grid has to stay usable with a real arrangement on it — fifty-odd
// clips over a few hundred beats. That is tens of thousands of cells, so
// the thing that matters is not how fast one render is but HOW MUCH is
// re-rendered when something small changes: a playhead poll sixteen times
// a second must not touch every row, and editing one row must not touch
// the other forty-nine.
//
// These are counted, not timed. A wall-clock budget on a shared CI box
// measures the box; counting renders measures the code.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BeatClipApi, BeatClipEntry } from '../src/beatClip';
import { GridView, __pageRenderCount, __rowRenderCount } from '../src/components/GridView';

const ROWS = 50;
// The ROW COUNT is what these tests are about, so it stays at a real
// fifty. The beat count is deliberately modest: every test here renders
// ROWS x BEATS cells, and on a four-core box a wider grid just starves
// the suites running alongside it. Widening it proves nothing extra —
// what is counted is renders per row, which does not depend on BEATS.
const BEATS = 32;

function clips(n: number): BeatClipEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    clipId: `c${i}`,
    name: `clip ${i}`,
    bpm: 120,
    beats: 4,
    stems: ['drums'],
    editable: true,
    ones: [0],
    sources: [{ trackHash: `h${i % 7}`, title: `Track ${i % 7}`, artist: 'A' }],
  }));
}

const CLIPS = clips(ROWS);

function api(): BeatClipApi {
  return {
    list: vi.fn().mockResolvedValue(CLIPS),
    load: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue([]),
    audio: vi.fn().mockResolvedValue(null),
    peaks: vi.fn().mockResolvedValue([]),
    gridSave: vi.fn().mockResolvedValue(undefined),
    gridLoad: vi.fn().mockResolvedValue(null),
    gridList: vi.fn().mockResolvedValue([]),
  };
}

/** A grid document with `ROWS` rows, each holding a few placements. */
function bigDoc(): string {
  return JSON.stringify({
    version: 1,
    state: {
      rows: CLIPS.map((c, i) => ({
        id: `row${i + 1}`,
        clipId: c.clipId,
        placements: [i % 16, (i % 16) + 16],
        levels: [],
      })),
      tempo: { bpm: 120, points: [] },
      beats: BEATS,
      barBeats: 4,
      loop: null,
    },
  });
}

/** Load the big arrangement through Open, the way a user would. */
async function renderBig() {
  const clipApi = api();
  (clipApi.gridList as ReturnType<typeof vi.fn>).mockResolvedValue(['big']);
  (clipApi.gridLoad as ReturnType<typeof vi.fn>).mockResolvedValue(bigDoc());
  render(<GridView clips={clipApi} pollMs={1000000} active />);
  await screen.findByTestId('grid-view');
  fireEvent.click(screen.getByTestId('grid-name'));
  fireEvent.click(screen.getByTestId('grid-open'));
  fireEvent.click(await screen.findByTestId('grid-open-big'));
  await waitFor(() => expect(screen.getByTestId('grid-cells-row50')).toBeTruthy());
}

beforeEach(() => {
  __rowRenderCount.reset();
  __pageRenderCount.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Grid performance', () => {
  it('renders a fifty-row arrangement', async () => {
    await renderBig();
    expect(screen.getAllByTestId(/^grid-cells-row/).length).toBe(ROWS);
  });

  it('does NOT re-render the rows when the playhead moves', async () => {
    await renderBig();
    __rowRenderCount.reset();

    // The playhead is drawn as one overlay across the whole grid, so a
    // poll must cost one render of that overlay and nothing per row.
    // This is the thing that made the page drag: at sixteen polls a
    // second, fifty rows of cells were being reconciled each time.
    act(() => {
      screen.getByTestId('grid-play').click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(__rowRenderCount.get()).toBe(0);
  });

  it('re-renders ONE row when that row is edited', async () => {
    await renderBig();
    __rowRenderCount.reset();

    fireEvent.click(screen.getByTestId('grid-cell-row3-20'));
    await waitFor(() => expect(__rowRenderCount.get()).toBeGreaterThan(0));

    // Only the row that changed: the other forty-nine are memoised on
    // their own data and must not be touched.
    expect(__rowRenderCount.get()).toBeLessThanOrEqual(2);
  });

  it('re-renders ONE row when its level line is drawn', async () => {
    await renderBig();
    const row = screen.getByTestId('grid-cells-row7');
    row.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: BEATS * 22, height: 26 }) as DOMRect;
    __rowRenderCount.reset();

    fireEvent.mouseDown(row, { metaKey: true, clientX: 220, clientY: 6 });
    await waitFor(() => expect(__rowRenderCount.get()).toBeGreaterThan(0));

    expect(__rowRenderCount.get()).toBeLessThanOrEqual(2);
  });

  it('re-renders every row when the grid-wide shape changes', async () => {
    await renderBig();
    __rowRenderCount.reset();

    // The honest opposite case: the bar length is drawn on every cell, so
    // changing it SHOULD redraw every row. The memo must not be so
    // aggressive that it holds a stale layout.
    fireEvent.change(screen.getByTestId('grid-bar-beats'), { target: { value: '3' } });
    await waitFor(() => expect(__rowRenderCount.get()).toBeGreaterThanOrEqual(ROWS));
  });
});

// ZOOMING is the gesture that used to make the page stutter: it changes
// the geometry of every one of the ROWS x BEATS cells, and it arrives as
// a stream of wheel events rather than as one click of a button. Two
// things keep it smooth, and both are counted here rather than timed:
// the geometry is a CSS variable (so React re-renders nothing below the
// container), and a burst of events is coalesced into one animation
// frame (so a flick of the wheel costs one render, not thirty).
describe('Grid zoom performance', () => {
  it('does NOT re-render a single row when the grid is zoomed', async () => {
    await renderBig();
    __rowRenderCount.reset();

    fireEvent.wheel(screen.getByTestId('grid-ruler'), { deltaY: -100 });
    await waitFor(() => expect(screen.getByTestId('grid-zoom').textContent).toBe('115%'));

    // Every cell is a beat wide in `--grid-cell-w`, so the browser lays
    // the new geometry out and React touches none of it.
    expect(__rowRenderCount.get()).toBe(0);
  });

  it('coalesces a burst of wheel events into one render per frame', async () => {
    await renderBig();
    const ruler = screen.getByTestId('grid-ruler');
    __pageRenderCount.reset();

    // A trackpad flick: thirty events between two frames. One state
    // update per event is what made the zoom feel clicky.
    for (let i = 0; i < 30; i += 1) fireEvent.wheel(ruler, { deltaY: -10 });
    await waitFor(() => expect(screen.getByTestId('grid-zoom').textContent).not.toBe('100%'));

    expect(__pageRenderCount.get()).toBeLessThanOrEqual(2);
    // …and the whole burst was applied, not just the event that got in
    // first: thirty tenth-notches is three notches of zoom.
    expect(screen.getByTestId('grid-zoom').textContent).toBe('152%');
  });

  it('keeps the clip blocks off the zoom too, waveforms and all', async () => {
    await renderBig();
    const block = screen.getByTestId('grid-clip-row1-0');
    fireEvent.wheel(screen.getByTestId('grid-ruler'), { deltaY: -100 });
    await waitFor(() => expect(screen.getByTestId('grid-zoom').textContent).toBe('115%'));

    // The same element, with the same declaration on it: nothing about a
    // placed clip — its block, its waveform, its ones — is re-rendered by
    // a zoom.
    expect(screen.getByTestId('grid-clip-row1-0')).toBe(block);
    expect(block.style.width).toBe('calc(var(--grid-cell-w) * 4)');
  });
});
