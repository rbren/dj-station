// Audio module custom panel: pick a library track to play and read back
// what the module is doing with it (length, tempo, speed). Transport, BPM
// and speed themselves are ordinary knob-backed inputs on the panel below,
// so this UI stays a track selector plus a readout. Tests inject a mock
// AudioApi.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { audio as defaultAudio, type AudioApi, type AudioStatus } from '../audio';
import { fixed, safeNumber } from '../format';
import type { Track } from '../library';

const POLL_MS = 500;

export interface AudioPanelProps {
  instanceId: string;
  api?: AudioApi;
  /** Library tracks offered in the load selector. */
  tracks?: Track[];
  /** Called after a load so the rack picks up the module's new knobs
   *  (loading a track moves the BPM and speed dials). */
  onLoaded?(): void;
  pollMs?: number;
}

function fmtTime(secs: number): string {
  const total = safeNumber(secs);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function AudioPanel(props: AudioPanelProps) {
  const api = props.api ?? defaultAudio;
  const { instanceId } = props;
  const [status, setStatus] = useState<AudioStatus | null>(null);

  const poll = useCallback(async () => {
    const st = await api.status(instanceId);
    if (st) setStatus(st);
  }, [api, instanceId]);

  useEffect(() => {
    // First poll on a timeout (keeps setState out of the effect body per
    // react-hooks/set-state-in-effect), then interval.
    const initial = setTimeout(() => void poll(), 0);
    const timer = setInterval(() => void poll(), props.pollMs ?? POLL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [poll, props.pollMs]);

  return (
    <div className="audio-panel" data-testid={`audio-${instanceId}`}>
      <div className="audio-row">
        <select
          data-testid="audio-track-select"
          value=""
          onChange={(e) => {
            const id = Number(e.target.value);
            if (!Number.isNaN(id) && e.target.value !== '') {
              void api.load(instanceId, id).then(() => {
                props.onLoaded?.();
                return poll();
              });
            }
          }}
        >
          <option value="">{status?.track ? status.track.split('/').pop() : 'load track…'}</option>
          {(props.tracks ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.artist ? `${t.artist} – ${t.title}` : t.title}
            </option>
          ))}
        </select>
      </div>
      <div className="audio-row audio-readout">
        <span data-testid="audio-length">{fmtTime(status?.duration_secs ?? 0)}</span>
        <span data-testid="audio-tempo">
          {fixed(status?.bpm, 1)} BPM · {fixed(status?.speed, 2)}×
        </span>
      </div>
    </div>
  );
}

/// Context + stable wrapper so App can register AudioPanel as a
/// ModulePanel custom UI (which only receives handle + instanceId) without
/// remounting it on every render.
export interface AudioUIState {
  tracks: Track[];
  onLoaded(): void;
}

export const AudioUIContext = createContext<AudioUIState>({
  tracks: [],
  onLoaded: () => {},
});

export function AudioCustomUI(props: { instanceId?: string }) {
  const ctx = useContext(AudioUIContext);
  return (
    <AudioPanel instanceId={props.instanceId ?? ''} tracks={ctx.tracks} onLoaded={ctx.onLoaded} />
  );
}
