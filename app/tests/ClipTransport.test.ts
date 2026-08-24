// The Clip page's transport owns every source that can make sound.
//
// These tests drive ClipTransport with a fake host whose renders and
// decodes resolve WHEN THE TEST SAYS SO, which is the only way to pin the
// races that made the page play a track twice: a render or a decode
// landing after a newer command has already superseded it.
//
// The master invariant — at most one live source, ever — is asserted by
// the world itself on every start, so a test does not have to remember to
// check it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipTransport, type TransportHost, type TransportStatus } from '../src/clipTransport';
import type { PreparedLoop } from '../src/clipAudio';

/** Let queued microtasks and zero-delay timers run. */
async function flush(times = 3) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A started loop node. */
interface LiveLoop {
  offset: number;
  stopped: boolean;
}

/**
 * A fake audio world: one media element plus however many loop nodes the
 * transport tries to start. It counts everything that is making sound and
 * fails the moment two things are.
 */
class World {
  loops: LiveLoop[] = [];
  /** Loops that were decoded but never started (correctly discarded). */
  preparedUnused = 0;
  elementPlaying = false;
  /** Highest number of simultaneously live sources seen. */
  peak = 0;
  renders: { start: number; len: number; deferred: Deferred<ArrayBuffer | null>; done?: true }[] =
    [];
  decodes: { deferred: Deferred<PreparedLoop | null>; done?: true }[] = [];
  durationSecs = 10;
  status: TransportStatus = { playing: false, playhead: 0 };
  statusCount = 0;
  webAudio = true;
  /** Set to false to model the editor before a track is open. */
  hasElement = true;

  readonly listeners = new Map<string, Set<() => void>>();

  readonly element = {
    src: '',
    loop: false,
    currentTime: 0,
    addEventListener: (type: string, fn: () => void) => {
      const set = this.listeners.get(type) ?? new Set();
      set.add(fn);
      this.listeners.set(type, set);
    },
    removeEventListener: (type: string, fn: () => void) => {
      this.listeners.get(type)?.delete(fn);
    },
    play: async () => {
      this.elementPlaying = true;
      this.check();
    },
    pause: () => {
      this.elementPlaying = false;
    },
  } as unknown as HTMLAudioElement;

  /** Fire a media event at whoever is listening. */
  emit(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }

  get live(): number {
    return this.loops.filter((l) => !l.stopped).length + (this.elementPlaying ? 1 : 0);
  }

  /** THE invariant. */
  check() {
    this.peak = Math.max(this.peak, this.live);
    if (this.live > 1) {
      throw new Error(
        `two sources are playing at once: ${this.loops.filter((l) => !l.stopped).length} loop node(s)` +
          `${this.elementPlaying ? ' + the media element' : ''}`,
      );
    }
  }

  host(): TransportHost {
    return {
      duration: () => this.durationSecs,
      element: () => (this.hasElement ? this.element : null),
      render: (start, len) => {
        const d = deferred<ArrayBuffer | null>();
        this.renders.push({ start, len, deferred: d });
        return d.promise;
      },
      prepareLoop: () => {
        if (!this.webAudio) return Promise.resolve(null);
        const d = deferred<PreparedLoop | null>();
        this.decodes.push({ deferred: d });
        return d.promise;
      },
      onStatus: (s) => {
        this.status = s;
        this.statusCount++;
      },
    };
  }

  /** Resolve the n-th STILL PENDING render with some bytes. */
  finishRender(index = 0) {
    const pending = this.renders.filter((r) => !r.done);
    const r = pending[index];
    if (!r) throw new Error(`no pending render #${index} (of ${pending.length})`);
    r.done = true;
    r.deferred.resolve(new ArrayBuffer(44));
  }

  /** Hand back a decoded buffer for the n-th still pending decode. It only
   *  makes sound if the transport actually starts it. */
  finishDecode(index = 0) {
    const pending = this.decodes.filter((d) => !d.done);
    const entry = pending[index];
    if (!entry) throw new Error(`no pending decode #${index} (of ${pending.length})`);
    entry.done = true;
    this.preparedUnused++;
    entry.deferred.resolve({
      duration: 4,
      start: (offsetSecs = 0) => {
        this.preparedUnused--;
        const live: LiveLoop = { offset: offsetSecs, stopped: false };
        this.loops.push(live);
        this.check();
        return {
          duration: 4,
          position: () => offsetSecs,
          stop: () => {
            live.stopped = true;
          },
        };
      },
    });
  }

  /** Resolve everything outstanding, letting continuations run in between
   *  (a decode is only asked for once its render lands). */
  async settle() {
    for (let i = 0; i < 6; i++) {
      const renders = this.renders.filter((r) => !r.done).length;
      const decodes = this.decodes.filter((d) => !d.done).length;
      if (!renders && !decodes) break;
      for (let n = renders; n > 0; n--) this.finishRender();
      for (let n = decodes; n > 0; n--) this.finishDecode();
      await flush(1);
    }
    await flush();
  }
}

describe('ClipTransport', () => {
  let world: World;
  let transport: ClipTransport;

  beforeEach(() => {
    world = new World();
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:clip'), revokeObjectURL: vi.fn() });
    transport = new ClipTransport(world.host(), { windowSecs: 60, tickMs: 5, toneDelayMs: 0 });
  });

  afterEach(() => {
    transport.dispose();
    expect(world.live).toBe(0);
  });

  it('plays a linear window through the media element', async () => {
    transport.play(0, null);
    await flush();
    expect(world.renders[0]).toMatchObject({ start: 0, len: 10 });
    world.finishRender();
    await flush();
    expect(transport.playing).toBe(true);
    expect(world.elementPlaying).toBe(true);
    expect(world.element.loop).toBe(false);
    expect(world.live).toBe(1);
  });

  it('loops through a Web Audio node, never the element', async () => {
    transport.play(2, { start: 2, end: 6 });
    await flush();
    expect(world.renders[0]).toMatchObject({ start: 2, len: 4 });
    world.finishRender();
    await flush();
    world.finishDecode();
    await flush();
    expect(world.loops).toHaveLength(1);
    expect(world.elementPlaying).toBe(false);
    expect(transport.playing).toBe(true);
  });

  it('discards a render that lands after a newer play', async () => {
    transport.play(0, null); // superseded
    transport.play(5, null);
    await flush();
    expect(world.renders).toHaveLength(2);

    // The stale render resolves LAST, the way a slow first request does.
    world.finishRender(1);
    await flush();
    world.finishRender(0);
    await flush();

    expect(world.live).toBe(1);
    expect(transport.loaded).toMatchObject({ start: 5 });
  });

  it('never starts a loop whose decode finishes after it was superseded', async () => {
    // This is the bug the refactor exists for: the decode used to start
    // the node itself, so the loser of this race played on with nobody
    // holding its handle.
    transport.play(0, { start: 0, end: 4 });
    await flush();
    world.finishRender();
    await flush();
    expect(world.decodes).toHaveLength(1);

    // A newer command lands while the first decode is still running.
    transport.play(6, { start: 6, end: 10 });
    await flush();
    world.finishDecode(); // the stale one
    await flush();

    expect(world.loops).toHaveLength(0);
    expect(world.preparedUnused).toBe(1);

    world.finishRender();
    await flush();
    world.finishDecode();
    await flush();

    expect(world.loops).toHaveLength(1);
    expect(world.loops[0].stopped).toBe(false);
    expect(transport.loaded).toMatchObject({ start: 6, loop: true });
    expect(world.peak).toBe(1);
  });

  it('drops work in flight when the user pauses', async () => {
    transport.play(0, { start: 0, end: 4 });
    await flush();
    world.finishRender();
    await flush();
    transport.pause();
    world.finishDecode();
    await flush();

    expect(world.loops).toHaveLength(0);
    expect(transport.playing).toBe(false);
    expect(world.live).toBe(0);
  });

  it('starts nothing once disposed, whatever is still in flight', async () => {
    transport.play(0, { start: 0, end: 4 });
    await flush();
    world.finishRender();
    await flush();
    transport.dispose();
    world.finishDecode();
    await flush();

    expect(world.loops).toHaveLength(0);
    // A disposed transport is dead: commands are refused, not queued.
    transport.play(0, null);
    await flush();
    expect(world.renders).toHaveLength(1);
    expect(transport.playing).toBe(false);
  });

  it('swaps the source when the loop range changes, keeping just one', async () => {
    transport.play(2, { start: 2, end: 6 });
    await flush();
    world.finishRender();
    await flush();
    world.finishDecode();
    await flush();
    const first = world.loops[0];

    transport.setLoop({ start: 3, end: 9 });
    await flush();
    // The old node plays on until the new one is ready — but only one of
    // them is ever live.
    expect(first.stopped).toBe(false);
    world.finishRender();
    await flush();
    world.finishDecode();
    await flush();

    expect(first.stopped).toBe(true);
    expect(world.loops.filter((l) => !l.stopped)).toHaveLength(1);
    expect(transport.loaded).toMatchObject({ start: 3, end: 9 });
    expect(world.peak).toBe(1);
  });

  it('ignores a loop change that asks for the window already playing', async () => {
    transport.play(2, { start: 2, end: 6 });
    await flush();
    world.finishRender();
    await flush();
    world.finishDecode();
    await flush();

    transport.setLoop({ start: 2, end: 6 });
    await flush();
    expect(world.renders).toHaveLength(1);
  });

  it('hands the loop back to the element when the range is cleared', async () => {
    transport.play(2, { start: 2, end: 6 });
    await flush();
    world.finishRender();
    await flush();
    world.finishDecode();
    await flush();

    transport.setLoop(null);
    await flush();
    world.finishRender();
    await flush();

    expect(world.loops[0].stopped).toBe(true);
    expect(world.elementPlaying).toBe(true);
    expect(world.element.loop).toBe(false);
    expect(world.peak).toBe(1);
  });

  it('re-renders in place for a tone edit, keeping the loop phase', async () => {
    transport.play(2, { start: 2, end: 6 });
    await flush();
    world.finishRender();
    await flush();
    world.finishDecode();
    await flush();

    transport.refreshTone();
    await flush();
    expect(world.renders).toHaveLength(2);
    world.finishRender();
    await flush();
    world.finishDecode();
    await flush();

    expect(world.loops).toHaveLength(2);
    expect(world.loops[0].stopped).toBe(true);
    expect(world.loops[1].stopped).toBe(false);
    expect(transport.playing).toBe(true);
    expect(world.peak).toBe(1);
  });

  it('does not re-render for a tone edit while stopped', async () => {
    transport.refreshTone();
    await flush();
    expect(world.renders).toHaveLength(0);
  });

  it('stops and forgets the window when the timeline changes', async () => {
    transport.play(0, null);
    await flush();
    world.finishRender();
    await flush();

    transport.invalidate();
    expect(transport.playing).toBe(false);
    expect(transport.loaded).toBeNull();
    expect(world.elementPlaying).toBe(false);
  });

  it('chains the next window when a linear one runs out', async () => {
    world.durationSecs = 120;
    transport.play(0, null);
    await flush();
    expect(world.renders[0]).toMatchObject({ start: 0, len: 60 });
    world.finishRender();
    await flush();

    world.emit('ended');
    await flush();
    expect(world.renders[1]).toMatchObject({ start: 60, len: 60 });
    world.finishRender();
    await flush();
    expect(transport.playing).toBe(true);
    expect(world.peak).toBe(1);

    world.emit('ended');
    await flush();
    expect(transport.playing).toBe(false);
    expect(transport.playhead).toBe(120);
  });

  it('follows the element while it plays and parks the playhead on pause', async () => {
    transport.play(0, null);
    await flush();
    world.finishRender();
    await flush();

    (world.element as { currentTime: number }).currentTime = 3;
    world.emit('timeupdate');
    expect(transport.playhead).toBe(3);
    expect(world.status).toEqual({ playing: true, playhead: 3 });

    transport.pause();
    expect(transport.playhead).toBe(3);
    expect(transport.playing).toBe(false);
  });

  it('survives the user hammering the transport', async () => {
    for (let i = 0; i < 12; i++) {
      transport.play(i % 3, i % 2 ? { start: 0, end: 4 } : null);
      if (i % 4 === 3) transport.pause();
      if (i % 3 === 2) transport.setLoop(i % 2 ? null : { start: 1, end: 5 });
      // Let some of the backlog land mid-stream and some of it pile up.
      if (i % 2) await world.settle();
      else await flush(1);
    }
    await world.settle();
    expect(world.peak).toBeLessThanOrEqual(1);
    expect(world.live).toBeLessThanOrEqual(1);

    transport.stop(0);
    expect(world.live).toBe(0);
    expect(transport.playhead).toBe(0);
  });

  it('falls back to the media element where Web Audio is missing', async () => {
    world.webAudio = false;
    transport.play(2, { start: 2, end: 6 });
    await flush();
    world.finishRender();
    await flush();

    expect(world.loops).toHaveLength(0);
    expect(world.elementPlaying).toBe(true);
    expect(world.element.loop).toBe(true);
  });

  it('plays nothing before the editor has an element', async () => {
    world.hasElement = false;
    transport.play(0, null);
    await flush();
    world.finishRender();
    await flush();
    expect(world.elementPlaying).toBe(false);
    expect([...world.listeners.values()].every((s) => s.size === 0)).toBe(true);
  });

  it('lets go of the element it was driving when disposed', async () => {
    transport.play(0, null);
    await flush();
    world.finishRender();
    await flush();
    expect(world.listeners.get('ended')?.size).toBe(1);

    transport.dispose();
    expect(world.elementPlaying).toBe(false);
    expect([...world.listeners.values()].every((s) => s.size === 0)).toBe(true);
    // Events from an element nobody owns any more change nothing.
    world.emit('ended');
    expect(transport.playing).toBe(false);
  });

  describe('a loop longer than one render window', () => {
    beforeEach(() => {
      world.durationSecs = 200;
    });

    it('chains windows through the range and wraps at its end', async () => {
      transport.play(0, { start: 0, end: 200 });
      await world.settle();
      // 200 s cannot sit in one buffer, so this runs on the element —
      // and the element must NOT loop the 60 s it is holding.
      expect(world.renders[0]).toMatchObject({ start: 0, len: 60 });
      expect(world.decodes).toHaveLength(0);
      expect(world.element.loop).toBe(false);

      for (const start of [60, 120, 180]) {
        world.emit('ended');
        await world.settle();
        expect(world.renders[world.renders.length - 1]).toMatchObject({ start });
      }
      // The last window is the short tail, and running out of it wraps
      // back to the head instead of stopping.
      expect(world.renders[world.renders.length - 1]).toMatchObject({ start: 180, len: 20 });
      world.emit('ended');
      await world.settle();
      expect(world.renders[world.renders.length - 1]).toMatchObject({ start: 0, len: 60 });
      expect(world.status.playing).toBe(true);
      expect(world.peak).toBe(1);
    });

    it('arms around the playhead instead of rewinding to the head', async () => {
      transport.play(30, null);
      await world.settle();
      expect(world.renders[0]).toMatchObject({ start: 30, len: 60 });

      transport.setLoop({ start: 0, end: 200 });
      await world.settle();
      // Still where it was, now looping — not yanked back to 0.
      expect(world.renders[world.renders.length - 1]).toMatchObject({ start: 30 });
      expect(world.status.playing).toBe(true);
    });

    it('still loops a range that fits on a gapless buffer', async () => {
      transport.play(0, { start: 10, end: 40 });
      await world.settle();
      expect(world.renders[0]).toMatchObject({ start: 10, len: 30 });
      expect(world.loops.filter((l) => !l.stopped)).toHaveLength(1);
    });
  });
});

// A media element is not the obliging stub above: a src assignment starts
// an async load, a seek before the metadata lands is dropped, and a seek
// PAST what it holds ends the media on the spot. Getting any of that
// wrong is inaudible in a fake that just flips a boolean, so the
// selection bug — the playhead marching along in silence — needs a
// stricter one.
class StrictElement {
  private srcValue = '';
  loop = false;
  currentTime = 0;
  /** Seconds of audio the loaded blob holds. */
  mediaSecs = 60;
  loaded = false;
  playing = false;
  ended = false;
  loads = 0;
  private readonly listeners = new Map<string, Set<() => void>>();

  get src(): string {
    return this.srcValue;
  }

  set src(v: string) {
    this.srcValue = v;
    this.loaded = false;
    this.ended = false;
    this.currentTime = 0;
    this.loads++;
    // The blob arrives on a later task, like a real load.
    setTimeout(() => {
      if (this.srcValue !== v) return;
      this.loaded = true;
      this.emit('loadedmetadata');
      if (this.currentTime >= this.mediaSecs) {
        this.currentTime = this.mediaSecs;
        this.ended = true;
        this.emit('ended');
      }
    }, 0);
  }

  addEventListener(type: string, fn: () => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }

  emit(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }

  async play() {
    this.playing = true;
  }

  pause() {
    this.playing = false;
  }

  /** Is sound actually coming out? */
  get sounding(): boolean {
    return this.playing && this.loaded && !this.ended;
  }
}

describe('ClipTransport against a strict media element', () => {
  let el: StrictElement;
  let renders: { start: number; len: number }[];
  let transport: ClipTransport;
  const DURATION = 300;

  beforeEach(() => {
    el = new StrictElement();
    renders = [];
    Object.assign(URL, { createObjectURL: vi.fn(() => `blob:${renders.length}`) });
    transport = new ClipTransport(
      {
        duration: () => DURATION,
        element: () => el as unknown as HTMLAudioElement,
        render: async (start, len) => {
          renders.push({ start, len });
          el.mediaSecs = len;
          return new ArrayBuffer(44);
        },
        // No Web Audio: this is the media-element path.
        prepareLoop: async () => null,
        onStatus: () => {},
      },
      { windowSecs: 60, tickMs: 5, toneDelayMs: 0 },
    );
  });

  afterEach(() => {
    transport.dispose();
  });

  it('seeks inside a long loop by loading the window that HOLDS the target', async () => {
    transport.play(0, { start: 0, end: DURATION });
    await flush();
    expect(el.sounding).toBe(true);

    // Clicking at 200 s used to load the loop's HEAD window and then ask
    // the element for 200 s into it: past the end, so it ended at once and
    // chained into the next window, and the next, silently forever.
    transport.seek(200);
    await flush(6);
    expect(renders).toEqual([
      { start: 0, len: 60 },
      { start: 200, len: 60 },
    ]);
    expect(transport.playhead).toBe(200);
    expect(el.sounding).toBe(true);
  });

  it('never leaves a seek behind for the next window to apply', async () => {
    // A short loop enters at its phase, which is a real seek…
    transport.play(0, { start: 100, end: 130 });
    await flush();
    transport.seek(120);
    // …and the window is REPLACED WHILE THAT LOAD IS STILL IN FLIGHT
    // (microtasks only: the render resolves, the blob has not loaded).
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(el.loaded).toBe(false);
    transport.setLoop({ start: 100, end: 104 });
    await flush(6);
    expect(renders[renders.length - 1]).toEqual({ start: 100, len: 4 });
    // The stale 20 s offset must not land on this 4 s window.
    expect(el.currentTime).toBeLessThanOrEqual(4);
    expect(el.sounding).toBe(true);
    expect(transport.playing).toBe(true);
  });

  it('keeps sounding through a selection drag', async () => {
    transport.play(0, { start: 0, end: DURATION });
    await flush();
    // mousedown seeks, then every mousemove re-arms the growing loop.
    transport.seek(100);
    for (let end = 100.5; end <= 108; end += 0.5) transport.setLoop({ start: 100, end });
    await flush(8);
    expect(renders[renders.length - 1]).toEqual({ start: 100, len: 8 });
    expect(el.sounding).toBe(true);
    expect(transport.playing).toBe(true);
  });
});
