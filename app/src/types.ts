// Shared types mirroring the engine's manifest / knob / telemetry model.

export type KnobStyle = 'continuous' | 'switch' | 'button' | 'stepped' | 'wire';
export type CurveName = 'linear' | 'exp' | 'log';

export interface KnobConfig {
  style: KnobStyle;
  min: number;
  max: number;
  curve: CurveName | { custom: [number, number][] };
  steps?: number;
}

export interface KnobState {
  position: number;
  atten: number;
  offset: number;
  config?: KnobConfig | null;
}

/** Display transform from raw engine value to human-readable number
 *  (mirrors `DisplayMap` in crates/dj-engine/src/manifest.rs). */
export type DisplayMap = { kind: 'volt_per_octave'; base?: number };

/** How a jack's value reads to a human: unit suffix, optional transform,
 *  optional per-step labels for stepped inputs. Absent = raw Volts.
 *  (Mirrors `DisplaySpec` in crates/dj-engine/src/manifest.rs.) */
export interface DisplaySpec {
  /** Unit suffix ("Hz", "s", "dB", ...). Undefined = "V"; "" = unitless. */
  unit?: string;
  map?: DisplayMap;
  /** Labels for stepped inputs, index = step. */
  steps?: string[];
}

export interface JackDecl {
  id: string;
  name: string;
  default?: number;
  knob?: KnobConfig | null;
  display?: DisplaySpec | null;
}

export interface OutputDecl {
  id: string;
  name: string;
  display?: DisplaySpec | null;
}

export interface ParamDecl {
  id: string;
  name: string;
  type?: string;
  default?: number | boolean;
  min?: number;
  max?: number;
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  abi: string;
  /** Library grouping ("Sources", "Shaping", ...). */
  category?: string;
  inputs: JackDecl[];
  outputs: OutputDecl[];
  params: ParamDecl[];
  ui?: string | null;
}

export interface JackTelemetry {
  instantaneous: number;
  rms_100ms: number;
  /** Low-pass smoothed value for display (100 ms mean, RMS when fast). */
  display: number;
  /** 0..1 — how much fast (>10 Hz) fluctuation the display value hides. */
  volatility: number;
  is_fast: boolean;
}

export type ParamValue = number;

/** Handle passed to custom extension UIs (PRD §5.3). */
export interface ModuleHandle {
  paramValue(id: string): ParamValue;
  setParam(id: string, v: ParamValue): void;
  signalTap(jackId: string): JackTelemetry;
  /** End of an edit gesture (drag release) — undo step boundary. */
  endEdit?(): void;
  size: { w: number; h: number };
}
