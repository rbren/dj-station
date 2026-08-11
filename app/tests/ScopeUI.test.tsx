// Scope custom UI: the frequency-domain spectrum (real FFT of the
// harmonic model reconstructed from the scope's hz/peak/rms telemetry),
// the time-domain trace, and the wave / spectrum / both view toggle.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ScopeUI, {
  FFT_SIZE,
  SAMPLE_RATE,
  fftMag,
  harmonicAmps,
  spectrumBands,
  synthesizeWave,
} from '../../extensions/scope/ui-src/ScopeUI';

function handleWith(taps: Record<string, number>) {
  return {
    paramValue: () => 0,
    signalTap: (jackId: string) => ({ display: taps[jackId] ?? 0 }),
  };
}

describe('fftMag', () => {
  it('puts a sine of amplitude A at its bin with magnitude ~A', () => {
    const n = FFT_SIZE;
    const bin = 40;
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = 5 * Math.sin((2 * Math.PI * bin * i) / n);
    const mags = fftMag(buf);
    let argmax = 0;
    for (let k = 1; k < mags.length; k++) if (mags[k] > mags[argmax]) argmax = k;
    expect(argmax).toBe(bin);
    expect(mags[bin]).toBeCloseTo(5, 1);
    // Energy is concentrated: a far-away bin is way down.
    expect(mags[bin + 20]).toBeLessThan(0.05);
  });

  it('rejects non-power-of-two buffers', () => {
    expect(() => fftMag(new Float32Array(1000))).toThrow(/2\^k/);
  });
});

describe('synthesizeWave', () => {
  it('is silent when unvoiced or silent', () => {
    expect(synthesizeWave(0, 5, 3).every((v) => v === 0)).toBe(true);
    expect(synthesizeWave(440, 0, 0).every((v) => v === 0)).toBe(true);
  });

  it('matches the measured rms and concentrates energy at f0', () => {
    const f0 = 440;
    const buf = synthesizeWave(f0, 5, 5 / Math.SQRT2); // sine crest
    let sumSq = 0;
    for (const v of buf) sumSq += v * v;
    expect(Math.sqrt(sumSq / buf.length)).toBeCloseTo(5 / Math.SQRT2, 1);
    const mags = fftMag(buf);
    let argmax = 0;
    for (let k = 1; k < mags.length; k++) if (mags[k] > mags[argmax]) argmax = k;
    const binHz = SAMPLE_RATE / FFT_SIZE;
    expect(Math.abs(argmax * binHz - f0)).toBeLessThanOrEqual(binHz);
  });

  it('crest factor picks the harmonic character', () => {
    // Sine crest: fundamental only.
    const sine = harmonicAmps(Math.SQRT2);
    expect(sine[0]).toBe(1);
    expect(sine[1]).toBe(0);
    expect(sine[2]).toBe(0);
    // Square crest (1): odd harmonics 1/k.
    const square = harmonicAmps(1);
    expect(square[1]).toBe(0);
    expect(square[2]).toBeCloseTo(1 / 3);
    // Saw crest (sqrt 3): all harmonics 1/k.
    const saw = harmonicAmps(Math.sqrt(3));
    expect(saw[1]).toBeCloseTo(1 / 2);
    expect(saw[2]).toBeCloseTo(1 / 3);
  });
});

describe('spectrumBands', () => {
  it('folds a 440 Hz sine into a peak band near 440 Hz', () => {
    const bands = spectrumBands(fftMag(synthesizeWave(440, 5, 5 / Math.SQRT2)));
    const best = bands.reduce((a, b) => (b.db > a.db ? b : a));
    expect(best.hz).toBeGreaterThan(350);
    expect(best.hz).toBeLessThan(550);
    // dB relative to 10 V: a 5 * sqrt2 amplitude sine sits well above floor.
    expect(best.db).toBeGreaterThan(-12);
  });
});

describe('ScopeUI', () => {
  // hz output is 1 V per 100 Hz -> 4.4 V = 440 Hz.
  const voiced = { 'out:hz': 4.4, 'out:peak': 5, 'out:rms': 5 / Math.SQRT2 };

  it('shows both the trace and the spectrum by default', () => {
    render(<ScopeUI handle={handleWith(voiced)} />);
    expect(screen.getByTestId('scope-trace')).toBeTruthy();
    expect(screen.getByTestId('scope-spectrum')).toBeTruthy();
    expect(screen.getByTestId('scope-view-both').getAttribute('aria-pressed')).toBe('true');
  });

  it('renders spectrum bars with the peak band near the detected pitch', () => {
    render(<ScopeUI handle={handleWith(voiced)} />);
    const spec = screen.getByTestId('scope-spectrum');
    expect(spec.querySelectorAll('.scope-bar').length).toBe(48);
    const peakHz = Number(spec.getAttribute('data-peak-hz'));
    expect(peakHz).toBeGreaterThan(350);
    expect(peakHz).toBeLessThan(550);
    expect(screen.getByTestId('scope-readout').textContent).toContain('440 Hz');
  });

  it('toggles between wave-only and spectrum-only views', () => {
    render(<ScopeUI handle={handleWith(voiced)} />);
    fireEvent.click(screen.getByTestId('scope-view-time'));
    expect(screen.getByTestId('scope-trace')).toBeTruthy();
    expect(screen.queryByTestId('scope-spectrum')).toBeNull();
    fireEvent.click(screen.getByTestId('scope-view-spectrum'));
    expect(screen.queryByTestId('scope-trace')).toBeNull();
    expect(screen.getByTestId('scope-spectrum')).toBeTruthy();
  });

  it('unvoiced input shows an empty spectrum and a dashed readout', () => {
    render(<ScopeUI handle={handleWith({ 'out:hz': 0, 'out:peak': 0, 'out:rms': 0 })} />);
    const spec = screen.getByTestId('scope-spectrum');
    expect(spec.getAttribute('data-peak-hz')).toBe('');
    expect(screen.getByTestId('scope-readout').textContent).toContain('— Hz');
    // All bars at the floor: zero height.
    for (const bar of spec.querySelectorAll('.scope-bar')) {
      expect(Number(bar.getAttribute('height'))).toBe(0);
    }
  });
});
