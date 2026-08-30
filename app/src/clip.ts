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
 *  and where the corrected grid puts it. */
export type WarpPoint = [number, number];

/** The tapped beat grid. `period`/`phase` are the IDEAL grid the taps
 *  averaged to; `times` are where the beats actually sound — inside a
 *  stretch-correction section the beats keep their tapped feel (flam)
 *  rather than being warped onto the ideal grid, and the grid covers
 *  only the tapped (plus explicitly extended) span, never the whole
 *  clip. Twin: `BeatGrid` in `dj_analysis::clip`. */
export interface ClipGrid extends Grid {
  times: number[];
  /** Indices into `times` of beats marked as a "one" (the downbeat),
   *  tapped with LEFT shift. Absent on every grid tapped before the
   *  marker existed, and on any run where nobody marked one — a grid
   *  without a one is a normal state, not a missing field. */
  ones?: number[];
}

export interface ClipProgram {
  regions: ClipRegion[];
  overlays: ClipOverlay[];
  eq: ClipEq;
  level: LevelPoint[];
  crossfade_ms: number;
  /** Beat-tap time warp anchors, strictly increasing in both axes and
   *  identity outside the tapped span. Empty = no stretch. */
  warp: WarpPoint[];
  /** How much the stretch is eased INSIDE each anchor pair, 0…1 (see
   *  `smoothWarp`). 0 steps the rate at every anchor — the click this
   *  control softens; the anchors themselves never move. Twin:
   *  `warp_smoothing` in `dj_analysis::clip`. */
  warp_smoothing: number;
  /** The beat grid the taps built — rides with the warp through undo,
   *  and is what selections quantize against. */
  beat_grid: ClipGrid | null;
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

/** Where the Clip page's smoothing slider starts: enough ease to take
 *  the edge off the rate step at a section boundary, little enough that
 *  the correction still happens where it was asked for. */
export const DEFAULT_WARP_SMOOTHING = 0.3;

export function emptyProgram(): ClipProgram {
  return {
    regions: [],
    overlays: [],
    eq: { bands: defaultEqBands() },
    level: [],
    crossfade_ms: DEFAULT_CROSSFADE_MS,
    warp: [],
    warp_smoothing: 0,
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
  return warpTime(program.warp, total, program.warp_smoothing);
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

/** Sub-segments an eased section is approximated with — twin of
 *  `SMOOTH_STEPS` in `dj_analysis::clip`. */
const SMOOTH_STEPS = 12;
/** Floor under an eased section's rate, so a wildly stretched section
 *  cannot ease itself backwards (twin: `MIN_EASED_RATE`). */
const MIN_EASED_RATE = 0.1;

/** Ease the stretch inside every anchor pair, `smoothing` 0…1.
 *
 *  A section's rate is otherwise constant, so it STEPS at each anchor —
 *  the click this control softens. Here the rate follows a raised cosine
 *  over the section instead: `rate(u) = 1 + e·((1−s) + s·(1 − cos 2πu))`
 *  with `e = ratio − 1`. Its mean over the section is `ratio` whatever
 *  `s` is, so the anchors land EXACTLY where they did; at `s = 1` the
 *  edges are unstretched and the whole correction happens mid-section,
 *  which makes the rate continuous across the anchor. `s = 0` gives the
 *  anchors back untouched.
 *
 *  Twin: `smooth_warp` in `dj_analysis::clip`. */
export function smoothWarp(warp: WarpPoint[], smoothing: number): WarpPoint[] {
  const s0 = Math.min(1, Math.max(0, smoothing));
  if (s0 <= 0 || warp.length < 2) return warp;
  const out: WarpPoint[] = [warp[0]];
  for (let i = 0; i + 1 < warp.length; i += 1) {
    const [x0, y0] = warp[i];
    const [x1, y1] = warp[i + 1];
    const lx = x1 - x0;
    const ly = y1 - y0;
    const e = lx > 0 ? ly / lx - 1 : 0;
    if (lx > 1e-6 && ly > 1e-6 && e !== 0) {
      const s = e < 0 ? Math.min(s0, Math.max(0, (1 - MIN_EASED_RATE) / -e - 1)) : s0;
      for (let k = 1; k < SMOOTH_STEPS; k += 1) {
        const u = k / SMOOTH_STEPS;
        const x = x0 + lx * u;
        const y = y0 + lx * (u + e * (u - (s * Math.sin(2 * Math.PI * u)) / (2 * Math.PI)));
        const prev = out[out.length - 1];
        if (x > prev[0] && y > prev[1]) out.push([x, y]);
      }
    }
    out.push(warp[i + 1]);
  }
  return out;
}

/** Where the warp puts an output time (identity for the empty warp).
 *  Twin: `warp_time_secs` in `dj_analysis::clip`. */
export function warpTime(warp: WarpPoint[], secs: number, smoothing = 0): number {
  if (warp.length < 2) return secs;
  return piecewise(guarded(smoothWarp(warp, smoothing)), secs, 0, 1);
}

/** The inverse: which pre-warp time lands at `secs`. */
export function warpSource(warp: WarpPoint[], secs: number, smoothing = 0): number {
  if (warp.length < 2) return secs;
  return piecewise(guarded(smoothWarp(warp, smoothing)), secs, 1, 0);
}

/** How much the correction moved and stretched things, and how far the
 *  hand was from what the tracker heard: what the grid toolbar displays,
 *  so the section length, the seed and the taps themselves can all be
 *  judged by eye as well as by ear. Every figure is max AND average —
 *  one bad section and a consistently bad grid read the same otherwise. */
export interface TapStats {
  /** Distance an actual beat sits from its ideal grid slot — the timing
   *  kept as feel instead of corrected away. */
  maxFlamSecs: number;
  avgFlamSecs: number;
  /** Stretch a correction section applies, as |ratio − 1| (0.02 = 2%
   *  faster or slower). */
  maxStretch: number;
  avgStretch: number;
  /** How far each right-shift tap landed from the beat the grid put
   *  nearest it — the hand's own error, once the tracker has spoken.
   *  Zero throughout when the taps ARE the grid (nothing fit them). */
  maxMissSecs: number;
  avgMissSecs: number;
  /** Beats the grid covers, and taps the miss was measured over. */
  beats: number;
  taps: number;
}

export interface Tapped {
  warp: WarpPoint[];
  grid: ClipGrid;
  stats: TapStats;
}

/** Which beats of a grid the left-shift taps marked as ones.
 *
 *  A one is never a beat of its own: the hand hits both shifts on the
 *  same beat, so each left tap is first pulled onto the nearest RIGHT
 *  tap (the beat it meant, whatever the two hands' skew), then carried
 *  through the warp onto the nearest beat the grid actually has. With no
 *  right taps at all — a grid measured from something else — the left
 *  tap answers for itself. */
function oneBeats(
  times: number[],
  warp: WarpPoint[],
  smoothing: number,
  handTaps: number[],
  oneTaps: number[],
): number[] {
  if (times.length === 0) return [];
  const marked = new Set<number>();
  for (const t of oneTaps) {
    const tap = handTaps.length
      ? handTaps.reduce((best, h) => (Math.abs(h - t) < Math.abs(best - t) ? h : best))
      : t;
    const at = warpTime(warp, tap, smoothing);
    let nearest = 0;
    for (let i = 1; i < times.length; i += 1) {
      if (Math.abs(times[i] - at) < Math.abs(times[nearest] - at)) nearest = i;
    }
    marked.add(nearest);
  }
  return [...marked].sort((a, b) => a - b);
}

/** What a beat list builds — the tracker's detected beats over the
 *  tapped span (`clip_tap_beats`), or the raw right-shift taps when
 *  nothing fit them. The grid's tempo is the AVERAGE between the first
 *  and last beat (both stay put, so the covered span keeps its length)
 *  and it covers ONLY that span.
 *
 *  `sectionBeats` is the length of the stretch correction: only every
 *  Nth tap is pinned to the ideal grid (a warp anchor). Within a section
 *  the audio moves as one piece and the beats between anchors keep their
 *  tapped positions — adjusted by the section's stretch, not forced even
 *  (their remaining offset is the flam in `stats`). At 1, every beat is
 *  pinned: a perfect grid.
 *
 *  `smoothing` eases that stretch inside each section (`smoothWarp`), so
 *  the beats between anchors land where the eased rate puts them.
 *
 *  `handTaps` are the right-shift taps themselves, kept apart from the
 *  beats because they are usually NOT the same list: they only measure
 *  the tap miss in `stats` (how far the hand was from the beat the grid
 *  landed on), which is what says whether a seed was worth choosing.
 *
 *  `oneTaps` are the LEFT-shift taps — the ones. They never add a beat:
 *  each is carried to the right-shift tap nearest it and from there to
 *  the beat that tap landed on, so what is kept is a FLAG on a beat the
 *  grid already has (`ClipGrid.ones`). */
export function tapGrid(
  beatTimes: number[],
  sectionBeats = 4,
  smoothing = 0,
  handTaps: number[] = [],
  oneTaps: number[] = [],
): Tapped | null {
  const taps: number[] = [];
  for (const t of [...beatTimes].sort((a, b) => a - b)) {
    if (taps.length === 0 || t - taps[taps.length - 1] >= TAP_MIN_GAP_SECS) taps.push(t);
  }
  if (taps.length < 2) return null;
  const first = taps[0];
  const last = taps.length - 1;
  const period = (taps[last] - first) / last;
  if (period <= 0) return null;
  const step = Math.max(1, Math.round(sectionBeats));
  const warp: WarpPoint[] = [];
  for (let i = 0; i < last; i += step) warp.push([taps[i], first + i * period]);
  warp.push([taps[last], first + last * period]);
  const times = taps.map((t) => warpTime(warp, t, smoothing));
  const ones = oneBeats(times, warp, smoothing, handTaps, oneTaps);
  const grid: ClipGrid = { bpm: 60 / period, period, phase: first, beats: taps.length, times };
  if (ones.length) grid.ones = ones;
  let maxFlamSecs = 0;
  let sumFlam = 0;
  for (let i = 0; i <= last; i += 1) {
    const flam = Math.abs(times[i] - (first + i * period));
    maxFlamSecs = Math.max(maxFlamSecs, flam);
    sumFlam += flam;
  }
  let maxStretch = 0;
  let sumStretch = 0;
  const bands = stretchBands(warp);
  for (const band of bands) {
    maxStretch = Math.max(maxStretch, Math.abs(band.ratio - 1));
    sumStretch += Math.abs(band.ratio - 1);
  }
  // The hand tapped the OLD timeline; the grid lives on the warped one,
  // so a tap has to be carried through the warp before it is compared.
  // The distance is to the nearest beat the grid actually HAS — a tap
  // past either end missed by the whole way to the last one.
  let maxMissSecs = 0;
  let sumMiss = 0;
  for (const t of handTaps) {
    const at = warpTime(warp, t, smoothing);
    const miss = times.reduce((best, b) => Math.min(best, Math.abs(b - at)), Infinity);
    maxMissSecs = Math.max(maxMissSecs, miss);
    sumMiss += miss;
  }
  return {
    warp,
    grid,
    stats: {
      maxFlamSecs,
      avgFlamSecs: sumFlam / (last + 1),
      maxStretch,
      avgStretch: bands.length ? sumStretch / bands.length : 0,
      maxMissSecs,
      avgMissSecs: handTaps.length ? sumMiss / handTaps.length : 0,
      beats: taps.length,
      taps: handTaps.length,
    },
  };
}

/** One stretch-correction section of the warp, on the OUTPUT (post-warp)
 *  timeline, with the stretch it applies: `ratio` > 1 slowed the audio
 *  down (made it longer), < 1 sped it up. What the waveform colors —
 *  the section's AVERAGE, which smoothing redistributes within the
 *  section but never changes. */
export interface StretchBand {
  start: number;
  end: number;
  ratio: number;
}

export function stretchBands(warp: WarpPoint[]): StretchBand[] {
  const out: StretchBand[] = [];
  for (let i = 0; i + 1 < warp.length; i += 1) {
    const src = warp[i + 1][0] - warp[i][0];
    const dst = warp[i + 1][1] - warp[i][1];
    if (src > 1e-9 && dst > 1e-9)
      out.push({ start: warp[i][1], end: warp[i + 1][1], ratio: dst / src });
  }
  return out;
}

/** Compose two warps: `next` was tapped against the OUTPUT of `prev`, so
 *  the map the renderer needs is `next ∘ prev`. Exact for piecewise
 *  linear maps: the breakpoints are prev's anchors plus next's pulled
 *  back through prev. Each side is read through its own smoothing (the
 *  composed anchors are then eased as one section list, so every anchor
 *  still lands exactly where it did). */
export function composeWarp(
  prev: WarpPoint[],
  next: WarpPoint[],
  prevSmoothing = 0,
  nextSmoothing = 0,
): WarpPoint[] {
  if (prev.length < 2) return next;
  if (next.length < 2) return prev;
  const xs = [
    ...prev.map((p) => p[0]),
    ...next.map((p) => warpSource(prev, p[0], prevSmoothing)),
  ].sort((a, b) => a - b);
  const out: WarpPoint[] = [];
  for (const x of xs) {
    if (out.length && x - out[out.length - 1][0] < 1e-9) continue;
    out.push([x, warpTime(next, warpTime(prev, x, prevSmoothing), nextSmoothing)]);
  }
  return out;
}

/** The grid's beats inside a view, thinned to at most `cap` lines so
 *  zooming out cannot fill the waveform with hairlines. Only the covered
 *  span has beats — the grid does not continue across the clip. */
export function gridBeatTimes(grid: ClipGrid, from: number, to: number, cap = 240): number[] {
  const ts = grid.times;
  if (ts.length === 0 || to <= from) return [];
  let step = 1;
  while (ts.length / step > cap) step *= 2;
  const out: number[] = [];
  for (let i = 0; i < ts.length; i += step) {
    if (ts[i] >= from && ts[i] <= to) out.push(ts[i]);
  }
  return out;
}

/** The times of the grid's ONE beats inside a view. There are only ever
 *  a handful, so they are never thinned the way `gridBeatTimes` thins the
 *  rest — a marked downbeat has to stay visible zoomed out. */
export function gridOneTimes(grid: ClipGrid, from: number, to: number): number[] {
  if (!grid.ones || to <= from) return [];
  const out: number[] = [];
  for (const i of grid.ones) {
    const t = grid.times[i];
    if (t !== undefined && t >= from && t <= to) out.push(t);
  }
  return out;
}

/** Fractional beat index of an output time against the grid's ACTUAL
 *  beats — piecewise linear between them, continuing at the ideal period
 *  outside the covered span (negative before it). */
export function beatIndexAt(grid: ClipGrid, secs: number): number {
  const ts = grid.times;
  if (ts.length < 2 || grid.period <= 0) return 0;
  const last = ts.length - 1;
  if (secs <= ts[0]) return (secs - ts[0]) / grid.period;
  if (secs >= ts[last]) return last + (secs - ts[last]) / grid.period;
  let i = 0;
  while (secs >= ts[i + 1]) i += 1;
  const span = ts[i + 1] - ts[i];
  return span > 0 ? i + (secs - ts[i]) / span : i;
}

/** Beats a selection covers, fractional against the grid (whole numbers
 *  when both ends sit on beats): what the readout counts. */
export function beatSpan(grid: ClipGrid, start: number, end: number): number {
  return Math.abs(beatIndexAt(grid, end) - beatIndexAt(grid, start));
}

/** The nearest beat of the grid, or the time itself when it falls
 *  outside the covered span — the grid only exists where it was tapped
 *  (or extended), so beyond it nothing snaps. */
export function nearestBeat(grid: ClipGrid, secs: number): number {
  const ts = grid.times;
  if (ts.length === 0) return secs;
  const i = Math.round(beatIndexAt(grid, secs));
  return i >= 0 && i < ts.length ? ts[i] : secs;
}

/** Grow or shrink the covered span by one beat: `by = 1` adds a beat at
 *  the ideal period beyond that edge, `-1` drops the outermost beat.
 *  Null when the step has nowhere to go (before 0, past the clip's end,
 *  or below the two beats a grid needs). */
export function extendGrid(
  grid: ClipGrid,
  edge: 'back' | 'fwd',
  by: 1 | -1,
  duration: number,
): ClipGrid | null {
  const ts = grid.times;
  if (ts.length < 2 || grid.period <= 0) return null;
  let times: number[];
  // A step at the BACK renumbers every beat, so the one markers move
  // with it (one dropped off the edge stops being a beat at all).
  let shift = 0;
  if (by === -1) {
    if (ts.length <= 2) return null;
    times = edge === 'back' ? ts.slice(1) : ts.slice(0, -1);
    if (edge === 'back') shift = -1;
  } else if (edge === 'back') {
    const t = ts[0] - grid.period;
    if (t < -1e-9) return null;
    times = [Math.max(0, t), ...ts];
    shift = 1;
  } else {
    const t = ts[ts.length - 1] + grid.period;
    if (t > duration + 1e-9) return null;
    times = [...ts, Math.min(duration, t)];
  }
  const next: ClipGrid = { ...grid, times, phase: times[0], beats: times.length };
  if (grid.ones) {
    const ones = grid.ones.map((i) => i + shift).filter((i) => i >= 0 && i < times.length);
    if (ones.length) next.ones = ones;
    else delete next.ones;
  }
  return next;
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
 *  into the clip. An end that falls OUTSIDE the covered span stays where
 *  the hand put it — the grid does not reach there. ⌘ frees the whole
 *  gesture (AudioTimeline reads the modifier live), which is how a
 *  window off the grid is chosen. */
export function quantizeRange(grid: ClipGrid, range: TimeRange, duration: number): TimeRange {
  const ts = grid.times;
  if (ts.length < 2 || grid.period <= 0) return range;
  const lo = Math.min(range.start, range.end);
  const hi = Math.max(range.start, range.end);
  const last = ts.length - 1;
  const iLo = beatIndexAt(grid, lo);
  const iHi = beatIndexAt(grid, hi);
  const covered = (i: number) => i > -1e-6 && i < last + 1e-6;
  let start = covered(iLo) ? ts[Math.max(0, Math.floor(iLo + 1e-6))] : lo;
  let end = covered(iHi) ? ts[Math.min(last, Math.ceil(iHi - 1e-6))] : hi;
  if (end - start < 1e-9 && covered(iLo)) {
    // A click-sized sweep inside the grid still selects one whole beat.
    const i = Math.max(0, Math.min(last - 1, Math.floor(iLo + 1e-6)));
    start = ts[i];
    end = ts[i + 1];
  }
  start = Math.max(0, start);
  end = Math.min(duration, end);
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

/** What the tracker heard over a tapped span (`clip_tap_beats`): the
 *  seed the taps chose and its actual beat times, which the UI then
 *  stretches by the same rules raw taps use. Empty `times` is the
 *  graceful refusal — `detail` says why and the taps themselves become
 *  the grid. */
export interface ClipTapBeats {
  times: number[];
  bpm: number;
  seed: string;
  tracker: string;
  detail: string;
  /** Every seed's hearing of the span, best fit first (the head is the
   *  one the taps chose) — the toolbar's seed picker, so overruling the
   *  choice costs no second measurement. */
  seeds: ClipTapSeed[];
}

/** One seed's hearing of a tapped span: a row of the seed picker. */
export interface ClipTapSeed {
  seed: string;
  bpm: number;
  times: number[];
  /** How well the taps land on it, 0..1 — what ranked the list. */
  fit: number;
}

/** What a beat-clip save filed: the record the decks' clip pickers list.
 *  A beat clip wears ONE name; where it came from is a pointer to the
 *  source tracks by the hash of their audio (`edit`), not a copy of
 *  their titles. */
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
  /** Run the tracker over the span a run of right-shift taps covered and
   *  let the taps choose among its seeds — the measured beat times the
   *  grid is built from (the taps themselves when nothing fits). */
  tapBeats(request: ClipRequest, taps: number[]): Promise<ClipTapBeats | null>;
  /** Render a span as a beat clip, cut to exactly `beats` whole beats at
   *  `bpm` (the save row's numbers). The edit is filed with it — the
   *  sources by the hash of their audio, the program's timestamps, beat
   *  grid and warp — and it lands in the decks' clip pickers, like a
   *  Beatify clip. */
  saveBeatClip(
    request: ClipRequest,
    title: string,
    startSecs: number,
    endSecs: number,
    bpm: number,
    beats: number,
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
  tapBeats(request: ClipRequest, taps: number[]) {
    return this.call<ClipTapBeats>('clip_tap_beats', { request, taps });
  }
  saveBeatClip(
    request: ClipRequest,
    title: string,
    startSecs: number,
    endSecs: number,
    bpm: number,
    beats: number,
  ) {
    return this.call<SavedBeatClip>('clip_save_beat_clip', {
      request,
      title,
      startSecs,
      endSecs,
      bpm,
      beats,
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
