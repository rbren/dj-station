// The anti-aliasing playhead follower (extensions/ui-lib/stepFollower.ts):
// sparse jittery poll samples in, smooth alias-free step prediction out.
// These tests simulate the real failure mode — a 100 ms poll point-
// sampling a faster clock — and pin the honesty rules (no extrapolation
// of irregular clocks, stall freeze, transport-jump re-lock).

import { describe, expect, it } from 'vitest';
import {
  StepFollower,
  counterCycle,
  forwardCycle,
  pingPongCycle,
  reverseCycle,
} from '../../extensions/ui-lib/stepFollower';

/** Feed the follower what a `pollMs` poll would sample from `posAt`. */
function pollFeed(
  f: StepFollower,
  posAt: (tMs: number) => number,
  pollMs: number,
  untilMs: number,
) {
  for (let t = 0; t <= untilMs; t += pollMs) {
    f.observe(posAt(t), t);
  }
}

/** Simulate the steady state: 100 ms polls keep feeding while 16 ms
 *  frames read predictions; calls `check(predicted, tMs)` per frame. */
function frameLoop(
  f: StepFollower,
  posAt: (tMs: number) => number,
  fromMs: number,
  untilMs: number,
  check: (p: number, tMs: number) => void,
) {
  let nextPoll = fromMs;
  for (let t = fromMs; t <= untilMs; t += 16) {
    while (nextPoll <= t) {
      f.observe(posAt(nextPoll), nextPoll);
      nextPoll += 100;
    }
    check(f.predict(t)!, t);
  }
}

describe('StepFollower', () => {
  it('falls back to the raw sample until enough changes are seen', () => {
    const f = new StepFollower(forwardCycle(16));
    f.observe(3, 0);
    expect(f.predict(50)).toBe(3);
    f.observe(4, 100);
    // Two events only: still raw.
    expect(f.predict(150)).toBe(4);
  });

  it('extrapolates a regular clock between polls', () => {
    // 8 steps/s (125 ms/step) sampled every 100 ms — the aliasing case:
    // raw samples show steps for one-or-two ticks semi-randomly, the
    // prediction must stay within one step of truth and never jump back.
    const f = new StepFollower(forwardCycle(16));
    const posAt = (t: number) => Math.floor(t / 125) % 16;
    pollFeed(f, posAt, 100, 1000);
    let last = -1;
    frameLoop(f, posAt, 1100, 2100, (p, t) => {
      const truth = posAt(t);
      const diff = Math.min(Math.abs(p - truth), 16 - Math.abs(p - truth));
      expect(diff).toBeLessThanOrEqual(1);
      if (last >= 0) expect((p - last + 16) % 16).toBeLessThanOrEqual(2);
      last = p;
    });
  });

  it('visits every step even when the poll skips some', () => {
    // 25 steps/s (40 ms/step) sampled every 100 ms: the raw samples skip
    // 1-2 steps per poll, the prediction must fill them in.
    const f = new StepFollower(forwardCycle(16));
    const posAt = (t: number) => Math.floor(t / 40) % 16;
    pollFeed(f, posAt, 100, 1500);
    const seen = new Set<number>();
    frameLoop(f, posAt, 1600, 2600, (p) => seen.add(p));
    expect(seen.size).toBe(16);
  });

  it('does not extrapolate an irregular clock', () => {
    // Random-ish jumps (cv-addressed switch): prediction == raw sample.
    const f = new StepFollower(forwardCycle(8));
    const jumps = [0, 3, 1, 6, 2, 7, 4, 0, 5, 2, 6, 1];
    jumps.forEach((pos, i) => f.observe(pos, i * 100));
    const t = jumps.length * 100;
    expect(f.predict(t + 50)).toBe(jumps[jumps.length - 1]);
  });

  it('freezes at the observed step when the clock stalls', () => {
    const f = new StepFollower(forwardCycle(16));
    const posAt = (t: number) => Math.floor(t / 125) % 16;
    pollFeed(f, posAt, 100, 1000);
    const last = f.predict(1000);
    // No new observations: after the stall window the prediction pins to
    // the last raw sample instead of running laps.
    expect(f.predict(5000)).toBe(last === null ? null : posAt(1000));
    expect(f.predict(9000)).toBe(posAt(1000));
  });

  it('handles the wrap of a monotonic counter', () => {
    const wrap = 720_720;
    const f = new StepFollower(counterCycle(wrap));
    // 8 advances/s crossing the wrap point.
    const start = wrap - 4;
    const posAt = (t: number) => (start + Math.floor(t / 125)) % wrap;
    pollFeed(f, posAt, 100, 1500);
    frameLoop(f, posAt, 1600, 2600, (p, t) => {
      const truth = posAt(t);
      const diff = Math.min(Math.abs(p - truth), wrap - Math.abs(p - truth));
      expect(diff).toBeLessThanOrEqual(1);
    });
  });

  it('follows a reverse cycle', () => {
    const f = new StepFollower(reverseCycle(8));
    // Reverse: 7,6,...,0,7 every 125 ms.
    const posAt = (t: number) => 7 - (Math.floor(t / 125) % 8);
    pollFeed(f, posAt, 100, 1500);
    frameLoop(f, posAt, 1600, 2600, (p, t) => {
      const truth = posAt(t);
      const diff = Math.min(Math.abs(p - truth), 8 - Math.abs(p - truth));
      expect(diff).toBeLessThanOrEqual(1);
    });
  });

  it('follows a ping-pong cycle through the bounce', () => {
    const f = new StepFollower(pingPongCycle(4));
    // 0,1,2,3,2,1,0,1,2,3,... every 125 ms (period 6).
    const seq = [0, 1, 2, 3, 2, 1];
    const posAt = (t: number) => seq[Math.floor(t / 125) % 6];
    pollFeed(f, posAt, 100, 2000);
    frameLoop(f, posAt, 2100, 3100, (p, t) => {
      // Within one advance of truth along the ping-pong path.
      const truthIdx = Math.floor(t / 125) % 6;
      const candidates = [seq[truthIdx], seq[(truthIdx + 1) % 6], seq[(truthIdx + 5) % 6]];
      expect(candidates).toContain(p);
    });
  });

  it('re-locks on a transport jump without polluting the rate', () => {
    const f = new StepFollower(forwardCycle(16));
    const posAt = (t: number) => Math.floor(t / 125) % 16;
    pollFeed(f, posAt, 100, 1000);
    // Reset: jump backwards to step 0 (a >half-cycle move).
    const jumpT = 1100;
    f.observe(0, jumpT);
    expect(f.predict(jumpT + 10)).toBe(0);
    // It keeps tracking from the new lock once re-measured.
    const posAt2 = (t: number) => Math.floor((t - jumpT) / 125) % 16;
    for (let t = jumpT + 100; t <= jumpT + 1200; t += 100) {
      f.observe(posAt2(t), t);
    }
    const t = jumpT + 1250;
    const p = f.predict(t)!;
    const truth = posAt2(t);
    const diff = Math.min(Math.abs(p - truth), 16 - Math.abs(p - truth));
    expect(diff).toBeLessThanOrEqual(1);
  });

  it('resets on not-running (-1 → null) and recovers', () => {
    const f = new StepFollower(forwardCycle(16));
    const posAt = (t: number) => Math.floor(t / 125) % 16;
    pollFeed(f, posAt, 100, 1000);
    f.observe(null, 1100);
    expect(f.predict(1150)).toBeNull();
    f.observe(5, 1200);
    expect(f.predict(1250)).toBe(5);
  });

  it('drops the rate window when the cycle shape changes', () => {
    const f = new StepFollower(forwardCycle(16));
    const posAt = (t: number) => Math.floor(t / 125) % 16;
    pollFeed(f, posAt, 100, 1000);
    f.setCycle(forwardCycle(8)); // length knob turned
    // The old window is void: back to raw sampling until re-measured.
    f.observe(2, 1100);
    expect(f.predict(1400)).toBe(2);
  });

  it('setCycle with an identical shape keeps the rate window', () => {
    const f = new StepFollower(forwardCycle(16));
    const posAt = (t: number) => Math.floor(t / 125) % 16;
    for (let t = 0; t <= 1000; t += 100) {
      f.setCycle(forwardCycle(16)); // fresh spec every "render"
      f.observe(posAt(t), t);
    }
    // Still extrapolates: at t=1040 the true step differs from the last
    // 100 ms sample often enough that a full sweep must stay within 1.
    const p = f.predict(1040)!;
    const truth = posAt(1040);
    const diff = Math.min(Math.abs(p - truth), 16 - Math.abs(p - truth));
    expect(diff).toBeLessThanOrEqual(1);
  });
});
