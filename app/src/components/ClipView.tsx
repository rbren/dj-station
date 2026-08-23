// Clip page (PRD §9): load library tracks, cut/splice/reverse/overlay/EQ
// them and automate their level, then render the edit into a NEW library
// track.
//
// The edit itself is a plain ClipProgram (src/clip.ts) — every operation is
// a pure function over it, so this component only owns selection, undo/redo
// history, the viewport (zoom), playback and the debounced preview render.
// Nothing here touches the engine: rendering happens off-thread in the
// shell (dj-analysis).
//
// The component stays MOUNTED when another page is showing (App hides it
// with display: none) so the edit survives tab switches; `active` gates
// its keyboard shortcuts and pauses playback on the way out.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  addOverlay,
  appendSource,
  clearLevel,
  cutRange,
  duplicateRange,
  emptyProgram,
  fadeIn,
  fadeOut,
  gainRange,
  levelDbAt,
  moveRange,
  programDuration,
  regionSpans,
  removeLevelPoint,
  removeOverlay,
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
import { isEditableTarget } from '../fileShortcuts';
import { fixed } from '../format';
import type { LibraryClientApi, Track } from '../library';
import { ClipEqUI } from './ClipEqUI';
import { peaksPath, WAVEFORM_VIEW_W as W } from './WaveformView';

const WAVE_H = 120;
const LEVEL_H = 90;
/** Preview peak resolution: enough per second that zooming stays sharp,
 *  within the backend's bucket cap. */
const PEAKS_PER_SEC = 100;
const MIN_BUCKETS = 1200;
const MAX_BUCKETS = 20000;
/** Debounce before re-rendering the preview after an edit. */
const PREVIEW_DELAY_MS = 350;
/** One playback fetch (the backend caps preview windows); playback chains
 *  consecutive windows for longer clips. */
const PLAY_WINDOW_SECS = 60;
const LEVEL_MAX_DB = 6;
const FADE_SECS = 2;
/** Undo depth for clip edits (page-local; unrelated to patch undo). */
const HISTORY_DEPTH = 49;
/** Narrowest zoom window. */
const MIN_VIEW_SECS = 0.05;

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

type Range = { start: number; end: number };

/** A drag on the waveform: sweeping a new selection, or sliding the
 *  existing one along the timeline. */
type WaveDrag =
  { kind: 'select'; anchor: number } | { kind: 'move'; base: Range; anchor: number; delta: number };

export interface ClipViewProps {
  clip: ClipClientApi;
  library: LibraryClientApi;
  /** False while another page is showing: shortcuts detach, playback
   *  pauses, and the section hides (but stays mounted, keeping the edit). */
  active?: boolean;
  /** Called after a clip is imported, so the library list can refresh. */
  onSaved?: (track: Track) => void;
}

export function ClipView({ clip, library, active = true, onSaved }: ClipViewProps) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [pick, setPick] = useState<number | null>(null);
  const [sources, setSources] = useState<ClipSource[]>([]);
  const [program, setProgram] = useState<ClipProgram>(emptyProgram);
  const [past, setPast] = useState<ClipProgram[]>([]);
  const [future, setFuture] = useState<ClipProgram[]>([]);
  const [selection, setSelection] = useState<Range | null>(null);
  const [previewState, setPreview] = useState<ClipRender | null>(null);
  const [name, setName] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  /** Zoomed viewport over the output timeline; null = the whole clip. */
  const [vp, setVp] = useState<Range | null>(null);

  const duration = programDuration(program);
  const spans = useMemo(() => regionSpans(program), [program]);
  const request = useMemo(
    () => ({ sources: sources.map((s) => s.track_id), program }),
    [sources, program],
  );

  // Viewport, clamped against the current duration (edits shrink clips).
  const vpLen = Math.min(vp ? vp.end - vp.start : duration, duration);
  const vpStart = vp ? Math.max(0, Math.min(vp.start, duration - vpLen)) : 0;
  const vpEnd = vpStart + vpLen;

  const refreshTracks = useCallback(async () => {
    const list = await library.tracks();
    if (list) {
      setTracks(list);
      setPick((cur) => cur ?? list[0]?.id ?? null);
    }
  }, [library]);

  // Refresh the pickable track list whenever the page comes back into
  // view — other pages import tracks while this one stays mounted.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void library.tracks().then((list) => {
      if (cancelled || !list) return;
      setTracks(list);
      setPick((cur) => cur ?? list[0]?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [active, library]);

  // Debounced preview render: the peaks the editor draws are the real
  // rendered output, not a client-side guess.
  useEffect(() => {
    if (program.regions.length === 0 || sources.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const buckets = Math.min(
          MAX_BUCKETS,
          Math.max(MIN_BUCKETS, Math.round(programDuration(program) * PEAKS_PER_SEC)),
        );
        const out = await clip.renderPreview(request, buckets);
        if (!cancelled && out) setPreview(out);
      })();
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [clip, request, program, sources.length]);

  /** Apply a pure edit, remembering the previous program for undo. */
  const apply = useCallback(
    (edit: (p: ClipProgram) => ClipProgram) => {
      const next = edit(program);
      if (next === program) return;
      setPast((h) => [...h.slice(-HISTORY_DEPTH), program]);
      setFuture([]);
      setProgram(next);
    },
    [program],
  );

  /** Snapshot for gestures (level-point and EQ drags) that then stream
   *  edits through setProgram directly. */
  const beginGesture = useCallback(() => {
    setPast((h) => [...h.slice(-HISTORY_DEPTH), program]);
    setFuture([]);
  }, [program]);

  const undo = useCallback(() => {
    if (past.length === 0) return;
    setFuture((f) => [...f, program]);
    setProgram(past[past.length - 1]);
    setPast(past.slice(0, -1));
    setSelection(null);
  }, [past, program]);

  const redo = useCallback(() => {
    if (future.length === 0) return;
    setPast((h) => [...h.slice(-HISTORY_DEPTH), program]);
    setProgram(future[future.length - 1]);
    setFuture(future.slice(0, -1));
    setSelection(null);
  }, [future, program]);

  const sel = selection && selection.end - selection.start > 1e-4 ? selection : null;

  const loadTrack = useCallback(
    async (trackId: number, mode: 'open' | 'append' | 'overlay') => {
      setBusy(true);
      setError(null);
      try {
        // Re-adding a track that is already a source reuses its slot.
        const existing = sources.findIndex((s) => s.track_id === trackId);
        const source =
          mode !== 'open' && existing >= 0
            ? sources[existing]
            : await clip.loadSource(trackId, MIN_BUCKETS);
        if (!source) {
          setError('Could not decode that track');
          return;
        }
        if (mode === 'open') {
          setSources([source]);
          setProgram(appendSource(emptyProgram(), 0, source.duration_secs));
          setPast([]);
          setFuture([]);
          setSelection(null);
          setVp(null);
          setPlayhead(0);
          setName(`${source.title} (clip)`);
          setStatus(`Editing "${source.title}" — the original is never modified`);
          return;
        }
        const index = existing >= 0 ? existing : sources.length;
        if (existing < 0) setSources([...sources, source]);
        setPast((h) => [...h.slice(-HISTORY_DEPTH), program]);
        setFuture([]);
        if (mode === 'append') {
          setProgram(appendSource(program, index, source.duration_secs));
          setStatus(`Spliced "${source.title}" onto the end`);
        } else {
          const at = sel ? sel.start : playhead;
          setProgram(addOverlay(program, index, source.duration_secs, at));
          setStatus(`Overlaid "${source.title}" at ${timecode(at)}`);
        }
      } finally {
        setBusy(false);
      }
    },
    [clip, playhead, program, sel, sources],
  );

  // --- selection: sweep on empty space, slide inside the selection -------
  const waveRef = useRef<SVGSVGElement | null>(null);
  const dragRect = useRef<DOMRect | null>(null);
  const dragRef = useRef<WaveDrag | null>(null);
  const [dragging, setDragging] = useState(false);

  const timeAt = useCallback(
    (clientX: number, rect: DOMRect | null) => {
      if (!rect || rect.width <= 0 || duration <= 0) return 0;
      const frac = (clientX - rect.left) / rect.width;
      return Math.min(duration, Math.max(0, vpStart + frac * vpLen));
    },
    [duration, vpStart, vpLen],
  );

  const startDrag = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      if (duration <= 0 || e.button !== 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      dragRect.current = rect;
      const t = timeAt(e.clientX, rect);
      if (sel && t >= sel.start && t <= sel.end) {
        dragRef.current = { kind: 'move', base: sel, anchor: t, delta: 0 };
      } else {
        dragRef.current = { kind: 'select', anchor: t };
        setSelection({ start: t, end: t });
        setPlayhead(t);
      }
      setDragging(true);
    },
    [duration, sel, timeAt],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const t = timeAt(e.clientX, dragRect.current);
      if (drag.kind === 'select') {
        setSelection({ start: Math.min(drag.anchor, t), end: Math.max(drag.anchor, t) });
      } else {
        const len = drag.base.end - drag.base.start;
        const delta = Math.min(
          duration - len - drag.base.start,
          Math.max(-drag.base.start, t - drag.anchor),
        );
        drag.delta = delta;
        setSelection({ start: drag.base.start + delta, end: drag.base.end + delta });
      }
    };
    const up = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      if (drag?.kind !== 'move') return;
      if (Math.abs(drag.delta) > 1e-3) {
        // The selection rect already sits at the target; move the audio
        // underneath it to match.
        const target = drag.base.start + drag.delta;
        apply((p) => moveRange(p, drag.base.start, drag.base.end, target));
        setSelection({ start: target, end: target + (drag.base.end - drag.base.start) });
        setPlayhead(target);
      } else {
        // A plain click inside the selection just parks the playhead.
        setPlayhead(drag.anchor);
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [apply, dragging, duration, timeAt]);

  // --- zoom ---------------------------------------------------------------
  const zoomAround = useCallback(
    (center: number, factor: number) => {
      if (duration <= 0) return;
      const span = Math.max(MIN_VIEW_SECS, Math.min(duration, vpLen * factor));
      if (span >= duration) {
        setVp(null);
        return;
      }
      const frac = vpLen > 0 ? (center - vpStart) / vpLen : 0.5;
      const start = Math.max(0, Math.min(center - frac * span, duration - span));
      setVp({ start, end: start + span });
    },
    [duration, vpLen, vpStart],
  );

  const zoomIn = useCallback(() => {
    const center = sel ? (sel.start + sel.end) / 2 : playhead > 0 ? playhead : vpStart + vpLen / 2;
    zoomAround(center, 0.5);
  }, [playhead, sel, vpLen, vpStart, zoomAround]);
  const zoomOut = useCallback(
    () => zoomAround(vpStart + vpLen / 2, 2),
    [vpLen, vpStart, zoomAround],
  );

  // Wheel over the waveform: zoom around the cursor; shift/horizontal
  // scroll pans. Native non-passive listener so the page never scrolls.
  useEffect(() => {
    const el = waveRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        const d = (e.deltaX || e.deltaY) * (vpLen / W);
        const start = Math.max(0, Math.min(vpStart + d, duration - vpLen));
        if (vp) setVp({ start, end: start + vpLen });
      } else {
        zoomAround(timeAt(e.clientX, rect), 2 ** (e.deltaY / 300));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [duration, timeAt, vp, vpLen, vpStart, zoomAround]);

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

  // --- playback ----------------------------------------------------------
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  /** The rendered window the <audio> element currently holds. */
  const windowRef = useRef<{ start: number; end: number; loop: boolean } | null>(null);

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  const haltPlayback = useCallback(() => {
    const el = audioRef.current;
    const w = windowRef.current;
    if (el && w) setPlayhead(Math.min(duration, w.start + el.currentTime));
    el?.pause();
    setPlaying(false);
  }, [duration]);

  /** Fetch a rendered window and start the <audio> element on it. Looping
   *  a selection plays the (window-capped) selection with native looping;
   *  linear playback chains windows from `startSecs` to the end. */
  const playFrom = useCallback(
    async (startSecs: number, loopRange: Range | null) => {
      let start: number;
      let end: number;
      if (loopRange) {
        start = loopRange.start;
        end = Math.min(loopRange.end, loopRange.start + PLAY_WINDOW_SECS);
      } else {
        // Play again from the top when the playhead sits at the end.
        start = startSecs >= duration - 0.01 ? 0 : Math.max(0, startSecs);
        end = Math.min(duration, start + PLAY_WINDOW_SECS);
      }
      if (end - start <= 1e-3) return;
      const bytes = await clip.previewAudio(request, start, end - start);
      const el = audioRef.current;
      if (!bytes || !el) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = url;
      windowRef.current = { start, end, loop: loopRange !== null };
      el.src = url;
      el.loop = loopRange !== null;
      setPlayhead(start);
      setPlaying(true);
      try {
        await el.play();
      } catch {
        // jsdom (and a webview without an output device) can't play; the
        // element still holds the rendered audio.
      }
    },
    [clip, duration, request],
  );

  const togglePlay = useCallback(() => {
    if (playing) {
      haltPlayback();
    } else {
      void playFrom(playhead, loop && sel ? sel : null);
    }
  }, [haltPlayback, loop, playFrom, playhead, playing, sel]);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    windowRef.current = null;
    setPlaying(false);
    setPlayhead(sel ? sel.start : 0);
  }, [sel]);

  // Track the playhead and chain the next window when one runs out.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => {
      const w = windowRef.current;
      if (w) setPlayhead(Math.min(duration, w.start + el.currentTime));
    };
    const onEnded = () => {
      const w = windowRef.current;
      if (!w) return;
      if (!w.loop && w.end < duration - 0.01) {
        void playFrom(w.end, null);
      } else {
        setPlaying(false);
        setPlayhead(w.loop ? w.start : duration);
      }
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnded);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnded);
    };
  }, [duration, playFrom]);

  // An edit makes the fetched audio stale: stop rather than play the old
  // render. Leaving the page pauses too (its shortcuts detach with it).
  const lastRequest = useRef(request);
  useEffect(() => {
    if (lastRequest.current === request) return;
    lastRequest.current = request;
    if (playing) haltPlayback();
    windowRef.current = null;
  }, [request, playing, haltPlayback]);
  useEffect(() => {
    if (!active && playing) haltPlayback();
  }, [active, playing, haltPlayback]);

  // --- keyboard shortcuts (page-scoped; see AGENTS.md keyboard scope) ----
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((mod && key === 'z' && e.shiftKey) || (mod && key === 'y')) {
        e.preventDefault();
        redo();
      } else if (!mod && e.key === ' ') {
        // Space would otherwise click a focused button / scroll the page.
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, redo, togglePlay, undo]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const track = await clip.save(request, name);
      if (track) {
        setStatus(`Saved "${track.title}" to the library as a new track`);
        onSaved?.(track);
        void refreshTracks();
      }
    } finally {
      setBusy(false);
    }
  }, [clip, name, onSaved, refreshTracks, request]);

  // The preview belongs to the current edit only; an emptied program has none.
  const preview = program.regions.length === 0 ? null : previewState;
  const peaks = preview?.peaks ?? [];
  const xOf = (secs: number) => (vpLen > 0 ? ((secs - vpStart) / vpLen) * W : 0);
  const disabled = program.regions.length === 0;
  const noSelection = disabled || sel === null;

  return (
    <section
      className="clip-view"
      data-testid="clip-view"
      style={active ? undefined : { display: 'none' }}
    >
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
        <button
          data-testid="clip-overlay-track"
          disabled={pick === null || busy || disabled}
          title="Mix the track over the timeline at the selection (or playhead)"
          onClick={() => pick !== null && void loadTrack(pick, 'overlay')}
        >
          Overlay
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
          <div className="clip-transport" data-testid="clip-transport">
            <button
              data-testid="clip-play"
              title={playing ? 'Pause (space)' : 'Play (space)'}
              onClick={togglePlay}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <button data-testid="clip-stop" title="Stop" onClick={stop}>
              ■
            </button>
            <button
              data-testid="clip-loop"
              className={loop ? 'clip-toggle-on' : undefined}
              aria-pressed={loop}
              title="Loop the selection"
              onClick={() => setLoop((v) => !v)}
            >
              Loop
            </button>
            <span className="clip-playhead-readout" data-testid="clip-playhead-readout">
              {timecode(playhead)}
            </span>
            <span className="clip-zoom">
              <button data-testid="clip-zoom-in" title="Zoom in" onClick={zoomIn}>
                +
              </button>
              <button
                data-testid="clip-zoom-out"
                title="Zoom out"
                disabled={vp === null}
                onClick={zoomOut}
              >
                −
              </button>
              <button
                data-testid="clip-zoom-fit"
                title="Fit whole clip"
                disabled={vp === null}
                onClick={() => setVp(null)}
              >
                Fit
              </button>
            </span>
            <button data-testid="clip-undo" disabled={past.length === 0} onClick={undo}>
              Undo
            </button>
            <button data-testid="clip-redo" disabled={future.length === 0} onClick={redo}>
              Redo
            </button>
          </div>

          <div className="clip-timeline">
            <svg
              ref={waveRef}
              data-testid="clip-waveform"
              className="clip-waveform"
              viewBox={`0 0 ${W} ${WAVE_H}`}
              preserveAspectRatio="none"
              data-vp-start={fixed(vpStart, 3)}
              data-vp-end={fixed(vpEnd, 3)}
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
              <path
                className="waveform-peaks"
                d={
                  duration > 0 ? peaksPath(peaks, vpStart / duration, vpEnd / duration, WAVE_H) : ''
                }
              />
              {program.overlays.map((o, i) => (
                <rect
                  key={`ov${i}`}
                  data-testid={`clip-overlay-span-${i}`}
                  className="clip-overlay-span"
                  x={xOf(Math.max(0, o.at_secs))}
                  y={0}
                  width={Math.max(1, xOf(o.at_secs + (o.end_secs - o.start_secs)) - xOf(o.at_secs))}
                  height={10}
                />
              ))}
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
              <line
                data-testid="clip-playhead"
                className="clip-playhead"
                x1={xOf(playhead)}
                x2={xOf(playhead)}
                y1={0}
                y2={WAVE_H}
              />
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
                    ? `${xOf(vpStart)},${levelY(0)} ${xOf(vpEnd)},${levelY(0)}`
                    : [vpStart, ...program.level.map((p) => p.time_secs), duration]
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
                    beginGesture();
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
              {vp ? ` · view ${timecode(vpStart)}–${timecode(vpEnd)}` : ''}
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
          </div>

          <ClipEqUI
            bands={program.eq.bands}
            onBegin={beginGesture}
            onChange={(bands) => setProgram({ ...program, eq: { bands } })}
          />

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
              {program.overlays.map((o, i) => (
                <tr key={`ov${i}`} data-testid="clip-overlay">
                  <td>+</td>
                  <td>{sources[o.source]?.title ?? `source ${o.source + 1}`} (overlay)</td>
                  <td>{timecode(o.at_secs)}</td>
                  <td>{timecode(o.at_secs + (o.end_secs - o.start_secs))}</td>
                  <td>{o.reverse ? '◀' : ''}</td>
                  <td>{fixed(o.gain_db, 1)} dB</td>
                  <td>
                    <button
                      data-testid={`clip-overlay-delete-${i}`}
                      onClick={() => apply((p) => removeOverlay(p, i))}
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
              <span>Name</span>
              <input
                data-testid="clip-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button
              className="clip-save-button"
              data-testid="clip-save"
              disabled={busy || name.trim() === ''}
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
