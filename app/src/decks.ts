// Decks bank bridge over Tauri IPC: the eight clip slots the Decks tab
// draws, what is in them and how they are mixed. Mirrors
// `app/src-tauri/src/decks.rs`; like every client here it resolves to null
// outside Tauri so the UI stays testable headless (tests inject a mock).

import { IpcClient } from './ipc';
import type { BeatClipRef } from './beatClip';

/** The rack module a bank IS. */
export const DECKS_TYPE = 'builtin.decks';

export const DECK_SLOTS = 8;

/** Full scale of a tone control: 0 kills the band, 1 is flat, 2 is +6 dB
 *  (mirrors `EQ_MAX` in crates/dj-engine/src/decks.rs). */
export const EQ_MAX = 2;

export const MIN_BPM = 20;
export const MAX_BPM = 300;

/** One of a slot's six controls — the six a Launch Control XL column
 *  carries. */
export type SlotControl = 'level' | 'high' | 'mid' | 'low' | 'mute' | 'solo';

export interface DeckSlotStatus {
  slot: number;
  clip: BeatClipRef | null;
  /** Whether the audio behind the binding is in hand yet. */
  loaded: boolean;
  beats: number;
  tail: number;
  phase: number;
  /** The tempo the clip was rendered at. */
  source_bpm: number;
  /** Bank tempo over source tempo; 1 plays the clip as rendered. */
  stretch: number;
  level: number;
  low: number;
  mid: number;
  high: number;
  mute: boolean;
  solo: boolean;
  /** The beat grid this slot's starts share with the rest of the bank. */
  align_beats: number;
  /** False when the clip shares no phase with something else loaded. */
  aligned: boolean;
  duration_secs: number;
  position_secs: number;
  /** Beat of its own clip the slot is on, -1 when silent. */
  beat: number;
  playing: boolean;
}

export interface DecksStatus {
  bpm: number;
  /** Fractional beats since the bank last restarted. */
  beat: number;
  /** Beats until every loaded slot comes round together. */
  cycle_beats: number;
  /** Whether this bank follows the Launch Control XL. */
  surface: boolean;
  /** Whether a surface is plugged in at all. */
  surface_connected: boolean;
  slots: DeckSlotStatus[];
}

/** What the Decks page needs; the Tauri client below implements it and
 *  tests substitute a mock. */
export interface DecksApi {
  banks(): Promise<string[] | null>;
  /** The bank the page drives, creating and wiring one if the patch has
   *  none. Resolves to its instance id. */
  ensure(): Promise<string | null>;
  status(instance: string): Promise<DecksStatus | null>;
  load(instance: string, slot: number, projectId: string, clipId: string): Promise<void | null>;
  clear(instance: string, slot: number): Promise<void | null>;
  setControl(
    instance: string,
    slot: number,
    control: SlotControl,
    value: number,
  ): Promise<void | null>;
  setTail(instance: string, slot: number, tail: number): Promise<void | null>;
  setPhase(instance: string, slot: number, phase: number): Promise<void | null>;
  setBpm(instance: string, bpm: number): Promise<void | null>;
  setSurface(instance: string, follow: boolean): Promise<void | null>;
  reset(instance: string): Promise<void | null>;
  endEdit(): Promise<void | null>;
}

export class DecksClient extends IpcClient implements DecksApi {
  banks() {
    return this.call<string[]>('decks_banks');
  }
  ensure() {
    return this.call<string>('decks_ensure');
  }
  status(instance: string) {
    // Polled while the tab is open: a bank the user just deleted is a
    // race, not news for the error banner.
    return this.call<DecksStatus>('decks_status', { instance }, { quiet: true });
  }
  load(instance: string, slot: number, projectId: string, clipId: string) {
    return this.call<void>('decks_load', { instance, slot, projectId, clipId });
  }
  clear(instance: string, slot: number) {
    return this.call<void>('decks_clear', { instance, slot });
  }
  setControl(instance: string, slot: number, control: SlotControl, value: number) {
    return this.call<void>('decks_set_control', { instance, slot, control, value });
  }
  setTail(instance: string, slot: number, tail: number) {
    return this.call<void>('decks_set_tail', { instance, slot, tail });
  }
  setPhase(instance: string, slot: number, phase: number) {
    return this.call<void>('decks_set_phase', { instance, slot, phase });
  }
  setBpm(instance: string, bpm: number) {
    return this.call<void>('decks_set_bpm', { instance, bpm });
  }
  setSurface(instance: string, follow: boolean) {
    return this.call<void>('decks_set_surface', { instance, follow });
  }
  reset(instance: string) {
    return this.call<void>('decks_reset', { instance });
  }
  /** Close the undo-coalescing window (fader drags, tempo drags). */
  endEdit() {
    return this.call<void>('end_edit');
  }
}

export const decks = new DecksClient();

/** How far a slot is being stretched, as a percentage a DJ reads the way
 *  a pitch fader reads: +6.7 % is "running 6.7 % fast". Under a tenth of
 *  a percent is not a stretch worth reporting. */
export function stretchLabel(stretch: number): string {
  const pct = (stretch - 1) * 100;
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.05) return '±0.0%';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
}

/** What a slot's phase relationship to the rest of the bank amounts to.
 *  `null` = nothing to say (an empty slot, or the only clip loaded). */
export function alignLabel(slot: DeckSlotStatus, loadedSlots: number): string | null {
  if (slot.beats === 0 || loadedSlots < 2) return null;
  if (!slot.aligned) return 'free — shares no beat with the others';
  return slot.align_beats === 1 ? 'locks every beat' : `locks every ${slot.align_beats} beats`;
}

/** Total loop length of a slot, silence included. */
export function loopBeats(slot: DeckSlotStatus): number {
  return slot.beats === 0 ? 0 : slot.beats + slot.tail;
}
