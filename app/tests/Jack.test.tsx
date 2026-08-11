// Jack value-indicator color language: neutral gray near 0 V, ramping to
// saturated blue at +10 V / orange-red at −10 V, and a distinct pulsing
// pure red for signals fluctuating faster than the 10 Hz display smoothing
// (deeper red = more volatile).

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { indicatorStyle, Jack } from '../src/components/Jack';
import type { JackTelemetry } from '../src/types';

function t(partial: Partial<JackTelemetry>): JackTelemetry {
  return { instantaneous: 0, rms_100ms: 0, display: 0, volatility: 0, is_fast: false, ...partial };
}

function hsl(color: string): { h: number; s: number; l: number } {
  const m = color.match(/hsl\((\d+), (\d+)%, (\d+)%\)/);
  if (!m) throw new Error(`not hsl: ${color}`);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
}

describe('indicatorStyle', () => {
  it('renders near-zero values as neutral gray, not a dim blue/red', () => {
    for (const display of [0, 0.05, -0.05]) {
      const { color, volatile } = indicatorStyle(t({ display }));
      expect(volatile).toBe(false);
      expect(hsl(color).s).toBeLessThan(15); // desaturated = gray
    }
  });

  it('ramps positive values to saturated blue at +10 V', () => {
    const half = hsl(indicatorStyle(t({ display: 5 })).color);
    const full = hsl(indicatorStyle(t({ display: 10 })).color);
    expect(half.h).toBe(210);
    expect(full.h).toBe(210);
    expect(full.s).toBe(100);
    expect(full.s).toBeGreaterThan(half.s);
    expect(half.s).toBeGreaterThan(40); // 5 V is clearly colored, not faint
  });

  it('ramps negative values to saturated orange-red at -10 V', () => {
    const full = hsl(indicatorStyle(t({ display: -10 })).color);
    expect(full.h).toBe(18); // orange-red, distinct from volatile pure red
    expect(full.s).toBe(100);
  });

  it('volatile signals go pure red, deeper with more volatility', () => {
    const v11 = indicatorStyle(t({ display: 3.5, volatility: 0.4, is_fast: true }));
    const v60 = indicatorStyle(t({ display: 3.5, volatility: 1, is_fast: true }));
    expect(v11.volatile).toBe(true);
    expect(v60.volatile).toBe(true);
    const c11 = hsl(v11.color);
    const c60 = hsl(v60.color);
    expect(c11.h).toBe(0);
    expect(c60.h).toBe(0);
    expect(c60.s).toBeGreaterThan(c11.s); // 60 Hz more saturated than 11 Hz
    expect(c60.l).toBeLessThan(c11.l); // and deeper
  });

  it('volatility wins over the signed-value color', () => {
    const { volatile, color } = indicatorStyle(t({ display: -8, volatility: 0.9, is_fast: true }));
    expect(volatile).toBe(true);
    expect(hsl(color).h).toBe(0);
  });
});

describe('Jack indicator rendering', () => {
  it('applies the color and pulse class to the glow, and flags the tooltip', () => {
    render(
      <Jack
        instance="m1"
        id="cv"
        kind="input"
        telemetry={t({ display: 3.5, rms_100ms: 3.5, volatility: 0.8, is_fast: true })}
      />,
    );
    const glow = screen.getByTestId('jack-glow-cv');
    expect(glow.className).toContain('jack-glow-volatile');
    expect(glow.getAttribute('data-indicator')).toMatch(/^hsl\(0, /);
    expect(screen.getByTestId('jack-input-cv').getAttribute('data-tip')).toContain('>10 Hz');
  });

  it('output jacks show the same telemetry treatment as inputs', () => {
    render(<Jack instance="m1" id="out" kind="output" telemetry={t({ display: 10 })} />);
    const glow = screen.getByTestId('jack-glow-out');
    expect(glow.getAttribute('data-indicator')).toBe('hsl(210, 100%, 52%)');
    expect(screen.getByTestId('jack-output-out').getAttribute('data-tip')).toBe('out: 10.00');
  });

  it('no telemetry leaves the CSS fallback (no inline style)', () => {
    render(<Jack instance="m1" id="cv" kind="input" />);
    expect(screen.getByTestId('jack-glow-cv').getAttribute('data-indicator')).toBeNull();
  });
});
