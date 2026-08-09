// DJ Deck bridge over Tauri IPC (M2). Mirrors the engine's DeckStatus and
// deck_* commands; falls back to nulls outside Tauri so the UI stays
// testable headless (tests inject a mock client).

import { IpcClient } from './ipc';

export interface DeckStatus {
  track: string | null;
  duration_secs: number;
  position_secs: number;
  rate: number;
  playing: boolean;
  grid_bpm: number | null;
  grid_anchor_secs: number | null;
  effective_bpm: number | null;
  cues: (number | null)[];
  loop_start_secs: number | null;
  loop_end_secs: number | null;
  loop_enabled: boolean;
  sync_to: string | null;
  /** Stems loaded for the current track (M3): stem gain params are live. */
  stems_loaded: boolean;
}

export interface SavedLoop {
  id: number;
  name: string;
  start_secs: number;
  end_secs: number;
}

/** What DeckPanel needs; the Tauri-backed client below implements it and
 *  tests substitute a mock. */
export interface DeckApi {
  load(instance: string, trackId: number): Promise<void | null>;
  status(instance: string): Promise<DeckStatus | null>;
  waveform(instance: string, buckets: number): Promise<number[] | null>;
  seek(instance: string, position: number): Promise<void | null>;
  setCue(instance: string, slot: number, position: number | null): Promise<void | null>;
  setLoop(instance: string, start: number, end: number): Promise<void | null>;
  loopEnable(instance: string, enabled: boolean): Promise<void | null>;
  loopHalve(instance: string): Promise<void | null>;
  loopDouble(instance: string): Promise<void | null>;
  saveLoop(instance: string, name: string): Promise<number | null>;
  savedLoops(instance: string): Promise<SavedLoop[] | null>;
  setBeatgrid(instance: string, bpm: number, anchor: number): Promise<void | null>;
  tapTempo(instance: string): Promise<[number, number] | null>;
  nudgeBeatgrid(instance: string, delta: number): Promise<void | null>;
  anchorHere(instance: string): Promise<void | null>;
  sync(instance: string, master: string | null): Promise<void | null>;
  /** Load cached stems for the deck's track; resolves false when none
   *  are cached yet (M3). */
  loadStems(instance: string): Promise<boolean | null>;
  clearStems(instance: string): Promise<void | null>;
}

export class DeckClient extends IpcClient implements DeckApi {
  load(instance: string, trackId: number) {
    return this.call<void>('deck_load', { instance, trackId });
  }
  status(instance: string) {
    return this.call<DeckStatus>('deck_status', { instance });
  }
  waveform(instance: string, buckets: number) {
    return this.call<number[]>('deck_waveform', { instance, buckets });
  }
  seek(instance: string, position: number) {
    return this.call<void>('deck_seek', { instance, position });
  }
  setCue(instance: string, slot: number, position: number | null) {
    return this.call<void>('deck_set_cue', { instance, slot, position });
  }
  setLoop(instance: string, start: number, end: number) {
    return this.call<void>('deck_set_loop', { instance, start, end });
  }
  loopEnable(instance: string, enabled: boolean) {
    return this.call<void>('deck_loop_enable', { instance, enabled });
  }
  loopHalve(instance: string) {
    return this.call<void>('deck_loop_halve', { instance });
  }
  loopDouble(instance: string) {
    return this.call<void>('deck_loop_double', { instance });
  }
  saveLoop(instance: string, name: string) {
    return this.call<number>('deck_save_loop', { instance, name });
  }
  savedLoops(instance: string) {
    return this.call<SavedLoop[]>('deck_saved_loops', { instance });
  }
  setBeatgrid(instance: string, bpm: number, anchor: number) {
    return this.call<void>('deck_set_beatgrid', { instance, bpm, anchor });
  }
  tapTempo(instance: string) {
    return this.call<[number, number]>('deck_tap_tempo', { instance });
  }
  nudgeBeatgrid(instance: string, delta: number) {
    return this.call<void>('deck_nudge_beatgrid', { instance, delta });
  }
  anchorHere(instance: string) {
    return this.call<void>('deck_anchor_here', { instance });
  }
  sync(instance: string, master: string | null) {
    return this.call<void>('deck_sync', { instance, master });
  }
  loadStems(instance: string) {
    return this.call<boolean>('deck_load_stems', { instance });
  }
  clearStems(instance: string) {
    return this.call<void>('deck_clear_stems', { instance });
  }
}

export const deck = new DeckClient();
