// Custom React UI for the ADSR extension (PRD §5.3, M0): an interactive
// envelope display where the attack / decay / sustain / release segments
// can be dragged directly.
//
// The display box is fixed-size: the time axis rescales to fit the current
// envelope (dragging captures the scale at pointer-down so drags stay
// linear). Param edits made elsewhere (the panel's generated knobs, patch
// load, a wire) flow back in through the handle and re-render the curve.
//
// This file is bundled to ../ui.js (esm, react external) by the app build.
// Drag math uses deltas from the pointer-down position, so it works both in
// a real browser and under jsdom (which reports zero-size bounding boxes).

import { useCallback, useEffect, useRef, useState } from "react";

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
  setParam(id: string, v: number): void;
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

export default function AdsrUI({ handle }: { handle: ModuleHandle }) {
  const [env, setEnv] = useState<Env>(() => readEnv(handle));

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
      </svg>
      <div className="adsr-readout" data-testid="adsr-readout">
        A {env.attack.toFixed(3)}s · D {env.decay.toFixed(3)}s · S{" "}
        {env.sustain.toFixed(2)} · R {env.release.toFixed(3)}s
      </div>
    </div>
  );
}
