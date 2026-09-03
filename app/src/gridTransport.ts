// The Grid page's transport: it plays a `GridState` through Web Audio and
// answers where the playhead is.
//
// A PASS is one walk of the play range — except the FIRST, which walks
// from wherever the play was cued to the range's end, so a cursor parked
// outside the loop is played FROM rather than jumped away from.
//
// Passes are scheduled AHEAD of time (a 250 ms lookahead, re-run on a
// 100 ms timer) rather than fired by a timer at the moment each clip
// should sound: a setTimeout lands whenever the main thread gets round
// to it, which on a beat grid is audible, while
// `AudioBufferSourceNode.start(when)` lands on the audio clock exactly.
// That is also what makes a loop seamless — the next pass's first clip
// is already scheduled while the current one plays.
//
// The grid is LIVE: `update` hands in a new state mid-play and the
// transport lays down whatever the edit added, so placing a clip while
// the music runs is heard on its next beat. Copies already scheduled are
// remembered by key (`rowId:start`), which is what keeps a re-schedule
// from re-triggering something already sounding.
//
// A copy is not ONE buffer but three: the clip, and its BLEED — the
// material either side of it in the track it was cut from, filed beside
// it as metadata. On a timeline the bleed goes back where it came from,
// the left bookend ending on the copy's first beat and the right one
// starting where its last beat ends. A copy on its own is heard as
// lead-in, clip, tail-out; copies running back to back put one's
// tail-out and the next one's lead-in ON the join, which is the overlay
// a looping player (the engine, the Clip page's preview) makes of its
// seam.
//
// The playhead is DERIVED, never counted: the page asks `status()`, which
// converts elapsed clock time back through the tempo envelope
// (`secsToBeat`). Nothing accumulates, so a slow render or a backgrounded
// tab cannot make the highlight drift away from the sound.
//
// Without an AudioContext (jsdom, an old webview) the transport still
// runs: `performance.now()` becomes the clock and every pass is silent,
// so the page's controls, highlight and loop are all exercised headless.

import { sharedContext } from './clipAudio';
import type { BeatClipEntry, BleedSide } from './beatClip';
import {
  beatToSecs,
  playRange,
  rangeSecs,
  scheduleRange,
  secsToBeat,
  type ColumnRange,
  type GridState,
  type ScheduledClip,
} from './grid';

/** How far ahead passes are scheduled, and how often that is re-run. */
const LOOKAHEAD_SECS = 0.25;
const SCHEDULE_MS = 100;

const BLEED_SIDES: readonly BleedSide[] = ['right', 'left'];

/** Where a clip's audio comes from. `bpm` asks for it RE-TIMED — the
 *  backend stretches it (WSOLA), so the grid's tempo can change without
 *  the pitch following it. `fx` asks for the stretched clip THROUGH a
 *  row's effects rack (the render spec `fxRenderSpec` makes): the WET
 *  buffer, sample-aligned with the dry one so the two can be
 *  crossfaded. */
export interface GridAudioSource {
  audio(clipId: string, bpm?: number, fx?: string): Promise<ArrayBuffer | null>;
  /** A clip's bleed, one bookend at a time and re-timed the same way.
   *  Optional: a source that cannot hand it over simply plays the loops
   *  bare, which is what the grid did before it asked. */
  bleed?(clipId: string, side: BleedSide, bpm?: number): Promise<ArrayBuffer | null>;
}

interface Pass {
  /** Clock time the pass begins. */
  at: number;
  /** Column it begins on — the range's start, except for a first pass
   *  resumed part-way through. */
  from: number;
  /** Column it runs to. Normally the loop's end; a pass cued from — or
   *  overtaken by a loop moved behind — the loop runs to the end of the
   *  grid instead, and only then falls into it.
   *
   *  This end, and the seconds that go with it, are RE-READ from the
   *  grid while the pass is in flight (`#reloop`): a loop re-marked mid
   *  play moves where this pass wraps, and nothing else. */
  to: number;
  secs: number;
  /** Keys of the copies already laid down for this pass, so a live edit
   *  re-schedules only what is new. */
  laid: Set<string>;
}

/** One buffer of a clip copy in flight: the source, the gain the row's
 *  level is written on, and the panner the row's rack chrome places it
 *  with (absent where the webview has no StereoPannerNode, or where the
 *  row sits centred and needs none). A copy is one to three voices: the
 *  clip itself, and a bookend of its bleed either side of it. */
interface Voice {
  node: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode | null;
  pass: Pass;
  key: string;
  /** Which side of the rack's Wetness crossfade this voice carries: the
   *  clip as stored (`dry` — bleed bookends ride this side too) or the
   *  rack's render of it (`wet`). A copy with the default rack has only
   *  a dry voice at full gain. */
  side: 'dry' | 'wet';
  /** The render spec the copy carried when the voice was laid, so a rack
   *  edited DURING playback can tell which wet voices are stale. */
  fx: string | null;
  at: number;
  /** When the COPY starts, which is where its level line is read from
   *  and what says whether it has been heard yet. A bleed voice starts
   *  somewhere else — before the copy, or after it ends — so the two
   *  cannot be the same number: judging a copy by its bleed's start
   *  would let an edit re-lay something already sounding. */
  copyAt: number;
  endsAt: number;
}

/** Let a finished voice's nodes go. */
function unplug(voice: Voice): void {
  voice.node.disconnect();
  voice.gain.disconnect();
  voice.pan?.disconnect();
}

export interface GridPlayback {
  playing: boolean;
  /** Fractional column the playhead is on. */
  column: number;
}

export class GridTransport {
  #source: GridAudioSource;
  /** Decoded audio, keyed by clip AND the tempo it was stretched to. */
  #buffers = new Map<string, AudioBuffer>();
  /** Decoded bleed bookends, keyed the same way plus the side. A clip
   *  saved WITHOUT one is remembered as null, so it is asked for once
   *  and not on every pass. */
  #bleed = new Map<string, AudioBuffer | null>();
  /** Renders in flight, so a re-schedule does not ask twice. */
  #pending = new Set<string>();
  /** Every voice in flight. A node is remembered with the copy and pass
   *  it came from, because an edit has to be able to FIND it again:
   *  Web Audio schedules a whole pass ahead of the sound, so a clip
   *  deleted (or a level re-drawn) after that point is already committed
   *  unless the node itself is revisited. */
  #nodes: Voice[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #passes: Pass[] = [];
  /** The pass being scheduled next, or null once the last one is laid
   *  down (a non-looping play). */
  #next: Pass | null = null;
  #state: GridState | null = null;
  #clips: ReadonlyMap<string, BeatClipEntry> = new Map();
  #columns = 0;
  #range: ColumnRange = { start: 0, end: 0 };
  #looping = false;
  #playing = false;
  /** Re-arming after an edit that cannot be spliced into the pass in
   *  flight. `play` is async (it may have audio to fetch), so without
   *  this the transport would report itself STOPPED for the microtask
   *  between the two — a blip the page would draw as a stop. */
  #cueing = false;
  #at = 0;
  #disposed = false;

  constructor(source: GridAudioSource) {
    this.#source = source;
  }

  get playing(): boolean {
    return this.#playing || this.#cueing;
  }

  /** The audio clock where there is one, the wall clock where there is
   *  not — both monotonic seconds, which is all the scheduling needs. */
  #now(): number {
    const ctx = sharedContext();
    return ctx ? ctx.currentTime : performance.now() / 1000;
  }

  /** A buffer's cache key: the clip, the tempo it was stretched to, and
   *  — for a WET buffer — the rack graph it was rendered through, so an
   *  edited rack is a different buffer, not a stale one. */
  #key(clipId: string, bpm: number, fx?: string | null): string {
    return fx ? `${clipId}@${bpm}!${fx}` : `${clipId}@${bpm}`;
  }

  #bleedKey(clipId: string, bpm: number, side: BleedSide): string {
    return `${this.#key(clipId, bpm)}:${side}`;
  }

  /** The longest lead-in in hand. A pass has to be committed this much
   *  before it begins as well as a lookahead: a copy on its first beat
   *  starts sounding a bookend's length EARLIER than the pass does, and
   *  where a loop comes round that lead-in belongs over the tail of the
   *  time before — scheduling it late would clip the very join it is
   *  there to smooth. */
  #leadIn(): number {
    let lead = 0;
    for (const [key, buffer] of this.#bleed) {
      if (buffer && key.endsWith(':left')) lead = Math.max(lead, buffer.duration);
    }
    return lead;
  }

  /** Fetch and decode every (clip, tempo) the grid asks for — and the
   *  bleed either side of every copy — so a pass can be scheduled
   *  without awaiting anything: an await between "it is time" and
   *  `start(when)` is how a clip ends up late. */
  async prime(
    state: GridState,
    clips: ReadonlyMap<string, BeatClipEntry>,
    over?: ColumnRange,
  ): Promise<void> {
    const ctx = sharedContext();
    if (!ctx) return;
    const columns = Math.max(this.#columns, state.beats);
    const wanted = new Map<string, { clipId: string; bpm: number; fx?: string }>();
    const bookends = new Map<string, { clipId: string; bpm: number; side: BleedSide }>();
    for (const copy of scheduleRange(state, clips, over ?? playRange(state, columns))) {
      wanted.set(this.#key(copy.clipId, copy.bpm), { clipId: copy.clipId, bpm: copy.bpm });
      if (copy.fx) {
        // An effected copy needs its WET buffer too — the same clip
        // rendered through the row's rack.
        wanted.set(this.#key(copy.clipId, copy.bpm, copy.fx), {
          clipId: copy.clipId,
          bpm: copy.bpm,
          fx: copy.fx,
        });
      }
      for (const side of BLEED_SIDES) {
        if (!copy.bleed[side]) continue;
        bookends.set(this.#bleedKey(copy.clipId, copy.bpm, side), {
          clipId: copy.clipId,
          bpm: copy.bpm,
          side,
        });
      }
    }
    await Promise.all([
      ...[...wanted].map(async ([key, { clipId, bpm, fx }]) => {
        if (this.#buffers.has(key) || this.#pending.has(key)) return;
        this.#pending.add(key);
        try {
          const bytes = await this.#source.audio(clipId, bpm, fx);
          if (!bytes || this.#disposed) return;
          this.#buffers.set(key, await ctx.decodeAudioData(bytes.slice(0)));
        } catch {
          // A clip that will not decode simply stays silent; the grid
          // still plays everything else.
        } finally {
          this.#pending.delete(key);
        }
      }),
      ...[...bookends].map(async ([key, { clipId, bpm, side }]) => {
        const fetch = this.#source.bleed;
        if (!fetch || this.#bleed.has(key) || this.#pending.has(key)) return;
        this.#pending.add(key);
        try {
          const bytes = await fetch.call(this.#source, clipId, side, bpm);
          if (this.#disposed) return;
          this.#bleed.set(key, bytes ? await ctx.decodeAudioData(bytes.slice(0)) : null);
        } catch {
          // A bookend that will not come or will not decode is a join
          // played bare — never a clip that does not sound.
          this.#bleed.set(key, null);
        } finally {
          this.#pending.delete(key);
        }
      }),
    ]);
  }

  /** Start at `fromColumn` (the range's start by default). Playing again
   *  while playing re-cues rather than layering.
   *
   *  A CURSOR OUTSIDE THE LOOP IS PLAYED FROM, not jumped away from: the
   *  first pass runs from wherever it is cued to the loop's end and the
   *  loop takes over there, so a lead-in before the loop is heard once
   *  and then the loop repeats. Cued from PAST the loop, the first pass
   *  runs to the end of the grid before falling into it. */
  async play(
    state: GridState,
    clips: ReadonlyMap<string, BeatClipEntry>,
    columns: number,
    fromColumn?: number,
  ): Promise<void> {
    if (this.#disposed) return;
    const cued = this.#cueing;
    this.#silence();
    const range = playRange(state, columns);
    if (range.end <= range.start) return;
    this.#state = state;
    this.#clips = clips;
    this.#columns = columns;
    this.#range = range;
    this.#looping = state.loop !== null;
    const from = Math.max(0, Math.min(fromColumn ?? range.start, columns - 1e-9));
    // Cued past the loop there is no loop end ahead, so the lead-in runs
    // to the end of the grid; the loop still takes over after it.
    const to = from < range.end ? range.end : columns;
    // The lead-in's clips are primed as well as the loop's: material the
    // loop never reaches still has to be there when it is played through.
    await Promise.all([
      this.prime(state, clips, { start: from, end: to }),
      this.prime(state, clips),
    ]);
    // A stop while the audio was being fetched wins: it cleared the cue
    // this play was arming, so there is nothing left to start.
    if (this.#disposed || (cued && !this.#cueing)) return;
    this.#playing = true;
    this.#next = {
      at: this.#now() + 0.05,
      from,
      to,
      secs: rangeSecs(state.tempo, { start: from, end: to }),
      laid: new Set(),
    };
    this.#pump();
    this.#timer = setInterval(() => this.#pump(), SCHEDULE_MS);
  }

  /** Take a new grid mid-play: the arrangement is EDITABLE while it
   *  sounds. Copies already scheduled keep playing (they are held by
   *  key); everything the edit added — a new placement, a moved level
   *  point — is laid down by the next pump, on its own beat.
   *
   *  A tempo change is the one edit that cannot be spliced into a pass
   *  in flight: every copy's start is measured through the envelope from
   *  the pass's beginning, so a new envelope re-times beats that are
   *  already sounding. It re-cues from where the playhead is, which
   *  keeps the grid honest at the cost of one seam.
   *
   *  THE LOOP IS NOT SUCH AN EDIT. It says where the pass in flight ends
   *  and where the next one begins — two numbers ahead of the playhead —
   *  so moving it is `#reloop`, and the sound only meets it at the wrap. */
  update(state: GridState, clips: ReadonlyMap<string, BeatClipEntry>, columns: number): void {
    const was = this.#state;
    this.#state = state;
    this.#clips = clips;
    this.#columns = columns;
    if (!this.#playing || !was) return;
    if (JSON.stringify(was.tempo) !== JSON.stringify(state.tempo)) {
      const range = playRange(state, columns);
      const at = this.#at;
      // Anywhere on the grid keeps its place, loop or no loop: a lead-in
      // before the loop is a place the transport can be.
      const from = at >= 0 && at < columns ? at : range.start;
      this.#cueing = true;
      void this.play(state, clips, columns, from).finally(() => {
        this.#cueing = false;
      });
      return;
    }
    this.#reloop(state);
    this.#resync(state);
    void this.prime(state, clips);
    this.#pump();
  }

  /** Point the pass in flight, and the one after it, at the loop as it
   *  now stands. NOTHING SOUNDING MOVES: a loop is a pair of columns the
   *  playhead has yet to reach, so re-marking it can only change where
   *  this pass ends and where the next one starts — never where the
   *  playhead is, which is what made dragging the loop re-cue the whole
   *  transport and tear the playback apart.
   *
   *  Passes committed AHEAD of the clock are thrown away and laid again
   *  from the new loop: they have not been heard, and a wrap that is no
   *  longer where it was must not be the one already scheduled. */
  #reloop(state: GridState): void {
    const range = playRange(state, this.#columns);
    const unchanged = range.start === this.#range.start && range.end === this.#range.end;
    this.#range = range;
    this.#looping = state.loop !== null;
    if (unchanged) return;
    const now = this.#now();
    while (this.#passes.length > 1 && this.#passes[this.#passes.length - 1].at > now) {
      this.#unlay(this.#passes.pop()!);
    }
    const pass = this.#passes[this.#passes.length - 1];
    if (!pass) return;
    pass.to = this.#endOf(state, pass, now);
    pass.secs = rangeSecs(state.tempo, { start: pass.from, end: pass.to });
    this.#next = this.#follow(state, pass);
  }

  /** Where a pass in flight now runs to. The loop's end while it is
   *  still AHEAD of the playhead; the end of the grid once it is not —
   *  a loop moved behind what is sounding is played out to the end and
   *  fallen into there, the same as a play cued past it, rather than
   *  jumping the playhead backwards into it. */
  #endOf(state: GridState, pass: Pass, now: number): number {
    const within = Math.max(0, now - pass.at);
    const at = secsToBeat(state.tempo, beatToSecs(state.tempo, pass.from) + within);
    return this.#range.end > at ? this.#range.end : this.#columns;
  }

  /** The pass that follows this one: the loop as it stands, or nothing
   *  where there is no loop to come round. */
  #follow(state: GridState, pass: Pass): Pass | null {
    if (!this.#looping) return null;
    return {
      at: pass.at + pass.secs,
      from: this.#range.start,
      to: this.#range.end,
      secs: rangeSecs(state.tempo, this.#range),
      laid: new Set(),
    };
  }

  /** Take back a pass that was committed but never heard. Voices already
   *  SOUNDING are left to ring — a lead-in bookend laid over the seam is
   *  material of the pass before it — and only what has yet to start is
   *  silenced. */
  #unlay(pass: Pass): void {
    const now = this.#now();
    this.#nodes = this.#nodes.filter((voice) => {
      if (voice.pass !== pass || voice.at <= now) return true;
      this.#drop(voice, voice.at);
      return false;
    });
  }

  /** Stop, keeping nothing: the next play starts where the caller says.
   *  A stop the caller ASKED FOR also cancels a re-cue in flight — the
   *  page has said to be quiet, and the pending `play` must not undo
   *  that when it lands. */
  stop(): void {
    this.#cueing = false;
    this.#silence();
  }

  /** Stop SCHEDULING and leave what is already sounding to finish: what
   *  a play that has run off its end does. The arrangement ran out;
   *  nobody asked for silence, so a tail-out hanging over the last
   *  copy's end is allowed to ring. */
  #finish(): void {
    this.#playing = false;
    this.#next = null;
    this.#passes = [];
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Tear the current pass down without touching `#cueing`: what `play`
   *  does to itself before cueing the next one, and what a stop the page
   *  ASKED for does — that one cuts. */
  #silence(): void {
    this.#finish();
    for (const voice of this.#nodes) {
      try {
        voice.node.stop();
      } catch {
        // Already finished.
      }
      unplug(voice);
    }
    this.#nodes = [];
  }

  /** Stop the sound but keep the place, so the next play resumes here.
   *  That is the whole difference between pause and stop on this page:
   *  the playhead survives. */
  pause(): number {
    const at = this.status().column;
    this.stop();
    this.#at = at;
    return at;
  }

  /** Park the playhead somewhere while stopped (a seek). */
  seek(column: number): void {
    this.#at = Math.max(0, column);
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
      this.#at = pass.to;
      // Running out ends a re-cue in flight the way a stop does — there
      // is nothing left to carry on with — but it does NOT cut what is
      // still sounding: the last copy's tail-out is meant to hang over
      // the end.
      this.#cueing = false;
      this.#finish();
      return { playing: false, column: this.#at };
    }
    const within = Math.max(0, Math.min(now - pass.at, pass.secs));
    const secs = beatToSecs(this.#state.tempo, pass.from) + within;
    this.#at = Math.min(secsToBeat(this.#state.tempo, secs), pass.to);
    return { playing: true, column: this.#at };
  }

  /** Drop every decode of these clips — the loop at each tempo, its wet
   *  renders and its bookends — so the next `prime` fetches them again.
   *
   *  A clip EDITED keeps its id (that is what makes the rows pointing at
   *  it survive the edit), so the cache key cannot tell the new audio
   *  from the old on its own: the page, which is what learns a clip has
   *  been re-saved, says so here. */
  forget(clipIds: Iterable<string>): void {
    for (const clipId of clipIds) {
      const prefix = `${clipId}@`;
      for (const key of this.#buffers.keys()) {
        if (key.startsWith(prefix)) this.#buffers.delete(key);
      }
      for (const key of this.#bleed.keys()) {
        if (key.startsWith(prefix)) this.#bleed.delete(key);
      }
    }
  }

  dispose(): void {
    this.stop();
    this.#disposed = true;
    this.#buffers.clear();
    this.#bleed.clear();
  }

  /** Lay down every pass that begins inside the lookahead, and top up the
   *  passes already begun with whatever a live edit has added. */
  #pump(): void {
    const state = this.#state;
    if (!this.#playing || !state) return;
    const horizon = this.#now() + LOOKAHEAD_SECS + this.#leadIn();
    while (this.#next && this.#next.at <= horizon) {
      const pass = this.#next;
      this.#passes = [...this.#passes.slice(-3), pass];
      this.#schedule(state, pass);
      this.#next = this.#follow(state, pass);
    }
    // Live edits: a pass still sounding gets whatever is now on the grid
    // and has not been laid down yet.
    const now = this.#now();
    for (const pass of this.#passes) {
      if (now < pass.at + pass.secs) this.#schedule(state, pass);
    }
    // Passes that have played out are dropped, but the LATEST one is
    // always kept: it is what tells `status` a non-looping play has run
    // off its end, and pruning it would leave the playhead frozen and
    // still calling itself playing.
    const cutoff = now - 1;
    this.#passes = this.#passes.filter(
      (p, i) => i === this.#passes.length - 1 || p.at + p.secs >= cutoff,
    );
    this.#nodes = this.#nodes.filter((voice) => {
      if (voice.endsAt >= now) return true;
      unplug(voice);
      return false;
    });
  }

  #schedule(state: GridState, pass: Pass): void {
    const ctx = sharedContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const copy of scheduleRange(state, this.#clips, {
      start: pass.from,
      end: pass.to,
    })) {
      if (pass.laid.has(copy.key)) continue;
      const at = pass.at + copy.atSecs;
      // A copy whose moment has passed is not started late — that would
      // put it off the beat. Mark it so later pumps stop reconsidering
      // it; the next pass plays it properly.
      if (at < now) {
        pass.laid.add(copy.key);
        continue;
      }
      const buffer = this.#buffers.get(this.#key(copy.clipId, copy.bpm));
      const wet = copy.fx ? this.#buffers.get(this.#key(copy.clipId, copy.bpm, copy.fx)) : null;
      if (!buffer || (copy.fx && !wet)) {
        // Its stretch (or its rack render) is still rendering. Leave the
        // copy UNMARKED so a later pump lays it down once the audio
        // lands, as long as its moment has not passed by then.
        void this.prime(state, this.#clips, { start: pass.from, end: pass.to });
        continue;
      }
      pass.laid.add(copy.key);
      const offset = Math.min(copy.offsetSecs, buffer.duration);
      const duration = Math.max(0, Math.min(copy.durationSecs, buffer.duration - offset));
      if (duration <= 0) continue;
      // An effected copy is a PAIR of sample-aligned voices — the clip
      // and the rack's render of it — whose gains split the row's level
      // by Wetness. Both are always laid: a wetness ridden mid-note can
      // then move between them (`#resync`) instead of missing a side.
      this.#lay(ctx, pass, copy, buffer, 'dry', { at, offset, duration, copyAt: at });
      if (wet) {
        const wetDuration = Math.max(0, Math.min(copy.durationSecs, wet.duration - offset));
        if (wetDuration > 0) {
          this.#lay(ctx, pass, copy, wet, 'wet', {
            at,
            offset,
            duration: wetDuration,
            copyAt: at,
          });
        }
      }
      this.#layBleed(ctx, pass, copy, at, now);
    }
  }

  /** How much of the row's level one voice carries: an effected copy
   *  splits it across the crossfade, an ordinary one is all dry. A wet
   *  voice whose copy has LOST its rack (reset to default mid-play) has
   *  no side left to carry. */
  #mix(copy: ScheduledClip, side: 'dry' | 'wet'): number {
    if (!copy.fx) return side === 'dry' ? 1 : 0;
    return side === 'dry' ? 1 - copy.wet : copy.wet;
  }

  /** One buffer under one copy, wired and started. */
  #lay(
    ctx: AudioContext,
    pass: Pass,
    copy: ScheduledClip,
    buffer: AudioBuffer,
    side: 'dry' | 'wet',
    when: { at: number; offset: number; duration: number; copyAt: number },
  ): void {
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    const gain = ctx.createGain();
    this.#writeLevels(gain, copy, this.#mix(copy, side), when.copyAt, when.at);
    // A centred row needs no panner at all, so the ordinary grid keeps
    // exactly the chain it had.
    const pan = copy.pan !== 0 && ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    node.connect(gain);
    if (pan) {
      pan.pan.value = copy.pan;
      gain.connect(pan);
      pan.connect(ctx.destination);
    } else {
      gain.connect(ctx.destination);
    }
    node.start(when.at, when.offset, when.duration);
    const voice: Voice = {
      node,
      gain,
      pan,
      pass,
      key: copy.key,
      side,
      fx: copy.fx,
      at: when.at,
      copyAt: when.copyAt,
      endsAt: when.at + when.duration,
    };
    node.onended = () => unplug(voice);
    this.#nodes.push(voice);
  }

  /** A copy's bleed, laid where the material came from: the LEFT
   *  bookend (what ran into the clip in its track) ends on the copy's
   *  first beat, the RIGHT one (what followed it) starts where its last
   *  beat ends. A copy on its own is therefore heard as lead-in, clip,
   *  tail-out; two copies running together put one copy's tail-out and
   *  the next one's lead-in ON the join, which is the overlay a looping
   *  player makes of its seam — and no copy carries its own right bleed
   *  at its head or its own left bleed at its tail, the rule the engine
   *  states as head/tail.
   *
   *  The bleed rides the copy's own level and pan: it is that copy
   *  coming in or going out, not a voice of its own.
   *
   *  A lead-in cannot be scheduled into the PAST, so one that reaches
   *  back before the clock (the first copy of a play that has just been
   *  started) is trimmed at the front and still lands on its beat. A
   *  bookend still being fetched is skipped rather than waited for: a
   *  join smoothed one pass late is a smaller fault than a clip that
   *  misses its beat. */
  #layBleed(ctx: AudioContext, pass: Pass, copy: ScheduledClip, at: number, now: number): void {
    for (const side of BLEED_SIDES) {
      if (!copy.bleed[side]) continue;
      const buffer = this.#bleed.get(this.#bleedKey(copy.clipId, copy.bpm, side));
      if (!buffer) continue;
      const from = side === 'right' ? at + copy.durationSecs : at - buffer.duration;
      const start = Math.max(from, now);
      const offset = start - from;
      const duration = buffer.duration - offset;
      if (duration <= 0) continue;
      // The bookend is material of the ORIGINAL clip, so it rides the
      // dry side of the crossfade: a fully wet copy plays the rack's
      // render alone, bleed and all.
      this.#lay(ctx, pass, copy, buffer, 'dry', { at: start, offset, duration, copyAt: at });
    }
  }

  /** Bring the voices already scheduled into line with a grid that has
   *  just changed under them. A pass is committed to Web Audio well
   *  before it is heard, so without this a copy taken off the grid still
   *  sounds on the next time round a loop, and a level re-drawn during
   *  playback is not heard at all.
   *
   *  A voice that has not started yet is simply thrown away and left to
   *  be laid down again from the current grid. One already SOUNDING is
   *  cut short if its copy is gone, and otherwise has its level rewritten
   *  underneath it — a note in progress cannot be un-rung, but it can
   *  still be faded. */
  #resync(state: GridState): void {
    const ctx = sharedContext();
    if (!ctx || this.#nodes.length === 0) return;
    const now = ctx.currentTime;

    // What the grid says each live pass should be playing, by copy key.
    const wanted = new Map<Pass, Map<string, ScheduledClip>>();
    for (const pass of this.#passes) {
      const copies = new Map<string, ScheduledClip>();
      for (const copy of scheduleRange(state, this.#clips, {
        start: pass.from,
        end: pass.to,
      })) {
        copies.set(copy.key, copy);
      }
      wanted.set(pass, copies);
    }

    this.#nodes = this.#nodes.filter((voice) => {
      const copies = wanted.get(voice.pass);
      if (!copies) return true;
      const copy = copies.get(voice.key);
      const started = voice.copyAt <= now;

      if (!copy) {
        this.#drop(voice, started ? now : voice.at);
        voice.pass.laid.delete(voice.key);
        return false;
      }
      if (!started) {
        // Not heard yet: drop it and let the next pump lay it down from
        // the grid as it stands now, gain and all.
        this.#drop(voice, voice.at);
        voice.pass.laid.delete(voice.key);
        return false;
      }
      // Sounding: rewrite the level under it — and the Wetness split,
      // so the crossfade knob is heard on notes already in the air. A
      // wet voice whose GRAPH was edited keeps sounding the old render
      // until the pass comes round again (a note in progress cannot be
      // re-rendered), at the new wetness.
      voice.gain.gain.cancelScheduledValues(now);
      this.#writeLevels(voice.gain, copy, this.#mix(copy, voice.side), voice.copyAt, voice.at);
      // A pan moved mid-note follows too, as far as the voice can: one
      // that started centred has no panner to move.
      if (voice.pan) voice.pan.pan.value = copy.pan;
      return true;
    });
  }

  /** Silence one voice, at `when` or as soon as possible. */
  #drop(voice: Voice, when: number): void {
    try {
      voice.node.stop(when);
    } catch {
      // Already stopped, or never started: nothing to take back.
    }
    voice.node.onended = null;
    unplug(voice);
  }

  /** Write the row's level line onto a copy's gain: the first value is
   *  set where the copy starts and every bend after it is ramped to, so
   *  a fade drawn across a clip is heard as a fade, not a step.
   *
   *  `from` is where the VOICE begins, which for a lead-in bookend is
   *  before the copy: the line's first value is laid down there instead,
   *  so material that runs into a faded clip is faded too rather than
   *  sounding at unity until the beat arrives. A tail-out needs nothing
   *  — the line's last value is where the envelope has already left the
   *  gain.
   *
   *  `mix` is the voice's share of the crossfade (`#mix`): the level line
   *  is the ROW's, and the dry/wet pair splits every point of it. */
  #writeLevels(gain: GainNode, copy: ScheduledClip, mix: number, at: number, from = at): void {
    const [first, ...rest] = copy.levels;
    gain.gain.setValueAtTime((first ? first[1] : 1) * mix, Math.min(from, at));
    for (const [secs, level] of rest) gain.gain.linearRampToValueAtTime(level * mix, at + secs);
  }
}
