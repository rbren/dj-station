// Clip page (PRD §9): load library tracks, cut/splice/reverse/EQ them and
// automate their level, then render the edit into a NEW library track.
//
// The edit itself is a plain ClipProgram (src/clip.ts) — every operation is
// a pure function over it, so this component only owns selection, undo
// history and the debounced preview render. Nothing here touches the
// engine: rendering happens off-thread in the shell (dj-analysis).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  appendSource,
  clearLevel,
  cutRange,
  duplicateRange,
  emptyProgram,
  fadeIn,
  fadeOut,
  gainRange,
  levelDbAt,
  programDuration,
  regionSpans,
  removeLevelPoint,
  removeRegion,
  reverseRange,
  setLevelPoint,
  trimTo,
  type ClipClientApi,
  type ClipProgram,
  type ClipRender,
  type ClipSource,
  SILENCE_DB,
} from '../clip';
import { fixed } from '../format';
import type { LibraryClientApi, Track } from '../library';
import { peaksPath, WAVEFORM_VIEW_W as W } from './WaveformView';

const WAVE_H = 120;
const LEVEL_H = 90;
const PREVIEW_BUCKETS = 1200;
/** Debounce before re-rendering the preview after an edit. */
const PREVIEW_DELAY_MS = 350;
/** Audition window; the backend caps it too. */
const AUDITION_SECS = 30;
const LEVEL_MAX_DB = 6;
const FADE_SECS = 2;
const EQ_RANGE_DB = 15;
/** Undo depth for clip edits (page-local; unrelated to patch undo). */
const HISTORY_DEPTH = 49;

function timecode(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '0:00.00';
  const m = Math.floor(secs / 60);
  const s = secs - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/** dB -> y in the automation lane (0 dB near the top, silence at the bottom). */
function levelY(db: number): number {
  const clamped = Math.min(LEVEL_MAX_DB, Math.max(SILENCE_DB, db));
  return ((LEVEL_MAX_DB - clamped) / (LEVEL_MAX_DB - SILENCE_DB)) * LEVEL_H;
}

function levelDbFromY(y: number): number {
  const frac = Math.min(1, Math.max(0, y / LEVEL_H));
  return LEVEL_MAX_DB - frac * (LEVEL_MAX_DB - SILENCE_DB);
}

export interface ClipViewProps {
  clip: ClipClientApi;
  library: LibraryClientApi;
  /** Called after a clip is imported, so the library list can refresh. */
  onSaved?: (track: Track) => void;
}

export function ClipView({ clip, library, onSaved }: ClipViewProps) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [pick, setPick] = useState<number | null>(null);
  const [sources, setSources] = useState<ClipSource[]>([]);
  const [program, setProgram] = useState<ClipProgram>(emptyProgram);
  const [past, setPast] = useState<ClipProgram[]>([]);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [previewState, setPreview] = useState<ClipRender | null>(null);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const duration = programDuration(program);
  const spans = useMemo(() => regionSpans(program), [program]);
  const request = useMemo(
    () => ({ sources: sources.map((s) => s.track_id), program }),
    [sources, program],
  );

  useEffect(() => {
    void (async () => {
      const list = await library.tracks();
      if (list) {
        setTracks(list);
        setPick((cur) => cur ?? list[0]?.id ?? null);
      }
    })();
  }, [library]);

  // Debounced preview render: the peaks the editor draws are the real
  // rendered output, not a client-side guess.
  useEffect(() => {
    if (program.regions.length === 0 || sources.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const out = await clip.renderPreview(request, PREVIEW_BUCKETS);
        if (!cancelled && out) setPreview(out);
      })();
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [clip, request, program.regions.length, sources.length]);

  /** Apply a pure edit, remembering the previous program for undo. */
  const apply = useCallback(
    (edit: (p: ClipProgram) => ClipProgram) => {
      const next = edit(program);
      if (next === program) return;
      setPast((h) => [...h.slice(-HISTORY_DEPTH), program]);
      setProgram(next);
    },
    [program],
  );

  const undo = useCallback(() => {
    if (past.length === 0) return;
    setProgram(past[past.length - 1]);
    setPast(past.slice(0, -1));
    setSelection(null);
  }, [past]);

  const loadTrack = useCallback(
    async (trackId: number, mode: 'open' | 'append') => {
      setBusy(true);
      setError(null);
      try {
        const source = await clip.loadSource(trackId, PREVIEW_BUCKETS);
        if (!source) {
          setError('Could not decode that track');
          return;
        }
        if (mode === 'open') {
          setSources([source]);
          setProgram(appendSource(emptyProgram(), 0, source.duration_secs));
          setPast([]);
          setSelection(null);
          setTitle(`${source.title} (clip)`);
          setArtist(source.artist);
          setStatus(`Editing "${source.title}" — the original is never modified`);
        } else {
          setSources([...sources, source]);
          setPast((h) => [...h.slice(-HISTORY_DEPTH), program]);
          setProgram(appendSource(program, sources.length, source.duration_secs));
          setStatus(`Spliced "${source.title}" onto the end`);
        }
      } finally {
        setBusy(false);
      }
    },
    [clip, program, sources],
  );

  // --- selection dragging over the output waveform ---------------------
  const waveRef = useRef<SVGSVGElement | null>(null);
  const dragRect = useRef<DOMRect | null>(null);
  const dragAnchor = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const timeAt = useCallback(
    (clientX: number, rect: DOMRect | null) => {
      if (!rect || rect.width <= 0 || duration <= 0) return 0;
      const frac = (clientX - rect.left) / rect.width;
      return Math.min(duration, Math.max(0, frac * duration));
    },
    [duration],
  );

  const startDrag = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      if (duration <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      dragRect.current = rect;
      const t = timeAt(e.clientX, rect);
      dragAnchor.current = t;
      setSelection({ start: t, end: t });
      setDragging(true);
    },
    [duration, timeAt],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const anchor = dragAnchor.current;
      if (anchor === null) return;
      const t = timeAt(e.clientX, dragRect.current);
      setSelection({ start: Math.min(anchor, t), end: Math.max(anchor, t) });
    };
    const up = () => setDragging(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [dragging, timeAt]);

  const sel = selection && selection.end - selection.start > 1e-4 ? selection : null;

  // --- level automation lane -------------------------------------------
  const laneRef = useRef<SVGSVGElement | null>(null);
  const dragBase = useRef<ClipProgram | null>(null);
  const [dragPoint, setDragPoint] = useState(false);

  const addLevelPoint = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      if (duration <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const t = timeAt(e.clientX, rect);
      const y = ((e.clientY - rect.top) / (rect.height || LEVEL_H)) * LEVEL_H;
      apply((p) => setLevelPoint(p, t, Math.round(levelDbFromY(y) * 10) / 10));
    },
    [apply, duration, timeAt],
  );

  useEffect(() => {
    if (!dragPoint) return;
    const move = (e: MouseEvent) => {
      const rect = laneRef.current?.getBoundingClientRect();
      const base = dragBase.current;
      if (!rect || rect.width <= 0 || !base) return;
      const t = timeAt(e.clientX, rect);
      const y = ((e.clientY - rect.top) / (rect.height || LEVEL_H)) * LEVEL_H;
      setProgram(setLevelPoint(base, t, Math.round(levelDbFromY(y) * 10) / 10));
    };
    const up = () => setDragPoint(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [dragPoint, timeAt]);

  // --- audition ---------------------------------------------------------
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  const audition = useCallback(async () => {
    const from = sel ? sel.start : 0;
    const secs = sel ? Math.min(AUDITION_SECS, sel.end - sel.start) : AUDITION_SECS;
    const bytes = await clip.previewAudio(request, from, secs);
    if (!bytes) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = url;
    const el = audioRef.current;
    if (!el) return;
    el.src = url;
    try {
      await el.play();
    } catch {
      // jsdom (and a webview without an output device) can't play; the
      // element still holds the rendered audio.
    }
  }, [clip, request, sel]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const track = await clip.save(request, title, artist);
      if (track) {
        setStatus(`Saved "${track.title}" to the library as a new track`);
        onSaved?.(track);
      }
    } finally {
      setBusy(false);
    }
  }, [artist, clip, onSaved, request, title]);

  // The preview belongs to the current edit only; an emptied program has none.
  const preview = program.regions.length === 0 ? null : previewState;
  const peaks = preview?.peaks ?? [];
  const xOf = (secs: number) => (duration > 0 ? (secs / duration) * W : 0);
  const disabled = program.regions.length === 0;
  const noSelection = disabled || sel === null;

  return (
    <section className="clip-view" data-testid="clip-view">
      <div className="clip-load">
        <label>
          <span>Track</span>
          <select
            data-testid="clip-track-select"
            value={pick ?? ''}
            onChange={(e) => setPick(Number(e.target.value))}
          >
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title} — {t.artist}
              </option>
            ))}
          </select>
        </label>
        <button
          data-testid="clip-open-track"
          disabled={pick === null || busy}
          onClick={() => pick !== null && void loadTrack(pick, 'open')}
        >
          Open
        </button>
        <button
          data-testid="clip-append-track"
          disabled={pick === null || busy || disabled}
          onClick={() => pick !== null && void loadTrack(pick, 'append')}
        >
          Splice on end
        </button>
        <span className="clip-sources" data-testid="clip-sources">
          {sources.map((s, i) => (
            <span className="tag tag-source" key={`${s.track_id}:${i}`}>
              {i + 1}. {s.title}
            </span>
          ))}
        </span>
      </div>

      {disabled ? (
        <p className="clip-empty" data-testid="clip-empty">
          Open a library track to start editing. Saving always creates a new track — sources are
          never overwritten.
        </p>
      ) : (
        <>
          <div className="clip-timeline">
            <svg
              ref={waveRef}
              data-testid="clip-waveform"
              className="clip-waveform"
              viewBox={`0 0 ${W} ${WAVE_H}`}
              preserveAspectRatio="none"
              onMouseDown={startDrag}
            >
              {spans.map((s) => (
                <line
                  key={s.index}
                  data-testid={`clip-join-${s.index}`}
                  className="clip-join"
                  x1={xOf(s.start)}
                  x2={xOf(s.start)}
                  y1={0}
                  y2={WAVE_H}
                />
              ))}
              <path className="waveform-peaks" d={peaksPath(peaks, 0, 1, WAVE_H)} />
              {sel && (
                <rect
                  data-testid="clip-selection"
                  className="clip-selection"
                  x={xOf(sel.start)}
                  y={0}
                  width={Math.max(1, xOf(sel.end) - xOf(sel.start))}
                  height={WAVE_H}
                />
              )}
            </svg>
            <svg
              ref={laneRef}
              data-testid="clip-level-lane"
              className="clip-level-lane"
              viewBox={`0 0 ${W} ${LEVEL_H}`}
              preserveAspectRatio="none"
              onMouseDown={addLevelPoint}
            >
              <polyline
                className="clip-level-line"
                data-testid="clip-level-line"
                points={
                  program.level.length === 0
                    ? `0,${levelY(0)} ${W},${levelY(0)}`
                    : [0, ...program.level.map((p) => p.time_secs), duration]
                        .map((t) => `${xOf(t)},${levelY(levelDbAt(program.level, t))}`)
                        .join(' ')
                }
              />
              {program.level.map((p, i) => (
                <circle
                  key={`${p.time_secs}:${i}`}
                  data-testid={`clip-level-point-${i}`}
                  className="clip-level-point"
                  cx={xOf(p.time_secs)}
                  cy={levelY(p.gain_db)}
                  r={7}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    setPast((h) => [...h.slice(-HISTORY_DEPTH), program]);
                    dragBase.current = removeLevelPoint(program, i);
                    setDragPoint(true);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    apply((prog) => removeLevelPoint(prog, i));
                  }}
                />
              ))}
            </svg>
            <p className="clip-readout" data-testid="clip-readout">
              {timecode(duration)} total
              {sel ? ` · selection ${timecode(sel.start)}–${timecode(sel.end)}` : ' · no selection'}
              {preview ? ` · ${preview.channels}ch ${preview.sample_rate} Hz` : ' · rendering…'}
            </p>
          </div>

          <div className="clip-tools">
            <button
              data-testid="clip-trim"
              disabled={noSelection}
              onClick={() => {
                if (!sel) return;
                apply((p) => trimTo(p, sel.start, sel.end));
                setSelection(null);
              }}
            >
              Trim to selection
            </button>
            <button
              data-testid="clip-cut"
              disabled={noSelection}
              onClick={() => {
                if (!sel) return;
                apply((p) => cutRange(p, sel.start, sel.end));
                setSelection(null);
              }}
            >
              Cut selection
            </button>
            <button
              data-testid="clip-reverse"
              disabled={noSelection}
              onClick={() => sel && apply((p) => reverseRange(p, sel.start, sel.end))}
            >
              Reverse
            </button>
            <button
              data-testid="clip-duplicate"
              disabled={noSelection}
              onClick={() => sel && apply((p) => duplicateRange(p, sel.start, sel.end))}
            >
              Duplicate
            </button>
            <button
              data-testid="clip-louder"
              disabled={noSelection}
              onClick={() => sel && apply((p) => gainRange(p, sel.start, sel.end, 3))}
            >
              +3 dB
            </button>
            <button
              data-testid="clip-quieter"
              disabled={noSelection}
              onClick={() => sel && apply((p) => gainRange(p, sel.start, sel.end, -3))}
            >
              −3 dB
            </button>
            <button
              data-testid="clip-fade-in"
              disabled={disabled}
              onClick={() => apply((p) => fadeIn(p, FADE_SECS))}
            >
              Fade in
            </button>
            <button
              data-testid="clip-fade-out"
              disabled={disabled}
              onClick={() => apply((p) => fadeOut(p, FADE_SECS))}
            >
              Fade out
            </button>
            <button
              data-testid="clip-clear-level"
              disabled={program.level.length === 0}
              onClick={() => apply(clearLevel)}
            >
              Clear automation
            </button>
            <button data-testid="clip-undo" disabled={past.length === 0} onClick={undo}>
              Undo
            </button>
          </div>

          <div className="clip-eq" data-testid="clip-eq">
            {(['low', 'mid', 'high'] as const).map((band) => {
              const key = `${band}_db` as const;
              return (
                <label key={band} className="clip-eq-band">
                  <span>
                    {band === 'low' ? 'Low' : band === 'mid' ? 'Mid' : 'High'}{' '}
                    {fixed(program.eq[key], 1)} dB
                  </span>
                  <input
                    type="range"
                    data-testid={`clip-eq-${band}`}
                    min={-EQ_RANGE_DB}
                    max={EQ_RANGE_DB}
                    step={0.5}
                    value={program.eq[key]}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      apply((p) => ({ ...p, eq: { ...p.eq, [key]: value } }));
                    }}
                  />
                </label>
              );
            })}
          </div>

          <table className="clip-regions" data-testid="clip-regions">
            <thead>
              <tr>
                <th>#</th>
                <th>Source</th>
                <th>In</th>
                <th>Out</th>
                <th>Rev</th>
                <th>Gain</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {program.regions.map((r, i) => (
                <tr key={i} data-testid="clip-region">
                  <td>{i + 1}</td>
                  <td>{sources[r.source]?.title ?? `source ${r.source + 1}`}</td>
                  <td>{timecode(r.start_secs)}</td>
                  <td>{timecode(r.end_secs)}</td>
                  <td>{r.reverse ? '◀' : ''}</td>
                  <td>{fixed(r.gain_db, 1)} dB</td>
                  <td>
                    <button
                      data-testid={`clip-region-delete-${i}`}
                      onClick={() => apply((p) => removeRegion(p, i))}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="clip-save">
            <label>
              <span>Title</span>
              <input
                data-testid="clip-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              <span>Artist</span>
              <input
                data-testid="clip-artist"
                value={artist}
                onChange={(e) => setArtist(e.target.value)}
              />
            </label>
            <button data-testid="clip-audition" onClick={() => void audition()}>
              ▶ Audition
            </button>
            <button
              className="clip-save-button"
              data-testid="clip-save"
              disabled={busy || title.trim() === ''}
              onClick={() => void save()}
            >
              Save as new track
            </button>
            <audio ref={audioRef} data-testid="clip-audio" />
          </div>
        </>
      )}

      {status && (
        <p className="clip-status" data-testid="clip-status">
          {status}
        </p>
      )}
      {error && (
        <p className="clip-error" data-testid="clip-error">
          {error}
        </p>
      )}
    </section>
  );
}
