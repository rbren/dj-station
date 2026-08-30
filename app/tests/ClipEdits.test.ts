// Clip program edit math (src/clip.ts). These pure functions are what the
// Clip page's buttons run, and they mirror the Rust renderer's splice law
// (`dj_analysis::clip`): adjacent regions overlap by the crossfade, capped
// at half of either neighbour. If either side's law changes, update both.

import { describe, expect, it } from 'vitest';
import {
  appendSource,
  beatSpan,
  composeWarp,
  cutRange,
  dropGrid,
  duplicateRange,
  emptyProgram,
  extendGrid,
  fadeIn,
  fadeOut,
  gainRange,
  gridBeatTimes,
  gridOneTimes,
  levelDbAt,
  moveRange,
  nearestBeat,
  programDuration,
  quantizeRange,
  regionSpans,
  rulerTicks,
  resizeSelection,
  reverseRange,
  selectionEdgeAt,
  setLevelPoint,
  SILENCE_DB,
  smoothWarp,
  stretchBands,
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
  // Taps at 1→3 s in three uneven gaps: average period 2/3 s → 90 BPM,
  // ideal beats at 1, 5/3, 7/3, 3.
  const TAPS = [1.0, 1.6, 2.2, 3.0];

  it('corrects every beat when the section length is 1', () => {
    const tapped = tapGrid(TAPS, 1);
    expect(tapped).not.toBeNull();
    const { warp, grid, stats } = tapped!;
    expect(grid.bpm).toBeCloseTo(90, 9);
    expect(grid.phase).toBe(1);
    expect(grid.beats).toBe(4);
    // Every tap is a warp anchor pinned to the ideal grid…
    expect(warp.map(([from]) => from)).toEqual(TAPS);
    expect(warp[1][1]).toBeCloseTo(1 + 2 / 3, 9);
    expect(warp[2][1]).toBeCloseTo(1 + 4 / 3, 9);
    // …so the actual beats ARE the ideal ones: zero flam, and the
    // stretch is per-gap (the 0.8 s gap squeezed to 2/3 s is the worst).
    grid.times.forEach((t, i) => expect(t).toBeCloseTo(1 + (i * 2) / 3, 9));
    expect(stats.maxFlamSecs).toBeCloseTo(0, 9);
    expect(stats.maxStretch).toBeCloseTo(Math.abs(2 / 3 / 0.8 - 1), 9);

    // The warp map is identity outside the tapped span and piecewise
    // linear inside; the inverse takes it back.
    expect(warpTime(warp, 0.5)).toBe(0.5);
    expect(warpTime(warp, 9)).toBeCloseTo(9, 9);
    expect(warpTime(warp, 1.6)).toBeCloseTo(1 + 2 / 3, 9);
    expect(warpSource(warp, warpTime(warp, 1.9))).toBeCloseTo(1.9, 9);
  });

  it('keeps the tapped feel inside a longer correction section', () => {
    // At the default section length the whole run is ONE section: only
    // the first and last taps are pinned — and those two DEFINE the
    // average, so nothing stretches at all. The beats between keep their
    // tapped positions; their offset from the ideal grid is the flam.
    const tapped = tapGrid(TAPS)!;
    expect(tapped.warp).toEqual([
      [1, 1],
      [3, 3],
    ]);
    expect(tapped.grid.times).toEqual(TAPS);
    expect(tapped.stats.maxStretch).toBeCloseTo(0, 9);
    expect(tapped.stats.maxFlamSecs).toBeCloseTo(Math.abs(2.2 - (1 + 4 / 3)), 9);
  });

  it('pins every Nth beat and adjusts the ones between', () => {
    // Section length 2 on taps 1, 1.5, 2.2, 3: anchors at taps 0, 2, 3.
    const tapped = tapGrid([1, 1.5, 2.2, 3], 2)!;
    expect(tapped.warp.map(([from]) => from)).toEqual([1, 2.2, 3]);
    expect(tapped.warp[1][1]).toBeCloseTo(1 + 4 / 3, 9);
    // The unpinned second tap moves WITH its section's stretch — to
    // 1.5556 s, not to its ideal 1.6667 s slot: 0.111 s of flam kept.
    expect(tapped.grid.times[1]).toBeCloseTo(1 + 0.5 * (4 / 3 / 1.2), 9);
    expect(tapped.stats.maxFlamSecs).toBeCloseTo(1 + 2 / 3 - 1.5555555555555556, 6);
    // Section stretches: 1.2 s → 4/3 s, then 0.8 s → 2/3 s.
    const bands = stretchBands(tapped.warp);
    expect(bands).toHaveLength(2);
    expect(bands[0].ratio).toBeCloseTo(4 / 3 / 1.2, 9);
    expect(bands[1].ratio).toBeCloseTo(2 / 3 / 0.8, 9);
    expect(tapped.stats.maxStretch).toBeCloseTo(Math.abs(2 / 3 / 0.8 - 1), 9);
  });

  it('smooths the stretch inside a section without moving its anchors', () => {
    // Two sections correcting opposite ways (1.2 s → 4/3 s, then 0.8 s →
    // 2/3 s): unsmoothed the rate STEPS at the 2.2 s anchor, which is the
    // click the smoothing softens. Twin: `smooth_warp` in
    // `dj_analysis::clip` (tests/clip_edit.rs).
    const warp = tapGrid([1, 1.5, 2.2, 3], 2)!.warp;
    expect(smoothWarp(warp, 0)).toBe(warp);
    expect(smoothWarp(warp, 1).length).toBeGreaterThan(warp.length);

    for (const s of [0, 0.3, 1, 2]) {
      for (const [from, to] of warp) expect(warpTime(warp, from, s)).toBeCloseTo(to, 9);
      // Nothing outside the anchors moves either.
      expect(warpTime(warp, 0.5, s)).toBe(0.5);
      expect(warpTime(warp, 4, s)).toBeCloseTo(warpTime(warp, 4, 0), 9);
      // Still invertible.
      expect(warpSource(warp, warpTime(warp, 1.9, s), s)).toBeCloseTo(1.9, 6);
    }

    // Eased, a section stretches least at its edges and most in its
    // middle — so the first quarter of the slowed section lags the
    // uniform stretch and the last quarter runs ahead of it.
    expect(warpTime(warp, 1.3, 1)).toBeLessThan(warpTime(warp, 1.3, 0));
    expect(warpTime(warp, 1.9, 1)).toBeGreaterThan(warpTime(warp, 1.9, 0));

    // What it buys: the two sections' rates meet at the anchor between
    // them instead of jumping 1.111 → 0.833.
    const rate = (t: number, s: number) =>
      (warpTime(warp, t + 1e-4, s) - warpTime(warp, t, s)) / 1e-4;
    expect(rate(2.19, 0)).toBeCloseTo(4 / 3 / 1.2, 3);
    expect(rate(2.2, 0)).toBeCloseTo(2 / 3 / 0.8, 3);
    expect(Math.abs(rate(2.19, 1) - rate(2.2, 1))).toBeLessThan(0.05);
  });

  it('moves the beats between anchors with the smoothed rate', () => {
    // The unpinned beat sits where the eased rate carries it, not where
    // the uniform stretch did; the anchors are untouched either way.
    const hard = tapGrid([1, 1.5, 2.2, 3], 2, 0)!;
    const eased = tapGrid([1, 1.5, 2.2, 3], 2, 0.5)!;
    expect(eased.warp).toEqual(hard.warp);
    expect(eased.grid.times[0]).toBeCloseTo(hard.grid.times[0], 9);
    expect(eased.grid.times[2]).toBeCloseTo(hard.grid.times[2], 9);
    expect(eased.grid.times[3]).toBeCloseTo(hard.grid.times[3], 9);
    expect(eased.grid.times[1]).toBeLessThan(hard.grid.times[1]);
    // The section wash still reports the whole section's stretch: the
    // ease redistributes it, it does not change it.
    expect(stretchBands(eased.warp)).toEqual(stretchBands(hard.warp));
  });

  it('reports averages beside the maxima, and the hand against the grid', () => {
    // Flam and stretch both read max/average: one bad section and a
    // uniformly bad grid look the same otherwise.
    const one = tapGrid(TAPS, 1)!;
    expect(one.stats.avgFlamSecs).toBeCloseTo(0, 9);
    const ratios = [2 / 3 / 0.6, 2 / 3 / 0.6, 2 / 3 / 0.8];
    expect(one.stats.avgStretch).toBeCloseTo(
      ratios.reduce((a, r) => a + Math.abs(r - 1), 0) / 3,
      9,
    );
    const four = tapGrid(TAPS)!;
    // One section: the two inner taps carry all the flam, over 4 beats.
    expect(four.stats.avgFlamSecs).toBeCloseTo(
      (Math.abs(1.6 - (1 + 2 / 3)) + Math.abs(2.2 - (1 + 4 / 3))) / 4,
      9,
    );

    // TAP MISS is the third figure: the grid is the tracker's five beats
    // at 120 BPM, and the hand hit three of them up to 100 ms out. It is
    // zero when the taps ARE the grid (nothing measured them).
    const heard = tapGrid([1.0, 1.5, 2.0, 2.5, 3.0], 4, 0, [1.05, 2.1, 2.95])!;
    expect(heard.stats.maxMissSecs).toBeCloseTo(0.1, 9);
    expect(heard.stats.avgMissSecs).toBeCloseTo((0.05 + 0.1 + 0.05) / 3, 9);
    expect([heard.stats.beats, heard.stats.taps]).toEqual([5, 3]);
    expect(four.stats.maxMissSecs).toBe(0);
  });

  it('flags the one on the beat its nearest tap made, adding no beat', () => {
    // The tracker heard five beats at 120 BPM; the hand tapped three of
    // them and marked a one 250 ms after the 2.1 s tap — nearer the
    // 2.5 s beat than the 2.0 s one, but the TAP is what it belongs to.
    const heard = tapGrid([1.0, 1.5, 2.0, 2.5, 3.0], 4, 0, [1.05, 2.1, 2.95], [2.35])!;
    expect(heard.grid.times).toHaveLength(5);
    expect(heard.grid.ones).toEqual([2]);
    // Two ones on the same beat are one mark; a run with none says so by
    // carrying no field at all (every grid tapped before ones existed).
    expect(tapGrid([1.0, 1.5, 2.0], 4, 0, [1.0, 2.0], [1.02, 1.04])!.grid.ones).toEqual([0]);
    expect(tapGrid([1.0, 1.5, 2.0], 4, 0, [1.0, 2.0])!.grid.ones).toBeUndefined();
  });

  it('ignores key bounce and refuses to build a grid from one tap', () => {
    expect(tapGrid([2.0], 1)).toBeNull();
    expect(tapGrid([2.0, 2.01], 1)).toBeNull();
    // The bounced repeat collapses; the honest taps still count.
    const tapped = tapGrid([1.0, 1.001, 2.0, 3.0], 1);
    expect(tapped!.grid.beats).toBe(3);
    expect(tapped!.grid.bpm).toBeCloseTo(60, 9);
  });

  it('composes a re-tap over an existing warp exactly', () => {
    const first = tapGrid([1.0, 1.5, 3.0], 1)!.warp;
    const second = tapGrid([4.0, 4.5, 6.0], 1)!.warp;
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

  it('dropGrid clears the warp and grid and is a no-op without one', () => {
    const p = base();
    expect(dropGrid(p)).toBe(p);
    const tapped: ClipProgram = {
      ...p,
      warp: [
        [1, 1],
        [2, 2.1],
      ],
      beat_grid: { bpm: 60, period: 1, phase: 1, beats: 2, times: [1, 2.1] },
    };
    const dropped = dropGrid(tapped);
    expect(dropped.warp).toEqual([]);
    expect(dropped.beat_grid).toBeNull();
    // The rest of the edit is untouched.
    expect(dropped.regions).toBe(tapped.regions);
  });
});

describe('the grid covers only what was tapped (or extended)', () => {
  // The perfect grid of the taps above: beats at 1, 5/3, 7/3, 3.
  const grid = tapGrid([1.0, 1.6, 2.2, 3.0], 1)!.grid;

  it('draws beats inside the covered span only, thinned when dense', () => {
    expect(gridBeatTimes(grid, 0, 10)).toHaveLength(4);
    expect(gridBeatTimes(grid, 0, 2)).toEqual([1, grid.times[1]]);
    const dense = tapGrid(
      Array.from({ length: 100 }, (_, i) => i * 0.5),
      1,
    )!.grid;
    expect(gridBeatTimes(dense, 0, 60, 30).length).toBeLessThanOrEqual(30);
  });

  it('quantizes ends inside the coverage outward, and frees ends beyond it', () => {
    expect(quantizeRange(grid, { start: 1.7, end: 2.2 }, 10)).toEqual({
      start: grid.times[1],
      end: grid.times[2],
    });
    // The end past the last beat stays where the hand put it…
    const half = quantizeRange(grid, { start: 2.5, end: 5 }, 10);
    expect(half.start).toBeCloseTo(grid.times[2], 9);
    expect(half.end).toBe(5);
    // …and a selection entirely outside the grid is untouched.
    expect(quantizeRange(grid, { start: 4, end: 6 }, 10)).toEqual({ start: 4, end: 6 });
    // A click-sized sweep inside still selects one whole beat.
    const beat = quantizeRange(grid, { start: 2.0, end: 2.0 }, 10);
    expect(beat.start).toBeCloseTo(grid.times[1], 9);
    expect(beat.end).toBeCloseTo(grid.times[2], 9);
  });

  it('snaps to the nearest beat inside, and to nothing outside', () => {
    expect(nearestBeat(grid, 1.7)).toBeCloseTo(grid.times[1], 9);
    expect(nearestBeat(grid, 0.9)).toBe(1);
    expect(nearestBeat(grid, 5)).toBe(5);
    expect(nearestBeat(grid, 0.2)).toBe(0.2);
  });

  it('counts the beats a selection covers, fractionally off the grid', () => {
    expect(beatSpan(grid, 1, 3)).toBeCloseTo(3, 9);
    expect(beatSpan(grid, grid.times[1], 3)).toBeCloseTo(2, 9);
    expect(beatSpan(grid, 1, (1 + grid.times[1]) / 2)).toBeCloseTo(0.5, 9);
    // Beyond the coverage it counts at the ideal period.
    expect(beatSpan(grid, 3, 3 + 2 / 3)).toBeCloseTo(1, 9);
  });

  it('draws the ones over the covered span, unthinned', () => {
    const marked = tapGrid([1.0, 1.6, 2.2, 3.0], 1, 0, [1.0, 1.6, 2.2, 3.0], [2.2])!.grid;
    expect(gridOneTimes(marked, 0, 10)).toEqual([marked.times[2]]);
    expect(gridOneTimes(marked, 0, 2)).toEqual([]);
    expect(gridOneTimes(grid, 0, 10)).toEqual([]);
  });

  it('carries the ones through an extension, dropping one stepped over', () => {
    const marked = tapGrid([1.0, 1.6, 2.2, 3.0], 1, 0, [1.0, 1.6, 2.2, 3.0], [1.0, 2.2])!.grid;
    expect(marked.ones).toEqual([0, 2]);
    // A beat added at the BACK renumbers every one of them…
    expect(extendGrid(marked, 'back', 1, 10)!.ones).toEqual([1, 3]);
    // …one added at the front leaves them alone…
    expect(extendGrid(marked, 'fwd', 1, 10)!.ones).toEqual([0, 2]);
    // …and a beat dropped from the back takes the mark on it with it.
    expect(extendGrid(marked, 'back', -1, 10)!.ones).toEqual([1]);
  });

  it('extends and shrinks a beat at a time, clamped to the clip', () => {
    const fwd = extendGrid(grid, 'fwd', 1, 10)!;
    expect(fwd.times[fwd.times.length - 1]).toBeCloseTo(3 + 2 / 3, 9);
    expect(fwd.beats).toBe(5);
    const back = extendGrid(grid, 'back', 1, 10)!;
    expect(back.times[0]).toBeCloseTo(1 / 3, 9);
    expect(back.phase).toBeCloseTo(1 / 3, 9);
    // A second step back would land before 0: nowhere to go.
    expect(extendGrid(back, 'back', 1, 10)).toBeNull();
    // Forward past the clip's end: nowhere to go either.
    expect(extendGrid(grid, 'fwd', 1, 3.2)).toBeNull();
    // Shrinking drops the outermost beat, but never below two.
    const shrunk = extendGrid(grid, 'fwd', -1, 10)!;
    expect(shrunk.times).toHaveLength(3);
    const two = extendGrid(shrunk, 'back', -1, 10)!;
    expect(extendGrid(two, 'fwd', -1, 10)).toBeNull();
  });
});
