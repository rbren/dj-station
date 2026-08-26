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
  beatsBetween,
  beatTime,
  cutClearanceMs,
  FLAM_GREEN_MS,
  gridLines,
  gridLod,
  IN_BAND_MS,
  LEAD_IN_MAX_MS,
  loopWrapBeat,
  SCOPE_PRE_MAX_MS,
  SCOPE_PRE_MS,
  scopePreMs,
  selectionLabel,
  snapSelection,
  snapTime,
  STRETCH_GREEN_PCT,
  type BeatifyScope,
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

  // A ⌘-drag frees the ends of the selection from the grid, so a count
  // of beats is no longer always whole. Groups are a fact about whole
  // beats and go quiet for a fraction, which is itself the signal that
  // this selection is off the grid.
  it('counts a freed selection in fractions of a beat', () => {
    expect(selectionLabel(3.5, 4)).toBe('3.5 beats');
    expect(selectionLabel(8.25, 4)).toBe('8.25 beats');
    // Float noise is not a fraction: 4 beats swept on the grid reads as 4.
    expect(selectionLabel(4.0000001, 4)).toBe('4 beats · 1 group');
    expect(selectionLabel(0.5, 4)).toBe('0.5 beats');
  });

  // What the source pane hands to the clip editor once the ends are free:
  // where the cut REALLY starts and ends, in beats, unrounded.
  it('measures a selection in beats without snapping it', () => {
    expect(beatsBetween(GRID, 2.6, 4.1)).toMatchObject({ startBeat: 4.2, endBeat: 7.2 });
    // Clamped into the track at both ends.
    expect(beatsBetween(GRID, -3, 0.5).startBeat).toBe(0);
    expect(beatsBetween(GRID, 100, 200).endBeat).toBe(GRID.beats - 1);
    // A fifth of a beat is a cut; a millionth of one is a slip of the
    // hand, and measures as nothing.
    expect(beatsBetween(GRID, 3, 3.1)).toMatchObject({ startBeat: 5, endBeat: 5.2 });
    const slip = beatsBetween(GRID, 3, 3.000001);
    expect(slip.endBeat).toBe(slip.startBeat);
    // On the grid it agrees with the snapping version, to the beat.
    expect(beatsBetween(GRID, 2.5, 4.5)).toMatchObject({ startBeat: 4, endBeat: 8 });
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
    const scopeSrc = readFileSync(
      join(__dirname, '../../crates/dj-analysis/src/beatify/scope.rs'),
      'utf8',
    );
    const num = (name: string, from: string = src): number => {
      const m = from.match(new RegExp(`${name}: f64 = ([0-9.]+)`));
      if (!m) throw new Error(`${name} not found`);
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
    expect(SCOPE_PRE_MS).toBe(num('SCOPE_PRE', scopeSrc) * 1000);
    expect(SCOPE_PRE_MAX_MS).toBe(num('SCOPE_PRE_MAX', scopeSrc) * 1000);
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

describe('cut point inspector law (§3.5)', () => {
  const scope = (attackLead: number, hasAttack = true): BeatifyScope => ({
    preSecs: 0.04,
    postSecs: 0.07,
    traces: [{ beat: 0, samples: [0, 1], attack: hasAttack ? -attackLead : null }],
    attackLead,
    spread: 0.002,
  });

  it('keeps the PRD window until the cut would fall outside it (MOD-8)', () => {
    expect(scopePreMs(0)).toBe(SCOPE_PRE_MS);
    expect(scopePreMs(14)).toBe(SCOPE_PRE_MS);
    expect(scopePreMs(32)).toBe(SCOPE_PRE_MS);
    // Past that the window opens, in steps, so the traces do not breathe
    // while the slider is being dragged.
    expect(scopePreMs(33)).toBe(50);
    expect(scopePreMs(40)).toBe(50);
    expect(scopePreMs(250)).toBe(275);
    expect(scopePreMs(9000)).toBe(SCOPE_PRE_MAX_MS);
    // Whatever it lands on, the cut is inside the window it asked for.
    for (const lead of [0, 14, 33, 120, 250]) {
      expect(scopePreMs(lead)).toBeGreaterThan(lead);
    }
  });

  it('says how much room the cut leaves in front of the attack (MOD-11)', () => {
    expect(cutClearanceMs(scope(0.006), 14)).toBeCloseTo(8, 6);
    // Negative is the interesting case: the cut lands inside the attack.
    expect(cutClearanceMs(scope(0.006), 2)).toBeCloseTo(-4, 6);
    // Nothing to measure is not the same as clearing by zero.
    expect(cutClearanceMs(scope(0, false), 14)).toBeNull();
    expect(cutClearanceMs(null, 14)).toBeNull();
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
