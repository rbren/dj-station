// Pins the TS knob curve math (src/components/Knob.tsx mapPosition /
// positionForValue) against a table of expected values computed from the
// engine's canonical implementation in crates/dj-engine/src/knob.rs
// (KnobConfig::map / position_for_value). There is no codegen between the
// two, so this table is the drift alarm: if either side's math changes,
// update BOTH sides (and ./scripts/regen-goldens.sh if manifests moved) or
// this test fails.
//
// KNOWN DIVERGENCES (documented, deliberately NOT pinned as matching):
// - Curve 'exp'/'log' with min > 0 && max > 0: knob.rs switches to
//   geometric interpolation (min * (max/min)^p and its inverse); the TS
//   side always uses the squared/sqrt fallback. The cases below use
//   min = 0 ranges, where both sides share the fallback formula.
// - Custom curves: knob.rs treats breakpoint y-values as final values;
//   the TS side treats them as normalized positions re-mapped through
//   min/max. The cases below use min=0/max=1 where the two coincide.

import { describe, expect, it } from 'vitest';
import { mapPosition, positionForValue } from '../src/components/Knob';
import type { KnobConfig } from '../src/types';

const LIN_0_10: KnobConfig = { style: 'continuous', min: 0, max: 10, curve: 'linear' };
const LIN_NEG: KnobConfig = { style: 'continuous', min: -5, max: 5, curve: 'linear' };
const EXP_0_10: KnobConfig = { style: 'continuous', min: 0, max: 10, curve: 'exp' };
const LOG_0_10: KnobConfig = { style: 'continuous', min: 0, max: 10, curve: 'log' };
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
    // log with min = 0: both sides use min + sqrt(p) * (max - min)
    ['log 0..10 @ 0.25', LOG_0_10, 0.25, 5],
    ['log 0..10 @ 0.04', LOG_0_10, 0.04, 2],
    ['log 0..10 @ 1', LOG_0_10, 1, 10],
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
    ['log 0..10 value 5', LOG_0_10, 5, 0.25],
    ['custom value 0.1', CUSTOM, 0.1, 0.25],
  ];
  for (const [name, config, value, expected] of cases) {
    it(name, () => {
      expect(positionForValue(config, value)).toBeCloseTo(expected, 5);
    });
  }

  it('round-trips through mapPosition on every curve', () => {
    // 4 decimal places: the binary search (40 iterations, like knob.rs)
    // leaves an epsilon at curve endpoints (e.g. exp value 0 at p=0).
    for (const config of [LIN_0_10, LIN_NEG, EXP_0_10, LOG_0_10, CUSTOM]) {
      for (const p of [0, 0.2, 0.5, 0.8, 1]) {
        const v = mapPosition(config, p);
        expect(mapPosition(config, positionForValue(config, v))).toBeCloseTo(v, 4);
      }
    }
  });
});
