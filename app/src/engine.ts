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
  /** LED feedback mappings (M4); each is also an input jack. */
  midi_led_mappings: MidiMapping[];
}

export interface WireSnapshot {
  from_instance: string;
  from_jack: string;
  to_instance: string;
  to_jack: string;
}

export interface MacroInfo {
  id: string;
  name: string;
  version: number;
}

/** A macro whose patch-saved version disagrees with the library (PRD §6). */
export interface MacroConflict {
  macro_id: string;
  name: string;
  patch_version: number;
  library_version: number;
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
  /** Loads a patch. A non-empty result is the list of macro version
   *  conflicts (PRD §6): the engine was left untouched and the caller
   *  should prompt update-vs-fork and retry with `resolutions`. */
  loadPatch(dir: string, resolutions?: [string, 'update' | 'fork'][]) {
    return this.call<MacroConflict[]>('load_patch', { dir, resolutions });
  }
  listMacros() {
    return this.call<MacroInfo[]>('list_macros');
  }
  /** Collapse the selected modules into a new macro; returns the new
   *  instance id. */
  collapseMacro(selection: string[], name: string) {
    return this.call<string>('collapse_macro', { selection, name });
  }
  savePatchAs(name: string) {
    return this.call<void>('save_patch_as', { name });
  }
  listPatches() {
    return this.call<string[]>('list_patches');
  }
  loadPatchByName(name: string) {
    return this.call<void>('load_patch_by_name', { name });
  }
  currentPatch() {
    return this.call<string>('current_patch');
  }
  removeModule(instance: string) {
    return this.call<void>('remove_module', { instance });
  }
  /** End of an edit gesture (pointer-up): next edit gets its own undo step. */
  endEdit() {
    return this.call<void>('end_edit');
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
  /** LED feedback (M4, PRD §7.1): the named input jack drives note/CC
   *  out messages back to the controller. */
  addMidiLedMapping(instance: string, kind: string, num: number, name: string) {
    return this.call<void>('add_midi_led_mapping', { instance, kind, num, name });
  }
  removeMidiLedMapping(instance: string, name: string) {
    return this.call<void>('remove_midi_led_mapping', { instance, name });
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
