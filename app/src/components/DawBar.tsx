// The DAW bottom bar: a native, always-present multi-track timeline docked
// below the rack (it takes layout space — never floats over module space).
// Collapsed (the default) it shrinks to a single strip that still renders
// every track's jacks, so wires from the modules above stay visibly
// connected. Expanded it shows one lane per track: a fixed-width side stack
// on the left (name, kind, order/remove, jacks with recordable knobs on
// each input, record/import controls) and a time- and beat-aligned clip
// region on the right, all lanes sharing ONE horizontally scrollable
// timeline with a beat ruler, a snap-resolution grid, horizontal zoom
// (which scales ONLY the timeline, never the side stack), a BPM input and
// click-to-seek.
//
// Track kinds: audio (waveform clip), continuous (CV trace clip), and MIDI
// (a beat×pitch note grid — clicking a cell toggles a note at the global
// snap resolution; pitch renders on `t<slot>` at 1 V/oct and gate/velocity
// on `t<slot+1>`, the choreo note-track convention).
//
// The engine side is the always-present `daw` node (crates/dj-engine/
// src/daw.rs): each track owns 1-2 contiguous jack slots on BOTH sides —
// `i<slot>` inputs (the record source; each carries a knob whose value is
// what gets recorded when unwired) and `t<slot>` outputs. Track state,
// tempo, knob states and transport come from one polled `daw_status`
// command (the choreo-panel pattern); clip graphs from `daw_clip_peaks`.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  dawTrackChannels,
  type DawNote,
  type DawStatus,
  type DawTrack,
  type WireSnapshot,
} from '../engine';
import type { Track } from '../library';
import { DAW_INSTANCE, loadJson, saveJson, useRackSelector, type PendingWire } from '../rackStore';
import type { JackTelemetry, KnobState } from '../types';
import { Jack } from './Jack';
import { Knob } from './Knob';

/** IPC surface the bar needs; App adapts EngineClient onto this. */
export interface DawApi {
  status(): Promise<DawStatus | null>;
  addTrack(name: string, kind: 'audio' | 'continuous' | 'midi', stereo: boolean): Promise<unknown>;
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
  setBpm(bpm: number): Promise<unknown>;
  setLength(beats: number): Promise<unknown>;
  addNote(track: number, note: DawNote): Promise<unknown>;
  removeNote(track: number, beat: number, pitch: number): Promise<unknown>;
  setKnobPosition(jack: string, position: number): Promise<unknown>;
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
const ZOOM_KEY = 'dj-daw-zoom';
const SNAP_KEY = 'dj-daw-snap';
const HEIGHT_KEY = 'dj-daw-height';
const MIDI_BASE_KEY = 'dj-daw-midi-base';

const DEFAULT_BODY_H = 320;
const MIN_BODY_H = 120;

export const GRAPH_H = 52;
const VMAX = 10;

/** Global snap resolutions: note fraction -> beats (1 beat = 1/4 note).
 *  Triplets are the straight value × 2/3. */
export const SNAP_OPTIONS: { label: string; beats: number }[] = [
  { label: '1/1', beats: 4 },
  { label: '1/2', beats: 2 },
  { label: '1/4', beats: 1 },
  { label: '1/8', beats: 0.5 },
  { label: '1/16', beats: 0.25 },
  { label: '1/32', beats: 0.125 },
  { label: '1/2T', beats: 2 * (2 / 3) },
  { label: '1/4T', beats: 2 / 3 },
  { label: '1/8T', beats: 1 / 3 },
  { label: '1/16T', beats: 1 / 6 },
];

/** Horizontal zoom bounds/steps, pixels per beat. */
const ZOOM_MIN = 8;
const ZOOM_MAX = 320;
const ZOOM_STEP = 1.5;
const DEFAULT_ZOOM = 40;

/** MIDI grid: a 2-octave window (24 rows, top-down from the highest) into
 *  the full pitch range; per-track octave arrows slide it. */
export const MIDI_PITCH_MAX = 83; // B5, default window top
export const MIDI_WINDOW_ROWS = 24;
export const MIDI_BASE_MIN = 24; // C1
export const MIDI_BASE_MAX = 96; // C7
export const MIDI_ROW_H = 9;
/** Default window bottom: C4..B5. */
export const MIDI_DEFAULT_BASE = MIDI_PITCH_MAX - MIDI_WINDOW_ROWS + 1;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiNoteName(pitch: number): string {
  return `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** ±10 V min/max-per-bin trace of a track's clip, drawn time-aligned at
 *  the current zoom. Click to seek the shared transport (snapped). */
export function ClipGraph({
  track,
  peaks,
  clipFrames,
  width,
  onSeek,
}: {
  track: number;
  peaks: [number, number][];
  clipFrames: number;
  /** Rendered width in px — clipFrames mapped through zoom×bpm. */
  width: number;
  onSeek(frac: number): void;
}) {
  const mid = GRAPH_H / 2;
  const y = (v: number) => mid - (Math.max(-VMAX, Math.min(VMAX, v)) / VMAX) * mid;
  // One band polygon: top edge = per-bin max left→right, bottom edge =
  // per-bin min right→left.
  let band = '';
  if (peaks.length > 0) {
    const w = width / peaks.length;
    const top = peaks.map((p, i) => `${(i + 0.5) * w},${y(p[1])}`);
    const bottom = peaks.map((p, i) => `${(i + 0.5) * w},${y(p[0])}`).reverse();
    band = [...top, ...bottom].join(' ');
  }
  return (
    <svg
      width={Math.max(1, width)}
      height={GRAPH_H}
      className="daw-graph"
      data-testid={`daw-graph-${track}`}
      onPointerDown={(e) => {
        if (clipFrames <= 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        e.stopPropagation();
        onSeek(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
      }}
    >
      <line x1={0} x2={width} y1={mid} y2={mid} className="daw-graph-zero" />
      {band && (
        <polygon points={band} className="daw-graph-band" data-testid={`daw-band-${track}`} />
      )}
      {peaks.length === 0 && (
        <text x={width / 2} y={mid - 4} className="daw-graph-empty" textAnchor="middle">
          no clip
        </text>
      )}
    </svg>
  );
}

/** Beat×pitch note grid for a MIDI track: a 2-octave window starting at
 *  `basePitch`. Clicking an empty cell adds a note at the snap resolution
 *  (snap length); clicking a note removes it. Notes outside the window
 *  don't render (slide the window with the octave arrows to reach them). */
export function MidiGrid({
  track,
  notes,
  beats,
  pxPerBeat,
  snapBeats,
  basePitch = MIDI_DEFAULT_BASE,
  onToggle,
}: {
  track: number;
  notes: DawNote[];
  beats: number;
  pxPerBeat: number;
  snapBeats: number;
  /** Lowest visible pitch; window spans basePitch..basePitch+23. */
  basePitch?: number;
  onToggle(beat: number, pitch: number, existing: DawNote | undefined): void;
}) {
  const rows = MIDI_WINDOW_ROWS;
  const top = basePitch + rows - 1;
  const height = rows * MIDI_ROW_H;
  const width = beats * pxPerBeat;
  const rowY = (pitch: number) => (top - pitch) * MIDI_ROW_H;
  const gridLines: number[] = [];
  for (let b = 0; b <= beats + 1e-6; b += snapBeats) gridLines.push(b);
  return (
    <svg
      width={Math.max(1, width)}
      height={height}
      className="daw-midi-grid"
      data-testid={`daw-midi-grid-${track}`}
      onPointerDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        e.stopPropagation();
        const beat = Math.floor((e.clientX - rect.left) / pxPerBeat / snapBeats) * snapBeats;
        const pitch = top - Math.floor((e.clientY - rect.top) / MIDI_ROW_H);
        if (pitch < basePitch || pitch > top || beat < 0) return;
        // A click anywhere inside an existing note (same pitch) removes it.
        const existing = notes.find(
          (n) => n.pitch === pitch && beat >= n.beat - 1e-6 && beat < n.beat + n.len - 1e-6,
        );
        onToggle(beat, pitch, existing);
      }}
    >
      {/* black-key row shading */}
      {Array.from({ length: rows }, (_, r) => {
        const pitch = top - r;
        const black = [1, 3, 6, 8, 10].includes(pitch % 12);
        return black ? (
          <rect
            key={pitch}
            x={0}
            y={r * MIDI_ROW_H}
            width={width}
            height={MIDI_ROW_H}
            className="daw-midi-blackrow"
          />
        ) : null;
      })}
      {/* octave lines (C rows) */}
      {Array.from({ length: rows }, (_, r) => {
        const pitch = top - r;
        return pitch % 12 === 0 ? (
          <line
            key={pitch}
            x1={0}
            x2={width}
            y1={(r + 1) * MIDI_ROW_H}
            y2={(r + 1) * MIDI_ROW_H}
            className="daw-midi-octave"
          />
        ) : null;
      })}
      {gridLines.map((b) => (
        <line
          key={b}
          x1={b * pxPerBeat}
          x2={b * pxPerBeat}
          y1={0}
          y2={height}
          className={Math.abs(b - Math.round(b)) < 1e-6 ? 'daw-grid-beat' : 'daw-grid-snap'}
        />
      ))}
      {notes
        .filter((n) => n.pitch >= basePitch && n.pitch <= top)
        .map((n) => (
          <rect
            key={`${n.beat}:${n.pitch}`}
            x={n.beat * pxPerBeat}
            y={rowY(n.pitch)}
            width={Math.max(2, n.len * pxPerBeat - 1)}
            height={MIDI_ROW_H - 1}
            rx={1}
            className="daw-midi-note"
            data-testid={`daw-note-${track}-${n.beat}-${n.pitch}`}
          >
            <title>{`${midiNoteName(n.pitch)} @ beat ${n.beat}`}</title>
          </rect>
        ))}
    </svg>
  );
}

/** Sticky note-name gutter over a MIDI grid's left edge, same row
 *  geometry, with octave up/down arrows floating at its corners. It
 *  overlays the grid (negative margin) so the beat grid's x-origin stays
 *  ruler-aligned. */
function MidiGutter({
  track,
  basePitch,
  onShift,
}: {
  track: number;
  basePitch: number;
  onShift(deltaOctaves: number): void;
}) {
  const top = basePitch + MIDI_WINDOW_ROWS - 1;
  return (
    <span
      className="daw-midi-gutter"
      data-testid={`daw-midi-gutter-${track}`}
      style={{ height: MIDI_WINDOW_ROWS * MIDI_ROW_H }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="daw-midi-names">
        {Array.from({ length: MIDI_WINDOW_ROWS }, (_, r) => {
          const pitch = top - r;
          const black = [1, 3, 6, 8, 10].includes(pitch % 12);
          return (
            <span
              key={pitch}
              className={`daw-midi-name${black ? ' daw-midi-name-black' : ''}`}
              style={{ height: MIDI_ROW_H }}
            >
              {black ? '' : midiNoteName(pitch)}
            </span>
          );
        })}
      </span>
      <button
        className="daw-btn daw-octave-btn daw-octave-up"
        data-testid={`daw-octave-up-${track}`}
        data-tip="show the octave above"
        disabled={basePitch + 12 > MIDI_BASE_MAX}
        onClick={() => onShift(1)}
      >
        ↑
      </button>
      <button
        className="daw-btn daw-octave-btn daw-octave-down"
        data-testid={`daw-octave-down-${track}`}
        data-tip="show the octave below"
        disabled={basePitch - 12 < MIDI_BASE_MIN}
        onClick={() => onShift(-1)}
      >
        ↓
      </button>
    </span>
  );
}

/** The jacks a track owns (with a recordable knob under each input),
 *  rendered identically in the collapsed strip and the expanded lane so
 *  wires stay anchored across the toggle. */
function TrackJacks({
  track,
  telemetry,
  knobs,
  wires,
  pending,
  onJackClick,
  onKnob,
  onKnobDone,
  showLabel,
}: {
  track: DawTrack;
  telemetry?: Record<string, JackTelemetry>;
  knobs?: Record<string, KnobState>;
  wires: WireSnapshot[];
  pending: PendingWire | null;
  onJackClick: DawBarProps['onJackClick'];
  /** Absent in the collapsed strip: jacks only, no knobs. */
  onKnob?: (jack: string, position: number) => void;
  onKnobDone?: () => void;
  showLabel: boolean;
}) {
  const midi = track.kind === 'midi';
  const slots = Array.from({ length: dawTrackChannels(track) }, (_, c) => track.jack + c);
  return (
    <span className="daw-track-jacks">
      {slots.map((slot, c) => {
        const suffix = midi
          ? c === 0
            ? ' pitch'
            : ' gate'
          : slots.length === 2
            ? c === 0
              ? ' L'
              : ' R'
            : '';
        const knobState = knobs?.[`i${slot}`];
        return (
          <span className="daw-jack-pair" key={slot}>
            {/* MIDI tracks render notes, not input signals: outputs only. */}
            {!midi && (
              <span className="daw-in-cell">
                <Jack
                  instance={DAW_INSTANCE}
                  id={`i${slot}`}
                  kind="input"
                  label={`in${suffix}`}
                  telemetry={telemetry?.[`i${slot}`]}
                  wired={wires.some(
                    (w) => w.to_instance === DAW_INSTANCE && w.to_jack === `i${slot}`,
                  )}
                  selected={
                    pending?.instance === DAW_INSTANCE &&
                    pending.kind === 'input' &&
                    pending.jack === `i${slot}`
                  }
                  onClick={(shift) => onJackClick(DAW_INSTANCE, 'input', `i${slot}`, shift)}
                  showLabel={showLabel}
                />
                {onKnob && (
                  <Knob
                    label={`i${slot}`}
                    config={
                      knobState?.config ?? { style: 'continuous', min: 0, max: 10, curve: 'linear' }
                    }
                    position={knobState?.position ?? 0}
                    plain
                    wired={wires.some(
                      (w) => w.to_instance === DAW_INSTANCE && w.to_jack === `i${slot}`,
                    )}
                    atten={knobState?.atten}
                    offset={knobState?.offset}
                    onPosition={(p) => onKnob(`i${slot}`, p)}
                    onRelease={onKnobDone}
                  />
                )}
              </span>
            )}
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
  const [addKind, setAddKind] = useState<'audio' | 'continuous' | 'midi'>('audio');
  const [addStereo, setAddStereo] = useState(false);
  const [zoom, setZoom] = useState<number>(() => loadJson(ZOOM_KEY, DEFAULT_ZOOM));
  const [snap, setSnap] = useState<string>(() => loadJson(SNAP_KEY, '1/4'));
  const [bodyH, setBodyH] = useState<number>(() => loadJson(HEIGHT_KEY, DEFAULT_BODY_H));
  // Per-track MIDI window bottom, keyed by the track's stable jack slot
  // (indices shift when tracks reorder). View-only state: localStorage.
  const [midiBase, setMidiBase] = useState<Record<number, number>>(() =>
    loadJson(MIDI_BASE_KEY, {}),
  );
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

  // Spacebar toggles the transport. Route current playing state through a
  // ref so the listener mounts once (the qwerty-panel pattern). A qwerty
  // module's space gate calls preventDefault first — defer to it.
  const playingRef = useRef(false);
  const playingNow = status?.playing ?? false;
  useEffect(() => {
    playingRef.current = playingNow;
  }, [playingNow]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.defaultPrevented) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'SELECT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'BUTTON' ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault(); // space would scroll the rack
      void (playingRef.current ? api.stop() : api.play()).then(() => void refresh());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [api, refresh]);

  const bpm = status?.bpm ?? 120;
  const rate = status?.sample_rate || 48000;
  const pxPerBeat = zoom;
  const framesPerBeat = (rate * 60) / bpm;
  const snapBeats = SNAP_OPTIONS.find((o) => o.label === snap)?.beats ?? 1;

  // Timeline extent: the engine-set total length (canonical, persisted in
  // the patch), rounded up to a whole 4-beat bar. The transport stops at
  // lengthBeats; content past it stays visible but grayed out.
  const lengthBeats = status?.length_beats ?? 16;
  let contentBeats = 0;
  if (status) {
    for (let i = 0; i < status.tracks.length; i++) {
      const t = status.tracks[i];
      contentBeats = Math.max(contentBeats, (status.clip_frames[i] ?? 0) / framesPerBeat);
      for (const n of t.notes ?? []) contentBeats = Math.max(contentBeats, n.beat + n.len);
    }
    contentBeats = Math.max(
      contentBeats,
      status.playhead / framesPerBeat,
      status.record_frames / framesPerBeat,
    );
  }
  const totalBeats = Math.max(
    Math.ceil(lengthBeats / 4) * 4,
    contentBeats > 0 ? (Math.floor(contentBeats / 4) + 1) * 4 : 0,
  );
  const timelineW = totalBeats * pxPerBeat;
  // Region past the chosen length (content overflow): grayed out.
  const pastX = lengthBeats * pxPerBeat;
  const pastW = timelineW - pastX;

  const setLength = (beats: number) => {
    const b = Math.max(1, Math.round(beats));
    void api.setLength(b).then(refresh).then(api.endEdit);
  };

  const shiftMidiBase = (jack: number, deltaOctaves: number) => {
    setMidiBase((m) => {
      const cur = m[jack] ?? MIDI_DEFAULT_BASE;
      const next = Math.max(MIDI_BASE_MIN, Math.min(MIDI_BASE_MAX, cur + deltaOctaves * 12));
      const nm = { ...m, [jack]: next };
      saveJson(MIDI_BASE_KEY, nm);
      return nm;
    });
  };

  // Vertical resize: drag the handle strip above the body. Height is
  // view-only state (localStorage), like zoom.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = bodyH;
    const onMove = (ev: PointerEvent) => {
      setBodyH(Math.max(MIN_BODY_H, startH + (startY - ev.clientY)));
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      saveJson(HEIGHT_KEY, Math.max(MIN_BODY_H, startH + (startY - ev.clientY)));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Re-fetch a lane's graph when its clip identity or the zoom level
  // changes (bins scale with the rendered width so zooming in adds
  // resolution).
  const clipKeys = status
    ? status.tracks.map((t, i) => `${t.clip ?? ''}:${status.clip_frames[i] ?? 0}`).join('|') +
      `@${zoom}:${bpm}`
    : '';
  const lastClipKeys = useRef('');
  useEffect(() => {
    if (!status || clipKeys === lastClipKeys.current) return;
    lastClipKeys.current = clipKeys;
    void (async () => {
      const next: Record<number, [number, number][]> = {};
      for (let i = 0; i < status.tracks.length; i++) {
        const frames = status.clip_frames[i] ?? 0;
        if (frames > 0) {
          const widthPx = (frames / framesPerBeat) * pxPerBeat;
          const bins = Math.max(16, Math.min(2048, Math.round(widthPx / 2)));
          next[i] = (await api.clipPeaks(i, bins)) ?? [];
        } else {
          next[i] = [];
        }
      }
      setPeaks(next);
    })();
  }, [status, clipKeys, api, framesPerBeat, pxPerBeat]);

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

  const setZoomClamped = (z: number) => {
    const zz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    saveJson(ZOOM_KEY, zz);
    setZoom(zz);
  };

  const seekBeats = (beats: number) => {
    const snapped = Math.max(0, Math.round(beats / snapBeats) * snapBeats);
    void api.seek(Math.round(snapped * framesPerBeat)).then(refresh);
  };

  const toggleNote = (track: number, beat: number, pitch: number, existing?: DawNote) => {
    const act = existing
      ? api.removeNote(track, existing.beat, existing.pitch)
      : api.addNote(track, { beat, len: snapBeats, pitch, velocity: 1 });
    void act.then(refresh).then(api.endEdit);
  };

  const recording = status?.recording ?? null;
  // During a take the line tracks the recording (a finished take lands at
  // timeline zero); the transport playhead needn't be rolling (mic takes).
  const lineFrames = status
    ? status.recording !== null
      ? status.record_frames
      : status.playhead
    : 0;
  const playheadX = (lineFrames / framesPerBeat) * pxPerBeat;

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
      <Jack
        instance={DAW_INSTANCE}
        id="clock"
        kind="output"
        label="clock"
        telemetry={telemetry?.clock}
        wired={wires.some((w) => w.from_instance === DAW_INSTANCE && w.from_jack === 'clock')}
        selected={
          pending?.instance === DAW_INSTANCE &&
          pending.kind === 'output' &&
          pending.jack === 'clock'
        }
        onClick={(shift) => onJackClick(DAW_INSTANCE, 'output', 'clock', shift)}
        showLabel
      />
    </span>
  );

  const timelineControls = !collapsed && (
    <span className="daw-timeline-controls">
      <label className="daw-bpm-label">
        bpm
        <input
          className="daw-bpm"
          data-testid="daw-bpm"
          type="number"
          min={20}
          max={999}
          key={bpm}
          defaultValue={bpm}
          data-tip="timeline tempo: beat grid + MIDI note scheduling"
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= 20 && v <= 999 && v !== bpm) {
              void api.setBpm(v).then(refresh).then(api.endEdit);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
      <label className="daw-snap-label">
        snap
        <select
          className="daw-snap"
          data-testid="daw-snap"
          value={snap}
          data-tip="grid resolution: overlay lines + click quantization"
          onChange={(e) => {
            saveJson(SNAP_KEY, e.target.value);
            setSnap(e.target.value);
          }}
        >
          {SNAP_OPTIONS.map((o) => (
            <option key={o.label} value={o.label}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="daw-bpm-label">
        beats
        <input
          className="daw-bpm daw-length"
          data-testid="daw-length-beats"
          type="number"
          min={1}
          key={`b${lengthBeats}`}
          defaultValue={lengthBeats}
          data-tip="total timeline length in beats (grows if content runs past it)"
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= 1 && Math.round(v) !== lengthBeats) setLength(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
      <label className="daw-bpm-label">
        secs
        <input
          className="daw-bpm daw-length"
          data-testid="daw-length-secs"
          type="number"
          min={0.1}
          step={0.1}
          key={`s${lengthBeats}:${bpm}`}
          defaultValue={Number(((lengthBeats * 60) / bpm).toFixed(1))}
          data-tip="total timeline length in seconds (converted to beats at the current BPM)"
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) {
              const beats = Math.round((v * bpm) / 60);
              if (beats >= 1 && beats !== lengthBeats) setLength(beats);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
      <span className="daw-zoom">
        <button
          className="daw-btn"
          data-testid="daw-zoom-out"
          data-tip="zoom the timeline out"
          disabled={zoom <= ZOOM_MIN}
          onClick={() => setZoomClamped(zoom / ZOOM_STEP)}
        >
          −
        </button>
        <button
          className="daw-btn"
          data-testid="daw-zoom-in"
          data-tip="zoom the timeline in"
          disabled={zoom >= ZOOM_MAX}
          onClick={() => setZoomClamped(zoom * ZOOM_STEP)}
        >
          +
        </button>
      </span>
    </span>
  );

  // Grid line positions shared by the ruler and every lane.
  const gridLines: { beat: number; kind: 'bar' | 'beat' | 'snap' }[] = [];
  for (let b = 0; b <= totalBeats + 1e-6; b += snapBeats) {
    const isBeat = Math.abs(b - Math.round(b)) < 1e-6;
    const isBar = isBeat && Math.round(b) % 4 === 0;
    gridLines.push({ beat: b, kind: isBar ? 'bar' : isBeat ? 'beat' : 'snap' });
  }

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
        {timelineControls}
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
        <div
          className="daw-resize"
          data-testid="daw-resize"
          data-tip="drag to resize the DAW"
          onPointerDown={startResize}
        />
      )}
      {!collapsed && (
        <div className="daw-body" data-testid="daw-lanes" style={{ height: bodyH }}>
          <div className="daw-scroll" data-testid="daw-scroll">
            {/* Ruler row: empty sticky side spacer + beat ruler. */}
            <div className="daw-row daw-ruler-row">
              <div className="daw-side daw-side-spacer" />
              <div className="daw-timeline" style={{ width: timelineW }}>
                <svg
                  width={timelineW}
                  height={18}
                  className="daw-ruler"
                  data-testid="daw-ruler"
                  onPointerDown={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    seekBeats((e.clientX - rect.left) / pxPerBeat);
                  }}
                >
                  {gridLines.map((g) => (
                    <line
                      key={g.beat}
                      x1={g.beat * pxPerBeat}
                      x2={g.beat * pxPerBeat}
                      y1={g.kind === 'bar' ? 2 : g.kind === 'beat' ? 8 : 13}
                      y2={18}
                      className={`daw-ruler-${g.kind}`}
                    />
                  ))}
                  {Array.from({ length: Math.floor(totalBeats / 4) + 1 }, (_, bar) => (
                    <text key={bar} x={bar * 4 * pxPerBeat + 3} y={9} className="daw-ruler-label">
                      {bar + 1}
                    </text>
                  ))}
                  {pastW > 0 && (
                    <rect
                      x={pastX}
                      y={0}
                      width={pastW}
                      height={18}
                      className="daw-past-end"
                      data-testid="daw-past-end-ruler"
                    />
                  )}
                </svg>
              </div>
            </div>
            {(status?.tracks ?? []).map((t, i) => (
              <div className="daw-row daw-lane" key={t.jack} data-testid={`daw-lane-${i}`}>
                <div className="daw-side">
                  <div className="daw-side-top">
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
                      {t.kind === 'audio'
                        ? t.stereo
                          ? 'audio · stereo'
                          : 'audio · mono'
                        : t.kind === 'midi'
                          ? 'MIDI'
                          : 'CV'}
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
                    knobs={status?.knobs}
                    wires={wires}
                    pending={pending}
                    onJackClick={onJackClick}
                    onKnob={(jack, p) => void api.setKnobPosition(jack, p).then(refresh)}
                    onKnobDone={() => void api.endEdit()}
                    showLabel
                  />
                  <div className="daw-lane-actions">
                    {t.kind !== 'midi' &&
                      (recording === i ? (
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
                            data-tip="record this track's input jacks (unwired: the knob value)"
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
                      ))}
                    {t.kind !== 'midi' && (
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
                    )}
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
                {t.kind === 'midi' && (
                  <MidiGutter
                    track={i}
                    basePitch={midiBase[t.jack] ?? MIDI_DEFAULT_BASE}
                    onShift={(d) => shiftMidiBase(t.jack, d)}
                  />
                )}
                <div
                  className="daw-timeline"
                  style={{ width: timelineW }}
                  data-testid={`daw-timeline-${i}`}
                  onPointerDown={(e) => {
                    // Clicks on empty timeline space seek (snapped);
                    // clip/midi SVGs stopPropagation and handle their own.
                    const rect = e.currentTarget.getBoundingClientRect();
                    seekBeats((e.clientX - rect.left) / pxPerBeat);
                  }}
                >
                  <svg
                    className="daw-gridlines"
                    width={timelineW}
                    height="100%"
                    preserveAspectRatio="none"
                  >
                    {gridLines.map((g) => (
                      <line
                        key={g.beat}
                        x1={g.beat * pxPerBeat}
                        x2={g.beat * pxPerBeat}
                        y1={0}
                        y2="100%"
                        className={g.kind === 'snap' ? 'daw-grid-snap' : 'daw-grid-beat'}
                      />
                    ))}
                  </svg>
                  {t.kind === 'midi' ? (
                    <MidiGrid
                      track={i}
                      notes={t.notes ?? []}
                      beats={totalBeats}
                      pxPerBeat={pxPerBeat}
                      snapBeats={snapBeats}
                      basePitch={midiBase[t.jack] ?? MIDI_DEFAULT_BASE}
                      onToggle={(beat, pitch, existing) => toggleNote(i, beat, pitch, existing)}
                    />
                  ) : (
                    <ClipGraph
                      track={i}
                      peaks={peaks[i] ?? []}
                      clipFrames={status?.clip_frames[i] ?? 0}
                      width={((status?.clip_frames[i] ?? 0) / framesPerBeat) * pxPerBeat}
                      onSeek={(frac) =>
                        seekBeats((frac * (status?.clip_frames[i] ?? 0)) / framesPerBeat)
                      }
                    />
                  )}
                  {pastW > 0 && (
                    <div
                      className="daw-past-end-lane"
                      data-testid={`daw-past-end-${i}`}
                      style={{ left: pastX, width: pastW }}
                    />
                  )}
                </div>
              </div>
            ))}
            {/* One playhead line across ruler + all lanes. */}
            {status && (
              <div
                className="daw-playhead-line"
                data-testid="daw-playhead"
                style={{ left: `var(--daw-side-w)`, transform: `translateX(${playheadX}px)` }}
              />
            )}
          </div>
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
              onChange={(e) => setAddKind(e.target.value as 'audio' | 'continuous' | 'midi')}
            >
              <option value="audio">audio</option>
              <option value="continuous">continuous (CV)</option>
              <option value="midi">MIDI</option>
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
