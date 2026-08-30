// Scope custom UI: what the panel draws for the sources people patch into
// it. Everything here goes through the SAMPLE WINDOW the panel polls from
// the engine (`handle.capture`), because that is all the panel draws — a
// sine from the oscillator, white noise from the noise module (same
// xorshift32 the module runs, see extensions/noise/src/lib.rs), silence.
//
// The engine side of the same story — real modules, real capture — is
// crates/dj-engine/tests/integration/scope.rs.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ScopeUI, {
  binCount,
  fftFrame,
  fftMag,
  spectrumBands,
  traceWindow,
  tracePoints,
  triggerStart,
  DEFAULT_BINS,
  MAX_BINS,
  MIN_BINS,
  type CaptureWindow,
} from '../../extensions/scope/ui-src/ScopeUI';
import scopeManifestJson from '../../extensions/scope/manifest.json';
import type { Manifest } from '../src/types';

/** The scope's manifest on disk: the controls the panel is drawn around. */
const scopeManifest = scopeManifestJson as unknown as Manifest;

afterEach(cleanup);

const SR = 48000;
const N = 2048;

function sine(hz: number, amp = 5, n = N, phase = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * (i + phase)) / SR);
  return out;
}

/** The Noise module's white output: xorshift32, uniform, ±5 V. */
function white(n = N, seed = 0x12345678): Float32Array {
  const out = new Float32Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = 5 * ((x * 2) / 4294967295 - 1);
  }
  return out;
}

/** An input's manifest default, as the engine would hand it to the panel. */
const manifestDefault = (id: string): number =>
  scopeManifest.inputs.find((i) => i.id === id)?.default ?? 0;

function handleWith(
  taps: Record<string, number>,
  samples?: Float32Array,
  params: Record<string, number> = {},
) {
  return {
    // Inputs read through the handle as their knob value, so an unset one
    // reads the manifest default the panel would really see.
    paramValue: (id: string) => params[id] ?? manifestDefault(id),
    signalTap: (jackId: string) => ({ display: taps[jackId] ?? 0 }),
    capture: async (): Promise<CaptureWindow | null> =>
      samples ? { sampleRate: SR, samples } : null,
  };
}

/** The y coordinates of an SVG polyline's points. */
const ys = (points: string): number[] =>
  points ? points.split(' ').map((p) => Number(p.split(',')[1])) : [];

const bandsOf = (samples: Float32Array) => spectrumBands(fftMag(fftFrame(samples)), SR);
const peakBand = (samples: Float32Array) =>
  bandsOf(samples).reduce((a, b) => (b.db > a.db ? b : a));

describe('fftMag', () => {
  it('puts a sine of amplitude A at its bin with magnitude ~A', () => {
    const bin = 40;
    const buf = new Float32Array(N);
    for (let i = 0; i < N; i++) buf[i] = 5 * Math.sin((2 * Math.PI * bin * i) / N);
    const mags = fftMag(buf);
    let argmax = 0;
    for (let k = 1; k < mags.length; k++) if (mags[k] > mags[argmax]) argmax = k;
    expect(argmax).toBe(bin);
    expect(mags[bin]).toBeCloseTo(5, 1);
    expect(mags[bin + 20]).toBeLessThan(0.05);
  });

  it('rejects non-power-of-two buffers', () => {
    expect(() => fftMag(new Float32Array(1000))).toThrow(/2\^k/);
  });
});

describe('fftFrame', () => {
  it('takes the newest power-of-two run of samples', () => {
    expect(fftFrame(new Float32Array(3000)).length).toBe(2048);
    expect(fftFrame(new Float32Array(1500)).length).toBe(1024);
    // The NEWEST: a marker at the end survives, the oldest samples do not.
    const buf = new Float32Array(1500);
    buf[1499] = 1;
    expect(fftFrame(buf)[1023]).toBe(1);
    expect(fftFrame(new Float32Array(1)).length).toBe(0);
  });
});

describe('spectrumBands', () => {
  it('puts an oscillator sine in the band at its frequency', () => {
    const best = peakBand(sine(440));
    expect(best.hz).toBeGreaterThan(380);
    expect(best.hz).toBeLessThan(510);
    expect(best.db).toBeGreaterThan(-20);
  });

  it('shows white noise as broadband with no dead bins', () => {
    const bands = bandsOf(white());
    expect(bands).toHaveLength(48);
    const mean = bands.reduce((s, b) => s + b.db, 0) / bands.length;
    for (const b of bands) {
      // Nothing at the floor, and nothing far off the flat mean: white
      // noise fills the whole display, low bands included.
      expect(b.db).toBeGreaterThan(-60);
      expect(Math.abs(b.db - mean)).toBeLessThan(12);
    }
    const low = bands.slice(0, 12);
    for (const b of low) expect(b.db).toBeGreaterThan(mean - 12);
  });

  it('draws as many bands as it is asked for, over the same range', () => {
    const at = (count: number) => spectrumBands(fftMag(fftFrame(white())), SR, count);
    for (const count of [MIN_BINS, DEFAULT_BINS, MAX_BINS]) {
      expect(at(count)).toHaveLength(count);
    }
    // Same 20 Hz .. 16 kHz display range however finely it is cut.
    for (const count of [MIN_BINS, MAX_BINS]) {
      const bands = at(count);
      expect(bands[0].hz).toBeGreaterThan(20);
      expect(bands[0].hz).toBeLessThan(bands[1].hz);
      expect(bands[bands.length - 1].hz).toBeLessThan(16000);
    }
    // More bands is more DETAIL, not a different picture: the loudest bar
    // of a tone still sits on the tone at either end of the range.
    for (const count of [MIN_BINS, MAX_BINS]) {
      const best = spectrumBands(fftMag(fftFrame(sine(440))), SR, count).reduce((a, b) =>
        b.db > a.db ? b : a,
      );
      expect(best.hz).toBeGreaterThan(380);
      expect(best.hz).toBeLessThan(510);
    }
  });

  it('has no empty bands even where a band is narrower than an FFT bin', () => {
    // At the dense end the lowest bands are far narrower than the 23 Hz
    // bins of a 2048-sample capture, so they read the bin they sit in
    // rather than nothing at all — bars step, they do not drop out.
    const bands = spectrumBands(fftMag(fftFrame(white())), SR, MAX_BINS);
    for (const b of bands) expect(b.db).toBeGreaterThan(-60);
  });

  it('shows silence as an empty spectrum', () => {
    for (const b of bandsOf(new Float32Array(N))) expect(b.db).toBe(-60);
    // No capture at all is the same picture.
    for (const b of spectrumBands(new Float32Array(0), SR)) expect(b.db).toBe(-60);
  });
});

describe('the time trace', () => {
  it('locks a periodic signal to a rising zero crossing', () => {
    const samples = sine(440);
    const start = triggerStart(samples, samples.length - 218);
    expect(samples[start - 1]).toBeLessThanOrEqual(0);
    expect(samples[start]).toBeGreaterThan(0);
  });

  it('draws two periods of a tone, from the same point every time', () => {
    // Two captures of the same tone caught at different phases must draw
    // the same trace — that is what a trigger is for. (Sample-quantized,
    // so "the same" is to within a pixel, not to the bit.)
    const a = ys(tracePoints(traceWindow(sine(440, 5, N, 0), SR, 440), 400, 400, 96));
    const b = ys(tracePoints(traceWindow(sine(440, 5, N, 37), SR, 440), 400, 400, 96));
    expect(a).toHaveLength(b.length);
    const drift = Math.max(...a.map((y, i) => Math.abs(y - b[i])));
    expect(drift).toBeLessThan(1);
    // Both start on the axis and rise: the trigger is a rising crossing.
    for (const t of [a, b]) {
      expect(Math.abs(t[0] - 48)).toBeLessThan(1);
      expect(t[1]).toBeLessThan(t[0]);
    }
    expect(traceWindow(sine(440, 5, N, 0), SR, 440).length).toBe(Math.round((2 * SR) / 440));
  });

  it('draws noise as the whole window, and never the same twice', () => {
    // No fundamental (the scope reports 0 Hz for noise), so the trace is
    // the captured window itself.
    const first = white();
    const second = white(N, 0x2f6e2b1);
    expect(traceWindow(first, SR, 0)).toHaveLength(N);
    const a = tracePoints(traceWindow(first, SR, 0), 400, 400, 96);
    const b = tracePoints(traceWindow(second, SR, 0), 400, 400, 96);
    expect(a).not.toBe(b);
    // A noise column spans a range of values, unlike a slow periodic line:
    // the envelope emits two points per column.
    expect(a.split(' ').length).toBeGreaterThan(400);
  });

  it('is empty with nothing captured', () => {
    expect(tracePoints(new Float32Array(0), 400, 400, 96)).toBe('');
  });
});

/** Render and let the first capture poll land. */
async function renderScope(handle: Parameters<typeof ScopeUI>[0]['handle']) {
  render(<ScopeUI handle={handle} />);
  await act(async () => {});
}

describe('ScopeUI', () => {
  // hz output is 1 V per 100 Hz -> 4.4 V = 440 Hz.
  const tone = { 'out:hz': 4.4, 'out:peak': 5, 'out:rms': 5 / Math.SQRT2 };
  // Noise: real levels, no fundamental.
  const noise = { 'out:hz': 0, 'out:peak': 5, 'out:rms': 2.9 };

  it('shows both the trace and the spectrum by default', async () => {
    await renderScope(handleWith(tone, sine(440)));
    expect(screen.getByTestId('scope-trace')).toBeTruthy();
    expect(screen.getByTestId('scope-spectrum')).toBeTruthy();
    expect(screen.getByTestId('scope-view-both').getAttribute('aria-pressed')).toBe('true');
  });

  it('draws the captured tone: bars peak at the detected pitch', async () => {
    await renderScope(handleWith(tone, sine(440)));
    const spec = screen.getByTestId('scope-spectrum');
    expect(spec.querySelectorAll('.scope-bar').length).toBe(48);
    const peakHz = Number(spec.getAttribute('data-peak-hz'));
    expect(peakHz).toBeGreaterThan(380);
    expect(peakHz).toBeLessThan(510);
    expect(screen.getByTestId('scope-readout').textContent).toContain('440 Hz');
    expect(
      screen.getByTestId('scope-trace').querySelector('polyline')?.getAttribute('points'),
    ).toBeTruthy();
  });

  it('draws captured white noise as bars everywhere and no pitch', async () => {
    await renderScope(handleWith(noise, white()));
    const bars = [...screen.getByTestId('scope-spectrum').querySelectorAll('.scope-bar')];
    expect(bars).toHaveLength(48);
    for (const bar of bars) {
      expect(Number(bar.getAttribute('height'))).toBeGreaterThan(0);
    }
    // Noise has no fundamental to report, so no "1000 Hz" fiction.
    expect(screen.getByTestId('scope-readout').textContent).toContain('— Hz');
    expect(screen.getByTestId('scope-readout').textContent).toContain('rms 2.9 V');
  });

  it('an unwired scope shows an empty spectrum and a dashed readout', async () => {
    await renderScope(handleWith({}, new Float32Array(N)));
    const spec = screen.getByTestId('scope-spectrum');
    expect(spec.getAttribute('data-peak-hz')).toBe('');
    expect(screen.getByTestId('scope-readout').textContent).toContain('— Hz');
    for (const bar of spec.querySelectorAll('.scope-bar')) {
      expect(Number(bar.getAttribute('height'))).toBe(0);
    }
    // Silence is a flat line on the axis, not a shape.
    const trace = ys(
      screen.getByTestId('scope-trace').querySelector('polyline')?.getAttribute('points') ?? '',
    );
    expect(trace.length).toBeGreaterThan(0);
    for (const y of trace) expect(y).toBe(48);
  });

  it('survives a handle with no capture (the picker preview)', async () => {
    await renderScope({ paramValue: () => 0, signalTap: () => ({ display: 0 }) });
    expect(screen.getByTestId('scope-ui')).toBeTruthy();
    for (const bar of screen.getByTestId('scope-spectrum').querySelectorAll('.scope-bar')) {
      expect(Number(bar.getAttribute('height'))).toBe(0);
    }
  });

  it('draws the number of bars the bins input asks for', async () => {
    // The user-visible half of the control: the knob moves, the spectrum
    // is cut into that many bars. (`window` never did this — it is the
    // level followers' time constant, and the bars are unaffected by it.)
    const bars = () => screen.getByTestId('scope-spectrum').querySelectorAll('.scope-bar').length;
    await renderScope(handleWith(tone, sine(440)));
    expect(bars()).toBe(DEFAULT_BINS);
    expect(screen.getByTestId('scope-spectrum').getAttribute('data-bins')).toBe(
      String(DEFAULT_BINS),
    );
    cleanup();

    for (const count of [MIN_BINS, 96, MAX_BINS]) {
      await renderScope(handleWith(tone, sine(440), { bins: count }));
      expect(bars()).toBe(count);
      cleanup();
    }
    // The window knob is not a bin count, whatever it is set to.
    for (const window of [0.005, 0.5]) {
      await renderScope(handleWith(tone, sine(440), { window }));
      expect(bars()).toBe(DEFAULT_BINS);
      cleanup();
    }
  });

  it('keeps a patched bins CV inside the range it can draw', async () => {
    // The jack is patchable, so anything can arrive on it.
    expect(binCount(MIN_BINS - 40)).toBe(MIN_BINS);
    expect(binCount(MAX_BINS * 10)).toBe(MAX_BINS);
    expect(binCount(47.6)).toBe(48);
    expect(binCount(NaN)).toBe(DEFAULT_BINS);
    await renderScope(handleWith(tone, sine(440), { bins: 0 }));
    expect(screen.getByTestId('scope-spectrum').querySelectorAll('.scope-bar').length).toBe(
      MIN_BINS,
    );
  });

  it('the bins knob in the manifest matches what the panel draws', () => {
    const bins = scopeManifest.inputs.find((i) => i.id === 'bins');
    expect(bins?.default).toBe(DEFAULT_BINS);
    expect(bins?.knob).toMatchObject({
      style: 'stepped',
      min: MIN_BINS,
      max: MAX_BINS,
      steps: 17,
    });
  });

  it('toggles between wave-only and spectrum-only views', async () => {
    await renderScope(handleWith(tone, sine(440)));
    fireEvent.click(screen.getByTestId('scope-view-time'));
    expect(screen.getByTestId('scope-trace')).toBeTruthy();
    expect(screen.queryByTestId('scope-spectrum')).toBeNull();
    fireEvent.click(screen.getByTestId('scope-view-spectrum'));
    expect(screen.queryByTestId('scope-trace')).toBeNull();
    expect(screen.getByTestId('scope-spectrum')).toBeTruthy();
  });
});
