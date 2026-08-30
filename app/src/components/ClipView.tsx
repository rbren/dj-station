// Clip page (PRD §9): load library tracks, cut/splice/reverse/overlay/EQ
// them and automate their level, then save a span of the edit as a BEAT
// CLIP — whole beats at a known tempo, loadable into the decks exactly
// like a Beatify clip.
//
// The edit itself is a plain ClipProgram (src/clip.ts) — every operation is
// a pure function over it, so this component only owns selection, undo/redo
// history, the viewport (zoom), playback and the debounced preview render.
// Nothing here touches the engine: rendering happens off-thread in the
// shell (dj-analysis).
//
// BEATS ARE TAPPED: right-shift during playback drops a marker at the
// playhead (drawn on the waveform), and when playback stops the tapped
// span is MEASURED — the Beatify tracker runs over it and the taps pick
// the seed (and metrical reading) that best fits them (clip_tap_beats),
// so the grid is the chosen seed's beat times; when nothing fits, the
// taps themselves are the grid at their average BPM. Either way it
// covers ONLY the tapped span (the grid toolbar's +/− buttons extend it
// a beat at a time). The stretch correction happens every `sectionBeats` beats
// (the toolbar slider, default 4): section boundaries are warped onto
// the ideal grid and the beats inside keep their tapped feel, so the
// toolbar shows the max flam (uncorrected offset) and max stretch that
// choice leaves. The whole tap session — grid, warp, extensions, slider
// moves — is ONE undo step (`tapSession` regenerates in place).
// Selections then quantize to the grid's actual beats; ⌘-drag frees
// them. A selection that was never tapped is measured by the Beatify
// tracker (beat_this when installed) the moment the save row needs
// numbers to show.
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
  beatSpan,
  clearLevel,
  composeWarp,
  cutRange,
  dropGrid,
  duplicateRange,
  emptyProgram,
  extendGrid,
  fadeIn,
  fadeOut,
  gainRange,
  gridBeatTimes,
  levelDbAt,
  moveRange,
  nearestBeat,
  programDuration,
  quantizeRange,
  regionSpans,
  removeLevelPoint,
  sameSource,
  reverseRange,
  setLevelPoint,
  sourceLabel,
  sourceRef,
  stemLabel,
  stemSet,
  stemWait,
  stretchBands,
  tapGrid,
  trimTo,
  warpSource,
  type ClipBeats,
  type ClipClientApi,
  type ClipGrid,
  type ClipProgram,
  type ClipRender,
  type ClipRequest,
  type ClipSource,
  type ClipStemBackend,
  type ClipStemStatus,
  type TapStats,
  SILENCE_DB,
  STEM_NAMES,
} from '../clip';
import { ClipTransport, type TransportHost } from '../clipTransport';
import { logError } from '../errors';
import { isEditableTarget } from '../fileShortcuts';
import { fixed } from '../format';
import type { LibraryClientApi, Track } from '../library';
import { AudioTimeline, viewSpan, type TimelineSnap } from './AudioTimeline';
import { ClipEqUI } from './ClipEqUI';
import { WAVEFORM_VIEW_W as W } from './WaveformView';

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
/** How often the picked track's stems are asked after. Separation is
 *  minutes long, so this is about noticing, not about progress. */
const STEM_POLL_MS = 2000;
/** Playhead refresh while a Web Audio loop runs (it has no timeupdate). */
const LOOP_TICK_MS = 50;
/** Debounce before measuring an untapped selection's tempo: detection
 *  renders the edit and may run a model, so it waits for the selection
 *  to settle. */
const DETECT_DELAY_MS = 600;

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

/** Default stretch-correction length, in beats (the grid slider). */
const DEFAULT_SECTION_BEATS = 4;
const MAX_SECTION_BEATS = 16;

/** The tap commit, kept regenerable: the slider and the +/− extensions
 *  re-derive grid and warp from the SAME taps against the SAME base
 *  program, replacing the present in place — the whole session is one
 *  undo step, however much the correction is tuned. */
type TapSession = {
  /** The program the taps were made against (what undo restores). */
  base: ClipProgram;
  /** The beat times the session was built from, on `base`'s output
   *  timeline: what the tracker heard over the tapped span, or the raw
   *  taps when nothing fit them. */
  taps: number[];
  /** What the session last produced; controls only apply while this IS
   *  the present program (undo/redo walks in and out of the session). */
  program: ClipProgram;
  stats: TapStats;
  /** Whole beats added (+) or dropped (−) at each edge of the grid. */
  extBack: number;
  extFwd: number;
};

/** Wash opacity for a stretch-correction section: faintly there from the
 *  first fraction of a percent (the section boundaries ARE the grid's
 *  structure), growing with the stretch, capped under the waveform. */
function stretchOpacity(ratio: number): number {
  return Math.min(0.4, 0.06 + 2 * Math.abs(Math.log2(ratio)));
}

function stretchTitle(ratio: number): string {
  const pct = (ratio - 1) * 100;
  return `stretched ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/** "4 beats selected", fractional (to one decimal) when an end sits off
 *  the grid. */
function beatsLabel(grid: ClipGrid, sel: Range): string {
  const b = beatSpan(grid, sel.start, sel.end);
  const whole = Math.abs(b - Math.round(b)) < 0.01;
  const shown = whole ? String(Math.round(b)) : b.toFixed(1);
  return `${shown} ${shown === '1' ? 'beat' : 'beats'} selected`;
}

/** Build a tap session's program: grid + warp from the taps at the given
 *  correction length, the +/− edge extensions re-applied a beat at a
 *  time (an extension with nowhere to go simply stops). */
function sessionProgram(
  base: ClipProgram,
  taps: number[],
  sectionBeats: number,
  extBack: number,
  extFwd: number,
): { program: ClipProgram; stats: TapStats } | null {
  const tapped = tapGrid(taps, sectionBeats);
  if (!tapped) return null;
  const warp = base.warp.length ? composeWarp(base.warp, tapped.warp) : tapped.warp;
  let program: ClipProgram = { ...base, warp, beat_grid: tapped.grid };
  const dur = programDuration(program);
  let grid = tapped.grid;
  for (const [edge, n] of [
    ['back', extBack],
    ['fwd', extFwd],
  ] as const) {
    for (let k = 0; k < Math.abs(n); k += 1) {
      const next = extendGrid(grid, edge, n > 0 ? 1 : -1, dur);
      if (!next) break;
      grid = next;
    }
  }
  if (grid !== tapped.grid) program = { ...program, beat_grid: grid };
  return { program, stats: tapped.stats };
}

export interface ClipViewProps {
  clip: ClipClientApi;
  library: LibraryClientApi;
  /** False while another page is showing: shortcuts detach, playback
   *  pauses, and the section hides (but stays mounted, keeping the edit). */
  active?: boolean;
  /** How often to ask after the picked track's stems (tests shorten it). */
  stemPollMs?: number;
  /** Debounce before measuring an untapped selection's tempo (tests
   *  shorten it). */
  detectDelayMs?: number;
  /** Handle for the Library page's Edit button (see ClipViewHandle). */
  ref?: Ref<ClipViewHandle>;
}

/** What another page can ask the (permanently mounted) editor to do. */
export interface ClipViewHandle {
  /** Open a library track for editing. Asks first if that would throw
   *  away an unsaved edit. */
  open: (trackId: number) => void;
}

export function ClipView({
  clip,
  library,
  active = true,
  stemPollMs = STEM_POLL_MS,
  detectDelayMs = DETECT_DELAY_MS,
  ref,
}: ClipViewProps) {
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
  /** The source track's title, filed with the clip — the beat-clip twin
   *  of a Beatify clip's project name (the decks show both). Prefilled
   *  from the opened track, editable in the save row. */
  const [sourceTitle, setSourceTitle] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  /** Right-shift taps of the current playback pass, output seconds. They
   *  become the beat grid the moment playback stops. */
  const [taps, setTaps] = useState<number[]>([]);
  /** Stretch-correction length in beats — the grid toolbar's slider. */
  const [sectionBeats, setSectionBeats] = useState(DEFAULT_SECTION_BEATS);
  /** The last tap commit, regenerable (see TapSession). */
  const [tapSession, setTapSession] = useState<TapSession | null>(null);
  /** The measured tempo of an untapped span, keyed by what it measured
   *  so a new selection or edit simply outdates it. */
  const [detected, setDetected] = useState<{
    request: ClipRequest;
    start: number;
    end: number;
    beats: ClipBeats | null;
  } | null>(null);
  const [detecting, setDetecting] = useState(false);

  /** Zoomed viewport over the output timeline; null = the whole clip. */
  const [vp, setVp] = useState<Range | null>(null);
  /** Which stems are switched ON, and the track they were chosen for: a
   *  choice does not carry over to the next track picked, which starts
   *  with the whole thing playing. */
  const [stemChoice, setStemChoice] = useState<{ trackId: number; on: string[] }>({
    trackId: -1,
    on: [...STEM_NAMES],
  });
  /** The configured separation backend, or null until probed. */
  const [backend, setBackend] = useState<ClipStemBackend | null>(null);
  /** Where each track's stems stand, as last polled. */
  const [stemStatus, setStemStatus] = useState<Record<number, ClipStemStatus>>({});

  const duration = programDuration(program);
  const spans = useMemo(() => regionSpans(program), [program]);
  // Memoized apart from `request` so its identity tracks the source list
  // itself: the staleness check below reads these references to tell a
  // timeline edit from a tone-only one.
  const sourceRefs = useMemo(() => sources.map(sourceRef), [sources]);
  const request = useMemo(() => ({ sources: sourceRefs, program }), [sourceRefs, program]);

  // A fresh array each render would churn every callback that depends on
  // the stem choice.
  const stemsOn = useMemo(
    () => (stemChoice.trackId === pick ? stemChoice.on : [...STEM_NAMES]),
    [pick, stemChoice],
  );

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
  const live = useRef({ clip, request, duration, taps, program, sectionBeats });
  useLayoutEffect(() => {
    live.current = { clip, request, duration, taps, program, sectionBeats };
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
        // Playback stopping is what turns the pass's taps into the beat
        // grid — but the grid is MEASURED, not averaged: the tracker
        // runs over the tapped span and the taps choose among its seeds
        // (clip_tap_beats), falling back to the taps themselves when
        // nothing fits. The chosen beat times go through the same rules
        // either way: covering only the tapped span, stretch-corrected
        // every `sectionBeats` beats, ONE program edit (one undo step);
        // a lone tap builds nothing and is simply cleared. All the
        // setters used here are React's stable ones — this is an event
        // callback, reading current state via `live`.
        if (!s.playing && live.current.taps.length > 0) {
          const rawTaps = live.current.taps;
          setTaps([]);
          const prev = live.current.program;
          void (async () => {
            let beats = rawTaps;
            let note: string | null = null;
            try {
              const heard = await live.current.clip.tapBeats(live.current.request, rawTaps);
              if (heard && heard.times.length >= 2) {
                beats = heard.times;
                note = heard.detail || null;
              } else if (heard?.detail) {
                note = `${heard.detail} — the grid is your taps as they were`;
              }
            } catch {
              // The tracker not answering never loses the taps.
            }
            // An edit landing while the tracker measured would put the
            // grid's anchors under different audio: drop the pass.
            if (live.current.program !== prev) return;
            const built = sessionProgram(prev, beats, live.current.sectionBeats, 0, 0);
            if (!built) return;
            setPast((h) => [...h.slice(-HISTORY_DEPTH), prev]);
            setFuture([]);
            setProgram(built.program);
            setTapSession({
              base: prev,
              taps: beats,
              program: built.program,
              stats: built.stats,
              extBack: 0,
              extFwd: 0,
            });
            // The selection in hand is quantized to the new grid at once.
            const grid = built.program.beat_grid;
            const dur = programDuration(built.program);
            setSelection((cur) => (cur && grid ? quantizeRange(grid, cur, dur) : cur));
            if (note) setStatus(note);
          })();
        }
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
  const { start: vpStart, end: vpEnd, len: vpLen } = viewSpan(vp, duration);

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

  /** Apply a TIMELINE edit: one that re-splices material. It consumes
   *  output times but cuts pre-warp audio, so the gesture's times are
   *  mapped back through the tap warp (`at`) — and the warp and its grid
   *  are dropped with it (see `dropGrid`), one undo step for the lot. */
  const applyTimeline = useCallback(
    (edit: (p: ClipProgram, at: (t: number) => number) => ClipProgram) => {
      apply((p) => {
        const warp = p.warp;
        return edit(dropGrid(p), (t) => warpSource(warp, t));
      });
    },
    [apply],
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

  // --- the grid toolbar: regenerating the tap session in place ----------
  //
  // The slider and the +/− extensions re-derive the grid and warp from
  // the session's taps and REPLACE the present program (no history push):
  // however much the correction is tuned, one undo removes the whole
  // session. They only apply while the present IS the session's program —
  // undo/redo walks in and out of that state.
  const tunable = tapSession !== null && tapSession.program === program;

  const regenerate = useCallback(
    (session: TapSession, beats: number, extBack: number, extFwd: number) => {
      const built = sessionProgram(session.base, session.taps, beats, extBack, extFwd);
      if (!built) return;
      setProgram(built.program);
      setTapSession({ ...session, program: built.program, stats: built.stats, extBack, extFwd });
    },
    [],
  );

  const retime = useCallback(
    (beats: number) => {
      setSectionBeats(beats);
      if (tapSession && tapSession.program === program) {
        regenerate(tapSession, beats, tapSession.extBack, tapSession.extFwd);
      }
    },
    [program, regenerate, tapSession],
  );

  const extend = useCallback(
    (edge: 'back' | 'fwd', by: 1 | -1) => {
      if (!tapSession || tapSession.program !== program) return;
      regenerate(
        tapSession,
        sectionBeats,
        tapSession.extBack + (edge === 'back' ? by : 0),
        tapSession.extFwd + (edge === 'fwd' ? by : 0),
      );
    },
    [program, regenerate, sectionBeats, tapSession],
  );

  const sel = selection && selection.end - selection.start > 1e-4 ? selection : null;

  const loadTrack = useCallback(
    async (
      trackId: number,
      mode: 'open' | 'append' | 'overlay',
      stemsWanted = stemSet(stemsOn),
    ) => {
      const stems = stemsWanted;
      setBusy(true);
      setError(null);
      try {
        // Re-adding a source that is already loaded reuses its slot — the
        // stem set is part of that identity, so "vocals" and the full mix
        // of the same track are two lanes.
        const existing = sources.findIndex((s) =>
          sameSource(sourceRef(s), { track_id: trackId, stems }),
        );
        const source =
          mode !== 'open' && existing >= 0
            ? sources[existing]
            : await clip.loadSource(trackId, stems, MIN_BUCKETS);
        if (!source) {
          logError(
            'clip.loadSource',
            `could not load track ${trackId} (stems: ${stems.join(', ') || 'none'})`,
          );
          setError(
            stems.length
              ? `Could not load ${stemLabel(stems)} — separate the track first`
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
          setTapSession(null);
          setVp(null);
          // A different program entirely: stop, don't play the old render.
          transportRef.current?.stop(0);
          setName(
            stems.length ? `${source.title} (${stemLabel(stems)})` : `${source.title} (clip)`,
          );
          setSourceTitle(source.title);
          return;
        }
        const index = existing >= 0 ? existing : sources.length;
        if (existing < 0) setSources([...sources, source]);
        setPast((h) => [...h.slice(-HISTORY_DEPTH), program]);
        setFuture([]);
        if (mode === 'append') {
          setProgram(appendSource(dropGrid(program), index, source.duration_secs));
          setStatus(`Spliced "${label}" onto the end`);
        } else {
          const at = sel ? sel.start : playhead;
          setProgram(
            addOverlay(
              dropGrid(program),
              index,
              source.duration_secs,
              warpSource(program.warp, at),
            ),
          );
          setStatus(`Overlaid "${label}" at ${timecode(at)}`);
        }
      } finally {
        setBusy(false);
      }
    },
    [clip, playhead, program, sel, sources, stemsOn],
  );

  /** Flip one stem of the picked track on or off.
   *
   *  The change lands on the audio straight away — swapping the loaded
   *  lane for the new mix — rather than waiting for another Open. Stems
   *  are the same length as the track they came from, so the edit itself
   *  (regions, level, EQ) survives untouched: only what those regions are
   *  made of changes. A load that fails leaves the switches as they were,
   *  so the panel never claims a mix that isn't playing.
   */
  const toggleStem = useCallback(
    async (name: string) => {
      if (pick === null) return;
      const on = stemsOn.includes(name) ? stemsOn.filter((s) => s !== name) : [...stemsOn, name];
      if (on.length === 0) {
        setError('Leave at least one stem on — muting all four is silence');
        return;
      }
      const was = stemsOn;
      setStemChoice({ trackId: pick, on });
      const lane = sources.findIndex((s) => s.track_id === pick);
      if (lane < 0) return;

      const stems = stemSet(on);
      setBusy(true);
      setError(null);
      try {
        const source = await clip.loadSource(pick, stems, MIN_BUCKETS);
        if (!source) {
          setStemChoice({ trackId: pick, on: was });
          logError('clip.loadSource', `could not load track ${pick} (stems: ${stems.join(', ')})`);
          setError(`Could not load ${stemLabel(stems) || 'the full mix'}`);
          return;
        }
        setSources(sources.map((s, i) => (i === lane ? source : s)));
        setStatus(stems.length ? `Playing ${stemLabel(stems)}` : 'Playing the full mix');
      } finally {
        setBusy(false);
      }
    },
    [clip, pick, sources, stemsOn],
  );

  // --- stems: automatic, so the page watches rather than asks ------------
  //
  // Every downloaded track is separated in the background (history
  // included), which is minutes of CPU each. There is nothing to press:
  // the page polls where the picked track stands and unlocks the mixer
  // when its stems land. Asking also puts that track at the front of the
  // queue, so an editor is never stuck behind a whole backfill.
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

  const picked = pick === null ? null : (stemStatus[pick] ?? null);
  /** Worth asking again? Only while stems might still turn up: a failed
   *  or unavailable track is a settled answer, not a wait. */
  const stemsPending = pick !== null && (picked === null || picked.state === 'loading');

  useEffect(() => {
    if (pick === null || !stemsPending || !active) return;
    let live = true;
    const poll = async () => {
      const status = await clip.stemStatus(pick);
      if (!live || !status) return;
      setStemStatus((m) =>
        m[pick]?.state === status.state &&
        m[pick]?.stage === status.stage &&
        m[pick]?.pending === status.pending
          ? m
          : { ...m, [pick]: status },
      );
    };
    void poll();
    const timer = setInterval(() => void poll(), stemPollMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, clip, pick, stemPollMs, stemsPending]);

  // --- selection edits (the timeline owns the gestures) -------------------
  //
  // The sweep/resize/slide gestures live in AudioTimeline; what stays here
  // is the one that EDITS: an alt-drag slide re-splices the audio to where
  // the selection was let go.
  const onSelectionSlid = useCallback(
    (base: Range, delta: number, audio: boolean) => {
      // Plain drag has already done its whole job: the selection sits
      // where it was let go and the audio never moved. Alt-drag asked
      // for the material to follow, so re-splice it there.
      if (!audio) return;
      const target = base.start + delta;
      applyTimeline((p, at) => moveRange(p, at(base.start), at(base.end), at(target)));
      setSelection({ start: target, end: target + (base.end - base.start) });
      transportRef.current?.seek(target);
    },
    [applyTimeline],
  );

  const timeAt = useCallback(
    (clientX: number, rect: DOMRect | null) => {
      if (!rect || rect.width <= 0 || duration <= 0) return 0;
      const frac = (clientX - rect.left) / rect.width;
      return Math.min(duration, Math.max(0, vpStart + frac * vpLen));
    },
    [duration, vpStart, vpLen],
  );

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
      setStemChoice({ trackId, on: [...STEM_NAMES] });
      void loadTrack(trackId, 'open', []);
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
      prev.program.crossfade_ms !== request.program.crossfade_ms ||
      prev.program.warp !== request.program.warp;
    const toneChanged =
      prev.program.eq !== request.program.eq || prev.program.level !== request.program.level;
    if (timelineChanged) transportRef.current?.invalidate();
    else if (toneChanged) transportRef.current?.refreshTone();
    // Only the beat grid moved (a +/− extension, say): no audio changed,
    // so playback carries on with the window it has.
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
      } else if (e.code === 'ShiftRight' && !e.repeat) {
        // A beat, tapped at the playhead — during playback only, and read
        // LIVE off the sounding source: the status playhead only advances
        // on timeupdate, far too coarse for a tapped beat.
        const transport = transportRef.current;
        if (transport?.playing) {
          const at = transport.position() ?? transport.playhead;
          setTaps((prev) => [...prev, at]);
        }
      } else if (!mod && e.key === 'Escape') {
        // Clicking no longer drops the selection, so this is the way out
        // of one — the same key the Beatify track view uses.
        setSelection(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, redo, togglePlay, undo]);

  // --- the beat grid, and what the save row says ---------------------------
  //
  // The grid rides in the program (it belongs to the warp, through undo).
  // A selection — or the whole clip — is measured in beats against it; a
  // span that was never tapped is measured by the tracker instead, and
  // the save row shows whichever answer is in hand.
  const grid = program.beat_grid;
  const disabled = program.regions.length === 0;
  /** What a save would file: the selection, or the whole clip. */
  const range = useMemo<Range>(() => sel ?? { start: 0, end: duration }, [sel, duration]);

  // Measure an untapped span once the selection settles. The result is
  // keyed by what it measured, so an edit or a new selection outdates it
  // without anything having to be cleared.
  useEffect(() => {
    if (!active || disabled || grid) return;
    const { start, end } = range;
    if (end - start <= 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setDetecting(true);
        try {
          const beats = await clip.detectBeats(request, start, end);
          if (!cancelled) setDetected({ request, start, end, beats });
        } finally {
          if (!cancelled) setDetecting(false);
        }
      })();
    }, detectDelayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, clip, detectDelayMs, disabled, grid, range, request]);

  /** The measurement, only if it still describes the span being saved. */
  const measured =
    detected &&
    detected.request === request &&
    detected.start === range.start &&
    detected.end === range.end
      ? detected.beats
      : null;

  /** BPM + whole beats for the save row: the tapped grid's when there is
   *  one, the tracker's otherwise. `padded` says the span was fractional
   *  and the last beat will be filled with silence. Against a grid the
   *  count comes from its ACTUAL beats (`beatSpan`) — a selection
   *  quantized to two beats IS two, even where flam makes its seconds
   *  run a hair long — and the save sends this count, so the clip filed
   *  is the clip this row showed. */
  const tempo = useMemo(() => {
    const span = range.end - range.start;
    if (span <= 0) return null;
    const of = (bpm: number, beatsF: number) => {
      const beats = Math.max(1, Math.ceil(beatsF - 1e-6));
      return { bpm, beats, padded: beats - beatsF > 1e-6 };
    };
    if (grid) return of(grid.bpm, beatSpan(grid, range.start, range.end));
    return measured ? of(measured.bpm, (span * measured.bpm) / 60) : null;
  }, [grid, measured, range]);

  const save = useCallback(async () => {
    if (!tempo) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const saved = await clip.saveBeatClip(
        request,
        name,
        sourceTitle,
        range.start,
        range.end,
        tempo.bpm,
        tempo.beats,
      );
      if (saved) {
        setStatus(
          `Saved "${saved.name}" — ${saved.beats} ${saved.beats === 1 ? 'beat' : 'beats'} at ` +
            `${fixed(saved.bpm, 1)} BPM, ready for the decks' clip pickers`,
        );
      }
    } finally {
      setBusy(false);
    }
  }, [clip, name, range, request, sourceTitle, tempo]);

  // Selections quantize to the tapped grid; AudioTimeline reads ⌘ live
  // and skips these, which is how the window is dragged off the beat.
  const snap = useMemo<TimelineSnap | undefined>(() => {
    if (!grid) return undefined;
    const clampT = (secs: number) => Math.min(duration, Math.max(0, secs));
    return {
      seek: (secs, free) => (free ? secs : clampT(nearestBeat(grid, secs))),
      range: (r) => quantizeRange(grid, r, duration),
      slide: (r) => {
        const start = clampT(nearestBeat(grid, r.start));
        return { start, end: start + (r.end - r.start) };
      },
    };
  }, [duration, grid]);

  // The preview belongs to the current edit only; an emptied program has none.
  const preview = program.regions.length === 0 ? null : previewState;
  const peaks = preview?.peaks ?? [];
  /** Can the picked track be loaded stem by stem right now? */
  const stemsReady = picked?.state === 'ready';
  /** The level lane shares the timeline's viewport (AudioTimeline uses
   *  the same mapping), so automation stays under its audio at any zoom. */
  const xOf = (secs: number) => (vpLen > 0 ? ((secs - vpStart) / vpLen) * W : 0);
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
            <span
              className="tag tag-source"
              key={`${s.track_id}:${s.stems.join('+') || 'mix'}:${i}`}
            >
              {i + 1}. {sourceLabel(s)}
            </span>
          ))}
        </span>
      </div>

      <div className="clip-stems" data-testid="clip-stems">
        <div
          className="clip-stem-toggles"
          data-testid="clip-stem-toggles"
          role="group"
          aria-label="Stems"
        >
          <span>Stems</span>
          {(backend?.stems ?? STEM_NAMES).map((name) => {
            const on = stemsOn.includes(name);
            return (
              <button
                key={name}
                className={on ? 'clip-stem-on' : 'clip-stem-off'}
                data-testid={`clip-stem-${name}`}
                aria-pressed={on}
                disabled={!stemsReady || busy}
                title={
                  stemsReady
                    ? `${on ? 'Drop' : 'Bring back'} the ${name}`
                    : stemWait(picked, backend)
                }
                onClick={() => void toggleStem(name)}
              >
                {name}
              </button>
            );
          })}
        </div>
        {stemsReady ? (
          <span className="clip-stem-ready" data-testid="clip-stem-ready">
            stems ready ({picked?.backend ?? backend?.backend})
          </span>
        ) : picked?.state === 'loading' ? (
          <span className="clip-stem-loading" data-testid="clip-stem-loading">
            Stems are loading…{picked.stage ? ` (${picked.stage})` : ''}
            {picked.pending > 1 ? ` · ${picked.pending} tracks queued` : ''}
          </span>
        ) : (
          pick !== null && (
            <span className="clip-stem-hint" data-testid="clip-stem-hint">
              {stemWait(picked, backend)}
            </span>
          )
        )}
        {pick === null && backend?.available === false && (
          <span className="clip-stem-hint" data-testid="clip-stem-hint">
            {backend.detail ?? 'Stem separation is unavailable'}
          </span>
        )}
      </div>

      {disabled ? (
        <p className="clip-empty" data-testid="clip-empty">
          Open a library track to start editing. Saving files a new beat clip the decks can load —
          sources are never overwritten.
        </p>
      ) : (
        <>
          <AudioTimeline
            idPrefix="clip"
            duration={duration}
            peaks={peaks}
            waveHeight={WAVE_H}
            vp={vp}
            onVpChange={setVp}
            selection={selection}
            onSelectionChange={setSelection}
            playing={playing}
            playhead={playhead}
            loop={loop}
            onTogglePlay={togglePlay}
            onStop={stop}
            onToggleLoop={() => setLoop((v) => !v)}
            onSeek={(t) => transportRef.current?.seek(t)}
            onSelectionSlid={onSelectionSlid}
            snap={snap}
            selectionTitle={
              grid
                ? 'Drag to move the selection — ⌘ frees it from the beat grid, alt moves the audio'
                : 'Drag to move the selection — alt-drag to move the audio with it'
            }
            timecode={timecode}
            transportExtra={
              <>
                <button data-testid="clip-undo" disabled={past.length === 0} onClick={undo}>
                  Undo
                </button>
                <button data-testid="clip-redo" disabled={future.length === 0} onClick={redo}>
                  Redo
                </button>
              </>
            }
            renderUnder={(xOf) => (
              <>
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
                {grid &&
                  stretchBands(program.warp).map((b, i) => (
                    <rect
                      key={`stretch${i}`}
                      data-testid={`clip-stretch-${i}`}
                      className={
                        b.ratio >= 1
                          ? 'clip-stretch clip-stretch-slower'
                          : 'clip-stretch clip-stretch-faster'
                      }
                      x={xOf(b.start)}
                      y={0}
                      width={Math.max(0, xOf(b.end) - xOf(b.start))}
                      height={WAVE_H}
                      style={{ opacity: stretchOpacity(b.ratio) }}
                    >
                      <title>{stretchTitle(b.ratio)}</title>
                    </rect>
                  ))}
                {grid &&
                  gridBeatTimes(grid, vpStart, vpEnd).map((t, i) => (
                    <line
                      key={`beat${i}`}
                      data-testid="clip-beat-line"
                      className="clip-beat-line"
                      x1={xOf(t)}
                      x2={xOf(t)}
                      y1={0}
                      y2={WAVE_H}
                    />
                  ))}
                {taps.map((t, i) => (
                  <line
                    key={`tap${i}`}
                    data-testid="clip-tap-line"
                    className="clip-tap-line"
                    x1={xOf(t)}
                    x2={xOf(t)}
                    y1={0}
                    y2={WAVE_H}
                  />
                ))}
              </>
            )}
            renderOver={(xOf) =>
              program.overlays.map((o, i) => (
                <rect
                  key={`ov${i}`}
                  data-testid={`clip-overlay-span-${i}`}
                  className="clip-overlay-span"
                  x={xOf(Math.max(0, o.at_secs))}
                  y={0}
                  width={Math.max(1, xOf(o.at_secs + (o.end_secs - o.start_secs)) - xOf(o.at_secs))}
                  height={10}
                />
              ))
            }
            readoutExtra={
              (grid && sel ? ` · ${beatsLabel(grid, sel)}` : '') +
              (preview ? ` · ${preview.channels}ch ${preview.sample_rate} Hz` : ' · rendering…')
            }
            belowWave={
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
            }
          />

          {grid && (
            <div className="clip-grid-tools" data-testid="clip-grid-tools">
              <span className="clip-grid-label">Beat grid</span>
              <span
                className="clip-grid-extend"
                role="group"
                aria-label="Extend or shrink the grid"
                title={tunable ? undefined : 'Tap the beats again to retune this grid'}
              >
                <button
                  data-testid="clip-grid-back-plus"
                  disabled={!tunable || extendGrid(grid, 'back', 1, duration) === null}
                  title="Extend the grid one beat earlier"
                  onClick={() => extend('back', 1)}
                >
                  +◀
                </button>
                <button
                  data-testid="clip-grid-back-minus"
                  disabled={!tunable || extendGrid(grid, 'back', -1, duration) === null}
                  title="Drop the grid's first beat"
                  onClick={() => extend('back', -1)}
                >
                  −◀
                </button>
                <button
                  data-testid="clip-grid-fwd-minus"
                  disabled={!tunable || extendGrid(grid, 'fwd', -1, duration) === null}
                  title="Drop the grid's last beat"
                  onClick={() => extend('fwd', -1)}
                >
                  ▶−
                </button>
                <button
                  data-testid="clip-grid-fwd-plus"
                  disabled={!tunable || extendGrid(grid, 'fwd', 1, duration) === null}
                  title="Extend the grid one beat later"
                  onClick={() => extend('fwd', 1)}
                >
                  ▶+
                </button>
              </span>
              <label className="clip-grid-section">
                <span>Correct every</span>
                <input
                  type="range"
                  min={1}
                  max={MAX_SECTION_BEATS}
                  step={1}
                  data-testid="clip-grid-section"
                  disabled={!tunable}
                  value={sectionBeats}
                  onChange={(e) => retime(Number(e.target.value))}
                  title="How long each stretch-correction section is: between corrections the beats keep their tapped feel"
                />
                <span data-testid="clip-grid-section-readout">
                  {sectionBeats === 1 ? 'every beat' : `${sectionBeats} beats`}
                </span>
              </label>
              {tunable && tapSession && (
                <span className="clip-grid-stats" data-testid="clip-grid-stats">
                  max flam {Math.round(tapSession.stats.maxFlamSecs * 1000)} ms · max stretch{' '}
                  {(tapSession.stats.maxStretch * 100).toFixed(1)}%
                </span>
              )}
            </div>
          )}

          <div className="clip-tools">
            <button
              data-testid="clip-trim"
              disabled={noSelection}
              onClick={() => {
                if (!sel) return;
                applyTimeline((p, at) => trimTo(p, at(sel.start), at(sel.end)));
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
                applyTimeline((p, at) => cutRange(p, at(sel.start), at(sel.end)));
                setSelection(null);
              }}
            >
              Cut selection
            </button>
            <button
              data-testid="clip-reverse"
              disabled={noSelection}
              onClick={() =>
                sel && applyTimeline((p, at) => reverseRange(p, at(sel.start), at(sel.end)))
              }
            >
              Reverse
            </button>
            <button
              data-testid="clip-duplicate"
              disabled={noSelection}
              onClick={() =>
                sel && applyTimeline((p, at) => duplicateRange(p, at(sel.start), at(sel.end)))
              }
            >
              Duplicate
            </button>
            <button
              data-testid="clip-louder"
              disabled={noSelection}
              onClick={() =>
                sel && applyTimeline((p, at) => gainRange(p, at(sel.start), at(sel.end), 3))
              }
            >
              +3 dB
            </button>
            <button
              data-testid="clip-quieter"
              disabled={noSelection}
              onClick={() =>
                sel && applyTimeline((p, at) => gainRange(p, at(sel.start), at(sel.end), -3))
              }
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

          <div className="clip-save">
            <label>
              <span>Name</span>
              <input
                data-testid="clip-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label title="The track this clip is cut from — shown above the clip's name in the decks, like a Beatify clip's project">
              <span>Source</span>
              <input
                data-testid="clip-source-title"
                value={sourceTitle}
                onChange={(e) => setSourceTitle(e.target.value)}
              />
            </label>
            <span className="clip-save-meta" data-testid="clip-save-meta">
              {tempo
                ? `${fixed(tempo.bpm, 1)} BPM · ${tempo.beats} ${tempo.beats === 1 ? 'beat' : 'beats'}${
                    tempo.padded ? ' (last beat filled with silence)' : ''
                  }${grid ? '' : ' · measured'}`
                : detecting
                  ? 'measuring the tempo…'
                  : 'no tempo yet — tap beats with right-shift during playback'}
            </span>
            <button
              className="clip-save-button"
              data-testid="clip-save"
              disabled={busy || name.trim() === '' || !tempo}
              onClick={() => void save()}
            >
              Save as new beat clip
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
