// Display-value mapping: raw engine values -> human-meaningful readouts.
//
// Every jack value is a voltage to the engine; a manifest may declare a
// `display` spec per input/output (unit suffix, value transform, per-step
// labels) and this module turns raw values into the strings shown by knob
// and jack tooltips. No display declaration = plain Volts. Mirrors
// `DisplaySpec` / `DisplayMap` in crates/dj-engine/src/manifest.rs.

import { fixed } from './format';
import type { DisplaySpec, KnobConfig } from './types';

/** Unit shown when a manifest declares none. */
export const DEFAULT_UNIT = 'V';

/** Middle C (C4) — `dj_module_sdk::pitch_to_hz(0.0)`; the default base of
 *  the `volt_per_octave` map. */
export const V_OCT_BASE = 261.626;

/** Raw engine value -> displayed number through the spec's map. */
export function displayNumber(display: DisplaySpec | null | undefined, value: number): number {
  const map = display?.map;
  if (map?.kind === 'volt_per_octave') return (map.base ?? V_OCT_BASE) * Math.pow(2, value);
  return value;
}

/** Displayed number -> raw engine value (inverse of `displayNumber`), so
 *  direct entry accepts values in the same units the tooltip shows. */
export function displayToRaw(display: DisplaySpec | null | undefined, shown: number): number {
  const map = display?.map;
  if (map?.kind === 'volt_per_octave') {
    if (!(shown > 0)) return NaN;
    return Math.log2(shown / (map.base ?? V_OCT_BASE));
  }
  return shown;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Equal-tempered note table for Hz-displaying knobs' note picker:
 *  C0 (MIDI 12) through B8 (MIDI 119), A4 = 440 Hz. */
export function noteOptions(): { name: string; hz: number }[] {
  const notes: { name: string; hz: number }[] = [];
  for (let midi = 12; midi <= 119; midi++) {
    notes.push({
      name: `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`,
      hz: 440 * Math.pow(2, (midi - 69) / 12),
    });
  }
  return notes;
}

/** Step label for a raw value, or null when the spec declares none. The
 *  step index comes from the knob range when known (labels.length spans
 *  min..max, matching the stepped knob's detents), else from round(value)
 *  — the way the DSPs themselves read selector inputs. */
export function stepLabel(
  display: DisplaySpec | null | undefined,
  value: number,
  config?: KnobConfig | null,
): string | null {
  const labels = display?.steps;
  if (!labels || labels.length === 0) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const idx =
    config && config.max !== config.min
      ? Math.round(((value - config.min) / (config.max - config.min)) * (labels.length - 1))
      : Math.round(value);
  return labels[Math.min(labels.length - 1, Math.max(0, idx))];
}

/** Digits shrink as the number grows ("0.25 s", "12.3 Hz", "2000 Hz"). */
function digitsFor(v: number): number {
  const a = Math.abs(v);
  if (a >= 100) return 0;
  if (a >= 10) return 1;
  return 2;
}

/** The one value formatter shared by knob and jack tooltips, inputs and
 *  outputs alike: "3.00 V", "440 Hz", "0.25 s", "4.00:1" or a step label
 *  ("major"). Unusable input renders as "—". */
export function formatDisplay(
  display: DisplaySpec | null | undefined,
  value: number,
  config?: KnobConfig | null,
): string {
  const label = stepLabel(display, value, config);
  if (label !== null) return label;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fixed(value);
  const v = displayNumber(display, value);
  const unit = display?.unit ?? DEFAULT_UNIT;
  const num = fixed(v, digitsFor(v));
  if (!unit) return num;
  return unit.startsWith(':') ? `${num}${unit}` : `${num} ${unit}`;
}
