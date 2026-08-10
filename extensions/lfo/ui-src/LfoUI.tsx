// Custom UI for the LFO: draws one cycle of the selected shape at the
// current pulse width, with the shape name and rate as a readout.
// Display-only — the panel knobs are the controls; the preview re-renders
// as their values change via the handle.

import { useEffect, useState } from "react";

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
}

const W = 148;
const H = 56;
const PAD = 5;
const N = 96;

const SHAPES = [
  "sine",
  "tri",
  "saw ↑",
  "saw ↓",
  "pulse",
  "s&h",
  "smooth",
] as const;

// Fixed pseudo-random levels for the s&h / smooth previews (the real
// module's sequence is seeded per instance; the preview just shows the
// character of the shape).
const RND = [0.6, -0.8, 0.2, 0.9, -0.4, -1.0, 0.5, -0.1];

interface View {
  shape: number;
  pw: number;
  rate: number;
}

const readView = (handle: ModuleHandle): View => ({
  shape: Math.min(6, Math.max(0, Math.round(handle.paramValue("shape")))),
  pw: Math.min(0.98, Math.max(0.02, handle.paramValue("pw"))),
  rate: handle.paramValue("rate"),
});

const same = (a: View, b: View) =>
  a.shape === b.shape && a.pw === b.pw && a.rate === b.rate;

function shapeAt(view: View, p: number): number {
  const seg = Math.floor(p * 4) % RND.length;
  switch (view.shape) {
    case 1:
      return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    case 2:
      return 2 * p - 1;
    case 3:
      return 1 - 2 * p;
    case 4:
      return p < view.pw ? 1 : -1;
    case 5:
      return RND[seg];
    case 6: {
      const t = (p * 4) % 1;
      const a = RND[seg];
      const b = RND[(seg + 1) % RND.length];
      const s = t * t * (3 - 2 * t);
      return a + (b - a) * s;
    }
    default:
      return Math.sin(2 * Math.PI * p);
  }
}

export default function LfoUI({ handle }: { handle: ModuleHandle }) {
  const [view, setView] = useState<View>(() => readView(handle));

  useEffect(() => {
    const next = readView(handle);
    setView((prev) => (same(prev, next) ? prev : next));
  }, [handle]);

  const pts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const p = i / N;
    const y = shapeAt(view, p);
    const px = PAD + p * (W - 2 * PAD);
    const py = H / 2 - y * (H / 2 - PAD);
    pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
  }

  return (
    <div className="lfo-ui" data-testid="lfo-ui">
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="LFO shape"
      >
        <rect x={0} y={0} width={W} height={H} className="lfo-bg" />
        <line
          x1={PAD}
          y1={H / 2}
          x2={W - PAD}
          y2={H / 2}
          className="lfo-axis"
        />
        <polyline points={pts.join(" ")} className="lfo-wave" fill="none" />
      </svg>
      <div className="lfo-readout" data-testid="lfo-readout">
        {SHAPES[view.shape]} ·{" "}
        {view.rate < 10 ? view.rate.toFixed(2) : view.rate.toFixed(0)} Hz
      </div>
    </div>
  );
}
