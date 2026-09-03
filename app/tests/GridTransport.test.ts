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

  // A CURSOR OUTSIDE THE LOOP IS A PLACE TO PLAY FROM. Cueing there used
  // to be clamped into the loop, so putting the playhead before a loop
  // and hitting play jumped straight to the loop's start and the lead-in
  // was never heard.
  it('plays the lead-in before a loop, and only then falls into it', async () => {
    // Loop 8..12, cued at the top of the grid: 4 s of lead-in at 120 bpm.
    await transport.play(gridWith({ loop: { start: 8, end: 12 } }), CLIPS, 32, 0);
    await advance(1);
    const early = transport.status().column;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(8);
    // Six seconds in, the lead-in is over and the loop has it.
    await advance(5);
    const later = transport.status();
    expect(later.playing).toBe(true);
    expect(later.column).toBeGreaterThanOrEqual(8);
    expect(later.column).toBeLessThan(12);
  });

  it('cued PAST the loop, plays out the grid and then loops', async () => {
    // Loop 0..4 with the cursor at beat 12 of 16: the tail is 2 s, and
    // there is no loop end ahead to fall into until the grid runs out.
    await transport.play(gridWith({ beats: 16, loop: { start: 0, end: 4 } }), CLIPS, 16, 12);
    await advance(1);
    expect(transport.status().column).toBeGreaterThan(12);
    await advance(2.5);
    const later = transport.status();
    expect(later.playing).toBe(true);
    expect(later.column).toBeLessThan(4);
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

  // MOVING THE LOOP IS NOT A REASON TO MOVE THE PLAYBACK. The loop says
  // where the pass in flight ends and where the next one starts — both
  // ahead of the playhead — so re-marking it, over and over as a drag
  // does, must leave the playhead exactly where it was.
  it('does not move the playhead when the loop is dragged about', async () => {
    await transport.play(gridWith({ loop: { start: 0, end: 16 } }), CLIPS, 32);
    await advance(3);
    // A re-cue is a new play, and a new play cuts every voice in flight:
    // whatever else moving the loop does, it must not do that.
    const recue = vi.spyOn(transport, 'play');
    // Every column a drag across the ruler passes through, handed over
    // as the page hands it over: the playhead does not budge for any.
    for (const loop of [
      { start: 4, end: 16 },
      { start: 4, end: 12 },
      { start: 6, end: 12 },
      { start: 8, end: 24 },
      { start: 8, end: 20 },
    ]) {
      const before = transport.status().column;
      transport.update(gridWith({ loop }), CLIPS, 32);
      expect(transport.playing).toBe(true);
      expect(transport.status().column).toBeCloseTo(before, 6);
      expect(recue).not.toHaveBeenCalled();
    }
    // And it is still running from there, not from anywhere the loop
    // was dragged past.
    const at = transport.status().column;
    await advance(0.5);
    expect(transport.status().column).toBeGreaterThan(at);
  });

  it('wraps where the loop end has been moved TO, not where it was', async () => {
    // A 4-beat loop is 2 s at 120 bpm; opened out to 8 beats it is 4 s.
    await transport.play(gridWith({ loop: { start: 0, end: 4 } }), CLIPS, 32);
    await advance(1);
    transport.update(gridWith({ loop: { start: 0, end: 8 } }), CLIPS, 32);
    // Past the old wrap at 2 s: a transport still ending its pass there
    // would have gone back to the top.
    await advance(2);
    expect(transport.status().column).toBeGreaterThan(4);
    // The new end is where it comes round.
    await advance(2);
    const later = transport.status();
    expect(later.playing).toBe(true);
    expect(later.column).toBeLessThan(4);
  });

  // The wrap is committed to the clock a lookahead BEFORE it is heard,
  // so a loop moved inside that window has to take the pass that was
  // already scheduled back.
  it('takes back a wrap already scheduled when the loop moves first', async () => {
    await transport.play(gridWith({ loop: { start: 0, end: 4 } }), CLIPS, 32);
    // 1.9 s in, with the wrap at 2.05 s already laid down.
    await advance(1.9);
    transport.update(gridWith({ loop: { start: 0, end: 8 } }), CLIPS, 32);
    await advance(1.5);
    expect(transport.status().column).toBeGreaterThan(4);
  });

  // A loop dragged BEHIND the playhead cannot be honoured without a jump
  // backwards, and a jump is the one thing the loop is not allowed to
  // do: the pass plays out the grid and falls into the loop at the end,
  // the same as a play cued past it.
  it('plays on to the end of the grid when the loop lands behind it', async () => {
    await transport.play(gridWith({ beats: 16, loop: { start: 0, end: 16 } }), CLIPS, 16);
    await advance(4);
    const before = transport.status().column;
    expect(before).toBeGreaterThan(7);
    transport.update(gridWith({ beats: 16, loop: { start: 0, end: 4 } }), CLIPS, 16);
    expect(transport.status().column).toBeCloseTo(before, 6);
    await advance(1);
    expect(transport.status().column).toBeGreaterThan(before);
    // The grid runs out at 8 s, and THAT is where the loop takes over.
    await advance(4.5);
    const later = transport.status();
    expect(later.playing).toBe(true);
    expect(later.column).toBeLessThan(4);
  });

  it('a loop cleared mid-play leaves the playhead where it is', async () => {
    await transport.play(gridWith({ loop: { start: 0, end: 8 } }), CLIPS, 32);
    await advance(3);
    const before = transport.status().column;
    transport.update(gridWith({ loop: null }), CLIPS, 32);
    expect(transport.playing).toBe(true);
    expect(transport.status().column).toBeCloseTo(before, 6);
    // Nothing to come round to any more: it walks on into the grid past
    // where the loop used to end.
    await advance(2);
    expect(transport.status().column).toBeGreaterThan(8);
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
   *  many of them. */
  offset: number;
  duration: number;
  /** How long the buffer under it is: a capture (loop plus both
   *  bookends) is longer than the loop a bare source hands over, which is
   *  how the two are told apart below. */
  bufferSecs: number;
}

let voices: FakeVoice[] = [];
let ctxTime = 0;

/** A bleed bookend's seconds in a capture — long enough to place, far
 *  shorter than the 8 s of loop it brackets. */
const BLEED_SECS = 0.25;
/** The bytes a CAPTURE is handed over as, and the seconds they decode
 *  to: the loop with a bookend either side of it. */
const CAPTURE_BYTES = 24;
const CAPTURE_SECS = 8 + 2 * BLEED_SECS;

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
        bufferSecs: 0,
      };
      return {
        set buffer(buffer: { duration: number }) {
          voice.bufferSecs = buffer.duration;
        },
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
    // A capture and a bare loop are handed over with different numbers
    // of bytes, so the decode can give each its own length.
    decodeAudioData(bytes: ArrayBuffer) {
      const duration = bytes.byteLength === CAPTURE_BYTES ? CAPTURE_SECS : 8;
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

  // WHAT IS SOUNDING WHEN THE LOOP MOVES KEEPS SOUNDING. Only the wrap
  // that had been committed to the clock — and never heard — is taken
  // back, because it is no longer where the loop says it is.
  it('cuts nothing that is already sounding when the loop is re-marked', async () => {
    const rows = [
      placeClip(
        placeClip({ id: 'row1', clipId: 'c1', placements: [], levels: [] }, CLIP, 0),
        CLIP,
        4,
      ),
    ];
    const loop = { start: 0, end: 8 };
    await audio.play(gridWith({ rows, loop }), CLIPS, 32);
    await settle();
    // 3.9 s in: the copy on beat 4 is in the air and the wrap at 4.05 s
    // has been laid down ahead of it.
    ctxTime = 3.9;
    await settle();
    const sounding = voices.filter(
      (v) => v.startedAt <= ctxTime && v.startedAt + v.duration > ctxTime,
    );
    const committed = voices.filter((v) => v.startedAt > ctxTime);
    expect(sounding.length).toBeGreaterThan(0);
    expect(committed.length).toBeGreaterThan(0);

    audio.update(gridWith({ rows, loop: { start: 0, end: 16 } }), CLIPS, 32);
    await settle();

    expect(sounding.every((v) => v.stoppedAt === null)).toBe(true);
    expect(committed.every((v) => v.stoppedAt !== null)).toBe(true);
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
// The bleed either side of a copy
// ---------------------------------------------------------------------------

// The bleed goes back where the material came from: the left bookend
// ENDS on a copy's first beat, the right one STARTS where its last beat
// ends. A copy on its own is heard as lead-in, clip, tail-out. Two
// copies back to back put the first one's tail-out and the second one's
// lead-in ON the join — which is precisely the overlay a looping player
// makes of its seam, and why no copy ever carries its own right bleed at
// its head or its own left bleed at its tail.

describe('GridTransport bleed', () => {
  let audio: GridTransport;
  let capture: ReturnType<typeof vi.fn>;

  function source(withBleed = true) {
    // The clip and its bleed come over as ONE capture: the bookends are
    // windows on it, not fetches of their own.
    capture = vi.fn().mockResolvedValue({
      bytes: new ArrayBuffer(CAPTURE_BYTES),
      leadSecs: BLEED_SECS,
      tailSecs: BLEED_SECS,
    });
    const loops = { audio: vi.fn().mockResolvedValue(new ArrayBuffer(16)) };
    return withBleed ? { ...loops, capture } : loops;
  }

  /** A row playing one copy of the 4-beat clip at each of `cols`. */
  function run(...cols: number[]): GridState {
    const empty: GridRow = { id: 'row1', clipId: 'c1', placements: [], levels: [] };
    return {
      ...emptyGrid(120),
      rows: [cols.reduce((row, col) => placeClip(row, CLIP, col), empty)],
    };
  }

  /** The bookends that reached Web Audio, in start order. A bookend is a
   *  window of at most a quarter second on the capture; a copy of the
   *  4-beat clip is 2 s of it. */
  function bookends() {
    return voices.filter((v) => v.duration <= BLEED_SECS).sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Where the clips themselves were started. */
  function loops() {
    return voices.filter((v) => v.duration > BLEED_SECS).map((v) => v.startedAt);
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

  it('plays a lone copy as lead-in, clip, tail-out', async () => {
    // Column 8 at 120 bpm is 4 s in, and the pass is cued 50 ms ahead.
    await audio.play(run(8), CLIPS, 32);
    await settle();
    expect(loops()).toEqual([4.05]);
    // The left bookend ENDS where the clip begins; the right one starts
    // where it ends.
    expect(bookends().map((v) => v.startedAt)).toEqual([4.05 - BLEED_SECS, 4.05 + 2]);
    // Each one is read from where its material lies in the capture: the
    // lead-in at the front of it, the tail-out after the loop.
    expect(bookends().map((v) => v.offset)).toEqual([0, CAPTURE_SECS - BLEED_SECS]);
    // And the copy itself is the loop between them, never its own bleed.
    expect(voices.filter((v) => v.duration > BLEED_SECS).map((v) => v.offset)).toEqual([
      BLEED_SECS,
    ]);
  });

  it('puts a tail-out and a lead-in on the join between two copies', async () => {
    await audio.play(run(4, 8), CLIPS, 32);
    await settle();
    expect(loops()).toEqual([2.05, 4.05]);
    // Lead-in, then the join carrying the first copy's tail-out and the
    // second's lead-in at once, then the tail-out of the run.
    for (const [i, at] of [1.8, 3.8, 4.05, 6.05].entries()) {
      expect(bookends()[i].startedAt).toBeCloseTo(at, 6);
    }
    expect(bookends()).toHaveLength(4);
  });

  it('trims a lead-in that reaches back before the clock, rather than dropping it', async () => {
    // A copy on the very first beat is cued 50 ms out, so only the last
    // 50 ms of its quarter-second lead-in can still be played.
    await audio.play(run(0), CLIPS, 32);
    await settle();
    const [lead] = bookends();
    expect(lead.startedAt).toBe(0);
    expect(lead.offset).toBeCloseTo(BLEED_SECS - 0.05, 6);
    expect(lead.duration).toBeCloseTo(0.05, 6);
  });

  it('asks for the capture once, however many copies want its bleed', async () => {
    await audio.play(run(0, 4, 8), CLIPS, 32);
    await settle();
    // Three copies, six bookends — but at one tempo that is ONE render,
    // which is the point of filing the bleed in the clip's own file.
    expect(capture.mock.calls).toEqual([['c1', 120]]);
  });

  // A LOOP'S WRAP IS A JOIN LIKE ANY OTHER. The last copy's tail-out
  // starts where the loop comes round, over the head of the next time
  // through, and the first copy's lead-in of that next pass reaches back
  // over the tail of this one — which is why a pass has to be committed
  // a lead-in before it begins, not merely a lookahead.
  it('carries the bleed across the wrap of a loop', async () => {
    const state = { ...run(0), loop: { start: 0, end: 4 } };
    await audio.play(state, CLIPS, 32);
    await settle();
    // The loop is 2 s: pass one at 0.05, pass two at 2.05.
    ctxTime = 1.7;
    await settle();

    expect(loops()).toEqual([0.05, 2.05]);
    // Pass one's tail-out lands on the wrap, and pass two's lead-in
    // reaches back before it — the two sides of the join, whole, neither
    // of them trimmed.
    const wrap = bookends().filter((v) => v.startedAt > 1 && v.startedAt < 3);
    expect(wrap.map((v) => v.startedAt)).toEqual([2.05 - BLEED_SECS, 2.05]);
    expect(wrap.map((v) => v.offset)).toEqual([0, CAPTURE_SECS - BLEED_SECS]);
    expect(wrap.map((v) => v.duration)).toEqual([BLEED_SECS, BLEED_SECS]);
  });

  // A play that runs off the end of the arrangement is not a STOP: the
  // tail-out of the last copy hangs over that end by design, and cutting
  // it would take back the very thing it is there for. A stop the page
  // asks for still cuts.
  it('lets the last tail-out ring out past the end of a one-shot play', async () => {
    await audio.play(run(0), CLIPS, 4);
    await settle();
    const tail = bookends().at(-1)!;
    expect(tail.startedAt).toBeCloseTo(2.05, 6);

    ctxTime = 2.1;
    expect(audio.status()).toEqual({ playing: false, column: 4 });
    expect(tail.stoppedAt).toBeNull();

    audio.stop();
    expect(tail.stoppedAt).not.toBeNull();
  });

  it('plays the run anyway where the clip was filed without bleed', async () => {
    // A capture of a clip with no bleed is the loop and nothing either
    // side of it.
    capture.mockResolvedValue({
      bytes: new ArrayBuffer(16),
      leadSecs: 0,
      tailSecs: 0,
    });
    await audio.play(run(0, 4), CLIPS, 32);
    await settle();
    expect(bookends()).toEqual([]);
    expect(loops()).toHaveLength(2);
  });

  it('plays the loops bare for a source that cannot hand a capture over', async () => {
    audio.dispose();
    audio = new GridTransport(source(false));
    await audio.play(run(0, 4), CLIPS, 32);
    await settle();
    expect(voices.map((v) => v.bufferSecs)).toEqual([8, 8]);
    expect(voices.map((v) => v.offset)).toEqual([0, 0]);
  });
});
