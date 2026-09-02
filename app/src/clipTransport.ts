// The Clip page's audition transport.
//
// One object owns EVERYTHING that can make sound on the clip page: the
// <audio> element's src/objectURL, the Web Audio loop node, the window
// those hold, the playhead, and the timers that drive them. The view
// calls commands and renders the status it is handed back; it never
// touches an audio node itself.
//
// WHY: playback used to be a handful of refs written from eight places
// (two effects, three callbacks, two media events, an async continuation),
// each with an `await` in the middle. Overlapping calls could each start a
// source and the loser's handle was simply overwritten — the page played
// the track twice with one copy no longer reachable by pause or stop.
//
// The invariants that replace that, all enforced here:
//
//   1. ONE SLOT. `#source` is the only reference to something making
//      sound, and it is only ever filled by `#install` immediately after
//      `#release` has emptied it — so no instant exists in which two
//      sources are live.
//   2. EPOCHS. Every command bumps `#epoch`. An async continuation
//      captures the epoch it started with and, after each await, gives up
//      if it no longer matches. Late renders and late decodes are dropped,
//      not applied.
//   3. NOTHING SOUNDS BEFORE ITS LAST CHECK. Decoding (`prepareLoop`) is
//      side-effect free; the node starts synchronously after the final
//      staleness check, so a superseded call cannot leave an orphan.
//   4. DISPOSAL IS FINAL. A disposed transport stops everything and
//      refuses every command, so React StrictMode's mount/unmount/mount
//      leaves nothing of the first instance behind.
//   5. THE WINDOW IS A CACHE. What has been rendered (and decoded) can be
//      re-entered anywhere inside itself, synchronously — so a seek into
//      it, or a resume out of a pause, moves the position instead of
//      fetching the same audio again and making the user wait for it.
//   6. ONLY PLAYBACK WRAPS. Reaching the loop's end is something playback
//      DOES (`advanceTo`); a command that puts the playhead somewhere
//      (`setPlayhead`) never triggers a wrap, or pausing near the end of
//      a loop starts the loop again.
//   7. A CHAIN IS FETCHED BEFORE IT IS NEEDED. Anything longer than one
//      window plays as windows chained end to end, and asking for the
//      next one only once the current has ENDED buys a render, a WAV
//      encode and an IPC hop of silence at every boundary — audibly, a
//      hole at the one-minute mark of any linear playback. The next
//      window is rendered while the current one still plays, so reaching
//      the boundary is a src swap with no await in it at all.
//
// Timing values are injected so tests can drive the same code with short
// debounces.

import { prepareLoop as defaultPrepareLoop, type LoopHandle, type PreparedLoop } from './clipAudio';

export interface Range {
  start: number;
  end: number;
}

/** The stretch of the edit currently rendered into a source. */
export interface PlayWindow {
  start: number;
  end: number;
  /** The source wraps itself at the end of this window — true only while
   *  the window IS the armed loop range. */
  loop: boolean;
}

export interface TransportStatus {
  playing: boolean;
  playhead: number;
}

/** Everything the transport needs from the outside world. Injected rather
 *  than imported so tests can supply deterministic fakes. */
export interface TransportHost {
  /** Length of the whole edit, in seconds. */
  duration(): number;
  /** The element to drive; null until the editor has rendered one. Read
   *  at call time, so the element may arrive after the transport does. */
  element(): HTMLAudioElement | null;
  /** Render `[start, start + lenSecs)` of the CURRENT edit to WAV bytes.
   *  Resolving late is fine — a stale result is discarded. */
  render(start: number, lenSecs: number): Promise<ArrayBuffer | null>;
  /** Called whenever `playing` or the playhead changes. */
  onStatus(status: TransportStatus): void;
  /** Decode for gapless looping; null ⇒ no Web Audio in this runtime. */
  prepareLoop?(bytes: ArrayBuffer): Promise<PreparedLoop | null>;
}

export interface TransportOptions {
  /** Length of one rendered window; playback chains windows past it. */
  windowSecs?: number;
  /** Playhead poll while a Web Audio loop runs (it has no timeupdate). */
  tickMs?: number;
  /** Debounce before re-rendering the playing window after a tone edit. */
  toneDelayMs?: number;
  /** How far before the end of a window its successor is fetched. Must
   *  comfortably exceed a render + IPC round trip. */
  prefetchSecs?: number;
}

/** The one thing that may be making sound. */
type Source = { kind: 'loop'; handle: LoopHandle } | { kind: 'element'; el: HTMLAudioElement };

/** A window fetched ahead of the boundary that will need it. */
interface Ahead {
  start: number;
  end: number;
  /** The render, so a boundary reached before it lands waits on it
   *  instead of asking for the same window a second time. */
  fetch: Promise<ArrayBuffer | null>;
  /** What it rendered to, once it has landed. */
  bytes: ArrayBuffer | null;
}

const EPS = 1e-3;

export class ClipTransport {
  private readonly host: TransportHost;
  private readonly windowSecs: number;
  private readonly tickMs: number;
  private readonly toneDelayMs: number;
  private readonly prefetchSecs: number;

  /** Bumped by every command. Async work started under an older epoch has
   *  been superseded and must not touch anything. */
  private epoch = 0;
  private disposed = false;

  private source: Source | null = null;
  private win: PlayWindow | null = null;
  /** The decoded audio behind `win`, kept for as long as the window is —
   *  a seek inside it, or a resume out of a pause, is then a node start
   *  rather than another render and another decode. */
  private prepared: PreparedLoop | null = null;
  /** The range the transport has been asked to loop, if any. */
  private loopRange: Range | null = null;
  /** The window AFTER the one playing, fetched before the boundary. Only
   *  ever used for the exact span it was fetched for, and thrown away
   *  whenever what it holds stops being the edit. */
  private ahead: Ahead | null = null;
  private playingNow = false;
  private playheadNow = 0;

  private el: HTMLAudioElement | null = null;
  private url: string | null = null;
  /** Seconds into the loaded window the element still has to seek to,
   *  null once it has (seeking only sticks after `loadedmetadata`). */
  private pendingSeek: number | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Guards the playhead write inside a wrap from re-entering it. */
  private wrapping = false;
  private toneTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: TransportHost, opts: TransportOptions = {}) {
    this.host = host;
    this.windowSecs = opts.windowSecs ?? 60;
    this.tickMs = opts.tickMs ?? 50;
    this.toneDelayMs = opts.toneDelayMs ?? 350;
    this.prefetchSecs = Math.min(opts.prefetchSecs ?? 10, this.windowSecs / 2);
  }

  // --- what the view reads -------------------------------------------
  get playing(): boolean {
    return this.playingNow;
  }

  get playhead(): number {
    return this.playheadNow;
  }

  /** The window a source currently holds, or null when nothing is loaded. */
  get loaded(): PlayWindow | null {
    return this.win;
  }

  /** Where playback has actually got to, from whichever backend owns it. */
  position(): number | null {
    const w = this.win;
    if (!w) return null;
    const within = this.within();
    return within === null ? null : Math.min(this.host.duration(), w.start + within);
  }

  // --- commands -------------------------------------------------------

  /** Play from `fromSecs`, looping `loopRange` if given. `seekWithin`
   *  starts that far into the rendered window (used to keep a loop's
   *  phase across a re-render). */
  play(fromSecs: number, loopRange: Range | null, seekWithin = 0): void {
    if (this.disposed) return;
    this.loopRange = loopRange;
    // Resuming a pause is not a fetch. The window in hand usually still
    // holds where we are being asked to start — the user only pressed
    // pause — and re-rendering it costs a second of silence and, on the
    // media element, a load whose seek lands late enough to be heard as
    // the loop starting from its head.
    if (!this.playingNow && seekWithin <= 0 && this.reenter(fromSecs, loopRange)) return;
    void this.begin(fromSecs, loopRange, seekWithin);
  }

  /** Move the playhead. Parks it while stopped; while playing, playback
   *  jumps there — the transport owns the playhead, so a click on the
   *  waveform cannot leave the view and the audio disagreeing. */
  seek(secs: number): void {
    if (this.disposed) return;
    const at = Math.max(0, Math.min(this.host.duration(), secs));
    if (!this.playingNow) {
      this.epoch++;
      this.cancelTone();
      this.release();
      // The window is AUDIO, not a position: keep it when it still holds
      // where the playhead has been parked, so the next Play is instant.
      if (this.withinLoaded(at) === null) this.drop();
      this.setPlayhead(at);
      return;
    }
    // A CLICK IS ANSWERED NOW. The audio in hand almost always covers
    // where the user clicked, and moving the position inside it is
    // immediate; going back to the backend for a window we are already
    // holding is what made seeking during playback feel ignored — the
    // old source plays on, and its playhead overwrites the click, until
    // a whole window has been rendered.
    const within = this.withinLoaded(at);
    if (within !== null && this.enter(within)) return;
    this.setPlayhead(at);
    const range = this.loopRange;
    // Inside the loop, keep looping; outside it, play on from there (the
    // view owns whether a loop is still armed and says so via `setLoop`).
    // Either way `begin` is handed the ABSOLUTE position and works out
    // which window holds it — a loop longer than one window does not have
    // the target in its head window, so asking to start `at - range.start`
    // into that window would seek past the end of what was loaded.
    const inLoop = range !== null && at >= range.start && at <= range.end;
    void this.begin(at, inLoop ? range : null, 0);
  }

  /** Stop, keeping the playhead where playback got to. */
  pause(): void {
    if (this.disposed) return;
    this.epoch++;
    this.cancelTone();
    const at = this.position();
    this.release();
    // Not playing FIRST, then the playhead: the window it holds is kept
    // (a resume re-enters it), and where playback got to is a fact about
    // a transport that has already stopped.
    this.setPlaying(false);
    if (at !== null) this.setPlayhead(at);
  }

  /** Stop and park the playhead at `parkAt`, dropping the loaded window. */
  stop(parkAt = 0): void {
    if (this.disposed) return;
    this.epoch++;
    this.cancelTone();
    this.release();
    this.drop();
    this.setPlaying(false);
    this.setPlayhead(parkAt);
  }

  /** The edit's TIMELINE changed: every output time now means something
   *  else, so what is loaded is not the edit any more. */
  invalidate(): void {
    if (this.disposed) return;
    this.epoch++;
    this.cancelTone();
    const at = this.position();
    this.release();
    this.drop();
    this.setPlaying(false);
    if (at !== null) this.setPlayhead(at);
  }

  /** The loop range changed (selection moved, Loop toggled). Playback
   *  carries on where it is either way — see below. */
  setLoop(range: Range | null): void {
    if (this.disposed) return;
    this.loopRange = range;
    const w = this.win;
    if (!this.playingNow || !w) return;
    // A LOOP CHANGE NEVER MOVES PLAYBACK. Arming Loop, or dragging the
    // selection while it plays, used to re-render at the loop head, so
    // the audio jumped backwards under a live drag and stuttered on every
    // mousemove. Playback runs on from where it is; the only thing a
    // range does is decide WHERE THE WRAP IS, and that happens when
    // playback reaches the right-hand edge (`wrapAt` below).
    //
    // All that is needed here is to stop the source wrapping somewhere
    // else: a buffer or element looping ITSELF only stays right while it
    // holds exactly the armed range.
    const exact =
      range !== null && Math.abs(w.start - range.start) < EPS && Math.abs(w.end - range.end) < EPS;
    if (!exact) this.setNativeLoop(false);
  }

  /** Whether the running source wraps on its own at the end of what it
   *  holds. Off means it runs out instead, and `onEnded`/`onLoopEnd`
   *  picks the next window using the range armed by then. */
  private setNativeLoop(on: boolean): void {
    const source = this.source;
    if (!source) return;
    if (source.kind === 'loop') source.handle.setLooping(on);
    else source.el.loop = on;
    if (this.win) this.win.loop = on;
  }

  /** A TONE-ONLY edit (EQ, level) landed on a page with no live tone
   *  chain: the timeline still means what it meant, so re-render the
   *  playing window in place instead of stopping. Debounced — a knob drag
   *  streams edits and each re-render is a whole window of DSP.
   *
   *  Where the page CAN apply tone live (clipLive.ts) this is never
   *  called: a knob move costs no render at all. */
  refreshTone(): void {
    if (this.disposed || !this.playingNow) return;
    this.cancelTone();
    this.toneTimer = setTimeout(() => {
      this.toneTimer = null;
      this.reload();
    }, this.toneDelayMs);
  }

  /** The MATERIAL changed but the timeline still means what it meant — a
   *  stem swapped under the same span. Re-render now and swap; the old
   *  source plays on until the new one is ready, so nothing stops. */
  refreshMaterial(): void {
    if (this.disposed || !this.playingNow) return;
    this.cancelTone();
    this.reload();
  }

  /** Re-fetch what is playing and carry on from wherever playback has got
   *  to BY THEN. The position is read after the render resolves, not
   *  before it: a render takes the best part of a second, and resuming at
   *  the position it started from replays that second. */
  private reload(): void {
    const w = this.win;
    if (this.disposed || !this.playingNow || !w) return;
    // Whatever was fetched ahead is a render of the material this call is
    // replacing, so playing it at the boundary would put the old sound
    // back.
    this.dropAhead();
    const range = this.loopRange;
    const live = () => this.position();
    if (range) void this.begin(w.start, range, 0, live);
    else void this.begin(this.position() ?? w.start, null, 0, live);
  }

  /** Push the current status at the host again. The page has TWO owners
   *  (the other is ClipLivePlayer) and shows whichever holds playback:
   *  when it changes hands, the readout has to come back to what this
   *  one says, even though nothing about it moved. */
  publish(): void {
    if (!this.disposed) this.notify();
  }

  /** Stop everything and refuse all further commands. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.epoch++;
    this.disposed = true;
    this.cancelTone();
    this.release();
    this.drop();
    this.detach();
    this.revokeUrl();
    this.playingNow = false;
  }

  // --- the window in hand ----------------------------------------------
  //
  // THE WINDOW IS A CACHE, NOT A POSITION. Once a stretch of the edit has
  // been rendered (and, for a loop, decoded), every position inside it is
  // reachable at once — so seeking into it, or resuming a pause inside
  // it, must not go anywhere near the backend.

  /** Seconds into the loaded window for an absolute time, or null when
   *  the window does not hold it. The last instant is excluded: a media
   *  element seeked to the end of what it holds ends on the spot. */
  private withinLoaded(at: number): number | null {
    const w = this.win;
    if (!w) return null;
    const within = at - w.start;
    if (within < -EPS || within > w.end - w.start - EPS) return null;
    return Math.max(0, within);
  }

  /** Forget the window and the audio behind it. */
  private drop(): void {
    this.win = null;
    this.prepared = null;
    this.dropAhead();
  }

  // --- the window after it ---------------------------------------------
  //
  // A CHAIN IS FETCHED BEFORE IT IS NEEDED (invariant 7). A render is a
  // round trip to the backend and back with a whole window of WAV in it;
  // starting one at the instant the current window ends puts all of that
  // in the middle of the audio, which is what a linear play heard as a
  // hole at exactly `windowSecs`.

  /** Forget anything fetched ahead: it is a render of an edit that may no
   *  longer be the one playing. The render itself cannot be cancelled —
   *  it lands on a slot nobody is holding any more and is dropped. */
  private dropAhead(): void {
    this.ahead = null;
  }

  /** The window `ranOut` (or a wrap) will ask for next, or null when this
   *  window is the last thing playback will play. Mirrors the choices
   *  `begin` makes, so what is fetched is what will be asked for. */
  private nextWindow(w: PlayWindow): Range | null {
    const duration = this.host.duration();
    const range = this.loopRange;
    if (range) {
      const lo = Math.max(0, range.start);
      const hi = Math.min(duration, range.end);
      // A range that fits one buffer never chains: it wraps inside the
      // source that holds it.
      if (hi - lo <= this.windowSecs) return null;
      const from = w.end < hi - 0.01 ? w.end : lo;
      return { start: from, end: Math.min(hi, from + this.windowSecs) };
    }
    if (w.end >= duration - 0.01) return null;
    return { start: w.end, end: Math.min(duration, w.end + this.windowSecs) };
  }

  /** Playback has got to `at`: fetch the next window if the boundary is
   *  close enough that a render started now would land before it. */
  private maybePrefetch(at: number): void {
    const w = this.win;
    // A source that wraps itself never reaches a boundary to chain over.
    if (this.disposed || !this.playingNow || !w || w.loop) return;
    // Outside the window means it is not the one this position belongs to
    // (a wrap has just swapped it): its boundary is a window away.
    if (at < w.start || at > w.end + EPS) return;
    if (at < w.end - this.prefetchSecs) return;
    const next = this.nextWindow(w);
    if (!next) return;
    if (this.ahead && this.sameSpan(this.ahead, next)) return;
    const entry: Ahead = {
      start: next.start,
      end: next.end,
      bytes: null,
      fetch: this.host.render(next.start, next.end - next.start),
    };
    this.ahead = entry;
    void entry.fetch.then((bytes) => {
      // Superseded (the edit changed, or playback went somewhere else):
      // the slot belongs to someone else now and these bytes are stale.
      if (this.ahead === entry) entry.bytes = bytes;
    });
  }

  /** The audio fetched ahead for exactly `[start, end)`, taken out of the
   *  slot. Bytes when the render has landed — the boundary then costs no
   *  await at all — or the render still in flight, which is at worst the
   *  wait the transport used to take every time. */
  private takeAhead(start: number, end: number): ArrayBuffer | Promise<ArrayBuffer | null> | null {
    const ahead = this.ahead;
    if (!ahead || !this.sameSpan(ahead, { start, end })) return null;
    this.ahead = null;
    return ahead.bytes ?? ahead.fetch;
  }

  private sameSpan(a: Range, b: Range): boolean {
    return Math.abs(a.start - b.start) < EPS && Math.abs(a.end - b.end) < EPS;
  }

  /** Play the window in hand from `within`, starting a source if none is
   *  live. Synchronous start to finish — no await, so nothing can
   *  supersede it midway and it may install without an epoch check.
   *  False when the window cannot be re-entered (nothing decoded, no
   *  element, no blob), and the caller renders instead. */
  private enter(within: number): boolean {
    const w = this.win;
    if (!w) return false;
    this.epoch++;
    this.cancelTone();
    const source = this.source;

    // A decoded buffer can be re-entered anywhere: start a node at the
    // new offset, after the old one is gone (invariant 1, one slot).
    // Whether the window belongs to the buffer is what decides the
    // backend here — never `this.el`, whose `src` is some OTHER window's
    // audio whenever the gapless path is the one holding this one.
    const prepared = this.prepared;
    if (prepared || source?.kind === 'loop') {
      if (!prepared) return false;
      this.release();
      const handle = prepared.start(within);
      handle.onEnd = this.onLoopEnd;
      if (!w.loop) handle.setLooping(false);
      this.install({ kind: 'loop', handle }, w, prepared);
      this.setPlayhead(Math.min(this.host.duration(), w.start + handle.position()));
      this.setPlaying(true);
      return true;
    }

    // The element still holds the blob it loaded for this window, so a
    // seek is a `currentTime` write and a resume is a `play()`.
    const el = source?.kind === 'element' ? source.el : this.el;
    if (!el || !el.src) return false;
    if (!source) this.install({ kind: 'element', el }, w);
    this.pendingSeek = within;
    this.applyPendingSeek(el);
    this.setPlayhead(Math.min(this.host.duration(), w.start + within));
    this.setPlaying(true);
    this.startElement(el);
    return true;
  }

  /** Start playing again inside the window already in hand, if it is one
   *  this range would have asked for. */
  private reenter(at: number, range: Range | null): boolean {
    const w = this.win;
    if (!w) return false;
    if (range) {
      // Outside the range, or a window the range would not have loaded
      // (it belongs to some other loop): render instead.
      if (at < range.start - EPS || at > range.end + EPS) return false;
      if (w.start < range.start - EPS || w.end > range.end + EPS) return false;
    }
    const within = this.withinLoaded(at);
    if (within === null || !this.enter(within)) return false;
    // Only a source holding EXACTLY the armed range may wrap itself; a
    // window inside a longer one runs out and chains (`ranOut`).
    const exact =
      range !== null && Math.abs(w.start - range.start) < EPS && Math.abs(w.end - range.end) < EPS;
    this.setNativeLoop(exact);
    return true;
  }

  /** Start the element, swallowing what a runtime with no output device
   *  (jsdom) or a superseded `src` throws. */
  private startElement(el: HTMLAudioElement): void {
    try {
      void el.play()?.catch?.(() => {});
    } catch {
      // The element still holds the rendered audio; it just cannot sound.
    }
  }

  // --- the one place a source is installed ----------------------------

  /** Fetch a window and take ownership of whatever plays it.
   *
   *  Everything after an `await` is guarded by the epoch this call started
   *  with: a newer command silently wins, and this call must leave no
   *  trace. Note that the previous source keeps playing until the moment
   *  the replacement is ready, so a re-render swaps rather than gaps.
   *
   *  `resumeAt`, where given, is asked AFTER the render for the absolute
   *  position to enter the window at — how a re-render lands where the
   *  audio that never stopped has actually got to. */
  private async begin(
    fromSecs: number,
    loopRange: Range | null,
    seekWithin: number,
    resumeAt?: () => number | null,
  ) {
    if (this.disposed) return;
    const epoch = ++this.epoch;
    this.cancelTone();

    const duration = this.host.duration();
    let start: number;
    let end: number;
    // Where in the loaded window playback starts. DERIVED here, never
    // taken on trust: it is the one number the media element cannot
    // survive being wrong about — a seek past the end of what it holds
    // makes it end on the spot, which chains straight into the next
    // window and reads as a playhead marching along in silence.
    let within: number;
    // A loop longer than one window (looping a whole track, say) cannot be
    // held in a single buffer: it plays as chained windows that wrap at
    // the range end instead, so `wholeLoop` decides which backend runs.
    let wholeLoop = false;
    if (loopRange) {
      const lo = Math.max(0, loopRange.start);
      const hi = Math.min(duration, loopRange.end);
      const at = Math.min(Math.max(fromSecs, lo), hi);
      if (hi - lo <= this.windowSecs) {
        // The whole range fits one buffer: load it and enter at its phase.
        start = lo;
        end = hi;
        wholeLoop = true;
        within = at - lo;
      } else {
        // Too long for one buffer: load the window `at` falls in and let
        // `onEnded` chain through the rest, wrapping at the range end.
        start = at >= hi - EPS ? lo : at;
        end = Math.min(hi, start + this.windowSecs);
        within = 0;
      }
    } else {
      // Play again from the top when the playhead sits at the end.
      start = fromSecs >= duration - 0.01 ? 0 : Math.max(0, fromSecs);
      end = Math.min(duration, start + this.windowSecs);
      within = 0;
    }
    if (end - start <= EPS) return;
    // An explicit phase (a tone re-render resuming in place) wins, but it
    // is clamped into the window like any other.
    if (seekWithin > 0) within = seekWithin;
    within = Math.max(0, Math.min(within, end - start - EPS));

    // Already in hand? Then nothing is awaited between here and the
    // source starting, and the boundary this call is answering costs no
    // silence at all.
    const ahead = this.takeAhead(start, end);
    const bytes =
      ahead instanceof ArrayBuffer ? ahead : await (ahead ?? this.host.render(start, end - start));
    if (this.stale(epoch) || !bytes) return;
    if (resumeAt) {
      // The old source has been playing all through the render: enter the
      // new window where it has ACTUALLY got to, not where it was when
      // the render was asked for.
      const live = resumeAt();
      if (live !== null) within = Math.max(0, Math.min(live - start, end - start - EPS));
    }

    if (loopRange && wholeLoop) {
      const prepare = this.host.prepareLoop ?? defaultPrepareLoop;
      const prepared = await prepare(bytes);
      // Nothing has sounded yet, so a stale call here simply drops the
      // decoded buffer — there is no node to orphan.
      if (this.stale(epoch)) return;
      if (prepared) {
        // Release BEFORE starting: the slot is empty for the few
        // microseconds in between, which is the only ordering in which
        // two sources are never live at the same instant.
        this.release();
        const handle = prepared.start(within);
        handle.onEnd = this.onLoopEnd;
        this.install({ kind: 'loop', handle }, { start, end, loop: true }, prepared);
        this.setPlayhead(Math.min(duration, start + handle.position()));
        this.setPlaying(true);
        return;
      }
      // No Web Audio here: fall back to the element's own looping.
    }

    const el = this.element();
    if (!el) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    this.release();
    this.install({ kind: 'element', el }, { start, end, loop: loopRange !== null && wholeLoop });
    this.revokeUrl();
    this.url = url;
    // The seek belongs to THIS window, so the transport holds it rather
    // than a one-shot listener on the element: a src replaced before the
    // metadata arrives would otherwise leave the offset behind to be
    // applied to the next window, which is a seek past its end.
    this.pendingSeek = within > EPS ? within : null;
    el.src = url;
    // Only let the element loop what it holds; a longer range wraps in
    // `onEnded`, which knows where the range actually ends.
    el.loop = loopRange !== null && wholeLoop;
    this.applyPendingSeek(el);
    this.setPlayhead(Math.min(duration, start + within));
    this.setPlaying(true);
    this.startElement(el);
  }

  /** Empty the slot: stop whatever was in it. The window is left alone —
   *  callers say what happens to it. */
  private release(): void {
    const prev = this.source;
    this.source = null;
    this.pendingSeek = null;
    this.stopTicker();
    if (!prev) return;
    if (prev.kind === 'loop') prev.handle.stop();
    else prev.el.pause();
  }

  /** Fill the empty slot. Only ever called straight after `release`. */
  private install(source: Source, win: PlayWindow, prepared: PreparedLoop | null = null): void {
    this.source = source;
    this.win = win;
    this.prepared = prepared;
    if (source.kind === 'loop') this.startTicker();
  }

  private stale(epoch: number): boolean {
    return this.disposed || epoch !== this.epoch;
  }

  // --- media element --------------------------------------------------

  private readonly onTime = () => {
    const source = this.source;
    const w = this.win;
    if (this.disposed || source?.kind !== 'element' || !w) return;
    this.advanceTo(Math.min(this.host.duration(), w.start + source.el.currentTime));
  };

  private readonly onMeta = () => {
    if (this.disposed || this.source?.kind !== 'element') return;
    this.applyPendingSeek(this.source.el);
  };

  /** Put the element at the offset THIS window was loaded for. Tried as
   *  soon as the src is set (some runtimes are ready at once) and again on
   *  `loadedmetadata`, because a seek before the duration is known is
   *  silently dropped. */
  private applyPendingSeek(el: HTMLAudioElement): void {
    const at = this.pendingSeek;
    if (at === null) return;
    try {
      el.currentTime = at;
    } catch {
      // Not seekable yet; `loadedmetadata` will come back for it.
    }
  }

  private readonly onEnded = () => {
    if (this.source?.kind === 'element') this.ranOut();
  };

  /** A gapless buffer that was un-looped mid-pass (the selection moved on
   *  from what it holds) has played itself out. */
  private readonly onLoopEnd = () => {
    if (this.source?.kind === 'loop') this.ranOut();
  };

  /** The loaded window has been played to its end. What comes next is
   *  decided by the range armed NOW, not the one the window was fetched
   *  for — the selection may have moved since. */
  private ranOut(): void {
    const w = this.win;
    if (this.disposed || !w) return;
    const duration = this.host.duration();
    const range = this.loopRange;
    if (range) {
      // More of the range past this window? Chain into it; otherwise the
      // pass is over and the loop starts again at its head.
      const more = w.end < range.end - 0.01;
      void this.begin(more ? w.end : range.start, range, 0);
      return;
    }
    if (w.end < duration - 0.01) {
      // Chain the next window of a long clip.
      void this.begin(w.end, null, 0);
      return;
    }
    this.release();
    this.setPlaying(false);
    this.setPlayhead(duration);
  }

  /** The element to drive, with this transport's listeners on it. The
   *  editor only renders one once a track is open, so it is looked up
   *  when needed rather than handed over once. */
  private element(): HTMLAudioElement | null {
    const el = this.host.element();
    if (this.disposed || el === this.el) return this.el;
    this.detach();
    if (el) {
      el.addEventListener('timeupdate', this.onTime);
      el.addEventListener('loadedmetadata', this.onMeta);
      el.addEventListener('ended', this.onEnded);
      this.el = el;
    }
    return el;
  }

  private detach(): void {
    const el = this.el;
    if (!el) return;
    el.removeEventListener('timeupdate', this.onTime);
    el.removeEventListener('loadedmetadata', this.onMeta);
    el.removeEventListener('ended', this.onEnded);
    this.el = null;
  }

  private revokeUrl(): void {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }

  // --- playhead -------------------------------------------------------

  /** Seconds into the loaded window, from whichever backend owns it. */
  private within(): number | null {
    const source = this.source;
    if (!source) return null;
    return source.kind === 'loop' ? source.handle.position() : source.el.currentTime;
  }

  private startTicker(): void {
    if (this.ticker !== null) return;
    this.ticker = setInterval(() => {
      if (this.source?.kind !== 'loop') {
        this.stopTicker();
        return;
      }
      const at = this.position();
      if (at !== null) this.advanceTo(at);
    }, this.tickMs);
  }

  private stopTicker(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
  }

  private cancelTone(): void {
    if (this.toneTimer !== null) clearTimeout(this.toneTimer);
    this.toneTimer = null;
  }

  private setPlaying(playing: boolean): void {
    if (this.playingNow === playing) return;
    this.playingNow = playing;
    this.notify();
  }

  /** Move the playhead. A COMMAND'S move, which never wraps: see below. */
  private setPlayhead(at: number): void {
    if (this.playheadNow === at) return;
    this.playheadNow = at;
    this.notify();
  }

  /** Playback got somewhere BY ITSELF — the only kind of move that can
   *  cross the loop's right-hand edge and wrap. A command that puts the
   *  playhead somewhere (a seek, a pause parking it where playback got
   *  to, a new window starting) is not playback arriving at the edge, and
   *  treating it as one is how pausing near the end of a loop started the
   *  loop again a moment after the button said "paused". */
  private advanceTo(at: number): void {
    const from = this.playheadNow;
    this.setPlayhead(at);
    this.wrapAt(from, at);
    this.maybePrefetch(at);
  }

  /** Loop by CROSSING the right-hand edge, not by jumping to the left one.
   *  A range armed while playback is before it is simply played into; the
   *  first time playback reaches its end, it goes back to its start. A
   *  range that ends behind the playhead is never crossed, so nothing is
   *  yanked backwards — playback keeps going and meets the loop when it
   *  comes round. */
  private wrapAt(from: number, to: number): void {
    const range = this.loopRange;
    if (!range || !this.playingNow || this.wrapping) return;
    const edge = range.end;
    if (!(from < edge - EPS && to >= edge - EPS)) return;
    this.wrapping = true;
    this.setPlayhead(range.start);
    this.wrapping = false;
    void this.begin(range.start, range, 0);
  }

  private notify(): void {
    if (this.disposed) return;
    this.host.onStatus({ playing: this.playingNow, playhead: this.playheadNow });
  }
}
