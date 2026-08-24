// Beatify tab bridge: types mirror `dj_analysis::beatify` (camelCase on
// both sides, because the §5 payload the tab emits is specified that way)
// and the grid math below is pure, so the page's behaviour is testable
// without a backend.
//
// Beat n is at `phase + n * period`. Exactly. There is no beat array, no
// meter and no bars anywhere in this file: `ruler.group` is a display
// preference and nothing else reads it.

import { IpcClient } from './ipc';

export interface Grid {
  bpm: number;
  period: number;
  /** Seconds of beat 0 in the warped file — always one period. */
  phase: number;
  beats: number;
}

export interface Reading {
  /** Metrical level: 2 doubles the tempo, 0.5 halves it. */
  factor: number;
  half_shift?: boolean;
  halfShift?: boolean;
}

export type Verdict = 'unanimous' | 'mostlyAgreed' | 'split' | 'metricalSplit' | 'singleTracker';

export interface SeedReading {
  seed: string;
  bpm: number;
  beats: number;
}

export interface Agreement {
  verdict: Verdict;
  tempoSpreadBpm: number;
  phaseAgreementPct: number;
  metricalSplit: boolean;
  readings: SeedReading[];
  disagreementSpans: [number, number][];
}

export interface Quality {
  worstFlamMs: number;
  peakStretchPct: number;
  rmsMs: number;
  inBandPct: number;
}

export interface SweepPoint {
  strength: number;
  stride: number;
  quality: Quality;
}

export interface Sweep {
  points: SweepPoint[];
  zone: [number, number] | null;
  defaultStrength: number;
}

export interface DriftSpan {
  startSecs: number;
  endSecs: number;
  deltaBpm: number;
}

export interface BeatifySource {
  trackId: number;
  title: string;
  artist: string;
  durationSecs: number;
  sampleRate: number;
  channels: number;
  peaks: number[];
}

export interface BeatifyAnalysis {
  source: BeatifySource;
  tracker: string;
  region: [number, number];
  /** The OUTPUT timebase: beat 0 is the head pad, so it cannot say where
   *  a beat is in the file you are looking at. */
  grid: Grid;
  /** The same beats in SOURCE seconds, spanning the whole file — what the
   *  modal draws over the source waveform and snaps its region to. */
  sourceGrid: Grid;
  reading: Reading;
  agreement: Agreement;
  beats: number[];
  confidence: number[];
  drift: DriftSpan[];
  sweep: Sweep;
  strength: number;
  quality: Quality;
  residuals: number[];
  /** Which `sourceGrid` beat each residual is about. Detections the
   *  tracker never found leave gaps, so this is NOT `0..residuals`. */
  residualBeats: number[];
  anchors: number[];
  leadIn: number;
  metricalFlag: boolean;
  outputSecs: number;
}

export interface BeatifyMeters {
  strength: number;
  anchorStride: number;
  quality: Quality;
  residuals: number[];
  anchors: number[];
}

/** One beat of the cut point inspector (§3.5). `samples` is peak-reduced
 *  source audio across the window; `attack` is where the transient starts
 *  relative to the grid line, or null where nothing in there rises. */
export interface BeatifyTrace {
  beat: number;
  samples: number[];
  attack: number | null;
}

/** The cut point inspector's payload (MOD-8/11). Seconds throughout. */
export interface BeatifyScope {
  preSecs: number;
  postSecs: number;
  traces: BeatifyTrace[];
  /** How far before the grid line the attacks begin, median. */
  attackLead: number;
  /** Horizontal smear across the traces — flam, in the units on screen. */
  spread: number;
}

export interface BeatifyRecord {
  source: string;
  sourceHash: string;
  sourceSpan: [number, number];
  warped: string;
  grid: Grid;
  leadIn: number;
  ruler: { group: number };
  warp: { strength: number; anchorStride: number; map: [number, number][] };
  quality: Quality;
  analysis: { tracker: string; agreement: Agreement; confidence: number[] };
  reading: Reading;
}

/** A project on the shelf: a tempo and the tracks beatified onto it.
 *  The PROJECT id — not a track id — is what every clip command is keyed
 *  by, and a project can be empty (no seeds, and so no tempo yet). */
export interface BeatifyProjectSummary {
  id: string;
  name: string;
  /** Null until the first seed sets it. */
  bpm: number | null;
  /** Seed names, in import order. */
  seeds: string[];
  /** Unix seconds; the list is newest first. */
  updated: number;
  /** Some seed's source track has left the library: the project still
   *  opens and plays, but stems, re-beatify and re-tempo need the file. */
  sourceMissing: boolean;
}

/** One beatified render — what the track view draws and plays. */
export interface BeatifyTrack {
  projectId: string;
  projectName: string;
  trackId: number;
  title: string;
  artist: string;
  record: BeatifyRecord;
  durationSecs: number;
  sampleRate: number;
  channels: number;
  peaks: number[];
}

/** A seed IS a beatified render, plus what only makes sense once a
 *  project can hold several: which seed it is, the tempo it was played
 *  at, and the ratio it now runs at to sit on the project's grid. */
export interface BeatifySeed extends BeatifyTrack {
  id: string;
  sourceBpm: number;
  speed: number;
  sourceMissing: boolean;
}

/** An open project: the tempo, and everything beatified onto it. */
export interface BeatifyProject {
  id: string;
  name: string;
  bpm: number | null;
  seeds: BeatifySeed[];
}

/** The tempo range the BPM box accepts — mirrors `MIN_BPM`/`MAX_BPM` in
 *  `app/src-tauri/src/beatify.rs`. Wide on purpose: half-time and
 *  double-time are legitimate places to put a project. */
export const MIN_PROJECT_BPM = 20;
export const MAX_PROJECT_BPM = 400;

/** How far a seed had to be sped up (or slowed down) to sit on the
 *  project's grid, as the list writes it. */
export function speedLabel(speed: number): string {
  const pct = (speed - 1) * 100;
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.05) return 'at its own tempo';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
}

export interface TrackerStatus {
  tracker: string;
  beatThis: boolean;
  seeds: string[];
  device: string;
  python: string;
  detail: string;
  installHint: string;
}

// ---------------------------------------------------------------------------
// Grid math (OUT-1: three numbers describe the whole rhythmic content)
// ---------------------------------------------------------------------------

export const DEFAULT_RULER_GROUP = 4;
/** Residual band the user cannot hear — mirrors `grid::IN_BAND_SECS`. */
export const IN_BAND_MS = 5;
/** Meter thresholds — mirror `grid::FLAM_GREEN_MS` / `STRETCH_GREEN_PCT`. */
export const FLAM_GREEN_MS = 5;
export const STRETCH_GREEN_PCT = 1.2;
/** Lead-in range in milliseconds (MOD-20) — mirrors `grid::LEAD_IN_MAX`. */
export const LEAD_IN_MAX_MS = 250;

/** The inspector's window in front of the grid line (MOD-8), ms. */
export const SCOPE_PRE_MS = 40;
/** As far as that window will ever stretch. */
export const SCOPE_PRE_MAX_MS = 400;
/** Room kept in front of the cut line so it never sits on the edge. */
const SCOPE_EDGE_MS = 8;

/** How much of the track before the beat the inspector shows.
 *
 *  The PRD's window is a fixed −40 ms (MOD-8) and stays that way for any
 *  ordinary lead-in, because traces are only comparable at one scale.
 *  A lead-in can now reach further back than the window does, though, and
 *  an inspector that cannot show the cut is worse than useless — so past
 *  that point the window grows, in 25 ms steps so that dragging the
 *  slider does not make the traces breathe. */
export function scopePreMs(leadInMs: number): number {
  if (leadInMs <= SCOPE_PRE_MS - SCOPE_EDGE_MS) return SCOPE_PRE_MS;
  return Math.min(SCOPE_PRE_MAX_MS, Math.ceil((leadInMs + SCOPE_EDGE_MS) / 25) * 25);
}

/** How much room a lead-in leaves in front of the attack (MOD-11), in
 *  milliseconds. Negative means the cut lands inside the attack and will
 *  chop it — which is the one thing the number beside the slider has to
 *  be able to say. */
export function cutClearanceMs(scope: BeatifyScope | null, leadInMs: number): number | null {
  if (!scope || scope.traces.every((t) => t.attack === null)) return null;
  return leadInMs - scope.attackLead * 1000;
}

export function beatTime(grid: Grid, n: number): number {
  return grid.phase + n * grid.period;
}

/** Which beat a time is nearest to (TV-6: beats are the atomic unit). */
export function beatAt(grid: Grid, secs: number): number {
  if (grid.period <= 0) return 0;
  return Math.round((secs - grid.phase) / grid.period);
}

export function clampBeat(grid: Grid, n: number): number {
  return Math.min(grid.beats - 1, Math.max(0, n));
}

/** Time of the nearest beat, clamped into the track. */
export function snapTime(grid: Grid, secs: number): number {
  return beatTime(grid, clampBeat(grid, beatAt(grid, secs)));
}

/** TV-14: selections snap OUTWARD, so they are always whole beats. */
export function snapSelection(
  grid: Grid,
  fromSecs: number,
  toSecs: number,
): { startBeat: number; endBeat: number } {
  const lo = Math.min(fromSecs, toSecs);
  const hi = Math.max(fromSecs, toSecs);
  const startBeat = clampBeat(grid, Math.floor((lo - grid.phase) / grid.period));
  const endBeat = clampBeat(grid, Math.ceil((hi - grid.phase) / grid.period));
  return { startBeat, endBeat: Math.max(endBeat, startBeat + 1) };
}

/** TV-15: "12 beats · 3 groups" when the count divides evenly. */
export function selectionLabel(beats: number, group: number): string {
  const plural = beats === 1 ? 'beat' : 'beats';
  if (group > 1 && beats % group === 0) {
    const groups = beats / group;
    return `${beats} ${plural} · ${groups} ${groups === 1 ? 'group' : 'groups'}`;
  }
  return `${beats} ${plural}`;
}

/** Grid line times over a beat range, every `step` beats (TV-1: pure
 *  arithmetic — the warped audio needs no per-beat storage). */
export function gridLines(grid: Grid, fromBeat: number, toBeat: number, step: number): number[] {
  const out: number[] = [];
  if (step <= 0) return out;
  const first = Math.max(0, Math.ceil(fromBeat / step) * step);
  const last = Math.min(toBeat, grid.beats - 1);
  for (let n = first; n <= last; n += step) out.push(beatTime(grid, n));
  return out;
}

/** Zoom levels in visible beats (TV-10); `null` is "whole track". */
export const ZOOM_BEATS: (number | null)[] = [null, 512, 128, 32, 8, 2, 1];

export interface GridLod {
  /** Spacing of drawn lines, in beats. */
  step: number;
  /** Spacing of emphasized lines, in beats. */
  emphasis: number;
  /** Density band from per-beat confidence (TV-5). */
  density: boolean;
  subdivisions: boolean;
}

/** TV-2: what to draw at a given zoom. Emphasis follows the ruler
 *  grouping, never any detected structure — there isn't any. */
export function gridLod(visibleBeats: number, group: number): GridLod {
  const g = Math.max(1, Math.round(group));
  if (visibleBeats > 256) {
    return { step: 16 * g, emphasis: 16 * g, density: false, subdivisions: false };
  }
  if (visibleBeats > 64) {
    return { step: 4 * g, emphasis: 16 * g, density: false, subdivisions: false };
  }
  if (visibleBeats > 16) {
    return { step: g, emphasis: 4 * g, density: false, subdivisions: false };
  }
  if (visibleBeats >= 4) {
    return { step: 1, emphasis: g, density: false, subdivisions: false };
  }
  return { step: 1, emphasis: g, density: true, subdivisions: true };
}

/** TV-25: a loop changed while the playhead is outside it wraps at the
 *  next GROUP boundary — immediate jumping is jarring, waiting for a loop
 *  end the playhead may never reach is a hang. (§6 open question 1: group,
 *  the recommended option.) */
export function loopWrapBeat(playheadBeat: number, group: number): number {
  const g = Math.max(1, Math.round(group));
  return Math.ceil((playheadBeat + 1e-9) / g) * g;
}

/** Anchor spacing for a slider position — mirrors `grid::anchor_stride`. */
export function anchorStride(strength: number): number {
  const s = Math.min(1, Math.max(0, strength));
  if (s <= 0.02) return 0;
  const stride = Math.round(2 ** (Math.log2(64) * (1 - s)));
  return Math.min(64, Math.max(1, stride));
}

export function verdictLabel(agreement: Agreement): string {
  switch (agreement.verdict) {
    case 'unanimous':
      return 'UNANIMOUS';
    case 'mostlyAgreed':
      return 'MOSTLY AGREED';
    case 'metricalSplit':
      return 'METRICAL SPLIT';
    case 'split':
      return 'SPLIT';
    default:
      return 'SINGLE TRACKER';
  }
}

/** Green / amber / red for the verdict line (MOD-30). */
export function qualityLevel(q: Quality): 'good' | 'warn' | 'bad' {
  if (q.worstFlamMs < FLAM_GREEN_MS && q.peakStretchPct < STRETCH_GREEN_PCT) return 'good';
  if (q.worstFlamMs < FLAM_GREEN_MS * 3) return 'warn';
  return 'bad';
}

export function readingOf(reading: Reading | undefined): {
  factor: number;
  halfShift: boolean;
} {
  return {
    factor: reading?.factor ?? 1,
    halfShift: reading?.halfShift ?? reading?.half_shift ?? false,
  };
}

export function timecode(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '0:00.00';
  const m = Math.floor(secs / 60);
  const s = secs - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/** What Save commits: one seed, into one project. An empty `projectId`
 *  mints a project; a `seedId` replaces that seed (re-beatify) instead of
 *  adding another. */
export interface SaveRequest {
  strength: number;
  leadIn: number;
  rulerGroup: number;
  projectId: string;
  seedId: string;
  name: string;
}

/** What the Beatify page needs; tests substitute a mock. */
export interface BeatifyClientApi {
  trackerStatus(): Promise<TrackerStatus | null>;
  analyze(
    trackId: number,
    region: [number, number] | null,
    buckets: number,
  ): Promise<BeatifyAnalysis | null>;
  setReading(reading: Reading, buckets: number): Promise<BeatifyAnalysis | null>;
  meters(strength: number): Promise<BeatifyMeters | null>;
  preview(
    startSecs: number,
    secs: number,
    warped: boolean,
    strength: number,
    click: boolean,
  ): Promise<ArrayBuffer | null>;
  syncCheck(strength: number, leadIn: number): Promise<ArrayBuffer | null>;
  scope(strength: number, points: number, preSecs: number): Promise<BeatifyScope | null>;
  save(request: SaveRequest, buckets: number): Promise<BeatifyProject | null>;
  projects(): Promise<BeatifyProjectSummary[] | null>;
  /** Start a project with nothing in it: seeds are imported afterwards. */
  newProject(name: string): Promise<BeatifyProject | null>;
  openProject(projectId: string, buckets: number): Promise<BeatifyProject | null>;
  /** Re-tempo the whole project: every seed is re-rendered, clips are
   *  untouched (they are beats, and a beat is a beat at any tempo). */
  setProjectBpm(projectId: string, bpm: number, buckets: number): Promise<BeatifyProject | null>;
  renameProject(projectId: string, name: string): Promise<BeatifyProjectSummary[] | null>;
  deleteProject(projectId: string): Promise<BeatifyProjectSummary[] | null>;
  deleteSeed(projectId: string, seedId: string, buckets: number): Promise<BeatifyProject | null>;
  renameSeed(
    projectId: string,
    seedId: string,
    name: string,
    buckets: number,
  ): Promise<BeatifyProject | null>;
  projectAudio(
    projectId: string,
    seedId: string,
    startSecs: number,
    secs: number,
  ): Promise<ArrayBuffer | null>;
  cancel(): Promise<void>;
}

export class BeatifyClient extends IpcClient implements BeatifyClientApi {
  trackerStatus() {
    return this.call<TrackerStatus>('beatify_tracker_status');
  }
  analyze(trackId: number, region: [number, number] | null, buckets: number) {
    return this.call<BeatifyAnalysis>('beatify_analyze', { trackId, region, buckets });
  }
  setReading(reading: Reading, buckets: number) {
    return this.call<BeatifyAnalysis>('beatify_set_reading', { reading, buckets });
  }
  meters(strength: number) {
    return this.call<BeatifyMeters>('beatify_meters', { strength });
  }
  preview(startSecs: number, secs: number, warped: boolean, strength: number, click: boolean) {
    return this.call<ArrayBuffer>('beatify_preview', {
      startSecs,
      secs,
      warped,
      strength,
      click,
    });
  }
  syncCheck(strength: number, leadIn: number) {
    return this.call<ArrayBuffer>('beatify_sync_check', { strength, leadIn });
  }
  scope(strength: number, points: number, preSecs: number) {
    return this.call<BeatifyScope>('beatify_scope', { strength, points, preSecs });
  }
  save(request: SaveRequest, buckets: number) {
    return this.call<BeatifyProject>('beatify_save', { request, buckets });
  }
  projects() {
    return this.call<BeatifyProjectSummary[]>('beatify_projects');
  }
  newProject(name: string) {
    return this.call<BeatifyProject>('beatify_project_new', { name });
  }
  openProject(projectId: string, buckets: number) {
    return this.call<BeatifyProject>('beatify_project_open', { projectId, buckets });
  }
  setProjectBpm(projectId: string, bpm: number, buckets: number) {
    return this.call<BeatifyProject>('beatify_project_set_bpm', { projectId, bpm, buckets });
  }
  renameProject(projectId: string, name: string) {
    return this.call<BeatifyProjectSummary[]>('beatify_project_rename', { projectId, name });
  }
  deleteProject(projectId: string) {
    return this.call<BeatifyProjectSummary[]>('beatify_project_delete', { projectId });
  }
  deleteSeed(projectId: string, seedId: string, buckets: number) {
    return this.call<BeatifyProject>('beatify_seed_delete', { projectId, seedId, buckets });
  }
  renameSeed(projectId: string, seedId: string, name: string, buckets: number) {
    return this.call<BeatifyProject>('beatify_seed_rename', { projectId, seedId, name, buckets });
  }
  projectAudio(projectId: string, seedId: string, startSecs: number, secs: number) {
    return this.call<ArrayBuffer>('beatify_project_audio', {
      projectId,
      seedId,
      startSecs,
      secs,
    });
  }
  async cancel() {
    await this.call<null>('beatify_cancel');
  }
}

export const beatifyClient = new BeatifyClient();
