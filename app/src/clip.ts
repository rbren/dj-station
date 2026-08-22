// Clip page bridge (PRD §9): edit library tracks into new library tracks.
//
// The program types mirror `dj_analysis::clip`; the edit operations below
// are pure functions over a ClipProgram so the page's behaviour is
// testable without a backend. Region positions on the output timeline
// follow the same law as the Rust renderer (`splice`): adjacent regions
// overlap by the crossfade, capped at half of either neighbour.

import { IpcClient } from './ipc';
import type { Track } from './library';

export interface ClipRegion {
  /** Index into the request's `sources` (library track ids). */
  source: number;
  start_secs: number;
  end_secs: number;
  reverse: boolean;
  gain_db: number;
}

export interface ClipEq {
  low_db: number;
  mid_db: number;
  high_db: number;
}

export interface LevelPoint {
  time_secs: number;
  gain_db: number;
}

export interface ClipProgram {
  regions: ClipRegion[];
  eq: ClipEq;
  level: LevelPoint[];
  crossfade_ms: number;
}

export interface ClipRequest {
  /** Library track ids; `region.source` indexes into this list. */
  sources: number[];
  program: ClipProgram;
}

/** A decoded source track, as the editor needs it. */
export interface ClipSource {
  track_id: number;
  title: string;
  artist: string;
  duration_secs: number;
  sample_rate: number;
  channels: number;
  peaks: number[];
}

/** The rendered edit (no file written). */
export interface ClipRender {
  duration_secs: number;
  sample_rate: number;
  channels: number;
  peaks: number[];
}

/** Level automation floor — mirrors `dj_analysis::clip::SILENCE_DB`. */
export const SILENCE_DB = -60;
export const DEFAULT_CROSSFADE_MS = 5;

export function emptyProgram(): ClipProgram {
  return {
    regions: [],
    eq: { low_db: 0, mid_db: 0, high_db: 0 },
    level: [],
    crossfade_ms: DEFAULT_CROSSFADE_MS,
  };
}

export function regionDuration(r: ClipRegion): number {
  return Math.max(0, r.end_secs - r.start_secs);
}

export interface RegionSpan {
  index: number;
  start: number;
  end: number;
}

/** Where each region lands on the output timeline (crossfades overlap). */
export function regionSpans(program: ClipProgram): RegionSpan[] {
  const xf = Math.max(0, program.crossfade_ms) / 1000;
  const spans: RegionSpan[] = [];
  let cursor = 0;
  let prev: number | null = null;
  program.regions.forEach((r, index) => {
    const dur = regionDuration(r);
    if (dur <= 0) return;
    if (prev !== null) cursor -= Math.min(xf, prev / 2, dur / 2);
    spans.push({ index, start: cursor, end: cursor + dur });
    cursor += dur;
    prev = dur;
  });
  return spans;
}

export function programDuration(program: ClipProgram): number {
  const spans = regionSpans(program);
  return spans.length ? spans[spans.length - 1].end : 0;
}

/** The region under an output time, plus how far into it the time falls. */
function locate(program: ClipProgram, t: number): { index: number; offset: number } {
  const spans = regionSpans(program);
  if (spans.length === 0) return { index: 0, offset: 0 };
  for (const s of spans) {
    if (t < s.end) {
      return { index: s.index, offset: Math.max(0, t - s.start) };
    }
  }
  const last = spans[spans.length - 1];
  return { index: last.index, offset: last.end - last.start };
}

/** Split `regions[index]` `offset` seconds in; returns where the right-hand
 *  part starts (region boundaries are respected, nothing is split twice). */
function splitAt(
  regions: ClipRegion[],
  index: number,
  offset: number,
): { index: number; inserted: boolean } {
  const r = regions[index];
  const dur = regionDuration(r);
  if (offset <= 0) return { index, inserted: false };
  if (offset >= dur) return { index: index + 1, inserted: false };
  // A reversed region plays from its end backwards, so its first `offset`
  // seconds are the tail of the source span.
  const [left, right] = r.reverse
    ? [
        { ...r, start_secs: r.end_secs - offset },
        { ...r, end_secs: r.end_secs - offset },
      ]
    : [
        { ...r, end_secs: r.start_secs + offset },
        { ...r, start_secs: r.start_secs + offset },
      ];
  regions.splice(index, 1, left, right);
  return { index: index + 1, inserted: true };
}

/** Split at both ends of an output-time range; returns the region index
 *  range `[from, to)` the selection now covers exactly. */
function isolate(
  program: ClipProgram,
  fromSecs: number,
  toSecs: number,
): { regions: ClipRegion[]; from: number; to: number } | null {
  const start = Math.max(0, Math.min(fromSecs, toSecs));
  const end = Math.max(fromSecs, toSecs);
  if (end - start <= 0 || program.regions.length === 0) return null;
  const a = locate(program, start);
  const b = locate(program, end);
  const regions = program.regions.map((r) => ({ ...r }));
  // Split the later boundary first so the earlier index stays valid.
  const right = splitAt(regions, b.index, b.offset);
  const left = splitAt(regions, a.index, a.offset);
  const to = right.index + (left.inserted && a.index < right.index ? 1 : 0);
  return { regions, from: left.index, to: Math.max(left.index, to) };
}

function withRegions(program: ClipProgram, regions: ClipRegion[]): ClipProgram {
  return { ...program, regions };
}

/** Delete a range; the remaining material splices together (cut + join). */
export function cutRange(program: ClipProgram, from: number, to: number): ClipProgram {
  const iso = isolate(program, from, to);
  if (!iso) return program;
  iso.regions.splice(iso.from, iso.to - iso.from);
  return withRegions(program, iso.regions);
}

/** Keep only the selected range. */
export function trimTo(program: ClipProgram, from: number, to: number): ClipProgram {
  const iso = isolate(program, from, to);
  if (!iso) return program;
  return withRegions(program, iso.regions.slice(iso.from, iso.to));
}

function mapRange(
  program: ClipProgram,
  from: number,
  to: number,
  fn: (r: ClipRegion) => ClipRegion,
): ClipProgram {
  const iso = isolate(program, from, to);
  if (!iso) return program;
  for (let i = iso.from; i < iso.to; i++) iso.regions[i] = fn(iso.regions[i]);
  return withRegions(program, iso.regions);
}

/** Reverse the selected range (region order flips too, so the whole
 *  selection plays backwards, not just each piece). */
export function reverseRange(program: ClipProgram, from: number, to: number): ClipProgram {
  const iso = isolate(program, from, to);
  if (!iso) return program;
  const flipped = iso.regions
    .slice(iso.from, iso.to)
    .map((r) => ({ ...r, reverse: !r.reverse }))
    .reverse();
  iso.regions.splice(iso.from, iso.to - iso.from, ...flipped);
  return withRegions(program, iso.regions);
}

/** Trim the selected range by `deltaDb`. */
export function gainRange(
  program: ClipProgram,
  from: number,
  to: number,
  deltaDb: number,
): ClipProgram {
  return mapRange(program, from, to, (r) => ({ ...r, gain_db: r.gain_db + deltaDb }));
}

/** Splice a copy of the selected range in right after it. */
export function duplicateRange(program: ClipProgram, from: number, to: number): ClipProgram {
  const iso = isolate(program, from, to);
  if (!iso) return program;
  const copy = iso.regions.slice(iso.from, iso.to).map((r) => ({ ...r }));
  if (copy.length === 0) return program;
  iso.regions.splice(iso.to, 0, ...copy);
  return withRegions(program, iso.regions);
}

/** Splice a whole source onto the end of the clip. */
export function appendSource(
  program: ClipProgram,
  source: number,
  durationSecs: number,
): ClipProgram {
  return withRegions(program, [
    ...program.regions,
    { source, start_secs: 0, end_secs: durationSecs, reverse: false, gain_db: 0 },
  ]);
}

export function removeRegion(program: ClipProgram, index: number): ClipProgram {
  return withRegions(
    program,
    program.regions.filter((_, i) => i !== index),
  );
}

// ---------------------------------------------------------------------------
// Level automation (output timeline, dB breakpoints)
// ---------------------------------------------------------------------------

function sortLevel(points: LevelPoint[]): LevelPoint[] {
  return [...points].sort((a, b) => a.time_secs - b.time_secs);
}

/** Add (or move, when one already sits at that time) a breakpoint. */
export function setLevelPoint(
  program: ClipProgram,
  timeSecs: number,
  gainDb: number,
  epsilon = 1e-3,
): ClipProgram {
  const time = Math.max(0, timeSecs);
  const level = program.level.filter((p) => Math.abs(p.time_secs - time) > epsilon);
  return { ...program, level: sortLevel([...level, { time_secs: time, gain_db: gainDb }]) };
}

export function removeLevelPoint(program: ClipProgram, index: number): ClipProgram {
  return { ...program, level: program.level.filter((_, i) => i !== index) };
}

export function clearLevel(program: ClipProgram): ClipProgram {
  return { ...program, level: [] };
}

/** Fade up from silence over `secs` at the start of the clip. */
export function fadeIn(program: ClipProgram, secs: number): ClipProgram {
  const out = { ...program, level: program.level.filter((p) => p.time_secs > secs) };
  return setLevelPoint(setLevelPoint(out, 0, SILENCE_DB), secs, 0);
}

/** Fade down to silence over the last `secs` of the clip. */
export function fadeOut(program: ClipProgram, secs: number): ClipProgram {
  const end = programDuration(program);
  const start = Math.max(0, end - secs);
  const out = { ...program, level: program.level.filter((p) => p.time_secs < start) };
  return setLevelPoint(setLevelPoint(out, start, 0), end, SILENCE_DB);
}

/** Envelope value at `t` — mirrors `level_db_at` in the renderer. */
export function levelDbAt(points: LevelPoint[], t: number): number {
  if (points.length === 0) return 0;
  const sorted = sortLevel(points);
  if (t <= sorted[0].time_secs) return sorted[0].gain_db;
  const last = sorted[sorted.length - 1];
  if (t >= last.time_secs) return last.gain_db;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (t <= b.time_secs) {
      const span = b.time_secs - a.time_secs;
      if (span <= 0) return b.gain_db;
      return a.gain_db + ((b.gain_db - a.gain_db) * (t - a.time_secs)) / span;
    }
  }
  return last.gain_db;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/** What ClipView needs; tests substitute a mock. */
export interface ClipClientApi {
  loadSource(trackId: number, buckets: number): Promise<ClipSource | null>;
  renderPreview(request: ClipRequest, buckets: number): Promise<ClipRender | null>;
  /** 16-bit WAV bytes for an audition window. */
  previewAudio(request: ClipRequest, startSecs: number, secs: number): Promise<ArrayBuffer | null>;
  /** Render and import as a NEW library track (sources untouched). */
  save(request: ClipRequest, title: string, artist: string): Promise<Track | null>;
}

export class ClipClient extends IpcClient implements ClipClientApi {
  loadSource(trackId: number, buckets: number) {
    return this.call<ClipSource>('clip_load_source', { trackId, buckets });
  }
  renderPreview(request: ClipRequest, buckets: number) {
    return this.call<ClipRender>('clip_render_preview', { request, buckets });
  }
  previewAudio(request: ClipRequest, startSecs: number, secs: number) {
    return this.call<ArrayBuffer>('clip_preview_audio', { request, startSecs, secs });
  }
  save(request: ClipRequest, title: string, artist: string) {
    return this.call<Track>('clip_save', { request, title, artist });
  }
}

export const clipClient = new ClipClient();
