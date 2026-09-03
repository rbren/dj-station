// Beat Clip module bridge over Tauri IPC: the clips the module picker
// offers, importing one into a rack module, and what the module is
// playing. Mirrors `app/src-tauri/src/beat_clip.rs`; like every client
// here it resolves to null outside Tauri so the UI stays testable
// headless (tests inject a mock).

import { IpcClient } from './ipc';
import { matchesQuery } from './search';

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
  /** Which of its own beats its grid marks as ONES, ascending. Empty for
   *  a clip that marks none — a surface that lines clips up by their
   *  downbeat has to cope with that. */
  ones: number[];
  /** The tracks it points at, resolved against the library as it now
   *  stands. Empty when the clip records no source at all. */
  sources: BeatClipSourceInfo[];
  /** How far the clip's files have been rewritten. A clip EDITED on the
   *  Clip page keeps its id, so nothing else here says its audio has
   *  moved: a surface holding a decode of the clip re-reads it when this
   *  changes. Only the store reports it — an entry a caller builds
   *  itself says nothing and reads as unchanged. */
  rev?: string;
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
  /** Which of the clip's own beats its grid marks as ONES (downbeats),
   *  ascending. Absent for a clip that marks none — and it is what a
   *  deck lines the clip up by, not just something to draw. */
  ones?: number[];
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

/** Which bookend of a clip's bleed: `right` is the material that
 *  FOLLOWED the clip in its track, `left` the material before it. */
export type BleedSide = 'left' | 'right';

/** A clip's whole captured area as one buffer to decode, with the two
 *  bookends measured off it: the loop is what lies between `leadSecs`
 *  from the start and `tailSecs` from the end. A clip saved without
 *  bleed is a capture with both at 0. */
export interface ClipCapture {
  bytes: ArrayBuffer;
  leadSecs: number;
  tailSecs: number;
}

/** The frame the backend puts in front of a capture's WAV: two
 *  little-endian `f64` seconds (`beat_clip_audio`, `withBleed`). */
const CAPTURE_HEADER = 16;

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
  /** The clip's loop as WAV bytes, for a page that plays it in the
   *  webview instead of through the engine (the Grid page). `bpm` asks
   *  for it RE-TIMED to that tempo, which is a stretch and not a resample
   *  — the clip keeps its pitch. `fx` asks for it rendered THROUGH a
   *  track's effects rack (`fxRenderSpec`), after the stretch: the wet
   *  buffer the grid crossfades against the dry one. */
  audio(clipId: string, bpm?: number, fx?: string): Promise<ArrayBuffer | null>;
  /** The clip's whole CAPTURE — lead-in, loop, tail-out, as it is filed
   *  — re-timed like the loop, with the seconds that say where the loop
   *  begins and ends inside it. Optional on the interface, because a
   *  caller that only ever loops the clip through the engine never asks
   *  for it. */
  capture?(clipId: string, bpm?: number): Promise<ClipCapture | null>;
  /** The clip's shape in `buckets` peaks, for drawing it on a grid. */
  peaks(clipId: string, buckets: number): Promise<number[] | null>;
  /** Save/open/list Grid arrangements. The document is JSON the frontend
   *  owns end to end; the backend only files it. */
  gridSave(name: string, doc: string): Promise<void>;
  gridLoad(name: string): Promise<string | null>;
  gridList(): Promise<string[] | null>;
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
  audio(clipId: string, bpm?: number, fx?: string) {
    return this.call<ArrayBuffer>('beat_clip_audio', { clipId, bpm, fx });
  }
  async capture(clipId: string, bpm?: number): Promise<ClipCapture | null> {
    const framed = await this.call<ArrayBuffer>('beat_clip_audio', {
      clipId,
      bpm,
      withBleed: true,
    });
    if (!framed || framed.byteLength <= CAPTURE_HEADER) return null;
    const header = new DataView(framed, 0, CAPTURE_HEADER);
    return {
      bytes: framed.slice(CAPTURE_HEADER),
      leadSecs: header.getFloat64(0, true),
      tailSecs: header.getFloat64(8, true),
    };
  }
  peaks(clipId: string, buckets: number) {
    return this.call<number[]>('beat_clip_peaks', { clipId, buckets });
  }
  async gridSave(name: string, doc: string) {
    await this.call<null>('grid_save', { name, doc });
  }
  gridLoad(name: string) {
    return this.call<string>('grid_load', { name });
  }
  gridList() {
    return this.call<string[]>('grid_list');
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

/** THE SONG A DECK IS LOOKING FOR, before the clip: every track at least
 *  one clip was cut from, with the clips cut from it. `hash` is null for
 *  the clips that name no source at all — they are still loadable, so
 *  they are still offered, gathered under one heading rather than left
 *  out. */
export interface ClipSong {
  hash: string | null;
  title: string;
  artist: string | null;
  /** The tempo the song's clips are laid out at (their median, so one
   *  half-time clip among many does not move it): what a bank looking
   *  for something to play at its own tempo sorts on. */
  bpm: number;
  clips: BeatClipEntry[];
}

/** Clips grouped by the song they were cut from, SLOWEST FIRST — the
 *  order a deck picks in, because what makes a clip usable on a running
 *  bank is its tempo. A clip cut from two sources belongs to both. */
export function songsByBpm(clips: BeatClipEntry[]): ClipSong[] {
  const songs = new Map<string, ClipSong>();
  for (const clip of clips) {
    const sources: (BeatClipSourceInfo | null)[] = clip.sources.length ? clip.sources : [null];
    for (const src of sources) {
      const key = src?.trackHash ?? '';
      let song = songs.get(key);
      if (!song) {
        song = {
          hash: src?.trackHash ?? null,
          title: src ? (src.title ?? 'source not in the library') : 'no source recorded',
          artist: src?.artist ?? null,
          bpm: 0,
          clips: [],
        };
        songs.set(key, song);
      }
      if (!song.clips.includes(clip)) song.clips.push(clip);
    }
  }
  const out = [...songs.values()];
  for (const song of out) {
    const bpms = song.clips.map((c) => c.bpm).sort((a, b) => a - b);
    song.bpm = bpms[Math.floor((bpms.length - 1) / 2)] ?? 0;
  }
  return out.sort((a, b) => a.bpm - b.bpm || a.title.localeCompare(b.title));
}

/** Which of the songs is nearest a tempo — the one a picker opens on.
 *  -1 when there are none. A tie goes to the SLOWER song, so the same
 *  list always opens in the same place. */
export function songNearestBpm(songs: ClipSong[], bpm: number): number {
  let best = -1;
  for (let i = 0; i < songs.length; i += 1) {
    if (best < 0 || Math.abs(songs[i].bpm - bpm) < Math.abs(songs[best].bpm - bpm)) best = i;
  }
  return best;
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
  const artist = filter.artist?.toLowerCase();
  return clips.filter((c) => {
    if (filter.stems && !filter.stems.every((s) => c.stems.includes(s))) return false;
    if (filter.trackHash && !c.sources.some((s) => s.trackHash === filter.trackHash)) return false;
    if (artist && !clipArtistNames(c).some((a) => a.toLowerCase() === artist)) return false;
    const hay = [c.name, ...clipTrackNames(c), ...clipArtistNames(c)].join(' ');
    return matchesQuery(filter.query ?? '', hay);
  });
}
