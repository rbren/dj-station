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

/** Where one copy of a row's clip sits: the grid column its OWN beat 0
 *  lands on. Negative means the clip begins before the grid does (its
 *  first one still lands where the user clicked). */
export type Placement = number;

export interface GridRow {
  /** Stable across re-orders and clip reloads; the layout is keyed by it. */
  id: string;
  clipId: string;
  placements: Placement[];
}

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
  /** The columns playback is confined to, or null for the whole grid. */
  loop: ColumnRange | null;
}

export const GRID_MIN_BEATS = 32;
/** One click of the "longer" button — a phrase, not a beat. */
export const GRID_GROW_BEATS = 16;

export function emptyGrid(bpm = 120): GridState {
  return { rows: [], tempo: { bpm, points: [] }, beats: GRID_MIN_BEATS, loop: null };
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
  const row: GridRow = { id: nextRowId(state.rows), clipId: clip.clipId, placements: [] };
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

export function clearTempo(tempo: GridTempo): GridTempo {
  return { ...tempo, points: [] };
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

/** One clip copy to sound: which clip, when it starts (seconds from the
 *  grid's beat 0), how far into the clip that is, and how fast it has to
 *  run to sit on the grid's beats. */
export interface ScheduledClip {
  rowId: string;
  clipId: string;
  /** Grid time the copy begins sounding. */
  atSecs: number;
  /** Seconds INTO the clip that moment is — non-zero only for a copy
   *  that starts before the grid does (a placement anchored so far left
   *  that its head is off-grid) or before the play range begins. */
  offsetSecs: number;
  /** Seconds of the clip to play; the copy is cut where the play range
   *  ends so a loop never bleeds past its own edge. */
  durationSecs: number;
  /** Sample-rate scaling: the grid's tempo where the copy starts against
   *  the tempo the clip was cut at. Constant per copy — a copy that
   *  straddles a tempo ramp rides the tempo it started on, which is the
   *  honest thing a fixed-rate buffer can do. */
  rate: number;
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
    const clipSecsPerBeat = 60 / clip.bpm;
    for (const start of row.placements) {
      const span = placementSpan(clip, start);
      if (span.end <= range.start || span.start >= range.end) continue;
      const from = Math.max(span.start, range.start);
      const fromSecs = beatToSecs(state.tempo, from);
      const rate = bpmAt(state.tempo, from) / clip.bpm;
      // Where the grid is when the copy is cut in: its own beats, at its
      // own tempo, scaled by nothing — the offset is a position in the
      // clip's material.
      const offsetSecs = Math.max(0, from - span.start) * clipSecsPerBeat;
      const untilSecs = Math.min(beatToSecs(state.tempo, span.end), rangeEndSecs);
      const gridSecs = Math.max(0, untilSecs - fromSecs);
      if (gridSecs <= 0) continue;
      out.push({
        rowId: row.id,
        clipId: row.clipId,
        atSecs: fromSecs - rangeStartSecs,
        offsetSecs,
        durationSecs: gridSecs * rate,
        rate,
      });
    }
  }
  return out.sort((a, b) => a.atSecs - b.atSecs);
}
