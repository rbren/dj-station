// Overlay renderer (extensions/camera/ui-src/HandOverlay.ts): skeleton +
// 21 points per hand with distinct fingertips (R-9/R-10), per-hand
// colours with the physical label at the wrist (R-11), and confidence
// driving opacity (R-12). jsdom has no real 2D context, so the tests
// drive a recording stub — the renderer is pure drawing over the
// projection math pinned by HandTracking.test.ts.

import { describe, expect, it } from 'vitest';
import {
  HAND_COLORS,
  HAND_LABELS,
  drawHandFrame,
} from '../../extensions/camera/ui-src/HandOverlay';
import type { HandFrame, TrackedHand } from '../../extensions/camera/ui-src/handTracking';

interface Call {
  op: string;
  args: unknown[];
  alpha: number;
  fill: string;
  stroke: string;
}

function recordingCtx() {
  const calls: Call[] = [];
  const state = { globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 0, font: '' };
  const record =
    (op: string) =>
    (...args: unknown[]) =>
      calls.push({
        op,
        args,
        alpha: state.globalAlpha,
        fill: state.fillStyle,
        stroke: state.strokeStyle,
      });
  const ctx = {
    clearRect: record('clearRect'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    arc: record('arc'),
    fill: record('fill'),
    fillText: record('fillText'),
  } as unknown as CanvasRenderingContext2D & typeof state;
  for (const key of Object.keys(state) as (keyof typeof state)[]) {
    Object.defineProperty(ctx, key, {
      get: () => state[key],
      set: (v) => {
        (state as Record<string, unknown>)[key] = v;
      },
    });
  }
  return { ctx, calls };
}

function hand(handedness: TrackedHand['hand'], score = 1): TrackedHand {
  // 21 distinct points spread across engine space.
  const points = Array.from({ length: 21 }, (_, i) => ({
    x: -0.8 + i * 0.08,
    y: -0.8 + i * 0.07,
    z: 0,
  }));
  return { hand: handedness, score, points };
}

const frame = (hands: TrackedHand[]): HandFrame => ({ mediaTime: 0, hands });

describe('drawHandFrame', () => {
  it('clears the canvas and draws nothing for an empty frame', () => {
    const { ctx, calls } = recordingCtx();
    drawHandFrame(ctx, frame([]), 1280, 720, 320, 180);
    expect(calls.map((c) => c.op)).toEqual(['clearRect']);
  });

  it('draws 21 points and the full skeleton per hand (R-9)', () => {
    const { ctx, calls } = recordingCtx();
    drawHandFrame(ctx, frame([hand('left')]), 1280, 720, 320, 180);
    expect(calls.filter((c) => c.op === 'arc')).toHaveLength(21);
    // 21 skeleton connections drawn as one stroked path.
    expect(calls.filter((c) => c.op === 'moveTo')).toHaveLength(21);
    expect(calls.filter((c) => c.op === 'lineTo')).toHaveLength(21);
    expect(calls.filter((c) => c.op === 'stroke')).toHaveLength(1);
  });

  it('renders fingertips larger than other landmarks (R-10)', () => {
    const { ctx, calls } = recordingCtx();
    drawHandFrame(ctx, frame([hand('left')]), 1280, 720, 320, 180);
    const arcs = calls.filter((c) => c.op === 'arc');
    const radii = arcs.map((c) => c.args[2] as number);
    const tipR = new Set([4, 8, 12, 16, 20].map((i) => radii[i]));
    const otherR = new Set(radii.filter((_, i) => ![4, 8, 12, 16, 20].includes(i)));
    expect(tipR.size).toBe(1);
    expect(otherR.size).toBe(1);
    expect([...tipR][0]).toBeGreaterThan([...otherR][0]);
  });

  it('uses distinct colours per hand and labels the wrist (R-11)', () => {
    const { ctx, calls } = recordingCtx();
    drawHandFrame(ctx, frame([hand('left'), hand('right')]), 1280, 720, 320, 180);
    expect(HAND_COLORS.left).not.toBe(HAND_COLORS.right);
    const labels = calls.filter((c) => c.op === 'fillText');
    expect(labels).toHaveLength(2);
    expect(labels[0].args[0]).toBe(HAND_LABELS.left);
    expect(labels[0].fill).toBe(HAND_COLORS.left);
    expect(labels[1].args[0]).toBe(HAND_LABELS.right);
    expect(labels[1].fill).toBe(HAND_COLORS.right);
  });

  it('maps tracking confidence to overlay opacity (R-12)', () => {
    const { ctx, calls } = recordingCtx();
    drawHandFrame(ctx, frame([hand('left', 0.6)]), 1280, 720, 320, 180);
    const drawn = calls.filter((c) => c.op === 'fill' || c.op === 'stroke');
    expect(drawn.length).toBeGreaterThan(0);
    for (const c of drawn) expect(c.alpha).toBeCloseTo(0.6);
  });

  it('keeps a barely-tracked hand faintly visible instead of invisible', () => {
    const { ctx, calls } = recordingCtx();
    drawHandFrame(ctx, frame([hand('left', 0.01)]), 1280, 720, 320, 180);
    const stroke = calls.find((c) => c.op === 'stroke');
    expect(stroke!.alpha).toBeGreaterThan(0);
  });
});
