// Anti-aliasing rendering fixes, end to end at the component level:
//
// 1. Sequencer playhead EXTRAPOLATION (useStepFollowers): once the
//    follower has measured a stable clock from poll-driven re-renders,
//    the rAF loop must advance the lamp BETWEEN polls by direct DOM
//    mutation — no React re-render involved.
// 2. LFO lamp MOTION BLUR (meanLevel): the painted brightness is the
//    mean over the phase span a frame covers, so fast rates converge on
//    a steady average instead of strobing against the frame rate.
//
// Time is fully faked (performance + rAF) so the poll/frame interleaving
// is deterministic.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StepSeqUI from '../../extensions/step_seq/ui-src/StepSeqUI';
import { meanLevel, type View } from '../../extensions/lfo/ui-src/LfoUI';
import type { ModuleHandle } from '../src/types';

function handleWith(values: Record<string, number>, taps: Record<string, number>) {
  return {
    paramValue: (id: string) => values[id] ?? 0,
    setParam: vi.fn(),
    signalTap: (jackId: string) => ({
      instantaneous: taps[jackId] ?? 0,
      rms_100ms: taps[jackId] ?? 0,
      display: taps[jackId] ?? 0,
      volatility: 0,
      is_fast: false,
    }),
    endEdit: vi.fn(),
    size: { w: 360, h: 200 },
  } satisfies ModuleHandle;
}

describe('sequencer playhead extrapolation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const playingLamp = () => {
    for (let s = 1; s <= 16; s++) {
      const el = screen.getByTestId(`stepseq-lamp-${s}`);
      if (el.className.includes('playing')) return s - 1;
    }
    return null;
  };

  it('advances the lamp between polls once the clock is measured', () => {
    // True clock: 8 steps/s (125 ms/step) — the aliasing regime for a
    // 100 ms poll. Re-renders stand in for poll-driven telemetry ticks.
    const stepAt = () => Math.floor(performance.now() / 125) % 16;
    const taps: Record<string, number> = { 'out:step': stepAt() };
    const handle = handleWith({ length: 16, dir: 0 }, taps);
    const { rerender } = render(<StepSeqUI handle={handle} />);

    // Feed 15 polls (1.5 s) so the follower locks the rate.
    for (let i = 0; i < 15; i++) {
      vi.advanceTimersByTime(100);
      taps['out:step'] = stepAt();
      rerender(<StepSeqUI handle={handle} />);
    }

    // Between this poll and the next, the true clock crosses a step
    // boundary. The lamp must follow via the rAF loop with NO re-render.
    const before = playingLamp();
    expect(before).not.toBeNull();
    // Advance to just after the next true step edge, pumping frames.
    const target = (Math.floor(performance.now() / 125) + 1) * 125 + 30;
    while (performance.now() < target) {
      vi.advanceTimersByTime(16); // fires rAF callbacks
    }
    const after = playingLamp();
    expect(after).toBe((before! + 1) % 16);
  });

  it('random direction stays on the raw sample (no extrapolation)', () => {
    // dir 3 = random: the follower is disabled; frames never move the
    // lamp on their own, even after many regular-looking polls.
    const taps: Record<string, number> = { 'out:step': 4 };
    const handle = handleWith({ length: 16, dir: 3 }, taps);
    const { rerender } = render(<StepSeqUI handle={handle} />);
    for (let i = 0; i < 15; i++) {
      vi.advanceTimersByTime(100);
      taps['out:step'] = (4 + i) % 16;
      rerender(<StepSeqUI handle={handle} />);
    }
    const before = playingLamp();
    for (let i = 0; i < 20; i++) vi.advanceTimersByTime(16);
    expect(playingLamp()).toBe(before);
  });
});

describe('LFO lamp motion blur (meanLevel)', () => {
  // Shape 4 is pulse (see SHAPES in LfoUI): +1 for p < pw, -1 after.
  const square: View = { shape: 4, pw: 0.5, rate: 8 };
  const sine: View = { shape: 0, pw: 0.5, rate: 8 };

  it('zero span is a point sample', () => {
    expect(meanLevel(square, 0.25, 0)).toBe(1);
    expect(meanLevel(square, 0.75, 0)).toBe(0);
  });

  it('a full cycle averages to the duty cycle', () => {
    // Square at pw 0.5 spends half the cycle high: mean 0.5.
    expect(meanLevel(square, 0, 1)).toBeCloseTo(0.5, 2);
    // And any faster-than-frame span clamps to the same cycle mean —
    // the "fast LED reads as steady glow" behavior.
    expect(meanLevel(square, 0.3, 7.7)).toBeCloseTo(0.5, 2);
    expect(meanLevel(sine, 0, 1)).toBeCloseTo(0.5, 1);
  });

  it('partial spans average only the covered interval', () => {
    // First half of the square cycle is all-high.
    expect(meanLevel(square, 0, 0.5)).toBeCloseTo(1, 5);
    // Straddling the edge: half high, half low.
    expect(meanLevel(square, 0.25, 0.5)).toBeCloseTo(0.5, 2);
  });
});
