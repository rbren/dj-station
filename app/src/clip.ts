// Clip page bridge (PRD §9): edit library tracks into beat clips the
// decks can load.
//
// The program types mirror `dj_analysis::clip`; the edit operations below
// are pure functions over a ClipProgram so the page's behaviour is
// testable without a backend. Region positions on the output timeline
// follow the same law as the Rust renderer (`splice`): adjacent regions
// overlap by the crossfade, capped at half of either neighbour, and the
// tap warp's time mapping exists on both sides too (`warpTime` /
// `warp_time_secs`).

import type { Grid } from './beatify';
import { IpcClient } from './ipc';

export interface ClipRegion {
  /** Index into the request's `sources` (library track ids). */
  source: number;
  start_secs: number;
  end_secs: number;
  reverse: boolean;
  gain_db: number;
}

/** A span mixed OVER the timeline at `at_secs` instead of spliced in. */
export type ClipOverlay = ClipRegion & { at_secs: number };

/** One parametric EQ band — an RBJ peaking bell, pass-through at 0 dB.
 *  Same filter as the rack's EQ module. */
export interface ClipEqBand {
  freq_hz: number;
  gain_db: number;
  q: number;
}

export interface ClipEq {
  bands: ClipEqBand[];
}

export const EQ_MIN_HZ = 20;
export const EQ_MIN_Q = 0.2;
export const EQ_MAX_Q = 12;

/** Four bells at the EQ module's default frequencies (its freq knobs'
 *  defaults, converted from 1 V/oct pitch to Hz). */
export function defaultEqBands(): ClipEqBand[] {
  return [99, 397, 1586, 6343].map((freq_hz) => ({ freq_hz, gain_db: 0, q: 1 }));
}

export interface LevelPoint {
  time_secs: number;
  gain_db: number;
}

/** One tap-warp anchor: output time `[from, to]` — where the audio was,
 *  and where the even grid puts it. */
export type WarpPoint = [number, number];

export interface ClipProgram {
  regions: ClipRegion[];
  overlays: ClipOverlay[];
  eq: ClipEq;
  level: LevelPoint[];
  crossfade_ms: number;
  /** Beat-tap time warp anchors, strictly increasing in both axes and
   *  identity outside the tapped span. Empty = no stretch. */
  warp: WarpPoint[];
  /** The beat grid the taps built — rides with the warp through undo,
   *  and is what selections quantize against. */
  beat_grid: Grid | null;
}

/** One thing the editor cuts from: a library track, or a chosen set of
 *  its stems mixed together. The set is part of the identity — "the
 *  vocals of track 7" is a different source from "track 7".
 *
 *  Empty means the full mix, which is also how "every stem on" is sent:
 *  the track's own file is exact, where re-summing stems is not. */
export interface ClipSourceRef {
  track_id: number;
  /** Empty = the full mix; otherwise STEM_NAMES entries. */
  stems: string[];
}

export interface ClipRequest {
  /** `region.source` indexes into this list. */
  sources: ClipSourceRef[];
  program: ClipProgram;
}

/** A decoded source track, as the editor needs it. */
export interface ClipSource {
  track_id: number;
  /** Which stems this lane is (canonical order), empty for the full mix. */
  stems: string[];
  title: string;
  artist: string;
  duration_secs: number;
  sample_rate: number;
  channels: number;
  peaks: number[];
}

/** Stem order, mirroring `dj_analysis::stems::STEM_NAMES`. */
export const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'] as const;
export type StemName = (typeof STEM_NAMES)[number];

/** Which separation backend the shell is configured with, and whether its
 *  tooling is actually installed on this machine. */
export interface ClipStemBackend {
  /** Separator id — the model name for demucs, e.g. "htdemucs_ft". */
  backend: string;
  available: boolean;
  /** Install hint / failure reason when `available` is false. */
  detail: string | null;
  stems: string[];
}

/** Where a track's stems stand. Nothing here asks for a separation: the
 *  shell separates every downloaded track on its own (history included),
 *  so the page reports progress rather than offering a button. */
export type StemState = 'ready' | 'loading' | 'failed' | 'unavailable';

export interface ClipStemStatus {
  track_id: number;
  backend: string;
  state: StemState;
  /** What the separation is doing, while it is this track's turn. */
  stage: string | null;
  /** Why there will be no stems (missing tooling, repeated failure). */
  detail: string | null;
  /** Tracks still waiting for stems, this one included. */
  pending: number;
}

/** What to tell someone whose stems are not ready yet.
 *
 *  Every one of these is a wait or a reason, never an instruction: there
 *  is no button to press, because separation happens on its own. */
export function stemWait(status: ClipStemStatus | null, backend: ClipStemBackend | null): string {
  if (status?.state === 'ready') return 'Stems are ready';
  if (status && (status.state === 'failed' || status.state === 'unavailable')) {
    return status.detail ?? 'These stems are unavailable';
  }
  if (backend?.available === false) {
    return backend.detail ?? 'Stem separation is unavailable';
  }
  const stage = status?.stage ? ` (${status.stage})` : '';
  const queued = status && status.pending > 1 ? ` · ${status.pending} tracks queued` : '';
  return `Stems are loading${stage}${queued} — separation runs in the background`;
}

/** Label for a source lane: "Title", "Title — vocals" or, once more than
 *  one stem is off, the shorter way round: "Title — no bass". */
export function stemLabel(stems: string[]): string {
  if (stems.length === 0) return '';
  if (stems.length > STEM_NAMES.length - stems.length) {
    const off = STEM_NAMES.filter((s) => !stems.includes(s));
    return `no ${off.join(', ')}`;
  }
  return stems.join(' + ');
}

export function sourceLabel(source: ClipSource): string {
  const stems = stemLabel(source.stems);
  return stems ? `${source.title} — ${stems}` : source.title;
}

export function sourceRef(source: ClipSource): ClipSourceRef {
  return { track_id: source.track_id, stems: source.stems };
}

/** The set the backend would use: every stem on is the full mix, so it
 *  travels as the empty set (and never needs a separation). */
export function stemSet(on: readonly string[]): string[] {
  const kept = STEM_NAMES.filter((s) => on.includes(s));
  return kept.length === STEM_NAMES.length ? [] : kept;
}

export function sameSource(a: ClipSourceRef, b: ClipSourceRef): boolean {
  return (
    a.track_id === b.track_id &&
    a.stems.length === b.stems.length &&
    a.stems.every((s, i) => s === b.stems[i])
  );
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
    overlays: [],
    eq: { bands: defaultEqBands() },
    level: [],
    crossfade_ms: DEFAULT_CROSSFADE_MS,
    warp: [],
    beat_grid: null,
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
  let total = spans.length ? spans[spans.length - 1].end : 0;
  for (const o of program.overlays) {
    total = Math.max(total, Math.max(0, o.at_secs) + regionDuration(o));
  }
  return warpTime(program.warp, total);
}

// ---------------------------------------------------------------------------
// Beat taps: the warp they build and the grid it leaves behind
// ---------------------------------------------------------------------------

/** Two right-shift presses inside this window are one bounced key, not
 *  two beats (a hand cannot tap 1200 BPM on purpose). */
export const TAP_MIN_GAP_SECS = 0.05;

/** The warp anchors with the slope-1 guard points the renderer adds, so
 *  everything outside the tapped span stays put (twin of `warp_map` in
 *  `dj_analysis::clip`). */
function guarded(warp: WarpPoint[]): WarpPoint[] {
  const [f0, f1] = warp[0];
  const [l0, l1] = warp[warp.length - 1];
  return [[f0 - 1, f1 - 1], ...warp, [l0 + 1, l1 + 1]];
}

function piecewise(points: WarpPoint[], x: number, from: 0 | 1, to: 0 | 1): number {
  let i = points.length - 2;
  for (let k = 0; k <= points.length - 2; k += 1) {
    if (x < points[k + 1][from]) {
      i = k;
      break;
    }
  }
  const [a, b] = [points[i], points[i + 1]];
  const span = b[from] - a[from];
  if (span <= 0) return a[to];
  return a[to] + ((b[to] - a[to]) * (x - a[from])) / span;
}

/** Where the warp puts an output time (identity for the empty warp).
 *  Twin: `warp_time_secs` in `dj_analysis::clip`. */
export function warpTime(warp: WarpPoint[], secs: number): number {
  if (warp.length < 2) return secs;
  return piecewise(guarded(warp), secs, 0, 1);
}

/** The inverse: which pre-warp time lands at `secs`. */
export function warpSource(warp: WarpPoint[], secs: number): number {
  if (warp.length < 2) return secs;
  return piecewise(guarded(warp), secs, 1, 0);
}

/** What a run of right-shift taps during playback builds: the average
 *  BPM between the first and last tap, warp anchors that stretch the
 *  audio between them onto a perfectly even grid (the endpoints stay
 *  put — the average preserves the covered span), and that grid. */
export function tapGrid(rawTaps: number[]): { warp: WarpPoint[]; grid: Grid } | null {
  const taps: number[] = [];
  for (const t of [...rawTaps].sort((a, b) => a - b)) {
    if (taps.length === 0 || t - taps[taps.length - 1] >= TAP_MIN_GAP_SECS) taps.push(t);
  }
  if (taps.length < 2) return null;
  const first = taps[0];
  const period = (taps[taps.length - 1] - first) / (taps.length - 1);
  if (period <= 0) return null;
  return {
    warp: taps.map((t, i) => [t, first + i * period]),
    grid: { bpm: 60 / period, period, phase: first, beats: taps.length },
  };
}

/** Compose two warps: `next` was tapped against the OUTPUT of `prev`, so
 *  the map the renderer needs is `next ∘ prev`. Exact for piecewise
 *  linear maps: the breakpoints are prev's anchors plus next's pulled
 *  back through prev. */
export function composeWarp(prev: WarpPoint[], next: WarpPoint[]): WarpPoint[] {
  if (prev.length < 2) return next;
  if (next.length < 2) return prev;
  const xs = [...prev.map((p) => p[0]), ...next.map((p) => warpSource(prev, p[0]))].sort(
    (a, b) => a - b,
  );
  const out: WarpPoint[] = [];
  for (const x of xs) {
    if (out.length && x - out[out.length - 1][0] < 1e-9) continue;
    out.push([x, warpTime(next, warpTime(prev, x))]);
  }
  return out;
}

/** Beat times of the (unclamped) grid across a view, thinned to at most
 *  `cap` lines so zooming out cannot fill the waveform with hairlines. */
export function gridBeatTimes(grid: Grid, from: number, to: number, cap = 240): number[] {
  if (grid.period <= 0 || to <= from) return [];
  let step = 1;
  while ((to - from) / (grid.period * step) > cap) step *= 2;
  const out: number[] = [];
  const first = Math.ceil((from - grid.phase) / (grid.period * step));
  for (let n = first; grid.phase + n * step * grid.period <= to; n += 1) {
    out.push(grid.phase + n * step * grid.period);
  }
  return out;
}

/** The nearest beat of the grid, unclamped: unlike Beatify's track view
 *  the tapped grid extends across the whole clip at its period. */
export function nearestBeat(grid: Grid, secs: number): number {
  if (grid.period <= 0) return secs;
  return grid.phase + Math.round((secs - grid.phase) / grid.period) * grid.period;
}

/** A TIMELINE EDIT DROPS THE TAPPED GRID. The warp's anchors and the
 *  grid's beats are output times, and a cut/trim/move/splice puts
 *  different audio under every one of them — keeping the stretch would
 *  quietly bend the wrong material. Both live in the program, so one
 *  undo brings the edit and the grid back together; tapping again
 *  rebuilds it. Tone edits (EQ, level) keep it: nothing moved. */
export function dropGrid(program: ClipProgram): ClipProgram {
  if (program.warp.length === 0 && program.beat_grid === null) return program;
  return { ...program, warp: [], beat_grid: null };
}

/** Selections quantize OUTWARD to whole beats of the tapped grid, capped
 *  into the clip. ⌘ frees the gesture (AudioTimeline reads the modifier
 *  live), which is how a window off the grid is chosen. */
export function quantizeRange(grid: Grid, range: TimeRange, duration: number): TimeRange {
  if (grid.period <= 0) return range;
  const lo = Math.min(range.start, range.end);
  const hi = Math.max(range.start, range.end);
  const startBeat = Math.floor((lo - grid.phase) / grid.period + 1e-6);
  const endBeat = Math.max(Math.ceil((hi - grid.phase) / grid.period - 1e-6), startBeat + 1);
  const start = Math.max(0, grid.phase + startBeat * grid.period);
  const end = Math.min(duration, grid.phase + endBeat * grid.period);
  return end > start ? { start, end } : range;
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

/** Move the selected range so it starts at `destStart` (drag a selection
 *  left or right along the timeline: cut it out, splice it back in). */
export function moveRange(
  program: ClipProgram,
  from: number,
  to: number,
  destStart: number,
): ClipProgram {
  const iso = isolate(program, from, to);
  if (!iso) return program;
  const moved = iso.regions.slice(iso.from, iso.to);
  if (moved.length === 0) return program;
  const rest = [...iso.regions.slice(0, iso.from), ...iso.regions.slice(iso.to)];
  if (rest.length === 0) return withRegions(program, moved);
  // Land the selection's start at destStart of the final timeline: that is
  // the same time on the remainder's timeline (everything after the
  // insertion just shifts right by the selection's length).
  const restProgram = withRegions(program, rest);
  const t = Math.min(Math.max(0, destStart), programDuration(restProgram));
  const loc = locate(restProgram, t);
  const at = splitAt(rest, loc.index, loc.offset);
  rest.splice(at.index, 0, ...moved);
  return withRegions(program, rest);
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

/** Mix a whole source over the timeline starting at `atSecs`. */
export function addOverlay(
  program: ClipProgram,
  source: number,
  durationSecs: number,
  atSecs: number,
): ClipProgram {
  const overlay: ClipOverlay = {
    source,
    start_secs: 0,
    end_secs: durationSecs,
    reverse: false,
    gain_db: 0,
    at_secs: Math.max(0, atSecs),
  };
  return { ...program, overlays: [...program.overlays, overlay] };
}

export function removeOverlay(program: ClipProgram, index: number): ClipProgram {
  return { ...program, overlays: program.overlays.filter((_, i) => i !== index) };
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
// Selection geometry (pure, so the drag behaviour is testable headless)
// ---------------------------------------------------------------------------

/** A span of the output timeline, in seconds. */
export interface TimeRange {
  start: number;
  end: number;
}

/** Which end of a selection a pointer is grabbing. */
export type SelectionEdge = 'start' | 'end';

/** The edge within `tolerance` seconds of `t`, or null for "not an edge".
 *  The nearer edge wins, so a very short selection still resizes sanely
 *  from whichever side the pointer is closest to. */
export function selectionEdgeAt(
  sel: TimeRange | null,
  t: number,
  tolerance: number,
): SelectionEdge | null {
  if (!sel || tolerance <= 0) return null;
  const dStart = Math.abs(t - sel.start);
  const dEnd = Math.abs(t - sel.end);
  if (Math.min(dStart, dEnd) > tolerance) return null;
  return dStart <= dEnd ? 'start' : 'end';
}

/** Drag one edge of a selection to `t`, keeping the other end anchored.
 *  Dragging an edge past its opposite simply flips the range (the pointer
 *  keeps controlling the same physical end), matching every DAW. */
export function resizeSelection(
  sel: TimeRange,
  edge: SelectionEdge,
  t: number,
  duration: number,
): TimeRange {
  const anchor = edge === 'start' ? sel.end : sel.start;
  const moved = Math.min(Math.max(0, t), Math.max(0, duration));
  return { start: Math.min(anchor, moved), end: Math.max(anchor, moved) };
}

// ---------------------------------------------------------------------------
// Time ruler
// ---------------------------------------------------------------------------

/** Tick spacings that read as round times, from a hundredth of a second
 *  (fully zoomed in) to ten minutes. Thirds of a minute are in there
 *  because 15 s and 30 s labels beat 20 s ones on a music timeline. */
const TICK_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** A labelled mark on the time ruler. `major` ticks carry the label. */
export interface TimeTick {
  secs: number;
  label: string;
  major: boolean;
}

/** Seconds as a ruler label, no more precise than `step` warrants:
 *  `1:30` at whole-second spacing, `1:30.5` at tenths, `1:30.25` below. */
export function tickLabel(secs: number, step: number): string {
  const m = Math.floor(secs / 60);
  const s = secs - m * 60;
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const pad = decimals === 0 ? 2 : decimals + 3;
  return `${m}:${s.toFixed(decimals).padStart(pad, '0')}`;
}

/** Ticks for the visible window [from, to], aiming for about `target`
 *  labels: the step is the coarsest one that still gets there, so the
 *  labels stay put as you zoom instead of crawling. Minor ticks subdivide
 *  each step in halves (fifths where the step is a 5, which subdivides
 *  1-2-5 evenly) and carry no label. */
export function rulerTicks(from: number, to: number, target = 8): TimeTick[] {
  const span = to - from;
  if (!Number.isFinite(span) || span <= 0 || target < 1) return [];
  const ideal = span / target;
  const step = TICK_STEPS.find((s) => s >= ideal) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const mantissa = step / 10 ** Math.floor(Math.log10(step));
  const minors = Math.abs(mantissa - 5) < 1e-9 ? 5 : 2;
  const sub = step / minors;
  const ticks: TimeTick[] = [];
  const first = Math.ceil(from / sub - 1e-9);
  const last = Math.floor(to / sub + 1e-9);
  for (let i = first; i <= last; i++) {
    // Snap away the dust i*sub leaves (3 * 0.005 is not 0.015), or a label
    // lands on 0:00.99 instead of 0:01.00.
    const at = Number((i * sub).toFixed(6));
    const major = Math.abs(at / step - Math.round(at / step)) < 1e-6;
    ticks.push({ secs: at, label: major ? tickLabel(at, step) : '', major });
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/** A measured tempo for a span of the edit (`clip_detect_beats`). */
export interface ClipBeats {
  bpm: number;
  /** Beats the span covers — fractional until a save pads the last one. */
  beats: number;
  /** Which tracker produced it ("beat_this/…" or "dsp"). */
  tracker: string;
}

/** What a beat-clip save filed: the record the decks' clip pickers list. */
export interface SavedBeatClip {
  id: string;
  name: string;
  bpm: number;
  beats: number;
  file: string;
  stems: string[];
}

/** What ClipView needs; tests substitute a mock. */
export interface ClipClientApi {
  /** Decode a track — or a mix of its separated stems — for editing. */
  loadSource(trackId: number, stems: string[], buckets: number): Promise<ClipSource | null>;
  renderPreview(request: ClipRequest, buckets: number): Promise<ClipRender | null>;
  /** 16-bit WAV bytes for a playback window of the rendered edit. */
  previewAudio(request: ClipRequest, startSecs: number, secs: number): Promise<ArrayBuffer | null>;
  /** Measure the tempo of a span of the edit (`beat_this` when it is
   *  installed, the DSP tracker otherwise) — the save row's numbers when
   *  no beat grid was tapped. */
  detectBeats(request: ClipRequest, startSecs: number, endSecs: number): Promise<ClipBeats | null>;
  /** Render a span as a beat clip, padded to whole beats at `bpm`. It
   *  lands in the decks' clip pickers, like a Beatify clip. */
  saveBeatClip(
    request: ClipRequest,
    title: string,
    startSecs: number,
    endSecs: number,
    bpm: number,
  ): Promise<SavedBeatClip | null>;
  /** Which separation backend is configured, and is it installed? */
  stemBackend(): Promise<ClipStemBackend | null>;
  /** Where this track's stems stand — asking also puts it at the front
   *  of the separation queue. */
  stemStatus(trackId: number): Promise<ClipStemStatus | null>;
}

export class ClipClient extends IpcClient implements ClipClientApi {
  loadSource(trackId: number, stems: string[], buckets: number) {
    return this.call<ClipSource>('clip_load_source', { trackId, stems, buckets });
  }
  renderPreview(request: ClipRequest, buckets: number) {
    return this.call<ClipRender>('clip_render_preview', { request, buckets });
  }
  previewAudio(request: ClipRequest, startSecs: number, secs: number) {
    return this.call<ArrayBuffer>('clip_preview_audio', { request, startSecs, secs });
  }
  detectBeats(request: ClipRequest, startSecs: number, endSecs: number) {
    return this.call<ClipBeats>('clip_detect_beats', { request, startSecs, endSecs });
  }
  saveBeatClip(
    request: ClipRequest,
    title: string,
    startSecs: number,
    endSecs: number,
    bpm: number,
  ) {
    return this.call<SavedBeatClip>('clip_save_beat_clip', {
      request,
      title,
      startSecs,
      endSecs,
      bpm,
    });
  }
  stemBackend() {
    return this.call<ClipStemBackend>('clip_stem_backend', {});
  }
  stemStatus(trackId: number) {
    return this.call<ClipStemStatus>('clip_stem_status', { trackId });
  }
}

export const clipClient = new ClipClient();
