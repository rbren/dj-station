// The live selection player's pure laws: what the level envelope is
// worth at a moment, what has to be SCHEDULED for the next stretch of
// a loop pass, and which windows a BLEED asks for and where they land.
// The graph around them is exercised through the page
// (ClipView.test.tsx, "the selection is live"); these are the parts a
// wrong answer would make inaudible rather than obvious.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bleedWindows,
  ClipLivePlayer,
  levelGainAt,
  levelSchedule,
  mixInto,
  type LiveHost,
} from '../src/clipLive';
import { closeAudio } from '../src/clipAudio';
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

describe('bleedWindows', () => {
  const span = { start: 2, end: 6 };

  it('asks for nothing when neither bookend does', () => {
    expect(bleedWindows(span, { leftMs: 0, rightMs: 0 }, 10)).toEqual({ left: null, right: null });
  });

  it('takes each bookend from OUTSIDE the span, at the edge it sits at', () => {
    const { left, right } = bleedWindows(span, { leftMs: 250, rightMs: 100 }, 10);
    // The left bleed is the material that RAN INTO the selection…
    expect(left).toEqual({ start: 1.75, len: 0.25 });
    // …and the right the material that FOLLOWED it.
    expect(right).toEqual({ start: 6, len: 0.1 });
  });

  it('gives what the edit has where a bookend runs off the end of it', () => {
    // A span on the very edges of a 6 s edit: there is 0.1 s behind it
    // and nothing at all after it, so only the left window is asked for
    // — an empty window is an error at the other end, not silence.
    const edges = bleedWindows({ start: 0.1, end: 6 }, { leftMs: 500, rightMs: 500 }, 6);
    expect(edges.left).toEqual({ start: 0, len: 0.1 });
    expect(edges.right).toBeNull();
  });
});

describe('mixInto', () => {
  it('sums the bookend in without moving what is under it', () => {
    const loop = new Float32Array([1, 1, 1, 1]);
    mixInto(loop, new Float32Array([0.5, 0.25]), 0);
    expect([...loop]).toEqual([1.5, 1.25, 1, 1]);
  });

  it('keeps the end of a bookend that is longer than the loop', () => {
    // The left bleed lands at `len - bookend`, i.e. below zero here: what
    // hangs off the front is lost, never the material meeting the seam.
    const loop = new Float32Array([0, 0]);
    mixInto(loop, new Float32Array([1, 2, 3, 4]), -2);
    expect([...loop]).toEqual([3, 4]);
  });

  it('stops where the loop ends', () => {
    const loop = new Float32Array([0, 0, 0]);
    mixInto(loop, new Float32Array([1, 1, 1]), 2);
    expect([...loop]).toEqual([0, 0, 1]);
  });
});

describe('the live loop plays its bleed', () => {
  /** A tiny rate keeps the fake buffers legible. */
  const RATE = 1000;

  function buffer(data: Float32Array): AudioBuffer {
    return {
      numberOfChannels: 1,
      length: data.length,
      sampleRate: RATE,
      duration: data.length / RATE,
      getChannelData: () => data,
    } as unknown as AudioBuffer;
  }

  class FakeParam {
    value = 0;
    setValueAtTime() {
      return this;
    }
    linearRampToValueAtTime() {
      return this;
    }
    setTargetAtTime() {
      return this;
    }
    cancelScheduledValues() {
      return this;
    }
  }

  /** Enough Web Audio for the player to fetch, mix and install a loop. */
  function installAudio() {
    class FakeContext {
      state = 'running';
      currentTime = 0;
      destination = {};
      sampleRate = RATE;
      async decodeAudioData(bytes: ArrayBuffer) {
        return buffer(new Float32Array(bytes));
      }
      createBuffer(_channels: number, length: number) {
        return buffer(new Float32Array(length));
      }
      createGain() {
        return { gain: new FakeParam(), connect() {}, disconnect() {} };
      }
      createBiquadFilter() {
        return {
          type: '',
          frequency: new FakeParam(),
          Q: new FakeParam(),
          gain: new FakeParam(),
          connect() {},
          disconnect() {},
        };
      }
      createBufferSource() {
        return {
          buffer: null,
          loop: false,
          loopStart: 0,
          loopEnd: 0,
          onended: null,
          connect() {},
          disconnect() {},
          start() {},
          stop() {},
        };
      }
      async resume() {}
      async close() {}
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
  }

  /** A 10 s edit whose every second reads back as its own level, so a
   *  window says where it came from: the loop at 1, the material after
   *  it at 0.25, the material before it at 0.5. */
  function fakeHost(): LiveHost & { published: AudioBuffer[] } {
    const level = new Map([
      [2, 1],
      [6, 0.25],
      [1.9, 0.5],
    ]);
    const published: AudioBuffer[] = [];
    return {
      render: vi.fn(async (start: number, len: number) => {
        const value = level.get(Number(start.toFixed(3))) ?? 0;
        return new Float32Array(Math.round(len * RATE)).fill(value).buffer;
      }),
      duration: () => 10,
      onBuffer: (buf: AudioBuffer | null) => {
        if (buf) published.push(buf);
      },
      onStatus: () => {},
      published,
    };
  }

  afterEach(() => {
    closeAudio();
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it('lays the right bleed over the head of the loop and the left over its tail', async () => {
    installAudio();
    const host = fakeHost();
    const player = new ClipLivePlayer(host, { fetchDelayMs: 0 });
    player.setSpan(2, 6);
    player.setBleed(100, 100);

    await vi.waitFor(() => expect(host.published.length).toBeGreaterThan(0));
    const heard = host.published[host.published.length - 1].getChannelData(0);

    // The loop is still four seconds long: the bleed lies OVER the seam,
    // it does not lengthen the loop or edit it.
    expect(heard).toHaveLength(4 * RATE);
    // Its head carries the material that FOLLOWED the selection…
    expect(heard[0]).toBeCloseTo(1.25, 6);
    expect(heard[99]).toBeCloseTo(1.25, 6);
    // …for exactly the 100 ms asked for, and no further.
    expect(heard[100]).toBeCloseTo(1, 6);
    expect(heard[2000]).toBeCloseTo(1, 6);
    // Its tail leans into the pass to come with the material from BEFORE
    // the selection.
    expect(heard[4 * RATE - 101]).toBeCloseTo(1, 6);
    expect(heard[4 * RATE - 100]).toBeCloseTo(1.5, 6);
    expect(heard[4 * RATE - 1]).toBeCloseTo(1.5, 6);

    player.dispose();
  });

  it('asks for no bookend and hands over the bare loop with no bleed set', async () => {
    installAudio();
    const host = fakeHost();
    const player = new ClipLivePlayer(host, { fetchDelayMs: 0 });
    player.setSpan(2, 6);

    await vi.waitFor(() => expect(host.published.length).toBeGreaterThan(0));
    const heard = host.published[host.published.length - 1].getChannelData(0);
    expect(heard[0]).toBeCloseTo(1, 6);
    expect(heard[4 * RATE - 1]).toBeCloseTo(1, 6);
    // One render, for the span itself: a clip with no bleed costs the
    // backend exactly what it did before there was such a thing.
    expect((host.render as ReturnType<typeof vi.fn>).mock.calls).toEqual([[2, 4]]);

    player.dispose();
  });
});
