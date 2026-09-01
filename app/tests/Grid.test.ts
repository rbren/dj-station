// The Grid page's arithmetic: rows grouped by track, placement anchored
// on a clip's first one, the master tempo envelope and the beat<->time
// integral over it, and what a player is handed for a span of columns.

import { describe, expect, it } from 'vitest';
import type { BeatClipEntry } from '../src/beatClip';
import {
  addRow,
  beatToSecs,
  bpmAt,
  cellKind,
  clearRow,
  emptyGrid,
  gridColumns,
  groupRows,
  leadOne,
  loopFromDrag,
  moveTempoPoint,
  placeClip,
  placementAt,
  playRange,
  removeRow,
  removeTempoPoint,
  scheduleRange,
  secsToBeat,
  setTempoPoint,
  type GridRow,
  type GridState,
} from '../src/grid';

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

function row(over: Partial<GridRow> = {}): GridRow {
  return { id: 'row1', clipId: 'c1', placements: [], ...over };
}

describe('grid rows', () => {
  it('loads a clip in as an EMPTY row — the row says what can play, not when', () => {
    const state = addRow(emptyGrid(), clip());
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].clipId).toBe('c1');
    expect(state.rows[0].placements).toEqual([]);
  });

  it('gives every row its own id, and removes by it', () => {
    let state = addRow(emptyGrid(), clip());
    state = addRow(state, clip({ clipId: 'c2' }));
    const ids = state.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    expect(removeRow(state, ids[0]).rows.map((r) => r.id)).toEqual([ids[1]]);
  });

  it('groups rows by the track their clips were cut from', () => {
    const a = clip({ clipId: 'a', sources: [{ trackHash: 'h1', title: 'One', artist: 'X' }] });
    const b = clip({ clipId: 'b', sources: [{ trackHash: 'h1', title: 'One', artist: 'X' }] });
    const c = clip({ clipId: 'c', sources: [{ trackHash: 'h2', title: 'Two', artist: 'Y' }] });
    const clips = new Map([a, b, c].map((x) => [x.clipId, x]));
    const rows = [
      row({ id: 'r1', clipId: 'a' }),
      row({ id: 'r2', clipId: 'c' }),
      row({ id: 'r3', clipId: 'b' }),
    ];
    const groups = groupRows(rows, clips);
    // Two groups, ONE title each, and the same-track rows together even
    // though they were added either side of the other track's.
    expect(groups.map((g) => g.title)).toEqual(['One', 'Two']);
    expect(groups[0].rows.map((r) => r.id)).toEqual(['r1', 'r3']);
    expect(groups[1].rows.map((r) => r.id)).toEqual(['r2']);
  });

  it('gathers the clips with no source under one heading', () => {
    const orphan = clip({ clipId: 'o', sources: [] });
    const groups = groupRows([row({ clipId: 'o' })], new Map([['o', orphan]]));
    expect(groups[0].title).toBe('no source recorded');
    expect(groups[0].hash).toBeNull();
  });
});

describe('placement', () => {
  it('centres the clip on the clicked cell by its FIRST ONE', () => {
    // 4 beats, the one is beat 1: clicking column 10 fills 9..12.
    const c = clip({ beats: 4, ones: [1] });
    expect(leadOne(c)).toBe(1);
    const placed = placeClip(row(), c, 10);
    expect(placed.placements).toEqual([9]);
    for (const col of [9, 10, 11, 12]) {
      expect(cellKind(placed, c, col)).not.toBe('empty');
    }
    expect(cellKind(placed, c, 8)).toBe('empty');
    expect(cellKind(placed, c, 13)).toBe('empty');
  });

  it('marks the ones, and the lead one where the click landed', () => {
    const c = clip({ beats: 8, ones: [1, 5] });
    const placed = placeClip(row(), c, 10);
    expect(cellKind(placed, c, 10)).toBe('lead');
    expect(cellKind(placed, c, 14)).toBe('one');
    expect(cellKind(placed, c, 11)).toBe('beat');
  });

  it('falls back to beat 0 for a clip whose grid marks no one', () => {
    const c = clip({ beats: 4, ones: [] });
    expect(leadOne(c)).toBe(0);
    expect(placeClip(row(), c, 10).placements).toEqual([10]);
  });

  it('clicking a placed cell takes that copy away again', () => {
    const c = clip({ beats: 4, ones: [1] });
    const placed = placeClip(row(), c, 10);
    expect(placeClip(placed, c, 12).placements).toEqual([]);
  });

  it('a row is one voice: a new copy displaces what it overlaps', () => {
    const c = clip({ beats: 4, ones: [0] });
    let r = placeClip(row(), c, 0); // 0..3
    r = placeClip(r, c, 8); // 8..11, no overlap
    expect(r.placements).toEqual([0, 8]);
    // Clicked on an empty cell, but the copy it lands reaches into 8..11,
    // which gives way — two copies of one row sounding at once is not
    // something the grid can mean.
    r = placeClip(r, c, 6); // 6..9
    expect(r.placements).toEqual([0, 6]);
    expect(placementAt(r, c, 10)).toBe(-1);
  });

  it('keeps a placement whose head runs off the left of the grid', () => {
    // The anchor is the musical fact; the left edge follows from it.
    const c = clip({ beats: 4, ones: [2] });
    expect(placeClip(row(), c, 1).placements).toEqual([-1]);
  });

  it('clears a row without unloading it', () => {
    const r = clearRow(placeClip(row(), clip(), 4));
    expect(r.placements).toEqual([]);
    expect(r.clipId).toBe('c1');
  });

  it('grows the grid to hold what is placed past its end', () => {
    const c = clip({ beats: 4, ones: [0] });
    const state: GridState = {
      ...emptyGrid(),
      beats: 32,
      rows: [placeClip(row(), c, 40)],
    };
    const clips = new Map([['c1', c]]);
    expect(gridColumns(state, clips)).toBe(44);
    // …and never shrinks below what the user asked for.
    expect(gridColumns({ ...state, rows: [row()] }, clips)).toBe(32);
  });
});

describe('master tempo', () => {
  it('is flat at the base value until something is drawn on it', () => {
    const tempo = emptyGrid(128).tempo;
    expect(bpmAt(tempo, 0)).toBe(128);
    expect(bpmAt(tempo, 999)).toBe(128);
    expect(beatToSecs(tempo, 128)).toBeCloseTo(60, 6);
  });

  it('interpolates between breakpoints and holds flat outside them', () => {
    let tempo = setTempoPoint(emptyGrid(120).tempo, 0, 120);
    tempo = setTempoPoint(tempo, 8, 180);
    expect(bpmAt(tempo, 4)).toBeCloseTo(150, 6);
    expect(bpmAt(tempo, -5)).toBeCloseTo(120, 6);
    expect(bpmAt(tempo, 100)).toBeCloseTo(180, 6);
  });

  it('a breakpoint dropped on an occupied beat MOVES it', () => {
    let tempo = setTempoPoint(emptyGrid().tempo, 8, 140);
    tempo = setTempoPoint(tempo, 8, 90);
    expect(tempo.points).toEqual([{ beat: 8, bpm: 90 }]);
  });

  it('a drag moves the point it grabbed, however the list renumbers', () => {
    let tempo = setTempoPoint(emptyGrid().tempo, 4, 100);
    tempo = setTempoPoint(tempo, 12, 160);
    // Drag the beat-4 point past the beat-12 one.
    tempo = moveTempoPoint(tempo, 4, 16, 100);
    expect(tempo.points).toEqual([
      { beat: 12, bpm: 160 },
      { beat: 16, bpm: 100 },
    ]);
  });

  it('removes the breakpoint nearest the beat asked for', () => {
    let tempo = setTempoPoint(emptyGrid().tempo, 4, 100);
    tempo = setTempoPoint(tempo, 20, 160);
    expect(removeTempoPoint(tempo, 19).points).toEqual([{ beat: 4, bpm: 100 }]);
  });

  it('clamps a breakpoint into the tempo range', () => {
    expect(setTempoPoint(emptyGrid().tempo, 0, 5000).points[0].bpm).toBe(300);
    expect(setTempoPoint(emptyGrid().tempo, 0, 1).points[0].bpm).toBe(20);
  });

  it('integrates a ramp instead of averaging it', () => {
    // 120 -> 240 over 4 beats. The average tempo (180) would say 4/3 s;
    // the integral is 60·4·ln(2)/120 = 1.386 s.
    let tempo = setTempoPoint(emptyGrid(120).tempo, 0, 120);
    tempo = setTempoPoint(tempo, 4, 240);
    expect(beatToSecs(tempo, 4)).toBeCloseTo((60 * 4 * Math.log(2)) / 120, 6);
    expect(beatToSecs(tempo, 4)).toBeGreaterThan(4 / 3);
  });

  it('round-trips beats to seconds and back through a ramp', () => {
    let tempo = setTempoPoint(emptyGrid(90).tempo, 2, 90);
    tempo = setTempoPoint(tempo, 10, 150);
    for (const beat of [0, 1, 2, 5.5, 10, 17.25]) {
      expect(secsToBeat(tempo, beatToSecs(tempo, beat))).toBeCloseTo(beat, 5);
    }
  });
});

describe('loop and play range', () => {
  it('a drag marks whole columns, either direction, at least one wide', () => {
    expect(loopFromDrag(4, 9)).toEqual({ start: 4, end: 10 });
    expect(loopFromDrag(9, 4)).toEqual({ start: 4, end: 10 });
    expect(loopFromDrag(7, 7)).toEqual({ start: 7, end: 8 });
  });

  it('plays the whole grid with no loop, and the loop with one', () => {
    const state = emptyGrid();
    expect(playRange(state, 32)).toEqual({ start: 0, end: 32 });
    expect(playRange({ ...state, loop: { start: 4, end: 12 } }, 32)).toEqual({
      start: 4,
      end: 12,
    });
    // A loop drawn past the end of a shrunken grid still plays something.
    expect(playRange({ ...state, loop: { start: 40, end: 60 } }, 32)).toEqual({
      start: 31,
      end: 32,
    });
  });
});

describe('what the player is handed', () => {
  const c = clip({ beats: 4, bpm: 120, ones: [0] });
  const clips = new Map([['c1', c]]);

  it('gives each copy its start, offset, length and rate', () => {
    const state: GridState = {
      ...emptyGrid(120),
      rows: [placeClip(row(), c, 8)],
    };
    const [copy] = scheduleRange(state, clips, { start: 0, end: 32 });
    expect(copy.rowId).toBe('row1');
    // 8 beats at 120 bpm = 4 s in, 4 beats = 2 s long, at its own tempo.
    expect(copy.atSecs).toBeCloseTo(4, 6);
    expect(copy.offsetSecs).toBeCloseTo(0, 6);
    expect(copy.durationSecs).toBeCloseTo(2, 6);
    expect(copy.rate).toBeCloseTo(1, 6);
  });

  it('runs a clip faster when the grid is faster than it was cut at', () => {
    const state: GridState = { ...emptyGrid(180), rows: [placeClip(row(), c, 0)] };
    const [copy] = scheduleRange(state, clips, { start: 0, end: 32 });
    expect(copy.rate).toBeCloseTo(1.5, 6);
    // The 4 clip-beats still take 4 grid beats — 4/3 s at 180 bpm — and
    // the buffer has to cover 2 s of its own material to do it.
    expect(copy.durationSecs).toBeCloseTo(2, 6);
  });

  it('cuts a copy that starts before the range, and one that runs past it', () => {
    const state: GridState = { ...emptyGrid(120), rows: [placeClip(row(), c, 4)] };
    // 4..7, played through a window of 5..7.
    const [copy] = scheduleRange(state, clips, { start: 5, end: 7 });
    expect(copy.atSecs).toBeCloseTo(0, 6);
    expect(copy.offsetSecs).toBeCloseTo(0.5, 6); // one clip beat in
    expect(copy.durationSecs).toBeCloseTo(1, 6); // two beats, not three
  });

  it('leaves out the copies that fall outside the range entirely', () => {
    let r = placeClip(row(), c, 0);
    r = placeClip(r, c, 20);
    const state: GridState = { ...emptyGrid(120), rows: [r] };
    const copies = scheduleRange(state, clips, { start: 16, end: 32 });
    expect(copies).toHaveLength(1);
    expect(copies[0].atSecs).toBeCloseTo(2, 6);
  });

  it('says nothing for a row whose clip is gone from the library', () => {
    const state: GridState = { ...emptyGrid(), rows: [placeClip(row(), c, 0)] };
    expect(scheduleRange(state, new Map(), { start: 0, end: 32 })).toEqual([]);
  });
});
