// The Grid has to stay usable with a real arrangement on it — fifty-odd
// clips over a few hundred beats. That is tens of thousands of cells, so
// the thing that matters is not how fast one render is but HOW MUCH is
// re-rendered when something small changes: a playhead poll sixteen times
// a second must not touch every row, and editing one row must not touch
// the other forty-nine.
//
// These are counted, not timed. A wall-clock budget on a shared CI box
// measures the box; counting renders measures the code.
//
// The last describe in this file is the exception, and it is deliberate:
// a count cannot see an arrangement that still renders ONCE and takes a
// second doing it. Those tests time the same fixtures against
// calibration-scaled budgets with several times the measured cost in
// headroom, and prefer scaling assertions (which cancel the box out) to
// absolute ones — see tests/perfHarness.ts.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BeatClipApi, BeatClipEntry } from '../src/beatClip';
import { GridView, __pageRenderCount, __rowRenderCount } from '../src/components/GridView';
import { bench, expectWithinBudget, heavy } from './perfHarness';

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

/** Rows in the TIMED arrangement below — a real set, and on the CI perf
 *  job (`DJ_PERF_HEAVY=1`) an unreasonable one. */
const PERF_ROWS = heavy(ROWS, 100);
/** Beats in the timed arrangement. */
const PERF_BEATS = heavy(128, 384);

const CLIPS = clips(Math.max(ROWS, PERF_ROWS));

function api(): BeatClipApi {
  return {
    list: vi.fn().mockResolvedValue(CLIPS),
    load: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue([]),
    peaks: vi.fn().mockResolvedValue([]),
    gridSave: vi.fn().mockResolvedValue(undefined),
    gridLoad: vi.fn().mockResolvedValue(null),
    gridList: vi.fn().mockResolvedValue([]),
  };
}

/** A grid document: `rows` rows, each holding a few placements, over
 *  `beats` columns. */
function bigDoc(rows = ROWS, beats = BEATS): string {
  return JSON.stringify({
    version: 1,
    state: {
      rows: CLIPS.slice(0, rows).map((c, i) => ({
        id: `row${i + 1}`,
        clipId: c.clipId,
        placements: [i % 16, (i % 16) + 16],
        levels: [],
      })),
      tempo: { bpm: 120, points: [] },
      beats,
      barBeats: 4,
      loop: null,
    },
  });
}

/** Load the big arrangement through Open, the way a user would. */
async function renderBig(rows = ROWS, beats = BEATS) {
  const clipApi = api();
  (clipApi.gridList as ReturnType<typeof vi.fn>).mockResolvedValue(['big']);
  (clipApi.gridLoad as ReturnType<typeof vi.fn>).mockResolvedValue(bigDoc(rows, beats));
  render(<GridView clips={clipApi} pollMs={1000000} active />);
  await screen.findByTestId('grid-view');
  fireEvent.click(screen.getByTestId('grid-name'));
  fireEvent.click(screen.getByTestId('grid-open'));
  fireEvent.click(await screen.findByTestId('grid-open-big'));
  await waitFor(() => expect(screen.getByTestId(`grid-cells-row${rows}`)).toBeTruthy());
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

  it('leaves a SIDEWAYS flick to the scrollport instead of zooming on it', async () => {
    await renderBig();
    const ruler = screen.getByTestId('grid-ruler');

    // A trackpad swipe across the ruler is never purely horizontal.
    // Taking its stray deltaY as a zoom meant every scroll sideways
    // zoomed a little AND put the scroll back where the zoom's anchor
    // said — the grid lurching about under the pointer.
    for (let i = 0; i < 10; i += 1) fireEvent.wheel(ruler, { deltaX: -120, deltaY: -6 });
    // Shift+wheel is the same gesture with a mouse.
    fireEvent.wheel(ruler, { deltaY: -100, shiftKey: true });
    await new Promise((done) => requestAnimationFrame(() => done(null)));

    expect(screen.getByTestId('grid-zoom').textContent).toBe('100%');
  });
});

// SCROLLING SIDEWAYS is the other gesture over the whole geometry, and it
// is the one a set is read through. A few hundred beats of fifty rows is
// tens of thousands of cells; drawn whole, the webview gives up
// compositing the scroll and repaints the lot every frame, which is what
// "janky, and it jumps about" is. Only the columns on screen are in the
// DOM, rounded out to whole blocks — so what is counted here is that an
// ordinary scroll costs NOTHING, that a flick costs one pass over the
// rows rather than one per event, and that the window really does follow
// the box.
describe('Grid scroll performance', () => {
  const CELL = 22;
  /** Beats a window is snapped to — `WINDOW_BLOCK` in the view. */
  const BLOCK = 32;
  /** A wide arrangement. The row count is not what this is about, the
   *  BEAT count is; eight rows keep the first render (before the box has
   *  been measured, when the whole grid is drawn) cheap. */
  const WIDE_ROWS = 8;
  const WIDE_BEATS = 512;
  /** A scrollport 30 beats wide, which jsdom will never lay out itself. */
  const VIEW = 30 * CELL;

  /** Let everything the load set off (the peaks fetch above all) land, so
   *  what is counted next is the scroll and nothing else. */
  const settle = () => new Promise((done) => setTimeout(done, 30));
  /** One animation frame — what a coalesced scroll waits for. */
  const frame = () => new Promise((done) => requestAnimationFrame(() => done(null)));

  /** Give the scrollport a width, and a way to scroll it. jsdom has no
   *  layout, so these are the only two numbers the window is measured
   *  off — exactly the two a browser would have supplied. */
  function scrollport(width: number): (px: number) => void {
    const box = screen.getByTestId('grid-body');
    let left = 0;
    Object.defineProperty(box, 'clientWidth', { configurable: true, get: () => width });
    Object.defineProperty(box, 'scrollLeft', {
      configurable: true,
      get: () => left,
      set: (v: number) => {
        left = v;
      },
    });
    return (px: number) => {
      box.scrollLeft = px;
      fireEvent.scroll(box);
    };
  }

  it('draws only the columns the scrollport is over', async () => {
    await renderBig(WIDE_ROWS, WIDE_BEATS);
    const to = scrollport(VIEW);
    to(0);

    // At the left end: what is on screen plus a block of slack past it,
    // and nothing at all of the four hundred beats further on.
    await waitFor(() => expect(screen.queryByTestId('grid-cell-row1-300')).toBeNull());
    expect(screen.getByTestId('grid-cell-row1-0')).toBeTruthy();
    expect(screen.getByTestId(`grid-cell-row1-${2 * BLOCK - 1}`)).toBeTruthy();
    // The ruler is windowed with the rows, or the bar numbers would come
    // away from the columns they belong to.
    expect(screen.queryByTestId(`grid-ruler-${2 * BLOCK}`)).toBeNull();

    // Scrolled into the middle of the set, the middle is what is drawn.
    to(200 * CELL);
    await waitFor(() => expect(screen.getByTestId('grid-cell-row1-200')).toBeTruthy());
    expect(screen.getByTestId('grid-ruler-200')).toBeTruthy();
    expect(screen.queryByTestId('grid-cell-row1-0')).toBeNull();
    // …and so is the clip block back there, waveform and all.
    expect(screen.queryByTestId('grid-clip-row1-0')).toBeNull();
  });

  it('costs NOTHING to scroll inside the columns already drawn', async () => {
    await renderBig(WIDE_ROWS, WIDE_BEATS);
    const to = scrollport(VIEW);
    to(200 * CELL);
    // Waiting for the WINDOW, not for a column: until the box has been
    // measured the whole grid is drawn, so beat 200 is there already and
    // beat 0 going away is what says the scroll has been answered.
    await waitFor(() => expect(screen.queryByTestId('grid-cell-row1-0')).toBeNull());
    await settle();
    __rowRenderCount.reset();
    __pageRenderCount.reset();

    // Twenty events over a couple of hundred pixels: the same block, so
    // the same columns, so nothing to draw again.
    for (let i = 0; i < 20; i += 1) to(200 * CELL + i * 10);
    await frame();

    expect(__rowRenderCount.get()).toBe(0);
    // The page itself is offered the window it already has, which React
    // answers with at most one bail-out render of this component alone —
    // never a pass over the grid.
    expect(__pageRenderCount.get()).toBeLessThanOrEqual(1);
  });

  it('coalesces a flick into one pass over the rows, not one per event', async () => {
    await renderBig(WIDE_ROWS, WIDE_BEATS);
    const to = scrollport(VIEW);
    to(200 * CELL);
    // Waiting for the WINDOW, not for a column: until the box has been
    // measured the whole grid is drawn, so beat 200 is there already and
    // beat 0 going away is what says the scroll has been answered.
    await waitFor(() => expect(screen.queryByTestId('grid-cell-row1-0')).toBeNull());
    await settle();
    __rowRenderCount.reset();
    __pageRenderCount.reset();

    // A trackpad flick: thirty events between two frames, carrying the
    // view a few blocks along.
    for (let i = 0; i < 30; i += 1) to(200 * CELL + i * 100);
    await waitFor(() => expect(screen.getByTestId('grid-cell-row1-330')).toBeTruthy());

    // One measure, one window, one draw of each row — not thirty.
    expect(__pageRenderCount.get()).toBeLessThanOrEqual(2);
    expect(__rowRenderCount.get()).toBeLessThanOrEqual(WIDE_ROWS);
  });

  it('holds the window still while the playhead moves through it', async () => {
    await renderBig(WIDE_ROWS, WIDE_BEATS);
    const to = scrollport(VIEW);
    to(200 * CELL);
    // Waiting for the WINDOW, not for a column: until the box has been
    // measured the whole grid is drawn, so beat 200 is there already and
    // beat 0 going away is what says the scroll has been answered.
    await waitFor(() => expect(screen.queryByTestId('grid-cell-row1-0')).toBeNull());
    await settle();
    __rowRenderCount.reset();

    // The playhead is one overlay over the whole grid, so it moves
    // without touching the window or the rows drawn in it — the scroll
    // does not get to jump because something started playing.
    act(() => {
      screen.getByTestId('grid-play').click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(__rowRenderCount.get()).toBe(0);
    expect(screen.getByTestId('grid-cell-row1-200')).toBeTruthy();
  });
});

// TIMED, not counted — the exception this file's header explains. The
// counts above pin how MUCH of the page is re-rendered; these pin what a
// render of a big arrangement COSTS, which is the other half of "the page
// dragged at fifty clips". Budgets are calibration-scaled and carry
// several times the measured cost (tests/perfHarness.ts); the scaling
// assertion is the one that really matters, because the box cancels out
// of a ratio.
describe('Grid rendering cost', () => {
  const CELL = 22;
  /** A scrollport 30 beats wide, as in the scroll suite above. */
  const VIEW = 30 * CELL;
  /** Rows for the SCROLL benches: the beat count is what those are about,
   *  and eight rows keep the first (unwindowed) render cheap. */
  const SCROLL_ROWS = 8;
  const SCROLL_BEATS = heavy(512, 1024);
  /** Mounting a big arrangement several times over is seconds of work,
   *  well past vitest's 5 s default. */
  const TIMEOUT = heavy(120_000, 300_000);

  const settle = () => new Promise((done) => setTimeout(done, 30));

  function scrollport(width: number): (px: number) => void {
    const box = screen.getByTestId('grid-body');
    let left = 0;
    Object.defineProperty(box, 'clientWidth', { configurable: true, get: () => width });
    Object.defineProperty(box, 'scrollLeft', {
      configurable: true,
      get: () => left,
      set: (v: number) => {
        left = v;
      },
    });
    return (px: number) => {
      box.scrollLeft = px;
      fireEvent.scroll(box);
    };
  }

  it(
    'opens a big arrangement',
    async () => {
      const stats = await bench(
        `grid open ${PERF_ROWS}x${PERF_BEATS}`,
        () => renderBig(PERF_ROWS, PERF_BEATS),
        { runs: 3, teardown: () => cleanup() },
      );
      expectWithinBudget(stats, heavy(6_000, 20_000));
    },
    TIMEOUT,
  );

  it(
    'scrolls at a cost set by the WINDOW, not by the arrangement',
    async () => {
      let to: (px: number) => void = () => {};
      /** Cells left in the DOM at the end of the flick — the window. */
      let cells = 0;
      /** A flick across a few blocks, from beat 200. */
      const flick = async () => {
        for (let i = 0; i < 30; i += 1) to(200 * CELL + i * 100);
        await waitFor(() => expect(screen.getByTestId('grid-cell-row1-330')).toBeTruthy());
        cells = document.querySelectorAll('[data-testid^="grid-cell-"]').length;
      };
      const open = (beats: number) => async () => {
        await renderBig(SCROLL_ROWS, beats);
        to = scrollport(VIEW);
        to(200 * CELL);
        await waitFor(() => expect(screen.queryByTestId('grid-cell-row1-0')).toBeNull());
        await settle();
      };
      const opts = { runs: 2, teardown: () => cleanup() };
      const short = await bench(`grid flick over ${SCROLL_BEATS} beats`, flick, {
        ...opts,
        setup: open(SCROLL_BEATS),
      });
      const shortCells = cells;
      const long = await bench(`grid flick over ${SCROLL_BEATS * 2} beats`, flick, {
        ...opts,
        setup: open(SCROLL_BEATS * 2),
      });
      const longCells = cells;

      // Only the columns under the scrollport are in the DOM, so twice as
      // long an arrangement leaves the same number of cells on the page.
      // This is the COUNTED form of the claim and the gate: if the
      // windowing is lost, the whole set is in the DOM again — the state
      // the window was added to get out of — and this is ×2 exactly,
      // whatever the machine was doing at the time.
      console.log(`[perf] windowed cells: ${shortCells} at ×1 beats, ${longCells} at ×2`);
      expect(longCells).toBeLessThanOrEqual(shortCells * 1.1);

      // The wall clock says the same thing, reported rather than gated:
      // it is 30 scroll events against jsdom, so it is a useful number to
      // read next to a change and a poor thing to fail a build on.
      const grew = long.median / Math.max(short.median, 0.5);
      console.log(`[perf] flick cost at ×2 beats: ×${grew.toFixed(2)}`);
    },
    TIMEOUT,
  );

  it(
    'answers a burst of zoom events inside a frame',
    async () => {
      const stats = await bench(
        'grid zoom burst (30 wheel events)',
        async () => {
          const ruler = screen.getByTestId('grid-ruler');
          for (let i = 0; i < 30; i += 1) fireEvent.wheel(ruler, { deltaY: -10 });
          await waitFor(() => expect(screen.getByTestId('grid-zoom').textContent).toBe('152%'));
        },
        { runs: 3, setup: () => renderBig(PERF_ROWS, PERF_BEATS), teardown: () => cleanup() },
      );

      // The zoom is a CSS variable and the burst is coalesced into one
      // frame (both counted above), so what is left is one render of the
      // page chrome — small, and roughly constant whatever is laid out
      // below it.
      expectWithinBudget(stats, heavy(1_200, 3_000));
    },
    TIMEOUT,
  );
});
