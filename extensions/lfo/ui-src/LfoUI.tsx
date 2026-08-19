// Custom UI for the LFO: one cycle of the selected shape at the current
// pulse width, plus a light that blinks with the LFO — brightness follows
// the shape at the current rate — with the shape name and rate as a
// readout. Display-only — the panel knobs are the controls; the preview
// re-renders and the blink re-times as their values change via the
// handle. The blink is a local rAF loop (the 100 ms telemetry poll is
// far too coarse to follow an LFO), so it shows the character of the
// output, not its engine-exact phase.

import { useEffect, useRef, useState } from "react";

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
}

const W = 148;
const H = 56;
const PAD = 5;
const N = 96;

// Exported so the app can pin the manifest's `display.steps` labels (the
// knob/tooltip readout) to this panel's readout — one source of names.
export const SHAPES = [
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

// Above this the blink aliases against the frame rate; clamp so fast
// settings read as a rapid flicker instead of random strobing.
const MAX_BLINK_HZ = 20;

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
  const viewRef = useRef(view);
  viewRef.current = view;
  const lampRef = useRef<HTMLSpanElement>(null);

  // No dep array: wired inputs read live telemetry through the handle,
  // and telemetry ticks re-render without changing the handle's identity.
  useEffect(() => {
    const next = readView(handle);
    setView((prev) => (same(prev, next) ? prev : next));
  });

  // Drive the lamp by mutating a CSS variable directly — no React
  // re-render per frame. Phase accumulates so rate changes speed the
  // blink up/down without a jump.
  useEffect(() => {
    let raf = 0;
    let phase = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const v = viewRef.current;
      const hz = Math.min(MAX_BLINK_HZ, Math.max(0, v.rate));
      phase = (phase + ((now - last) / 1000) * hz) % 1;
      last = now;
      const level = (shapeAt(v, phase) + 1) / 2;
      lampRef.current?.style.setProperty(
        "--lfo-level",
        Math.min(1, Math.max(0, level)).toFixed(3),
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

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
      <div className="lfo-display">
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
        <div className="lfo-lamp-box">
          <span
            ref={lampRef}
            className="lfo-lamp"
            data-testid="lfo-lamp"
            role="img"
            aria-label="LFO blink light"
          />
        </div>
      </div>
      <div className="lfo-readout" data-testid="lfo-readout">
        {SHAPES[view.shape]} ·{" "}
        {view.rate < 10 ? view.rate.toFixed(2) : view.rate.toFixed(0)} Hz
      </div>
    </div>
  );
}
