// The live selection player's two pure laws: what the level envelope is
// worth at a moment, and what has to be SCHEDULED for the next stretch of
// a loop pass. The graph around them is exercised through the page
// (ClipView.test.tsx, "the selection is live"); these are the parts a
// wrong answer would make inaudible rather than obvious.

import { describe, expect, it } from 'vitest';
import { levelGainAt, levelSchedule } from '../src/clipLive';
import { SILENCE_DB } from '../src/clip';

describe('levelGainAt', () => {
  it('is unity with no automation and follows the breakpoints with it', () => {
    expect(levelGainAt([], 3)).toBe(1);
    const points = [
      { time_secs: 0, gain_db: 0 },
      { time_secs: 4, gain_db: -6 },
    ];
    expect(levelGainAt(points, 0)).toBeCloseTo(1, 6);
    expect(levelGainAt(points, 4)).toBeCloseTo(10 ** (-6 / 20), 6);
    // Between them the ramp is in dB, so halfway is -3 dB, not half the
    // amplitude.
    expect(levelGainAt(points, 2)).toBeCloseTo(10 ** (-3 / 20), 6);
    // Past the last point it holds.
    expect(levelGainAt(points, 9)).toBeCloseTo(10 ** (-6 / 20), 6);
  });

  it('takes the silence floor to true zero', () => {
    expect(levelGainAt([{ time_secs: 0, gain_db: SILENCE_DB }], 0)).toBe(0);
  });
});

describe('levelSchedule', () => {
  const points = [
    { time_secs: 2, gain_db: 0 },
    { time_secs: 4, gain_db: -12 },
    { time_secs: 6, gain_db: 0 },
  ];

  it('schedules nothing without automation', () => {
    expect(levelSchedule([], 2, 4, 0, 1)).toEqual([]);
  });

  it('ramps to each breakpoint the pass reaches, at the moment it does', () => {
    // A 2–6 s span played from its head: the point at 4 s is 2 s away.
    const out = levelSchedule(points, 2, 4, 0, 3);
    expect(out).toHaveLength(1);
    expect(out[0].at).toBeCloseTo(2, 6);
    expect(out[0].gain).toBeCloseTo(10 ** (-12 / 20), 6);
    expect(out[0].jump).toBe(false);

    // Half a second in, it is half a second nearer.
    expect(levelSchedule(points, 2, 4, 1.5, 3)[0].at).toBeCloseTo(0.5, 6);
  });

  it('leaves a pass with nothing coming up alone', () => {
    // Everything inside the span is behind the playhead and the wrap is
    // further off than the lookahead: the value set at "now" holds.
    expect(levelSchedule(points, 2, 4, 2.5, 0.4)).toEqual([]);
  });

  it('ramps to the span end and STEPS back to its start at the wrap', () => {
    // Looking across the seam from 3.6 s into a 4 s span.
    const out = levelSchedule(points, 2, 4, 3.6, 0.5);
    expect(out).toHaveLength(2);
    const [end, wrap] = out;
    expect(end.at).toBeCloseTo(0.4, 6);
    expect(end.jump).toBe(false);
    expect(end.gain).toBeCloseTo(levelGainAt(points, 6), 6);
    // The envelope restarts: a step, not a ramp, or a hard cut at the
    // top of a loop would smear across the seam.
    expect(wrap.at).toBeCloseTo(0.4, 6);
    expect(wrap.jump).toBe(true);
    expect(wrap.gain).toBeCloseTo(levelGainAt(points, 2), 6);
  });

  it('keeps going round for as long as it is asked to look', () => {
    // Two whole passes of a 4 s span: each contributes its inner
    // breakpoint plus the pair at its seam.
    const out = levelSchedule(points, 2, 4, 0, 9);
    expect(out.filter((e) => e.jump)).toHaveLength(2);
    expect(out.map((e) => Number(e.at.toFixed(3)))).toEqual([2, 4, 4, 6, 8, 8]);
  });
});
