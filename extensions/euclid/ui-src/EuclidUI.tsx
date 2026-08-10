// Custom UI for the Euclidean sequencer: four pattern rings, each drawing
// its E(fill, steps) onset pattern (rotated by rot) as dots on a circle.
// Purely a state display — the steps/fill/rot knobs below stay the
// controls; the rings re-render as their values change via the handle.

import { useEffect, useState } from "react";

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
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

export default function EuclidUI({ handle }: { handle: ModuleHandle }) {
  const [rings, setRings] = useState<Ring[]>(() => readRings(handle));

  useEffect(() => {
    const next = readRings(handle);
    setRings((prev) => (same(prev, next) ? prev : next));
  }, [handle]);

  return (
    <div className="euclid-ui" data-testid="euclid-ui">
      {rings.map((ring, c) => {
        const base = euclid(ring.steps, ring.fill);
        const pattern = base.map((_, i) => base[(i + ring.rot) % ring.steps]);
        const cx = BOX / 2;
        const cy = BOX / 2;
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
              return (
                <circle
                  key={i}
                  cx={cx + R * Math.cos(a)}
                  cy={cy + R * Math.sin(a)}
                  r={on ? 3.2 : 1.4}
                  className={on ? "euclid-dot on" : "euclid-dot"}
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
