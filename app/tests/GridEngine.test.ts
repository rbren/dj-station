// The Grid page's end of engine playback: what an arrangement compiles
// into for `grid_sync`, and the command traffic a transport gesture
// makes. The engine plays the grid, so what is pinned here is the
// CONTRACT with it — the document it is sent, and that a play is never
// ordered before the document it plays.

import { afterEach, describe, expect, it } from 'vitest';
import type { BeatClipEntry } from '../src/beatClip';
import { EngineGridPlayer, syncDoc } from '../src/gridEngine';
import { emptyGrid, type GridState } from '../src/grid';

function clip(over: Partial<BeatClipEntry> = {}): BeatClipEntry {
  return {
    clipId: 'c1',
    name: 'main drums',
    bpm: 120,
    beats: 4,
    stems: ['drums'],
    editable: true,
    ones: [0],
    sources: [],
    rev: 'r1',
    ...over,
  };
}

const CLIPS = new Map([['c1', clip()]]);

function grid(over: Partial<GridState> = {}): GridState {
  return {
    ...emptyGrid(120),
    rows: [{ id: 'row1', clipId: 'c1', placements: [4, 0], levels: [] }],
    ...over,
  };
}

/** Every IPC call the player made, in order. */
function record() {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  window.__DJ_STRESS_INVOKE__ = (cmd, args) => {
    calls.push([cmd, args]);
    return Promise.resolve(cmd === 'grid_status' ? { beat: 6.5, playing: true, bpm: 120 } : null);
  };
  return calls;
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('syncDoc', () => {
  it('compiles a row into placements, a length and its chrome', () => {
    const doc = syncDoc(grid(), CLIPS, 32);
    expect(doc.rows).toEqual([
      {
        id: 'row1',
        clipId: 'c1',
        rev: 'r1',
        // Sorted: the modules read copies in order.
        placements: [0, 4],
        clipBeats: 4,
        levels: [],
        level: 1,
        pan: 0,
        // The default rack's Wetness. It says nothing yet — a row with
        // no rack behind it in the engine plays dry whatever the knob
        // is — but the document's value is what the session is given.
        wet: 1,
      },
    ]);
    expect(doc.bpm).toBe(120);
    // No loop: the range is the whole grid.
    expect([doc.rangeStart, doc.rangeEnd]).toEqual([0, 32]);
  });

  it('sends the loop as the play range, and the tempo lane with it', () => {
    const doc = syncDoc(
      grid({
        loop: { start: 8, end: 16 },
        tempo: { bpm: 120, points: [{ beat: 8, bpm: 140 }] },
      }),
      CLIPS,
      32,
    );
    expect([doc.rangeStart, doc.rangeEnd]).toEqual([8, 16]);
    expect(doc.tempoPoints).toEqual([{ beat: 8, bpm: 140 }]);
  });

  it('leaves out a row whose clip the store no longer has', () => {
    expect(syncDoc(grid(), new Map(), 32).rows).toEqual([]);
  });

  it('keeps the level line and its baseline apart', () => {
    const state = grid();
    state.rows[0].levels = [
      { beat: 0, level: 1 },
      { beat: 8, level: 0 },
    ];
    state.rows[0].fx = { level: 0.5, pan: -1, wet: 0.25, modules: [], wires: [] };
    const row = syncDoc(state, CLIPS, 32).rows[0];
    // The line is what was drawn; the knob is what it rides on. Folding
    // one into the other would make the Level knob edit the automation.
    expect(row.levels).toEqual([
      { beat: 0, level: 1 },
      { beat: 8, level: 0 },
    ]);
    expect([row.level, row.pan, row.wet]).toEqual([0.5, -1, 0.25]);
  });
});

describe('EngineGridPlayer', () => {
  afterEach(() => delete window.__DJ_STRESS_INVOKE__);

  it('syncs an edit once and says nothing when nothing changed', async () => {
    const calls = record();
    const player = new EngineGridPlayer();
    player.update(grid(), CLIPS, 32);
    player.update(grid(), CLIPS, 32);
    await flush();
    expect(calls.map(([cmd]) => cmd)).toEqual(['grid_sync']);
  });

  it('sends the document BEFORE the play that plays it', async () => {
    const calls = record();
    const player = new EngineGridPlayer();
    await player.play(grid({ tempo: { bpm: 120, points: [{ beat: 8, bpm: 160 }] } }), CLIPS, 32, 8);
    expect(calls.map(([cmd]) => cmd)).toEqual(['grid_sync', 'grid_transport']);
    // The cue, and the tempo the cue sits at — what lets the rows come
    // in on the transport's first beat.
    expect(calls[1][1]).toEqual({ playing: true, from: 8, startBpm: 160 });
  });

  it('reads the playhead off the engine while it agrees the music is running', async () => {
    record();
    const player = new EngineGridPlayer();
    await player.play(grid(), CLIPS, 32, 0);
    expect(player.status()).toEqual({ playing: true, column: 0 });
    await flush();
    expect(player.status()).toEqual({ playing: true, column: 6.5 });
  });

  it('drops a reading taken before the stop it disagrees with', async () => {
    record();
    const player = new EngineGridPlayer();
    await player.play(grid(), CLIPS, 32, 0);
    player.status();
    await flush();
    // The engine still reports itself playing (the command has not
    // landed): the page's own intent is what the page draws.
    const at = player.pause();
    expect(at).toBe(6.5);
    await flush();
    expect(player.status()).toEqual({ playing: false, column: 6.5 });
  });

  it('takes the session down with it', async () => {
    const calls = record();
    const player = new EngineGridPlayer();
    player.dispose();
    await flush();
    expect(calls.map(([cmd]) => cmd)).toEqual(['grid_transport', 'grid_teardown']);
  });
});
