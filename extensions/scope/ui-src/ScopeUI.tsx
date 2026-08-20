// Custom UI for the Scope: a time-domain trace and a frequency-domain
// spectrum, with a wave / spectrum / both toggle.
//
// The DSP module deliberately ships no sample buffer to the app (see
// src/lib.rs — the engine's telemetry is scalar per jack), so this panel
// reconstructs a model of the measured signal from what the scope does
// emit: the detected fundamental (`hz`), the decaying `peak` and the
// windowed `rms`. The crest factor peak/rms picks a harmonic template
// (sine ~ 1.41, square ~ 1, saw ~ 1.73) and a band-limited harmonic
// series is synthesized in TS at 48 kHz. The spectrum is a real FFT
// (N = 1024) of that synthesized buffer, drawn as log-frequency bars —
// all analysis happens here in the UI; the RT thread does no extra work.

import { useState } from "react";

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
  signalTap?(jackId: string): { display: number };
}

export const FFT_SIZE = 1024;
export const SAMPLE_RATE = 48000;

// Sized to fill the condensed one-row I/O strip below (3 input + 6 output
// cells, see panelLayouts.ts) so the display is the panel's main surface.
const W = 400;
const TRACE_H = 96;
const SPEC_H = 120;
const PAD = 4;

/** Log-frequency display range and bar count for the spectrum. */
const F_LO = 20;
const F_HI = 16000;
const BANDS = 48;
/** Spectrum floor, dB relative to a 10 V full-scale sine. */
const DB_FLOOR = -60;

const CREST_SQUARE = 1.0;
const CREST_SINE = Math.SQRT2;
const CREST_SAW = Math.sqrt(3);
const HARMONICS = 16;

/** Harmonic amplitudes for the crest-factor-matched template blend. */
export function harmonicAmps(crest: number): number[] {
  const amps: number[] = [];
  for (let k = 1; k <= HARMONICS; k++) {
    const sine = k === 1 ? 1 : 0;
    const square = k % 2 === 1 ? 1 / k : 0;
    const saw = 1 / k;
    let a: number;
    if (crest <= CREST_SINE) {
      // square -> sine as the crest factor rises toward sqrt(2).
      const t = Math.min(
        1,
        Math.max(0, (crest - CREST_SQUARE) / (CREST_SINE - CREST_SQUARE)),
      );
      a = square + (sine - square) * t;
    } else {
      // sine -> saw beyond sqrt(2).
      const t = Math.min(
        1,
        Math.max(0, (crest - CREST_SINE) / (CREST_SAW - CREST_SINE)),
      );
      a = sine + (saw - sine) * t;
    }
    amps.push(a);
  }
  return amps;
}

/**
 * Synthesize `n` samples of the reconstructed signal: a band-limited
 * harmonic series at `f0`, character picked by peak/rms, scaled so the
 * buffer RMS matches the measured `rms`. Unvoiced (f0 <= 0) or silent
 * input yields silence.
 */
export function synthesizeWave(
  f0: number,
  peak: number,
  rms: number,
  n: number = FFT_SIZE,
  sampleRate: number = SAMPLE_RATE,
): Float32Array {
  const out = new Float32Array(n);
  if (f0 <= 0 || peak <= 1e-4 || rms <= 1e-4) return out;
  const crest = peak / rms;
  const amps = harmonicAmps(crest);
  const nyquist = sampleRate / 2;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 1; k <= amps.length; k++) {
      const f = k * f0;
      if (f >= nyquist || amps[k - 1] === 0) continue;
      v += amps[k - 1] * Math.sin((2 * Math.PI * f * i) / sampleRate);
    }
    out[i] = v;
    sumSq += v * v;
  }
  const bufRms = Math.sqrt(sumSq / n);
  if (bufRms > 0) {
    const g = rms / bufRms;
    for (let i = 0; i < n; i++) out[i] *= g;
  }
  return out;
}

/**
 * Magnitude spectrum of a real buffer: iterative radix-2 FFT, Hann
 * windowed, returning n/2 one-sided magnitudes normalized so a sine of
 * amplitude A reads |X[k]| ~= A at its bin.
 */
export function fftMag(input: Float32Array): Float32Array {
  const n = input.length;
  if ((n & (n - 1)) !== 0) throw new Error("fftMag: length must be 2^k");
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Hann window (coherent gain 0.5, compensated in `norm` below).
    re[i] = input[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  }
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const t = re[i];
      re[i] = re[j];
      re[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  const mags = new Float32Array(n / 2);
  // One-sided amplitude: 2/n for the FFT scale, 2x for the Hann window.
  const norm = 4 / n;
  for (let k = 0; k < n / 2; k++) {
    mags[k] = Math.hypot(re[k], im[k]) * norm;
  }
  return mags;
}

export interface Band {
  /** Band center frequency, Hz. */
  hz: number;
  /** Level in dB relative to a 10 V sine, clamped to DB_FLOOR. */
  db: number;
}

/** Fold FFT magnitudes into log-spaced display bands (max per band). */
export function spectrumBands(
  mags: Float32Array,
  sampleRate: number = SAMPLE_RATE,
): Band[] {
  const n = mags.length * 2;
  const binHz = sampleRate / n;
  const bands: Band[] = [];
  const logLo = Math.log(F_LO);
  const logHi = Math.log(F_HI);
  for (let b = 0; b < BANDS; b++) {
    const fLo = Math.exp(logLo + ((logHi - logLo) * b) / BANDS);
    const fHi = Math.exp(logLo + ((logHi - logLo) * (b + 1)) / BANDS);
    const kLo = Math.max(1, Math.floor(fLo / binHz));
    const kHi = Math.min(mags.length - 1, Math.ceil(fHi / binHz));
    let m = 0;
    for (let k = kLo; k <= kHi; k++) m = Math.max(m, mags[k]);
    const db = m > 0 ? 20 * Math.log10(m / 10) : DB_FLOOR;
    bands.push({ hz: Math.sqrt(fLo * fHi), db: Math.max(DB_FLOOR, db) });
  }
  return bands;
}

type View = "time" | "spectrum" | "both";

const readTap = (handle: ModuleHandle, jack: string): number =>
  handle.signalTap?.(jack)?.display ?? 0;

export default function ScopeUI({ handle }: { handle: ModuleHandle }) {
  const [view, setView] = useState<View>("both");
  // Scope measurements from the batched telemetry tap (see lib.rs for
  // the output scaling: hz is 1 V per 100 Hz).
  const f0 = readTap(handle, "out:hz") * 100;
  const peak = Math.max(0, readTap(handle, "out:peak"));
  const rms = Math.max(0, readTap(handle, "out:rms"));
  const voiced = f0 > 0 && peak > 1e-4 && rms > 1e-4;

  const showTime = view !== "spectrum";
  const showSpec = view !== "time";

  // Time trace: two periods of the harmonic model, scaled to the peak.
  let tracePts = "";
  if (showTime) {
    const pts: string[] = [];
    const amps = voiced ? harmonicAmps(peak / rms) : [];
    // Normalize the drawn shape to unit peak so the y-scale is honest.
    let shapePeak = 0;
    const shape: number[] = [];
    const N = 128;
    for (let i = 0; i <= N; i++) {
      let v = 0;
      const ph = (2 * 2 * Math.PI * i) / N; // two cycles
      for (let k = 1; k <= amps.length; k++) {
        if (k * f0 >= SAMPLE_RATE / 2) break;
        v += amps[k - 1] * Math.sin(k * ph);
      }
      shape.push(v);
      shapePeak = Math.max(shapePeak, Math.abs(v));
    }
    const yScale = (TRACE_H / 2 - PAD) * Math.min(1, peak / 10) || 0;
    for (let i = 0; i <= N; i++) {
      const x = PAD + (i / N) * (W - 2 * PAD);
      const y =
        TRACE_H / 2 - (shapePeak > 0 ? (shape[i] / shapePeak) * yScale : 0);
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    tracePts = pts.join(" ");
  }

  let bands: Band[] = [];
  let peakBandHz = 0;
  if (showSpec) {
    bands = spectrumBands(fftMag(synthesizeWave(f0, peak, rms)));
    let best = DB_FLOOR;
    for (const b of bands) {
      if (b.db > best) {
        best = b.db;
        peakBandHz = b.hz;
      }
    }
  }

  return (
    <div className="scope-ui" data-testid="scope-ui">
      <div className="scope-views" role="group" aria-label="scope view">
        {(["time", "spectrum", "both"] as const).map((v) => (
          <button
            key={v}
            type="button"
            className="scope-view-btn"
            data-testid={`scope-view-${v}`}
            aria-pressed={view === v}
            onClick={() => setView(v)}
          >
            {v === "time" ? "wave" : v}
          </button>
        ))}
      </div>
      {showTime && (
        <svg
          width={W}
          height={TRACE_H}
          viewBox={`0 0 ${W} ${TRACE_H}`}
          role="img"
          aria-label="waveform trace"
          data-testid="scope-trace"
        >
          <rect x={0} y={0} width={W} height={TRACE_H} className="scope-bg" />
          <line
            x1={PAD}
            y1={TRACE_H / 2}
            x2={W - PAD}
            y2={TRACE_H / 2}
            className="scope-axis"
          />
          <polyline points={tracePts} className="scope-wave" fill="none" />
        </svg>
      )}
      {showSpec && (
        <svg
          width={W}
          height={SPEC_H}
          viewBox={`0 0 ${W} ${SPEC_H}`}
          role="img"
          aria-label="spectrum"
          data-testid="scope-spectrum"
          data-peak-hz={voiced ? peakBandHz.toFixed(0) : ""}
        >
          <rect x={0} y={0} width={W} height={SPEC_H} className="scope-bg" />
          {bands.map((b, i) => {
            const barW = (W - 2 * PAD) / BANDS;
            const h = ((b.db - DB_FLOOR) / -DB_FLOOR) * (SPEC_H - 2 * PAD);
            return (
              <rect
                key={i}
                className="scope-bar"
                data-hz={b.hz.toFixed(0)}
                x={PAD + i * barW + 0.5}
                y={SPEC_H - PAD - h}
                width={Math.max(0.5, barW - 1)}
                height={Math.max(0, h)}
              />
            );
          })}
        </svg>
      )}
      <div className="scope-readout" data-testid="scope-readout">
        {voiced ? `${f0.toFixed(f0 < 100 ? 1 : 0)} Hz` : "— Hz"} · peak{" "}
        {peak.toFixed(1)} V · rms {rms.toFixed(1)} V
      </div>
    </div>
  );
}
