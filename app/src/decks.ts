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
export type SlotControl = 'level' | 'high' | 'mid' | 'low' | 'mute' | 'monitor';

/** A quantized start or stop the bank's clock is still holding (mirrors
 *  `DeckArm` in crates/dj-engine/src/decks.rs): a queued deck comes in
 *  when its clip's own first beat next comes round, a dropping one plays
 *  its clip out first. */
export type DeckArm = 'none' | 'queue' | 'drop';

/** The bank's own jacks, by name (mirrors `decks_manifest`). A deck's
 *  SEND carries its audio out to the rack and its RETURN brings the
 *  rack's answer back; the three tone controls each have a CV out. */
export const CLOCK_JACK = 'clock';
/** The bank's two output pairs: the room, and the headphones a deck's
 *  Monitor button cues into. Each carries a master fader. */
export const MASTER_BUSES = ['live', 'monitor'] as const;
export type MasterBus = (typeof MASTER_BUSES)[number];
export const outJack = (bus: MasterBus, side: 'l' | 'r') =>
  bus === 'live' ? `audio_${side}` : `mon_${side}`;
export const sendJack = (slot: number, side: 'l' | 'r') => `d${slot + 1}_${side}`;
export const returnJack = (slot: number, side: 'l' | 'r') => `d${slot + 1}_in_${side}`;
/** The tone controls of a strip, top to bottom — the order the surface's
 *  three knob rows are in. */
export const TONES = ['high', 'mid', 'low'] as const;
export type Tone = (typeof TONES)[number];
export const toneJack = (slot: number, tone: Tone) => `d${slot + 1}_${tone}`;

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
  /** On the monitor pair instead of the live mix (the cue button). */
  monitor: boolean;
  /** Whether the deck's return is wired — the rack is its insert. */
  insert: boolean;
  /** Which tone controls have left the deck for the rack, in TONES
   *  order: a patched one is a CV source and stops cutting its band. */
  tone_patched: [boolean, boolean, boolean];
  duration_secs: number;
  position_secs: number;
  /** Beat of the slot's LOOP the playhead is on, silence included; -1
   *  when the slot holds nothing. */
  beat: number;
  /** Whether the playhead is inside the clip rather than its silence. */
  sounding: boolean;
  playing: boolean;
  /** A queue or drop the bank's clock is still holding; the mute above is
   *  already where the deck is going. */
  arm: DeckArm;
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
  /** The fader on the live pair (1 = unity). */
  master_live: number;
  /** The fader on the monitor pair. */
  master_monitor: number;
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
  /** The fader on one of the bank's two output pairs. */
  setMaster(instance: string, bus: MasterBus, value: number): Promise<void | null>;
  /** Queue/drop a deck on the bank's grid; 'none' takes an arm back. */
  arm(instance: string, slot: number, arm: DeckArm): Promise<void | null>;
  setTail(instance: string, slot: number, tail: number): Promise<void | null>;
  setPhase(instance: string, slot: number, phase: number): Promise<void | null>;
  setBpm(instance: string, bpm: number): Promise<void | null>;
  setSurface(instance: string, follow: boolean): Promise<void | null>;
  reset(instance: string): Promise<void | null>;
  /** Assemble any slot still waiting for its audio; resolves to how many
   *  were filled. */
  rehydrate(): Promise<number | null>;
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
  setMaster(instance: string, bus: MasterBus, value: number) {
    return this.call<void>('decks_set_master', { instance, bus, value });
  }
  arm(instance: string, slot: number, arm: DeckArm) {
    return this.call<void>('decks_arm', { instance, slot, arm });
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
  rehydrate() {
    return this.call<number>('decks_rehydrate');
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

/** What a clip costs at the bank's tempo, on one line: the tempo it was
 *  cut at, then the stretch to get it here. The tempo drops a trailing
 *  `.0` — a clip cut at 140 reads "140 bpm". */
export function tempoLabel(sourceBpm: number, stretch: number): string {
  return `${Number(sourceBpm.toFixed(1))} bpm ${stretchLabel(stretch)}`;
}

/** What a deck calls what is in it: the Beatify project the clip was cut
 *  in, then the clip. Two clips called "intro" are told apart by their
 *  project, so the project comes first and both live on one line. A patch
 *  saved before clips carried the project name falls back to its id. */
export function clipTitle(clip: BeatClipRef | null): string {
  if (!clip?.name) return 'empty';
  const project = clip.project_name || clip.project;
  return project ? `${project} - ${clip.name}` : clip.name;
}

/** Total loop length of a slot, silence included. */
export function loopBeats(slot: DeckSlotStatus): number {
  return slot.beats === 0 ? 0 : slot.beats + slot.tail;
}
