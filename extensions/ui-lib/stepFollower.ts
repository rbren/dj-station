// Anti-aliasing playhead follower for clock-driven step displays.
//
// ## The problem (and why every sequencer UI needs this)
//
// Sequencer playheads (step_seq lamps, trig_seq/grid_seq columns, euclid
// rings, seq_switch lamps, the choreo timeline) are DISCRETE positions
// driven by the audio clock, but the UI only sees them through the 100 ms
// tap_all/status poll — a ~10 Hz point-sampler. Sampling a 6–8 steps/s
// process at ~10 Hz is right at the Nyquist edge: steps display for one
// poll tick or two semi-randomly (a ~2 Hz beat against the poll), timer
// jitter and IPC latency make it worse, and past 10 steps/s steps are
// skipped outright. No poll rate fixes this class of problem — a poll
// only ever point-samples.
//
// ## The fix: extrapolate client-side
//
// The clocked position is *predictable*: between polls it advances at the
// clock rate through a known cycle. This follower turns sparse, jittery
// observations into a smooth prediction:
//
// - `observe` records (time, cumulative-advance) whenever the sampled
//   position CHANGES; the cycle spec maps raw positions to advance counts
//   (forward, reverse, ping-pong, wrapped counters).
// - The per-step interval is fitted over the whole event window —
//   (t_last − t_first) / (advances between) — NOT per-change deltas:
//   individual deltas are quantized to the poll period (a 125 ms step
//   sampled at 100 ms reads as 100,100,100,200 ms), but the windowed fit
//   converges on the true interval. That quantization is exactly the
//   aliasing being fixed, so the estimator must be immune to it.
// - Regularity check: every event must sit within ±1 step of the linear
//   fit. Poll quantization stays under a step of residual by
//   construction; genuinely irregular advancement (cv-addressed
//   switching, random direction) blows past it and disables
//   extrapolation — a wrong prediction is worse than the honest sampled
//   value.
// - `predict(now)` advances the cycle phase by whole elapsed intervals
//   since the last observed change (floor — the prediction trails the
//   true edge by up to one poll's sampling delay but never leads it, so
//   corrections land on step boundaries as timing nudges, never
//   backwards jumps).
//
// ## Honesty rules (when NOT to extrapolate)
//
// - Not enough events, or an irregular pattern: `predict` returns the
//   raw observation.
// - Stalled clock (no change for STALL_FACTOR × interval, floored at
//   STALL_MIN_MS): prediction freezes at the observed position and the
//   window resets, so a stopped sequencer shows its true step.
// - A position jump beyond half the cycle is a transport event (reset,
//   seek, direction flip): re-lock without polluting the rate window.
//
// The follower is deliberately framework-free (the caller supplies
// timestamps) so it unit-tests deterministically; the React binding
// lives in useStepFollower.ts.

/** How a position advances through its cycle: the follower predicts in
 *  "advance counts" and maps back through `at`. `length` is the cycle
 *  length in advances (after which positions repeat). */
export interface CycleSpec {
  /** Advances per full cycle (>= 1). */
  length: number;
  /** Position shown `k` advances after cycle phase 0. */
  at(k: number): number;
  /** Cycle phases (advance counts, 0..length-1) that display position
   *  `pos`; empty = position not in cycle (forces a re-lock). */
  phasesOf(pos: number): number[];
}

/** Forward counter 0,1,...,n-1,0 — trig/grid `pos mod len`, euclid,
 *  seq_switch clocked mode, choreo beats. */
export function forwardCycle(n: number): CycleSpec {
  const len = Math.max(1, Math.round(n));
  return {
    length: len,
    at: (k) => ((k % len) + len) % len,
    phasesOf: (pos) =>
      Number.isInteger(pos) && pos >= 0 && pos < len ? [pos] : [],
  };
}

/** Reverse counter n-1,...,1,0,n-1 — step_seq dir 1. */
export function reverseCycle(n: number): CycleSpec {
  const len = Math.max(1, Math.round(n));
  return {
    length: len,
    at: (k) => len - 1 - (((k % len) + len) % len),
    phasesOf: (pos) =>
      Number.isInteger(pos) && pos >= 0 && pos < len ? [len - 1 - pos] : [],
  };
}

/** Ping-pong 0,1,...,n-1,n-2,...,1 — step_seq dir 2. Interior positions
 *  occur at two phases; the follower picks whichever is nearest ahead. */
export function pingPongCycle(n: number): CycleSpec {
  const len = Math.max(1, Math.round(n));
  if (len <= 1) return forwardCycle(1);
  const period = 2 * len - 2;
  return {
    length: period,
    at: (k) => {
      const p = ((k % period) + period) % period;
      return p < len ? p : period - p;
    },
    phasesOf: (pos) => {
      if (!Number.isInteger(pos) || pos < 0 || pos >= len) return [];
      if (pos === 0) return [0];
      if (pos === len - 1) return [len - 1];
      return [pos, period - pos];
    },
  };
}

/** Monotonic counter with a wrap point (trig_seq/grid_seq `pos`, wrap
 *  720720): predict the raw counter, callers derive `pos mod len`. */
export function counterCycle(wrap: number): CycleSpec {
  return forwardCycle(wrap);
}

/** Change events needed before extrapolating (the fit needs a window). */
const MIN_EVENTS = 4;
const MAX_EVENTS = 10;
/** Max residual (in steps) of any event against the linear fit. Poll
 *  quantization contributes < 1 step by construction; irregular
 *  advancement (cv addressing, random direction) exceeds it. */
const RESIDUAL_TOL_STEPS = 1.0;
/** No observed change for this many intervals ⇒ the clock stopped. */
const STALL_FACTOR = 2.5;
/** Absolute stall floor, ms — poll jitter alone must never read as a
 *  stall at fast clock rates. */
const STALL_MIN_MS = 350;

interface ChangeEvent {
  t: number;
  /** Cumulative advances since the current lock. */
  cum: number;
}

export class StepFollower {
  private cycle: CycleSpec;
  /** Phase (advance count within the cycle) of the last observation. */
  private phase = 0;
  private lastPos: number | null = null;
  private events: ChangeEvent[] = [];

  constructor(cycle: CycleSpec) {
    this.cycle = cycle;
  }

  /** Swap the cycle shape (length/dir knob turned). A different shape
   *  voids the phase mapping and rate window; an identical one is a
   *  no-op so callers can pass a fresh spec every render. */
  setCycle(cycle: CycleSpec) {
    const sameShape =
      cycle.length === this.cycle.length &&
      cycle.at(0) === this.cycle.at(0) &&
      cycle.at(1) === this.cycle.at(1);
    this.cycle = cycle;
    if (!sameShape) this.relock();
  }

  private relock() {
    this.events = this.lastEvent() ? [{ t: this.lastEvent()!.t, cum: 0 }] : [];
    if (this.lastPos !== null) {
      this.phase = this.cycle.phasesOf(this.lastPos)[0] ?? 0;
    }
  }

  private lastEvent(): ChangeEvent | null {
    return this.events.length ? this.events[this.events.length - 1] : null;
  }

  /** Feed a raw sampled position (already decoded to a step/beat index;
   *  null or negative = "not running"). */
  observe(pos: number | null, now: number) {
    if (pos === null || pos < 0 || !Number.isFinite(pos)) {
      this.lastPos = null;
      this.events = [];
      return;
    }
    if (this.lastPos === null) {
      this.lastPos = pos;
      this.phase = this.cycle.phasesOf(pos)[0] ?? 0;
      this.events = [{ t: now, cum: 0 }];
      return;
    }
    if (pos === this.lastPos) return;

    const phases = this.cycle.phasesOf(pos);
    const last = this.lastEvent();
    if (phases.length === 0 || !last) {
      // Position outside the cycle (length knob mid-turn): hard re-lock.
      this.lastPos = pos;
      this.phase = this.cycle.phasesOf(pos)[0] ?? 0;
      this.events = [{ t: now, cum: 0 }];
      return;
    }
    // Advances to the nearest matching phase strictly ahead (1..length):
    // ping-pong interior positions pick the closest branch, everything
    // else has exactly one candidate.
    const len = this.cycle.length;
    let steps = Infinity;
    let nextPhase = phases[0];
    for (const ph of phases) {
      const d = (((ph - this.phase) % len) + len) % len || len;
      if (d < steps) {
        steps = d;
        nextPhase = ph;
      }
    }
    this.lastPos = pos;
    this.phase = nextPhase;
    if (steps > Math.max(1, len / 2)) {
      // A jump past half the cycle is a transport event (reset, seek,
      // direction change), not fast clocking: re-lock, drop the window.
      this.events = [{ t: now, cum: 0 }];
      return;
    }
    this.events.push({ t: now, cum: last.cum + steps });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  /** Per-step interval (ms) fitted over the event window when the recent
   *  history is regular enough to extrapolate from; null otherwise. */
  private stepInterval(): number | null {
    if (this.events.length < MIN_EVENTS) return null;
    const first = this.events[0];
    const last = this.events[this.events.length - 1];
    const span = last.t - first.t;
    const advances = last.cum - first.cum;
    if (span <= 0 || advances <= 0) return null;
    const interval = span / advances;
    for (const e of this.events) {
      const expected = (e.t - first.t) / interval;
      if (Math.abs(expected - (e.cum - first.cum)) > RESIDUAL_TOL_STEPS) {
        return null;
      }
    }
    return interval;
  }

  /** Best-known position at `now`: extrapolated when the clock is
   *  regular, otherwise the last raw observation (null = not running). */
  predict(now: number): number | null {
    if (this.lastPos === null) return null;
    const last = this.lastEvent();
    const interval = this.stepInterval();
    if (interval === null || !last) return this.lastPos;
    if (now - last.t > Math.max(STALL_FACTOR * interval, STALL_MIN_MS)) {
      // Clock stopped: show the true position and re-measure on restart
      // (keeping the stale rate would race ahead of a slowed clock).
      this.events = [{ t: last.t, cum: last.cum }];
      return this.lastPos;
    }
    const steps = Math.floor((now - last.t) / interval);
    return this.cycle.at(this.phase + Math.max(0, steps));
  }
}
