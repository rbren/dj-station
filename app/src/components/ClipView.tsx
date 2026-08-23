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

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { MouseEvent as ReactMouseEvent, Ref } from 'react';
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
  resizeSelection,
  reverseRange,
  rulerTicks,
  selectionEdgeAt,
  setLevelPoint,
  sourceLabel,
  sourceRef,
  trimTo,
  type ClipClientApi,
  type ClipProgram,
  type ClipRender,
  type ClipSource,
  type ClipStemBackend,
  SILENCE_DB,
  STEM_NAMES,
} from '../clip';
import { ClipTransport, type TransportHost } from '../clipTransport';
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
/** Grab radius for the selection's edge handles, in waveform pixels. */
const HANDLE_PX = 7;
/** How often separation jobs are polled while one is running. */
const STEM_POLL_MS = 700;
/** Playhead refresh while a Web Audio loop runs (it has no timeupdate). */
const LOOP_TICK_MS = 50;

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

/** A drag on the waveform. Sweeping a new selection and dragging one end
 *  of an existing one are the same gesture — both track the pointer
 *  against a fixed `anchor` (for a resize, the end you did NOT grab) —
 *  so they share a kind. Sliding the whole selection is the only one that
 *  edits the program. */
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
  /** Handle for the Library page's Edit button (see ClipViewHandle). */
  ref?: Ref<ClipViewHandle>;
}

/** What another page can ask the (permanently mounted) editor to do. */
export interface ClipViewHandle {
  /** Open a library track for editing. Asks first if that would throw
   *  away an unsaved edit. */
  open: (trackId: number) => void;
}

export function ClipView({ clip, library, active = true, onSaved, ref }: ClipViewProps) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [pick, setPick] = useState<number | null>(null);
  const [sources, setSources] = useState<ClipSource[]>([]);
  const [program, setProgram] = useState<ClipProgram>(emptyProgram);
  const [past, setPast] = useState<ClipProgram[]>([]);
  /** A library track waiting on "discard the current edit?". */
  const [pendingOpen, setPendingOpen] = useState<number | null>(null);
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
  /** Which stem to load ('' = the full mix), and the track it was chosen
   *  for: a choice does not carry over to the next track picked. */
  const [stemChoice, setStemChoice] = useState<{ trackId: number; stem: string }>({
    trackId: -1,
    stem: '',
  });
  /** The configured separation backend, or null until probed. */
  const [backend, setBackend] = useState<ClipStemBackend | null>(null);
  /** Tracks whose stems are already separated (backend-qualified cache). */
  const [separated, setSeparated] = useState<Record<number, boolean>>({});
  /** Separation running for this track id, with its stage for the UI. */
  const [separating, setSeparating] = useState<{ trackId: number; stage: string } | null>(null);

  const duration = programDuration(program);
  const spans = useMemo(() => regionSpans(program), [program]);
  // Memoized apart from `request` so its identity tracks the source list
  // itself: the staleness check below reads these references to tell a
  // timeline edit from a tone-only one.
  const sourceRefs = useMemo(() => sources.map(sourceRef), [sources]);
  const request = useMemo(() => ({ sources: sourceRefs, program }), [sourceRefs, program]);

  const stemPick = stemChoice.trackId === pick ? stemChoice.stem : '';

  // --- playback: the owner ------------------------------------------------
  //
  // Every source that can make sound belongs to ONE ClipTransport
  // (src/clipTransport.ts). This component never touches an audio node: it
  // hands the transport a host to read the live edit through, calls
  // commands (further down, and from the handlers below), and renders the
  // status it is given back. See AGENTS.md for why: overlapping async play
  // requests used to leave a second source playing with nobody holding its
  // handle. The owner is declared up here because the editing handlers
  // below issue commands to it.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transportRef = useRef<ClipTransport | null>(null);

  // What the transport needs to read at CALL time, not at render time: the
  // host closes over this ref so a single transport instance survives every
  // edit.
  //
  // The mirror is updated in a LAYOUT effect, which React flushes during
  // the commit. A passive effect is flushed later — after the browser can
  // dispatch the next click — so pressing play in that gap read the
  // previous render's duration, computed an empty window, and silently
  // played nothing.
  const live = useRef({ clip, request, duration });
  useLayoutEffect(() => {
    live.current = { clip, request, duration };
  });

  // One effect creates the transport and one effect destroys it, so React
  // StrictMode's mount/unmount/mount leaves nothing of the first instance
  // behind: it is disposed (which stops everything and makes it refuse
  // further commands) and replaced by a fresh one. The host is built here
  // rather than memoized above so the transport owns nothing that outlives
  // it, and reads everything that changes through `live`.
  useEffect(() => {
    const host: TransportHost = {
      duration: () => live.current.duration,
      // The editor only renders an <audio> element once a track is open,
      // so the transport looks it up when it needs it.
      element: () => audioRef.current,
      render: (start, len) => live.current.clip.previewAudio(live.current.request, start, len),
      onStatus: (s) => {
        setPlaying(s.playing);
        setPlayhead(s.playhead);
      },
    };
    const transport = new ClipTransport(host, {
      windowSecs: PLAY_WINDOW_SECS,
      tickMs: LOOP_TICK_MS,
      toneDelayMs: PREVIEW_DELAY_MS,
    });
    transportRef.current = transport;
    return () => {
      transportRef.current = null;
      transport.dispose();
    };
  }, []);

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
    async (trackId: number, mode: 'open' | 'append' | 'overlay', stemName = stemPick) => {
      const stem = stemName || null;
      setBusy(true);
      setError(null);
      try {
        // Re-adding a source that is already loaded reuses its slot — the
        // stem is part of that identity, so "vocals" and the full mix of
        // the same track are two lanes.
        const existing = sources.findIndex((s) => s.track_id === trackId && s.stem === stem);
        const source =
          mode !== 'open' && existing >= 0
            ? sources[existing]
            : await clip.loadSource(trackId, stem, MIN_BUCKETS);
        if (!source) {
          setError(
            stem
              ? `Could not load the ${stem} stem — separate the track first`
              : 'Could not decode that track',
          );
          return;
        }
        const label = sourceLabel(source);
        if (mode === 'open') {
          setSources([source]);
          setProgram(appendSource(emptyProgram(), 0, source.duration_secs));
          setPast([]);
          setFuture([]);
          setSelection(null);
          setVp(null);
          // A different program entirely: stop, don't play the old render.
          transportRef.current?.stop(0);
          setName(stem ? `${source.title} (${stem})` : `${source.title} (clip)`);
          setStatus(`Editing "${label}" — the original is never modified`);
          return;
        }
        const index = existing >= 0 ? existing : sources.length;
        if (existing < 0) setSources([...sources, source]);
        setPast((h) => [...h.slice(-HISTORY_DEPTH), program]);
        setFuture([]);
        if (mode === 'append') {
          setProgram(appendSource(program, index, source.duration_secs));
          setStatus(`Spliced "${label}" onto the end`);
        } else {
          const at = sel ? sel.start : playhead;
          setProgram(addOverlay(program, index, source.duration_secs, at));
          setStatus(`Overlaid "${label}" at ${timecode(at)}`);
        }
      } finally {
        setBusy(false);
      }
    },
    [clip, playhead, program, sel, sources, stemPick],
  );

  // --- stems: isolate a stem of the picked track on demand ----------------
  //
  // Separation is minutes of CPU work in the shell's job manager; the page
  // only ever kicks it off and polls. Missing tooling is a normal state:
  // the controls explain it instead of failing.
  useEffect(() => {
    let live = true;
    void (async () => {
      const info = await clip.stemBackend();
      if (live) setBackend(info);
    })();
    return () => {
      live = false;
    };
  }, [clip]);

  const refreshStemStatus = useCallback(
    async (trackId: number) => {
      const status = await clip.stemStatus(trackId);
      if (!status) return;
      setSeparated((m) => ({ ...m, [trackId]: status.cached }));
      setSeparating((cur) => {
        if (status.running) return { trackId, stage: 'separating' };
        return cur?.trackId === trackId ? null : cur;
      });
    },
    [clip],
  );

  useEffect(() => {
    if (pick === null) return;
    void (async () => {
      await refreshStemStatus(pick);
    })();
  }, [pick, refreshStemStatus]);

  const separateStems = useCallback(async () => {
    if (pick === null) return;
    setError(null);
    const id = await clip.stemSeparate(pick);
    if (id === null) {
      // The command rejected it (tooling missing) — the client surfaced
      // the reason; re-probe so the panel reflects reality.
      const info = await clip.stemBackend();
      setBackend(info);
      setError(info?.detail ?? 'Stem separation is unavailable');
      return;
    }
    setSeparating({ trackId: pick, stage: 'queued' });
    setStatus(`Separating stems with ${backend?.backend ?? 'the stem model'} — this takes a while`);
  }, [backend, clip, pick]);

  // Cancelling only fires the signal; the poll above sees the job finish
  // and clears the panel, so the button stays honest about work that
  // takes a moment to actually stop.
  const cancelStems = useCallback(async () => {
    if (!separating) return;
    setStatus('Stopping the separation…');
    await clip.stemCancel(separating.trackId);
  }, [clip, separating]);

  // Poll while a separation runs; stop as soon as none is in flight.
  useEffect(() => {
    if (!separating) return;
    const trackId = separating.trackId;
    const timer = setInterval(() => {
      void (async () => {
        const jobs = await clip.stemJobs();
        const job = jobs?.filter((j) => j.track_id === trackId).pop();
        if (!job) return;
        if (job.state === 'running') {
          // Keep the same object when the stage is unchanged, so this
          // effect (and its interval) is not torn down every poll.
          setSeparating((cur) =>
            cur && cur.trackId === trackId && cur.stage === job.stage
              ? cur
              : { trackId, stage: job.stage },
          );
          return;
        }
        setSeparating(null);
        if (job.state === 'failed') {
          setError(job.error ?? 'Stem separation failed');
        } else if (job.state === 'cancelled') {
          setStatus(`Stopped separating "${job.title}"`);
        } else {
          setSeparated((m) => ({ ...m, [trackId]: true }));
          setStatus(`Stems ready for "${job.title}"`);
        }
      })();
    }, STEM_POLL_MS);
    return () => clearInterval(timer);
  }, [clip, separating]);

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

  /** Seconds per HANDLE_PX at the current zoom — the edge grab radius. */
  const handleSecs = useCallback(
    (rect: DOMRect | null) =>
      rect && rect.width > 0 ? (HANDLE_PX / rect.width) * vpLen : (HANDLE_PX / W) * vpLen,
    [vpLen],
  );

  const startDrag = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      if (duration <= 0 || e.button !== 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      dragRect.current = rect;
      const t = timeAt(e.clientX, rect);
      // Grabbing an end expands/shrinks the selection; that beats the
      // "slide the whole thing" case, whose zone contains both edges.
      const edge = selectionEdgeAt(sel, t, handleSecs(rect));
      if (sel && edge) {
        // Anchor the end you did not grab and sweep from there; the
        // playhead stays put (only a fresh sweep moves it).
        dragRef.current = { kind: 'select', anchor: edge === 'start' ? sel.end : sel.start };
        setSelection(resizeSelection(sel, edge, t, duration));
      } else if (sel && t >= sel.start && t <= sel.end) {
        dragRef.current = { kind: 'move', base: sel, anchor: t, delta: 0 };
      } else {
        dragRef.current = { kind: 'select', anchor: t };
        setSelection({ start: t, end: t });
        transportRef.current?.seek(t);
      }
      setDragging(true);
    },
    [duration, handleSecs, sel, timeAt],
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
        transportRef.current?.seek(target);
      } else {
        // A plain click inside the selection just moves the playhead.
        transportRef.current?.seek(drag.anchor);
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

  // Opening from the Library page. An edit that has been touched but not
  // saved would be lost, so that case asks first — the source track is
  // never written, so the only thing at stake is the editing itself.
  const openFromLibrary = useCallback(
    (trackId: number) => {
      setPendingOpen(null);
      setPick(trackId);
      setStemChoice({ trackId, stem: '' });
      void loadTrack(trackId, 'open', '');
    },
    [loadTrack],
  );

  const dirtyEdit = past.length > 0 && program.regions.length > 0;
  useImperativeHandle(
    ref,
    () => ({
      open: (trackId: number) => {
        if (dirtyEdit) setPendingOpen(trackId);
        else openFromLibrary(trackId);
      },
    }),
    [dirtyEdit, openFromLibrary],
  );

  // --- playback: commands -------------------------------------------------
  // What Loop loops: the selection if there is one, otherwise the whole
  // clip. "Loop" with nothing selected used to light up and do nothing,
  // which read as broken — and looping the whole edit is what you want
  // when auditioning one anyway.
  const loopRange = useMemo(
    () => (!loop ? null : (sel ?? (duration > 0 ? { start: 0, end: duration } : null))),
    [loop, sel, duration],
  );

  const togglePlay = useCallback(() => {
    const transport = transportRef.current;
    if (!transport) return;
    if (transport.playing) transport.pause();
    else transport.play(transport.playhead, loopRange);
  }, [loopRange]);

  const stop = useCallback(() => {
    transportRef.current?.stop(sel ? sel.start : 0);
  }, [sel]);

  // An edit makes the fetched audio stale. What that costs playback
  // depends on WHAT changed:
  //
  // - the timeline (regions/overlays/crossfade/sources): every output time
  //   now means something else, so stop rather than play the old render;
  // - tone only (EQ, level automation): the timeline is untouched, so
  //   re-fetch the same window and carry on from the same spot — pausing
  //   for an EQ tweak would make the control useless for auditioning.
  const lastRequest = useRef(request);
  useEffect(() => {
    const prev = lastRequest.current;
    // Unrelated state moved (selection, zoom, …): leave any pending
    // re-render alone rather than re-arming its timer.
    if (prev === request) return;
    lastRequest.current = request;
    const timelineChanged =
      prev.sources !== request.sources ||
      prev.program.regions !== request.program.regions ||
      prev.program.overlays !== request.program.overlays ||
      prev.program.crossfade_ms !== request.program.crossfade_ms;
    if (timelineChanged) transportRef.current?.invalidate();
    else transportRef.current?.refreshTone();
  }, [request]);

  // Keep playback in step with the selection, so a loop follows its edges
  // live instead of looping the old span until the next pause/play.
  useEffect(() => {
    transportRef.current?.setLoop(loopRange);
  }, [loopRange]);

  // Leaving the page pauses (its shortcuts detach with it).
  useEffect(() => {
    if (!active) transportRef.current?.pause();
  }, [active]);

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
  // Ruler marks for whatever is on screen. Recomputed from the viewport
  // alone, so zooming and scrolling move them with the audio.
  const ticks = useMemo(() => rulerTicks(vpStart, vpEnd), [vpStart, vpEnd]);
  /** Can the picked track be loaded stem by stem right now? */
  const stemsReady = pick !== null && separated[pick] === true;
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
            <span className="tag tag-source" key={`${s.track_id}:${s.stem ?? 'mix'}:${i}`}>
              {i + 1}. {sourceLabel(s)}
            </span>
          ))}
        </span>
      </div>

      <div className="clip-stems" data-testid="clip-stems">
        <label>
          <span>Stem</span>
          <select
            data-testid="clip-stem-select"
            value={stemPick}
            disabled={!stemsReady}
            title={
              stemsReady
                ? 'Load one isolated stem instead of the full mix'
                : 'Separate the track first'
            }
            onChange={(e) => setStemChoice({ trackId: pick ?? -1, stem: e.target.value })}
          >
            <option value="">Full mix</option>
            {(backend?.stems ?? STEM_NAMES).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {stemsReady ? (
          <span className="clip-stem-ready" data-testid="clip-stem-ready">
            stems ready ({backend?.backend})
          </span>
        ) : (
          <button
            data-testid="clip-stem-separate"
            disabled={pick === null || separating !== null || backend?.available === false}
            title={
              backend?.available === false
                ? (backend.detail ?? 'Stem separation is unavailable')
                : `Separate this track into ${(backend?.stems ?? STEM_NAMES).join(', ')} with ${
                    backend?.backend ?? 'the stem model'
                  }`
            }
            onClick={() => void separateStems()}
          >
            {separating ? `Separating… (${separating.stage})` : 'Separate stems'}
          </button>
        )}
        {separating && (
          <button
            className="clip-stem-cancel"
            data-testid="clip-stem-cancel"
            title="Stop the separation — nothing is kept, and it can be run again"
            onClick={() => void cancelStems()}
          >
            Cancel
          </button>
        )}
        {backend?.available === false && (
          <span className="clip-stem-hint" data-testid="clip-stem-hint">
            {backend.detail ?? 'Stem separation is unavailable'}
          </span>
        )}
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
              title={sel ? 'Loop the selection' : 'Loop the whole clip'}
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
            {/* The ruler is HTML, not SVG: the waveform's viewBox is
                stretched to the pane width (preserveAspectRatio="none"),
                which would squash text with it. Percentages track the
                viewport, so the marks follow every zoom and scroll. */}
            <div className="clip-ruler" data-testid="clip-ruler">
              {ticks.map((t) => (
                <span
                  key={t.secs}
                  className={t.major ? 'clip-tick clip-tick-major' : 'clip-tick'}
                  style={{ left: `${((t.secs - vpStart) / Math.max(1e-9, vpLen)) * 100}%` }}
                  data-testid={t.major ? `clip-tick-${fixed(t.secs, 3)}` : undefined}
                >
                  {t.major && <i className="clip-tick-label">{t.label}</i>}
                </span>
              ))}
            </div>
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
              {/* The ruler's labelled marks, carried across the audio so a
                  time can be read off the waveform itself. */}
              {ticks
                .filter((t) => t.major)
                .map((t) => (
                  <line
                    key={`grid${t.secs}`}
                    className="clip-grid"
                    x1={xOf(t.secs)}
                    x2={xOf(t.secs)}
                    y1={0}
                    y2={WAVE_H}
                  />
                ))}
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
                <>
                  <rect
                    data-testid="clip-selection"
                    className="clip-selection"
                    x={xOf(sel.start)}
                    y={0}
                    width={Math.max(1, xOf(sel.end) - xOf(sel.start))}
                    height={WAVE_H}
                  />
                  {/* A hairline you aim at, over a wide invisible zone you
                      can actually hit. startDrag hit-tests the same radius,
                      so the zone only has to exist for the cursor to change
                      over it — which is the only hint that the edge is
                      draggable. */}
                  {(['start', 'end'] as const).map((edge) => (
                    <g key={edge}>
                      <rect
                        data-testid={`clip-selection-handle-${edge}`}
                        className="clip-selection-handle"
                        x={xOf(edge === 'start' ? sel.start : sel.end) - HANDLE_PX / 2}
                        y={0}
                        width={HANDLE_PX}
                        height={WAVE_H}
                      />
                      <line
                        data-testid={`clip-selection-edge-${edge}`}
                        className="clip-selection-edge"
                        x1={xOf(edge === 'start' ? sel.start : sel.end)}
                        x2={xOf(edge === 'start' ? sel.start : sel.end)}
                        y1={0}
                        y2={WAVE_H}
                      />
                    </g>
                  ))}
                </>
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
      {pendingOpen !== null && (
        <div
          className="file-dialog-backdrop"
          data-testid="clip-discard-dialog"
          onClick={() => setPendingOpen(null)}
        >
          <div className="file-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Discard this edit?</h3>
            <p className="file-dialog-empty">
              Opening “{tracks.find((t) => t.id === pendingOpen)?.title ?? 'that track'}” clears the
              timeline. This edit has not been saved to the library, and nothing here can be
              recovered afterwards.
            </p>
            <button data-testid="clip-discard-confirm" onClick={() => openFromLibrary(pendingOpen)}>
              Discard and Open
            </button>
            <button
              className="file-dialog-cancel"
              data-testid="clip-discard-cancel"
              onClick={() => setPendingOpen(null)}
            >
              Keep Editing
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
