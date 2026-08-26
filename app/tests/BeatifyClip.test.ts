// The clip builder's model. Everything the grid does to a drop lives
// here, so the component tests can stay about pointers and pixels.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLUMNS,
  abutsLeft,
  addRow,
  cellRange,
  clipSeconds,
  copyRange,
  drawnColumns,
  emptyDraft,
  freshClipName,
  isSaved,
  movePlacement,
  pasteFragment,
  isWholeSeed,
  parseSourceId,
  placeRun,
  removeLastRow,
  removePlacement,
  rowPlacements,
  setColumns,
  seedMix,
  seedSourceId,
  seedOfSourceId,
  stemsOfSourceId,
  usedColumns,
} from '../src/beatifyClip';
import type { BeatRun, ClipDraft } from '../src/beatifyClip';

const SEED = seedSourceId('s1');
const run = (beats: number, sourceBeat = 0, source = SEED): BeatRun => ({
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

describe('copying a chunk of the grid', () => {
  /** Two runs on row 0: beats 0–3 and 4–7, from different sources. */
  const two = () =>
    placeRun(
      placeRun(emptyDraft(), run(4, 0), 0, 0),
      run(4, 8, seedSourceId('s1', ['drums'])),
      0,
      4,
    );

  it('reads a swept rectangle whichever way it was swept', () => {
    expect(cellRange({ row: 0, col: 2 }, { row: 1, col: 5 })).toEqual({
      row0: 0,
      row1: 1,
      col0: 2,
      col1: 6,
    });
    // Backwards, and the same rectangle: the cell under the pointer is
    // in it either way.
    expect(cellRange({ row: 1, col: 5 }, { row: 0, col: 2 })).toEqual({
      row0: 0,
      row1: 1,
      col0: 2,
      col1: 6,
    });
  });

  it('takes what is selected, not the whole run it belonged to', () => {
    const frag = copyRange(two(), cellRange({ row: 0, col: 2 }, { row: 0, col: 5 }));
    expect(frag.columns).toBe(4);
    // Half of each run, each starting further into its own source.
    expect(frag.placements.map((p) => [p.col, p.beats, p.sourceBeat])).toEqual([
      [0, 2, 2],
      [2, 2, 8],
    ]);
  });

  it('pastes the shape it copied, wherever it lands', () => {
    const draft = two();
    const frag = copyRange(draft, cellRange({ row: 0, col: 0 }, { row: 0, col: 7 }));
    const pasted = pasteFragment(draft, frag, 0, 8);
    expect(shape(pasted)).toEqual([
      { col: 0, beats: 4, from: 0 },
      { col: 4, beats: 4, from: 8 },
      { col: 8, beats: 4, from: 0 },
      { col: 12, beats: 4, from: 8 },
    ]);
  });

  it('pastes over what was there, like any other drop', () => {
    const draft = two();
    const frag = copyRange(draft, cellRange({ row: 0, col: 0 }, { row: 0, col: 1 }));
    const pasted = pasteFragment(draft, frag, 0, 4);
    // The drums run lost its first two beats to the paste.
    expect(shape(pasted)).toEqual([
      { col: 0, beats: 4, from: 0 },
      { col: 4, beats: 2, from: 0 },
      { col: 6, beats: 2, from: 10 },
    ]);
  });

  it('copies rows as well as beats', () => {
    let draft = placeRun(emptyDraft(), run(2, 0), 0, 0);
    draft = placeRun(draft, run(2, 4), 1, 0);
    const frag = copyRange(draft, cellRange({ row: 0, col: 0 }, { row: 1, col: 1 }));
    expect(frag.rows).toBe(2);
    const pasted = pasteFragment(draft, frag, 2, 4);
    expect(pasted.rows).toBe(4);
    expect(rowPlacements(pasted, 3).map((p) => [p.col, p.sourceBeat])).toEqual([[4, 4]]);
  });
});

describe("a draft's identity", () => {
  it('is the id it was filed under, not its name', () => {
    expect(isSaved(emptyDraft())).toBe(false);
    expect(isSaved({ ...emptyDraft(), name: 'Chorus' })).toBe(false);
    expect(isSaved({ ...emptyDraft(), id: '3' })).toBe(true);
  });

  // Saving clears the desk, so the default name is landed on over and
  // over. Clips are filed by id, so nothing but this stops a shelf of
  // rows all called the same thing.
  it('starts life with a name no clip on the shelf has', () => {
    expect(freshClipName([])).toBe('Untitled clip');
    expect(freshClipName(['Intro', 'Chorus'])).toBe('Untitled clip');
    expect(freshClipName(['Untitled clip'])).toBe('Untitled clip 2');
    expect(freshClipName(['Untitled clip', 'Untitled clip 2'])).toBe('Untitled clip 3');
    // Gaps get filled rather than counted past — the number is only there
    // to tell two rows apart.
    expect(freshClipName(['Untitled clip', 'Untitled clip 3'])).toBe('Untitled clip 2');
    expect(emptyDraft(freshClipName(['Untitled clip'])).name).toBe('Untitled clip 2');
  });
});

describe('source ids', () => {
  it('round-trip to what the backend needs', () => {
    expect(parseSourceId(seedSourceId('s1'))).toEqual({ kind: 'seed', id: 's1', stems: [] });
    expect(parseSourceId('clip:7')).toEqual({ kind: 'clip', id: '7' });
    expect(() => parseSourceId('nonsense')).toThrow(/unknown source/);
  });

  // A project holds several tracks, so a run has to remember WHICH one it
  // came from — and which parts of it were playing at the time.
  it('name the seed, and the parts of it that were on', () => {
    const drums = seedSourceId('s2', ['drums', 'bass']);
    expect(drums).toBe('seed:s2/drums+bass');
    expect(parseSourceId(drums)).toEqual({ kind: 'seed', id: 's2', stems: ['drums', 'bass'] });
    expect(seedOfSourceId(drums)).toBe('s2');
    expect(stemsOfSourceId(drums)).toEqual(['drums', 'bass']);
    // The whole mix names no parts: it is the render, not a sum of stems.
    expect(seedSourceId('s2', [])).toBe('seed:s2');
    expect(stemsOfSourceId('seed:s2')).toEqual([]);
    // A clip belongs to no seed.
    expect(seedOfSourceId('clip:7')).toBe('');
  });

  it('keep two seeds apart even when the same stem is soloed', () => {
    expect(seedSourceId('s1', ['drums'])).not.toBe(seedSourceId('s2', ['drums']));
  });
});

// What a seed PLAYS follows its switches, and only its switches: that is
// what lets a switch reach a pane showing a seed nobody ever clicked.
describe('the mix a seed plays', () => {
  const PARTS = ['drums', 'bass', 'other', 'vocals'];

  it('is the render until somebody touches a switch', () => {
    expect(seedMix('s1', PARTS, undefined)).toBe('seed:s1');
    expect(isWholeSeed(seedMix('s1', PARTS, undefined), PARTS)).toBe(true);
  });

  it('is the parts that are left on, once one is off', () => {
    expect(seedMix('s1', PARTS, ['vocals'])).toBe('seed:s1/drums+bass+other');
    expect(stemsOfSourceId(seedMix('s1', PARTS, ['vocals', 'bass']))).toEqual(['drums', 'other']);
  });

  // The point of the whole exercise: switching a part back on must leave
  // everything else exactly as it was, so a seed being taken apart goes
  // on being played from its parts rather than jumping back to the
  // render — which is the same audio in name only.
  it('stays on the parts when every one of them is back on', () => {
    const whole = seedMix('s1', PARTS, []);
    expect(whole).toBe('seed:s1/drums+bass+other+vocals');
    expect(stemsOfSourceId(whole)).toEqual(PARTS);
    // Still the whole of that seed, so it is named after the seed.
    expect(isWholeSeed(whole, PARTS)).toBe(true);
    expect(isWholeSeed(seedMix('s1', PARTS, ['vocals']), PARTS)).toBe(false);
  });

  it('keeps the parts in the order the list shows them', () => {
    expect(seedMix('s1', PARTS, ['bass'])).toBe('seed:s1/drums+other+vocals');
  });
});
