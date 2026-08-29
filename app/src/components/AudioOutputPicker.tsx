// WHICH HARDWARE the two buses play out of, in the chrome at the top of
// the app. It lives up there rather than on one page because the choice
// belongs to the MACHINE, not to a patch or a tab — and because the moment
// you need it most is the moment a device has just left (the headphones
// come out mid-set), which can happen while you are looking at anything.
//
// It POLLS. The device list, the pair chosen and the pair actually reached
// all change without the app doing anything: unplug the live output and
// the engine drops that stream, falls back to the system default and says
// so. The `note` is the ENGINE's own line about why it is not playing
// where it was asked to — the picker shows it, never invents one.

import { useCallback, useEffect, useState } from 'react';
import {
  audioOutputs as defaultApi,
  type AudioOutputSettings,
  type AudioOutputsApi,
} from '../audioOutputs';

const BUSES = ['live', 'monitor'] as const;
type Bus = (typeof BUSES)[number];

const POLL_MS = 2000;

const NOTHING: AudioOutputSettings = {
  devices: [],
  live: null,
  monitor: null,
  playing_live: null,
  playing_monitor: null,
  note: null,
};

export interface AudioOutputPickerProps {
  api?: AudioOutputsApi;
  /** How often the devices and what is playing are re-read. */
  pollMs?: number;
}

export function AudioOutputPicker(props: AudioOutputPickerProps) {
  const api = props.api ?? defaultApi;
  const pollMs = props.pollMs ?? POLL_MS;
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
    async (bus: Bus, device: string | null) => {
      const next = { ...(outputs ?? NOTHING), [bus]: device };
      setOutputs(next);
      await api.set(next.live, next.monitor);
      const fresh = await api.get();
      if (fresh) setOutputs(fresh);
    },
    [api, outputs],
  );

  const note = outputs?.note ?? null;
  return (
    <div className="audio-outputs" data-testid="audio-outputs" data-state={note ? 'adrift' : 'ok'}>
      {BUSES.map((bus) => (
        <label className="audio-output" key={bus}>
          <span className="audio-output-label">{bus}</span>
          <select
            data-testid={`audio-output-${bus}`}
            aria-label={`${bus} audio output`}
            value={outputs?.[bus] ?? ''}
            onChange={(e) => void choose(bus, e.target.value || null)}
          >
            <option value="">{bus === 'live' ? 'system default' : 'no cue'}</option>
            {(outputs?.devices ?? []).map((device) => (
              <option key={device} value={device}>
                {device}
              </option>
            ))}
            {/* A remembered device that is not plugged in today still has
                to be shown, or the picker would silently say something
                the engine does not. */}
            {outputs?.[bus] && !outputs.devices.includes(outputs[bus]) && (
              <option value={outputs[bus]}>{outputs[bus]} (not found)</option>
            )}
          </select>
        </label>
      ))}
      {note && (
        <span className="audio-output-note" data-testid="audio-output-note" role="status">
          {note}
        </span>
      )}
    </div>
  );
}
