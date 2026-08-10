// Custom UI for the Waveshaper: draws the current transfer curve
// (output vs input over ±10 V) for the selected mode / drive / bias /
// level. Display-only — the knobs below are the controls; the curve
// re-renders as their values change via the handle.

import { useEffect, useState } from "react";

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
}

const W = 148;
const H = 84;
const PAD = 6;
const RAIL = 10;
const N = 96;

const MODES = ["fold", "saturate", "crush", "rate"] as const;

interface Shape {
  mode: number;
  drive: number;
  bias: number;
  level: number;
}

const readShape = (handle: ModuleHandle): Shape => ({
  mode: Math.min(3, Math.max(0, Math.round(handle.paramValue("mode")))),
  drive: handle.paramValue("drive"),
  bias: handle.paramValue("bias"),
  level: handle.paramValue("level"),
});

const same = (a: Shape, b: Shape) =>
  a.mode === b.mode &&
  a.drive === b.drive &&
  a.bias === b.bias &&
  a.level === b.level;

/** Static transfer approximation of the DSP modes (normalized ±1). */
function transfer(shape: Shape, x: number): number {
  const d = Math.max(0, shape.drive);
  let y: number;
  switch (shape.mode) {
    case 1: {
      // Saturate: tanh(d x), normalized so low drive is transparent.
      const g = Math.max(0.05, d);
      y = Math.tanh(g * x) / Math.tanh(g);
      break;
    }
    case 2: {
      // Crush: quantize to N bits, N sweeping 16 -> 1 with drive.
      const bits = Math.max(1, 16 - (d / 10) * 15);
      const q = 2 ** (bits - 1);
      y = Math.round(x * q) / q;
      break;
    }
    case 3:
      // Rate reduction is time-domain; show identity as the static curve.
      y = x;
      break;
    default: {
      // Fold: reflect off ±1 repeatedly, amount scales the input in.
      let v = x * (1 + d);
      for (let i = 0; i < 32 && (v > 1 || v < -1); i++) {
        v = v > 1 ? 2 - v : v < -1 ? -2 - v : v;
      }
      y = v;
    }
  }
  return Math.max(-1, Math.min(1, y * shape.level));
}

export default function WaveshaperUI({ handle }: { handle: ModuleHandle }) {
  const [shape, setShape] = useState<Shape>(() => readShape(handle));

  useEffect(() => {
    const next = readShape(handle);
    setShape((prev) => (same(prev, next) ? prev : next));
  }, [handle]);

  const bias01 = shape.bias / RAIL; // normalized input offset
  const pts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const xin = -1 + (2 * i) / N;
    const y = transfer(shape, xin + bias01);
    const px = PAD + ((xin + 1) / 2) * (W - 2 * PAD);
    const py = H / 2 - y * (H / 2 - PAD);
    pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
  }

  return (
    <div className="shaper-ui" data-testid="shaper-ui">
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="transfer curve"
      >
        <rect x={0} y={0} width={W} height={H} className="shaper-bg" />
        <line
          x1={PAD}
          y1={H / 2}
          x2={W - PAD}
          y2={H / 2}
          className="shaper-axis"
        />
        <line
          x1={W / 2}
          y1={PAD}
          x2={W / 2}
          y2={H - PAD}
          className="shaper-axis"
        />
        <polyline points={pts.join(" ")} className="shaper-curve" fill="none" />
      </svg>
      <div className="shaper-mode" data-testid="shaper-mode">
        {MODES[shape.mode]}
      </div>
    </div>
  );
}
