// Custom React UI for the ADSR extension (PRD §5.3, M0): an interactive
// envelope display where the attack / decay / sustain / release segments
// can be dragged directly, with a live playhead showing where the running
// envelope currently sits on that curve.
//
// The display box is fixed-size: the time axis rescales to fit the current
// envelope (dragging captures the scale at pointer-down so drags stay
// linear). Param edits made elsewhere (the panel's generated knobs, patch
// load, a wire) flow back in through the handle and re-render the curve.
//
// ## Playhead
//
// The dot (plus the traversed-so-far trail) is EXTRAPOLATED client-side by
// replaying the module's own stage machine — the same code shape as
// src/lib.rs — from the observed gate, at rAF rate. It has to be: the only
// window onto the engine is the 100 ms tap_all poll, and envelope segments
// are routinely milliseconds long, so point-sampling the `env` output would
// show a dot that teleports (see extensions/ui-lib/stepFollower.ts for the
// same argument about sequencer playheads). The gate observation holds
// between polls, dt integration runs on the rAF clock, and the DOM is
// patched directly — never React state per frame (app/tests/
// RenderCounts.test.tsx discipline).
//
// Honesty rules, in the spirit of the step follower:
//   - the engine's `env` tap is the ground truth for RE-LOCKING: a gate
//     pulse that opened and closed entirely between two polls is invisible
//     to us, so whenever the local replay and the tapped level disagree
//     about whether anything is happening at all, the tap wins.
//   - when the tap reports the envelope is fluctuating faster than the
//     display bandwidth (`is_fast` — retriggering above ~10 Hz), no
//     observation can pin the phase; the playhead says so by going
//     "uncertain" (dimmed) instead of inventing a position.
//
// This file is bundled to ../ui.js (esm, react external) by the app build.
// Drag math uses deltas from the pointer-down position, so it works both in
// a real browser and under jsdom (which reports zero-size bounding boxes).

import { useCallback, useEffect, useRef, useState } from "react";

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
  setParam(id: string, v: number): void;
  signalTap?(jackId: string): {
    instantaneous: number;
    display: number;
    is_fast: boolean;
  };
  endEdit?(): void;
}

const W = 360;
const H = 150;
const PAD = 12;
const SUSTAIN_W = 60; // fixed visual width of the sustain plateau

const MAX_ATTACK = 5;
const MAX_DECAY = 5;
const MAX_RELEASE = 10;
const MIN_TIME = 0.001;

/** Full-scale envelope output, Volts (ENV_MAX in src/lib.rs). */
const ENV_MAX = 10;
/** Level below which the envelope counts as silent, for re-locking. */
const SILENT_V = 0.05;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

interface Env {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

type Segment = "attack" | "decay" | "sustain" | "release";

const readEnv = (handle: ModuleHandle): Env => ({
  attack: handle.paramValue("attack"),
  decay: handle.paramValue("decay"),
  sustain: handle.paramValue("sustain"),
  release: handle.paramValue("release"),
});

const sameEnv = (a: Env, b: Env) =>
  a.attack === b.attack &&
  a.decay === b.decay &&
  a.sustain === b.sustain &&
  a.release === b.release;

/** Pixels per second so the whole envelope always fits the fixed box. */
const pxPerSec = (env: Env) =>
  (W - 2 * PAD - SUSTAIN_W) /
  Math.max(0.05, env.attack + env.decay + env.release);

export type Stage = "idle" | "attack" | "decay" | "sustain" | "release";

/** Local replay of the module's envelope state (mirrors src/lib.rs). */
export interface EnvState {
  stage: Stage;
  /** Current output level, 0..ENV_MAX Volts. */
  level: number;
  /** Level the current release started from (its ramp rate is fixed then). */
  releaseFrom: number;
  /** Seconds held in sustain, for the plateau's playhead position. */
  sustainSecs: number;
  /** Where the envelope was when the gate fell — the release limb starts
   *  from that point, which is off the drawn curve for an early release. */
  releasedAt?: { stage: Stage; level: number; sustainSecs: number };
}

export const idleState = (): EnvState => ({
  stage: "idle",
  level: 0,
  releaseFrom: 0,
  sustainSecs: 0,
});

/** Advance the replayed envelope by `dt` seconds. Segment rates and the
 *  transition conditions mirror src/lib.rs exactly, in seconds rather than
 *  samples; the loop consumes `dt` across stage boundaries so a 1 ms attack
 *  is not stretched to a whole frame. Exported for tests. */
export function stepEnvelope(state: EnvState, env: Env, dt: number): EnvState {
  const next = { ...state };
  const target = ENV_MAX * clamp(env.sustain, 0, 1);
  let left = Math.max(0, dt);
  // Bounded: each iteration either consumes all remaining time or leaves a
  // stage, and the stage chain idle<-release / attack->decay->sustain is
  // short.
  for (let guard = 0; left > 1e-9 && guard < 8; guard++) {
    switch (next.stage) {
      case "attack": {
        const rate = ENV_MAX / Math.max(env.attack, MIN_TIME);
        const need = (ENV_MAX - next.level) / rate;
        if (need > left) {
          next.level += rate * left;
          left = 0;
        } else {
          next.level = ENV_MAX;
          next.stage = "decay";
          left -= Math.max(0, need);
        }
        break;
      }
      case "decay": {
        const rate = (ENV_MAX - target) / Math.max(env.decay, MIN_TIME);
        const need = rate > 0 ? (next.level - target) / rate : 0;
        if (rate > 0 && need > left) {
          next.level -= rate * left;
          left = 0;
        } else {
          next.level = target;
          next.stage = "sustain";
          next.sustainSecs = 0;
          left -= Math.max(0, need);
        }
        break;
      }
      case "sustain": {
        next.level = target;
        next.sustainSecs += left;
        left = 0;
        break;
      }
      case "release": {
        const rate = next.releaseFrom / Math.max(env.release, MIN_TIME);
        const need = rate > 0 ? next.level / rate : 0;
        if (rate > 0 && need > left) {
          next.level -= rate * left;
          left = 0;
        } else {
          next.level = 0;
          next.stage = "idle";
          left -= Math.max(0, need);
        }
        break;
      }
      default:
        left = 0;
    }
  }
  return next;
}

/** Gate-on / gate-off / retrig edges, as src/lib.rs sees them: a rising
 *  gate (or a retrig while the gate is held) restarts the attack from the
 *  CURRENT level, a falling gate releases from it. */
export function applyGate(
  state: EnvState,
  gateHigh: boolean,
  retrig: boolean,
): EnvState {
  const attack: EnvState = {
    ...state,
    stage: "attack",
    sustainSecs: 0,
    releasedAt: undefined,
  };
  if (
    gateHigh &&
    (retrig || state.stage === "idle" || state.stage === "release")
  ) {
    return attack;
  }
  if (!gateHigh && state.stage !== "idle" && state.stage !== "release") {
    return {
      ...state,
      stage: "release",
      releaseFrom: state.level,
      releasedAt: {
        stage: state.stage,
        level: state.level,
        sustainSecs: state.sustainSecs,
      },
    };
  }
  return state;
}

/** Re-lock the replay to the engine's `env` tap when the two disagree about
 *  whether the envelope is running: a gate pulse shorter than the poll
 *  period is invisible to us, and so is a patch loaded mid-note. Level
 *  differences inside a running envelope are NOT corrected — the tapped
 *  sample is up to a poll old, so chasing it would jitter the dot. */
export function relock(
  state: EnvState,
  env: Env,
  gateHigh: boolean,
  tapped: number,
): EnvState {
  const target = ENV_MAX * clamp(env.sustain, 0, 1);
  if (state.stage === "idle" && tapped > SILENT_V) {
    if (!gateHigh) {
      return {
        stage: "release",
        level: tapped,
        releaseFrom: tapped,
        sustainSecs: 0,
      };
    }
    const stage: Stage =
      tapped < target - SILENT_V
        ? "attack"
        : tapped > target + SILENT_V
          ? "decay"
          : "sustain";
    return { stage, level: tapped, releaseFrom: tapped, sustainSecs: 0 };
  }
  if (state.stage !== "idle" && !gateHigh && tapped <= SILENT_V) {
    return idleState();
  }
  return state;
}

interface Geometry {
  scale: number;
  x0: number;
  xA: number;
  xD: number;
  xS: number;
  xR: number;
  floorY: number;
  peakY: number;
  sustainY: number;
}

function geometryOf(env: Env): Geometry {
  const scale = pxPerSec(env);
  const x0 = PAD;
  const xA = x0 + env.attack * scale;
  const xD = xA + env.decay * scale;
  const xS = xD + SUSTAIN_W;
  return {
    scale,
    x0,
    xA,
    xD,
    xS,
    xR: xS + env.release * scale,
    floorY: H - PAD,
    peakY: PAD,
    sustainY: PAD + (1 - env.sustain) * (H - 2 * PAD),
  };
}

export interface Playhead {
  x: number;
  y: number;
  /** The curve from its start up to the dot — the part already played. */
  trail: string;
  label: string;
}

const yOf = (level: number) =>
  PAD + (1 - clamp(level / ENV_MAX, 0, 1)) * (H - 2 * PAD);

/** Position on the A/D/S limbs, plus the corner vertices already passed.
 *  Horizontal position comes from the LEVEL within the segment, not from
 *  elapsed time: the segments are linear so the two agree, and after a
 *  retrig (which restarts the attack from the current level, part-way up
 *  the limb) the level is the honest answer. The sustain plateau has no
 *  natural duration, so there the dot walks at the display's time scale
 *  and parks at the plateau's end. */
function limbAt(
  stage: Stage,
  level: number,
  sustainSecs: number,
  env: Env,
  geo: Geometry,
): { x: number; y: number; verts: Array<[number, number]> } {
  const target = ENV_MAX * clamp(env.sustain, 0, 1);
  const verts: Array<[number, number]> = [[geo.x0, geo.floorY]];
  let x = geo.x0;
  if (stage === "attack") {
    x = geo.x0 + clamp(level / ENV_MAX, 0, 1) * (geo.xA - geo.x0);
  } else if (stage === "decay") {
    const span = ENV_MAX - target;
    const frac = span > 0 ? (ENV_MAX - level) / span : 1;
    x = geo.xA + clamp(frac, 0, 1) * (geo.xD - geo.xA);
    verts.push([geo.xA, geo.peakY]);
  } else {
    x = Math.min(geo.xS, geo.xD + sustainSecs * geo.scale);
    verts.push([geo.xA, geo.peakY], [geo.xD, geo.sustainY]);
  }
  return { x, y: yOf(level), verts };
}

/** Where the dot sits, and the curve it has traversed to get there. */
export function playheadAt(
  state: EnvState,
  env: Env,
  geo: Geometry = geometryOf(env),
): Playhead | null {
  if (state.stage === "idle") return null;
  let x: number;
  let verts: Array<[number, number]>;
  if (state.stage === "release") {
    // The release limb starts wherever the gate fell — the plateau's end
    // for a held note, but part-way up the attack for a short one, which
    // is OFF the drawn curve. Its horizontal span is the release time at
    // the display's scale (xR - xS), so the dot slides parallel to the
    // drawn release limb from that point.
    const from = state.releasedAt ?? {
      stage: "sustain" as Stage,
      level: state.releaseFrom,
      sustainSecs: Infinity,
    };
    const origin = limbAt(from.stage, from.level, from.sustainSecs, env, geo);
    const span = Math.max(state.releaseFrom, 1e-6);
    const frac = clamp(1 - state.level / span, 0, 1);
    x = origin.x + frac * (geo.xR - geo.xS);
    verts = [...origin.verts, [origin.x, origin.y]];
  } else {
    const p = limbAt(state.stage, state.level, state.sustainSecs, env, geo);
    x = p.x;
    verts = p.verts;
  }
  const y = yOf(state.level);
  verts.push([x, y]);
  const trail = verts
    .map(
      ([vx, vy], i) =>
        `${i === 0 ? "M" : "L"} ${vx.toFixed(1)} ${vy.toFixed(1)}`,
    )
    .join(" ");
  return { x, y, trail, label: `${state.stage} ${state.level.toFixed(1)} V` };
}

/** Runs the local envelope replay and paints the playhead by direct DOM
 *  mutation on every frame (never React state — the panel must not
 *  re-render at frame rate). Observations arrive on the caller's renders,
 *  which the 100 ms telemetry poll drives. */
function usePlayhead(
  handle: ModuleHandle,
  env: Env,
  rootRef: { current: SVGSVGElement | null },
): { playhead: Playhead | null; uncertain: boolean } {
  const state = useRef<EnvState>(idleState());
  const lastFrame = useRef(performance.now());
  const envRef = useRef(env);
  envRef.current = env;
  const gate = handle.signalTap?.("gate");
  const retrig = handle.signalTap?.("retrig");
  const out = handle.signalTap?.("out:env");
  // Gates are discrete: `instantaneous` is the only honest field
  // (`display` is 100 ms smoothed, so a gate reads as a ramp).
  const gateHigh = (gate?.instantaneous ?? 0) >= 1;
  const retrigHigh = (retrig?.instantaneous ?? 0) >= 1;
  const tapped = out?.instantaneous ?? 0;
  // Faster than the display bandwidth: no sample can pin the phase, so
  // the replay is not trustworthy and the dot says so instead of lying.
  const uncertain = out?.is_fast ?? false;

  const obs = useRef({ gateHigh: false, retrigHigh: false });
  // Advance to now, then apply what this observation says. Ordering
  // matters: the previous gate state held until this poll saw otherwise.
  const now = performance.now();
  const dt = Math.max(0, (now - lastFrame.current) / 1000);
  lastFrame.current = now;
  let next = stepEnvelope(state.current, env, dt);
  next = applyGate(next, gateHigh, retrigHigh && !obs.current.retrigHigh);
  next = relock(next, env, gateHigh, tapped);
  obs.current = { gateHigh, retrigHigh };
  state.current = next;

  const shown = playheadAt(next, env);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const root = rootRef.current;
      if (!root) return;
      const t = performance.now();
      const step = Math.max(0, (t - lastFrame.current) / 1000);
      lastFrame.current = t;
      state.current = stepEnvelope(state.current, envRef.current, step);
      const p = playheadAt(state.current, envRef.current);
      const dot = root.querySelector<SVGCircleElement>(".adsr-playhead");
      const trail = root.querySelector<SVGPathElement>(".adsr-trail");
      if (!dot || !trail) return;
      dot.setAttribute("opacity", p ? "1" : "0");
      trail.setAttribute("opacity", p ? "1" : "0");
      if (!p) return;
      dot.setAttribute("cx", p.x.toFixed(1));
      dot.setAttribute("cy", p.y.toFixed(1));
      trail.setAttribute("d", p.trail);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Refs only — the loop reads everything through refs updated at render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    playhead: uncertain && shown ? { ...shown, label: "retriggering" } : shown,
    uncertain,
  };
}

export default function AdsrUI({ handle }: { handle: ModuleHandle }) {
  const [env, setEnv] = useState<Env>(() => readEnv(handle));
  const svgRef = useRef<SVGSVGElement>(null);
  const { playhead, uncertain } = usePlayhead(handle, env, svgRef);

  const drag = useRef<{
    segment: Segment;
    startX: number;
    startY: number;
    startEnv: Env;
    scale: number; // px per second, captured at pointer-down
  } | null>(null);

  // Sync from the engine (panel knobs, patch load, wires) unless mid-drag.
  // No dep array: wired inputs read live telemetry through the handle, and
  // telemetry ticks re-render without changing the handle's identity.
  useEffect(() => {
    if (drag.current) return;
    const next = readEnv(handle);
    setEnv((prev) => (sameEnv(prev, next) ? prev : next));
  });

  const apply = useCallback(
    (next: Env) => {
      setEnv((prev) => {
        for (const key of ["attack", "decay", "sustain", "release"] as const) {
          if (next[key] !== prev[key]) handle.setParam(key, next[key]);
        }
        return next;
      });
    },
    [handle],
  );

  const onMove = useCallback(
    (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = (e.clientX - d.startX) / d.scale;
      const dy = (e.clientY - d.startY) / (H - 2 * PAD);
      const next = { ...d.startEnv };
      switch (d.segment) {
        case "attack":
          next.attack = clamp(d.startEnv.attack + dx, MIN_TIME, MAX_ATTACK);
          break;
        case "decay":
          next.decay = clamp(d.startEnv.decay + dx, MIN_TIME, MAX_DECAY);
          break;
        case "sustain":
          next.sustain = clamp(d.startEnv.sustain - dy, 0, 1);
          break;
        case "release":
          next.release = clamp(d.startEnv.release + dx, MIN_TIME, MAX_RELEASE);
          break;
      }
      apply(next);
    },
    [apply],
  );

  const onUp = useCallback(() => {
    if (drag.current) {
      drag.current = null;
      handle.endEdit?.();
    }
  }, [handle]);

  useEffect(() => {
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onMove, onUp]);

  const startDrag = (segment: Segment) => (e: React.MouseEvent) => {
    e.preventDefault();
    drag.current = {
      segment,
      startX: e.clientX,
      startY: e.clientY,
      startEnv: env,
      scale: pxPerSec(env),
    };
  };

  // Geometry — always inside the fixed W x H box.
  const scale = pxPerSec(env);
  const floorY = H - PAD;
  const peakY = PAD;
  const sustainY = PAD + (1 - env.sustain) * (H - 2 * PAD);
  const x0 = PAD;
  const xA = x0 + env.attack * scale;
  const xD = xA + env.decay * scale;
  const xS = xD + SUSTAIN_W;
  const xR = xS + env.release * scale;

  const path = `M ${x0} ${floorY} L ${xA} ${peakY} L ${xD} ${sustainY} L ${xS} ${sustainY} L ${xR} ${floorY}`;

  const handleProps = (
    segment: Segment,
    cx: number,
    cy: number,
    testId: string,
  ) => ({
    cx,
    cy,
    r: 7,
    className: "adsr-handle",
    "data-testid": testId,
    onMouseDown: startDrag(segment),
    style: {
      cursor: segment === "sustain" ? "ns-resize" : "ew-resize",
    } as React.CSSProperties,
  });

  return (
    <div className="adsr-ui" data-testid="adsr-ui">
      <svg
        ref={svgRef}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="ADSR envelope"
      >
        <rect x={0} y={0} width={W} height={H} className="adsr-bg" />
        <path
          d={path}
          className="adsr-path"
          fill="none"
          data-testid="adsr-path"
        />
        {/* The traversed part of the curve, under the drag handles. */}
        <path
          d={playhead?.trail ?? ""}
          className="adsr-trail"
          fill="none"
          opacity={playhead ? 1 : 0}
          data-testid="adsr-trail"
        />
        <circle {...handleProps("attack", xA, peakY, "adsr-handle-attack")} />
        <circle {...handleProps("decay", xD, sustainY, "adsr-handle-decay")} />
        <circle
          {...handleProps(
            "sustain",
            (xD + xS) / 2,
            sustainY,
            "adsr-handle-sustain",
          )}
        />
        <circle
          {...handleProps("release", xR, floorY, "adsr-handle-release")}
        />
        {/* Playhead LAST so it stays visible over a drag handle it passes
            under. Rendered on every telemetry poll and moved between polls
            by the rAF loop in usePlayhead, which finds it by class. */}
        <circle
          cx={playhead?.x ?? 0}
          cy={playhead?.y ?? 0}
          r={5}
          className={`adsr-playhead${uncertain ? " adsr-playhead-uncertain" : ""}`}
          opacity={playhead ? 1 : 0}
          data-testid="adsr-playhead"
        />
      </svg>
      <div className="adsr-readout" data-testid="adsr-readout">
        A {env.attack.toFixed(3)}s · D {env.decay.toFixed(3)}s · S{" "}
        {env.sustain.toFixed(2)} · R {env.release.toFixed(3)}s
        <span className="adsr-stage" data-testid="adsr-stage">
          {playhead?.label ?? "idle"}
        </span>
      </div>
    </div>
  );
}
