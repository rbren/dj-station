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

/** What a clip row says it was cut from: the titles of its sources, or
 *  an honest line when the library no longer has them (a clip outlives
 *  its source, and the pickers still have to name it somehow). */
export function clipSourceLabel(clip: BeatClipEntry): string {
  const titles = clip.sources.map((s) => s.title).filter((t): t is string => !!t);
  if (titles.length > 0) return titles.join(' + ');
  return clip.sources.length > 0 ? 'source not in the library' : 'no source recorded';
}
