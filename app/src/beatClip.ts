// Beat Clip module bridge over Tauri IPC: the clips the module picker
// offers, importing one into a rack module, and what the module is
// playing. Mirrors `app/src-tauri/src/beat_clip.rs`; like every client
// here it resolves to null outside Tauri so the UI stays testable
// headless (tests inject a mock).

import { IpcClient } from './ipc';

/** The rack module a clip is imported as. */
export const BEAT_CLIP_TYPE = 'builtin.beat_clip';

/** A library track a clip was cut from: the pointer — the hash of the
 *  track's audio, which nothing can change — and the names it answers to
 *  today. `title === null` means the source is gone (never recorded, or
 *  since deleted), which rows must handle. */
export interface BeatClipSourceInfo {
  trackHash: string;
  title: string | null;
  artist: string | null;
}

/** One clip a Beat Clip module can be built from. */
export interface BeatClipEntry {
  clipId: string;
  name: string;
  /** The tempo the clip's beats are laid out at. */
  bpm: number;
  /** Clip length in beats (trailing silence included). */
  beats: number;
  /** Which parts of a track it is made of, `STEM_NAMES` order — the tags
   *  the row shows. All four means it was cut from whole mixes. */
  stems: string[];
  /** Can it be opened in the Clip page again? Only a clip filed with the
   *  edit behind it can. */
  editable: boolean;
  /** The tracks it points at, resolved against the library as it now
   *  stands. Empty when the clip records no source at all. */
  sources: BeatClipSourceInfo[];
}

/** Which clip a module is bound to. The patch persists this, never the
 *  audio: the clip is loaded out of the store on every patch load. */
export interface BeatClipRef {
  /** The store it was filed in — see `clip::BEAT_CLIPS_PROJECT`. */
  project: string;
  clip: string;
  name: string;
  /** The store it came from, by name — display only, and empty in a
   *  patch saved before clips said. */
  project_name?: string;
  /** What the clip held when it was bound — display only, and absent in
   *  a patch saved before clips said. Refreshed on every load. */
  stems?: string[];
}

export interface BeatClipStatus {
  clip: BeatClipRef | null;
  duration_secs: number;
  /** Audible position in clip seconds as of the engine's last block. */
  position_secs: number;
  /** Clip length in beats at the BPM input's tempo. */
  beats: number;
  /** Beat being played, or -1 while the module waits for a clock. */
  beat: number;
  /** Tempo the clip's audio was rendered at. */
  bpm: number;
  /** Tempo the last two clock edges measured out; 0 until there are two. */
  clock_bpm: number;
  playing: boolean;
}

/** What the picker's Clips tab and the module panel need; the Tauri
 *  client below implements it and tests substitute a mock. */
export interface BeatClipApi {
  list(): Promise<BeatClipEntry[] | null>;
  /** Resolves to the module's instance id, which the load renames after
   *  the clip ("chorus stack"), so the caller can re-key its layout. */
  load(instance: string, clipId: string): Promise<string | null>;
  status(instance: string): Promise<BeatClipStatus | null>;
  /** Delete a saved clip. Resolves to the list as it now stands. */
  delete(clipId: string): Promise<BeatClipEntry[] | null>;
}

export class BeatClipClient extends IpcClient implements BeatClipApi {
  list() {
    return this.call<BeatClipEntry[]>('beat_clip_list');
  }
  load(instance: string, clipId: string) {
    return this.call<string>('beat_clip_load', { instance, clipId });
  }
  status(instance: string) {
    return this.call<BeatClipStatus>('beat_clip_status', { instance });
  }
  delete(clipId: string) {
    return this.call<BeatClipEntry[]>('beat_clip_delete', { clipId });
  }
}

export const beatClip = new BeatClipClient();

/** The titles a clip's sources answer to TODAY, in source order. Empty
 *  when the sources are gone from the library or were never recorded. */
export function clipTrackNames(clip: BeatClipEntry): string[] {
  return clip.sources.map((s) => s.title).filter((t): t is string => !!t);
}

/** The artists behind those titles, each named once. */
export function clipArtistNames(clip: BeatClipEntry): string[] {
  const names = clip.sources.map((s) => s.artist).filter((a): a is string => !!a);
  return [...new Set(names)];
}

/** What a clip row says it was cut from: the titles of its sources, or
 *  an honest line when the library no longer has them (a clip outlives
 *  its source, and the pickers still have to name it somehow). */
export function clipSourceLabel(clip: BeatClipEntry): string {
  const titles = clipTrackNames(clip);
  if (titles.length > 0) return titles.join(' + ');
  return clip.sources.length > 0 ? 'source not in the library' : 'no source recorded';
}

/** A column of the clip table, by what it orders on. */
export type ClipSortField = 'name' | 'track' | 'artist' | 'bpm' | 'beats' | 'stems';

export interface ClipSort {
  field: ClipSortField;
  desc: boolean;
}

/** Clicking a column title: ascending, descending, then OFF — the store
 *  answers oldest first, and that order is worth being able to get back. */
export function nextClipSort(current: ClipSort | null, field: ClipSortField): ClipSort | null {
  if (!current || current.field !== field) return { field, desc: false };
  return current.desc ? null : { field, desc: true };
}

function compareBy(a: BeatClipEntry, b: BeatClipEntry, field: ClipSortField): number {
  switch (field) {
    case 'name':
      return a.name.localeCompare(b.name);
    case 'track':
      return clipTrackNames(a).join(' ').localeCompare(clipTrackNames(b).join(' '));
    case 'artist':
      return clipArtistNames(a).join(' ').localeCompare(clipArtistNames(b).join(' '));
    case 'bpm':
      return a.bpm - b.bpm;
    case 'beats':
      return a.beats - b.beats;
    case 'stems':
      return a.stems.length - b.stems.length || a.stems.join(' ').localeCompare(b.stems.join(' '));
  }
}

/** A copy of the list in the asked-for order; the list itself when no
 *  column is sorted on. Ties fall back to the name, so a re-sort of
 *  equal rows never shuffles them. */
export function sortClips(clips: BeatClipEntry[], sort: ClipSort | null): BeatClipEntry[] {
  if (!sort) return clips;
  const dir = sort.desc ? -1 : 1;
  return [...clips].sort(
    (a, b) => dir * compareBy(a, b, sort.field) || a.name.localeCompare(b.name),
  );
}

/** Everything a surface can narrow the clip list by. Every field is
 *  optional and they AND together; each runs client-side over the list
 *  already in hand (one store, one list — there is nothing to ask). */
export interface ClipFilter {
  /** Free text, by word, over the names a row shows: the clip's own, its
   *  tracks' and its artists'. */
  query?: string;
  /** Every one of these parts must be in the clip. A clip that says
   *  nothing about its parts makes no claim, so it drops out. */
  stems?: readonly string[];
  /** Only clips cut from this track — the hash of its audio, so the
   *  filter follows a rename. */
  trackHash?: string;
  /** Only clips whose sources credit this artist. */
  artist?: string;
}

export function filterClips(clips: BeatClipEntry[], filter: ClipFilter): BeatClipEntry[] {
  const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const artist = filter.artist?.toLowerCase();
  return clips.filter((c) => {
    if (filter.stems && !filter.stems.every((s) => c.stems.includes(s))) return false;
    if (filter.trackHash && !c.sources.some((s) => s.trackHash === filter.trackHash)) return false;
    if (artist && !clipArtistNames(c).some((a) => a.toLowerCase() === artist)) return false;
    if (words.length === 0) return true;
    const hay = [c.name, ...clipTrackNames(c), ...clipArtistNames(c)].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
