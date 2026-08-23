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
}

/** The one thing that may be making sound. */
type Source = { kind: 'loop'; handle: LoopHandle } | { kind: 'element'; el: HTMLAudioElement };

const EPS = 1e-3;

export class ClipTransport {
  private readonly host: TransportHost;
  private readonly windowSecs: number;
  private readonly tickMs: number;
  private readonly toneDelayMs: number;

  /** Bumped by every command. Async work started under an older epoch has
   *  been superseded and must not touch anything. */
  private epoch = 0;
  private disposed = false;

  private source: Source | null = null;
  private win: PlayWindow | null = null;
  /** The range the transport has been asked to loop, if any. */
  private loopRange: Range | null = null;
  private playingNow = false;
  private playheadNow = 0;

  private el: HTMLAudioElement | null = null;
  private url: string | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private toneTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: TransportHost, opts: TransportOptions = {}) {
    this.host = host;
    this.windowSecs = opts.windowSecs ?? 60;
    this.tickMs = opts.tickMs ?? 50;
    this.toneDelayMs = opts.toneDelayMs ?? 350;
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
    this.loopRange = loopRange;
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
      this.win = null;
      this.setPlayhead(at);
      return;
    }
    this.setPlayhead(at);
    const range = this.loopRange;
    if (range && at >= range.start && at <= range.end) {
      // Inside the loop: jump to that phase and keep looping.
      void this.begin(range.start, range, at - range.start);
    } else {
      // Outside it: play on from there. The view owns whether a loop is
      // still armed and tells us through `setLoop` if it is.
      void this.begin(at, null, 0);
    }
  }

  /** Stop, keeping the playhead where playback got to. */
  pause(): void {
    if (this.disposed) return;
    this.epoch++;
    this.cancelTone();
    const at = this.position();
    this.release();
    if (at !== null) this.setPlayhead(at);
    this.setPlaying(false);
  }

  /** Stop and park the playhead at `parkAt`, dropping the loaded window. */
  stop(parkAt = 0): void {
    if (this.disposed) return;
    this.epoch++;
    this.cancelTone();
    this.release();
    this.win = null;
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
    this.win = null;
    if (at !== null) this.setPlayhead(at);
    this.setPlaying(false);
  }

  /** The loop range changed (selection moved, Loop toggled). Re-fetches
   *  while playing so the change is heard at once; otherwise just
   *  remembers it for the next `play`. */
  setLoop(range: Range | null): void {
    if (this.disposed) return;
    this.loopRange = range;
    const w = this.win;
    if (!this.playingNow || !w) return;
    if (range) {
      const end = Math.min(range.end, range.start + this.windowSecs);
      const same = w.loop && Math.abs(w.start - range.start) < EPS && Math.abs(w.end - end) < EPS;
      if (same) return;
      // Arming a loop around where playback already is (looping the whole
      // clip, say) carries on from there rather than rewinding to the head.
      const at = this.position();
      const inside = at !== null && at > range.start + EPS && at < range.end - EPS;
      void this.begin(inside ? at : range.start, range, 0);
    } else if (w.loop) {
      // The loop is gone: carry on linearly from where it had got to.
      void this.begin(this.position() ?? w.start, null, 0);
    }
  }

  /** A TONE-ONLY edit (EQ, level) landed: the timeline still means what it
   *  meant, so re-render the playing window in place instead of stopping.
   *  Debounced — a knob drag streams edits and each re-render is a whole
   *  window of DSP. */
  refreshTone(): void {
    if (this.disposed || !this.playingNow) return;
    this.cancelTone();
    this.toneTimer = setTimeout(() => {
      this.toneTimer = null;
      const w = this.win;
      if (this.disposed || !this.playingNow || !w) return;
      if (w.loop) {
        // Resume at the same phase, so the audition keeps its place while
        // the tone changes underneath it.
        const phase = Math.max(0, (this.position() ?? w.start) - w.start);
        void this.begin(w.start, this.loopRange ?? { start: w.start, end: w.end }, phase);
      } else {
        void this.begin(this.position() ?? w.start, null, 0);
      }
    }, this.toneDelayMs);
  }

  /** Stop everything and refuse all further commands. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.epoch++;
    this.disposed = true;
    this.cancelTone();
    this.release();
    this.win = null;
    this.detach();
    this.revokeUrl();
    this.playingNow = false;
  }

  // --- the one place a source is installed ----------------------------

  /** Fetch a window and take ownership of whatever plays it.
   *
   *  Everything after an `await` is guarded by the epoch this call started
   *  with: a newer command silently wins, and this call must leave no
   *  trace. Note that the previous source keeps playing until the moment
   *  the replacement is ready, so a re-render swaps rather than gaps. */
  private async begin(fromSecs: number, loopRange: Range | null, seekWithin: number) {
    if (this.disposed) return;
    const epoch = ++this.epoch;
    this.cancelTone();

    const duration = this.host.duration();
    let start: number;
    let end: number;
    // A loop longer than one window (looping a whole track, say) cannot be
    // held in a single buffer: it plays as chained windows that wrap at
    // the range end instead, so `wholeLoop` decides which backend runs.
    let wholeLoop = false;
    if (loopRange) {
      const lo = Math.max(0, loopRange.start);
      const hi = Math.min(duration, loopRange.end);
      // A range that fits always loads from its head, so `seekWithin`
      // carries the loop's phase; a longer one loads the window that
      // `fromSecs` falls in, which is how a chain walks through it.
      const inside = fromSecs > lo + EPS && fromSecs < hi - EPS;
      start = hi - lo <= this.windowSecs || !inside ? lo : fromSecs;
      end = Math.min(hi, start + this.windowSecs);
      wholeLoop = start <= lo + EPS && end >= hi - EPS;
    } else {
      // Play again from the top when the playhead sits at the end.
      start = fromSecs >= duration - 0.01 ? 0 : Math.max(0, fromSecs);
      end = Math.min(duration, start + this.windowSecs);
    }
    if (end - start <= EPS) return;

    const bytes = await this.host.render(start, end - start);
    if (this.stale(epoch) || !bytes) return;

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
        const handle = prepared.start(Math.max(0, seekWithin));
        this.install({ kind: 'loop', handle }, { start, end, loop: true });
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
    this.install({ kind: 'element', el }, { start, end, loop: loopRange !== null });
    this.revokeUrl();
    this.url = url;
    el.src = url;
    // Only let the element loop what it holds; a longer range wraps in
    // `onEnded`, which knows where the range actually ends.
    el.loop = loopRange !== null && wholeLoop;
    if (seekWithin > 0) seekElement(el, seekWithin);
    this.setPlayhead(Math.min(duration, start + seekWithin));
    this.setPlaying(true);
    try {
      await el.play();
    } catch {
      // jsdom (and a webview with no output device) cannot play; the
      // element still holds the rendered audio. A newer command may also
      // have replaced the src, which aborts this play.
    }
  }

  /** Empty the slot: stop whatever was in it. The window is left alone —
   *  callers say what happens to it. */
  private release(): void {
    const prev = this.source;
    this.source = null;
    this.stopTicker();
    if (!prev) return;
    if (prev.kind === 'loop') prev.handle.stop();
    else prev.el.pause();
  }

  /** Fill the empty slot. Only ever called straight after `release`. */
  private install(source: Source, win: PlayWindow): void {
    this.source = source;
    this.win = win;
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
    this.setPlayhead(Math.min(this.host.duration(), w.start + source.el.currentTime));
  };

  private readonly onEnded = () => {
    const w = this.win;
    if (this.disposed || this.source?.kind !== 'element' || !w) return;
    const duration = this.host.duration();
    const range = w.loop ? this.loopRange : null;
    if (range) {
      // A loop too long for one window: chain through it, then wrap.
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
  };

  /** The element to drive, with this transport's listeners on it. The
   *  editor only renders one once a track is open, so it is looked up
   *  when needed rather than handed over once. */
  private element(): HTMLAudioElement | null {
    const el = this.host.element();
    if (this.disposed || el === this.el) return this.el;
    this.detach();
    if (el) {
      el.addEventListener('timeupdate', this.onTime);
      el.addEventListener('ended', this.onEnded);
      this.el = el;
    }
    return el;
  }

  private detach(): void {
    const el = this.el;
    if (!el) return;
    el.removeEventListener('timeupdate', this.onTime);
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
      if (at !== null) this.setPlayhead(at);
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

  private setPlayhead(at: number): void {
    if (this.playheadNow === at) return;
    this.playheadNow = at;
    this.notify();
  }

  private notify(): void {
    if (this.disposed) return;
    this.host.onStatus({ playing: this.playingNow, playhead: this.playheadNow });
  }
}

function seekElement(el: HTMLAudioElement, to: number): void {
  // Seeking only sticks once the duration is known, so try now (for
  // runtimes that are ready immediately) and again on metadata.
  const seek = () => {
    try {
      el.currentTime = to;
    } catch {
      // Not seekable yet.
    }
  };
  el.addEventListener('loadedmetadata', seek, { once: true });
  seek();
}
