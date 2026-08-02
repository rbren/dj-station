// DJ Deck custom panel (PRD §7): waveform views, transport, pitch fader
// state, 8 hot cues, loop controls with saved loops, manual beatgrid
// (tap / nudge / anchor), keylock/slip/reverse toggles, and beat-sync to
// another deck. Everything drives the engine over the deck IPC client;
// tests inject a mock DeckApi.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { deck as defaultDeck, type DeckApi, type DeckStatus, type SavedLoop } from '../deck';
import type { Track } from '../library';
import type { ModuleHandle } from '../types';
import { WaveformView } from './WaveformView';

const WAVEFORM_BUCKETS = 800;
const POLL_MS = 100;

export interface DeckPanelProps {
  instanceId: string;
  handle: ModuleHandle;
  api?: DeckApi;
  /** Library tracks offered in the load selector. */
  tracks?: Track[];
  /** Other deck instances offered as sync masters. */
  otherDecks?: string[];
  /** Drives the play_gate input knob (transport play/pause). */
  onPlayGate?(high: boolean): void;
  pollMs?: number;
}

function fmtTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function DeckPanel(props: DeckPanelProps) {
  const api = props.api ?? defaultDeck;
  const { instanceId } = props;
  const [status, setStatus] = useState<DeckStatus | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [savedLoops, setSavedLoops] = useState<SavedLoop[]>([]);
  const [loopIn, setLoopIn] = useState<number | null>(null);
  const loadedTrack = useRef<string | null>(null);

  const refreshMeta = useCallback(async () => {
    const wf = await api.waveform(instanceId, WAVEFORM_BUCKETS);
    if (wf) setPeaks(wf);
    const loops = await api.savedLoops(instanceId);
    if (loops) setSavedLoops(loops);
  }, [api, instanceId]);

  const poll = useCallback(async () => {
    const st = await api.status(instanceId);
    if (!st) return;
    setStatus(st);
    if (st.track !== loadedTrack.current) {
      loadedTrack.current = st.track;
      await refreshMeta();
    }
  }, [api, instanceId, refreshMeta]);

  useEffect(() => {
    // First poll on a microtask-ish timeout (keeps setState out of the
    // effect body per react-hooks/set-state-in-effect), then interval.
    const initial = setTimeout(() => void poll(), 0);
    const timer = setInterval(() => void poll(), props.pollMs ?? POLL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [poll, props.pollMs]);

  const cues = status?.cues ?? Array<number | null>(8).fill(null);
  const playing = status?.playing ?? false;
  const pos = status?.position_secs ?? 0;

  const onCue = (slot: number) => {
    const at = cues[slot];
    // Set on empty slot, jump on a filled one (clear via right-click).
    void (
      at === null || at === undefined ? api.setCue(instanceId, slot, pos) : api.seek(instanceId, at)
    ).then(poll);
  };

  const paramOn = (id: string) => props.handle.paramValue(id) >= 0.5;
  const toggleParam = (id: string) => props.handle.setParam(id, paramOn(id) ? 0 : 1);

  return (
    <div className="deck-panel" data-testid={`deck-${instanceId}`}>
      <div className="deck-row deck-load-row">
        <select
          data-testid="deck-track-select"
          value=""
          onChange={(e) => {
            const id = Number(e.target.value);
            if (!Number.isNaN(id) && e.target.value !== '') {
              void api.load(instanceId, id).then(poll);
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
        <span className="deck-time" data-testid="deck-time">
          {fmtTime(pos)} / {fmtTime(status?.duration_secs ?? 0)}
        </span>
        <span className="deck-bpm" data-testid="deck-bpm">
          {status?.effective_bpm
            ? `${status.effective_bpm.toFixed(1)} BPM`
            : status?.grid_bpm
              ? `${status.grid_bpm.toFixed(1)} BPM`
              : 'no grid'}
        </span>
      </div>

      <WaveformView
        peaks={peaks}
        durationSecs={status?.duration_secs ?? 0}
        positionSecs={pos}
        cues={cues}
        loopStartSecs={status?.loop_start_secs}
        loopEndSecs={status?.loop_end_secs}
        loopEnabled={status?.loop_enabled}
        onSeek={(p) => void api.seek(instanceId, p).then(poll)}
      />

      <div className="deck-row deck-transport">
        <button
          data-testid="deck-play"
          className={playing ? 'deck-btn active' : 'deck-btn'}
          onClick={() => props.onPlayGate?.(!playing)}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          data-testid="deck-keylock"
          className={paramOn('keylock') ? 'deck-btn active' : 'deck-btn'}
          onClick={() => toggleParam('keylock')}
        >
          Keylock
        </button>
        <button
          data-testid="deck-slip"
          className={paramOn('slip') ? 'deck-btn active' : 'deck-btn'}
          onClick={() => toggleParam('slip')}
        >
          Slip
        </button>
        <button
          data-testid="deck-reverse"
          className={paramOn('reverse') ? 'deck-btn active' : 'deck-btn'}
          onClick={() => toggleParam('reverse')}
        >
          Rev
        </button>
        <label className="deck-sync">
          sync
          <select
            data-testid="deck-sync-select"
            value={status?.sync_to ?? ''}
            onChange={(e) =>
              void api.sync(instanceId, e.target.value === '' ? null : e.target.value).then(poll)
            }
          >
            <option value="">off</option>
            {(props.otherDecks ?? []).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="deck-row deck-cues">
        {cues.map((at, slot) => (
          <button
            key={slot}
            data-testid={`deck-cue-${slot + 1}`}
            className={at !== null && at !== undefined ? 'deck-cue set' : 'deck-cue'}
            title={
              at !== null && at !== undefined
                ? `cue ${slot + 1} @ ${fmtTime(at)} (right-click clears)`
                : `set cue ${slot + 1} at playhead`
            }
            onClick={() => onCue(slot)}
            onContextMenu={(e) => {
              e.preventDefault();
              void api.setCue(instanceId, slot, null).then(poll);
            }}
          >
            {slot + 1}
          </button>
        ))}
      </div>

      <div className="deck-row deck-loop">
        <button
          data-testid="deck-loop-in"
          className="deck-btn"
          onClick={() => setLoopIn(pos)}
          title="mark loop in at playhead"
        >
          In
        </button>
        <button
          data-testid="deck-loop-out"
          className="deck-btn"
          onClick={() => {
            const start = loopIn ?? status?.loop_start_secs;
            if (start !== null && start !== undefined && pos > start) {
              void api
                .setLoop(instanceId, start, pos)
                .then(() => api.loopEnable(instanceId, true))
                .then(poll);
            }
          }}
          title="set loop out at playhead and engage"
        >
          Out
        </button>
        <button
          data-testid="deck-loop-toggle"
          className={status?.loop_enabled ? 'deck-btn active' : 'deck-btn'}
          onClick={() =>
            void api.loopEnable(instanceId, !(status?.loop_enabled ?? false)).then(poll)
          }
        >
          Loop
        </button>
        <button
          data-testid="deck-loop-halve"
          className="deck-btn"
          onClick={() => void api.loopHalve(instanceId).then(poll)}
        >
          ½
        </button>
        <button
          data-testid="deck-loop-double"
          className="deck-btn"
          onClick={() => void api.loopDouble(instanceId).then(poll)}
        >
          ×2
        </button>
        <button
          data-testid="deck-loop-save"
          className="deck-btn"
          onClick={() =>
            void api
              .saveLoop(instanceId, `loop ${fmtTime(status?.loop_start_secs ?? 0)}`)
              .then(refreshMeta)
          }
          disabled={status?.loop_start_secs === null || status?.loop_start_secs === undefined}
        >
          Save
        </button>
        {savedLoops.map((l) => (
          <button
            key={l.id}
            data-testid={`deck-saved-loop-${l.id}`}
            className="deck-btn deck-saved-loop"
            title={`${l.name}: ${fmtTime(l.start_secs)} – ${fmtTime(l.end_secs)}`}
            onClick={() => void api.setLoop(instanceId, l.start_secs, l.end_secs).then(poll)}
          >
            {l.name || `${fmtTime(l.start_secs)}`}
          </button>
        ))}
      </div>

      <div className="deck-row deck-grid">
        <button
          data-testid="deck-tap"
          className="deck-btn"
          onClick={() => void api.tapTempo(instanceId).then(poll)}
          title="tap on the beat while the track plays"
        >
          Tap
        </button>
        <button
          data-testid="deck-nudge-back"
          className="deck-btn"
          onClick={() => void api.nudgeBeatgrid(instanceId, -0.01).then(poll)}
          title="shift grid 10 ms earlier"
        >
          ‹ grid
        </button>
        <button
          data-testid="deck-nudge-fwd"
          className="deck-btn"
          onClick={() => void api.nudgeBeatgrid(instanceId, 0.01).then(poll)}
          title="shift grid 10 ms later"
        >
          grid ›
        </button>
        <button
          data-testid="deck-anchor"
          className="deck-btn"
          onClick={() => void api.anchorHere(instanceId).then(poll)}
          title="anchor the grid at the playhead"
        >
          Anchor
        </button>
      </div>
    </div>
  );
}

/// Context + stable wrapper so App can register DeckPanel as a ModulePanel
/// custom UI (which only receives handle + instanceId) without remounting
/// it on every render.
export interface DeckUIState {
  tracks: Track[];
  deckInstances: string[];
  setPlayGate(instance: string, high: boolean): void;
}

export const DeckUIContext = createContext<DeckUIState>({
  tracks: [],
  deckInstances: [],
  setPlayGate: () => {},
});

export function DeckCustomUI(props: { handle: ModuleHandle; instanceId?: string }) {
  const ctx = useContext(DeckUIContext);
  const instanceId = props.instanceId ?? '';
  return (
    <DeckPanel
      instanceId={instanceId}
      handle={props.handle}
      tracks={ctx.tracks}
      otherDecks={ctx.deckInstances.filter((d) => d !== instanceId)}
      onPlayGate={(high) => ctx.setPlayGate(instanceId, high)}
    />
  );
}
