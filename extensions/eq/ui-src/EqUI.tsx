// Custom UI for the 4-band parametric EQ: a log-frequency response plot
// with one draggable handle per band. Drag horizontally for frequency,
// vertically for gain; scroll over a handle (or drag the Q ring) to widen
// or narrow the band. The drawn curve is the exact magnitude response of
// the DSP's four series RBJ peaking biquads, so what you see is what the
// engine does.
//
// This file is bundled to ../ui.js (esm, react external) by the app build.
// Drag math uses deltas from the pointer-down position, so it works both
// in a real browser and under jsdom (zero-size bounding boxes).

import { useCallback, useEffect, useRef, useState } from "react";

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
  setParam(id: string, v: number): void;
  endEdit?(): void;
}

const W = 340;
const H = 150;
const PAD_X = 8;
const PAD_TOP = 10;
const PAD_BOT = 16;

// Pitch axis (1 V/oct, 0 = C4) mirrors the freq knobs' range.
const PITCH_MIN = -3.7;
const PITCH_MAX = 6.1;
const GAIN_MAX = 15;
const Q_MIN = 0.2;
const Q_MAX = 12;
const N_BANDS = 4;
const N_POINTS = 128;

const BAND_COLORS = ["#e06c75", "#e5c07b", "#61afef", "#98c379"];
const GRID_HZ = [50, 100, 500, 1000, 5000, 10000];

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const pitchToHz = (v: number) => 261.626 * 2 ** v;
const hzLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : `${hz}`);

const xOfPitch = (p: number) =>
  PAD_X + ((p - PITCH_MIN) / (PITCH_MAX - PITCH_MIN)) * (W - 2 * PAD_X);
const yOfDb = (db: number) =>
  PAD_TOP + ((GAIN_MAX - db) / (2 * GAIN_MAX)) * (H - PAD_TOP - PAD_BOT);

interface BandState {
  pitch: number;
  gain: number;
  q: number;
}

const readBands = (handle: ModuleHandle): BandState[] =>
  Array.from({ length: N_BANDS }, (_, b) => ({
    pitch: handle.paramValue(`freq${b + 1}`),
    gain: handle.paramValue(`gain${b + 1}`),
    q: handle.paramValue(`q${b + 1}`),
  }));

const sameBands = (a: BandState[], b: BandState[]) =>
  a.every(
    (x, i) => x.pitch === b[i].pitch && x.gain === b[i].gain && x.q === b[i].q,
  );

/** Magnitude (dB) of one RBJ peaking bell at pitch p — matches lib.rs. */
function bandDb(band: BandState, p: number, sampleRate = 48000): number {
  if (band.gain === 0) return 0;
  const f0 = clamp(pitchToHz(band.pitch), 20, 0.45 * sampleRate);
  const f = clamp(pitchToHz(p), 20, 0.45 * sampleRate);
  const a = 10 ** (clamp(band.gain, -GAIN_MAX, GAIN_MAX) / 40);
  const q = clamp(band.q, Q_MIN, Q_MAX);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = 1 + alpha * a;
  const b1 = -2 * Math.cos(w0);
  const b2 = 1 - alpha * a;
  const a0 = 1 + alpha / a;
  const a2 = 1 - alpha / a;
  const w = (2 * Math.PI * f) / sampleRate;
  const cos1 = Math.cos(w);
  const cos2 = Math.cos(2 * w);
  const num =
    (b0 + b1 * cos1 + b2 * cos2) ** 2 +
    (b1 * Math.sin(w) + b2 * Math.sin(2 * w)) ** 2;
  const den =
    (a0 + b1 * cos1 + a2 * cos2) ** 2 +
    (b1 * Math.sin(w) + a2 * Math.sin(2 * w)) ** 2;
  return 10 * Math.log10(num / den);
}

function responsePath(bands: BandState[]): string {
  const pts: string[] = [];
  for (let i = 0; i < N_POINTS; i++) {
    const p = PITCH_MIN + (i / (N_POINTS - 1)) * (PITCH_MAX - PITCH_MIN);
    const db = bands.reduce((acc, b) => acc + bandDb(b, p), 0);
    const x = xOfPitch(p);
    const y = yOfDb(clamp(db, -GAIN_MAX, GAIN_MAX));
    pts.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

export default function EqUI({ handle }: { handle: ModuleHandle }) {
  const [bands, setBands] = useState<BandState[]>(() => readBands(handle));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bandsRef = useRef(bands);
  bandsRef.current = bands;

  const drag = useRef<{
    band: number;
    startX: number;
    startY: number;
    start: BandState;
  } | null>(null);

  // Sync from the engine (panel knobs, patch load, wires) unless mid-drag.
  // No dep array: wired inputs read live telemetry through the handle, and
  // telemetry ticks re-render without changing the handle's identity.
  useEffect(() => {
    if (drag.current) return;
    const next = readBands(handle);
    setBands((prev) => (sameBands(prev, next) ? prev : next));
  });

  const apply = useCallback(
    (index: number, next: BandState) => {
      setBands((prev) => {
        const p = prev[index];
        if (next.pitch !== p.pitch)
          handle.setParam(`freq${index + 1}`, next.pitch);
        if (next.gain !== p.gain)
          handle.setParam(`gain${index + 1}`, next.gain);
        if (next.q !== p.q) handle.setParam(`q${index + 1}`, next.q);
        return prev.map((b, i) => (i === index ? next : b));
      });
    },
    [handle],
  );

  const onMove = useCallback(
    (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dp =
        ((e.clientX - d.startX) / (W - 2 * PAD_X)) * (PITCH_MAX - PITCH_MIN);
      const dg =
        (-(e.clientY - d.startY) / (H - PAD_TOP - PAD_BOT)) * 2 * GAIN_MAX;
      apply(d.band, {
        ...d.start,
        pitch: clamp(d.start.pitch + dp, PITCH_MIN, PITCH_MAX),
        gain: clamp(d.start.gain + dg, -GAIN_MAX, GAIN_MAX),
      });
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

  const startDrag = (band: number) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = {
      band,
      startX: e.clientX,
      startY: e.clientY,
      start: bands[band],
    };
  };

  // Scroll over a handle adjusts Q geometrically (up = narrower). Native
  // non-passive listener: the rack's overscroll pan is itself a native
  // wheel listener on an ancestor, so a React synthetic handler would fire
  // too late to stop the canvas from panning underneath.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const target = e.target as Element | null;
      const g = target?.closest?.("[data-eq-band]");
      if (!g) return;
      e.preventDefault();
      e.stopPropagation();
      const band = Number(g.getAttribute("data-eq-band"));
      const factor = 2 ** (-e.deltaY / 480);
      const b = bandsRef.current[band];
      apply(band, { ...b, q: clamp(b.q * factor, Q_MIN, Q_MAX) });
      handle.endEdit?.();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [apply, handle]);

  return (
    <div className="eq-ui" data-testid="eq-ui" ref={rootRef}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="eq-plot"
        onDragStart={(e) => e.preventDefault()}
      >
        {/* 0 dB line + frequency grid */}
        <line
          x1={PAD_X}
          y1={yOfDb(0)}
          x2={W - PAD_X}
          y2={yOfDb(0)}
          stroke="#3a3f46"
          strokeDasharray="3 3"
        />
        {GRID_HZ.map((hz) => {
          const p = Math.log2(hz / 261.626);
          if (p < PITCH_MIN || p > PITCH_MAX) return null;
          const x = xOfPitch(p);
          return (
            <g key={hz}>
              <line
                x1={x}
                y1={PAD_TOP}
                x2={x}
                y2={H - PAD_BOT}
                stroke="#23262c"
              />
              <text
                x={x}
                y={H - 4}
                textAnchor="middle"
                className="eq-grid-label"
              >
                {hzLabel(hz)}
              </text>
            </g>
          );
        })}
        {/* per-band shadow curves, then the combined response */}
        {bands.map((b, i) =>
          b.gain !== 0 ? (
            <path
              key={i}
              className="eq-band-curve"
              d={responsePath([b])}
              fill="none"
              stroke={BAND_COLORS[i]}
              strokeOpacity={0.35}
            />
          ) : null,
        )}
        <path
          className="eq-curve"
          data-testid="eq-curve"
          d={responsePath(bands)}
          fill="none"
          stroke="#62d0ff"
          strokeWidth={1.8}
        />
        {/* draggable band handles; ring radius tracks bandwidth (1/Q) */}
        {bands.map((b, i) => {
          const x = xOfPitch(clamp(b.pitch, PITCH_MIN, PITCH_MAX));
          const y = yOfDb(clamp(b.gain, -GAIN_MAX, GAIN_MAX));
          const ring = 6 + 14 / clamp(b.q, Q_MIN, Q_MAX);
          return (
            <g
              key={i}
              data-testid={`eq-handle-${i + 1}`}
              data-eq-band={i}
              className="eq-handle"
              onMouseDown={startDrag(i)}
            >
              <circle
                cx={x}
                cy={y}
                r={ring}
                fill={BAND_COLORS[i]}
                fillOpacity={0.12}
              />
              <circle
                cx={x}
                cy={y}
                r={5}
                fill={BAND_COLORS[i]}
                stroke="#14161a"
                strokeWidth={1.5}
              />
              <text
                x={x}
                y={y + 3}
                textAnchor="middle"
                className="eq-handle-label"
              >
                {i + 1}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="eq-readout" data-testid="eq-readout">
        {bands.map((b, i) => (
          <span
            key={i}
            className="eq-readout-band"
            style={{ color: BAND_COLORS[i] }}
          >
            {hzLabel(Math.round(pitchToHz(b.pitch)))}Hz {b.gain >= 0 ? "+" : ""}
            {b.gain.toFixed(1)}dB Q{b.q.toFixed(1)}
          </span>
        ))}
      </div>
    </div>
  );
}
