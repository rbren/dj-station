// Display-value mapping (src/display.ts): raw engine values -> the strings
// knob and jack tooltips show. Also pins the manifests' declared display
// specs to the DSP/UI facts they describe: the LFO rate readout is the
// true frequency, and step-label lists match the extension UIs' own name
// tables (QuantizerUI / LfoUI), so there is one source of names.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import clockMultJson from '../../extensions/clock_mult/manifest.json';
import lfoJson from '../../extensions/lfo/manifest.json';
import { SHAPES } from '../../extensions/lfo/ui-src/LfoUI';
import oscJson from '../../extensions/oscillator/manifest.json';
import quantizerJson from '../../extensions/quantizer/manifest.json';
import { NOTE_NAMES, SCALE_NAMES } from '../../extensions/quantizer/ui-src/QuantizerUI';
import turingJson from '../../extensions/turing/manifest.json';
import { mapPosition } from '../src/components/Knob';
import {
  displayNumber,
  formatDisplay,
  stepLabel,
  THIRD_SNAP_EPS,
  V_OCT_BASE,
} from '../src/display';
import type { DisplaySpec, JackDecl, KnobConfig, Manifest } from '../src/types';

// JSON imports infer literal-ish structural types; go through the real
// Manifest type so the specs are exercised as the app sees them.
const CLOCK_MULT = clockMultJson as unknown as Manifest;
const LFO = lfoJson as unknown as Manifest;
const OSC = oscJson as unknown as Manifest;
const QUANTIZER = quantizerJson as unknown as Manifest;
const TURING = turingJson as unknown as Manifest;

const input = (m: Manifest, id: string): JackDecl => {
  const decl = m.inputs.find((i) => i.id === id);
  if (!decl) throw new Error(`no input ${id}`);
  return decl;
};

describe('formatDisplay', () => {
  it('defaults to Volts when no spec is declared', () => {
    expect(formatDisplay(undefined, 3)).toBe('3.00 V');
    expect(formatDisplay(null, -10)).toBe('-10.0 V');
  });

  it('shrinks digits as the number grows', () => {
    const hz: DisplaySpec = { unit: 'Hz' };
    expect(formatDisplay(hz, 0.25)).toBe('0.25 Hz');
    expect(formatDisplay(hz, 12.34)).toBe('12.3 Hz');
    expect(formatDisplay(hz, 2000)).toBe('2000 Hz');
  });

  it('empty unit means unitless; ":" units attach without a space', () => {
    expect(formatDisplay({ unit: '' }, 0.5)).toBe('0.50');
    expect(formatDisplay({ unit: ':1' }, 4)).toBe('4.00:1');
  });

  it('never throws on non-finite values (engine JSON nulls)', () => {
    expect(formatDisplay({ unit: 'Hz' }, NaN)).toBe('—');
    expect(formatDisplay(undefined, Infinity)).toBe('—');
  });

  it('volt_per_octave maps 1 V/oct around middle C', () => {
    const spec: DisplaySpec = { unit: 'Hz', map: { kind: 'volt_per_octave' } };
    expect(displayNumber(spec, 0)).toBeCloseTo(V_OCT_BASE, 3);
    expect(displayNumber(spec, 1)).toBeCloseTo(2 * V_OCT_BASE, 3);
    expect(formatDisplay(spec, -1)).toBe('131 Hz');
    // explicit base (e.g. A440 tuning)
    expect(displayNumber({ unit: 'Hz', map: { kind: 'volt_per_octave', base: 440 } }, 1)).toBe(880);
  });

  it('clock_ratio reads as a multiplier, with exact thirds as fractions', () => {
    const mult = input(CLOCK_MULT, 'mult');
    const spec = mult.display!;
    expect(spec.map?.kind).toBe('clock_ratio');
    expect(formatDisplay(spec, 1)).toBe('1x');
    expect(formatDisplay(spec, 4)).toBe('4x');
    expect(formatDisplay(spec, -2)).toBe('-2x');
    expect(formatDisplay(spec, 2.5)).toBe('2.50x');
    // The knob's decimal thirds ARE exact thirds in the DSP, so they read
    // as fractions rather than as 0.33x.
    expect(formatDisplay(spec, 0.333)).toBe('1/3');
    expect(formatDisplay(spec, 0.667)).toBe('2/3');
    expect(formatDisplay(spec, 0.666)).toBe('2/3');
    expect(formatDisplay(spec, -0.333)).toBe('-1/3');
    expect(formatDisplay(spec, 4.667)).toBe('14/3');
    // Just outside the snap window it is an ordinary decimal ratio.
    expect(formatDisplay(spec, 0.34)).toBe('0.34x');
  });

  it('the third-snap window matches the Clock Multiplier DSP', () => {
    // A readout that disagreed with the grid the module runs would be
    // worse than none: both sides use the same epsilon.
    const dsp = readFileSync(join(__dirname, '../../extensions/clock_mult/src/lib.rs'), 'utf8');
    const eps = dsp.match(/const THIRD_SNAP_EPS: f32 = ([\d.]+);/);
    expect(eps).toBeTruthy();
    expect(Number(eps![1])).toBe(THIRD_SNAP_EPS);
  });

  it('stepped inputs with labels show the step name, via the knob range', () => {
    const scale = input(QUANTIZER, 'scale');
    const config = scale.knob as KnobConfig;
    const display = scale.display!;
    expect(formatDisplay(display, 0, config)).toBe('custom');
    expect(formatDisplay(display, 1, config)).toBe('major');
    expect(formatDisplay(display, 9, config)).toBe('whole tone');
    // out-of-range telemetry clamps instead of vanishing
    expect(formatDisplay(display, 42, config)).toBe('whole tone');
    expect(formatDisplay(display, -3, config)).toBe('custom');
    // without a config the index is round(value) — how the DSP reads it
    expect(stepLabel(display, 2.4)).toBe('minor');
  });

  it('step index accounts for non-zero knob minimums', () => {
    // turing length: stepped 1..16 — value 1 is step 0
    const length = input(TURING, 'length');
    const labels = { steps: Array.from({ length: 16 }, (_, i) => `s${i}`) };
    expect(stepLabel(labels, 1, length.knob)).toBe('s0');
    expect(stepLabel(labels, 16, length.knob)).toBe('s15');
  });
});

describe('manifest display declarations', () => {
  it('LFO rate displays the true frequency: knob value == Hz, identity map', () => {
    const rate = input(LFO, 'rate');
    expect(rate.display).toEqual({ unit: 'Hz' });
    // The regression this scheme fixes: at the knob position whose engine
    // value is 1 Hz, the tooltip must read 1 Hz (the old TS exp curve
    // showed ~285 here — see KnobMath.test.ts for the curve pin).
    const config = rate.knob as KnobConfig;
    const p = Math.log(1 / config.min) / Math.log(config.max / config.min);
    expect(formatDisplay(rate.display, mapPosition(config, p), config)).toBe('1.00 Hz');
  });

  it('quantizer scale/root labels match the QuantizerUI name tables', () => {
    const m = QUANTIZER;
    expect(input(m, 'scale').display?.steps).toEqual(SCALE_NAMES);
    expect(input(m, 'root').display?.steps).toEqual(NOTE_NAMES);
  });

  it('LFO shape labels match the LfoUI readout table', () => {
    expect(input(LFO, 'shape').display?.steps).toEqual([...SHAPES]);
  });

  it('oscillator waveform labels follow the DSP order (sine saw square tri)', () => {
    expect(input(OSC, 'waveform').display?.steps).toEqual(['sine', 'saw', 'square', 'tri']);
  });
});
