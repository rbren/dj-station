// DJ Deck custom panel (PRD §7): waveform views, transport, pitch fader
// state, 8 hot cues, loop controls with saved loops, manual beatgrid
// (tap / nudge / anchor), keylock/slip/reverse toggles, and beat-sync to
// another deck. Everything drives the engine over the deck IPC client;
// tests inject a mock DeckApi.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { deck as defaultDeck, type DeckApi, type DeckStatus, type SavedLoop } from '../deck';
import { fixed, safeNumber } from '../format';
import type { Track } from '../library';
import type { ModuleHandle } from '../types';
import { WaveformView, WAVEFORM_VIEW_W, zoomWindow } from './WaveformView';

const WAVEFORM_BUCKETS = 800;
const POLL_MS = 100;

/** Stem gain params on the deck module, UI order (M3). */
const STEMS = [
  { param: 'stem_vocals', label: 'Voc' },
  { param: 'stem_drums', label: 'Drm' },
  { param: 'stem_bass', label: 'Bas' },
  { param: 'stem_other', label: 'Oth' },
] as const;

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
  const total = safeNumber(secs);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Between-poll deck playhead extrapolation. The 100 ms status poll
 *  point-samples a continuously moving transport, so the playhead line
 *  advances in visible ~100 ms lurches (with poll-jitter irregularity on
 *  top). The transport is exactly predictable from the poll's own fields
 *  — position + signed rate while playing — so a rAF loop advances it
 *  linearly and repaints by direct DOM mutation (never React state: a
 *  frame must not re-render the panel). Each poll-driven render resets
 *  the DOM to sampled truth, snapping any accumulated error; seeks,
 *  loops and cue jumps land within one poll. */
function useDeckPlayhead(rootRef: { current: HTMLDivElement | null }, status: DeckStatus | null) {
  const anchor = useRef<{ at: number; status: DeckStatus } | null>(null);
  // Re-anchor on each FRESH status object (each poll builds a new one) —
  // keying the effect on `status` identity means unrelated re-renders
  // never rewind the extrapolation to a stale sample time.
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
      const st = a.status;
      const dur = st.duration_secs;
      if (!(dur > 0)) return;
      const dt = (performance.now() - a.at) / 1000;
      const pos = Math.min(dur, Math.max(0, st.position_secs + dt * st.rate));

      // Overview: move the playhead line (full-track window).
      const over = root.querySelector<SVGLineElement>('[data-testid="waveform-overview-playhead"]');
      if (over) {
        const x = (pos / dur) * WAVEFORM_VIEW_W;
        over.setAttribute('x1', String(x));
        over.setAttribute('x2', String(x));
      }

      // Zoom: the playhead line stays centered (React rendered it inside
      // the window); scroll the content group under it instead, using
      // the window the strip actually rendered (data-from/data-to).
      const zoom = root.querySelector<SVGSVGElement>('[data-testid="waveform-zoom"]');
      const scroll = zoom?.querySelector<SVGGElement>('.waveform-scroll');
      if (zoom && scroll) {
        const renderedFrom = Number(zoom.dataset.from);
        const renderedTo = Number(zoom.dataset.to);
        const span = renderedTo - renderedFrom;
        if (span > 0) {
          const now = zoomWindow(dur, pos);
          const dx = ((now.from - renderedFrom) / span) * WAVEFORM_VIEW_W;
          scroll.setAttribute('transform', `translate(${-dx} 0)`);
          // Keep the line on the (possibly edge-clamped) position.
          const line = zoom.querySelector<SVGLineElement>('[data-testid="waveform-zoom-playhead"]');
          if (line) {
            const x = ((pos / dur - now.from) / span) * WAVEFORM_VIEW_W;
            line.setAttribute('x1', String(x));
            line.setAttribute('x2', String(x));
          }
        }
      }

      // Time readout, at display resolution (0.1 s).
      const time = root.querySelector<HTMLElement>('[data-testid="deck-time"]');
      if (time) {
        const shown = `${fmtTime(pos)} / ${fmtTime(dur)}`;
        if (time.textContent !== shown) time.textContent = shown;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rootRef]);
}

export function DeckPanel(props: DeckPanelProps) {
  const api = props.api ?? defaultDeck;
  const { instanceId } = props;
  const [status, setStatus] = useState<DeckStatus | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [savedLoops, setSavedLoops] = useState<SavedLoop[]>([]);
  const [loopIn, setLoopIn] = useState<number | null>(null);
  const loadedTrack = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useDeckPlayhead(rootRef, status);

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

  // Stem gains mirror the module params locally so sliders re-render
  // immediately (the handle itself isn't reactive).
  const [stemGains, setStemGains] = useState<number[]>(() =>
    STEMS.map((s) => props.handle.paramValue(s.param)),
  );
  const preMute = useRef<number[]>([1, 1, 1, 1]);
  const setStemGain = (idx: number, value: number) => {
    props.handle.setParam(STEMS[idx].param, value);
    setStemGains((prev) => prev.map((g, i) => (i === idx ? value : g)));
  };
  const toggleStemMute = (idx: number) => {
    if (stemGains[idx] > 0) {
      preMute.current[idx] = stemGains[idx];
      setStemGain(idx, 0);
    } else {
      setStemGain(idx, preMute.current[idx] || 1);
    }
  };

  return (
    <div className="deck-panel" data-testid={`deck-${instanceId}`} ref={rootRef}>
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
            ? `${fixed(status.effective_bpm, 1)} BPM`
            : status?.grid_bpm
              ? `${fixed(status.grid_bpm, 1)} BPM`
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
            data-tip={
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
          data-tip="mark loop in at playhead"
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
          data-tip="set loop out at playhead and engage"
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
            data-tip={`${l.name}: ${fmtTime(l.start_secs)} – ${fmtTime(l.end_secs)}`}
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
          data-tip="tap on the beat while the track plays"
        >
          Tap
        </button>
        <button
          data-testid="deck-nudge-back"
          className="deck-btn"
          onClick={() => void api.nudgeBeatgrid(instanceId, -0.01).then(poll)}
          data-tip="shift grid 10 ms earlier"
        >
          ‹ grid
        </button>
        <button
          data-testid="deck-nudge-fwd"
          className="deck-btn"
          onClick={() => void api.nudgeBeatgrid(instanceId, 0.01).then(poll)}
          data-tip="shift grid 10 ms later"
        >
          grid ›
        </button>
        <button
          data-testid="deck-anchor"
          className="deck-btn"
          onClick={() => void api.anchorHere(instanceId).then(poll)}
          data-tip="anchor the grid at the playhead"
        >
          Anchor
        </button>
      </div>

      <div className="deck-row deck-stems" data-testid="deck-stems">
        {status?.stems_loaded ? (
          STEMS.map((s, idx) => (
            <label key={s.param} className="deck-stem" data-testid={`deck-stem-${s.param}`}>
              <button
                data-testid={`deck-stem-mute-${s.param}`}
                className={stemGains[idx] > 0 ? 'deck-btn' : 'deck-btn muted'}
                data-tip={`${stemGains[idx] > 0 ? 'mute' : 'unmute'} ${s.param.replace('stem_', '')}`}
                onClick={() => toggleStemMute(idx)}
              >
                {s.label}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={stemGains[idx]}
                data-testid={`deck-stem-gain-${s.param}`}
                onChange={(e) => setStemGain(idx, Number(e.target.value))}
              />
            </label>
          ))
        ) : (
          <button
            data-testid="deck-stems-load"
            className="deck-btn"
            disabled={!status?.track}
            data-tip="load cached stems for this track (available after analysis)"
            onClick={() => void api.loadStems(instanceId).then(poll)}
          >
            Stems
          </button>
        )}
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
