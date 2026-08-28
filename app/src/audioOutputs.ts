// Where the two output buses play: the LIVE mix (the room) and the
// MONITOR mix (the headphones a deck's Monitor button cues into). Mirrors
// the `audio_outputs` / `set_audio_outputs` commands in
// `app/src-tauri/src/main.rs`.
//
// The choice is a property of the MACHINE, not of the patch — it is kept
// beside the app's data, and a patch carried to another computer picks up
// that computer's devices. `null` means "the system default output",
// which is what a fresh install runs on.

import { IpcClient } from './ipc';

export interface AudioOutputSettings {
  /** Every output device the machine can see, by name. */
  devices: string[];
  live: string | null;
  monitor: string | null;
}

export interface AudioOutputsApi {
  get(): Promise<AudioOutputSettings | null>;
  /** Point the buses at devices; restarts the audio backend if it is
   *  running, because the streams are opened when it starts. */
  set(live: string | null, monitor: string | null): Promise<void | null>;
}

export class AudioOutputsClient extends IpcClient implements AudioOutputsApi {
  get() {
    return this.call<AudioOutputSettings>('audio_outputs');
  }
  set(live: string | null, monitor: string | null) {
    return this.call<void>('set_audio_outputs', { live, monitor });
  }
}

export const audioOutputs = new AudioOutputsClient();
