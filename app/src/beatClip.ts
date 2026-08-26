// Beat Clip module bridge over Tauri IPC: the clips the module picker
// offers, importing one into a rack module, and what the module is
// playing. Mirrors `app/src-tauri/src/beat_clip.rs`; like every client
// here it resolves to null outside Tauri so the UI stays testable
// headless (tests inject a mock).

import { IpcClient } from './ipc';

/** The rack module a clip is imported as. */
export const BEAT_CLIP_TYPE = 'builtin.beat_clip';

/** One clip a Beat Clip module can be built from. */
export interface BeatClipEntry {
  projectId: string;
  projectName: string;
  clipId: string;
  name: string;
  /** The project's tempo — a clip is laid out on its grid. */
  bpm: number;
  /** Clip length in beats (trailing silence included). */
  beats: number;
}

/** Which clip a module is bound to. The patch persists this, never the
 *  audio: a clip is placements, re-assembled on load. */
export interface BeatClipRef {
  project: string;
  clip: string;
  name: string;
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
  load(instance: string, projectId: string, clipId: string): Promise<string | null>;
  status(instance: string): Promise<BeatClipStatus | null>;
}

export class BeatClipClient extends IpcClient implements BeatClipApi {
  list() {
    return this.call<BeatClipEntry[]>('beat_clip_list');
  }
  load(instance: string, projectId: string, clipId: string) {
    return this.call<string>('beat_clip_load', { instance, projectId, clipId });
  }
  status(instance: string) {
    return this.call<BeatClipStatus>('beat_clip_status', { instance });
  }
}

export const beatClip = new BeatClipClient();
