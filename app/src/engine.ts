// Bridge to the Rust engine over Tauri IPC. Falls back to a no-op stub when
// running outside Tauri (vite dev server / tests), so the UI stays testable
// headless.

import { IpcClient } from './ipc';
import type { JackTelemetry, KnobConfig, Manifest, WireStyle } from './types';

/** Subscribe to native File-menu actions ("saved" | "save-as" | "open").
 *  Also listens for `dj-menu` DOM CustomEvents so tests / the dev browser
 *  can drive the same paths. Returns an unsubscribe function. */
export function onMenuAction(cb: (action: string) => void): () => void {
  const domHandler = (e: Event) => {
    const action = (e as CustomEvent).detail;
    if (typeof action === 'string') cb(action);
  };
  window.addEventListener('dj-menu', domHandler);
  let tauriUnlisten: (() => void) | null = null;
  let disposed = false;
  if ('__TAURI_INTERNALS__' in window) {
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<string>('dj-menu', (e) => cb(e.payload)).then((un) => {
        if (disposed) un();
        else tauriUnlisten = un;
      }),
    );
  }
  return () => {
    disposed = true;
    window.removeEventListener('dj-menu', domHandler);
    tauriUnlisten?.();
  };
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
  knobs: Record<
    string,
    {
      position: number;
      atten: number;
      offset: number;
      wire_style: WireStyle;
      config?: KnobConfig | null;
    }
  >;
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

// --- Gesture Control (M5, PRD §7.3) ---

export interface GestureWheel {
  cx: number;
  cy: number;
  radius: number;
  center_radius: number;
}

export interface GestureWheelLayout {
  wheels: GestureWheel[];
}

export interface GestureHand {
  handedness: 'Left' | 'Right';
  points: { x: number; y: number }[];
}

export interface GestureDetection {
  hands: GestureHand[];
}

export interface GestureMapping {
  name: string;
  mode: string;
  config: Record<string, unknown>;
  value: number;
}

export interface GestureStatus {
  mode: string;
  modes: string[];
  wheels: GestureWheelLayout;
  mappings: GestureMapping[];
  detection: GestureDetection | null;
  active_zones: [number, number][];
  /** Fixture name when a mock feed is running. */
  feed: string | null;
  /** 'mock' here; 'granted' | 'denied' | 'prompt' on macOS later. */
  camera: string;
}

/** One note-track cell: at most one note per beat (no polyphony). */
export interface NoteStep {
  /** Grid row: 0 = base note, counting up through the scale. */
  degree: number;
  /** 0..1; scales the velocity jack's 0..10 V output. */
  velocity: number;
}

export type ChoreoTrackData =
  | { kind: 'boolean'; steps: boolean[] }
  | { kind: 'continuous'; values: number[] }
  | {
      kind: 'note';
      octaves: number;
      scale: string;
      base_note: number;
      steps: (NoteStep | null)[];
    };

export interface ChoreoTrack {
  name: string;
  /** First output-jack slot (`t<jack>`); note tracks also own `t<jack+1>`. */
  jack: number;
  data: ChoreoTrackData;
}

export interface ChoreoStatus {
  beats: number;
  tracks: ChoreoTrack[];
  /** Current beat index; -1 until the first clock. */
  playhead: number;
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

export class EngineClient extends IpcClient {
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
  /** Wired-input blend mode: 'cv' (signal modulates the knob) or
   *  'override' (signal IS the value, knob inert while wired). */
  setKnobWireStyle(instance: string, jack: string, style: WireStyle) {
    return this.call<void>('set_knob_wire_style', { instance, jack, style });
  }
  /** Double-click knob reset: position to the manifest default, wire
   *  atten/offset back to defaults. */
  resetKnob(instance: string, jack: string) {
    return this.call<void>('reset_knob', { instance, jack });
  }
  /** Module "Reset to defaults": every knob and param back to a freshly
   *  added module's state (wires and mappings stay). */
  resetModule(instance: string) {
    return this.call<void>('reset_module', { instance });
  }
  /** Group "Reset to defaults" — one undo step for the whole selection. */
  resetModules(instances: string[]) {
    return this.call<void>('reset_modules', { instances });
  }
  /** Copy the selection as an opaque clipboard string (wires internal to
   *  the selection ride along; external wires are dropped). */
  copyModules(instances: string[]) {
    return this.call<string>('copy_modules', { instances });
  }
  /** Paste a copyModules clipboard; returns copied id -> new instance id. */
  pasteModules(clipboard: string) {
    return this.call<Record<string, string>>('paste_modules', { clipboard });
  }
  /** Delete a whole selection as one undo step. */
  removeModules(instances: string[]) {
    return this.call<void>('remove_modules', { instances });
  }
  setParam(instance: string, param: string, value: number) {
    return this.call<void>('set_param', { instance, param, value });
  }
  tap(instance: string, jack: string) {
    // Quiet: the 100ms telemetry poll races structural edits (undo/redo,
    // module removal, patch load), so "no node" failures are expected and
    // just mean "no meter update this tick".
    return this.call<JackTelemetry>('tap', { instance, jack }, { quiet: true });
  }
  /** Batched telemetry for the whole rack: one IPC round-trip returning
   *  { instance_id -> { jack_id -> JackTelemetry } }. Quiet for the same
   *  reason as `tap`. */
  tapAll() {
    return this.call<Record<string, Record<string, JackTelemetry>>>('tap_all', undefined, {
      quiet: true,
    });
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
  /** File > New Patch: replace the rack with a fresh empty engine. */
  newPatch() {
    return this.call<void>('new_patch');
  }
  listPatches() {
    return this.call<string[]>('list_patches');
  }
  /** Resolves to non-fatal load warnings (e.g. wires dropped because a
   *  newer module version no longer has the saved jack). */
  loadPatchByName(name: string) {
    return this.call<string[]>('load_patch_by_name', { name });
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
  /** One key transition into a QWERTY module (lowercased `event.key`). */
  qwertyKey(instance: string, key: string, down: boolean) {
    return this.call<void>('qwerty_key', { instance, key, down });
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
  /** Polled by the gesture panel; quiet because a poll racing the module's
   *  removal (or an undo/redo rebuild) is expected, not an error. */
  gestureStatus(instance: string) {
    return this.call<GestureStatus>('gesture_status', { instance }, { quiet: true });
  }
  gestureSetMode(instance: string, mode: string) {
    return this.call<void>('gesture_set_mode', { instance, mode });
  }
  gestureAddMapping(instance: string, name: string, mode: string, config: Record<string, unknown>) {
    return this.call<void>('gesture_add_mapping', { instance, name, mode, config });
  }
  gestureRemoveMapping(instance: string, name: string) {
    return this.call<void>('gesture_remove_mapping', { instance, name });
  }
  gestureLearnBegin(instance: string) {
    return this.call<void>('gesture_learn_begin', { instance });
  }
  gestureLearnPoll(instance: string, name: string) {
    return this.call<boolean>('gesture_learn_poll', { instance, name });
  }
  gestureFeedStart(instance: string, source: string) {
    return this.call<void>('gesture_feed_start', { instance, source });
  }
  gestureFeedStop(instance: string) {
    return this.call<void>('gesture_feed_stop', { instance });
  }
  removeMidiLedMapping(instance: string, name: string) {
    return this.call<void>('remove_midi_led_mapping', { instance, name });
  }
  /** Polled by the choreography panel; quiet because a poll racing the
   *  module's removal is expected, not an error. */
  choreoStatus(instance: string) {
    return this.call<ChoreoStatus>('choreo_status', { instance }, { quiet: true });
  }
  choreoSetBeats(instance: string, beats: number) {
    return this.call<void>('choreo_set_beats', { instance, beats });
  }
  choreoAddTrack(instance: string, name: string, kind: string) {
    return this.call<void>('choreo_add_track', { instance, name, kind });
  }
  choreoRemoveTrack(instance: string, track: number) {
    return this.call<void>('choreo_remove_track', { instance, track });
  }
  choreoRenameTrack(instance: string, track: number, name: string) {
    return this.call<void>('choreo_rename_track', { instance, track, name });
  }
  choreoMoveTrack(instance: string, from: number, to: number) {
    return this.call<void>('choreo_move_track', { instance, from, to });
  }
  choreoSetBool(instance: string, track: number, beat: number, on: boolean) {
    return this.call<void>('choreo_set_bool', { instance, track, beat, on });
  }
  /** Write a run of continuous values starting at `start` (drag paints
   *  batch into one call). */
  choreoSetValues(instance: string, track: number, start: number, values: number[]) {
    return this.call<void>('choreo_set_values', { instance, track, start, values });
  }
  choreoSetNote(instance: string, track: number, beat: number, note: NoteStep | null) {
    return this.call<void>('choreo_set_note', { instance, track, beat, note });
  }
  choreoSetNoteSettings(
    instance: string,
    track: number,
    octaves: number,
    scale: string,
    baseNote: number,
  ) {
    return this.call<void>('choreo_set_note_settings', {
      instance,
      track,
      octaves,
      scale,
      baseNote,
    });
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
