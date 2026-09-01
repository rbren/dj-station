// The Grid transport's clock, headless. jsdom has no AudioContext, so
// the transport falls back to the wall clock and every pass is silent —
// which is exactly the part worth pinning here: WHERE the playhead is
// after so much time, that a loop wraps to the loop's start (not the
// grid's), that a one-shot play stops itself at the end, and that the
// tempo envelope is what the playhead is read through.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BeatClipEntry } from '../src/beatClip';
import { emptyGrid, placeClip, setTempoPoint, type GridState } from '../src/grid';
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
      rows: [placeClip(placeClip({ id: 'row1', clipId: 'c1', placements: [], levels: [] }, CLIP, 0), CLIP, 16)],
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
