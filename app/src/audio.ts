// Audio module bridge over Tauri IPC. Mirrors the engine's AudioStatus and
// audio_* commands; falls back to nulls outside Tauri so the UI stays
// testable headless (tests inject a mock client).

import { IpcClient } from './ipc';

export interface AudioStatus {
  track: string | null;
  duration_secs: number;
  /** Audible position in track seconds as of the engine's last block. */
  position_secs: number;
  /** Track seconds per output second — what the playhead moves at. */
  rate: number;
  /** The audio is actually advancing right now. */
  playing: boolean;
  /** Clock tempo the BPM input is set to. */
  bpm: number;
  /** Playback rate multiplier the speed input is set to. */
  speed: number;
  /** Loop switch position. */
  looping: boolean;
}

/** What AudioPanel needs; the Tauri-backed client below implements it and
 *  tests substitute a mock. */
export interface AudioApi {
  load(instance: string, trackId: number): Promise<void | null>;
  status(instance: string): Promise<AudioStatus | null>;
  waveform(instance: string, buckets: number): Promise<number[] | null>;
}

export class AudioClient extends IpcClient implements AudioApi {
  load(instance: string, trackId: number) {
    return this.call<void>('audio_load', { instance, trackId });
  }
  status(instance: string) {
    return this.call<AudioStatus>('audio_status', { instance });
  }
  waveform(instance: string, buckets: number) {
    return this.call<number[]>('audio_waveform', { instance, buckets });
  }
}

export const audio = new AudioClient();
