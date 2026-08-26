// Audio module custom panel: pick a library track, watch it play on a
// waveform with a playhead, and toggle looping. Transport, BPM and speed
// themselves are ordinary knob-backed inputs on the panel below, so this
// UI stays a track selector, a waveform and a readout — plus the loop
// button, which drives the module's `loop` knob. Tests inject a mock
// AudioApi.
//
// React renders the waveform from the status poll; between polls the rAF
// loop in useAudioPlayhead extrapolates the position (wrapping when the
// track loops) and moves the playhead line by direct DOM mutation, the
// same discipline as DeckPanel.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { audio as defaultAudio, type AudioApi, type AudioStatus } from '../audio';
import { fixed, safeNumber } from '../format';
import type { Track } from '../library';
import { peaksPath, WAVEFORM_VIEW_W } from './WaveformView';

const POLL_MS = 100;
const WAVEFORM_BUCKETS = 600;
const WAVEFORM_H = 48;

export interface AudioPanelProps {
  instanceId: string;
  api?: AudioApi;
  /** Library tracks offered in the load selector. */
  tracks?: Track[];
  /** Called after a load so the rack picks up the module's new knobs
   *  (loading a track moves the BPM and speed dials). */
  onLoaded?(): void;
  /** Set the module's `loop` switch (a knob-backed input, so the rack
   *  owns the write — see AudioUIState). */
  onLoop?(on: boolean): void;
  pollMs?: number;
}

function fmtTime(secs: number): string {
  const total = safeNumber(secs);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Where the playhead is `dt` seconds after the sampled status: the
 *  engine wraps a looping track at its end, so the display does too. */
export function extrapolate(status: AudioStatus, dt: number): number {
  const dur = status.duration_secs;
  if (!(dur > 0)) return 0;
  const pos = status.position_secs + dt * status.rate;
  if (status.looping) return ((pos % dur) + dur) % dur;
  return Math.min(dur, Math.max(0, pos));
}

function useAudioPlayhead(rootRef: { current: HTMLDivElement | null }, status: AudioStatus | null) {
  const anchor = useRef<{ at: number; status: AudioStatus } | null>(null);
  // Re-anchor on each FRESH status object (each poll builds a new one) so
  // unrelated re-renders never rewind the extrapolation.
  useEffect(() => {
    anchor.current = status ? { at: performance.now(), status } : null;
  }, [status]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const root = rootRef.current;
      const a = anchor.current;
      if (!root || !a || !a.status.playing) return;
      const dur = a.status.duration_secs;
      if (!(dur > 0)) return;
      const pos = extrapolate(a.status, (performance.now() - a.at) / 1000);

      const line = root.querySelector<SVGLineElement>('[data-testid="audio-playhead"]');
      if (line) {
        const x = (pos / dur) * WAVEFORM_VIEW_W;
        line.setAttribute('x1', String(x));
        line.setAttribute('x2', String(x));
      }
      const time = root.querySelector<HTMLElement>('[data-testid="audio-time"]');
      if (time) {
        const shown = `${fmtTime(pos)} / ${fmtTime(dur)}`;
        if (time.textContent !== shown) time.textContent = shown;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rootRef]);
}

export function AudioPanel(props: AudioPanelProps) {
  const api = props.api ?? defaultAudio;
  const { instanceId } = props;
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const loadedTrack = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useAudioPlayhead(rootRef, status);

  const poll = useCallback(async () => {
    const st = await api.status(instanceId);
    if (!st) return;
    setStatus(st);
    if (st.track !== loadedTrack.current) {
      loadedTrack.current = st.track;
      const wf = await api.waveform(instanceId, WAVEFORM_BUCKETS);
      setPeaks(wf ?? []);
    }
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

  const duration = safeNumber(status?.duration_secs);
  const position = safeNumber(status?.position_secs);
  const playX = duration > 0 ? (Math.min(position, duration) / duration) * WAVEFORM_VIEW_W : null;
  const looping = status?.looping ?? true;

  return (
    <div className="audio-panel" data-testid={`audio-${instanceId}`} ref={rootRef}>
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
        <button
          type="button"
          data-testid="audio-loop"
          className={looping ? 'audio-loop on' : 'audio-loop'}
          aria-pressed={looping}
          title={looping ? 'Looping (click for one-shot)' : 'One-shot (click to loop)'}
          onClick={() => props.onLoop?.(!looping)}
        >
          ⟳
        </button>
      </div>
      <svg
        data-testid="audio-waveform"
        className="audio-waveform waveform-strip"
        viewBox={`0 0 ${WAVEFORM_VIEW_W} ${WAVEFORM_H}`}
        preserveAspectRatio="none"
      >
        <path className="waveform-peaks" d={peaksPath(peaks, 0, 1, WAVEFORM_H)} />
        {playX !== null && (
          <line
            data-testid="audio-playhead"
            className="waveform-playhead"
            x1={playX}
            x2={playX}
            y1={0}
            y2={WAVEFORM_H}
          />
        )}
      </svg>
      <div className="audio-row audio-readout">
        <span data-testid="audio-time">
          {fmtTime(position)} / {fmtTime(duration)}
        </span>
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
  setLoop(instance: string, on: boolean): void;
}

export const AudioUIContext = createContext<AudioUIState>({
  tracks: [],
  onLoaded: () => {},
  setLoop: () => {},
});

export function AudioCustomUI(props: { instanceId?: string }) {
  const ctx = useContext(AudioUIContext);
  const instanceId = props.instanceId ?? '';
  return (
    <AudioPanel
      instanceId={instanceId}
      tracks={ctx.tracks}
      onLoaded={ctx.onLoaded}
      onLoop={(on) => ctx.setLoop(instanceId, on)}
    />
  );
}
