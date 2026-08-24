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

export const SEED_SOURCE: SourceId = 'seed';

export const stemSourceId = (name: string): SourceId => `stem:${name}`;
export const clipSourceId = (id: string): SourceId => `clip:${id}`;

/** IPC shape of a source: what the backend needs to find the audio. */
export type SourceSpec =
  { kind: 'seed' } | { kind: 'stem'; name: string } | { kind: 'clip'; id: string };

export function parseSourceId(id: SourceId): SourceSpec {
  if (id === SEED_SOURCE) return { kind: 'seed' };
  if (id.startsWith('stem:')) return { kind: 'stem', name: id.slice(5) };
  if (id.startsWith('clip:')) return { kind: 'clip', id: id.slice(5) };
  throw new Error(`beatify clip: unknown source ${id}`);
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

export function emptyDraft(name = 'Untitled clip'): ClipDraft {
  return { name, rows: 1, columns: DEFAULT_COLUMNS, placements: [] };
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

export interface ClipSourceInfo {
  source: SourceSpec;
  label: string;
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
      return SEED_SOURCE;
    case 'stem':
      return stemSourceId(spec.name);
    case 'clip':
      return clipSourceId(spec.id);
  }
}

export function fromWire(clip: SavedClip): ClipDraft {
  return {
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
  sources(trackId: number): Promise<ClipSources | null>;
  open(trackId: number, source: SourceSpec, buckets: number): Promise<ClipSourceAudio | null>;
  audio(
    trackId: number,
    source: SourceSpec,
    startSecs: number,
    secs: number,
  ): Promise<ArrayBuffer | null>;
  preview(
    trackId: number,
    draft: ClipDraft,
    startSecs: number,
    secs: number,
  ): Promise<ArrayBuffer | null>;
  save(trackId: number, clip: SavedClip): Promise<SavedClip[] | null>;
  remove(trackId: number, id: string): Promise<SavedClip[] | null>;
}

export class BeatifyClipClient extends IpcClient implements BeatifyClipClientApi {
  sources(trackId: number) {
    return this.call<ClipSources>('beatify_clip_sources', { trackId });
  }
  open(trackId: number, source: SourceSpec, buckets: number) {
    return this.call<ClipSourceAudio>('beatify_clip_open', { trackId, source, buckets });
  }
  audio(trackId: number, source: SourceSpec, startSecs: number, secs: number) {
    return this.call<ArrayBuffer>('beatify_clip_audio', { trackId, source, startSecs, secs });
  }
  preview(trackId: number, draft: ClipDraft, startSecs: number, secs: number) {
    return this.call<ArrayBuffer>('beatify_clip_preview', {
      trackId,
      draft: toWire(draft),
      startSecs,
      secs,
    });
  }
  save(trackId: number, clip: SavedClip) {
    return this.call<SavedClip[]>('beatify_clip_save', { trackId, clip });
  }
  remove(trackId: number, id: string) {
    return this.call<SavedClip[]>('beatify_clip_delete', { trackId, id });
  }
}

export const beatifyClipClient = new BeatifyClipClient();
