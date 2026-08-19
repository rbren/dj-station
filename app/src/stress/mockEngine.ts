// Dev-only mock engine for the rendering stress harness (see index.ts).
//
// Fabricates N rack nodes from REAL extension manifests (so panel layouts,
// custom UIs, knob configs and jack counts match production), synthesizes
// wires between them, and answers the same IPC commands the Tauri backend
// does. Telemetry is generated per jack from deterministic per-jack
// oscillators evaluated at call time, so the App's normal 100 ms tap_all
// poll drives exactly the same store/render path as a live engine.

import type { Invoke } from '../ipc';
import type { NodeSnapshot, WireSnapshot } from '../engine';
import type { JackTelemetry, Manifest } from '../types';

import adsr from '../../../extensions/adsr/manifest.json';
import clock from '../../../extensions/clock/manifest.json';
import delay from '../../../extensions/delay/manifest.json';
import euclid from '../../../extensions/euclid/manifest.json';
import filter from '../../../extensions/filter/manifest.json';
import lfo from '../../../extensions/lfo/manifest.json';
import mixer from '../../../extensions/mixer/manifest.json';
import noise from '../../../extensions/noise/manifest.json';
import oscillator from '../../../extensions/oscillator/manifest.json';
import quantizer from '../../../extensions/quantizer/manifest.json';
import sampleHold from '../../../extensions/sample_hold/manifest.json';
import scope from '../../../extensions/scope/manifest.json';
import stepSeq from '../../../extensions/step_seq/manifest.json';
import turing from '../../../extensions/turing/manifest.json';
import vca from '../../../extensions/vca/manifest.json';
import waveshaper from '../../../extensions/waveshaper/manifest.json';

/** Representative type mix, heavy panels included (mixer: 25 inputs,
 *  step_seq: 56; lfo/scope run rAF canvas custom UIs). Cycled to fill N. */
const MANIFESTS = [
  oscillator,
  filter,
  vca,
  adsr,
  lfo,
  clock,
  noise,
  quantizer,
  waveshaper,
  sampleHold,
  euclid,
  turing,
  delay,
  scope,
  mixer,
  stepSeq,
] as unknown as Manifest[];

/** FNV-1a → [0, 1): deterministic per-jack randomness. */
function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

export interface StressOptions {
  /** Number of rack modules to fabricate. */
  modules: number;
  /** Fraction of jacks whose telemetry oscillates each tick (0..1). */
  activeFraction: number;
}

export interface MockEngine {
  invoke: Invoke;
  /** Live toggle ('t' key): 0 freezes all telemetry, restoring the
   *  configured fraction resumes it. */
  setActiveFraction(f: number): void;
  readonly options: StressOptions;
  counts(): { modules: number; wires: number; jacks: number };
}

function makeNodes(n: number): NodeSnapshot[] {
  return Array.from({ length: n }, (_, i) => {
    const manifest = MANIFESTS[i % MANIFESTS.length];
    const knobs: NodeSnapshot['knobs'] = {};
    for (const input of manifest.inputs) {
      if (input.knob) knobs[input.id] = { position: 0.5, atten: 0, offset: 0, wire_style: 'cv' };
    }
    return {
      instance_id: `stress-${i}-${manifest.id.replace(/^com\.dj\./, '')}`,
      type_id: manifest.id,
      manifest,
      knobs,
      params: {},
      wired_inputs: [] as string[],
      midi_mappings: [],
      midi_led_mappings: [],
    };
  });
}

/** Chain each module's first output to the next module's first input, plus
 *  a longer-range cross wire from every third module, so wire count scales
 *  ~1.3× with N and the wired-input blend path gets exercised. */
function makeWires(nodes: NodeSnapshot[]): WireSnapshot[] {
  const wires: WireSnapshot[] = [];
  const wire = (from: NodeSnapshot, to: NodeSnapshot, toInput: number) => {
    const out = from.manifest.outputs[0];
    const inp = to.manifest.inputs[toInput];
    if (!out || !inp) return;
    wires.push({
      from_instance: from.instance_id,
      from_jack: out.id,
      to_instance: to.instance_id,
      to_jack: inp.id,
    });
    if (!to.wired_inputs.includes(inp.id)) to.wired_inputs.push(inp.id);
  };
  for (let i = 0; i + 1 < nodes.length; i++) wire(nodes[i], nodes[i + 1], 0);
  for (let i = 0; i + 3 < nodes.length; i += 3) wire(nodes[i], nodes[i + 3], 1);
  return wires;
}

export function createMockEngine(options: StressOptions): MockEngine {
  const nodes = makeNodes(options.modules);
  const wires = makeWires(nodes);
  let activeFraction = options.activeFraction;
  const t0 = performance.now();
  let jackCount = 0;
  for (const n of nodes) jackCount += n.manifest.inputs.length + n.manifest.outputs.length;

  const telemetryFor = (instance: string, jack: string, t: number): JackTelemetry => {
    const seed = hash01(`${instance}:${jack}`);
    if (seed >= activeFraction) {
      // Static jack: constant value, exercises the slice-equality path.
      const v = seed * 10 - 5;
      return {
        instantaneous: v,
        rms_100ms: Math.abs(v) * 0.7,
        display: v,
        volatility: 0,
        is_fast: false,
      };
    }
    const freq = 0.2 + seed * 1.8; // 0.2..2 Hz — visibly moving indicators
    const phase = seed * Math.PI * 2;
    const display = 5 * Math.sin(2 * Math.PI * freq * t + phase);
    const volatility = 0.5 + 0.5 * Math.sin(0.3 * t + phase);
    return {
      instantaneous: display + Math.sin(31 * t + phase),
      rms_100ms: Math.abs(display) * 0.7,
      display,
      volatility,
      is_fast: volatility > 0.8,
    };
  };

  const tapAll = () => {
    const t = (performance.now() - t0) / 1000;
    const out: Record<string, Record<string, JackTelemetry>> = {};
    for (const n of nodes) {
      const jacks: Record<string, JackTelemetry> = {};
      for (const i of n.manifest.inputs) jacks[i.id] = telemetryFor(n.instance_id, i.id, t);
      for (const o of n.manifest.outputs) jacks[o.id] = telemetryFor(n.instance_id, o.id, t);
      out[n.instance_id] = jacks;
    }
    return out;
  };

  const invoke: Invoke = async (cmd, args) => {
    switch (cmd) {
      case 'engine_nodes':
        return nodes;
      case 'engine_wires':
        return wires;
      case 'tap_all':
        return tapAll();
      case 'tap': {
        const t = (performance.now() - t0) / 1000;
        return telemetryFor(args?.instance as string, args?.jack as string, t);
      }
      case 'set_knob_position': {
        const node = nodes.find((n) => n.instance_id === args?.instance);
        const jack = args?.jack as string;
        if (node) {
          const prev = node.knobs[jack] ?? { position: 0, atten: 0, offset: 0 };
          const knobs = { ...node.knobs, [jack]: { ...prev, position: args?.position as number } };
          nodes[nodes.indexOf(node)] = { ...node, knobs };
        }
        return null;
      }
      case 'set_knob_atten_offset': {
        const node = nodes.find((n) => n.instance_id === args?.instance);
        const jack = args?.jack as string;
        if (node) {
          const prev = node.knobs[jack] ?? { position: 0, atten: 0, offset: 0 };
          const knobs = {
            ...node.knobs,
            [jack]: { ...prev, atten: args?.atten as number, offset: args?.offset as number },
          };
          nodes[nodes.indexOf(node)] = { ...node, knobs };
        }
        return null;
      }
      case 'list_modules':
      case 'list_extensions':
        return MANIFESTS;
      case 'engine_start':
        return 'stress';
      case 'current_patch':
        return `stress ×${options.modules}`;
      case 'list_patches':
      case 'library_tracks':
        return [];
      case 'undo':
      case 'redo':
        return false;
      default:
        // load_demo_patch, end_edit, set_param, engine_stop, wire edits...
        // — accepted no-ops; the harness profiles rendering, not editing.
        return null;
    }
  };

  return {
    invoke,
    setActiveFraction(f) {
      activeFraction = f;
    },
    options,
    counts: () => ({ modules: nodes.length, wires: wires.length, jacks: jackCount }),
  };
}
