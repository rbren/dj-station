// Bridge to the Rust engine over Tauri IPC. Falls back to a no-op stub when
// running outside Tauri (vite dev server / tests), so the UI stays testable
// headless.

import type { JackTelemetry, KnobConfig, Manifest } from './types';

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

async function tauriInvoke(): Promise<Invoke | null> {
  if (!('__TAURI_INTERNALS__' in window)) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke as Invoke;
}

export interface MidiMapping {
  name: string;
  kind: string;
  num: number;
}

export interface NodeSnapshot {
  instance_id: string;
  type_id: string;
  manifest: Manifest;
  knobs: Record<string, { position: number; atten: number; offset: number }>;
  params: Record<string, number>;
  wired_inputs: string[];
  midi_mappings: MidiMapping[];
}

export interface WireSnapshot {
  from_instance: string;
  from_jack: string;
  to_instance: string;
  to_jack: string;
}

export class EngineClient {
  private invoke: Invoke | null = null;
  private ready: Promise<void>;

  constructor() {
    this.ready = tauriInvoke().then((inv) => {
      this.invoke = inv;
    });
  }

  private async call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
    await this.ready;
    if (!this.invoke) return null;
    return (await this.invoke(cmd, args)) as T;
  }

  listExtensions() {
    return this.call<Manifest[]>('list_extensions');
  }
  listModules() {
    return this.call<Manifest[]>('list_modules');
  }
  nodes() {
    return this.call<NodeSnapshot[]>('engine_nodes');
  }
  wires() {
    return this.call<WireSnapshot[]>('engine_wires');
  }
  addModule(instance: string, typeId: string) {
    return this.call<void>('add_module', { instance, typeId });
  }
  connectWire(from: { instance: string; jack: string }, to: { instance: string; jack: string }) {
    return this.call<void>('connect_wire', {
      fromInstance: from.instance,
      fromJack: from.jack,
      toInstance: to.instance,
      toJack: to.jack,
    });
  }
  disconnectWire(from: { instance: string; jack: string }, to: { instance: string; jack: string }) {
    return this.call<void>('disconnect_wire', {
      fromInstance: from.instance,
      fromJack: from.jack,
      toInstance: to.instance,
      toJack: to.jack,
    });
  }
  loadDemoPatch() {
    return this.call<void>('load_demo_patch');
  }
  setKnobPosition(instance: string, jack: string, position: number) {
    return this.call<void>('set_knob_position', { instance, jack, position });
  }
  setKnobConfig(instance: string, jack: string, config: KnobConfig | null) {
    return this.call<void>('set_knob_config', { instance, jack, config });
  }
  setAttenOffset(instance: string, jack: string, atten: number, offset: number) {
    return this.call<void>('set_knob_atten_offset', { instance, jack, atten, offset });
  }
  setParam(instance: string, param: string, value: number) {
    return this.call<void>('set_param', { instance, param, value });
  }
  tap(instance: string, jack: string) {
    return this.call<JackTelemetry>('tap', { instance, jack });
  }
  savePatch(dir: string, name: string) {
    return this.call<void>('save_patch', { dir, name });
  }
  loadPatch(dir: string) {
    return this.call<void>('load_patch', { dir });
  }
  injectMidi(instance: string, frame: number, data: [number, number, number]) {
    return this.call<void>('inject_midi', { instance, frame, data });
  }
  addMidiMapping(instance: string, kind: string, num: number, name: string) {
    return this.call<void>('add_midi_mapping', { instance, kind, num, name });
  }
  removeMidiMapping(instance: string, name: string) {
    return this.call<void>('remove_midi_mapping', { instance, name });
  }
  undo() {
    return this.call<boolean>('undo');
  }
  redo() {
    return this.call<boolean>('redo');
  }
  /** Returns the backend the engine actually started on: 'cpal' (device
   *  audio) or 'null' (silent fallback), or null outside Tauri. */
  start() {
    return this.call<string>('engine_start');
  }
  stop() {
    return this.call<void>('engine_stop');
  }
}

export const engine = new EngineClient();
