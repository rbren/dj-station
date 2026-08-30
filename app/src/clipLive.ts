// The Clip page's LIVE selection player: the selection loops in a Web
// Audio graph, and tone is a parameter on that graph rather than a
// re-render.
//
// WHY THIS EXISTS. Every clip edit used to reach the ears the same way:
// re-render the whole program in Rust, encode a WAV window, ship it over
// IPC, decode it and restart the source. Measured on a 5-minute clip that
// is ~0.5 s of DSP for the EQ alone, ~1.2 s with level automation and
// ~6.8 s once a tap warp is in the program — plus a 350 ms debounce and a
// 10 MB round trip. An EQ knob is useless at that latency.
//
// The split that fixes it: the BACKEND renders the timeline (regions,
// crossfades, the WSOLA warp) — things that decide what audio
// exists and when — and the WEBVIEW applies TONE (parametric EQ, level
// automation), which is just a filter coefficient and a gain. So the
// rendered selection is fetched ONCE and the knobs move inside a running
// graph: no render, no fetch, no gap, continuous while dragging.
//
// The graph:
//
//     loop        (AudioBufferSourceNode) -> levelGain  -> fade  ┐
//     right bleed (AudioBufferSourceNode) -> levelGain' -> fade' ┤
//     left bleed  (AudioBufferSourceNode) -> levelGain" -> fade" ┤
//     (the same three again during a crossfade)                  ┤
//                                                                ├─>
//                                              [peaking bells] -> master
//                                                  -> destination
//
// A voice is the three pieces of ONE pass, started together and levelled
// apart (see below). One voice sounds at a time except during a ~20 ms
// crossfade, which is what makes a stem swap (or any material change)
// seamless: the running loop keeps playing until the new audio is
// decoded, then the two are faded across at the SAME phase. Nothing ever
// stops for an edit.
//
// Level automation is scheduled, not sampled: `levelSchedule` lays the
// breakpoints of the next lookahead onto the gain param as ramps and
// re-runs every 100 ms, wrapping where the loop wraps. Sampling the
// envelope from a timer would smear a hard cut over the tick.
//
// The BLEED is fetched with the loop and never mixed into it. The two
// bookend windows are renders of the edit either side of the span, and
// they play as their OWN looping voices, started with the loop and in
// step with it: the right bleed's material at the head of the pass, the
// left's at its tail, silence in between. Summing is the GRAPH's job, at
// playback, which is also what lets each piece carry its own automation
// — a voice is levelled from where its material sits on the TIMELINE
// (the loop at the span's start, the right bleed at the span's end, the
// left bleed one loop-length before its start), so a fade drawn over a
// bookend moves that bookend and nothing else, even though the bookend
// is heard on top of the loop. The selection loops for as long as it is
// auditioned, so the pass it plays is a MIDDLE one — both bookends over
// the seam, which is the join they exist to smooth. Which passes go bare
// is a matter for the players that have a first and a last one
// (decks.rs, beat_clip.rs).
//
// The preview is a very close TWIN of the saved render, not a bit-exact
// copy: Web Audio's peaking biquads are the same RBJ cookbook filters as
// `dj_analysis::clip`'s but run in float32, and the envelope is ramped
// between breakpoints instead of evaluated per sample. What gets SAVED is
// always the Rust render.

import { audioAvailable, sharedContext } from './clipAudio';
import { EQ_MAX_Q, EQ_MIN_HZ, EQ_MIN_Q, levelDbAt, SILENCE_DB } from './clip';
import type { ClipEqBand, LevelPoint } from './clip';

export interface LiveStatus {
  playing: boolean;
  /** Seconds into the span — the loop's phase. */
  phase: number;
  /** A render/decode of the material is in flight. */
  loading: boolean;
  /** Audio is in hand: the play button can make sound at once. */
  ready: boolean;
}

/** Everything the player needs from the outside world (injected, so tests
 *  drive it with fakes). */
export interface LiveHost {
  /** Render `[start, start + lenSecs)` of the DRY edit — the timeline
   *  with NO eq and NO level, since those are applied here. */
  render(startSecs: number, lenSecs: number): Promise<ArrayBuffer | null>;
  /** How long the whole edit is. The bleed's bookends are windows of it
   *  OUTSIDE the span, so they have to be clamped to what exists. */
  duration(): number;
  /** New material decoded (or lost): what the selection's waveform is
   *  drawn from. The loop is handed over BARE, with the bookends beside
   *  it rather than over it — they are drawn as their own regions, and
   *  mixed only where they are heard (the graph). */
  onBuffer(buffer: AudioBuffer | null, bleed: LiveBleedAudio): void;
  onStatus(status: LiveStatus): void;
}

export interface LiveOptions {
  /** Playhead publish rate (a buffer source has no timeupdate). */
  tickMs?: number;
  /** Level-automation scheduling tick. */
  scheduleMs?: number;
  /** How far ahead automation is scheduled; must exceed `scheduleMs`. */
  lookaheadSecs?: number;
  /** Equal-gain crossfade when material is swapped under a running loop. */
  fadeSecs?: number;
  /** Settle time before a new span or new material is FETCHED. Sweeping
   *  a selection moves it per mousemove and each fetch is a render in
   *  Rust: one render per pixel dragged would jam the backend even
   *  though the epoch guard means only the last could ever sound. */
  fetchDelayMs?: number;
}

/** Smoothing for a knob move, in seconds: long enough that dragging a
 *  band does not zipper, short enough to feel like the knob. */
const PARAM_SMOOTH = 0.02;
const EPS = 1e-4;

export interface LiveRange {
  start: number;
  end: number;
}

/** The selection's bookends, in milliseconds (see ClipView). */
export interface LiveBleed {
  leftMs: number;
  rightMs: number;
}

/** The decoded bookends: the material either side of the span, kept
 *  apart from the loop because it is drawn apart from it and levelled
 *  apart from it. Either side is null when it asks for nothing. */
export interface LiveBleedAudio {
  left: AudioBuffer | null;
  right: AudioBuffer | null;
}

/** A window of the edit to fetch, in output-timeline seconds. */
export interface BleedWindow {
  start: number;
  len: number;
}

/**
 * The BOOKEND windows a bleed asks the backend for: the material just
 * BEFORE the span (which sounds over the loop's end) and just AFTER it
 * (which sounds over its start).
 *
 * Clamped to what the edit actually has — a selection at the head of the
 * clip has nothing behind it, one at its tail nothing after — because an
 * empty window is an error at the other end, not silence. A side that
 * asks for nothing (the default, 0 ms) is null, and costs no render.
 */
export function bleedWindows(
  span: LiveRange,
  bleed: LiveBleed,
  editSecs: number,
): { left: BleedWindow | null; right: BleedWindow | null } {
  const left = Math.min(Math.max(bleed.leftMs, 0) / 1000, Math.max(0, span.start));
  const right = Math.min(Math.max(bleed.rightMs, 0) / 1000, Math.max(0, editSecs - span.end));
  return {
    left: left > EPS ? { start: span.start - left, len: left } : null,
    right: right > EPS ? { start: span.end, len: right } : null,
  };
}

/**
 * Sum a bookend into the loop at `at`, in place — the same plain overlay
 * the engine does per grain (`playback::ClipBleed::tap`), and the same
 * alignment: a bookend longer than the loop loses the end that hangs
 * over, not the material that meets the seam.
 */
export function mixInto(loop: Float32Array, bookend: Float32Array, at: number): void {
  for (let i = Math.max(0, -at); i < bookend.length; i++) {
    const j = at + i;
    if (j >= loop.length) break;
    loop[j] += bookend[i];
  }
}

/** Amplitude for the level envelope at an OUTPUT-timeline second.
 *  Mirrors `db_to_gain(level_db_at(..))` in `dj_analysis::clip`. */
export function levelGainAt(points: LevelPoint[], secs: number): number {
  if (points.length === 0) return 1;
  const db = levelDbAt(points, secs);
  return db <= SILENCE_DB ? 0 : 10 ** (db / 20);
}

/** One scheduled automation move: `at` seconds from now, ramp (or jump,
 *  at the loop seam) to `gain`. */
export interface LevelEvent {
  at: number;
  gain: number;
  /** The loop wrapped here: the envelope restarts, so this is a step. */
  jump: boolean;
}

/**
 * The automation the next `lookahead` seconds of a loop pass need.
 *
 * Pure, because this is the whole law of the live envelope: breakpoints
 * inside the span become ramps at the moment playback reaches them, and
 * the loop's seam becomes a ramp to the span's last value followed by a
 * step back to its first. A pass with no breakpoints inside it schedules
 * nothing at all — the value set at "now" already holds.
 */
export function levelSchedule(
  points: LevelPoint[],
  spanStart: number,
  spanLen: number,
  phase: number,
  lookahead: number,
): LevelEvent[] {
  const out: LevelEvent[] = [];
  if (spanLen <= 0 || points.length === 0) return out;
  const inside = points
    .map((p) => p.time_secs - spanStart)
    .filter((t) => t > EPS && t < spanLen - EPS)
    .sort((a, b) => a - b);
  let at = 0;
  let p = Math.max(0, Math.min(phase, spanLen));
  // The guard is a belt-and-braces stop for a degenerate span (a loop
  // shorter than a scheduling tick would otherwise wrap forever).
  for (let guard = 0; guard < 256 && at < lookahead; guard += 1) {
    const next = inside.find((t) => t > p + EPS);
    const to = next ?? spanLen;
    const dt = to - p;
    if (at + dt > lookahead) break;
    out.push({ at: at + dt, gain: levelGainAt(points, spanStart + to), jump: false });
    if (next === undefined) {
      out.push({ at: at + dt, gain: levelGainAt(points, spanStart), jump: true });
      p = 0;
    } else {
      p = next;
    }
    at += dt;
  }
  return out;
}

/** Peak per bucket (0..1) of a decoded buffer — the twin of
 *  `dj_analysis::clip::peaks`, so the drawn selection reads like every
 *  other waveform on the page. */
export function bufferPeaks(buffer: AudioBuffer, buckets: number): number[] {
  const frames = buffer.length;
  if (frames === 0 || buckets <= 0) return [];
  const n = Math.min(buckets, frames);
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const per = frames / n;
  const out = new Array<number>(n);
  for (let b = 0; b < n; b += 1) {
    const from = Math.floor(b * per);
    const to = Math.min(frames, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = from; i < to; i += 1) {
      const s = right ? Math.max(Math.abs(left[i]), Math.abs(right[i])) : Math.abs(left[i]);
      if (s > peak) peak = s;
    }
    out[b] = peak;
  }
  return out;
}

type OfflineCtor = typeof OfflineAudioContext;

function offlineCtor(): OfflineCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    OfflineAudioContext?: OfflineCtor;
    webkitOfflineAudioContext?: OfflineCtor;
  };
  return w.OfflineAudioContext ?? w.webkitOfflineAudioContext ?? null;
}

function setBand(filter: BiquadFilterNode, band: ClipEqBand, sampleRate: number, when: number) {
  // The same clamps the renderer applies, so the drawn response, the
  // preview and the saved file agree about what an extreme band does.
  const freq = Math.min(Math.max(band.freq_hz, EQ_MIN_HZ), 0.45 * sampleRate);
  const q = Math.min(Math.max(band.q, EQ_MIN_Q), EQ_MAX_Q);
  filter.type = 'peaking';
  ramp(filter.frequency, freq, when);
  ramp(filter.Q, q, when);
  ramp(filter.gain, band.gain_db, when);
}

/** Move a param without a click. `setTargetAtTime` is exponential and
 *  never lands exactly, but a band's coefficients only have to arrive
 *  within a knob's worth of the target. */
function ramp(param: AudioParam, value: number, when: number) {
  if (typeof param.setTargetAtTime === 'function') param.setTargetAtTime(value, when, PARAM_SMOOTH);
  else param.value = value;
}

/**
 * Render a decoded selection through the tone stage OFFLINE, for the
 * waveform under it: the drawn peaks are what the live graph is doing,
 * computed the same way, without asking the backend anything.
 *
 * Null where the runtime has no OfflineAudioContext (jsdom), which the
 * caller draws as the dry material instead.
 */
export async function tonePeaks(
  buffer: AudioBuffer,
  bands: ClipEqBand[],
  level: LevelPoint[],
  spanStart: number,
  buckets: number,
): Promise<number[] | null> {
  const Ctor = offlineCtor();
  if (!Ctor || buffer.length === 0) return null;
  let rendered: AudioBuffer;
  try {
    const ctx = new Ctor(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    let node: AudioNode = src;
    for (const band of bands) {
      const filter = ctx.createBiquadFilter();
      setBand(filter, band, ctx.sampleRate, 0);
      node.connect(filter);
      node = filter;
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(levelGainAt(level, spanStart), 0);
    const span = buffer.duration;
    for (const e of levelSchedule(level, spanStart, span, 0, span)) {
      if (!e.jump) gain.gain.linearRampToValueAtTime(e.gain, e.at);
    }
    node.connect(gain);
    gain.connect(ctx.destination);
    src.start(0);
    rendered = await ctx.startRendering();
  } catch {
    return null;
  }
  return bufferPeaks(rendered, buckets);
}

/** Whether a live selection can play here at all. */
export function liveAudioAvailable(): boolean {
  return audioAvailable();
}

/** Decode rendered bytes, or null where there are none (a side with no
 *  bleed) and where they will not decode. Makes no sound. */
async function decode(ctx: AudioContext, bytes: ArrayBuffer | null): Promise<AudioBuffer | null> {
  if (!bytes) return null;
  try {
    // decodeAudioData detaches its input, so it gets a copy.
    return await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    return null;
  }
}

/** A bookend's channel for a loop channel: material with fewer channels
 *  is heard on all of them, as it is in the engine. */
function bookendChannel(buffer: AudioBuffer, channel: number): Float32Array {
  return buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
}

/** A bookend as a VOICE of its own: the material at the place in the
 *  pass where it is heard — the right bleed at the head, carrying the
 *  last pass's tail over the seam, the left at the tail, leaning into
 *  the pass to come — and silence everywhere else, in a buffer the
 *  length of the loop so it wraps in step with it. Never a copy of the
 *  loop: the two are summed where they are heard, not before. */
function bleedVoiceBuffer(
  ctx: AudioContext,
  loop: AudioBuffer,
  bookend: AudioBuffer,
  side: 'left' | 'right',
): AudioBuffer {
  const out = ctx.createBuffer(loop.numberOfChannels, loop.length, loop.sampleRate);
  const at = side === 'right' ? 0 : loop.length - bookend.length;
  for (let c = 0; c < loop.numberOfChannels; c++) {
    mixInto(out.getChannelData(c), bookendChannel(bookend, c), at);
  }
  return out;
}

/** One PIECE of what is sounding: a looping buffer, the gain its own
 *  level automation moves, and the gain it fades in on. */
interface VoicePart {
  src: AudioBufferSourceNode;
  level: GainNode;
  fade: GainNode;
  /** Where this piece's material begins on the OUTPUT timeline. Its
   *  level is read from THERE — the loop from the span's start, the
   *  right bleed from the span's end, the left bleed from one loop
   *  before the span's start — which is what keeps the three envelopes
   *  independent of one another where the audio overlaps. */
  levelStart: number;
}

function disconnectPart(part: VoicePart): void {
  part.src.disconnect();
  part.level.disconnect();
  part.fade.disconnect();
}

/** What is sounding: the loop and its bookends, started together and so
 *  in phase for as long as they run. */
interface Voice {
  parts: VoicePart[];
  /** Context time the nodes started. */
  startedAt: number;
  /** Phase they started at. */
  offset: number;
  duration: number;
}

/**
 * The live selection loop.
 *
 * Commands are synchronous and idempotent; the one asynchronous thing —
 * fetching and decoding the material — carries an epoch, and a
 * superseded fetch drops its result rather than installing it (the same
 * rule that keeps `ClipTransport` from ever playing twice). The player
 * makes NO sound before its last staleness check.
 */
export class ClipLivePlayer {
  private readonly host: LiveHost;
  private readonly tickMs: number;
  private readonly scheduleMs: number;
  private readonly lookahead: number;
  private readonly fadeSecs: number;
  private readonly fetchDelayMs: number;

  private ctx: AudioContext | null = null;
  private filters: BiquadFilterNode[] = [];
  /** The tail of the shared tone chain. Level is NOT here: it belongs to
   *  each piece (see `VoicePart`), since the loop and its bookends carry
   *  their own. */
  private master: GainNode | null = null;
  private voice: Voice | null = null;
  private buffer: AudioBuffer | null = null;
  /** The bookends laid out for playback: loop-length, silent but for the
   *  stretch where each is heard. (What the PANE draws is the decoded
   *  material itself, handed straight to the host.) */
  private bleedVoices: LiveBleedAudio = { left: null, right: null };

  private span: LiveRange = { start: 0, end: 0 };
  private bleed: LiveBleed = { leftMs: 0, rightMs: 0 };
  private bands: ClipEqBand[] = [];
  private level: LevelPoint[] = [];

  private epoch = 0;
  private wantPlaying = false;
  private loadingNow = false;
  private disposed = false;
  /** Where playback resumes from while nothing is sounding. */
  private parked = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private scheduler: ReturnType<typeof setInterval> | null = null;
  private pendingFetch: ReturnType<typeof setTimeout> | null = null;

  constructor(host: LiveHost, opts: LiveOptions = {}) {
    this.host = host;
    this.tickMs = opts.tickMs ?? 50;
    this.scheduleMs = opts.scheduleMs ?? 100;
    this.lookahead = opts.lookaheadSecs ?? 0.4;
    this.fadeSecs = opts.fadeSecs ?? 0.02;
    this.fetchDelayMs = opts.fetchDelayMs ?? 150;
  }

  get playing(): boolean {
    return this.voice !== null;
  }

  get ready(): boolean {
    return this.buffer !== null;
  }

  /** Seconds into the span, wherever playback (or the parked playhead) is. */
  phase(): number {
    const voice = this.voice;
    const ctx = this.ctx;
    if (!voice || !ctx || voice.duration <= 0) return this.parked;
    const at = voice.offset + Math.max(0, ctx.currentTime - voice.startedAt);
    return at % voice.duration;
  }

  // --- what the page is auditioning -------------------------------------

  /** Audition this stretch of the edit. A new span is new material: it is
   *  fetched, and playback (if any) carries on into it from its head. */
  setSpan(start: number, end: number): void {
    if (this.disposed) return;
    if (Math.abs(start - this.span.start) < EPS && Math.abs(end - this.span.end) < EPS) return;
    this.span = { start, end };
    this.parked = 0;
    this.laterFetch(false);
  }

  /** New BOOKENDS: how much of the track either side of the span sounds
   *  over the loop's seam. The bleed is material, not tone, so it costs
   *  a fetch — but the pass in the air carries on into it. */
  setBleed(leftMs: number, rightMs: number): void {
    if (this.disposed) return;
    if (leftMs === this.bleed.leftMs && rightMs === this.bleed.rightMs) return;
    this.bleed = { leftMs, rightMs };
    this.laterFetch(true);
  }

  /** The MATERIAL changed under the same span — a stem swapped, a
   *  timeline edit landed. Fetch it and cross-fade onto it at the phase
   *  playback has reached, so nothing stops and nothing jumps. */
  refresh(): void {
    if (this.disposed) return;
    this.laterFetch(true);
  }

  // --- tone: the whole point --------------------------------------------

  /** New EQ bands. No fetch, no gap — coefficients move under the audio. */
  setEq(bands: ClipEqBand[]): void {
    if (this.disposed) return;
    this.bands = bands.map((b) => ({ ...b }));
    if (this.ctx) this.buildChain();
  }

  /** New level automation (OUTPUT-timeline breakpoints). Re-scheduled at
   *  once so a dragged point is heard on the pass it is dragged in. */
  setLevel(points: LevelPoint[]): void {
    if (this.disposed) return;
    this.level = points.map((p) => ({ ...p }));
    this.scheduleLevel();
  }

  // --- transport ---------------------------------------------------------

  play(): void {
    if (this.disposed || this.voice) return;
    this.wantPlaying = true;
    // A press of play is not a drag: it takes the material NOW.
    if (this.buffer) this.startVoice(this.parked, false);
    else this.laterFetch(false, 0);
    this.notify();
  }

  pause(): void {
    if (this.disposed) return;
    this.parked = this.phase();
    this.wantPlaying = false;
    this.silence();
    this.notify();
  }

  /** Stop and park at the head of the span (the selection's start). */
  stop(): void {
    if (this.disposed) return;
    this.wantPlaying = false;
    this.silence();
    this.parked = 0;
    this.notify();
  }

  /** Move the playhead inside the span. While playing, playback moves
   *  with it — a click on the selection's waveform IS a seek. */
  seekPhase(secs: number): void {
    if (this.disposed) return;
    const len = this.buffer?.duration ?? this.span.end - this.span.start;
    const at = Math.max(0, Math.min(secs, Math.max(0, len - EPS)));
    this.parked = at;
    if (this.voice && this.buffer) this.startVoice(at, true);
    this.notify();
  }

  /** Push the current status at the host again: the page shows whichever
   *  owner holds playback, and a handover moves nothing here. */
  publish(): void {
    this.notify();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.silence();
    this.stopTimers();
    if (this.pendingFetch !== null) clearTimeout(this.pendingFetch);
    this.pendingFetch = null;
    for (const f of this.filters) f.disconnect();
    this.filters = [];
    this.master?.disconnect();
    this.master = null;
    this.buffer = null;
    this.bleedVoices = { left: null, right: null };
  }

  // --- material ----------------------------------------------------------

  /** Fetch once the span has settled. The epoch a fetch takes is claimed
   *  when it RUNS, so a pending one is simply replaced. */
  private laterFetch(keepPhase: boolean, delayMs = this.fetchDelayMs): void {
    if (this.pendingFetch !== null) clearTimeout(this.pendingFetch);
    this.pendingFetch = setTimeout(() => {
      this.pendingFetch = null;
      void this.fetch(keepPhase);
    }, delayMs);
  }

  private async fetch(keepPhase: boolean): Promise<void> {
    const span = this.span;
    const len = span.end - span.start;
    if (this.disposed || len <= EPS) return;
    const epoch = ++this.epoch;
    this.loadingNow = true;
    this.notify();
    // The loop and its bookends are all windows of the SAME edit, asked
    // for together: the bleed is material the selection left behind, not
    // something the loop can be made to say.
    const windows = bleedWindows(span, this.bleed, this.host.duration());
    const [bytes, leftBytes, rightBytes] = await Promise.all([
      this.host.render(span.start, len),
      windows.left ? this.host.render(windows.left.start, windows.left.len) : null,
      windows.right ? this.host.render(windows.right.start, windows.right.len) : null,
    ]);
    if (this.stale(epoch)) return;
    let buffer: AudioBuffer | null = null;
    let bleed: LiveBleedAudio = { left: null, right: null };
    let voices: LiveBleedAudio = { left: null, right: null };
    const ctx = this.context();
    if (bytes && ctx) {
      const [loop, left, right] = await Promise.all([
        decode(ctx, bytes),
        decode(ctx, leftBytes),
        decode(ctx, rightBytes),
      ]);
      buffer = loop;
      bleed = { left, right };
      // What the page auditions is a MIDDLE pass — both bookends over
      // the seam — because that is the join the bleed exists to smooth.
      // They are laid out to wrap with the loop, and summed with it in
      // the graph: the loop's own audio is never written to.
      if (loop) {
        voices = {
          left: left && bleedVoiceBuffer(ctx, loop, left, 'left'),
          right: right && bleedVoiceBuffer(ctx, loop, right, 'right'),
        };
      }
    }
    // NOTHING SOUNDS BEFORE THIS CHECK: decoding is side-effect free, so
    // a superseded fetch simply drops the buffer it decoded.
    if (this.stale(epoch)) return;
    this.loadingNow = false;
    const phase = keepPhase && this.buffer ? this.phase() : 0;
    this.buffer = buffer;
    this.bleedVoices = voices;
    this.host.onBuffer(buffer, bleed);
    if (!buffer) {
      this.silence();
      this.notify();
      return;
    }
    if (this.wantPlaying) this.startVoice(phase % buffer.duration, true);
    else this.parked = Math.min(phase, buffer.duration);
    this.notify();
  }

  private stale(epoch: number): boolean {
    return this.disposed || epoch !== this.epoch;
  }

  // --- the graph ---------------------------------------------------------

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    this.ctx = sharedContext();
    if (this.ctx) this.buildChain();
    return this.ctx;
  }

  /** Peaking bells in series into the master. Rebuilt only when the
   *  BAND COUNT changes; an ordinary tone edit just moves params. EQ is
   *  the clip's tone, so every piece plays through it — what each piece
   *  keeps to itself is its level. */
  private buildChain(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.master) {
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
    }
    if (this.filters.length !== this.bands.length) {
      for (const f of this.filters) f.disconnect();
      this.filters = this.bands.map(() => ctx.createBiquadFilter());
      this.filters.forEach((f, i) => {
        const next = this.filters[i + 1] ?? this.master;
        if (next) f.connect(next);
      });
      // A voice mid-pass is playing into the old head: move it over
      // rather than dropping the pass on the floor.
      const head = this.chainHead();
      if (head) {
        for (const part of this.voice?.parts ?? []) {
          part.fade.disconnect();
          part.fade.connect(head);
        }
      }
    }
    const when = ctx.currentTime;
    this.filters.forEach((f, i) => setBand(f, this.bands[i], ctx.sampleRate, when));
  }

  private chainHead(): AudioNode | null {
    return this.filters[0] ?? this.master;
  }

  /** The pieces a pass is made of, each with the place on the timeline
   *  its level is read from. The loop is the span itself; the RIGHT
   *  bleed is the audio the span was followed by, so it is levelled from
   *  the span's end; the LEFT bleed ran INTO the span, and lands at the
   *  tail of the pass, so a loop before its start. */
  private pieces(len: number): { buffer: AudioBuffer; levelStart: number }[] {
    const out: { buffer: AudioBuffer; levelStart: number }[] = [];
    if (this.buffer) out.push({ buffer: this.buffer, levelStart: this.span.start });
    const { left, right } = this.bleedVoices;
    if (right) out.push({ buffer: right, levelStart: this.span.end });
    if (left) out.push({ buffer: left, levelStart: this.span.start - len });
    return out;
  }

  /** Start a voice at `offset`, cross-fading off whatever was sounding.
   *  Synchronous start to finish, so nothing can supersede it midway —
   *  and every piece is started in the same breath, which is what keeps
   *  the bookends in phase with the loop they lie over. */
  private startVoice(offset: number, crossfade: boolean): void {
    const ctx = this.context();
    const buffer = this.buffer;
    const head = this.chainHead();
    if (!ctx || !buffer || !head || buffer.duration <= 0) return;
    const now = ctx.currentTime;
    const len = buffer.duration;
    const at = Math.max(0, offset % len);
    const prev = this.voice;
    const fade = crossfade && prev ? this.fadeSecs : 0;
    const parts = this.pieces(len).map(({ buffer: material, levelStart }) => {
      const src = ctx.createBufferSource();
      src.buffer = material;
      src.loop = true;
      src.loopStart = 0;
      src.loopEnd = len;
      const level = ctx.createGain();
      const fadeGain = ctx.createGain();
      src.connect(level);
      level.connect(fadeGain);
      fadeGain.connect(head);
      if (fade > 0) {
        fadeGain.gain.setValueAtTime(0, now);
        fadeGain.gain.linearRampToValueAtTime(1, now + fade);
      } else {
        fadeGain.gain.setValueAtTime(1, now);
      }
      src.start(0, at);
      return { src, level, fade: fadeGain, levelStart };
    });
    this.voice = { parts, startedAt: now, offset: at, duration: len };
    this.retire(prev, fade);
    // Autoplay policies suspend a fresh context until a gesture; play is
    // always reached from a click or a key, so resuming here is safe.
    if (ctx.state === 'suspended') void ctx.resume?.();
    this.startTimers();
    this.scheduleLevel();
  }

  private retire(voice: Voice | null, fade: number): void {
    if (!voice || !this.ctx) return;
    const now = this.ctx.currentTime;
    for (const part of voice.parts) {
      try {
        if (fade > 0) {
          part.fade.gain.setValueAtTime(part.fade.gain.value, now);
          part.fade.gain.linearRampToValueAtTime(0, now + fade);
          part.src.stop(now + fade);
        } else {
          part.src.stop();
        }
      } catch {
        // Already finished; the disconnect below is all that is left.
      }
      part.src.onended = () => disconnectPart(part);
    }
  }

  /** Stop anything sounding right now (no fade: this is a command). */
  private silence(): void {
    const voice = this.voice;
    this.voice = null;
    this.stopTimers();
    if (!voice) return;
    for (const part of voice.parts) {
      try {
        part.src.stop();
      } catch {
        // Already stopped.
      }
      disconnectPart(part);
    }
  }

  // --- level automation ---------------------------------------------------

  /** Lay the next stretch of automation onto EVERY piece — each read
   *  from its own place on the timeline, so the fade over a bookend and
   *  the fade over the loop it lands on are two different curves. */
  private scheduleLevel(): void {
    const ctx = this.ctx;
    const voice = this.voice;
    if (!ctx || !voice) return;
    const now = ctx.currentTime;
    const phase = this.phase();
    for (const part of voice.parts) {
      const param = part.level.gain;
      param.cancelScheduledValues?.(now);
      param.setValueAtTime(levelGainAt(this.level, part.levelStart + phase), now);
      for (const e of levelSchedule(
        this.level,
        part.levelStart,
        voice.duration,
        phase,
        this.lookahead,
      )) {
        if (e.jump) param.setValueAtTime(e.gain, now + e.at);
        else param.linearRampToValueAtTime(e.gain, now + e.at);
      }
    }
  }

  private startTimers(): void {
    if (this.ticker === null) {
      this.ticker = setInterval(() => this.notify(), this.tickMs);
    }
    if (this.scheduler === null) {
      this.scheduler = setInterval(() => this.scheduleLevel(), this.scheduleMs);
    }
  }

  private stopTimers(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    if (this.scheduler !== null) clearInterval(this.scheduler);
    this.ticker = null;
    this.scheduler = null;
  }

  private notify(): void {
    if (this.disposed) return;
    this.host.onStatus({
      playing: this.playing,
      phase: this.phase(),
      loading: this.loadingNow,
      ready: this.buffer !== null,
    });
  }
}
