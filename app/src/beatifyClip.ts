// The clip builder's model: what a clip IS, and what dropping beats into
// one does to it.
//
// A clip is a grid. Columns are BEATS of the beatified grid — every
// source on the page shares one, which is the whole point of beatifying —
// and rows are tracks that sound together. A `Placement` is one
// contiguous run of beats taken from one source and put at one spot:
// three beats dragged in stay three beats, one block, not three cells
// that happen to be adjacent (BC-3). Two runs that end up touching stay
// two blocks, and the editor draws the seam between them.
//
// Everything here is pure. The audio it describes is assembled by the
// backend (`beatify_clip_preview`), which reads the same fields.

import { IpcClient } from './ipc';

/** Which audio a run of beats was cut from. A string because it keys
 *  React lists, colours and the source list; `parseSourceId` is the only
 *  thing that takes one apart, for IPC. */
export type SourceId = string;

/** A seed, whole: `seed:s1`. With only some of its parts switched on the
 *  id says which — `seed:s1/drums+bass` — because a run cut from the
 *  drums alone has to remember that it was the drums alone. */
export const seedSourceId = (seedId: string, stems: readonly string[] = []): SourceId =>
  stems.length === 0 ? `seed:${seedId}` : `seed:${seedId}/${[...stems].join('+')}`;

export const clipSourceId = (id: string): SourceId => `clip:${id}`;

/** What a seed PLAYS, given which of its parts are switched off. `off`
 *  undefined means nobody has touched its switches.
 *
 *  UNTOUCHED IS THE RENDER; TOUCHED IS THE PARTS — including when every
 *  part is switched back on, which is why this returns the whole kit by
 *  name rather than a bare seed id. Dropping the vocals has to leave the
 *  drums exactly as they were, and a sum of stems is not sample-for-sample
 *  the render they were separated out of: mixing the two means every
 *  switch also nudges everything it did not touch. So a seed being taken
 *  apart is played from its parts from then on, and a seed nobody is
 *  taking apart costs no separated audio at all. */
export function seedMix(
  seedId: string,
  parts: readonly string[],
  off: readonly string[] | undefined,
): SourceId {
  if (off === undefined) return seedSourceId(seedId);
  return seedSourceId(
    seedId,
    parts.filter((name) => !off.includes(name)),
  );
}

/** Whether a source is a seed with all of `parts` playing — the whole of
 *  it, however it is being resolved, so it is named after itself and not
 *  after a list of everything it contains. */
export function isWholeSeed(id: SourceId, parts: readonly string[]): boolean {
  const on = stemsOfSourceId(id);
  return on.length === 0 || (parts.length > 0 && on.length === parts.length);
}

/** IPC shape of a source: what the backend needs to find the audio. */
export type SourceSpec =
  { kind: 'seed'; id: string; stems: string[] } | { kind: 'clip'; id: string };

export function parseSourceId(id: SourceId): SourceSpec {
  if (id.startsWith('seed:')) {
    const [seed, stems] = id.slice(5).split('/');
    return { kind: 'seed', id: seed, stems: stems ? stems.split('+') : [] };
  }
  if (id.startsWith('clip:')) return { kind: 'clip', id: id.slice(5) };
  throw new Error(`beatify clip: unknown source ${id}`);
}

/** Which seed a source belongs to: '' for a clip, and '' for nothing at
 *  all — an empty project has no source open, which is not an error. */
export function seedOfSourceId(id: SourceId): string {
  if (!id.startsWith('seed:')) return '';
  const spec = parseSourceId(id);
  return spec.kind === 'seed' ? spec.id : '';
}

/** The stems switched on for a source; empty means the whole mix. */
export function stemsOfSourceId(id: SourceId): string[] {
  if (!id.startsWith('seed:')) return [];
  const spec = parseSourceId(id);
  return spec.kind === 'seed' ? spec.stems : [];
}

/** One contiguous run of beats, taken from one source, placed once. */
export interface Placement {
  /** Unique within a draft; identity for selection, drag and React keys. */
  id: string;
  row: number;
  /** Column (beat) it starts at in the clip. */
  col: number;
  /** How many beats it covers. Always ≥ 1. */
  beats: number;
  source: SourceId;
  /** The beat of the SOURCE its first column came from. */
  sourceBeat: number;
}

/** A clip being built (or a saved one, loaded back for editing). */
export interface ClipDraft {
  /** The id it is filed under, or '' while it has never been saved.
   *  IDENTITY, not the name: saving twice overwrites one clip, and only
   *  a clip that has an id can be deleted. */
  id: string;
  name: string;
  rows: number;
  columns: number;
  placements: Placement[];
}

/** What a drag is carrying: a run of beats lifted off a source. */
export interface BeatRun {
  source: SourceId;
  sourceBeat: number;
  beats: number;
}

export const DEFAULT_COLUMNS = 16;

/** What a clip nobody has named yet is called. */
export const UNTITLED_CLIP = 'Untitled clip';

export function emptyDraft(name = UNTITLED_CLIP): ClipDraft {
  return { id: '', name, rows: 1, columns: DEFAULT_COLUMNS, placements: [] };
}

/** A default name that is not already on the shelf: "Untitled clip", then
 *  "Untitled clip 2", and so on. Saving clears the desk, so the default
 *  is landed on again and again — and clips are filed by id, so nothing
 *  stops two of them being called the same thing and becoming two rows
 *  the user cannot tell apart. A name typed over is never touched. */
export function freshClipName(taken: readonly string[]): string {
  if (!taken.includes(UNTITLED_CLIP)) return UNTITLED_CLIP;
  let n = 2;
  while (taken.includes(`${UNTITLED_CLIP} ${n}`)) n += 1;
  return `${UNTITLED_CLIP} ${n}`;
}

/** Has this draft ever been saved? What the Delete button waits for. */
export function isSaved(draft: ClipDraft): boolean {
  return draft.id !== '';
}

let nextId = 0;

/** Placement ids are per-session and never persisted as meaning. */
export function placementId(): string {
  nextId += 1;
  return `p${nextId}`;
}

/** The column after the last one with anything in it — the clip's real
 *  length, as opposed to the grid drawn around it. */
export function usedColumns(draft: ClipDraft): number {
  return draft.placements.reduce((n, p) => Math.max(n, p.col + p.beats), 0);
}

/** Seconds a clip of `columns` beats lasts on this grid. */
export function clipSeconds(columns: number, period: number): number {
  return Math.max(0, columns) * period;
}

/** Where a placement sits, in beats: `[col, col + beats)`. */
function covers(p: Placement, from: number, to: number): boolean {
  return p.col < to && from < p.col + p.beats;
}

/** Trim `p` so it does not overlap `[from, to)`, splitting it in two when
 *  the hole is punched out of its middle. Returns what is left. */
function carve(p: Placement, from: number, to: number): Placement[] {
  const end = p.col + p.beats;
  const left: Placement[] = [];
  if (p.col < from) {
    left.push({ ...p, beats: from - p.col });
  }
  if (end > to) {
    // The right-hand piece is a NEW run: it starts further into the
    // source by exactly as much as was cut off its front.
    left.push({
      ...p,
      id: placementId(),
      col: to,
      beats: end - to,
      sourceBeat: p.sourceBeat + (to - p.col),
    });
  }
  return left;
}

/** Drop a run of beats at `row`/`col`. What is already there gives way —
 *  the dropped material wins, like every DAW — and the grid grows to the
 *  right if the run runs off the end (BC-5). Rows grow the same way, so a
 *  drop below the last row adds the rows it needs. */
export function placeRun(draft: ClipDraft, run: BeatRun, row: number, col: number): ClipDraft {
  const at = Math.max(0, Math.round(col));
  const into = Math.max(0, Math.round(row));
  const end = at + run.beats;
  const placements = draft.placements.flatMap((p) =>
    p.row === into && covers(p, at, end) ? carve(p, at, end) : [p],
  );
  placements.push({
    id: placementId(),
    row: into,
    col: at,
    beats: run.beats,
    source: run.source,
    sourceBeat: run.sourceBeat,
  });
  return {
    ...draft,
    rows: Math.max(draft.rows, into + 1),
    columns: Math.max(draft.columns, end),
    placements,
  };
}

/** Move a placement already in the clip. Same rules as a fresh drop, and
 *  the mover never carves ITSELF. */
export function movePlacement(draft: ClipDraft, id: string, row: number, col: number): ClipDraft {
  const moving = draft.placements.find((p) => p.id === id);
  if (!moving) return draft;
  const without = { ...draft, placements: draft.placements.filter((p) => p.id !== id) };
  return placeRun(
    without,
    { source: moving.source, sourceBeat: moving.sourceBeat, beats: moving.beats },
    row,
    col,
  );
}

export function removePlacement(draft: ClipDraft, id: string): ClipDraft {
  return { ...draft, placements: draft.placements.filter((p) => p.id !== id) };
}

// ---------------------------------------------------------------------------
// Selecting, copying and pasting a chunk of the grid
// ---------------------------------------------------------------------------

/** A rectangle of the grid: rows `[row0, row1]` inclusive (there are few
 *  of them and they are named by index), beats `[col0, col1)` half-open
 *  (a range of beats, like every other beat range here). */
export interface CellRange {
  row0: number;
  row1: number;
  col0: number;
  col1: number;
}

/** The rectangle two swept cells describe, whichever way round they were
 *  swept. The cell under the pointer is always included. */
export function cellRange(
  anchor: { row: number; col: number },
  to: { row: number; col: number },
): CellRange {
  return {
    row0: Math.min(anchor.row, to.row),
    row1: Math.max(anchor.row, to.row),
    col0: Math.min(anchor.col, to.col),
    col1: Math.max(anchor.col, to.col) + 1,
  };
}

export function rangeHas(range: CellRange, row: number, col: number): boolean {
  return row >= range.row0 && row <= range.row1 && col >= range.col0 && col < range.col1;
}

/** What a clipboard holds: runs of beats with their positions made
 *  RELATIVE to the corner of the copied rectangle, so a paste can land
 *  anywhere and keep the shape it was cut from. */
export interface ClipFragment {
  rows: number;
  columns: number;
  placements: Placement[];
}

/** Copy what is inside `range`, trimming runs at its edges: what you see
 *  selected is what you get, not the whole run it belonged to. */
export function copyRange(draft: ClipDraft, range: CellRange): ClipFragment {
  const placements = draft.placements.flatMap((p) => {
    if (p.row < range.row0 || p.row > range.row1) return [];
    const from = Math.max(p.col, range.col0);
    const to = Math.min(p.col + p.beats, range.col1);
    if (to <= from) return [];
    return [
      {
        ...p,
        row: p.row - range.row0,
        col: from - range.col0,
        beats: to - from,
        // Cutting the front off a run starts it further into its source.
        sourceBeat: p.sourceBeat + (from - p.col),
      },
    ];
  });
  return { rows: range.row1 - range.row0 + 1, columns: range.col1 - range.col0, placements };
}

export function fragmentIsEmpty(fragment: ClipFragment): boolean {
  return fragment.placements.length === 0;
}

/** Paste a fragment with its corner at `row`/`col`. Every run lands by
 *  the ordinary drop rules, so what was there gives way and the grid
 *  grows if the paste runs off the end. */
export function pasteFragment(
  draft: ClipDraft,
  fragment: ClipFragment,
  row: number,
  col: number,
): ClipDraft {
  return fragment.placements.reduce(
    (cur, p) =>
      placeRun(
        cur,
        { source: p.source, sourceBeat: p.sourceBeat, beats: p.beats },
        row + p.row,
        col + p.col,
      ),
    draft,
  );
}

/** Add an empty row at the bottom. */
export function addRow(draft: ClipDraft): ClipDraft {
  return { ...draft, rows: draft.rows + 1 };
}

/** Drop the last row, and anything in it. Never goes below one row. */
export function removeLastRow(draft: ClipDraft): ClipDraft {
  if (draft.rows <= 1) return draft;
  const row = draft.rows - 1;
  return { ...draft, rows: row, placements: draft.placements.filter((p) => p.row !== row) };
}

/** How long the clip IS, in beats — the length the editor draws, loops
 *  and renders, trailing silence included. A clip is as long as it was
 *  set to be, not as long as the material in it happens to reach. */
export function drawnColumns(draft: ClipDraft): number {
  return Math.max(1, draft.columns);
}

/** Set the clip's length. Material that no longer fits is trimmed, and a
 *  run left entirely past the end goes: a shorter clip is a shorter clip,
 *  and pretending otherwise would hide beats that cannot be heard. */
export function setColumns(draft: ClipDraft, columns: number): ClipDraft {
  const n = Math.max(1, Math.round(columns));
  const placements = draft.placements.flatMap((p) =>
    p.col >= n ? [] : p.col + p.beats <= n ? [p] : [{ ...p, beats: n - p.col }],
  );
  return { ...draft, columns: n, placements };
}

/** Placements of one row, left to right. */
export function rowPlacements(draft: ClipDraft, row: number): Placement[] {
  return draft.placements.filter((p) => p.row === row).sort((a, b) => a.col - b.col);
}

/** Does `p` start exactly where its neighbour on the left ends? Two runs
 *  that abut are still two runs, and the editor draws the join so the
 *  difference is visible (BC-4). */
export function abutsLeft(draft: ClipDraft, p: Placement): boolean {
  return draft.placements.some(
    (o) => o.row === p.row && o.id !== p.id && o.col + o.beats === p.col,
  );
}

/** A stable colour index per source, so the same material reads the same
 *  everywhere in the editor. */
export function sourceTint(id: SourceId, order: readonly SourceId[]): number {
  const at = order.indexOf(id);
  return at < 0 ? 0 : at % 6;
}

/** Is there anything to render? An empty clip is silence, and asking the
 *  backend for silence is a waste of a round trip. */
export function isEmpty(draft: ClipDraft): boolean {
  return draft.placements.length === 0;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/** What a save answers with: the id it was filed under (the draft has to
 *  learn it, or its next save would file a second copy) and the list as
 *  it now stands. */
export interface ClipSaved {
  id: string;
  clips: SavedClip[];
}

/** A saved clip, as the backend files it. */
export interface SavedClip {
  id: string;
  name: string;
  rows: number;
  columns: number;
  placements: WirePlacement[];
}

/** A placement on the wire: the same fields, with the source expanded
 *  into the tagged shape serde wants. */
export interface WirePlacement {
  id: string;
  row: number;
  col: number;
  beats: number;
  source: SourceSpec;
  sourceBeat: number;
}

/** One seed in the left-hand list, with the parts it can be broken into.
 *  A stem is not a source of its own: it is this seed with some of its
 *  parts switched off, the way the Clip page treats stems. */
export interface ClipSourceInfo {
  source: SourceSpec;
  seedId: string;
  label: string;
  beats: number;
  sourceBpm: number;
  speed: number;
  available: boolean;
  hint: string | null;
  stems: ClipStemInfo[];
}

export interface ClipStemInfo {
  name: string;
  available: boolean;
  hint: string | null;
}

export interface ClipSources {
  sources: ClipSourceInfo[];
  clips: SavedClip[];
  grid: { bpm: number; period: number; phase: number; beats: number };
}

/** A source opened for the timeline. */
export interface ClipSourceAudio {
  source: SourceSpec;
  label: string;
  durationSecs: number;
  sampleRate: number;
  channels: number;
  beats: number;
  peaks: number[];
}

export function toWire(draft: ClipDraft): {
  name: string;
  rows: number;
  columns: number;
  placements: WirePlacement[];
} {
  return {
    name: draft.name,
    rows: draft.rows,
    columns: draft.columns,
    placements: draft.placements.map((p) => ({
      id: p.id,
      row: p.row,
      col: p.col,
      beats: p.beats,
      source: parseSourceId(p.source),
      sourceBeat: p.sourceBeat,
    })),
  };
}

export function sourceIdOf(spec: SourceSpec): SourceId {
  switch (spec.kind) {
    case 'seed':
      return seedSourceId(spec.id, spec.stems ?? []);
    case 'clip':
      return clipSourceId(spec.id);
  }
}

export function fromWire(clip: SavedClip): ClipDraft {
  return {
    id: clip.id,
    name: clip.name,
    rows: clip.rows,
    columns: clip.columns,
    placements: clip.placements.map((p) => ({
      id: p.id || placementId(),
      row: p.row,
      col: p.col,
      beats: p.beats,
      source: sourceIdOf(p.source),
      sourceBeat: p.sourceBeat,
    })),
  };
}

/** What the clip builder needs; tests substitute a mock. */
export interface BeatifyClipClientApi {
  sources(projectId: string): Promise<ClipSources | null>;
  open(projectId: string, source: SourceSpec, buckets: number): Promise<ClipSourceAudio | null>;
  audio(
    projectId: string,
    source: SourceSpec,
    startSecs: number,
    secs: number,
  ): Promise<ArrayBuffer | null>;
  preview(
    projectId: string,
    draft: ClipDraft,
    startSecs: number,
    secs: number,
  ): Promise<ArrayBuffer | null>;
  save(projectId: string, clip: SavedClip): Promise<ClipSaved | null>;
  remove(projectId: string, id: string): Promise<SavedClip[] | null>;
}

export class BeatifyClipClient extends IpcClient implements BeatifyClipClientApi {
  sources(projectId: string) {
    return this.call<ClipSources>('beatify_clip_sources', { projectId });
  }
  open(projectId: string, source: SourceSpec, buckets: number) {
    return this.call<ClipSourceAudio>('beatify_clip_open', { projectId, source, buckets });
  }
  audio(projectId: string, source: SourceSpec, startSecs: number, secs: number) {
    return this.call<ArrayBuffer>('beatify_clip_audio', { projectId, source, startSecs, secs });
  }
  preview(projectId: string, draft: ClipDraft, startSecs: number, secs: number) {
    return this.call<ArrayBuffer>('beatify_clip_preview', {
      projectId,
      draft: toWire(draft),
      startSecs,
      secs,
    });
  }
  save(projectId: string, clip: SavedClip) {
    return this.call<ClipSaved>('beatify_clip_save', { projectId, clip });
  }
  remove(projectId: string, id: string) {
    return this.call<SavedClip[]>('beatify_clip_delete', { projectId, id });
  }
}

export const beatifyClipClient = new BeatifyClipClient();
