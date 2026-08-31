// Decks V2 bridge and page arithmetic. The V2 page drives the SAME
// `builtin.decks` module as the Decks tab — a bank flagged `v2`, playing
// TWO ARRANGEMENTS of its slots on one clock: the classic per-slot state
// is the MONITOR side (the editable copy in the headphones) and the
// `live_*` fields are what the room hears. This file adds the V2-only
// commands to the Decks client (mirroring `decks_v2_*` in
// app/src-tauri/src/decks.rs) and owns the page's grid arithmetic: rows,
// the LCM the two grids draw, and the song colors.

import type { BeatClipEntry } from './beatClip';
import {
  DecksClient,
  loopBeats,
  type DecksApi,
  type DeckSlotStatus,
  type DeckTransition,
} from './decks';

/** What the Decks V2 page needs on top of the classic bank commands. */
export interface DecksV2Api extends DecksApi {
  /** Every V2 bank in the patch (usually one). */
  banksV2(): Promise<string[] | null>;
  /** The V2 bank the page drives, creating and wiring one if the patch
   *  has none. Resolves to its instance id. */
  ensureV2(): Promise<string | null>;
  /** Load a clip into a row. It lands in the MONITOR arrangement;
   *  `muted` lands it silent there too (adding a whole song at once). */
  loadV2(instance: string, slot: number, clipId: string, muted: boolean): Promise<void | null>;
  /** The LIVE side's own fader or mute on one row. */
  setLiveControl(
    instance: string,
    slot: number,
    control: 'level' | 'mute',
    value: number,
  ): Promise<void | null>;
  /** The LIVE side's own shift on one row (the disarmed grid's). */
  setLivePhase(instance: string, slot: number, phase: number): Promise<void | null>;
  /** Arm a jump/crossfade on the bank's cycle; 'none' takes it back. */
  transition(instance: string, mode: DeckTransition): Promise<void | null>;
  /** Finish a fired transition (the poll saw `transition_done`): copy
   *  monitor into live. Resolves to whether anything was owed. */
  commitTransition(instance: string): Promise<boolean | null>;
}

export class DecksV2Client extends DecksClient implements DecksV2Api {
  banksV2() {
    return this.call<string[]>('decks_v2_banks');
  }
  ensureV2() {
    return this.call<string>('decks_v2_ensure');
  }
  loadV2(instance: string, slot: number, clipId: string, muted: boolean) {
    return this.call<void>('decks_v2_load', { instance, slot, clipId, muted });
  }
  setLiveControl(instance: string, slot: number, control: 'level' | 'mute', value: number) {
    return this.call<void>('decks_v2_set_live_control', { instance, slot, control, value });
  }
  setLivePhase(instance: string, slot: number, phase: number) {
    return this.call<void>('decks_v2_set_live_phase', { instance, slot, phase });
  }
  transition(instance: string, mode: DeckTransition) {
    return this.call<void>('decks_v2_transition', { instance, mode });
  }
  commitTransition(instance: string) {
    return this.call<boolean>('decks_v2_commit', { instance });
  }
}

export const decksV2 = new DecksV2Client();

/** The page's rows: every slot with a clip in it, in slot order — there
 *  are only as many rows as have been loaded. */
export function v2Rows(slots: DeckSlotStatus[]): DeckSlotStatus[] {
  return slots.filter((s) => s.clip !== null || s.beats > 0);
}

/** The first slot a new row can land in; null when the bank is full. */
export function freeSlot(slots: DeckSlotStatus[]): number | null {
  const open = slots.find((s) => s.clip === null && s.beats === 0);
  return open ? open.slot : null;
}

/** Which of a row's loop beats a GRID COLUMN shows, for one side: the
 *  grids are in BANK time (column = bank beat of the cycle), so a shift
 *  slides the clip's picture along the row rather than repainting it in
 *  place. `phase` is that side's own. */
export function cellBeat(slot: DeckSlotStatus, phase: number, col: number): number {
  const len = loopBeats(slot);
  if (len <= 0) return 0;
  return (((col - phase) % len) + len) % len;
}

/** Pixel widths a grid can draw one beat at — the zoom steps. */
export const V2_ZOOMS = [4, 8, 12, 18, 28, 42] as const;
export const V2_ZOOM_DEFAULT = 2; // 12 px

export function clampZoom(z: number): number {
  return Math.min(V2_ZOOMS.length - 1, Math.max(0, Math.round(z)));
}

/** The color every clip cut from one song shares, keyed by the SONG (the
 *  source track's hash — a rename never moves it). A tiny FNV-1a over
 *  the key spreads hues; the lightness/chroma stay fixed so every row
 *  chip reads at the same weight against the canvas. */
export function songHue(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}

/** The song behind a clip: the first source it records. Null for a clip
 *  with no source left — those rows fall back to a neutral chip. */
export function clipSong(clip: BeatClipEntry | undefined): { hash: string; title: string } | null {
  const src = clip?.sources[0];
  if (!src) return null;
  return { hash: src.trackHash, title: src.title ?? 'source not in the library' };
}

/** CSS color of a row's song chip. */
export function songColor(hash: string | null): string {
  if (!hash) return 'var(--ink-dim)';
  return `hsl(${songHue(hash)} 60% 55%)`;
}

/** The clip list grouped by SONG, for the "add a song" picker: every
 *  song at least one clip was cut from, its clips in list order. Clips
 *  without a source have no song to add by and stay out. */
export interface SongGroup {
  hash: string;
  title: string;
  artist: string | null;
  clips: BeatClipEntry[];
}

export function songsOf(clips: BeatClipEntry[]): SongGroup[] {
  const groups = new Map<string, SongGroup>();
  for (const clip of clips) {
    for (const src of clip.sources) {
      let group = groups.get(src.trackHash);
      if (!group) {
        group = {
          hash: src.trackHash,
          title: src.title ?? 'source not in the library',
          artist: src.artist,
          clips: [],
        };
        groups.set(src.trackHash, group);
      }
      if (!group.clips.includes(clip)) group.clips.push(clip);
    }
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
}
