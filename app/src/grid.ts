// The Grid page's model: rows of beat clips laid out on one beat-indexed
// timeline, the master tempo drawn as automation over it, and the
// arithmetic that turns the two into times a player can schedule.
//
// EVERYTHING HERE IS PURE. The page (GridView) renders it and the
// transport (gridTransport) plays it; both hold a `GridState` and neither
// owns the maths, so the placement rules and the tempo integral are
// testable without a DOM or an AudioContext.
//
// THE TWO IDEAS THE REST FOLLOWS FROM:
//
//   1. A COLUMN IS A BEAT OF THE GRID, not of a clip. A clip's own beats
//      are only ever mapped onto columns through a PLACEMENT, so the same
//      clip can sit at several places on its row and the grid stays one
//      shared ruler.
//   2. A PLACEMENT IS ANCHORED ON THE CLIP'S FIRST ONE. Clicking a cell
//      says "put the downbeat HERE"; where the clip starts follows from
//      that (`start = col - leadOne`), which is why a placement's start
//      may land before column 0 — the anchor is the musical fact, the
//      left edge is a consequence. Columns below zero are simply not
//      drawn and not played.
//
// The tempo is a breakpoint envelope over beats, exactly like the Clip
// page's level automation, so beat->time is an INTEGRAL rather than a
// division: between two breakpoints the tempo moves linearly in the beat
// domain, and ∫60/bpm(b) db has the closed form below. That is what makes
// a tempo ramp play in tune with the grid instead of drifting.

import type { BeatClipEntry } from './beatClip';
import { MAX_BPM, MIN_BPM } from './decks';
import { fxOrDefault, fxRenderSpec, parseTrackFx, type TrackFx } from './gridFx';
import { timed } from './perf';

/** Where one copy of a row's clip sits: the grid column its OWN beat 0
 *  lands on. Negative means the clip begins before the grid does (its
 *  first one still lands where the user clicked). */
export type Placement = number;

/** One point on a row's level line: the gain in force from `beat`. */
export interface LevelPoint {
  beat: number;
  /** 0..=`MAX_LEVEL`, where 1 is unity — the line's resting middle. */
  level: number;
}

export interface GridRow {
  /** Stable across re-orders and clip reloads; the layout is keyed by it. */
  id: string;
  clipId: string;
  placements: Placement[];
  /** The row's level automation. EMPTY is the normal state and means
   *  unity all the way across — the flat line drawn down the middle of
   *  the row, which is why a row that has never been touched needs no
   *  points to say what it does. */
  levels: LevelPoint[];
  /** The row's effects rack (`gridFx.ts`), or ABSENT for a row nobody has
   *  opened the modal on — the default rack is what an absent one plays
   *  through, so an untouched row costs the document nothing. */
  fx?: TrackFx;
}

/** The top of a row's level line. Unity sits at the MIDDLE of the row
 *  (the line's default), so the line can be pushed up as far as it can
 *  be pulled down — a row can be made louder, not only quieter. */
export const MAX_LEVEL = 2;

/** One master-tempo breakpoint: the tempo the grid runs at from `beat`. */
export interface TempoPoint {
  beat: number;
  bpm: number;
}

/** The master tempo: a base value, plus the breakpoints drawn over it.
 *  No breakpoints means a flat grid at `bpm` — the default, and what the
 *  lane says by staying quiet. */
export interface GridTempo {
  bpm: number;
  points: TempoPoint[];
}

/** A span of columns, `end` exclusive. */
export interface ColumnRange {
  start: number;
  end: number;
}

export interface GridState {
  rows: GridRow[];
  tempo: GridTempo;
  /** Columns the grid shows at rest. It grows to hold what is placed on
   *  it (`gridColumns`) but never shrinks below this. */
  beats: number;
  /** Beats to a bar: what the ruler counts by and what a bar-sized seek
   *  steps by. Four unless the music says otherwise. */
  barBeats: number;
  /** The columns playback is confined to, or null for the whole grid. */
  loop: ColumnRange | null;
}

export const GRID_MIN_BEATS = 32;
export const DEFAULT_BAR_BEATS = 4;
export const MIN_BAR = 1;
export const MAX_BAR = 32;

export function clampBar(beats: number): number {
  return Math.min(Math.max(Math.round(beats), MIN_BAR), MAX_BAR);
}

export function emptyGrid(bpm = 120): GridState {
  return {
    rows: [],
    tempo: { bpm, points: [] },
    beats: GRID_MIN_BEATS,
    barBeats: DEFAULT_BAR_BEATS,
    loop: null,
  };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** A row id nothing in `rows` is using. */
export function nextRowId(rows: readonly GridRow[]): string {
  const used = new Set(rows.map((r) => r.id));
  for (let n = 1; ; n += 1) {
    const id = `row${n}`;
    if (!used.has(id)) return id;
  }
}

/** Load a clip in as a new row — EMPTY, because the row is where the clip
 *  lives and the placements are where it plays. A row added for a track
 *  that already has rows lands beside them, so a track's group stays one
 *  block and its title keeps being said once. */
export function addRow(state: GridState, clip: BeatClipEntry): GridState {
  const row: GridRow = {
    id: nextRowId(state.rows),
    clipId: clip.clipId,
    placements: [],
    levels: [],
  };
  return { ...state, rows: [...state.rows, row] };
}

export function removeRow(state: GridState, rowId: string): GridState {
  return { ...state, rows: state.rows.filter((r) => r.id !== rowId) };
}

/** Rows re-ordered so every track's rows sit together, first-seen track
 *  first. The page draws a group heading per run, which is how a track
 *  title is said once for the whole group. */
export function groupRows(
  rows: readonly GridRow[],
  clips: ReadonlyMap<string, BeatClipEntry>,
): GridGroup[] {
  const groups: GridGroup[] = [];
  const byKey = new Map<string, GridGroup>();
  for (const row of rows) {
    const clip = clips.get(row.clipId);
    const source = clip?.sources[0];
    const key = source?.trackHash ?? `clip:${row.clipId}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        hash: source?.trackHash ?? null,
        title: source ? (source.title ?? 'source not in the library') : 'no source recorded',
        artist: source?.artist ?? null,
        rows: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

/** The rows of one track, under the title the group is headed by. */
export interface GridGroup {
  key: string;
  hash: string | null;
  title: string;
  artist: string | null;
  rows: GridRow[];
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** The clip beat a placement is ANCHORED by: its first one, or its beat 0
 *  for a clip whose grid marks none (there is still a downbeat to line
 *  up on — it is just the start of the clip). */
export function leadOne(clip: BeatClipEntry): number {
  const ones = clip.ones.filter((b) => b >= 0 && b < clip.beats).sort((a, b) => a - b);
  return ones[0] ?? 0;
}

/** The columns one placement occupies, `end` exclusive. */
export function placementSpan(clip: BeatClipEntry, start: Placement): ColumnRange {
  return { start, end: start + Math.max(1, clip.beats) };
}

/** Which placement of a row covers `col`, or -1. */
export function placementAt(row: GridRow, clip: BeatClipEntry, col: number): number {
  return row.placements.findIndex((start) => {
    const span = placementSpan(clip, start);
    return col >= span.start && col < span.end;
  });
}

/** CLICKING A CELL. The clip lands with its first one ON that column —
 *  a 4-beat clip whose one is its second beat, clicked at column 10,
 *  fills 9..12. Clicking a cell the row already plays takes that copy
 *  away again (the same gesture undoes itself), and a new copy displaces
 *  whatever it would overlap: a row is one voice, and two copies of it
 *  sounding at once is not a thing the grid can mean. */
export function placeClip(row: GridRow, clip: BeatClipEntry, col: number): GridRow {
  const hit = placementAt(row, clip, col);
  if (hit >= 0) {
    return { ...row, placements: row.placements.filter((_, i) => i !== hit) };
  }
  const start = col - leadOne(clip);
  const span = placementSpan(clip, start);
  const kept = row.placements.filter((other) => {
    const o = placementSpan(clip, other);
    return o.end <= span.start || o.start >= span.end;
  });
  return { ...row, placements: [...kept, start].sort((a, b) => a - b) };
}

export function clearRow(row: GridRow): GridRow {
  return { ...row, placements: [] };
}

/** What a cell of a laid-out row shows. `one` is any downbeat of the
 *  clip; `lead` is the one the placement is anchored by — the beat that
 *  sits exactly where the user clicked. */
export type CellKind = 'empty' | 'beat' | 'one' | 'lead';

export function cellKind(row: GridRow, clip: BeatClipEntry, col: number): CellKind {
  const hit = placementAt(row, clip, col);
  if (hit < 0) return 'empty';
  const beat = col - row.placements[hit];
  if (beat === leadOne(clip)) return 'lead';
  return clip.ones.includes(beat) ? 'one' : 'beat';
}

/** How wide the grid has to be: what the user asked for, and never less
 *  than what is laid out on it. */
export function gridColumns(state: GridState, clips: ReadonlyMap<string, BeatClipEntry>): number {
  return timed('grid.gridColumns', () => gridColumnsImpl(state, clips));
}

function gridColumnsImpl(state: GridState, clips: ReadonlyMap<string, BeatClipEntry>): number {
  let end = state.beats;
  for (const row of state.rows) {
    const clip = clips.get(row.clipId);
    if (!clip) continue;
    for (const start of row.placements) end = Math.max(end, placementSpan(clip, start).end);
  }
  return Math.max(1, Math.ceil(end));
}

// ---------------------------------------------------------------------------
// Master tempo (breakpoint automation over beats)
// ---------------------------------------------------------------------------

export function clampBpm(bpm: number): number {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}

function sortPoints(points: readonly TempoPoint[]): TempoPoint[] {
  return [...points].sort((a, b) => a.beat - b.beat);
}

/** The tempo at a beat: the base value where nothing is drawn, and
 *  otherwise the envelope — linear between breakpoints, flat outside
 *  them (the Clip page's level lane, in the beat domain). */
export function bpmAt(tempo: GridTempo, beat: number): number {
  const points = sortPoints(tempo.points);
  if (points.length === 0) return tempo.bpm;
  if (beat <= points[0].beat) return points[0].bpm;
  const last = points[points.length - 1];
  if (beat >= last.beat) return last.bpm;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (beat <= b.beat) {
      const span = b.beat - a.beat;
      if (span <= 0) return b.bpm;
      return a.bpm + ((b.bpm - a.bpm) * (beat - a.beat)) / span;
    }
  }
  return last.bpm;
}

/** How near two breakpoints have to be to count as the same one. A beat
 *  is the resolution the lane works at, so a click lands ON a column's
 *  breakpoint rather than beside it. */
const TEMPO_EPSILON = 0.25;

/** Add (or move, when one already sits at that beat) a breakpoint. */
export function setTempoPoint(tempo: GridTempo, beat: number, bpm: number): GridTempo {
  const at = Math.max(0, Math.round(beat));
  const kept = tempo.points.filter((p) => Math.abs(p.beat - at) > TEMPO_EPSILON);
  return { ...tempo, points: sortPoints([...kept, { beat: at, bpm: clampBpm(bpm) }]) };
}

/** Move the breakpoint nearest `fromBeat` — what a drag reports, since
 *  the envelope renumbers itself whenever one point passes another. */
export function moveTempoPoint(
  tempo: GridTempo,
  fromBeat: number,
  beat: number,
  bpm: number,
): GridTempo {
  return setTempoPoint(removeTempoPoint(tempo, fromBeat), beat, bpm);
}

/** Drop the breakpoint nearest `beat`; a beat with none is a no-op. */
export function removeTempoPoint(tempo: GridTempo, beat: number): GridTempo {
  let best = -1;
  for (let i = 0; i < tempo.points.length; i += 1) {
    if (
      best < 0 ||
      Math.abs(tempo.points[i].beat - beat) < Math.abs(tempo.points[best].beat - beat)
    )
      best = i;
  }
  if (best < 0) return tempo;
  return { ...tempo, points: tempo.points.filter((_, i) => i !== best) };
}

// ---------------------------------------------------------------------------
// Row level (the line drawn through each row)
// ---------------------------------------------------------------------------

export function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.min(MAX_LEVEL, Math.max(0, level));
}

/** The gain in force at `beat`. No points is unity everywhere — the flat
 *  line down the middle — and outside the points the end values hold, so
 *  a fade written at the end stays faded. */
export function levelAt(row: GridRow, beat: number): number {
  const points = [...row.levels].sort((a, b) => a.beat - b.beat);
  if (points.length === 0) return 1;
  if (beat <= points[0].beat) return points[0].level;
  const last = points[points.length - 1];
  if (beat >= last.beat) return last.level;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (beat <= b.beat) {
      const span = b.beat - a.beat;
      if (span <= 0) return b.level;
      return a.level + ((b.level - a.level) * (beat - a.beat)) / span;
    }
  }
  return last.level;
}

/** Add (or move, when one already sits there) a level point. The FIRST
 *  point on a resting row would otherwise redefine the whole line by
 *  itself — a single point holds its value everywhere — so it brings a
 *  unity point at beat 0 with it, and the line bends from the middle
 *  rather than jumping to the new value. */
export function setLevelPoint(row: GridRow, beat: number, level: number): GridRow {
  const at = Math.max(0, Math.round(beat));
  const seeded = row.levels.length === 0 && at > 0 ? [{ beat: 0, level: 1 }] : [...row.levels];
  const kept = seeded.filter((p) => Math.abs(p.beat - at) > TEMPO_EPSILON);
  return {
    ...row,
    levels: [...kept, { beat: at, level: clampLevel(level) }].sort((a, b) => a.beat - b.beat),
  };
}

/** Move the level point nearest `fromBeat` — what a drag reports, since
 *  the line renumbers itself whenever one point passes another. */
export function moveLevelPoint(
  row: GridRow,
  fromBeat: number,
  beat: number,
  level: number,
): GridRow {
  return setLevelPoint(removeLevelPoint(row, fromBeat), beat, level);
}

export function removeLevelPoint(row: GridRow, beat: number): GridRow {
  let best = -1;
  for (let i = 0; i < row.levels.length; i += 1) {
    if (best < 0 || Math.abs(row.levels[i].beat - beat) < Math.abs(row.levels[best].beat - beat))
      best = i;
  }
  if (best < 0) return row;
  return { ...row, levels: row.levels.filter((_, i) => i !== best) };
}

// ---------------------------------------------------------------------------
// Selection and clipboard
// ---------------------------------------------------------------------------

/** A rectangle of the grid: some rows, some columns. Rows are held by
 *  ID rather than index so a selection survives a row being added. */
export interface GridSelection {
  rowIds: string[];
  columns: ColumnRange;
}

/** What a copy took: for each row, the placements inside the selection
 *  measured FROM ITS LEFT EDGE, so a paste can land anywhere. */
export interface GridClipboard {
  rows: { clipId: string; offsets: number[] }[];
  width: number;
}

/** The selection a drag from cell (rowA, colA) to (rowB, colB) makes:
 *  every row between the two, and the columns they span. */
export function selectionFromDrag(
  rows: readonly GridRow[],
  rowA: string,
  colA: number,
  rowB: string,
  colB: number,
): GridSelection | null {
  const ia = rows.findIndex((r) => r.id === rowA);
  const ib = rows.findIndex((r) => r.id === rowB);
  if (ia < 0 || ib < 0) return null;
  const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
  return {
    rowIds: rows.slice(lo, hi + 1).map((r) => r.id),
    columns: loopFromDrag(colA, colB),
  };
}

/** One row's share of a selection: the columns, or null when the row is
 *  not in it. Passed to a row instead of the whole selection so that a
 *  row outside it is handed the SAME null every time and can be left
 *  undrawn. */
export function selectionFor(sel: GridSelection | null, rowId: string): ColumnRange | null {
  if (!sel || !sel.rowIds.includes(rowId)) return null;
  return sel.columns;
}

/** A placement counts as inside a selection when the beat it is ANCHORED
 *  by is: the anchor is where the user put the clip, so it is the part
 *  of it the selection is really about. */
function anchorOf(clip: BeatClipEntry, start: Placement): number {
  return start + leadOne(clip);
}

export function copySelection(
  state: GridState,
  clips: ReadonlyMap<string, BeatClipEntry>,
  sel: GridSelection,
): GridClipboard {
  const rows = sel.rowIds.flatMap((id) => {
    const row = state.rows.find((r) => r.id === id);
    const clip = row && clips.get(row.clipId);
    if (!row || !clip) return [];
    const offsets = row.placements
      .filter((start) => inRange(sel.columns, anchorOf(clip, start)))
      .map((start) => anchorOf(clip, start) - sel.columns.start);
    return [{ clipId: row.clipId, offsets }];
  });
  return { rows, width: sel.columns.end - sel.columns.start };
}

/** Paste at `col` — the playhead's column, which is where the user can
 *  see the music is. Each copied row goes back to a row playing the SAME
 *  CLIP (the one it came from if it is still there), so a paste means
 *  the same thing after the rows have been re-ordered. */
export function pasteAt(
  state: GridState,
  clips: ReadonlyMap<string, BeatClipEntry>,
  board: GridClipboard,
  col: number,
): GridState {
  const used = new Set<string>();
  const rows = state.rows.map((row) => row);
  for (const copied of board.rows) {
    const target = rows.find((r) => r.clipId === copied.clipId && !used.has(r.id));
    const clip = clips.get(copied.clipId);
    if (!target || !clip) continue;
    used.add(target.id);
    let next = target;
    for (const offset of copied.offsets) next = placeAnchored(next, clip, col + offset);
    rows[rows.indexOf(target)] = next;
  }
  return { ...state, rows };
}

/** Place a copy anchored at `col` WITHOUT the click's toggle: pasting
 *  onto a beat that already plays should leave the clip there, not take
 *  it away. */
function placeAnchored(row: GridRow, clip: BeatClipEntry, col: number): GridRow {
  const start = col - leadOne(clip);
  const span = placementSpan(clip, start);
  const kept = row.placements.filter((other) => {
    const o = placementSpan(clip, other);
    return o.end <= span.start || o.start >= span.end;
  });
  return { ...row, placements: [...kept, start].sort((a, b) => a - b) };
}

/** FILL a selection with the rows' own clips, laid end to end from its
 *  left edge: a rectangle of empty cells and Enter is how a loop is
 *  written out over sixteen bars without sixteen clicks. Only whole
 *  copies are laid, so a fill never spills past what was marked — except
 *  on a selection too short to hold one, which still gets the single copy
 *  it was asked for. */
export function fillSelection(
  state: GridState,
  clips: ReadonlyMap<string, BeatClipEntry>,
  sel: GridSelection,
): GridState {
  const width = Math.max(1, sel.columns.end - sel.columns.start);
  const rows = state.rows.map((row) => {
    if (!sel.rowIds.includes(row.id)) return row;
    const clip = clips.get(row.clipId);
    if (!clip) return row;
    const beats = Math.max(1, clip.beats);
    const copies = Math.max(1, Math.floor(width / beats));
    let next = row;
    for (let i = 0; i < copies; i += 1) {
      next = placeAnchored(next, clip, sel.columns.start + i * beats + leadOne(clip));
    }
    return next;
  });
  return { ...state, rows };
}

/** A selection moved, and where it now is: the caller keeps the marked
 *  rectangle under the pointer as the drag goes. */
export interface SelectionMove {
  state: GridState;
  selection: GridSelection;
}

/** How far the selection may really step DOWN THE PAGE. A row IS its
 *  clip — a row plays one voice of one clip — so a copy can only land in
 *  a row playing the same clip; anything else and the vertical part of
 *  the drag is simply dropped rather than losing what it carried. */
function rowShift(
  state: GridState,
  order: readonly string[],
  sel: GridSelection,
  dRow: number,
): number {
  if (dRow === 0) return 0;
  const clipOf = (id: string) => state.rows.find((r) => r.id === id)?.clipId;
  const lands = sel.rowIds.every((id) => {
    const to = order[order.indexOf(id) + dRow];
    return to !== undefined && clipOf(to) === clipOf(id);
  });
  return lands ? dRow : 0;
}

/** DRAG THE SELECTION. What is anchored inside it travels by `dCol`
 *  beats (and `dRow` rows, where that lands on the same clip); `copy`
 *  leaves the originals where they are, which is what cmd+drag means.
 *
 *  Measured from the state the drag STARTED on, so the caller can call
 *  this on every pointer move with the total offset and get one result
 *  rather than a walk. */
export function moveSelection(
  state: GridState,
  clips: ReadonlyMap<string, BeatClipEntry>,
  order: readonly string[],
  sel: GridSelection,
  dRow: number,
  dCol: number,
  copy: boolean,
): SelectionMove {
  const shift = rowShift(state, order, sel, dRow);
  // The grid has no beats left of zero: a drag past its start stops
  // there rather than throwing the material away.
  const dx = Math.max(dCol, -sel.columns.start);
  if (shift === 0 && dx === 0) return { state, selection: sel };

  const carried = sel.rowIds.flatMap((id) => {
    const row = state.rows.find((r) => r.id === id);
    const clip = row && clips.get(row.clipId);
    if (!row || !clip) return [];
    const anchors = row.placements
      .map((start) => anchorOf(clip, start))
      .filter((anchor) => inRange(sel.columns, anchor));
    return [{ id, clip, anchors }];
  });

  // Everything the drag picked up leaves first, so a move ONTO a row the
  // selection also covers cannot delete what has just landed there.
  let rows = copy ? state.rows : deleteSelection(state, clips, sel).rows;
  for (const { id, clip, anchors } of carried) {
    const to = order[order.indexOf(id) + shift];
    const at = rows.findIndex((r) => r.id === to);
    if (at < 0) continue;
    rows = rows.map((row, i) =>
      i === at
        ? anchors.reduce((next, anchor) => placeAnchored(next, clip, anchor + dx), row)
        : row,
    );
  }
  return {
    state: { ...state, rows },
    selection: {
      rowIds: sel.rowIds.map((id) => order[order.indexOf(id) + shift] ?? id),
      columns: { start: sel.columns.start + dx, end: sel.columns.end + dx },
    },
  };
}

/** Take every placement anchored inside the selection away. */
export function deleteSelection(
  state: GridState,
  clips: ReadonlyMap<string, BeatClipEntry>,
  sel: GridSelection,
): GridState {
  const rows = state.rows.map((row) => {
    if (!sel.rowIds.includes(row.id)) return row;
    const clip = clips.get(row.clipId);
    if (!clip) return row;
    return {
      ...row,
      placements: row.placements.filter((start) => !inRange(sel.columns, anchorOf(clip, start))),
    };
  });
  return { ...state, rows };
}

// ---------------------------------------------------------------------------
// Beat surgery (the ruler's right-click menu)
// ---------------------------------------------------------------------------

/** Which side of a span an insert or a copy lands on. */
export type BeatSide = 'left' | 'right';

/** Where a beat ends up once `count` beats are opened at `at`. */
function shiftedBeat(beat: number, at: number, count: number): number {
  return beat >= at ? beat + count : beat;
}

/** OPEN `count` empty beats at column `at`: everything ANCHORED there or
 *  later moves along by that many, and the grid grows to match. A clip
 *  that straddles the cut stays where it is — its anchor is before the
 *  cut, and the anchor is the musical fact a placement is held by. */
export function insertBeats(
  state: GridState,
  clips: ReadonlyMap<string, BeatClipEntry>,
  at: number,
  count: number,
): GridState {
  const n = Math.max(0, Math.round(count));
  if (n === 0) return state;
  const rows = state.rows.map((row) => {
    const clip = clips.get(row.clipId);
    if (!clip) return row;
    return {
      ...row,
      placements: row.placements
        .map((start) => (anchorOf(clip, start) >= at ? start + n : start))
        .sort((a, b) => a - b),
      levels: row.levels.map((p) => ({ ...p, beat: shiftedBeat(p.beat, at, n) })),
    };
  });
  return {
    ...state,
    rows,
    tempo: {
      ...state.tempo,
      points: state.tempo.points.map((p) => ({ ...p, beat: shiftedBeat(p.beat, at, n) })),
    },
    beats: state.beats + n,
    loop: state.loop
      ? {
          start: shiftedBeat(state.loop.start, at, n),
          // A loop whose END is exactly the cut does not grow: the beats
          // go in AFTER it, which is what "insert to the right" means.
          end: state.loop.end > at ? state.loop.end + n : state.loop.end,
        }
      : null,
  };
}

/** TAKE the columns `range` covers out of the grid: what is anchored
 *  inside them goes, and everything after closes up over the gap. */
export function deleteBeats(
  state: GridState,
  clips: ReadonlyMap<string, BeatClipEntry>,
  range: ColumnRange,
): GridState {
  const n = Math.max(0, Math.round(range.end - range.start));
  if (n === 0) return state;
  const closed = (beat: number): number =>
    beat < range.start ? beat : Math.max(range.start, beat - n);
  const rows = state.rows.map((row) => {
    const clip = clips.get(row.clipId);
    if (!clip) return row;
    return {
      ...row,
      placements: row.placements
        .filter((start) => !inRange(range, anchorOf(clip, start)))
        .map((start) => (anchorOf(clip, start) >= range.end ? start - n : start))
        .sort((a, b) => a - b),
      levels: row.levels
        .filter((p) => !inRange(range, p.beat))
        .map((p) => ({ ...p, beat: closed(p.beat) })),
    };
  });
  const loop = state.loop;
  return {
    ...state,
    rows,
    tempo: {
      ...state.tempo,
      points: state.tempo.points
        .filter((p) => !inRange(range, p.beat))
        .map((p) => ({ ...p, beat: closed(p.beat) })),
    },
    beats: Math.max(1, state.beats - n),
    // A loop the deletion swallowed whole has nothing left to mark.
    loop:
      !loop || (loop.start >= range.start && loop.end <= range.end)
        ? null
        : { start: closed(loop.start), end: Math.max(closed(loop.start) + 1, closed(loop.end)) },
  };
}

/** DUPLICATE the columns `range` covers to one side of themselves: the
 *  beats are opened first (so nothing is overwritten) and the copies land
 *  in them, anchored the same distance from the new span's start as they
 *  were from the old one's. */
export function copyBeats(
  state: GridState,
  clips: ReadonlyMap<string, BeatClipEntry>,
  range: ColumnRange,
  side: BeatSide,
): GridState {
  const n = Math.max(0, Math.round(range.end - range.start));
  if (n === 0) return state;
  const grown = insertBeats(state, clips, side === 'left' ? range.start : range.end, n);
  // Inserting on the LEFT pushed the material being copied along with
  // everything else; on the right it stayed put.
  const from: ColumnRange =
    side === 'left' ? { start: range.start + n, end: range.end + n } : { ...range };
  const to = side === 'left' ? range.start : range.end;
  const rows = grown.rows.map((row) => {
    const clip = clips.get(row.clipId);
    if (!clip) return row;
    const anchors = row.placements
      .map((start) => anchorOf(clip, start))
      .filter((anchor) => inRange(from, anchor));
    return anchors.reduce(
      (next, anchor) => placeAnchored(next, clip, to + (anchor - from.start)),
      row,
    );
  });
  return { ...grown, rows };
}

/** The pieces beat->time integrates over: the envelope between 0 and
 *  `upto`, cut at every breakpoint inside it. */
function tempoSegments(tempo: GridTempo, upto: number) {
  const segments: { b0: number; b1: number; v0: number; v1: number }[] = [];
  let b0 = 0;
  let v0 = bpmAt(tempo, 0);
  for (const point of sortPoints(tempo.points)) {
    if (point.beat <= 0 || point.beat >= upto) continue;
    segments.push({ b0, b1: point.beat, v0, v1: point.bpm });
    b0 = point.beat;
    v0 = point.bpm;
  }
  segments.push({ b0, b1: upto, v0, v1: bpmAt(tempo, upto) });
  return segments;
}

/** Seconds one segment takes. Constant tempo is beats/bps; a linear ramp
 *  is ∫60/bpm(b) db = 60·Δb·ln(v1/v0)/(v1−v0) — the log mean, which is
 *  why a ramp from 120 to 240 over 4 beats is NOT the 3 s the average
 *  would suggest. */
function segmentSecs(b0: number, b1: number, v0: number, v1: number): number {
  const beats = b1 - b0;
  if (beats <= 0) return 0;
  const a = clampBpm(v0);
  const b = clampBpm(v1);
  if (Math.abs(b - a) < 1e-9) return (beats * 60) / a;
  return (60 * beats * Math.log(b / a)) / (b - a);
}

/** When a beat happens, in seconds from the grid's beat 0. */
export function beatToSecs(tempo: GridTempo, beat: number): number {
  if (beat <= 0) return 0;
  return tempoSegments(tempo, beat).reduce(
    (secs, s) => secs + segmentSecs(s.b0, s.b1, s.v0, s.v1),
    0,
  );
}

/** The inverse — which beat a moment is on. Walks the same segments and
 *  inverts the one the time lands in, so it round-trips `beatToSecs`
 *  through a tempo ramp instead of approximating it. */
export function secsToBeat(tempo: GridTempo, secs: number): number {
  if (secs <= 0) return 0;
  const points = sortPoints(tempo.points);
  let beat = 0;
  let elapsed = 0;
  let v0 = bpmAt(tempo, 0);
  const invert = (t: number, b0: number, a: number, b: number, span: number): number => {
    if (Math.abs(b - a) < 1e-9 || span <= 0) return b0 + (t * a) / 60;
    const k = (b - a) / span;
    return b0 + (a * Math.exp((t * k) / 60) - a) / k;
  };
  for (const point of points) {
    if (point.beat <= beat) continue;
    const span = point.beat - beat;
    const took = segmentSecs(beat, point.beat, v0, point.bpm);
    if (elapsed + took >= secs) {
      return invert(secs - elapsed, beat, clampBpm(v0), clampBpm(point.bpm), span);
    }
    elapsed += took;
    beat = point.beat;
    v0 = point.bpm;
  }
  // Past the last breakpoint the tempo is flat, so the tail is a division.
  return beat + ((secs - elapsed) * clampBpm(v0)) / 60;
}

/** How long a span of columns lasts. */
export function rangeSecs(tempo: GridTempo, range: ColumnRange): number {
  return Math.max(0, beatToSecs(tempo, range.end) - beatToSecs(tempo, range.start));
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

/** The loop a drag across the ruler asks for: whole columns, at least
 *  one wide, whichever way the drag went. */
export function loopFromDrag(a: number, b: number): ColumnRange {
  const start = Math.max(0, Math.min(Math.floor(a), Math.floor(b)));
  const end = Math.max(Math.floor(a), Math.floor(b)) + 1;
  return { start, end };
}

/** What playback walks: the loop if one is set (clamped to the grid),
 *  otherwise the whole grid. */
export function playRange(state: GridState, columns: number): ColumnRange {
  const loop = state.loop;
  if (!loop) return { start: 0, end: columns };
  const start = Math.max(0, Math.min(loop.start, columns - 1));
  const end = Math.max(start + 1, Math.min(loop.end, columns));
  return { start, end };
}

export function inRange(range: ColumnRange, col: number): boolean {
  return col >= range.start && col < range.end;
}

// ---------------------------------------------------------------------------
// What a player has to do
// ---------------------------------------------------------------------------

/** One clip copy to sound: which clip, at which tempo, when it starts
 *  (seconds from the range's beginning) and how much of it to play. */
export interface ScheduledClip {
  /** Identifies the copy across re-schedules, so a grid edited DURING
   *  playback re-lays only what has not been heard yet. */
  key: string;
  rowId: string;
  clipId: string;
  /** The tempo the copy's audio has to be RE-TIMED to (whole bpm, so a
   *  ramp asks for a bounded number of renders). The player fetches the
   *  clip stretched to this and plays it at rate 1.0 — the stretch keeps
   *  the pitch, which resampling would not. Constant per copy: a copy
   *  that straddles a ramp rides the tempo it started on, the honest
   *  thing a fixed buffer can do. */
  bpm: number;
  /** Grid time the copy begins sounding, from the range's start. */
  atSecs: number;
  /** The copy's first beat, as a grid column — where its level is read
   *  from, and what a paste or a selection measures it by. */
  atBeat: number;
  /** Seconds INTO the (re-timed) clip that moment is — non-zero only for
   *  a copy cut into part-way, by the grid's edge or the range's. */
  offsetSecs: number;
  /** Seconds to play; the copy is cut where the play range ends so a
   *  loop never bleeds past its own edge. */
  durationSecs: number;
  /** The row's level over the copy, as `[secsFromCopyStart, gain]` — one
   *  point for a resting row, more where the line bends under it. The
   *  row's rack baseline (`TrackFx.level`) is already in these numbers:
   *  the automation is drawn AGAINST the baseline, so the two multiply
   *  and the player has one gain to write. */
  levels: [number, number][];
  /** Where the copy sits in the stereo field: −1 left … +1 right, off
   *  the row's rack chrome. */
  pan: number;
  /** The row's rack graph as a render spec (`fxRenderSpec`), or null for
   *  the default graph. Non-null asks the player for a SECOND buffer —
   *  the copy's audio rendered through the rack — to crossfade against
   *  the dry one. */
  fx: string | null;
  /** The rack chrome's Wetness: 0 = the dry buffer alone, 1 = the rack's
   *  render alone. Meaningless (and unused) while `fx` is null — the
   *  default rack is neutral, so there is nothing to crossfade to. */
  wet: number;
  /** Which of the clip's bleed bookends this copy sounds, by SIDE (see
   *  `playback::ClipBleed`). The bleed is the material either side of
   *  the clip in the track it was cut from, and on a TIMELINE it goes
   *  back where it came from: the `left` bookend ENDS on the copy's
   *  first beat, the `right` one STARTS where its last beat ends.
   *
   *  That one rule covers both readings of a bleed. Where two copies of
   *  a row run straight into each other the two bookends land on the
   *  join — the left one over the tail of the copy before it, the right
   *  one over the head of the copy after — which is exactly the overlay
   *  a looping player makes of its seam, and no copy ever carries its
   *  own right bleed at its head or its own left bleed at its tail.
   *  Where a copy stands alone they are simply its lead-in and its
   *  tail-out.
   *
   *  False for an end the play RANGE cuts: the beat the bookend is
   *  measured from is not being played, so there is nothing to lead into
   *  or out of. */
  bleed: ClipBleedEnds;
}

/** The bleed ends of one copy — see `ScheduledClip.bleed`. */
export interface ClipBleedEnds {
  left: boolean;
  right: boolean;
}

/** Every clip copy that sounds inside `range`, in start order. Placements
 *  are cut to the range at both ends: one that starts before it plays
 *  from part-way in, one that runs past it stops at the edge. */
export function scheduleRange(
  state: GridState,
  clips: ReadonlyMap<string, BeatClipEntry>,
  range: ColumnRange,
): ScheduledClip[] {
  const out: ScheduledClip[] = [];
  const rangeStartSecs = beatToSecs(state.tempo, range.start);
  const rangeEndSecs = beatToSecs(state.tempo, range.end);
  for (const row of state.rows) {
    const clip = clips.get(row.clipId);
    if (!clip || clip.bpm <= 0) continue;
    const rowFx = fxOrDefault(row.fx);
    const renderSpec = fxRenderSpec(row.fx);
    for (const start of row.placements) {
      const span = placementSpan(clip, start);
      if (span.end <= range.start || span.start >= range.end) continue;
      const from = Math.max(span.start, range.start);
      const fromSecs = beatToSecs(state.tempo, from);
      const bpm = renderBpm(bpmAt(state.tempo, from));
      // The copy's audio is re-timed to `bpm`, so a beat of it lasts a
      // beat of the grid: the offset is that many of the grid's beats,
      // not the clip's original ones.
      const secsPerBeat = 60 / bpm;
      const offsetSecs = Math.max(0, from - span.start) * secsPerBeat;
      const untilSecs = Math.min(beatToSecs(state.tempo, span.end), rangeEndSecs);
      const gridSecs = Math.max(0, untilSecs - fromSecs);
      if (gridSecs <= 0) continue;
      out.push({
        key: `${row.id}:${start}`,
        rowId: row.id,
        clipId: row.clipId,
        bpm,
        atSecs: fromSecs - rangeStartSecs,
        atBeat: from,
        offsetSecs,
        durationSecs: gridSecs,
        levels: levelRamp(state, row, from, Math.min(span.end, range.end)),
        pan: rowFx.pan,
        fx: renderSpec,
        wet: rowFx.wet,
        // Only the ends the copy actually PLAYS carry a bookend; an end
        // the range cuts off is not a moment the bleed can meet.
        bleed: { left: span.start >= range.start, right: span.end <= range.end },
      });
    }
  }
  return out.sort((a, b) => a.atSecs - b.atSecs);
}

/** Tempos are QUANTIZED before a stretch is asked for. Every distinct
 *  value costs a WSOLA render and a cache slot, and a ramp passes
 *  through a continuum of them; whole bpm is finer than anyone can hear
 *  on one clip and leaves the cache a bounded, reusable set. */
export function renderBpm(bpm: number): number {
  return Math.round(clampBpm(bpm));
}

/** The row's level across one copy, as offsets in seconds from where the
 *  copy starts. A resting row gives a single point (the flat line down
 *  the middle); a row with automation gives the value at each end plus
 *  every bend between, which the player ramps through.
 *
 *  The rack's Level knob is the BASELINE the line is read against, not
 *  another gain downstream of it: turning it down halves a fade instead
 *  of fading to half of what the fade wrote. */
function levelRamp(
  state: GridState,
  row: GridRow,
  fromBeat: number,
  toBeat: number,
): [number, number][] {
  const baseline = fxOrDefault(row.fx).level;
  const at = (beat: number): [number, number] => [
    Math.max(0, beatToSecs(state.tempo, beat) - beatToSecs(state.tempo, fromBeat)),
    levelAt(row, beat) * baseline,
  ];
  if (row.levels.length === 0) return [[0, baseline]];
  const inside = row.levels
    .map((p) => p.beat)
    .filter((beat) => beat > fromBeat && beat < toBeat)
    .sort((a, b) => a - b);
  return [at(fromBeat), ...inside.map(at), at(toBeat)];
}

// ---------------------------------------------------------------------------
// The document (Save / Save As / Open / New)
// ---------------------------------------------------------------------------

/** What a saved arrangement is on disk. The clips themselves are NOT in
 *  here — a grid file points at library clips by id, the way a patch
 *  points at them, so saving an arrangement never copies audio and a
 *  re-cut clip is heard in every grid that uses it. */
export interface GridDocument {
  version: 1;
  state: GridState;
}

export const GRID_DOC_VERSION = 1;

export function toDocument(state: GridState): GridDocument {
  return { version: GRID_DOC_VERSION, state };
}

/** Read a saved arrangement, filling in anything a file does not say.
 *  Throws only for input that is not a grid file at all — a missing
 *  field is a default, not an error, so a file saved by an older build
 *  still opens. */
export function fromDocument(raw: unknown): GridState {
  const doc = raw as Partial<GridDocument> | null;
  const state = doc?.state as Partial<GridState> | undefined;
  if (!state || !Array.isArray(state.rows)) throw new Error('not a grid file');
  const tempo = state.tempo ?? { bpm: 120, points: [] };
  return {
    rows: state.rows.map((row, i) => ({
      id: row?.id ?? `row${i + 1}`,
      clipId: String(row?.clipId ?? ''),
      placements: Array.isArray(row?.placements) ? row.placements.map(Number) : [],
      levels: Array.isArray(row?.levels)
        ? row.levels.map((p) => ({ beat: Number(p.beat), level: clampLevel(Number(p.level)) }))
        : [],
      fx: parseTrackFx(row?.fx),
    })),
    tempo: {
      bpm: clampBpm(Number(tempo.bpm ?? 120)),
      points: Array.isArray(tempo.points)
        ? tempo.points.map((p) => ({ beat: Number(p.beat), bpm: clampBpm(Number(p.bpm)) }))
        : [],
    },
    beats: Math.max(1, Math.round(Number(state.beats ?? GRID_MIN_BEATS))),
    barBeats: clampBar(Number(state.barBeats ?? DEFAULT_BAR_BEATS)),
    loop: state.loop ? { start: Number(state.loop.start), end: Number(state.loop.end) } : null,
  };
}

/** Is there anything in this grid worth warning about losing? A grid
 *  with no rows and nothing written on it is what New makes, so it can
 *  be replaced without asking. */
export function isEmptyGrid(state: GridState): boolean {
  return (
    state.rows.length === 0 &&
    state.tempo.points.length === 0 &&
    state.loop === null &&
    state.beats === GRID_MIN_BEATS &&
    state.barBeats === DEFAULT_BAR_BEATS
  );
}
