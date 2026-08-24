// The clip builder's model. Everything the grid does to a drop lives
// here, so the component tests can stay about pointers and pixels.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLUMNS,
  SEED_SOURCE,
  abutsLeft,
  addRow,
  clipSeconds,
  drawnColumns,
  emptyDraft,
  movePlacement,
  parseSourceId,
  placeRun,
  removeLastRow,
  removePlacement,
  rowPlacements,
  setColumns,
  stemSourceId,
  usedColumns,
} from '../src/beatifyClip';
import type { BeatRun, ClipDraft } from '../src/beatifyClip';

const run = (beats: number, sourceBeat = 0, source = SEED_SOURCE): BeatRun => ({
  source,
  sourceBeat,
  beats,
});

/** A draft as `row → columns`, for reading assertions at a glance. */
function shape(draft: ClipDraft, row = 0): { col: number; beats: number; from: number }[] {
  return rowPlacements(draft, row).map((p) => ({
    col: p.col,
    beats: p.beats,
    from: p.sourceBeat,
  }));
}

describe('a fresh clip', () => {
  it('is one row of sixteen beats', () => {
    const draft = emptyDraft();
    expect(draft.rows).toBe(1);
    expect(draft.columns).toBe(DEFAULT_COLUMNS);
    expect(usedColumns(draft)).toBe(0);
  });

  it('lasts as many beats as it holds', () => {
    expect(clipSeconds(16, 0.5)).toBe(8);
    expect(clipSeconds(0, 0.5)).toBe(0);
  });
});

describe('dropping a run of beats', () => {
  it('keeps it whole, not one cell per beat', () => {
    const draft = placeRun(emptyDraft(), run(3, 8), 0, 0);
    expect(shape(draft)).toEqual([{ col: 0, beats: 3, from: 8 }]);
    expect(usedColumns(draft)).toBe(3);
  });

  it('leaves two runs that touch as two runs', () => {
    let draft = placeRun(emptyDraft(), run(3, 0), 0, 0);
    draft = placeRun(draft, run(6, 16), 0, 3);
    expect(shape(draft)).toEqual([
      { col: 0, beats: 3, from: 0 },
      { col: 3, beats: 6, from: 16 },
    ]);
    // …and the editor can tell where the seam is.
    const [first, second] = rowPlacements(draft, 0);
    expect(abutsLeft(draft, first)).toBe(false);
    expect(abutsLeft(draft, second)).toBe(true);
  });

  it('grows the clip to the right when the run runs off the end', () => {
    const draft = placeRun(emptyDraft(), run(8, 0), 0, 12);
    expect(draft.columns).toBe(20);
    expect(usedColumns(draft)).toBe(20);
  });

  it('grows downwards when dropped below the last row', () => {
    const draft = placeRun(emptyDraft(), run(4, 0), 2, 0);
    expect(draft.rows).toBe(3);
    expect(shape(draft, 2)).toEqual([{ col: 0, beats: 4, from: 0 }]);
  });

  it('does not disturb the other rows', () => {
    let draft = placeRun(emptyDraft(), run(4, 0), 0, 0);
    draft = placeRun(draft, run(4, 32), 1, 0);
    expect(shape(draft, 0)).toEqual([{ col: 0, beats: 4, from: 0 }]);
    expect(shape(draft, 1)).toEqual([{ col: 0, beats: 4, from: 32 }]);
  });
});

describe('dropping onto something already there', () => {
  it('trims the run it lands on the end of', () => {
    let draft = placeRun(emptyDraft(), run(8, 0), 0, 0);
    draft = placeRun(draft, run(4, 20), 0, 6);
    expect(shape(draft)).toEqual([
      { col: 0, beats: 6, from: 0 },
      { col: 6, beats: 4, from: 20 },
    ]);
  });

  it('trims the front of the run it lands on the start of', () => {
    let draft = placeRun(emptyDraft(), run(8, 4), 0, 4);
    draft = placeRun(draft, run(4, 20), 0, 2);
    expect(shape(draft)).toEqual([
      { col: 2, beats: 4, from: 20 },
      // The survivor starts two beats further into ITS source, because
      // that is the material still showing.
      { col: 6, beats: 6, from: 6 },
    ]);
  });

  it('punches a hole through the middle, leaving two runs', () => {
    let draft = placeRun(emptyDraft(), run(8, 0), 0, 0);
    draft = placeRun(draft, run(2, 40), 0, 3);
    expect(shape(draft)).toEqual([
      { col: 0, beats: 3, from: 0 },
      { col: 3, beats: 2, from: 40 },
      { col: 5, beats: 3, from: 5 },
    ]);
  });

  it('swallows a run it completely covers', () => {
    let draft = placeRun(emptyDraft(), run(2, 0), 0, 4);
    draft = placeRun(draft, run(8, 16), 0, 0);
    expect(shape(draft)).toEqual([{ col: 0, beats: 8, from: 16 }]);
  });
});

describe('editing what is in the clip', () => {
  it('moves a placement without carving itself away', () => {
    let draft = placeRun(emptyDraft(), run(4, 0), 0, 0);
    const id = draft.placements[0].id;
    draft = movePlacement(draft, id, 0, 2);
    expect(shape(draft)).toEqual([{ col: 2, beats: 4, from: 0 }]);
    expect(draft.placements).toHaveLength(1);
  });

  it('removes one', () => {
    let draft = placeRun(emptyDraft(), run(4, 0), 0, 0);
    draft = removePlacement(draft, draft.placements[0].id);
    expect(draft.placements).toEqual([]);
    expect(usedColumns(draft)).toBe(0);
  });

  it('adds and drops rows, taking the row\u2019s contents with it', () => {
    let draft = addRow(emptyDraft());
    draft = placeRun(draft, run(4, 0), 1, 0);
    expect(draft.rows).toBe(2);
    draft = removeLastRow(draft);
    expect(draft.rows).toBe(1);
    expect(draft.placements).toEqual([]);
    // Never below one row: there is always somewhere to drop.
    expect(removeLastRow(draft).rows).toBe(1);
  });

  it('is drawn as long as it was set to be', () => {
    expect(drawnColumns(emptyDraft())).toBe(DEFAULT_COLUMNS);
    // A run that hangs off the end takes the clip with it.
    expect(drawnColumns(placeRun(emptyDraft(), run(20, 0), 0, 0))).toBe(20);
  });
});

describe('setting the clip length', () => {
  it('is the length, silence and all', () => {
    const draft = setColumns(placeRun(emptyDraft(), run(4, 0), 0, 0), 32);
    expect(drawnColumns(draft)).toBe(32);
    expect(usedColumns(draft)).toBe(4);
    expect(clipSeconds(drawnColumns(draft), 0.5)).toBe(16);
  });

  it('trims what no longer fits and drops what is wholly past the end', () => {
    let draft = placeRun(emptyDraft(), run(6, 0), 0, 2);
    draft = placeRun(draft, run(4, 0), 0, 10);
    draft = setColumns(draft, 6);
    expect(shape(draft)).toEqual([{ col: 2, beats: 4, from: 0 }]);
  });

  it('never goes below one beat', () => {
    expect(setColumns(emptyDraft(), 0).columns).toBe(1);
    expect(setColumns(emptyDraft(), -9).columns).toBe(1);
  });
});

describe('source ids', () => {
  it('round-trip to what the backend needs', () => {
    expect(parseSourceId(SEED_SOURCE)).toEqual({ kind: 'seed' });
    expect(parseSourceId(stemSourceId('drums'))).toEqual({ kind: 'stem', name: 'drums' });
    expect(parseSourceId('clip:7')).toEqual({ kind: 'clip', id: '7' });
    expect(() => parseSourceId('nonsense')).toThrow(/unknown source/);
  });
});
