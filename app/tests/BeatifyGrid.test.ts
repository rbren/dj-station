// Beatify grid math (PRD §4): beats are the atomic unit, and every line
// on screen is `phase + n × period`. These are pure functions, so they are
// pinned here without a backend — and the shared thresholds are pinned to
// the Rust source they mirror.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  anchorStride,
  beatAt,
  beatTime,
  FLAM_GREEN_MS,
  gridLines,
  gridLod,
  IN_BAND_MS,
  LEAD_IN_MAX_MS,
  loopWrapBeat,
  selectionLabel,
  snapSelection,
  snapTime,
  STRETCH_GREEN_PCT,
  type Grid,
} from '../src/beatify';

const GRID: Grid = { bpm: 120, period: 0.5, phase: 0.5, beats: 64 };

describe('grid arithmetic', () => {
  it('places beat n at phase + n * period (OUT-1)', () => {
    expect(beatTime(GRID, 0)).toBe(0.5);
    expect(beatTime(GRID, 8)).toBe(4.5);
    // OUT-1a: phase is one period, so beat 0 has audio behind it.
    expect(GRID.phase).toBe(GRID.period);
  });

  it('snaps a time to the nearest beat (TV-6)', () => {
    expect(beatAt(GRID, 2.6)).toBe(4);
    expect(beatAt(GRID, 2.74)).toBe(4);
    expect(beatAt(GRID, 2.76)).toBe(5);
    expect(snapTime(GRID, 2.76)).toBeCloseTo(3.0, 6);
    // Clamped into the track.
    expect(snapTime(GRID, -10)).toBe(0.5);
    expect(snapTime(GRID, 1e6)).toBeCloseTo(beatTime(GRID, 63), 6);
  });

  it('snaps selections OUTWARD to whole beats (TV-14)', () => {
    const sel = snapSelection(GRID, 2.6, 4.1);
    expect(sel.startBeat).toBe(4);
    expect(sel.endBeat).toBe(8);
    // A selection is never empty.
    const tiny = snapSelection(GRID, 3.0, 3.01);
    expect(tiny.endBeat).toBeGreaterThan(tiny.startBeat);
  });

  it('reads out groups only when the count divides evenly (TV-15)', () => {
    expect(selectionLabel(12, 4)).toBe('12 beats · 3 groups');
    expect(selectionLabel(4, 4)).toBe('4 beats · 1 group');
    expect(selectionLabel(13, 4)).toBe('13 beats');
    expect(selectionLabel(1, 4)).toBe('1 beat');
  });

  it('draws lines by zoom, emphasized on the ruler grouping (TV-2)', () => {
    expect(gridLod(1000, 4).step).toBe(64);
    expect(gridLod(200, 4).step).toBe(16);
    expect(gridLod(32, 4).step).toBe(4);
    expect(gridLod(8, 4).step).toBe(1);
    expect(gridLod(2, 4)).toMatchObject({ step: 1, density: true, subdivisions: true });
    // Grouping is a display preference: 7-feel gets 7-beat emphasis.
    expect(gridLod(32, 7).step).toBe(7);
    expect(gridLod(8, 7).emphasis).toBe(7);
  });

  it('lists grid line times inside the track only', () => {
    const lines = gridLines(GRID, 0, 8, 4);
    expect(lines).toEqual([0.5, 2.5, 4.5]);
    expect(gridLines(GRID, 60, 200, 1).length).toBe(4);
  });

  it('wraps a changed loop at the next group boundary (TV-25)', () => {
    expect(loopWrapBeat(5, 4)).toBe(8);
    expect(loopWrapBeat(8, 4)).toBe(12);
    expect(loopWrapBeat(0, 4)).toBe(4);
    expect(loopWrapBeat(5, 1)).toBe(6);
  });
});

describe('warp slider', () => {
  it('maps strength to anchor spacing, with no-warp at the far left', () => {
    expect(anchorStride(0)).toBe(0);
    expect(anchorStride(1)).toBe(1);
    expect(anchorStride(0.5)).toBe(8);
    expect(anchorStride(0.5)).toBeGreaterThan(anchorStride(0.9));
  });

  it('mirrors the Rust thresholds it displays against', () => {
    const src = readFileSync(
      join(__dirname, '../../crates/dj-analysis/src/beatify/grid.rs'),
      'utf8',
    );
    const num = (name: string): number => {
      const m = src.match(new RegExp(`${name}: f64 = ([0-9.]+)`));
      if (!m) throw new Error(`${name} not found in grid.rs`);
      return Number(m[1]);
    };
    const usize = (name: string): number => {
      const m = src.match(new RegExp(`${name}: usize = ([0-9]+)`));
      if (!m) throw new Error(`${name} not found in grid.rs`);
      return Number(m[1]);
    };
    expect(FLAM_GREEN_MS).toBe(num('FLAM_GREEN_MS'));
    expect(STRETCH_GREEN_PCT).toBe(num('STRETCH_GREEN_PCT'));
    expect(IN_BAND_MS).toBe(num('IN_BAND_SECS') * 1000);
    expect(LEAD_IN_MAX_MS).toBe(num('LEAD_IN_MAX') * 1000);
    // The slider's own law, recomputed from the Rust bounds.
    const min = usize('MIN_STRIDE');
    const max = usize('MAX_STRIDE');
    const expected = (s: number) =>
      Math.min(max, Math.max(min, Math.round(2 ** (Math.log2(max) * (1 - s)))));
    expect(anchorStride(1)).toBe(min);
    expect(anchorStride(0.0001)).toBe(0);
    for (const s of [0.05, 0.2, 0.4, 0.6, 0.8, 0.95]) {
      expect(anchorStride(s)).toBe(expected(s));
    }
  });
});

// The timeline snap hooks (TV-6/TV-9/TV-14): what AudioTimeline routes
// every gesture through on the Beatify track view.
import { beatSnap } from '../src/components/BeatifyTrackView';
import { viewSpan, zoomView } from '../src/components/AudioTimeline';

describe('beatSnap', () => {
  const grid = { bpm: 120, period: 0.5, phase: 0.5, beats: 64 };
  const snap = beatSnap(grid);

  it('seeks to the nearest beat unless freed (TV-6)', () => {
    expect(snap.seek(7.6, false)).toBeCloseTo(7.5);
    expect(snap.seek(7.6, true)).toBe(7.6);
    expect(snap.seek(-3, false)).toBeCloseTo(0.5); // clamped into the track
  });

  it('snaps swept selections OUTWARD to whole beats (TV-14)', () => {
    const r = snap.range({ start: 7.6, end: 9.4 });
    expect(r.start).toBeCloseTo(7.5);
    expect(r.end).toBeCloseTo(9.5);
  });

  it('slides selections by whole beats, keeping their length', () => {
    const r = snap.slide({ start: 7.7, end: 9.7 });
    expect(r.start).toBeCloseTo(7.5);
    expect(r.end - r.start).toBeCloseTo(2);
  });
});

describe('timeline zoom law', () => {
  it('zooms around a center and refuses to zoom past the whole clip', () => {
    const vp = zoomView(null, 60, 30, 0.5);
    expect(vp).toEqual({ start: 15, end: 45 });
    expect(zoomView(vp, 60, 30, 4)).toBeNull();
    expect(viewSpan(vp, 60)).toEqual({ start: 15, end: 45, len: 30 });
  });
});
