// The DAW bottom bar: a native, always-present multi-track timeline docked
// below the rack (it takes layout space — never floats over module space).
// Collapsed (the default) it shrinks to a single strip that still renders
// every track's jacks, so wires from the modules above stay visibly
// connected; expanded it shows one lane per track with a ±10 V min/max
// graph of the clip (waveform for audio tracks, value trace for
// continuous), transport controls, import-from-library, and recording
// (input jacks or mic).
//
// The engine side is the always-present `daw` node (crates/dj-engine/
// src/daw.rs): each track owns 1-2 contiguous jack slots on BOTH sides —
// `i<slot>` inputs (the record source) and `t<slot>` outputs (clip
// playback). Track state and transport come from one polled `daw_status`
// command (the choreo-panel pattern); clip graphs from `daw_clip_peaks`.

import { useCallback, useEffect, useRef, useState } from 'react';
import { dawTrackChannels, type DawStatus, type DawTrack, type WireSnapshot } from '../engine';
import type { Track } from '../library';
import { DAW_INSTANCE, loadJson, saveJson, useRackSelector, type PendingWire } from '../rackStore';
import type { JackTelemetry } from '../types';
import { Jack } from './Jack';

/** IPC surface the bar needs; App adapts EngineClient onto this. */
export interface DawApi {
  status(): Promise<DawStatus | null>;
  addTrack(name: string, kind: 'audio' | 'continuous', stereo: boolean): Promise<unknown>;
  removeTrack(track: number): Promise<unknown>;
  renameTrack(track: number, name: string): Promise<unknown>;
  moveTrack(from: number, to: number): Promise<unknown>;
  importClip(track: number, path: string): Promise<unknown>;
  clearClip(track: number): Promise<unknown>;
  play(): Promise<unknown>;
  stop(): Promise<unknown>;
  seek(frames: number): Promise<unknown>;
  recordStart(track: number, source: 'input' | 'mic'): Promise<unknown>;
  recordStop(): Promise<unknown>;
  recordCancel(): Promise<unknown>;
  clipPeaks(track: number, bins: number): Promise<[number, number][] | null>;
  endEdit(): Promise<unknown>;
}

export interface DawBarProps {
  api: DawApi;
  /** Library tracks offered in each lane's import selector. */
  libraryTracks: Track[];
  onJackClick(instance: string, kind: 'input' | 'output', jack: string, shift?: boolean): void;
  /** Called after any track add/remove/rename so App refreshes wires. */
  onChanged(): void;
  /** Status poll interval in ms (tests dial it down). */
  pollMs?: number;
}

const COLLAPSED_KEY = 'dj-daw-collapsed';
export const GRAPH_W = 220;
export const GRAPH_H = 52;
const VMAX = 10;

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** ±10 V min/max-per-bin trace of a track's clip, with playhead. Click to
 *  seek the shared transport to that point in the clip. */
export function ClipGraph({
  track,
  peaks,
  clipFrames,
  playhead,
  onSeek,
}: {
  track: number;
  peaks: [number, number][];
  clipFrames: number;
  playhead: number;
  onSeek(frames: number): void;
}) {
  const mid = GRAPH_H / 2;
  const y = (v: number) => mid - (Math.max(-VMAX, Math.min(VMAX, v)) / VMAX) * mid;
  // One band polygon: top edge = per-bin max left→right, bottom edge =
  // per-bin min right→left.
  let band = '';
  if (peaks.length > 0) {
    const w = GRAPH_W / peaks.length;
    const top = peaks.map((p, i) => `${(i + 0.5) * w},${y(p[1])}`);
    const bottom = peaks.map((p, i) => `${(i + 0.5) * w},${y(p[0])}`).reverse();
    band = [...top, ...bottom].join(' ');
  }
  const px = clipFrames > 0 ? Math.min(1, playhead / clipFrames) * GRAPH_W : -1;
  return (
    <svg
      width={GRAPH_W}
      height={GRAPH_H}
      className="daw-graph"
      data-testid={`daw-graph-${track}`}
      onPointerDown={(e) => {
        if (clipFrames <= 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        onSeek(Math.round(frac * clipFrames));
      }}
    >
      <line x1={0} x2={GRAPH_W} y1={mid} y2={mid} className="daw-graph-zero" />
      {band && (
        <polygon points={band} className="daw-graph-band" data-testid={`daw-band-${track}`} />
      )}
      {peaks.length === 0 && (
        <text x={GRAPH_W / 2} y={mid - 4} className="daw-graph-empty" textAnchor="middle">
          no clip
        </text>
      )}
      {px >= 0 && playhead <= clipFrames && (
        <line
          x1={px}
          x2={px}
          y1={0}
          y2={GRAPH_H}
          className="daw-playhead"
          data-testid={`daw-playhead-${track}`}
        />
      )}
    </svg>
  );
}

/** The jacks a track owns, rendered identically in the collapsed strip and
 *  the expanded lane so wires stay anchored across the toggle. */
function TrackJacks({
  track,
  telemetry,
  wires,
  pending,
  onJackClick,
  showLabel,
}: {
  track: DawTrack;
  telemetry?: Record<string, JackTelemetry>;
  wires: WireSnapshot[];
  pending: PendingWire | null;
  onJackClick: DawBarProps['onJackClick'];
  showLabel: boolean;
}) {
  const slots = Array.from({ length: dawTrackChannels(track) }, (_, c) => track.jack + c);
  return (
    <span className="daw-track-jacks">
      {slots.map((slot, c) => {
        const suffix = slots.length === 2 ? (c === 0 ? ' L' : ' R') : '';
        return (
          <span className="daw-jack-pair" key={slot}>
            <Jack
              instance={DAW_INSTANCE}
              id={`i${slot}`}
              kind="input"
              label={`in${suffix}`}
              telemetry={telemetry?.[`i${slot}`]}
              wired={wires.some((w) => w.to_instance === DAW_INSTANCE && w.to_jack === `i${slot}`)}
              selected={
                pending?.instance === DAW_INSTANCE &&
                pending.kind === 'input' &&
                pending.jack === `i${slot}`
              }
              onClick={(shift) => onJackClick(DAW_INSTANCE, 'input', `i${slot}`, shift)}
              showLabel={showLabel}
            />
            <Jack
              instance={DAW_INSTANCE}
              id={`t${slot}`}
              kind="output"
              label={`out${suffix}`}
              telemetry={telemetry?.[`out:t${slot}`]}
              selected={
                pending?.instance === DAW_INSTANCE &&
                pending.kind === 'output' &&
                pending.jack === `t${slot}`
              }
              onClick={(shift) => onJackClick(DAW_INSTANCE, 'output', `t${slot}`, shift)}
              showLabel={showLabel}
            />
          </span>
        );
      })}
    </span>
  );
}

export function DawBar({ api, libraryTracks, onJackClick, onChanged, pollMs = 150 }: DawBarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => loadJson(COLLAPSED_KEY, true));
  const [status, setStatus] = useState<DawStatus | null>(null);
  const [peaks, setPeaks] = useState<Record<number, [number, number][]>>({});
  const [addName, setAddName] = useState('');
  const [addKind, setAddKind] = useState<'audio' | 'continuous'>('audio');
  const [addStereo, setAddStereo] = useState(false);
  const pending = useRackSelector((s) => s.pending);
  const wires = useRackSelector((s) => s.wires);
  const telemetry = useRackSelector((s) => s.telemetry[DAW_INSTANCE]);

  const refresh = useCallback(async () => {
    const st = await api.status();
    if (st) setStatus(st);
  }, [api]);

  // Initial fetch via timeout(0) (setState directly in an effect body trips
  // react-hooks/set-state-in-effect), then interval — the choreo pattern.
  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), pollMs);
    return () => {
      clearTimeout(initial);
      clearInterval(t);
    };
  }, [refresh, pollMs]);

  // Re-fetch a lane's graph when its clip identity changes (path or
  // length — a finished recording keeps the path shape but grows frames).
  const clipKeys = status
    ? status.tracks.map((t, i) => `${t.clip ?? ''}:${status.clip_frames[i] ?? 0}`).join('|')
    : '';
  const lastClipKeys = useRef('');
  useEffect(() => {
    if (!status || clipKeys === lastClipKeys.current) return;
    lastClipKeys.current = clipKeys;
    void (async () => {
      const next: Record<number, [number, number][]> = {};
      for (let i = 0; i < status.tracks.length; i++) {
        next[i] = (status.clip_frames[i] ?? 0) > 0 ? ((await api.clipPeaks(i, 96)) ?? []) : [];
      }
      setPeaks(next);
    })();
  }, [status, clipKeys, api]);

  const toggle = () => {
    setCollapsed((c) => {
      saveJson(COLLAPSED_KEY, !c);
      return !c;
    });
  };

  const changed = useCallback(async () => {
    await refresh();
    onChanged();
  }, [refresh, onChanged]);

  const addTrack = async () => {
    const name = addName.trim() || `track ${(status?.tracks.length ?? 0) + 1}`;
    await api.addTrack(name, addKind, addKind === 'audio' && addStereo);
    setAddName('');
    await changed();
  };

  const recording = status?.recording ?? null;
  const rate = status?.sample_rate || 48000;

  const transport = (
    <span className="daw-transport">
      <button
        data-testid="daw-play"
        className="daw-btn"
        data-tip={status?.playing ? 'stop the DAW transport' : 'play from the current position'}
        onClick={() => void (status?.playing ? api.stop() : api.play()).then(refresh)}
      >
        {status?.playing ? '⏹' : '▶'}
      </button>
      <button
        data-testid="daw-rewind"
        className="daw-btn"
        data-tip="rewind to the start"
        onClick={() => void api.seek(0).then(refresh)}
      >
        ⏮
      </button>
      <span className="daw-time" data-testid="daw-time">
        {fmtTime((status?.playhead ?? 0) / rate)}
      </span>
    </span>
  );

  return (
    <div className={`daw-bar${collapsed ? ' daw-bar-collapsed' : ''}`} data-testid="daw-bar">
      <div className="daw-bar-header">
        <button
          data-testid="daw-toggle"
          className="daw-btn daw-toggle"
          data-tip={collapsed ? 'expand the DAW' : 'collapse the DAW to a single strip'}
          onClick={toggle}
        >
          {collapsed ? '▴' : '▾'} DAW
        </button>
        {transport}
        {recording !== null && (
          <span className="daw-rec-live" data-testid="daw-rec-live">
            ● rec {status ? fmtTime(status.record_frames / rate) : ''}
          </span>
        )}
        {collapsed && (
          <span className="daw-strip" data-testid="daw-strip">
            {(status?.tracks ?? []).map((t, i) => (
              <span className="daw-strip-track" key={t.jack} data-testid={`daw-strip-track-${i}`}>
                <span className="daw-strip-name">{t.name}</span>
                <TrackJacks
                  track={t}
                  telemetry={telemetry}
                  wires={wires}
                  pending={pending}
                  onJackClick={onJackClick}
                  showLabel={false}
                />
              </span>
            ))}
          </span>
        )}
      </div>
      {!collapsed && (
        <div className="daw-lanes" data-testid="daw-lanes">
          {(status?.tracks ?? []).map((t, i) => (
            <div className="daw-lane" key={t.jack} data-testid={`daw-lane-${i}`}>
              <div className="daw-lane-side">
                <input
                  className="daw-track-name"
                  data-testid={`daw-name-${i}`}
                  defaultValue={t.name}
                  key={`${t.jack}:${t.name}`}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== t.name) {
                      void api.renameTrack(i, name).then(changed).then(api.endEdit);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                />
                <span className="daw-track-kind" data-testid={`daw-kind-${i}`}>
                  {t.kind === 'audio' ? (t.stereo ? 'audio · stereo' : 'audio · mono') : 'CV'}
                </span>
                <span className="daw-lane-order">
                  <button
                    className="daw-btn"
                    data-testid={`daw-up-${i}`}
                    disabled={i === 0}
                    data-tip="move track up"
                    onClick={() =>
                      void api
                        .moveTrack(i, i - 1)
                        .then(changed)
                        .then(api.endEdit)
                    }
                  >
                    ↑
                  </button>
                  <button
                    className="daw-btn"
                    data-testid={`daw-down-${i}`}
                    disabled={i === (status?.tracks.length ?? 0) - 1}
                    data-tip="move track down"
                    onClick={() =>
                      void api
                        .moveTrack(i, i + 1)
                        .then(changed)
                        .then(api.endEdit)
                    }
                  >
                    ↓
                  </button>
                  <button
                    className="daw-btn daw-remove"
                    data-testid={`daw-remove-${i}`}
                    data-tip="remove this track (wires to its jacks are unplugged)"
                    onClick={() => void api.removeTrack(i).then(changed)}
                  >
                    ×
                  </button>
                </span>
              </div>
              <TrackJacks
                track={t}
                telemetry={telemetry}
                wires={wires}
                pending={pending}
                onJackClick={onJackClick}
                showLabel
              />
              <ClipGraph
                track={i}
                peaks={peaks[i] ?? []}
                clipFrames={status?.clip_frames[i] ?? 0}
                playhead={status?.playhead ?? 0}
                onSeek={(frames) => void api.seek(frames).then(refresh)}
              />
              <div className="daw-lane-actions">
                {recording === i ? (
                  <>
                    <button
                      className="daw-btn daw-rec-stop"
                      data-testid={`daw-rec-stop-${i}`}
                      data-tip="finish the take (saved to the library)"
                      onClick={() => void api.recordStop().then(changed)}
                    >
                      ■ stop
                    </button>
                    <button
                      className="daw-btn"
                      data-testid={`daw-rec-cancel-${i}`}
                      data-tip="discard the take"
                      onClick={() => void api.recordCancel().then(refresh)}
                    >
                      ✕
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="daw-btn daw-rec"
                      data-testid={`daw-rec-input-${i}`}
                      disabled={recording !== null}
                      data-tip="record this track's input jacks"
                      onClick={() => void api.recordStart(i, 'input').then(refresh)}
                    >
                      ● in
                    </button>
                    {t.kind === 'audio' && (
                      <button
                        className="daw-btn daw-rec"
                        data-testid={`daw-rec-mic-${i}`}
                        disabled={recording !== null}
                        data-tip="record from the microphone"
                        onClick={() => void api.recordStart(i, 'mic').then(refresh)}
                      >
                        ● mic
                      </button>
                    )}
                  </>
                )}
                <select
                  className="daw-import"
                  data-testid={`daw-import-${i}`}
                  value=""
                  data-tip="load a library track as this track's clip"
                  onChange={(e) => {
                    const path = e.target.value;
                    if (path) void api.importClip(i, path).then(changed);
                  }}
                >
                  <option value="">
                    {t.clip ? (t.clip.split('/').pop() ?? 'clip') : 'import…'}
                  </option>
                  {libraryTracks.map((lt) => (
                    <option key={lt.id} value={lt.file_path}>
                      {lt.artist ? `${lt.artist} – ${lt.title}` : lt.title}
                    </option>
                  ))}
                </select>
                {t.clip && (
                  <button
                    className="daw-btn"
                    data-testid={`daw-clear-${i}`}
                    data-tip="clear the clip (the file stays in the library)"
                    onClick={() => void api.clearClip(i).then(changed)}
                  >
                    clear
                  </button>
                )}
              </div>
            </div>
          ))}
          <div className="daw-add" data-testid="daw-add">
            <input
              className="daw-track-name"
              data-testid="daw-add-name"
              placeholder="new track"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addTrack();
              }}
            />
            <select
              data-testid="daw-add-kind"
              value={addKind}
              onChange={(e) => setAddKind(e.target.value as 'audio' | 'continuous')}
            >
              <option value="audio">audio</option>
              <option value="continuous">continuous (CV)</option>
            </select>
            {addKind === 'audio' && (
              <label className="daw-stereo">
                <input
                  type="checkbox"
                  data-testid="daw-add-stereo"
                  checked={addStereo}
                  onChange={(e) => setAddStereo(e.target.checked)}
                />
                stereo
              </label>
            )}
            <button className="daw-btn" data-testid="daw-add-track" onClick={() => void addTrack()}>
              + track
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
