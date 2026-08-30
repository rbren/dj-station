// Clip program edit math (src/clip.ts). These pure functions are what the
// Clip page's buttons run, and they mirror the Rust renderer's splice law
// (`dj_analysis::clip`): adjacent regions overlap by the crossfade, capped
// at half of either neighbour. If either side's law changes, update both.

import { describe, expect, it } from 'vitest';
import {
  addOverlay,
  appendSource,
  composeWarp,
  cutRange,
  dropGrid,
  duplicateRange,
  emptyProgram,
  fadeIn,
  fadeOut,
  gainRange,
  gridBeatTimes,
  levelDbAt,
  moveRange,
  nearestBeat,
  programDuration,
  quantizeRange,
  regionSpans,
  removeOverlay,
  rulerTicks,
  resizeSelection,
  reverseRange,
  selectionEdgeAt,
  setLevelPoint,
  SILENCE_DB,
  tapGrid,
  trimTo,
  warpSource,
  warpTime,
  type ClipProgram,
} from '../src/clip';

/** One 10 s source, no crossfade: output time == material time. */
function base(): ClipProgram {
  return { ...appendSource(emptyProgram(), 0, 10), crossfade_ms: 0 };
}

describe('clip region math', () => {
  it('lays regions out end to end, overlapping by the crossfade', () => {
    const p = { ...base(), crossfade_ms: 100 };
    const two = appendSource(p, 0, 4);
    const spans = regionSpans(two);
    expect(spans.map((s) => [s.start, s.end])).toEqual([
      [0, 10],
      [9.9, 13.9],
    ]);
    expect(programDuration(two)).toBeCloseTo(13.9, 9);
    // The overlap is capped at half the shorter neighbour.
    const tiny = appendSource({ ...base(), crossfade_ms: 1000 }, 0, 0.4);
    expect(programDuration(tiny)).toBeCloseTo(10.2, 9);
  });

  it('trims to the selection', () => {
    const p = trimTo(base(), 2, 5);
    expect(p.regions).toHaveLength(1);
    expect(p.regions[0]).toMatchObject({ start_secs: 2, end_secs: 5 });
    expect(programDuration(p)).toBeCloseTo(3, 9);
  });

  it('cuts a span and splices the remainder', () => {
    const p = cutRange(base(), 3, 7);
    expect(p.regions.map((r) => [r.start_secs, r.end_secs])).toEqual([
      [0, 3],
      [7, 10],
    ]);
    expect(programDuration(p)).toBeCloseTo(6, 9);
  });

  it('cutting the head or tail leaves one region', () => {
    expect(cutRange(base(), 0, 4).regions).toEqual([
      { source: 0, start_secs: 4, end_secs: 10, reverse: false, gain_db: 0 },
    ]);
    expect(cutRange(base(), 6, 10).regions).toEqual([
      { source: 0, start_secs: 0, end_secs: 6, reverse: false, gain_db: 0 },
    ]);
  });

  it('reverses only the selected span', () => {
    const p = reverseRange(base(), 4, 6);
    expect(p.regions).toHaveLength(3);
    expect(p.regions[1]).toMatchObject({ start_secs: 4, end_secs: 6, reverse: true });
    expect(p.regions[0].reverse).toBe(false);
    expect(p.regions[2].reverse).toBe(false);
    expect(programDuration(p)).toBeCloseTo(10, 9);
  });

  it('reverses a multi-region span back to front', () => {
    const spliced = { ...appendSource(base(), 1, 4), crossfade_ms: 0 };
    const p = reverseRange(spliced, 0, programDuration(spliced));
    expect(p.regions.map((r) => r.source)).toEqual([1, 0]);
    expect(p.regions.every((r) => r.reverse)).toBe(true);
  });

  it('splits a reversed region at the right source position', () => {
    // 0..10 reversed plays 10 -> 0, so its first 4 s are source 6..10.
    const reversed = reverseRange(base(), 0, 10);
    const p = trimTo(reversed, 0, 4);
    expect(p.regions[0]).toMatchObject({ start_secs: 6, end_secs: 10, reverse: true });
  });

  it('trims the selection gain and duplicates it', () => {
    const louder = gainRange(base(), 2, 4, 3);
    expect(louder.regions.map((r) => r.gain_db)).toEqual([0, 3, 0]);

    const doubled = duplicateRange(base(), 0, 5);
    expect(doubled.regions.map((r) => [r.start_secs, r.end_secs])).toEqual([
      [0, 5],
      [0, 5],
      [5, 10],
    ]);
    expect(programDuration(doubled)).toBeCloseTo(15, 9);
  });

  it('moves a selection later on the timeline (drag right)', () => {
    // [2,4) of a 10 s clip dragged to start at 5: the material between
    // 4 and 7 shifts left to fill the hole, the selection lands at 5.
    const p = moveRange(base(), 2, 4, 5);
    expect(p.regions.map((r) => [r.start_secs, r.end_secs])).toEqual([
      [0, 2],
      [4, 7],
      [2, 4],
      [7, 10],
    ]);
    expect(programDuration(p)).toBeCloseTo(10, 9);
  });

  it('moves a selection earlier on the timeline (drag left)', () => {
    const p = moveRange(base(), 6, 8, 1);
    expect(p.regions.map((r) => [r.start_secs, r.end_secs])).toEqual([
      [0, 1],
      [6, 8],
      [1, 6],
      [8, 10],
    ]);
  });

  it('clamps a move to the ends of the timeline', () => {
    const start = moveRange(base(), 4, 6, -3);
    expect(start.regions[0]).toMatchObject({ start_secs: 4, end_secs: 6 });
    const end = moveRange(base(), 4, 6, 99);
    expect(end.regions[end.regions.length - 1]).toMatchObject({ start_secs: 4, end_secs: 6 });
    // Moving the whole clip is a no-op shape-wise.
    expect(moveRange(base(), 0, 10, 3).regions).toEqual(base().regions);
  });

  it('overlays mix over the timeline and extend the duration', () => {
    const p = addOverlay(base(), 1, 4, 8);
    expect(p.overlays).toHaveLength(1);
    expect(p.overlays[0]).toMatchObject({ source: 1, at_secs: 8, start_secs: 0, end_secs: 4 });
    // 8 s in + 4 s of overlay outruns the 10 s base.
    expect(programDuration(p)).toBeCloseTo(12, 9);
    expect(programDuration(removeOverlay(p, 0))).toBeCloseTo(10, 9);
  });

  it('appends another source for splicing', () => {
    const p = appendSource(base(), 1, 6);
    expect(p.regions.map((r) => r.source)).toEqual([0, 1]);
    expect(programDuration(p)).toBeCloseTo(16, 9);
  });

  it('ignores empty selections', () => {
    const p = base();
    expect(cutRange(p, 3, 3)).toBe(p);
    expect(trimTo(p, 4, 4)).toBe(p);
    expect(reverseRange(emptyProgram(), 0, 1)).toEqual(emptyProgram());
  });
});

describe('clip level automation', () => {
  it('interpolates between breakpoints and holds the ends', () => {
    const points = [
      { time_secs: 1, gain_db: -12 },
      { time_secs: 3, gain_db: 0 },
    ];
    expect(levelDbAt(points, 0)).toBe(-12);
    expect(levelDbAt(points, 2)).toBeCloseTo(-6, 9);
    expect(levelDbAt(points, 9)).toBe(0);
    expect(levelDbAt([], 5)).toBe(0);
  });

  it('replaces a breakpoint at the same time instead of stacking', () => {
    let p = setLevelPoint(base(), 2, -6);
    p = setLevelPoint(p, 2, -3);
    expect(p.level).toEqual([{ time_secs: 2, gain_db: -3 }]);
  });

  it('fades in from silence and out to silence', () => {
    const p = fadeOut(fadeIn(base(), 2), 3);
    expect(p.level[0]).toEqual({ time_secs: 0, gain_db: SILENCE_DB });
    expect(p.level[1]).toEqual({ time_secs: 2, gain_db: 0 });
    expect(p.level[2]).toEqual({ time_secs: 7, gain_db: 0 });
    expect(p.level[3]).toEqual({ time_secs: 10, gain_db: SILENCE_DB });
    expect(levelDbAt(p.level, 1)).toBeCloseTo(SILENCE_DB / 2, 9);
  });
});

describe('selection edges', () => {
  const sel = { start: 3, end: 6 };

  it('grabs whichever end is within the handle radius', () => {
    expect(selectionEdgeAt(sel, 3.05, 0.1)).toBe('start');
    expect(selectionEdgeAt(sel, 5.95, 0.1)).toBe('end');
    // Between the ends, and outside them, is not a grab.
    expect(selectionEdgeAt(sel, 4.5, 0.1)).toBeNull();
    expect(selectionEdgeAt(sel, 2.5, 0.1)).toBeNull();
    expect(selectionEdgeAt(null, 3, 0.1)).toBeNull();
  });

  it('breaks a tie toward the start and ignores a zero radius', () => {
    expect(selectionEdgeAt({ start: 4, end: 6 }, 5, 1)).toBe('start');
    expect(selectionEdgeAt(sel, 3, 0)).toBeNull();
  });

  it('expands and shrinks against the anchored end', () => {
    expect(resizeSelection(sel, 'end', 9, 10)).toEqual({ start: 3, end: 9 });
    expect(resizeSelection(sel, 'end', 4, 10)).toEqual({ start: 3, end: 4 });
    expect(resizeSelection(sel, 'start', 1, 10)).toEqual({ start: 1, end: 6 });
    expect(resizeSelection(sel, 'start', 5, 10)).toEqual({ start: 5, end: 6 });
  });

  it('flips when an end is dragged past its opposite, and clamps to the clip', () => {
    expect(resizeSelection(sel, 'end', 1, 10)).toEqual({ start: 1, end: 3 });
    expect(resizeSelection(sel, 'start', 8, 10)).toEqual({ start: 6, end: 8 });
    expect(resizeSelection(sel, 'end', 99, 10)).toEqual({ start: 3, end: 10 });
    expect(resizeSelection(sel, 'start', -5, 10)).toEqual({ start: 0, end: 6 });
  });
});

describe('ruler ticks', () => {
  const majors = (from: number, to: number, target?: number) =>
    rulerTicks(from, to, target)
      .filter((t) => t.major)
      .map((t) => t.label);

  it('labels round times at a spacing the zoom warrants', () => {
    expect(majors(0, 60)).toEqual(['0:00', '0:10', '0:20', '0:30', '0:40', '0:50', '1:00']);
    // Zoomed to four seconds: half-second labels, not four one-second ones.
    expect(majors(0, 4)).toEqual([
      '0:00.0',
      '0:00.5',
      '0:01.0',
      '0:01.5',
      '0:02.0',
      '0:02.5',
      '0:03.0',
      '0:03.5',
      '0:04.0',
    ]);
  });

  it('only labels ticks that fall inside the window', () => {
    const ticks = rulerTicks(12.3, 27.8);
    expect(ticks.every((t) => t.secs >= 12.3 && t.secs <= 27.8)).toBe(true);
    expect(majors(12.3, 27.8)).toEqual(['0:14', '0:16', '0:18', '0:20', '0:22', '0:24', '0:26']);
  });

  it('subdivides between labels without labelling the minors', () => {
    const ticks = rulerTicks(0, 60);
    expect(ticks.filter((t) => !t.major).every((t) => t.label === '')).toBe(true);
    // 10 s steps are subdivided in halves.
    expect(ticks.map((t) => t.secs)).toContain(5);
    expect(ticks.map((t) => t.secs)).toContain(55);
  });

  it('keeps labels on exact times when zoomed to hundredths', () => {
    expect(majors(0.995, 1.06)).toEqual([
      '0:01.00',
      '0:01.01',
      '0:01.02',
      '0:01.03',
      '0:01.04',
      '0:01.05',
      '0:01.06',
    ]);
  });

  it('has nothing to draw for an empty or backwards window', () => {
    expect(rulerTicks(5, 5)).toEqual([]);
    expect(rulerTicks(9, 3)).toEqual([]);
    expect(rulerTicks(0, Number.NaN)).toEqual([]);
  });

  it('stops coarsening at ten minutes for a very long clip', () => {
    const labels = majors(0, 7200);
    expect(labels[0]).toBe('0:00');
    expect(labels[1]).toBe('10:00');
    expect(labels[labels.length - 1]).toBe('120:00');
  });
});

describe('beat taps', () => {
  it('builds the average grid and the warp that evens the beats out', () => {
    // 1→3 s in 3 uneven gaps: average period 2/3 s → 90 BPM. The first
    // and last taps stay put; the middle ones move onto the even grid.
    const tapped = tapGrid([1.0, 1.6, 2.2, 3.0]);
    expect(tapped).not.toBeNull();
    const { warp, grid } = tapped!;
    expect(grid.bpm).toBeCloseTo(90, 9);
    expect(grid.phase).toBe(1);
    expect(grid.beats).toBe(4);
    expect(warp.map(([from]) => from)).toEqual([1.0, 1.6, 2.2, 3.0]);
    expect(warp[1][1]).toBeCloseTo(1 + 2 / 3, 9);
    expect(warp[2][1]).toBeCloseTo(1 + 4 / 3, 9);

    // The warp map is identity outside the tapped span and piecewise
    // linear inside; the inverse takes it back.
    expect(warpTime(warp, 0.5)).toBe(0.5);
    expect(warpTime(warp, 9)).toBeCloseTo(9, 9);
    expect(warpTime(warp, 1.6)).toBeCloseTo(1 + 2 / 3, 9);
    expect(warpTime(warp, 1.3)).toBeCloseTo(1 + 1 / 3, 9);
    expect(warpSource(warp, warpTime(warp, 1.9))).toBeCloseTo(1.9, 9);
  });

  it('ignores key bounce and refuses to build a grid from one tap', () => {
    expect(tapGrid([2.0])).toBeNull();
    expect(tapGrid([2.0, 2.01])).toBeNull();
    // The bounced repeat collapses; the honest taps still count.
    const tapped = tapGrid([1.0, 1.001, 2.0, 3.0]);
    expect(tapped!.grid.beats).toBe(3);
    expect(tapped!.grid.bpm).toBeCloseTo(60, 9);
  });

  it('composes a re-tap over an existing warp exactly', () => {
    const first = tapGrid([1.0, 1.5, 3.0])!.warp;
    const second = tapGrid([4.0, 4.5, 6.0])!.warp;
    const both = composeWarp(first, second);
    for (const t of [0.5, 1.25, 2.0, 3.5, 4.2, 5.0, 7.0]) {
      expect(warpTime(both, t)).toBeCloseTo(warpTime(second, warpTime(first, t)), 9);
    }
    // Either side empty is just the other.
    expect(composeWarp([], second)).toBe(second);
    expect(composeWarp(first, [])).toBe(first);
  });

  it('stretches the program duration through the warp', () => {
    const p = base();
    // Push the last anchor later: everything after it shifts with it.
    const withWarp: ClipProgram = {
      ...p,
      warp: [
        [2, 2],
        [4, 5],
      ],
    };
    expect(programDuration(p)).toBe(10);
    expect(programDuration(withWarp)).toBe(11);
  });

  it('quantizes selections outward to whole beats, clamped to the clip', () => {
    const grid = { bpm: 60, period: 1, phase: 0.5, beats: 4 };
    expect(quantizeRange(grid, { start: 1.7, end: 3.2 }, 10)).toEqual({ start: 1.5, end: 3.5 });
    // A sliver still becomes one whole beat…
    expect(quantizeRange(grid, { start: 2.6, end: 2.9 }, 10)).toEqual({ start: 2.5, end: 3.5 });
    // …and the grid extends across the clip but never past its ends.
    expect(quantizeRange(grid, { start: 0.1, end: 9.9 }, 10)).toEqual({ start: 0, end: 10 });
    expect(nearestBeat(grid, 2.4)).toBe(2.5);
  });

  it('draws grid beats across the view, thinning as the view widens', () => {
    const grid = { bpm: 120, period: 0.5, phase: 1, beats: 4 };
    expect(gridBeatTimes(grid, 0, 2.4)).toEqual([0, 0.5, 1, 1.5, 2]);
    // Far zoomed out, only every 2^n-th beat is drawn.
    const sparse = gridBeatTimes(grid, 0, 1000, 100);
    expect(sparse.length).toBeLessThanOrEqual(100);
    expect(sparse.length).toBeGreaterThan(50);
  });

  it('dropGrid clears the warp and grid and is a no-op without one', () => {
    const p = base();
    expect(dropGrid(p)).toBe(p);
    const tapped: ClipProgram = {
      ...p,
      warp: [
        [1, 1],
        [2, 2.1],
      ],
      beat_grid: { bpm: 60, period: 1, phase: 1, beats: 2 },
    };
    const dropped = dropGrid(tapped);
    expect(dropped.warp).toEqual([]);
    expect(dropped.beat_grid).toBeNull();
    // The rest of the edit is untouched.
    expect(dropped.regions).toBe(tapped.regions);
  });
});
