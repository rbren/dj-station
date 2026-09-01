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
  copyBeats,
  copySelection,
  deleteBeats,
  deleteSelection,
  emptyGrid,
  fillSelection,
  fromDocument,
  isEmptyGrid,
  levelAt,
  moveLevelPoint,
  moveSelection,
  pasteAt,
  removeLevelPoint,
  selectionFromDrag,
  setLevelPoint,
  toDocument,
  gridColumns,
  groupRows,
  insertBeats,
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
import { canRedo, canUndo, endGesture, initHistory, record, redo, undo } from '../src/gridHistory';

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
  return { id: 'row1', clipId: 'c1', placements: [], levels: [], ...over };
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

  it('gives each copy its start, offset, length and tempo', () => {
    const state: GridState = {
      ...emptyGrid(120),
      rows: [placeClip(row(), c, 8)],
    };
    const [copy] = scheduleRange(state, clips, { start: 0, end: 32 });
    expect(copy.rowId).toBe('row1');
    // 8 beats at 120 bpm = 4 s in, 4 beats = 2 s long.
    expect(copy.atSecs).toBeCloseTo(4, 6);
    expect(copy.offsetSecs).toBeCloseTo(0, 6);
    expect(copy.durationSecs).toBeCloseTo(2, 6);
    expect(copy.bpm).toBe(120);
  });

  // THE PITCH RULE. A grid running faster than the clip was cut at asks
  // for the clip RE-TIMED to the grid's tempo — a stretch the backend
  // does with WSOLA — and plays it whole. It never asks for a playback
  // rate, which is what used to transpose every clip on the grid up with
  // the tempo.
  it('asks for the clip at the GRID tempo rather than speeding it up', () => {
    const state: GridState = { ...emptyGrid(180), rows: [placeClip(row(), c, 0)] };
    const [copy] = scheduleRange(state, clips, { start: 0, end: 32 });
    expect(copy.bpm).toBe(180);
    // 4 beats at 180 bpm is 4/3 s, and the re-timed audio is exactly
    // that long: no rate scaling anywhere.
    expect(copy.durationSecs).toBeCloseTo(4 / 3, 6);
    expect(copy).not.toHaveProperty('rate');
  });

  it('quantizes the tempo it asks for, so a ramp needs finitely many renders', () => {
    const tempo = { bpm: 120, points: [{ beat: 0, bpm: 120.4 }] };
    const state: GridState = { ...emptyGrid(120), tempo, rows: [placeClip(row(), c, 0)] };
    const [copy] = scheduleRange(state, clips, { start: 0, end: 32 });
    expect(copy.bpm).toBe(120);
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

describe('the level line through a row', () => {
  it('rests at unity everywhere until something is written on it', () => {
    const r = row();
    expect(levelAt(r, 0)).toBe(1);
    expect(levelAt(r, 99)).toBe(1);
  });

  // A single point would otherwise redefine the WHOLE line — one point
  // holds its value everywhere — so the first one brings a unity point
  // at beat 0 and the line bends from the middle instead of jumping.
  it('bends from the middle when the first point is written', () => {
    const r = setLevelPoint(row(), 8, 0);
    expect(r.levels).toEqual([
      { beat: 0, level: 1 },
      { beat: 8, level: 0 },
    ]);
    expect(levelAt(r, 0)).toBe(1);
    expect(levelAt(r, 4)).toBeCloseTo(0.5, 6);
    expect(levelAt(r, 8)).toBe(0);
    // Past the last point the end value HOLDS: a fade stays faded.
    expect(levelAt(r, 40)).toBe(0);
  });

  it('interpolates between points, and clamps what it is given', () => {
    let r = setLevelPoint(row(), 0, 1);
    r = setLevelPoint(r, 4, 99);
    expect(r.levels[1].level).toBe(2);
    expect(levelAt(r, 2)).toBeCloseTo(1.5, 6);
    r = setLevelPoint(r, 4, -5);
    expect(r.levels[1].level).toBe(0);
  });

  it('moves the point nearest a drag, and drops one on demand', () => {
    let r = setLevelPoint(setLevelPoint(row(), 0, 1), 8, 0.25);
    r = moveLevelPoint(r, 8, 12, 0.5);
    expect(r.levels.map((p) => p.beat)).toEqual([0, 12]);
    expect(levelAt(r, 12)).toBeCloseTo(0.5, 6);
    r = removeLevelPoint(r, 12);
    expect(r.levels.map((p) => p.beat)).toEqual([0]);
  });

  it('hands the player the level over each copy, so a fade is a ramp', () => {
    const c = clip({ beats: 4, bpm: 120, ones: [0] });
    const clips = new Map([['c1', c]]);
    let r = placeClip(row(), c, 0);
    r = setLevelPoint(r, 0, 1);
    r = setLevelPoint(r, 4, 0);
    const [copy] = scheduleRange({ ...emptyGrid(120), rows: [r] }, clips, { start: 0, end: 8 });
    // Two seconds of clip at 120 bpm: unity at its head, silent at its
    // tail, and the player ramps between them.
    expect(copy.levels[0]).toEqual([0, 1]);
    const [lastAt, lastLevel] = copy.levels[copy.levels.length - 1];
    expect(lastAt).toBeCloseTo(2, 6);
    expect(lastLevel).toBeCloseTo(0, 6);
  });

  it('gives a resting row one unity point rather than no envelope', () => {
    const c = clip({ beats: 4, bpm: 120, ones: [0] });
    const clips = new Map([['c1', c]]);
    const state = { ...emptyGrid(120), rows: [placeClip(row(), c, 0)] };
    const [copy] = scheduleRange(state, clips, { start: 0, end: 8 });
    expect(copy.levels).toEqual([[0, 1]]);
  });
});

describe('selection, copy and paste', () => {
  const c = clip({ beats: 4, bpm: 120, ones: [1] });
  const clips = new Map([['c1', c]]);

  function twoRows(): GridState {
    return {
      ...emptyGrid(120),
      rows: [
        placeClip(row({ id: 'row1' }), c, 4),
        placeClip(row({ id: 'row2', clipId: 'c1' }), c, 20),
      ],
    };
  }

  it('takes the rows between the two ends of a drag, in either direction', () => {
    const state = twoRows();
    const down = selectionFromDrag(state.rows, 'row1', 4, 'row2', 8);
    expect(down?.rowIds).toEqual(['row1', 'row2']);
    expect(down?.columns).toEqual({ start: 4, end: 9 });
    // Dragging up selects the same rectangle.
    const up = selectionFromDrag(state.rows, 'row2', 8, 'row1', 4);
    expect(up).toEqual(down);
  });

  // A copy measures its clips from the selection's LEFT EDGE so it can
  // land anywhere, and a clip belongs to a selection by its ANCHOR — the
  // beat the user aimed at — not by every beat it covers.
  it('copies by anchor, offset from the left edge, and pastes at a column', () => {
    const state = twoRows();
    const sel = selectionFromDrag(state.rows, 'row1', 4, 'row1', 7)!;
    const board = copySelection(state, clips, sel);
    // The clip is anchored at 4 and the selection starts at 4, so it
    // sits at the left edge of what was copied.
    expect(board.rows).toEqual([{ clipId: 'c1', offsets: [0] }]);
    const pasted = pasteAt(state, clips, board, 12);
    // Pasted at 12, the copy's own first one lands on 12 — so its body
    // starts at 11, a beat earlier, exactly as a click there would.
    expect(pasted.rows[0].placements).toContain(11);
    expect(placementAt(pasted.rows[0], c, 12)).toBeGreaterThanOrEqual(0);
  });

  it('pasting over an existing copy leaves it there rather than toggling it off', () => {
    const state = twoRows();
    const sel = selectionFromDrag(state.rows, 'row1', 4, 'row1', 7)!;
    const board = copySelection(state, clips, sel);
    const pasted = pasteAt(state, clips, board, 5);
    expect(pasted.rows[0].placements).toEqual([4]);
  });

  it('deletes every copy anchored inside a selection', () => {
    const state = twoRows();
    const sel = selectionFromDrag(state.rows, 'row1', 0, 'row2', 31)!;
    const cleared = deleteSelection(state, clips, sel);
    expect(cleared.rows.every((r) => r.placements.length === 0)).toBe(true);
  });
});

describe('dragging a selection about', () => {
  const c = clip({ beats: 4, bpm: 120, ones: [1] });
  const clips = new Map([['c1', c]]);
  const order = ['row1', 'row2'];

  function twoRows(): GridState {
    return {
      ...emptyGrid(120),
      rows: [
        placeClip(row({ id: 'row1' }), c, 4),
        placeClip(row({ id: 'row2', clipId: 'c1' }), c, 20),
      ],
    };
  }

  it('carries what the selection covers along, leaving nothing behind', () => {
    const state = twoRows();
    const sel = selectionFromDrag(state.rows, 'row1', 4, 'row1', 7)!;
    const moved = moveSelection(state, clips, order, sel, 0, 8, false);
    // The copy was anchored at 4 (body from 3); eight beats later its
    // anchor is 12 and its body starts at 11.
    expect(moved.state.rows[0].placements).toEqual([11]);
    expect(moved.selection.columns).toEqual({ start: 12, end: 16 });
    // The other row is untouched by a drag that never covered it.
    expect(moved.state.rows[1].placements).toEqual(state.rows[1].placements);
  });

  it('a copy drag leaves the original where it was', () => {
    const state = twoRows();
    const sel = selectionFromDrag(state.rows, 'row1', 4, 'row1', 7)!;
    const moved = moveSelection(state, clips, order, sel, 0, 8, true);
    expect(moved.state.rows[0].placements).toEqual([3, 11]);
  });

  it('measures from the state the drag began on, so every move is one operation', () => {
    const state = twoRows();
    const sel = selectionFromDrag(state.rows, 'row1', 4, 'row1', 7)!;
    const near = moveSelection(state, clips, order, sel, 0, 4, false);
    const far = moveSelection(state, clips, order, sel, 0, 8, false);
    expect(near.state.rows[0].placements).toEqual([7]);
    expect(far.state.rows[0].placements).toEqual([11]);
  });

  it('stops at the start of the grid rather than dragging material off it', () => {
    const state = twoRows();
    const sel = selectionFromDrag(state.rows, 'row1', 4, 'row1', 7)!;
    const moved = moveSelection(state, clips, order, sel, 0, -40, false);
    expect(moved.selection.columns.start).toBe(0);
    expect(moved.state.rows[0].placements).toEqual([-1]);
  });

  it('steps down the page onto a row playing the same clip', () => {
    const state = twoRows();
    const sel = selectionFromDrag(state.rows, 'row1', 4, 'row1', 7)!;
    const moved = moveSelection(state, clips, order, sel, 1, 0, false);
    expect(moved.state.rows[0].placements).toEqual([]);
    expect(moved.state.rows[1].placements).toContain(3);
    expect(moved.selection.rowIds).toEqual(['row2']);
  });

  // A row IS its clip, so there is nothing a copy could mean in a row
  // playing a different one: the vertical part of the drag is dropped
  // and the horizontal part still happens.
  it('drops the vertical move when the row below plays another clip', () => {
    const other = clip({ clipId: 'c2', beats: 4, ones: [0] });
    const state: GridState = {
      ...emptyGrid(120),
      rows: [placeClip(row({ id: 'row1' }), c, 4), row({ id: 'row2', clipId: 'c2' })],
    };
    const sel = selectionFromDrag(state.rows, 'row1', 4, 'row1', 7)!;
    const moved = moveSelection(
      state,
      new Map([
        ['c1', c],
        ['c2', other],
      ]),
      order,
      sel,
      1,
      4,
      false,
    );
    expect(moved.state.rows[1].placements).toEqual([]);
    expect(moved.state.rows[0].placements).toEqual([7]);
    expect(moved.selection.rowIds).toEqual(['row1']);
  });
});

describe('filling a selection', () => {
  const c = clip({ beats: 4, bpm: 120, ones: [1] });
  const clips = new Map([['c1', c]]);

  it('lays whole copies end to end from the selection\u2019s left edge', () => {
    const state: GridState = { ...emptyGrid(120), rows: [row({ id: 'row1' })] };
    const sel = { rowIds: ['row1'], columns: { start: 4, end: 16 } };
    const filled = fillSelection(state, clips, sel);
    // Three four-beat copies, each starting where the last ended.
    expect(filled.rows[0].placements).toEqual([4, 8, 12]);
  });

  it('lays only what fits, and a copy even where nothing does', () => {
    const state: GridState = { ...emptyGrid(120), rows: [row({ id: 'row1' })] };
    const short = fillSelection(state, clips, {
      rowIds: ['row1'],
      columns: { start: 0, end: 6 },
    });
    expect(short.rows[0].placements).toEqual([0]);
    const tiny = fillSelection(state, clips, {
      rowIds: ['row1'],
      columns: { start: 0, end: 2 },
    });
    expect(tiny.rows[0].placements).toEqual([0]);
  });

  it('fills every row of the selection and no other', () => {
    const state: GridState = {
      ...emptyGrid(120),
      rows: [row({ id: 'row1' }), row({ id: 'row2', clipId: 'c1' })],
    };
    const filled = fillSelection(state, clips, {
      rowIds: ['row2'],
      columns: { start: 0, end: 8 },
    });
    expect(filled.rows[0].placements).toEqual([]);
    expect(filled.rows[1].placements).toEqual([0, 4]);
  });
});

describe('the grid document', () => {
  const c = clip({ beats: 4, bpm: 120, ones: [0] });

  it('round-trips a grid through save and open', () => {
    let state: GridState = { ...emptyGrid(128), rows: [placeClip(row(), c, 8)] };
    state = { ...state, loop: { start: 4, end: 20 }, beats: 64 };
    state = { ...state, rows: [setLevelPoint(state.rows[0], 8, 0.5)] };
    const reopened = fromDocument(JSON.parse(JSON.stringify(toDocument(state))));
    expect(reopened).toEqual(state);
  });

  // A grid file NAMES its clips rather than carrying their audio, so it
  // stays small and a re-cut clip is heard in every grid that uses it.
  it('names the clips it uses rather than embedding them', () => {
    const state: GridState = { ...emptyGrid(120), rows: [placeClip(row(), c, 0)] };
    const json = JSON.stringify(toDocument(state));
    expect(json).toContain('c1');
    expect(json.length).toBeLessThan(500);
  });

  it('fills in what an older file does not say, and refuses what is not a grid', () => {
    const sparse = fromDocument({ state: { rows: [{ clipId: 'c1' }] } });
    expect(sparse.rows[0].placements).toEqual([]);
    expect(sparse.rows[0].levels).toEqual([]);
    expect(sparse.tempo.bpm).toBe(120);
    expect(sparse.loop).toBeNull();
    expect(() => fromDocument({ nope: true })).toThrow();
    expect(() => fromDocument(null)).toThrow();
  });

  // What New makes needs no warning before it is replaced.
  it('knows an untouched grid from one with work in it', () => {
    expect(isEmptyGrid(emptyGrid())).toBe(true);
    expect(isEmptyGrid({ ...emptyGrid(), rows: [row()] })).toBe(false);
    expect(isEmptyGrid({ ...emptyGrid(), loop: { start: 0, end: 4 } })).toBe(false);
  });
});

// BEAT SURGERY: the ruler's right-click operations on the loop's span.
// All three are measured by a placement's ANCHOR — where the clip's one
// landed is what says which side of a cut it is on.
describe('inserting, copying and deleting beats', () => {
  const clips = new Map([['c1', clip()]]);
  const base = (over: Partial<GridState> = {}): GridState => ({
    ...emptyGrid(),
    rows: [row({ placements: [0, 8] })],
    ...over,
  });

  it('opens beats at a column and moves what is anchored from there on', () => {
    const out = insertBeats(base(), clips, 4, 2);
    expect(out.rows[0].placements).toEqual([0, 10]);
    // The grid grows by what was opened in it.
    expect(out.beats).toBe(base().beats + 2);
  });

  it('carries the tempo and level automation along with the beats', () => {
    const state = base({
      rows: [row({ placements: [], levels: [{ beat: 8, level: 0.5 }] })],
      tempo: { bpm: 120, points: [{ beat: 8, bpm: 140 }] },
    });
    const out = insertBeats(state, clips, 4, 4);
    expect(out.rows[0].levels[0].beat).toBe(12);
    expect(out.tempo.points[0].beat).toBe(12);
  });

  it('an insert to the RIGHT of the loop leaves the loop over its own beats', () => {
    const out = insertBeats(base({ loop: { start: 0, end: 4 } }), clips, 4, 4);
    expect(out.loop).toEqual({ start: 0, end: 4 });
    // …and one to the left takes the loop with the music it marks.
    expect(insertBeats(base({ loop: { start: 4, end: 8 } }), clips, 4, 4).loop).toEqual({
      start: 8,
      end: 12,
    });
  });

  it('deletes what is anchored in a span and closes the gap behind it', () => {
    const out = deleteBeats(base(), clips, { start: 0, end: 4 });
    expect(out.rows[0].placements).toEqual([4]);
    expect(out.beats).toBe(base().beats - 4);
  });

  it('a deletion that swallowed the loop leaves no loop behind', () => {
    const out = deleteBeats(base({ loop: { start: 0, end: 4 } }), clips, { start: 0, end: 4 });
    expect(out.loop).toBeNull();
  });

  it('copies a span to the right, leaving the original where it was', () => {
    const out = copyBeats(
      base({ rows: [row({ placements: [0] })] }),
      clips,
      {
        start: 0,
        end: 4,
      },
      'right',
    );
    expect(out.rows[0].placements).toEqual([0, 4]);
  });

  it('copies a span to the left, opening the beats it needs first', () => {
    const out = copyBeats(
      base({ rows: [row({ placements: [0] })] }),
      clips,
      {
        start: 0,
        end: 4,
      },
      'left',
    );
    // The original moved along to make room; the copy is in front of it.
    expect(out.rows[0].placements).toEqual([0, 4]);
    expect(out.beats).toBe(base().beats + 4);
  });

  it('leaves a grid alone when the span is empty', () => {
    const state = base();
    expect(insertBeats(state, clips, 4, 0)).toBe(state);
    expect(deleteBeats(state, clips, { start: 4, end: 4 })).toBe(state);
  });
});

// UNDO/REDO. The grid's state is one immutable value, so history is a
// stack of them; what the module has to get right is what counts as ONE
// step when a drag streams thirty of them.
describe('the grid history', () => {
  const a = emptyGrid();
  const b = { ...a, beats: 64 };
  const c = { ...a, beats: 96 };

  it('walks back and forward through the edits', () => {
    const h = record(record(initHistory(a), b), c);
    expect(canUndo(h)).toBe(true);
    expect(undo(h).present).toBe(b);
    expect(undo(undo(h)).present).toBe(a);
    expect(redo(undo(h)).present).toBe(c);
  });

  it('stops at the ends rather than falling off them', () => {
    const h = initHistory(a);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it('an edit that changed nothing is not a step', () => {
    const h = initHistory(a);
    expect(record(h, a)).toBe(h);
  });

  it('a gesture is ONE step, however many edits it streams', () => {
    let h = initHistory(a);
    h = record(h, b, 'loop');
    h = record(h, c, 'loop');
    expect(h.present).toBe(c);
    // One undo, back past the whole drag.
    expect(undo(h).present).toBe(a);
  });

  it('the next gesture is its own step once the last one is closed', () => {
    let h = record(initHistory(a), b, 'loop');
    h = record(endGesture(h), c, 'loop');
    expect(undo(h).present).toBe(b);
  });

  it('a fresh edit spends the redo stack', () => {
    const h = undo(record(initHistory(a), b));
    expect(canRedo(h)).toBe(true);
    expect(canRedo(record(h, c))).toBe(false);
  });
});
