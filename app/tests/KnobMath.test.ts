// Pins the TS knob curve math (src/components/Knob.tsx mapPosition /
// positionForValue) against a table of expected values computed from the
// engine's canonical implementation in crates/dj-engine/src/knob.rs
// (KnobConfig::map / position_for_value). There is no codegen between the
// two, so this table is the drift alarm: if either side's math changes,
// update BOTH sides (and ./scripts/regen-goldens.sh if manifests moved) or
// this test fails.
//
// KNOWN DIVERGENCES (documented, deliberately NOT pinned as matching):
// - Custom curves: knob.rs treats breakpoint y-values as final values;
//   the TS side treats them as normalized positions re-mapped through
//   min/max. The cases below use min=0/max=1 where the two coincide.
//
// Curve 'exp'/'log' with min > 0 && max > 0 WAS such a divergence: knob.rs
// switches to geometric interpolation (min * (max/min)^p and the expm1
// inverse) while the TS side used the squared/sqrt fallback everywhere.
// That mismatch was the LFO displayed-rate bug — a rate knob whose engine
// value was 1 Hz displayed as ~285 — and is now pinned as matching below
// (EXP_GEO / LOG_GEO / RATE cases).

import { describe, expect, it } from 'vitest';
import {
  attenOffsetForSpread,
  mapPosition,
  positionForValue,
  spreadRange,
} from '../src/components/Knob';
import type { KnobConfig } from '../src/types';

const LIN_0_10: KnobConfig = { style: 'continuous', min: 0, max: 10, curve: 'linear' };
const LIN_NEG: KnobConfig = { style: 'continuous', min: -5, max: 5, curve: 'linear' };
const EXP_0_10: KnobConfig = { style: 'continuous', min: 0, max: 10, curve: 'exp' };
const LOG_0_10: KnobConfig = { style: 'continuous', min: 0, max: 10, curve: 'log' };
const EXP_GEO: KnobConfig = { style: 'continuous', min: 1, max: 100, curve: 'exp' };
const LOG_GEO: KnobConfig = { style: 'continuous', min: 1, max: 100, curve: 'log' };
/** The LFO rate knob's manifest config — the displayed-rate bug's config. */
const RATE: KnobConfig = { style: 'continuous', min: 0.01, max: 2000, curve: 'exp' };
const STEP_5: KnobConfig = { style: 'stepped', min: 0, max: 10, curve: 'linear', steps: 5 };
const SWITCH: KnobConfig = { style: 'switch', min: 0, max: 1, curve: 'linear' };
const CUSTOM: KnobConfig = {
  style: 'continuous',
  min: 0,
  max: 1,
  curve: {
    custom: [
      [0, 0],
      [0.5, 0.2],
      [1, 1],
    ],
  },
};

describe('mapPosition matches knob.rs KnobConfig::map', () => {
  // Each row: [config, position, expected value from KnobConfig::map].
  const cases: [string, KnobConfig, number, number][] = [
    // linear: min + p * (max - min); positions clamp to 0..1
    ['linear 0..10 @ 0', LIN_0_10, 0, 0],
    ['linear 0..10 @ 0.25', LIN_0_10, 0.25, 2.5],
    ['linear 0..10 @ 1', LIN_0_10, 1, 10],
    ['linear 0..10 clamps > 1', LIN_0_10, 1.5, 10],
    ['linear 0..10 clamps < 0', LIN_0_10, -0.5, 0],
    ['linear -5..5 @ 0.5', LIN_NEG, 0.5, 0],
    ['linear -5..5 @ 0.75', LIN_NEG, 0.75, 2.5],
    // exp with min = 0: both sides use min + p^2 * (max - min)
    ['exp 0..10 @ 0.5', EXP_0_10, 0.5, 2.5],
    ['exp 0..10 @ 0.25', EXP_0_10, 0.25, 0.625],
    ['exp 0..10 @ 1', EXP_0_10, 1, 10],
    // exp with min > 0: geometric interpolation min * (max/min)^p
    ['exp 1..100 @ 0', EXP_GEO, 0, 1],
    ['exp 1..100 @ 0.5', EXP_GEO, 0.5, 10],
    ['exp 1..100 @ 1', EXP_GEO, 1, 100],
    ['exp 0.01..2000 @ 0.25', RATE, 0.25, 0.2114743],
    ['exp 0.01..2000 @ 0.5', RATE, 0.5, 4.4721359],
    // The bug position: engine value 1 Hz; the squared fallback showed
    // ~284.7 here.
    ['exp 0.01..2000 @ 0.3772852 (1 Hz)', RATE, 0.3772852, 1],
    // log with min = 0: both sides use min + sqrt(p) * (max - min)
    ['log 0..10 @ 0.25', LOG_0_10, 0.25, 5],
    ['log 0..10 @ 0.04', LOG_0_10, 0.04, 2],
    ['log 0..10 @ 1', LOG_0_10, 1, 10],
    // log with min > 0: expm1 interpolation (inverse of the exp map)
    ['log 1..100 @ 0.25', LOG_GEO, 0.25, 3.1622777],
    ['log 1..100 @ 0.5', LOG_GEO, 0.5, 10],
    ['log 1..100 @ 1', LOG_GEO, 1, 100],
    // stepped: round(p * (steps-1)) / (steps-1), then linear map
    ['stepped 5 @ 0.3', STEP_5, 0.3, 2.5],
    ['stepped 5 @ 0.4', STEP_5, 0.4, 5],
    ['stepped 5 @ 0.9', STEP_5, 0.9, 10],
    // switch/button: p >= 0.5 -> max else min
    ['switch @ 0.49', SWITCH, 0.49, 0],
    ['switch @ 0.5', SWITCH, 0.5, 1],
    // custom breakpoints with min=0/max=1 (where both sides coincide):
    // piecewise-linear through (0,0) (0.5,0.2) (1,1)
    ['custom @ 0.25', CUSTOM, 0.25, 0.1],
    ['custom @ 0.5', CUSTOM, 0.5, 0.2],
    ['custom @ 0.75', CUSTOM, 0.75, 0.6],
  ];
  for (const [name, config, position, expected] of cases) {
    it(name, () => {
      expect(mapPosition(config, position)).toBeCloseTo(expected, 5);
    });
  }
});

describe('positionForValue matches knob.rs position_for_value', () => {
  // knob.rs inverts linear/continuous maps exactly and binary-searches the
  // rest (40 iterations); the TS side binary-searches everything. Both
  // land on the same position to well past 5 decimal places.
  const cases: [string, KnobConfig, number, number][] = [
    ['linear 0..10 value 2.5', LIN_0_10, 2.5, 0.25],
    ['linear 0..10 value 0', LIN_0_10, 0, 0],
    ['linear 0..10 value 10', LIN_0_10, 10, 1],
    ['linear -5..5 value 0', LIN_NEG, 0, 0.5],
    ['exp 0..10 value 2.5', EXP_0_10, 2.5, 0.5],
    ['exp 1..100 value 10', EXP_GEO, 10, 0.5],
    ['exp 0.01..2000 value 1 (the 1 Hz LFO)', RATE, 1, 0.3772852],
    ['log 0..10 value 5', LOG_0_10, 5, 0.25],
    ['log 1..100 value 10', LOG_GEO, 10, 0.5],
    ['custom value 0.1', CUSTOM, 0.1, 0.25],
    // Two-position styles resolve to an END, never the snap threshold.
    ['switch 0..1 value 1 (a default-on switch)', SWITCH, 1, 1],
    ['switch 0..1 value 0', SWITCH, 0, 0],
  ];
  for (const [name, config, value, expected] of cases) {
    it(name, () => {
      expect(positionForValue(config, value)).toBeCloseTo(expected, 5);
    });
  }

  it('round-trips through mapPosition on every curve', () => {
    // 4 decimal places: the binary search (40 iterations, like knob.rs)
    // leaves an epsilon at curve endpoints (e.g. exp value 0 at p=0).
    for (const config of [LIN_0_10, LIN_NEG, EXP_0_10, LOG_0_10, EXP_GEO, LOG_GEO, RATE, CUSTOM]) {
      for (const p of [0, 0.2, 0.5, 0.8, 1]) {
        const v = mapPosition(config, p);
        expect(mapPosition(config, positionForValue(config, v))).toBeCloseTo(v, 4);
      }
    }
  });
});

describe('spreadRange matches the engine wired-blend laws (graph.rs)', () => {
  // Positional (knob-backed) law: value = curve(clamp01(base_pos +
  // signal * atten / 10 + offset)) for a ±5 V full-scale signal. Each row:
  // [config, position, atten, offset, expected min, expected max].
  const cases: [string, KnobConfig, number, number, number, number, number][] = [
    // Linear 0..10 span: identical to the old additive ±5·atten law.
    ['linear 0..10 centred, atten 1', LIN_0_10, 0.5, 1, 0, 0, 10],
    ['linear 0..10 centred, atten 0.4', LIN_0_10, 0.5, 0.4, 0, 3, 7],
    ['linear -5..5 pitch, atten 0.2', LIN_NEG, 0.5, 0.2, 0, -1, 1],
    // Position offset shifts the band before mapping.
    ['linear 0..10 offset +0.15', LIN_0_10, 0.5, 0.4, 0.15, 4.5, 8.5],
    // Exp rate knob: the band is geometric around the baseline
    // (mid = sqrt(0.01·2000) ≈ 4.472; ±quarter travel = ratio 21.147).
    [
      'exp rate centred, atten 0.5',
      RATE,
      0.5,
      0.5,
      0,
      4.4721359 / 21.1474253,
      4.4721359 * 21.1474253,
    ],
    // Full atten from centre reaches both endpoints (clamped travel).
    ['exp rate centred, atten 1', RATE, 0.5, 1, 0, 0.01, 2000],
    // Negative atten reverses the wire but not the displayed range.
    ['linear 0..10 atten -0.4', LIN_0_10, 0.5, -0.4, 0, 3, 7],
  ];
  for (const [name, config, position, atten, offset, min, max] of cases) {
    it(name, () => {
      const s = spreadRange(config, position, atten, offset);
      expect(s.min).toBeCloseTo(min, 4);
      expect(s.max).toBeCloseTo(max, 4);
    });
  }

  it('plain wire jacks keep the additive value-space law', () => {
    // baseline 5 V + signal·0.4 for ±5 V: 3..7, offset in value units.
    const s = spreadRange(LIN_0_10, 0.5, 0.4, 1.0, true);
    expect(s.min).toBeCloseTo(4, 5);
    expect(s.max).toBeCloseTo(8, 5);
  });

  it('attenOffsetForSpread inverts spreadRange (both laws)', () => {
    const rows: [KnobConfig, number, number, boolean][] = [
      [LIN_0_10, 2, 8, false],
      [LIN_NEG, -3, 1, false],
      [RATE, 2, 8, false],
      [LIN_0_10, 2, 8, true],
    ];
    for (const [config, min, max, plain] of rows) {
      const { atten, offset } = attenOffsetForSpread(config, 0.5, min, max, plain);
      const s = spreadRange(config, 0.5, atten, offset, plain);
      expect(s.min).toBeCloseTo(min, 3);
      expect(s.max).toBeCloseTo(max, 3);
    }
  });
});
