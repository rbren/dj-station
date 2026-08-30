// Custom UI for the Scope: a time-domain trace and a frequency-domain
// spectrum, with a wave / spectrum / both toggle.
//
// EVERYTHING DRAWN HERE IS THE SIGNAL ITSELF. The panel polls a window of
// raw samples from the scope's `in` jack (a manifest `capture` jack — see
// crates/dj-engine/src/capture.rs) and draws that: the trace is those
// samples, the spectrum is a real FFT of those samples. It used to
// RECONSTRUCT a harmonic model from the scalar hz/peak/rms telemetry,
// which is why noise drew a tidy periodic wave and a comb spectrum with
// dead bins between the invented harmonics — a picture of the model, not
// of the signal. The scalar outputs still feed the readout, which is what
// they measure.
//
// The RT thread does no extra work: it writes samples it already has into
// a fixed ring, and the FFT happens here, per poll, on the window the app
// asked for.
//
// The FFT's own resolution is fixed by that ring — 2048 samples, so 1024
// bins ~23 Hz apart at 48 kHz, and nothing on the panel changes it (the
// `window` input is the level followers' time constant, not a buffer
// length). What the `bins` input sets is how many log-spaced BANDS those
// FFT bins are folded into for the display: fewer, wider bars read like a
// spectrum analyser's octave bands; more, narrower ones separate partials
// that sit close together, up to the point where the bottom of the range
// runs out of FFT bins to distinguish (below ~200 Hz neighbouring bands
// start reading the same bin and the bars step rather than curve).

import { useEffect, useRef, useState } from "react";

/** One window of captured samples, oldest first. */
export interface CaptureWindow {
  sampleRate: number;
  samples: Float32Array;
}

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
  signalTap?(jackId: string): { display: number };
  /** Raw samples from a `capture` jack; absent outside a live rack. */
  capture?(jackId: string): Promise<CaptureWindow | null>;
}

/** How often the sample window is re-fetched (ms) — the telemetry rate. */
export const POLL_MS = 100;
export const FFT_SIZE = 2048;

// Sized to fill the condensed one-row I/O strip below (3 input + 6 output
// cells, see panelLayouts.ts) so the display is the panel's main surface.
const W = 400;
const TRACE_H = 96;
const SPEC_H = 120;
const PAD = 4;

/** Log-frequency display range for the spectrum. */
const F_LO = 20;
const F_HI = 16000;
/** Bar count: the `bins` input's detents (manifest.json), and its default. */
export const MIN_BINS = 16;
export const MAX_BINS = 144;
export const DEFAULT_BINS = 48;
/** Spectrum floor, dB relative to a 10 V full-scale sine. */
const DB_FLOOR = -60;
/** Trace full scale: the ±10 V signal rails, so the height is honest. */
const FULL_SCALE = 10;

/**
 * Magnitude spectrum of a real buffer: iterative radix-2 FFT, Hann
 * windowed, returning n/2 one-sided magnitudes normalized so a sine of
 * amplitude A reads |X[k]| ~= A at its bin.
 */
export function fftMag(input: Float32Array): Float32Array {
  const n = input.length;
  if (n === 0 || (n & (n - 1)) !== 0)
    throw new Error("fftMag: length must be 2^k");
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

/** The newest 2^k samples of a capture, for the FFT. Empty if too short. */
export function fftFrame(
  samples: Float32Array,
  max: number = FFT_SIZE,
): Float32Array {
  let n = 1;
  while (n * 2 <= Math.min(samples.length, max)) n *= 2;
  if (n < 2) return new Float32Array(0);
  return samples.subarray(samples.length - n);
}

export interface Band {
  /** Band center frequency, Hz. */
  hz: number;
  /** Level in dB relative to a 10 V sine, clamped to DB_FLOOR. */
  db: number;
}

/**
 * Fold FFT magnitudes into `count` log-spaced display bands. A band reads
 * the MEAN POWER of the bins it covers, so the display is a density: white
 * noise — equal power per bin — draws flat across bands of very different
 * widths, and no band can come out empty (the lowest bands, narrower than
 * a bin, read the bin they sit in).
 */
export function spectrumBands(
  mags: Float32Array,
  sampleRate: number,
  count: number = DEFAULT_BINS,
): Band[] {
  const n = mags.length * 2;
  const binHz = sampleRate / n;
  const bands: Band[] = [];
  const logLo = Math.log(F_LO);
  const logHi = Math.log(F_HI);
  for (let b = 0; b < count; b++) {
    const fLo = Math.exp(logLo + ((logHi - logLo) * b) / count);
    const fHi = Math.exp(logLo + ((logHi - logLo) * (b + 1)) / count);
    const hz = Math.sqrt(fLo * fHi);
    if (mags.length < 2) {
      bands.push({ hz, db: DB_FLOOR });
      continue;
    }
    // Bin 0 is DC — never part of a band.
    const kLo = Math.min(mags.length - 1, Math.max(1, Math.floor(fLo / binHz)));
    const kHi = Math.min(
      mags.length - 1,
      Math.max(kLo, Math.ceil(fHi / binHz)),
    );
    let power = 0;
    for (let k = kLo; k <= kHi; k++) power += mags[k] * mags[k];
    const amp = Math.sqrt(power / (kHi - kLo + 1));
    const db = amp > 0 ? 20 * Math.log10(amp / 10) : DB_FLOOR;
    bands.push({ hz, db: Math.max(DB_FLOOR, db) });
  }
  return bands;
}

/**
 * The `bins` input read as a bar count: a whole number of bands inside the
 * knob's range. The jack is patchable, so the value arriving here can be
 * any voltage — clamping is what keeps a swept CV drawing a spectrum
 * instead of nothing at all.
 */
export function binCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BINS;
  return Math.min(MAX_BINS, Math.max(MIN_BINS, Math.round(value)));
}

/**
 * Where to start drawing so a periodic trace stands still: the latest
 * rising zero crossing at or before the window start, falling back to the
 * window start when the signal never crosses. Noise has no trigger to
 * find by nature — which is what an unsyncable input looks like on a real
 * scope, and why noise must not be drawn as if it had one.
 */
export function triggerStart(
  samples: Float32Array,
  windowStart: number,
): number {
  for (let i = windowStart; i > 0; i--) {
    if (samples[i - 1] <= 0 && samples[i] > 0) return i;
  }
  return windowStart;
}

/**
 * The slice of the capture the trace draws: two periods of the detected
 * fundamental, trigger-aligned; the whole window when there is no pitch to
 * lock to (noise, silence).
 */
export function traceWindow(
  samples: Float32Array,
  sampleRate: number,
  f0: number,
): Float32Array {
  if (samples.length === 0 || f0 <= 0) return samples;
  const len = Math.min(
    samples.length,
    Math.max(16, Math.round((2 * sampleRate) / f0)),
  );
  const start = triggerStart(samples, samples.length - len);
  return samples.subarray(start, start + len);
}

/**
 * Min/max envelope of `samples` over at most `columns` display columns, as
 * SVG polyline points: a window longer than the panel is wide is drawn as
 * the band it actually occupies instead of an aliased line through every
 * k-th sample.
 */
export function tracePoints(
  samples: Float32Array,
  columns: number,
  width: number,
  height: number,
): string {
  if (samples.length === 0) return "";
  const yOf = (v: number) =>
    height / 2 -
    (Math.max(-FULL_SCALE, Math.min(FULL_SCALE, v)) / FULL_SCALE) *
      (height / 2 - PAD);
  const cols = Math.max(1, Math.min(columns, samples.length));
  const pts: string[] = [];
  for (let c = 0; c < cols; c++) {
    const lo = Math.floor((c * samples.length) / cols);
    const hi = Math.max(lo + 1, Math.floor(((c + 1) * samples.length) / cols));
    let min = Infinity;
    let max = -Infinity;
    for (let i = lo; i < hi && i < samples.length; i++) {
      if (samples[i] < min) min = samples[i];
      if (samples[i] > max) max = samples[i];
    }
    const x = PAD + (c / Math.max(1, cols - 1)) * (width - 2 * PAD);
    // Top-then-bottom per column keeps the envelope one continuous line.
    pts.push(`${x.toFixed(1)},${yOf(max).toFixed(1)}`);
    if (min !== max) pts.push(`${x.toFixed(1)},${yOf(min).toFixed(1)}`);
  }
  return pts.join(" ");
}

type View = "time" | "spectrum" | "both";

const readTap = (handle: ModuleHandle, jack: string): number =>
  handle.signalTap?.(jack)?.display ?? 0;

const EMPTY = new Float32Array(0);
const DEFAULT_SAMPLE_RATE = 48000;

/** Poll the scope's `in` jack for a fresh window of samples. */
function useCapture(handle: ModuleHandle): CaptureWindow {
  const [window, setWindow] = useState<CaptureWindow>({
    sampleRate: DEFAULT_SAMPLE_RATE,
    samples: EMPTY,
  });
  // The handle is rebuilt on every node snapshot; the poll must not be.
  const handleRef = useRef(handle);
  handleRef.current = handle;
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const poll = async () => {
      if (inFlight || !handleRef.current.capture) return;
      inFlight = true;
      try {
        const w = await handleRef.current.capture("in");
        if (alive && w) setWindow(w);
      } catch {
        // A scope on a node that just went away: the next poll is the
        // retry, and the IPC layer has already reported the failure.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return window;
}

export default function ScopeUI({ handle }: { handle: ModuleHandle }) {
  const [view, setView] = useState<View>("both");
  const { sampleRate, samples } = useCapture(handle);
  // Scope measurements from the batched telemetry tap (see lib.rs for the
  // output scaling: hz is 1 V per 100 Hz, and reads 0 when the input has
  // no fundamental to report).
  const f0 = readTap(handle, "out:hz") * 100;
  const peak = Math.max(0, readTap(handle, "out:peak"));
  const rms = Math.max(0, readTap(handle, "out:rms"));

  const showTime = view !== "spectrum";
  const showSpec = view !== "time";

  const tracePts = showTime
    ? tracePoints(traceWindow(samples, sampleRate, f0), W, W, TRACE_H)
    : "";

  const bins = binCount(handle.paramValue("bins"));
  let bands: Band[] = [];
  let peakBandHz = 0;
  if (showSpec) {
    const frame = fftFrame(samples);
    bands = spectrumBands(
      frame.length > 0 ? fftMag(frame) : EMPTY,
      sampleRate,
      bins,
    );
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
          data-bins={bins}
          data-peak-hz={peakBandHz > 0 ? peakBandHz.toFixed(0) : ""}
        >
          <rect x={0} y={0} width={W} height={SPEC_H} className="scope-bg" />
          {bands.map((b, i) => {
            const barW = (W - 2 * PAD) / bins;
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
        {f0 > 0 ? `${f0.toFixed(f0 < 100 ? 1 : 0)} Hz` : "— Hz"} · peak{" "}
        {peak.toFixed(1)} V · rms {rms.toFixed(1)} V
      </div>
    </div>
  );
}
