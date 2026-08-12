// The camera panel -> builtin.hands bridge: wire-format conversion and
// the discovery/feed/close lifecycle, with an injected invoke (no Tauri).

import { describe, expect, it, vi } from 'vitest';
import {
  createHandsFeeder,
  toDetectionWire,
  type Invoke,
} from '../../extensions/camera/ui-src/handsFeed';
import type { HandFrame, TrackedHand } from '../../extensions/camera/ui-src/handTracking';

function hand(which: 'left' | 'right', x = 0.1): TrackedHand {
  return {
    hand: which,
    score: 0.9,
    points: Array.from({ length: 21 }, (_, i) => ({
      x: x + i * 0.01,
      y: -0.2 + i * 0.01,
      z: 0,
    })),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function mockInvoke(nodes: { instance_id: string; type_id: string }[]) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const invoke: Invoke = vi.fn(async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'engine_nodes') return nodes;
    return null;
  });
  return { invoke, calls };
}

describe('toDetectionWire', () => {
  it('maps tracked hands onto the HandsDetection wire shape', () => {
    const frame: HandFrame = { mediaTime: 1, hands: [hand('right', 0.3)] };
    const det = toDetectionWire(frame);
    expect(det.left).toBeNull();
    expect(det.right).toHaveLength(21);
    expect(det.right![0]).toEqual([0.3, -0.2, 0]);
  });

  it('no hands -> both null (a measurement, still sent)', () => {
    expect(toDetectionWire({ mediaTime: 0, hands: [] })).toEqual({
      left: null,
      right: null,
    });
  });

  it('drops hands with partial landmark sets', () => {
    const partial = hand('left');
    partial.points = partial.points.slice(0, 5);
    const det = toDetectionWire({ mediaTime: 0, hands: [partial] });
    expect(det.left).toBeNull();
  });
});

describe('createHandsFeeder', () => {
  it('discovers Hands modules and feeds each one per frame', async () => {
    const { invoke, calls } = mockInvoke([
      { instance_id: 'hands1', type_id: 'builtin.hands' },
      { instance_id: 'hands2', type_id: 'builtin.hands' },
      { instance_id: 'osc1', type_id: 'com.dj.oscillator' },
    ]);
    const feeder = createHandsFeeder(invoke);
    await flush();
    feeder.feed({ mediaTime: 1, hands: [hand('left')] });
    await flush();
    const feeds = calls.filter((c) => c.cmd === 'hands_feed');
    expect(feeds.map((c) => c.args?.instance).sort()).toEqual(['hands1', 'hands2']);
    const det = feeds[0].args?.detection as { left: unknown; right: unknown };
    expect(det.left).toHaveLength(21);
    expect(det.right).toBeNull();
    feeder.close();
  });

  it('feeds nothing when the rack has no Hands modules', async () => {
    const { invoke, calls } = mockInvoke([{ instance_id: 'osc1', type_id: 'com.dj.oscillator' }]);
    const feeder = createHandsFeeder(invoke);
    await flush();
    feeder.feed({ mediaTime: 1, hands: [] });
    await flush();
    expect(calls.filter((c) => c.cmd === 'hands_feed')).toHaveLength(0);
    feeder.close();
  });

  it('close() stops feeding and discovery', async () => {
    const { invoke, calls } = mockInvoke([{ instance_id: 'hands1', type_id: 'builtin.hands' }]);
    const feeder = createHandsFeeder(invoke);
    await flush();
    feeder.close();
    feeder.feed({ mediaTime: 1, hands: [hand('right')] });
    await flush();
    expect(calls.filter((c) => c.cmd === 'hands_feed')).toHaveLength(0);
  });

  it('survives hands_feed rejections (dropped frames are fine)', async () => {
    const invoke: Invoke = vi.fn(async (cmd) => {
      if (cmd === 'engine_nodes') return [{ instance_id: 'hands1', type_id: 'builtin.hands' }];
      throw new Error('engine busy');
    });
    const feeder = createHandsFeeder(invoke);
    await flush();
    expect(() => feeder.feed({ mediaTime: 1, hands: [] })).not.toThrow();
    await flush();
    feeder.close();
  });
});
