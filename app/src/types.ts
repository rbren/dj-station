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

/** How a wired input treats the incoming signal (knob.rs docs):
 *  'cv' (default) blends it with the knob baseline; 'override' makes the
 *  signal the value (knob inert), clamped to the knob's range. */
export type WireStyle = 'cv' | 'override';

export interface KnobState {
  position: number;
  atten: number;
  offset: number;
  wire_style?: WireStyle;
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
  /** Audio pass-through jack: renders as a plain jack with no manual
   *  control and no CV/attenuverter settings (values only arrive by wire). */
  audio?: boolean;
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
  /** Bypass routing: output jack id -> the input jack id it passes
   *  through untouched while the module is bypassed. A non-empty map is
   *  what makes a module bypassable (the title bar's ⏻ toggle). */
  bypass?: Record<string, string>;
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

/** A window of raw samples from a `capture` jack, as the engine sends it. */
export interface CaptureWindow {
  sample_rate: number;
  samples: number[];
}

/** Handle passed to custom extension UIs (PRD §5.3). */
export interface ModuleHandle {
  paramValue(id: string): ParamValue;
  setParam(id: string, v: ParamValue): void;
  signalTap(jackId: string): JackTelemetry;
  /** The signal ITSELF on a manifest `capture` jack — for the panels that
   *  draw it (the Scope). Absent on the picker's inert preview handle. */
  capture?(jackId: string): Promise<{ sampleRate: number; samples: Float32Array } | null>;
  /** End of an edit gesture (drag release) — undo step boundary. */
  endEdit?(): void;
  size: { w: number; h: number };
}
