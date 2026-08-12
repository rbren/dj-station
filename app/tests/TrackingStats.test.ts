// Diagnostics accumulator (extensions/camera/ui-src/trackingStats.ts):
// delivered fps is measured from mediaTime deltas, repeat frames count
// as drops and are skipped, inference/latency are windowed means, and
// the active delegate is carried into the snapshot (PRD §4.4).

import { describe, expect, it } from 'vitest';
import { StatsAccumulator } from '../../extensions/camera/ui-src/trackingStats';

describe('StatsAccumulator', () => {
  it('measures delivered fps from mediaTime deltas', () => {
    const acc = new StatsAccumulator();
    // 31 frames spaced 1/30 s apart -> 30 fps over a 1 s span.
    for (let i = 0; i <= 30; i++) expect(acc.frameArrived(i / 30)).toBe(true);
    expect(acc.snapshot().cameraFps).toBeCloseTo(30, 1);
  });

  it('counts a non-advancing mediaTime as a dropped frame and rejects it', () => {
    const acc = new StatsAccumulator();
    expect(acc.frameArrived(0.1)).toBe(true);
    expect(acc.frameArrived(0.1)).toBe(false); // rVFC tick, same frame
    expect(acc.frameArrived(0.05)).toBe(false); // going backwards
    expect(acc.frameArrived(0.2)).toBe(true);
    expect(acc.snapshot().droppedFrames).toBe(2);
  });

  it('averages inference and latency over the window', () => {
    const acc = new StatsAccumulator();
    acc.frameProcessed(10, 40);
    acc.frameProcessed(20, 60);
    const s = acc.snapshot();
    expect(s.inferenceMs).toBeCloseTo(15);
    expect(s.latencyMs).toBeCloseTo(50);
  });

  it('counts failed inference as dropped', () => {
    const acc = new StatsAccumulator();
    acc.frameArrived(0.1);
    acc.frameFailed();
    expect(acc.snapshot().droppedFrames).toBe(1);
  });

  it('reports the active delegate and resets fully', () => {
    const acc = new StatsAccumulator();
    acc.delegate = 'GPU';
    acc.frameArrived(0.1);
    acc.frameProcessed(5, 10);
    expect(acc.snapshot().delegate).toBe('GPU');
    acc.reset();
    const s = acc.snapshot();
    expect(s).toEqual({
      cameraFps: 0,
      inferenceMs: 0,
      latencyMs: 0,
      droppedFrames: 0,
      delegate: null,
    });
    // After reset the first frame is accepted again.
    expect(acc.frameArrived(0.05)).toBe(true);
  });

  it('reports 0 fps with fewer than two frames', () => {
    const acc = new StatsAccumulator();
    expect(acc.snapshot().cameraFps).toBe(0);
    acc.frameArrived(1);
    expect(acc.snapshot().cameraFps).toBe(0);
  });
});
