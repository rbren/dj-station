// The Grid transport's clock, headless. jsdom has no AudioContext, so
// the transport falls back to the wall clock and every pass is silent —
// which is exactly the part worth pinning here: WHERE the playhead is
// after so much time, that a loop wraps to the loop's start (not the
// grid's), that a one-shot play stops itself at the end, and that the
// tempo envelope is what the playhead is read through.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BeatClipEntry } from '../src/beatClip';
import {
  emptyGrid,
  placeClip,
  setLevelPoint,
  setTempoPoint,
  type GridRow,
  type GridState,
} from '../src/grid';
import { GridTransport } from '../src/gridTransport';

function clip(over: Partial<BeatClipEntry> = {}): BeatClipEntry {
  return {
    clipId: 'c1',
    name: 'main drums',
    bpm: 120,
    beats: 4,
    stems: ['drums'],
    editable: true,
    ones: [0],
    sources: [{ trackHash: 'h1', title: 'Basement Loop', artist: 'Nadia' }],
    ...over,
  };
}

const CLIP = clip();
const CLIPS = new Map([[CLIP.clipId, CLIP]]);

function gridWith(over: Partial<GridState> = {}): GridState {
  return {
    ...emptyGrid(120),
    rows: [placeClip({ id: 'row1', clipId: 'c1', placements: [], levels: [] }, CLIP, 0)],
    ...over,
  };
}

const source = { audio: vi.fn().mockResolvedValue(null) };

/** Wind the fake clock forward by `secs`, running the schedule timer. */
async function advance(secs: number) {
  await vi.advanceTimersByTimeAsync(secs * 1000);
}

/** A fake-timer transport, disposed after each test. Shared by every
 *  block below so they all measure the same clock. */
let transport: GridTransport;

beforeEach(() => {
  vi.useFakeTimers();
  transport = new GridTransport(source);
});

afterEach(() => {
  transport.dispose();
  vi.useRealTimers();
});

describe('GridTransport', () => {
  it('is stopped, at the start, before anything is played', () => {
    expect(transport.status()).toEqual({ playing: false, column: 0 });
  });

  it('walks the grid at the master tempo', async () => {
    await transport.play(gridWith(), CLIPS, 32);
    expect(transport.playing).toBe(true);
    // 120 bpm = 2 beats a second; the play is cued a moment ahead, so the
    // column is read to the beat rather than to the sample.
    await advance(4);
    expect(transport.status().column).toBeGreaterThan(6.5);
    expect(transport.status().column).toBeLessThan(8.5);
  });

  it('reads the playhead THROUGH the tempo envelope', async () => {
    // Half tempo: half as far in the same time.
    const slow = gridWith({ tempo: { bpm: 60, points: [] } });
    await transport.play(slow, CLIPS, 32);
    await advance(4);
    expect(transport.status().column).toBeGreaterThan(2.5);
    expect(transport.status().column).toBeLessThan(4.5);
  });

  it('starts where it is told to', async () => {
    await transport.play(gridWith(), CLIPS, 32, 16);
    expect(transport.status().column).toBeGreaterThanOrEqual(16);
  });

  it('stops itself at the end of a grid with no loop', async () => {
    // 8 columns at 120 bpm is 4 s of grid.
    await transport.play(gridWith({ beats: 8 }), CLIPS, 8);
    await advance(3);
    expect(transport.status().playing).toBe(true);
    await advance(3);
    expect(transport.status().playing).toBe(false);
    expect(transport.status().column).toBe(8);
  });

  it('wraps to the LOOP start, not the grid start', async () => {
    // Loop 4..8: 2 s a pass at 120 bpm.
    await transport.play(gridWith({ loop: { start: 4, end: 8 } }), CLIPS, 32);
    await advance(1);
    const first = transport.status().column;
    expect(first).toBeGreaterThanOrEqual(4);
    expect(first).toBeLessThan(8);
    // Three passes later it is still inside the loop, not off the end.
    await advance(6);
    const later = transport.status();
    expect(later.playing).toBe(true);
    expect(later.column).toBeGreaterThanOrEqual(4);
    expect(later.column).toBeLessThan(8);
  });

  it('stop parks the playhead and plays nothing more', async () => {
    await transport.play(gridWith(), CLIPS, 32);
    await advance(2);
    transport.stop();
    const at = transport.status().column;
    expect(transport.status().playing).toBe(false);
    await advance(4);
    expect(transport.status().column).toBe(at);
  });

  it('playing again re-cues rather than layering', async () => {
    await transport.play(gridWith(), CLIPS, 32);
    await advance(3);
    await transport.play(gridWith(), CLIPS, 32);
    expect(transport.status().column).toBeLessThan(1);
  });

  it('a tempo ramp gets there faster than its start tempo would', async () => {
    let tempo = setTempoPoint(emptyGrid(120).tempo, 0, 120);
    tempo = setTempoPoint(tempo, 16, 240);
    await transport.play(gridWith({ tempo }), CLIPS, 32);
    await advance(4);
    // Flat 120 would be at column 8; the ramp has run past it.
    expect(transport.status().column).toBeGreaterThan(8);
  });

  it('refuses to play after disposal', async () => {
    transport.dispose();
    await transport.play(gridWith(), CLIPS, 32);
    expect(transport.playing).toBe(false);
  });
});

// LIVE EDITING. The grid is playable while it is edited, which is the
// point of a page like this: you place a clip and hear it come round.
describe('GridTransport live editing', () => {
  it('keeps playing, and keeps its place, when a clip is placed mid-play', async () => {
    await transport.play(gridWith(), CLIPS, 32);
    await advance(3);
    const before = transport.status().column;
    // Another copy, further down the grid than the playhead has reached.
    const edited = gridWith({
      rows: [
        placeClip(
          placeClip({ id: 'row1', clipId: 'c1', placements: [], levels: [] }, CLIP, 0),
          CLIP,
          16,
        ),
      ],
    });
    transport.update(edited, CLIPS, 32);
    expect(transport.playing).toBe(true);
    // The playhead did NOT jump: a placement is spliced into the pass in
    // flight rather than re-cueing it.
    expect(transport.status().column).toBeGreaterThanOrEqual(before);
    expect(transport.status().column).toBeLessThan(before + 1);
  });

  // A tempo change cannot be spliced in — every start time in the pass
  // is measured through the envelope — so it re-cues from where the
  // playhead is rather than silently playing the old timing.
  it('re-cues from the playhead when the tempo changes mid-play', async () => {
    await transport.play(gridWith(), CLIPS, 32);
    await advance(4);
    const before = transport.status().column;
    expect(before).toBeGreaterThan(1);
    transport.update(gridWith({ tempo: setTempoPoint(emptyGrid(120).tempo, 0, 180) }), CLIPS, 32);
    expect(transport.playing).toBe(true);
    // It picks up where it was, not back at the top.
    expect(transport.status().column).toBeGreaterThanOrEqual(before - 1);
  });

  it('follows a loop set mid-play instead of walking the whole grid', async () => {
    await transport.play(gridWith(), CLIPS, 32);
    await advance(1);
    transport.update(gridWith({ loop: { start: 0, end: 4 } }), CLIPS, 32);
    // Well past the 4-beat loop's 2 s: a transport still walking the
    // whole grid would be far beyond column 4.
    await advance(6);
    expect(transport.playing).toBe(true);
    expect(transport.status().column).toBeLessThan(4);
  });

  it('an edit while stopped changes nothing about being stopped', () => {
    transport.update(gridWith(), CLIPS, 32);
    expect(transport.playing).toBe(false);
  });

  // A stop the page asked for WINS over a re-cue still in flight —
  // leaving the page is a stop, and the pending play must not undo it.
  it('a stop during a re-cue stays stopped', async () => {
    await transport.play(gridWith(), CLIPS, 32);
    await advance(2);
    transport.update(gridWith({ loop: { start: 0, end: 8 } }), CLIPS, 32);
    transport.stop();
    await advance(1);
    expect(transport.playing).toBe(false);
  });
});

describe('GridTransport pause', () => {
  it('keeps the place, so playing again resumes there', async () => {
    await transport.play(gridWith(), CLIPS, 32);
    await advance(3);
    const at = transport.pause();
    expect(transport.playing).toBe(false);
    expect(at).toBeGreaterThan(1);
    // The place SURVIVES the pause: that is the whole difference from a
    // stop, which leaves the next play to say where to start.
    expect(transport.status().column).toBeCloseTo(at, 6);
  });

  it('seek parks the playhead while stopped', () => {
    transport.seek(12);
    expect(transport.status().column).toBe(12);
    expect(transport.playing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What actually reaches Web Audio
// ---------------------------------------------------------------------------

// The tests above run without an AudioContext, which pins the clock but
// leaves every pass silent. These build a RECORDING one, so the voices
// themselves can be inspected: what was scheduled, what was called back
// when the grid changed underneath it, and what gain was written.

interface FakeVoice {
  startedAt: number;
  stoppedAt: number | null;
  gain: string[];
  /** What `start` was told to play: seconds into the buffer, and how
   *  many of them. A bleed bookend is a much shorter one than a loop,
   *  which is how the two are told apart below. */
  offset: number;
  duration: number;
}

let voices: FakeVoice[] = [];
let ctxTime = 0;

/** A bleed bookend's bytes and the seconds they decode to — long enough
 *  to place, far shorter than the 8 s the loop decodes to. */
const BLEED_BYTES = 8;
const BLEED_SECS = 0.25;

class FakeParam {
  #log: string[];
  constructor(log: string[]) {
    this.#log = log;
  }
  setValueAtTime(v: number, t: number) {
    this.#log.push(`set ${v.toFixed(2)}@${t.toFixed(2)}`);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.#log.push(`ramp ${v.toFixed(2)}@${t.toFixed(2)}`);
  }
  cancelScheduledValues(t: number) {
    this.#log.push(`cancel@${t.toFixed(2)}`);
  }
}

function fakeContext() {
  return class {
    destination = {};
    sampleRate = 48000;
    state = 'running';
    get currentTime() {
      return ctxTime;
    }
    createGain() {
      const log: string[] = [];
      return { gain: new FakeParam(log), log, connect() {}, disconnect() {} };
    }
    createBufferSource() {
      const voice: FakeVoice = {
        startedAt: -1,
        stoppedAt: null,
        gain: [],
        offset: 0,
        duration: 0,
      };
      return {
        buffer: null,
        onended: null,
        playbackRate: { value: 1 },
        connect(dest: { log?: string[] }) {
          if (dest.log) voice.gain = dest.log;
        },
        disconnect() {},
        start(at: number, offset = 0, duration = 0) {
          voice.startedAt = at;
          voice.offset = offset;
          voice.duration = duration;
          voices.push(voice);
        },
        stop(at?: number) {
          voice.stoppedAt = at ?? ctxTime;
        },
      };
    }
    // Loops and bleed bookends are asked for with different numbers of
    // bytes, so the decode can hand each its own length.
    decodeAudioData(bytes: ArrayBuffer) {
      const duration = bytes.byteLength === BLEED_BYTES ? BLEED_SECS : 8;
      return Promise.resolve({
        duration,
        length: duration * 48000,
        sampleRate: 48000,
      });
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  };
}

describe('GridTransport voices', () => {
  let audio: GridTransport;
  const withAudio = { audio: vi.fn().mockResolvedValue(new ArrayBuffer(16)) };

  beforeEach(() => {
    voices = [];
    ctxTime = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext = fakeContext();
    audio = new GridTransport(withAudio);
  });

  afterEach(() => {
    audio.dispose();
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  /** Let the render land and the pump run. */
  async function settle() {
    await vi.advanceTimersByTimeAsync(200);
  }

  it('stops a voice taken off the grid before it has sounded', async () => {
    const loop = { start: 0, end: 8 };
    const state = gridWith({ loop });
    await audio.play(state, CLIPS, 32);
    await settle();
    const scheduled = voices.filter((v) => v.startedAt >= 0);
    expect(scheduled.length).toBeGreaterThan(0);
    // Everything here is still in the FUTURE: that is the window the bug
    // lived in, where the audio was committed but not yet heard.
    expect(scheduled.every((v) => v.startedAt >= ctxTime)).toBe(true);

    const emptied = gridWith({ loop, rows: [{ ...state.rows[0], placements: [] }] });
    audio.update(emptied, CLIPS, 32);
    await settle();

    expect(scheduled.every((v) => v.stoppedAt !== null)).toBe(true);
  });

  it('lays a clip down again when it comes back', async () => {
    const loop = { start: 0, end: 8 };
    const state = gridWith({ loop });
    await audio.play(state, CLIPS, 32);
    await settle();
    const before = voices.length;

    const emptied = gridWith({ loop, rows: [{ ...state.rows[0], placements: [] }] });
    audio.update(emptied, CLIPS, 32);
    await settle();
    audio.update(state, CLIPS, 32);
    await settle();

    // The copy was un-laid along with its voice, so it is free to sound.
    expect(voices.length).toBeGreaterThan(before);
    expect(voices.some((v) => v.stoppedAt === null)).toBe(true);
  });

  it('writes a row level onto the voice it belongs to', async () => {
    let row = gridWith().rows[0];
    row = setLevelPoint(row, 0, 1);
    row = setLevelPoint(row, 4, 0);
    await audio.play(gridWith({ rows: [row] }), CLIPS, 32);
    await settle();
    const sounded = voices.find((v) => v.gain.length > 0);
    expect(sounded).toBeDefined();
    // A fade is a RAMP, not a step.
    expect(sounded?.gain.some((g) => g.startsWith('ramp 0.00'))).toBe(true);
  });

  it('re-levels a voice that was already scheduled', async () => {
    const state = gridWith({ loop: { start: 0, end: 8 } });
    await audio.play(state, CLIPS, 32);
    await settle();
    expect(voices.some((v) => v.startedAt >= 0)).toBe(true);

    // Draw a level line WHILE it plays: the old voices were committed at
    // full level, so the change is only heard if they are revisited.
    const faded = setLevelPoint(state.rows[0], 0, 0.25);
    audio.update(gridWith({ ...state, rows: [faded] }), CLIPS, 32);
    await settle();

    expect(voices.some((v) => v.gain.some((g) => g.includes('0.25')))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The bleed over a seam
// ---------------------------------------------------------------------------

// Two copies of a row running straight into each other are two passes of
// one loop, and the join between them is a SEAM: the clip's right bleed
// (the material that followed it in its track) goes over the head of the
// second copy, its left bleed over the tail of the first. A run's own
// ends are not seams — a first pass has nothing to carry in, a last pass
// nothing to lean into — which is the rule the engine's player and the
// Clip page's preview both follow.

describe('GridTransport bleed', () => {
  let audio: GridTransport;
  let bleed: ReturnType<typeof vi.fn>;

  function source(withBleed = true) {
    bleed = vi.fn().mockResolvedValue(new ArrayBuffer(BLEED_BYTES));
    const loops = { audio: vi.fn().mockResolvedValue(new ArrayBuffer(16)) };
    return withBleed ? { ...loops, bleed } : loops;
  }

  /** A row playing one copy of the 4-beat clip at each of `cols`. */
  function run(...cols: number[]): GridState {
    const empty: GridRow = { id: 'row1', clipId: 'c1', placements: [], levels: [] };
    return {
      ...emptyGrid(120),
      rows: [cols.reduce((row, col) => placeClip(row, CLIP, col), empty)],
    };
  }

  /** The bookends that reached Web Audio, in start order. */
  function bookends() {
    return voices
      .filter((v) => v.duration === BLEED_SECS)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  function loops() {
    return voices.filter((v) => v.duration === 2).map((v) => v.startedAt);
  }

  async function settle() {
    await vi.advanceTimersByTimeAsync(200);
  }

  beforeEach(() => {
    voices = [];
    ctxTime = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext = fakeContext();
    audio = new GridTransport(source());
  });

  afterEach(() => {
    audio.dispose();
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it('lays each bookend on the seam it belongs to', async () => {
    await audio.play(run(0, 4), CLIPS, 32);
    await settle();

    // 120 bpm: each copy is 2 s long, and the pass is cued 50 ms ahead.
    expect(loops()).toEqual([0.05, 2.05]);
    // The left bleed ENDS on the join and the right one starts there:
    // the seam is overlaid from both sides, and neither the run's head
    // nor its tail carries anything.
    expect(bookends().map((v) => v.startedAt)).toEqual([2.05 - BLEED_SECS, 2.05]);
    expect(bookends().map((v) => v.offset)).toEqual([0, 0]);
  });

  it('asks for each side a seam needs, once', async () => {
    await audio.play(run(0, 4, 8), CLIPS, 32);
    await settle();
    // Three copies are two seams, and both of them want both bookends —
    // at one tempo that is two renders, not four.
    expect([...bleed.mock.calls].sort()).toEqual([
      ['c1', 'left', 120],
      ['c1', 'right', 120],
    ]);
  });

  it('plays no bleed on a copy nothing runs into or out of', async () => {
    await audio.play(run(8), CLIPS, 32);
    await settle();
    expect(bleed).not.toHaveBeenCalled();
    expect(bookends()).toEqual([]);
    expect(loops()).toHaveLength(1);
  });

  it('plays the run anyway where the clip was filed without bleed', async () => {
    bleed.mockResolvedValue(null);
    await audio.play(run(0, 4), CLIPS, 32);
    await settle();
    expect(bookends()).toEqual([]);
    expect(loops()).toHaveLength(2);
  });

  it('plays the loops bare for a source that cannot hand bleed over', async () => {
    audio.dispose();
    audio = new GridTransport(source(false));
    await audio.play(run(0, 4), CLIPS, 32);
    await settle();
    expect(voices.map((v) => v.duration)).toEqual([2, 2]);
  });
});
