// Parametric EQ editor for the Clip page: a log-frequency response plot
// with one draggable handle per band, adapted from the EQ module's custom
// UI (extensions/eq/ui-src/EqUI.tsx — copied per that module's layout so
// both EQs read the same; this one edits a ClipProgram instead of module
// params). Drag horizontally for frequency, vertically for gain; scroll
// over a handle to widen or narrow the band. The drawn curve is the exact
// magnitude response of the renderer's series RBJ peaking biquads.
//
// Undo integration: `onBegin` fires once at the start of a gesture (drag
// or a fresh wheel burst) so the owner can snapshot history, then
// `onChange` streams the live band values.

import { useCallback, useEffect, useRef } from 'react';
import { EQ_MAX_Q, EQ_MIN_Q, type ClipEqBand } from '../clip';

const W = 340;
const H = 150;
const PAD_X = 8;
const PAD_TOP = 10;
const PAD_BOT = 16;

// Same pitch axis as the EQ module (1 V/oct, 0 = C4).
const PITCH_MIN = -3.7;
const PITCH_MAX = 6.1;
const GAIN_MAX = 15;
const N_POINTS = 128;
/** Wheel events further apart than this start a new undo gesture. */
const WHEEL_GESTURE_MS = 500;

const BAND_COLORS = ['#e06c75', '#e5c07b', '#61afef', '#98c379'];
const GRID_HZ = [50, 100, 500, 1000, 5000, 10000];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pitchToHz = (v: number) => 261.626 * 2 ** v;
const hzToPitch = (hz: number) => Math.log2(hz / 261.626);
const hzLabel = (hz: number) => (hz >= 1000 ? `${Math.round(hz / 100) / 10}k` : `${hz}`);

const xOfPitch = (p: number) =>
  PAD_X + ((p - PITCH_MIN) / (PITCH_MAX - PITCH_MIN)) * (W - 2 * PAD_X);
const yOfDb = (db: number) =>
  PAD_TOP + ((GAIN_MAX - db) / (2 * GAIN_MAX)) * (H - PAD_TOP - PAD_BOT);

/** Magnitude (dB) of one RBJ peaking bell at pitch p — matches the clip
 *  renderer's `Biquad::peaking` (and the EQ module's DSP). */
function bandDb(band: ClipEqBand, p: number, sampleRate = 48000): number {
  if (band.gain_db === 0) return 0;
  const f0 = clamp(band.freq_hz, 20, 0.45 * sampleRate);
  const f = clamp(pitchToHz(p), 20, 0.45 * sampleRate);
  const a = 10 ** (clamp(band.gain_db, -GAIN_MAX, GAIN_MAX) / 40);
  const q = clamp(band.q, EQ_MIN_Q, EQ_MAX_Q);
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
  const num = (b0 + b1 * cos1 + b2 * cos2) ** 2 + (b1 * Math.sin(w) + b2 * Math.sin(2 * w)) ** 2;
  const den = (a0 + b1 * cos1 + a2 * cos2) ** 2 + (b1 * Math.sin(w) + a2 * Math.sin(2 * w)) ** 2;
  return 10 * Math.log10(num / den);
}

function responsePath(bands: ClipEqBand[]): string {
  const pts: string[] = [];
  for (let i = 0; i < N_POINTS; i++) {
    const p = PITCH_MIN + (i / (N_POINTS - 1)) * (PITCH_MAX - PITCH_MIN);
    const db = bands.reduce((acc, b) => acc + bandDb(b, p), 0);
    const x = xOfPitch(p);
    const y = yOfDb(clamp(db, -GAIN_MAX, GAIN_MAX));
    pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(' ');
}

export interface ClipEqUIProps {
  bands: ClipEqBand[];
  /** A new edit gesture is starting — snapshot for undo. */
  onBegin(): void;
  onChange(bands: ClipEqBand[]): void;
}

export function ClipEqUI({ bands, onBegin, onChange }: ClipEqUIProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bandsRef = useRef(bands);
  useEffect(() => {
    bandsRef.current = bands;
  }, [bands]);

  const drag = useRef<{
    band: number;
    startX: number;
    startY: number;
    start: ClipEqBand;
  } | null>(null);
  const lastWheel = useRef(0);

  const apply = useCallback(
    (index: number, next: ClipEqBand) => {
      onChange(bandsRef.current.map((b, i) => (i === index ? next : b)));
    },
    [onChange],
  );

  const onMove = useCallback(
    (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dp = ((e.clientX - d.startX) / (W - 2 * PAD_X)) * (PITCH_MAX - PITCH_MIN);
      const dg = (-(e.clientY - d.startY) / (H - PAD_TOP - PAD_BOT)) * 2 * GAIN_MAX;
      const pitch = clamp(hzToPitch(d.start.freq_hz) + dp, PITCH_MIN, PITCH_MAX);
      apply(d.band, {
        ...d.start,
        freq_hz: Math.round(pitchToHz(pitch) * 10) / 10,
        gain_db: Math.round(clamp(d.start.gain_db + dg, -GAIN_MAX, GAIN_MAX) * 10) / 10,
      });
    },
    [apply],
  );

  const onUp = useCallback(() => {
    drag.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onMove, onUp]);

  const startDrag = (band: number) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onBegin();
    drag.current = { band, startX: e.clientX, startY: e.clientY, start: bands[band] };
  };

  // Scroll over a handle adjusts Q geometrically (up = narrower). Native
  // non-passive listener so the page never scrolls underneath.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const target = e.target as Element | null;
      const g = target?.closest?.('[data-eq-band]');
      if (!g) return;
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - lastWheel.current > WHEEL_GESTURE_MS) onBegin();
      lastWheel.current = now;
      const band = Number(g.getAttribute('data-eq-band'));
      const factor = 2 ** (-e.deltaY / 480);
      const b = bandsRef.current[band];
      apply(band, { ...b, q: Math.round(clamp(b.q * factor, EQ_MIN_Q, EQ_MAX_Q) * 100) / 100 });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [apply, onBegin]);

  return (
    <div className="eq-ui clip-eq-ui" data-testid="clip-eq" ref={rootRef}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="eq-plot"
        onDragStart={(e) => e.preventDefault()}
      >
        <line
          x1={PAD_X}
          y1={yOfDb(0)}
          x2={W - PAD_X}
          y2={yOfDb(0)}
          stroke="#3a3f46"
          strokeDasharray="3 3"
        />
        {GRID_HZ.map((hz) => {
          const p = hzToPitch(hz);
          if (p < PITCH_MIN || p > PITCH_MAX) return null;
          const x = xOfPitch(p);
          return (
            <g key={hz}>
              <line x1={x} y1={PAD_TOP} x2={x} y2={H - PAD_BOT} stroke="#23262c" />
              <text x={x} y={H - 4} textAnchor="middle" className="eq-grid-label">
                {hzLabel(hz)}
              </text>
            </g>
          );
        })}
        {bands.map((b, i) =>
          b.gain_db !== 0 ? (
            <path
              key={i}
              className="eq-band-curve"
              d={responsePath([b])}
              fill="none"
              stroke={BAND_COLORS[i % BAND_COLORS.length]}
              strokeOpacity={0.35}
            />
          ) : null,
        )}
        <path
          className="eq-curve"
          data-testid="clip-eq-curve"
          d={responsePath(bands)}
          fill="none"
          stroke="#62d0ff"
          strokeWidth={1.8}
        />
        {bands.map((b, i) => {
          const x = xOfPitch(clamp(hzToPitch(b.freq_hz), PITCH_MIN, PITCH_MAX));
          const y = yOfDb(clamp(b.gain_db, -GAIN_MAX, GAIN_MAX));
          const ring = 6 + 14 / clamp(b.q, EQ_MIN_Q, EQ_MAX_Q);
          const color = BAND_COLORS[i % BAND_COLORS.length];
          return (
            <g
              key={i}
              data-testid={`clip-eq-handle-${i + 1}`}
              data-eq-band={i}
              className="eq-handle"
              onMouseDown={startDrag(i)}
            >
              <circle cx={x} cy={y} r={ring} fill={color} fillOpacity={0.12} />
              <circle cx={x} cy={y} r={5} fill={color} stroke="#14161a" strokeWidth={1.5} />
              <text x={x} y={y + 3} textAnchor="middle" className="eq-handle-label">
                {i + 1}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="eq-readout" data-testid="clip-eq-readout">
        {bands.map((b, i) => (
          <span
            key={i}
            className="eq-readout-band"
            style={{ color: BAND_COLORS[i % BAND_COLORS.length] }}
          >
            {hzLabel(Math.round(b.freq_hz))}Hz {b.gain_db >= 0 ? '+' : ''}
            {b.gain_db.toFixed(1)}dB Q{b.q.toFixed(1)}
          </span>
        ))}
      </div>
    </div>
  );
}
