// Reusable live level meter: a horizontal bar plus a numeric readout for a
// single telemetry value (input CV, output level, gain reduction...).
// Values come from the module handle's signalTap — the batched 100 ms
// tap_all poll that already feeds jack glows — so meters add zero extra
// IPC. Panels re-render on each telemetry tick, so reading at render time
// keeps the bar live.

import { fixed, safeNumber } from '../format';
import type { JackTelemetry, ModuleHandle } from '../types';

export interface MeterSpec {
  /** Telemetry key: an input jack id, or `out:<jack>` for an output. */
  jack: string;
  label: string;
  /** Full-scale value for the bar (default 10 V). */
  max?: number;
  /** Readout formatter (default: volts with 2 decimals). */
  format?(value: number): string;
}

export function LevelMeter({ spec, telemetry }: { spec: MeterSpec; telemetry: JackTelemetry }) {
  const value = safeNumber(telemetry.display);
  const max = spec.max ?? 10;
  const frac = Math.min(1, Math.abs(value) / max);
  return (
    <div className="level-meter" data-testid={`meter-${spec.jack}`}>
      <span className="level-meter-label">{spec.label}</span>
      <span className="level-meter-track">
        <span className="level-meter-fill" style={{ width: `${frac * 100}%` }} />
      </span>
      <span className="level-meter-value" data-testid={`meter-value-${spec.jack}`}>
        {spec.format ? spec.format(value) : `${fixed(value)} V`}
      </span>
    </div>
  );
}

/** A stack of meters bound to a module handle — the shared custom-UI body
 *  for modules whose main job is a live level (VCA CV, compressor GR...). */
export function meterUI(specs: MeterSpec[]) {
  return function MeterPanel({ handle }: { handle: ModuleHandle }) {
    return (
      <div className="level-meters" data-testid="level-meters">
        {specs.map((spec) => (
          <LevelMeter key={spec.jack} spec={spec} telemetry={handle.signalTap(spec.jack)} />
        ))}
      </div>
    );
  };
}

const db = (v: number) => `${fixed(v)} dB`;

/** VCA: the CV level is the module's whole story — show it big, next to
 *  the resulting output level. */
export const VcaUI = meterUI([
  { jack: 'cv', label: 'cv' },
  { jack: 'out:out', label: 'out' },
]);

export const VcaDualUI = meterUI([
  { jack: 'cv1', label: 'cv 1' },
  { jack: 'cv2', label: 'cv 2' },
]);

/** Compressor gain reduction: `gr` is 0.5 V per dB (see the module docs). */
export const CompressorUI = meterUI([{ jack: 'out:gr', label: 'gr', format: (v) => db(v * 2) }]);

/** Mixer master output level. */
export const MixerUI = meterUI([{ jack: 'out:out', label: 'out' }]);

/** Filter cutoff CV (knob + wires summed at the jack). */
export const FilterUI = meterUI([{ jack: 'cutoff', label: 'cutoff' }]);
