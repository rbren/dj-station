// WHICH HARDWARE the two buses play out of. The pickers live in the Decks
// page's top bar, one beside each master fader — the live pair and the
// monitor (cue) pair each choose their device right where their volume is
// set, so the row reads as one destination: its level and its hardware.
//
// The state POLLS. The device list, the pair chosen and the pair actually
// reached all change without the app doing anything: unplug the live
// output and the engine drops that stream, falls back to the system
// default and says so. The `note` is the ENGINE's own line about why it is
// not playing where it was asked to — the page shows it, never invents one.

import { useCallback, useEffect, useState } from 'react';
import {
  audioOutputs as defaultApi,
  type AudioOutputSettings,
  type AudioOutputsApi,
} from '../audioOutputs';

export type OutputBus = 'live' | 'monitor';

const POLL_MS = 2000;

const NOTHING: AudioOutputSettings = {
  devices: [],
  live: null,
  monitor: null,
  playing_live: null,
  playing_monitor: null,
  note: null,
};

export interface AudioOutputsState {
  outputs: AudioOutputSettings | null;
  choose: (bus: OutputBus, device: string | null) => Promise<void>;
}

/** The polled device state and the one write path both selects share:
 *  choosing on either bus sends BOTH buses, so the engine always hears a
 *  complete assignment. */
export function useAudioOutputs(
  api: AudioOutputsApi = defaultApi,
  pollMs = POLL_MS,
): AudioOutputsState {
  const [outputs, setOutputs] = useState<AudioOutputSettings | null>(null);

  useEffect(() => {
    let mounted = true;
    const read = async () => {
      const fresh = await api.get();
      if (mounted && fresh) setOutputs(fresh);
    };
    void read();
    const timer = setInterval(() => void read(), pollMs);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [api, pollMs]);

  const choose = useCallback(
    async (bus: OutputBus, device: string | null) => {
      const next = { ...(outputs ?? NOTHING), [bus]: device };
      setOutputs(next);
      await api.set(next.live, next.monitor);
      const fresh = await api.get();
      if (fresh) setOutputs(fresh);
    },
    [api, outputs],
  );

  return { outputs, choose };
}

export interface AudioOutputSelectProps {
  bus: OutputBus;
  outputs: AudioOutputSettings | null;
  onChoose: (bus: OutputBus, device: string | null) => void | Promise<void>;
}

/** One bus's device dropdown. */
export function AudioOutputSelect({ bus, outputs, onChoose }: AudioOutputSelectProps) {
  return (
    <select
      className="audio-output-select"
      data-testid={`audio-output-${bus}`}
      aria-label={`${bus} audio output`}
      value={outputs?.[bus] ?? ''}
      onChange={(e) => void onChoose(bus, e.target.value || null)}
    >
      <option value="">{bus === 'live' ? 'system default' : 'no cue'}</option>
      {(outputs?.devices ?? []).map((device) => (
        <option key={device} value={device}>
          {device}
        </option>
      ))}
      {/* A remembered device that is not plugged in today still has to be
          shown, or the select would silently say something the engine
          does not. */}
      {outputs?.[bus] && !outputs.devices.includes(outputs[bus]) && (
        <option value={outputs[bus]}>{outputs[bus]} (not found)</option>
      )}
    </select>
  );
}
