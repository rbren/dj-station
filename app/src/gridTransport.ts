// The Grid page's transport: it plays a `GridState` through Web Audio and
// answers where the playhead is.
//
// A PASS is one walk of the play range. Passes are scheduled AHEAD of
// time (a 250 ms lookahead, re-run on a 100 ms timer) rather than fired
// by a timer at the moment each clip should sound: a setTimeout lands
// whenever the main thread gets round to it, which on a beat grid is
// audible, while `AudioBufferSourceNode.start(when)` lands on the audio
// clock exactly. That is also what makes a loop seamless — the next
// pass's first clip is already scheduled while the current one plays.
//
// The playhead is DERIVED, never counted: the page asks `column()`, which
// converts elapsed clock time back through the tempo envelope
// (`secsToBeat`). Nothing accumulates, so a slow render or a backgrounded
// tab cannot make the highlight drift away from the sound.
//
// Without an AudioContext (jsdom, an old webview) the transport still
// runs: `performance.now()` becomes the clock and every pass is silent,
// so the page's controls, highlight and loop are all exercised headless.

import { sharedContext } from './clipAudio';
import type { BeatClipEntry } from './beatClip';
import {
  beatToSecs,
  playRange,
  rangeSecs,
  scheduleRange,
  secsToBeat,
  type ColumnRange,
  type GridState,
} from './grid';

/** How far ahead passes are scheduled, and how often that is re-run. */
const LOOKAHEAD_SECS = 0.25;
const SCHEDULE_MS = 100;

/** Where a clip's audio comes from — `BeatClipApi.audio`, narrowed. */
export interface GridAudioSource {
  audio(clipId: string): Promise<ArrayBuffer | null>;
}

interface Pass {
  /** Clock time the pass begins. */
  at: number;
  /** Column it begins on — the range's start, except for a first pass
   *  resumed part-way through. */
  from: number;
  secs: number;
}

export interface GridPlayback {
  playing: boolean;
  /** Fractional column the playhead is on. */
  column: number;
}

export class GridTransport {
  #source: GridAudioSource;
  #buffers = new Map<string, AudioBuffer>();
  #nodes: AudioBufferSourceNode[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #passes: Pass[] = [];
  /** The pass being scheduled next, or null once the last one is laid
   *  down (a non-looping play). */
  #next: Pass | null = null;
  #state: GridState | null = null;
  #clips: ReadonlyMap<string, BeatClipEntry> = new Map();
  #range: ColumnRange = { start: 0, end: 0 };
  #looping = false;
  #playing = false;
  #at = 0;
  #disposed = false;

  constructor(source: GridAudioSource) {
    this.#source = source;
  }

  get playing(): boolean {
    return this.#playing;
  }

  /** The audio clock where there is one, the wall clock where there is
   *  not — both monotonic seconds, which is all the scheduling needs. */
  #now(): number {
    const ctx = sharedContext();
    return ctx ? ctx.currentTime : performance.now() / 1000;
  }

  /** Decode every clip the grid plays, so a pass can be scheduled without
   *  awaiting anything (an await between "it is time" and `start(when)`
   *  is how a clip ends up late). Clips already decoded cost nothing. */
  async prime(state: GridState, clips: ReadonlyMap<string, BeatClipEntry>): Promise<void> {
    const ctx = sharedContext();
    if (!ctx) return;
    const wanted = new Set(state.rows.filter((r) => r.placements.length > 0).map((r) => r.clipId));
    await Promise.all(
      [...wanted]
        .filter((id) => clips.has(id) && !this.#buffers.has(id))
        .map(async (id) => {
          const bytes = await this.#source.audio(id);
          if (!bytes || this.#disposed) return;
          try {
            this.#buffers.set(id, await ctx.decodeAudioData(bytes.slice(0)));
          } catch {
            // A clip that will not decode simply stays silent; the grid
            // still plays everything else.
          }
        }),
    );
  }

  /** Start at `fromColumn` (the range's start by default). Playing again
   *  while playing re-cues rather than layering. */
  async play(
    state: GridState,
    clips: ReadonlyMap<string, BeatClipEntry>,
    columns: number,
    fromColumn?: number,
  ): Promise<void> {
    if (this.#disposed) return;
    this.stop();
    const range = playRange(state, columns);
    if (range.end <= range.start) return;
    this.#state = state;
    this.#clips = clips;
    this.#range = range;
    this.#looping = state.loop !== null;
    await this.prime(state, clips);
    if (this.#disposed) return;
    const from = Math.min(Math.max(fromColumn ?? range.start, range.start), range.end - 1e-9);
    this.#playing = true;
    this.#next = {
      at: this.#now() + 0.05,
      from,
      secs: rangeSecs(state.tempo, { start: from, end: range.end }),
    };
    this.#pump();
    this.#timer = setInterval(() => this.#pump(), SCHEDULE_MS);
  }

  /** Stop, keeping nothing: the next play starts where the caller says. */
  stop(): void {
    this.#playing = false;
    this.#next = null;
    this.#passes = [];
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    for (const node of this.#nodes) {
      try {
        node.stop();
      } catch {
        // Already finished.
      }
      node.disconnect();
    }
    this.#nodes = [];
  }

  /** Where the playhead is, and whether it is moving. A play with no loop
   *  that has run off the end reports itself stopped, parked on the last
   *  column — it is the transport, not the page's timer, that decides a
   *  pass is over. */
  status(): GridPlayback {
    if (!this.#playing || !this.#state) {
      return { playing: false, column: this.#at };
    }
    const now = this.#now();
    const pass = [...this.#passes].reverse().find((p) => now >= p.at) ?? this.#passes[0] ?? null;
    if (!pass) return { playing: true, column: this.#at };
    if (now >= pass.at + pass.secs && this.#next === null) {
      this.#at = this.#range.end;
      this.stop();
      return { playing: false, column: this.#at };
    }
    const within = Math.max(0, Math.min(now - pass.at, pass.secs));
    const secs = beatToSecs(this.#state.tempo, pass.from) + within;
    this.#at = Math.min(secsToBeat(this.#state.tempo, secs), this.#range.end);
    return { playing: true, column: this.#at };
  }

  dispose(): void {
    this.stop();
    this.#disposed = true;
    this.#buffers.clear();
  }

  /** Lay down every pass that begins inside the lookahead. */
  #pump(): void {
    const state = this.#state;
    if (!this.#playing || !state) return;
    const horizon = this.#now() + LOOKAHEAD_SECS;
    while (this.#next && this.#next.at <= horizon) {
      const pass = this.#next;
      this.#schedule(state, pass);
      this.#passes = [...this.#passes.slice(-3), pass];
      this.#next = this.#looping
        ? {
            at: pass.at + pass.secs,
            from: this.#range.start,
            secs: rangeSecs(state.tempo, this.#range),
          }
        : null;
    }
    // Passes that have played out are dropped, but the LATEST one is
    // always kept: it is what tells `status` a non-looping play has run
    // off its end, and pruning it would leave the playhead frozen and
    // still calling itself playing.
    const cutoff = this.#now() - 1;
    this.#passes = this.#passes.filter(
      (p, i) => i === this.#passes.length - 1 || p.at + p.secs >= cutoff,
    );
  }

  #schedule(state: GridState, pass: Pass): void {
    const ctx = sharedContext();
    if (!ctx) return;
    for (const copy of scheduleRange(state, this.#clips, {
      start: pass.from,
      end: this.#range.end,
    })) {
      const buffer = this.#buffers.get(copy.clipId);
      if (!buffer) continue;
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = copy.rate;
      node.connect(ctx.destination);
      const at = pass.at + copy.atSecs;
      const offset = Math.min(copy.offsetSecs, buffer.duration);
      const duration = Math.max(0, Math.min(copy.durationSecs, buffer.duration - offset));
      if (duration <= 0) continue;
      node.start(Math.max(at, ctx.currentTime), offset, duration);
      node.onended = () => {
        this.#nodes = this.#nodes.filter((n) => n !== node);
        node.disconnect();
      };
      this.#nodes.push(node);
    }
  }
}
