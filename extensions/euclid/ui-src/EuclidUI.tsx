// Custom UI for the Euclidean sequencer: four pattern rings, each drawing
// its E(fill, steps) onset pattern (rotated by rot) as dots on a circle,
// with the currently-playing step lit hot (bright halo) from the module's
// step1..step4 outputs via the batched telemetry tap. The steps/fill/rot
// knobs below stay the controls; the rings re-render as their values (and
// the playhead) change via the handle.
//
// Ring playheads are EXTRAPOLATED between polls (useStepFollowers, one
// forward cycle per ring): the 100 ms poll aliases against clock rates
// past a few Hz — see extensions/ui-lib/stepFollower.ts.

import { useEffect, useRef, useState } from "react";
import { forwardCycle } from "../../ui-lib/stepFollower";
import { useStepFollowers } from "../../ui-lib/useStepFollower";

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
  signalTap?(jackId: string): { instantaneous: number };
}

const CHANNELS = 4;
const MAX_STEPS = 32;
const R = 24; // ring radius
const BOX = 58; // per-ring viewport

/** Bjorklund pattern, canonical rotation (first slot is an onset) —
 *  mirrors the DSP's bjorklund() + rotate-to-first-onset. */
function euclid(steps: number, pulses: number): boolean[] {
  const out = new Array<boolean>(steps).fill(false);
  if (steps === 0 || pulses === 0) return out;
  if (pulses >= steps) return out.fill(true);
  // Bresenham-style construction gives the same onset sets as Bjorklund
  // up to rotation; we canonicalize identically (start on an onset).
  let acc = 0;
  for (let i = 0; i < steps; i++) {
    acc += pulses;
    if (acc >= steps) {
      acc -= steps;
      out[i] = true;
    }
  }
  const first = out.indexOf(true);
  return out.map((_, i) => out[(i + first) % steps]);
}

interface Ring {
  steps: number;
  fill: number;
  rot: number;
}

const readRings = (handle: ModuleHandle): Ring[] =>
  Array.from({ length: CHANNELS }, (_, c) => ({
    steps: Math.min(
      MAX_STEPS,
      Math.max(1, Math.round(handle.paramValue(`steps${c + 1}`))),
    ),
    fill: Math.max(0, Math.round(handle.paramValue(`fill${c + 1}`))),
    rot: Math.max(0, Math.round(handle.paramValue(`rot${c + 1}`))),
  }));

const same = (a: Ring[], b: Ring[]) =>
  a.every(
    (r, i) =>
      r.steps === b[i].steps && r.fill === b[i].fill && r.rot === b[i].rot,
  );

/** Move each ring's halo by direct DOM mutation — must mirror the dot
 *  markup below (playing dots swell to r 4.6, on dots 3.2, rests 1.4). */
function applyPlayheads(root: HTMLDivElement, values: (number | null)[]) {
  const svgs = root.querySelectorAll("svg");
  values.forEach((step, c) => {
    const dots = svgs[c]?.querySelectorAll(".euclid-dot") ?? [];
    dots.forEach((dot, i) => {
      const playing = step === i;
      dot.classList.toggle("playing", playing);
      if (playing) dot.setAttribute("data-playing", "true");
      else dot.removeAttribute("data-playing");
      const on = dot.classList.contains("on");
      dot.setAttribute("r", playing ? "4.6" : on ? "3.2" : "1.4");
    });
  });
}

export default function EuclidUI({ handle }: { handle: ModuleHandle }) {
  const [rings, setRings] = useState<Ring[]>(() => readRings(handle));

  // No dep array: wired inputs read live telemetry through the handle,
  // and telemetry ticks re-render without changing the handle's identity.
  useEffect(() => {
    const next = readRings(handle);
    setRings((prev) => (same(prev, next) ? prev : next));
  });

  // Live playheads from the module's stepN outputs (-1 = not running).
  // `instantaneous`, not `display`: the smoothed display sweeps through
  // phantom steps on the wrap back to step 1.
  const rootRef = useRef<HTMLDivElement>(null);
  const currents = useStepFollowers(
    rings.map((ring, c) => {
      const raw = handle.signalTap?.(`out:step${c + 1}`)?.instantaneous ?? -1;
      return {
        cycle: forwardCycle(ring.steps),
        sampled: raw >= 0 ? Math.round(raw) % ring.steps : null,
      };
    }),
    rootRef,
    applyPlayheads,
  );

  return (
    <div className="euclid-ui" data-testid="euclid-ui" ref={rootRef}>
      {rings.map((ring, c) => {
        const base = euclid(ring.steps, ring.fill);
        const pattern = base.map((_, i) => base[(i + ring.rot) % ring.steps]);
        const cx = BOX / 2;
        const cy = BOX / 2;
        const current = currents[c];
        return (
          <svg
            key={c}
            width={BOX}
            height={BOX}
            viewBox={`0 0 ${BOX} ${BOX}`}
            className="euclid-ring"
            data-testid={`euclid-ring-${c + 1}`}
            role="img"
            aria-label={`ring ${c + 1}: ${ring.fill} of ${ring.steps}`}
          >
            <circle cx={cx} cy={cy} r={R} className="euclid-circle" />
            {pattern.map((on, i) => {
              const a = (i / ring.steps) * 2 * Math.PI - Math.PI / 2;
              const playing = current === i;
              return (
                <circle
                  key={i}
                  cx={cx + R * Math.cos(a)}
                  cy={cy + R * Math.sin(a)}
                  r={playing ? 4.6 : on ? 3.2 : 1.4}
                  data-playing={playing || undefined}
                  className={`euclid-dot${on ? " on" : ""}${playing ? " playing" : ""}`}
                />
              );
            })}
            <text
              x={cx}
              y={cy + 3}
              className="euclid-count"
              textAnchor="middle"
            >
              {ring.fill}/{ring.steps}
            </text>
          </svg>
        );
      })}
    </div>
  );
}
