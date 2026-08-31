// Clip page (PRD §9): load a library track, splice it and automate its
// level, then save a span of the edit as a BEAT CLIP —
// whole beats at a known tempo, loadable into the decks and the rack's
// Beat Clip module.
//
// A SAVE BINDS THE PAGE TO WHAT IT FILED. The first save mints a clip;
// every save after it re-files THAT clip (`editing`), so shaping a loop
// leaves one clip in the store rather than a trail of near-copies. The
// binding breaks when the top row picks a different track — a new source
// is a new clip — and it is also what the Library's Edit button sets when
// it hands a saved clip back (`openClip`): the clip carries the edit that
// made it, so it opens as the edit rather than as audio.
//
// The edit itself is a plain ClipProgram (src/clip.ts) — every operation is
// a pure function over it, so this component only owns selection, undo/redo
// history, the viewport (zoom), playback and the debounced preview render.
// Nothing here touches the engine: rendering happens off-thread in the
// shell (dj-analysis).
//
// TWO PANES, TWO JOBS. The SOURCE TRACK at the top is the reference —
// the material as it was cut, with the beat grid, the joins and the
// selection drawn on it. Its waveform is the DRY render (no level), so
// it never moves under a tone edit: that is what makes it something to
// cut against. The SELECTION PANE below it is the result — the chosen
// span as it actually sounds, with the level automation lane under it,
// looping, and updating under the hand rather than after it.
// Clearing the selection takes the pane away and hands playback back to
// the source track.
//
// That split is also what makes the page quick. Tone is applied in the
// webview (clipLive.ts) instead of being baked into a render, so a
// dragged level point is a parameter change on running audio —
// no render, no IPC, no gap — while the backend is asked only for
// MATERIAL (the timeline, the stems), and even then the old audio plays
// on until the new is decoded and cross-faded in.
//
// BEATS ARE TAPPED: right-shift during playback drops a marker at the
// playhead (drawn on the waveform), and when playback stops the tapped
// span is MEASURED — the beat tracker runs over it and the taps pick
// the seed (and metrical reading) that best fits them (clip_tap_beats),
// so the grid is the chosen seed's beat times; when nothing fits, the
// taps themselves are the grid at their average BPM. Every OTHER seed's
// hearing comes back too, so the toolbar's picker can overrule the
// choice without measuring again. LEFT shift marks a ONE (a downbeat)
// rather than a beat: it adds nothing to the grid — the tap is carried
// to the right-shift tap nearest it and flags the beat that one landed
// on (`ClipGrid.ones`, drawn in its own colour and filed with the clip).
// Either way the grid
// covers ONLY the tapped span (the grid toolbar's +/− buttons extend it
// a beat at a time). The stretch correction happens every `sectionBeats` beats
// (the toolbar slider, default 4): section boundaries are warped onto
// the ideal grid and the beats inside keep their tapped feel, so the
// toolbar reads out what that costs — flam (uncorrected offset), stretch
// and the miss between the hand and the grid, max and average each. A
// second slider SMOOTHS that stretch (`warp_smoothing`, 0…1): the
// correction eases in and out across each section instead of switching
// rate at its boundary, which is what the boundary clicked with. The
// whole tap session — grid, warp, extensions, slider moves, seed picks —
// is ONE undo step (`tapSession` regenerates in place).
// Selections then quantize to the grid's actual beats; ⌘-drag frees
// them. A selection that was never tapped is measured by the beat
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
  appendSource,
  beatSpan,
  clearLevel,
  composeWarp,
  dropGrid,
  emptyProgram,
  extendGrid,
  gridBeatTimes,
  gridOneTimes,
  levelDbAt,
  moveRange,
  nearestBeat,
  programDuration,
  quantizeRange,
  regionSpans,
  removeLevelPoint,
  setLevelPoint,
  sourceLabel,
  sourceRef,
  stemLabel,
  stemSet,
  stemWait,
  stretchBands,
  tapGrid,
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
  type ClipTapSeed,
  type TapStats,
  type WarpPoint,
  DEFAULT_WARP_SMOOTHING,
  SILENCE_DB,
  STEM_NAMES,
} from '../clip';
import { ClipTransport, type TransportHost } from '../clipTransport';
import {
  bleedWindows,
  ClipLivePlayer,
  liveAudioAvailable,
  tonePeaks,
  type BleedWindow,
  type LiveBleedAudio,
  type LiveHost,
} from '../clipLive';
import { logError } from '../errors';
import { isEditableTarget } from '../fileShortcuts';
import { fixed } from '../format';
import type { LibraryClientApi, Track } from '../library';
import { AudioTimeline, viewSpan, type TimelineSnap } from './AudioTimeline';
import { ClipSelectionPane } from './ClipSelectionPane';
import { WAVEFORM_VIEW_W as W } from './WaveformView';

const WAVE_H = 120;
/** The selection pane's waveform: shorter than the source track's, which
 *  is the one you cut against. */
const SEL_WAVE_H = 96;
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
/** How near a whole beat counts AS that beat. A selection is chosen by
 *  hand or snapped to a grid whose beats carry the tapping's flam, so the
 *  fraction left over is arithmetic, not intent: anything inside a
 *  hundredth of a beat rounds down rather than growing a beat of
 *  silence. */
const BEAT_EPS = 0.01;
/** Undo depth for clip edits (page-local; unrelated to patch undo). */
const HISTORY_DEPTH = 49;
/** How often the picked track's stems are asked after. Separation is
 *  minutes long, so this is about noticing, not about progress. */
const STEM_POLL_MS = 2000;
/** Playhead refresh while a Web Audio loop runs (it has no timeupdate). */
const LOOP_TICK_MS = 50;
/** Buckets for the selection pane's waveform: it is one pane wide, and
 *  the peaks are computed in the webview, so this is cheap. */
const SEL_BUCKETS = 2000;
/** Fewest buckets a bleed region is drawn with: a bookend is a fraction
 *  of the loop's width, and a handful of columns still reads as audio. */
const MIN_BLEED_BUCKETS = 8;
/** Debounce before re-drawing the selection's waveform after a tone edit.
 *  The AUDIO is already live; this is only the picture catching up, and
 *  redrawing it per mousemove is what would cost. */
const SEL_PEAKS_DELAY_MS = 120;
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

/** The pictures the selection pane draws: the loop and the two bookends
 *  either side of it, each its own region of the waveform. */
interface PiecePeaks {
  loop: number[];
  left: number[];
  right: number[];
}

/** Default stretch-correction length, in beats (the grid slider). */
const DEFAULT_SECTION_BEATS = 4;
const MAX_SECTION_BEATS = 16;
/** Step of the smoothing slider (0 = the hard rate step at each anchor,
 *  1 = all of the stretch in the middle of the section). */
const SMOOTHING_STEP = 0.05;

/** The tap commit, kept regenerable: the slider, the seed picker and the
 *  +/− extensions re-derive grid and warp from the SAME taps against the
 *  SAME base program, replacing the present in place — the whole session
 *  is one undo step, however much the correction is tuned. */
type TapSession = {
  /** The program the taps were made against (what undo restores, and
   *  whose warp this session composes onto). */
  base: ClipProgram;
  /** The right-shift taps themselves, on `base`'s output timeline: what
   *  bounded the span, and what the tap miss is measured against. */
  rawTaps: number[];
  /** The left-shift taps of the same pass: the ones. They mark beats the
   *  taps already made, so they are re-derived with everything else. */
  oneTaps: number[];
  /** Every seed's hearing of the span, best fit first — empty when the
   *  tracker refused and the taps are the grid on their own. */
  seeds: ClipTapSeed[];
  /** Which seed's beats the grid is built from; null is "the taps
   *  themselves". Autoselected (the best fit), overridable. */
  seed: string | null;
  /** The beat times the grid was built from: the chosen seed's, or the
   *  raw taps when nothing fit them. */
  beats: number[];
  /** What the session put ON the program. The grid is the session's
   *  IDENTITY: its controls apply as long as the present program still
   *  carries it — a tone edit (level automation) keeps the grid and must
   *  not silently end the session, while any timeline edit drops it. */
  grid: ClipGrid;
  /** The session's OWN warp, before composition with `base.warp`: the
   *  stretch sections belong to this session, so a re-tap replaces the
   *  washes on the waveform instead of leaving the old ones behind. */
  warp: WarpPoint[];
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

/** What the tracker's grid cost and how well it was tapped, max/average
 *  throughout: the toolbar's debug line. Flam and stretch are the two
 *  halves of the correction (what it left, what it moved), tap miss is
 *  the hand against the beats the chosen seed heard — a big miss with a
 *  small flam means the seed disagrees with the tapping, not the tapping
 *  with itself, which is exactly when another seed is worth a try. */
function statsLine(s: TapStats): string {
  const ms = (secs: number) => Math.round(secs * 1000);
  const pct = (r: number) => (r * 100).toFixed(1);
  return (
    `flam ${ms(s.maxFlamSecs)}/${ms(s.avgFlamSecs)} ms · ` +
    `stretch ${pct(s.maxStretch)}/${pct(s.avgStretch)}% · ` +
    `tap miss ${ms(s.maxMissSecs)}/${ms(s.avgMissSecs)} ms · ` +
    `${s.beats} beats from ${s.taps} taps`
  );
}

/** What one grid control changed about the session (everything else is
 *  re-derived from the session as it stands). */
type TapTweak = {
  seed?: string;
  beats?: number[];
  sectionBeats?: number;
  smoothing?: number;
  extBack?: number;
  extFwd?: number;
};

/** What a tap session is re-derived from: the taps, the seed chosen among
 *  what the tracker heard, and the toolbar settings. */
type TapSpec = {
  base: ClipProgram;
  /** The program the result REPLACES — everything the session does not
   *  own (tone edits made since the taps) is carried over from it. */
  present: ClipProgram;
  beats: number[];
  rawTaps: number[];
  oneTaps: number[];
  sectionBeats: number;
  smoothing: number;
  extBack: number;
  extFwd: number;
};

/** Build a tap session's program: grid + warp from the beats at the given
 *  correction length and smoothing, composed onto the base program's warp,
 *  the +/− edge extensions re-applied a beat at a time (an extension with
 *  nowhere to go simply stops). */
function sessionProgram(
  spec: TapSpec,
): { program: ClipProgram; grid: ClipGrid; warp: WarpPoint[]; stats: TapStats } | null {
  const { base, present, beats, rawTaps, oneTaps, sectionBeats, smoothing, extBack, extFwd } = spec;
  const tapped = tapGrid(beats, sectionBeats, smoothing, rawTaps, oneTaps);
  if (!tapped) return null;
  const warp = base.warp.length
    ? composeWarp(base.warp, tapped.warp, base.warp_smoothing, smoothing)
    : tapped.warp;
  let program: ClipProgram = {
    ...present,
    warp,
    warp_smoothing: smoothing,
    beat_grid: tapped.grid,
  };
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
  return { program, grid, warp: tapped.warp, stats: tapped.stats };
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
  /** Open a SAVED beat clip: its edit, its span and its name, with saves
   *  going back to that clip. A clip that cannot be taken apart says so
   *  where the editor would have been. */
  openClip: (clipId: string) => void;
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
  /** The saved beat clip this page is revising: set by the first save,
   *  and by opening one from the Library. While it holds, saving re-files
   *  THAT clip instead of minting another — picking a different track in
   *  the top row is what ends it. */
  const [editing, setEditing] = useState<{ clipId: string } | null>(null);
  /** A saved clip that cannot be opened, and why. Shown INSTEAD of the
   *  editor: there is nothing to edit, and pretending otherwise would
   *  offer edits that could never be saved back. */
  const [unopenable, setUnopenable] = useState<{ name: string; problem: string } | null>(null);
  /** BLEED, in milliseconds, as the selection's two bookends: material
   *  from OUTSIDE the span, filed with the clip as metadata and laid over
   *  the loop's seam by whatever plays it — never mixed into the loop
   *  (dj-engine's `ClipBleed`). The RIGHT bleed is the audio after the
   *  span and sounds over the loop's start; the LEFT is the audio before
   *  it and sounds over the loop's end. Each control sits at the edge its
   *  material comes from. */
  const [bleed, setBleed] = useState({ left: 0, right: 0 });
  /** WHAT THE LAST SAVE FILED. The tick beside the save buttons is this
   *  agreeing with what the page holds now, so it goes out by itself the
   *  moment anything that would be filed differently moves. */
  const [filed, setFiled] = useState<{
    request: ClipRequest;
    name: string;
    range: Range;
    bleed: { left: number; right: number };
  } | null>(null);
  /** The selection edges the bleed in hand was dialled against. */
  const bleedEdges = useRef<Range | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  /** Right-shift taps of the current playback pass, output seconds. They
   *  become the beat grid the moment playback stops. */
  const [taps, setTaps] = useState<number[]>([]);
  /** The same list, written as the taps happen: the stop that commits
   *  them arrives before React has re-rendered, so the pass reads this
   *  and empties it — the state copy is only what the waveform draws. */
  const tapRun = useRef<number[]>([]);
  /** Left-shift taps of the same pass: the ones. They never become beats
   *  of their own — each flags the beat the nearest right-shift tap made
   *  — but they are drawn while the pass runs, like the taps. */
  const [oneTaps, setOneTaps] = useState<number[]>([]);
  const oneRun = useRef<number[]>([]);
  /** Stretch-correction length in beats — the grid toolbar's slider. */
  const [sectionBeats, setSectionBeats] = useState(DEFAULT_SECTION_BEATS);
  /** How much the correction eases across a section (0…1) — the grid
   *  toolbar's second slider. */
  const [smoothing, setSmoothing] = useState(DEFAULT_WARP_SMOOTHING);
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

  // THE DRY EDIT: the timeline with no tone on it. Tone (level) is
  // applied LIVE in the webview (clipLive.ts), so the backend must not be
  // asked to bake it in — and, more to the point, this request's identity
  // does not move when a point does, which is what keeps the source
  // track's waveform still, the render memo warm and playback unbroken
  // through a whole automation pass. The full `request` above is what the SAVE
  // sends (and what the fallback audition path plays, where there is no
  // live graph to apply tone).
  const { regions, crossfade_ms, warp, warp_smoothing, beat_grid } = program;
  const dryProgram = useMemo<ClipProgram>(
    () => ({ ...emptyProgram(), regions, crossfade_ms, warp, warp_smoothing, beat_grid }),
    [regions, crossfade_ms, warp, warp_smoothing, beat_grid],
  );
  const dryRequest = useMemo(
    () => ({ sources: sourceRefs, program: dryProgram }),
    [sourceRefs, dryProgram],
  );

  // A fresh array each render would churn every callback that depends on
  // the stem choice.
  const stemsOn = useMemo(
    () => (stemChoice.trackId === pick ? stemChoice.on : [...STEM_NAMES]),
    [pick, stemChoice],
  );

  // --- playback: the two owners -------------------------------------------
  //
  // Playback belongs to one of exactly two objects, and never to both:
  //
  //   - a SELECTION is auditioned by ClipLivePlayer (src/clipLive.ts): the
  //     dry span is fetched once and loops in a Web Audio graph whose
  //     level automation moves under the audio, so a dragged point costs
  //     no render and playback never stops;
  //   - with NOTHING selected the source track plays through ClipTransport
  //     (src/clipTransport.ts), which streams rendered windows of the
  //     whole edit — the same owner (and the same four invariants) the
  //     page has always had. It is also the fallback for a selection too
  //     long to hold as one buffer, or a runtime with no Web Audio.
  //
  // This component never touches an audio node itself: it hands each owner
  // a host to read the live edit through, calls commands, and renders the
  // status it is given back. ONE effect below ("who plays what") is the
  // only place playback changes hands, so the "playing twice with nobody
  // holding the handle" bug cannot come back through the second owner.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transportRef = useRef<ClipTransport | null>(null);
  const liveRef = useRef<ClipLivePlayer | null>(null);
  /** The decoded selection, when the live player has one: what the
   *  selection pane's waveform is drawn from. */
  const [selBuffer, setSelBuffer] = useState<AudioBuffer | null>(null);
  /** The decoded BOOKENDS beside it — the bleed either side of the span.
   *  Kept apart from the loop because they are drawn apart from it: what
   *  overlays them is playback, not the picture. */
  const [bleedBuffers, setBleedBuffers] = useState<LiveBleedAudio>({ left: null, right: null });
  /** Peaks of the selection WITH the tone on it, computed off the decoded
   *  buffer; null until the first pass (the pane draws the dry material
   *  meanwhile). Each piece is levelled where its material sits on the
   *  timeline, so the three pictures agree with the three voices. */
  const [selPeaks, setSelPeaks] = useState<PiecePeaks | null>(null);
  /** The live player is fetching material (a stem swap, a timeline edit).
   *  What is already loaded keeps playing until it lands. */
  const [selLoading, setSelLoading] = useState(false);

  const sel = selection && selection.end - selection.start > 1e-4 ? selection : null;
  /** Is the live graph what is auditioning the selection? A span longer
   *  than one rendered window cannot be held as a single buffer, and a
   *  runtime with no Web Audio has no graph at all — both fall back to
   *  the transport, where tone still costs a render. */
  const liveOn = sel !== null && sel.end - sel.start <= PLAY_WINDOW_SECS && liveAudioAvailable();

  /** WHERE the bleed comes from: the windows either side of the span, in
   *  output-timeline seconds, clamped to what the edit actually has.
   *  Asked of the live player's own function, so the regions drawn (and
   *  the times the level lane writes over them) are exactly the windows
   *  that get fetched and heard. */
  const bleedWin = useMemo(
    () =>
      sel
        ? bleedWindows(sel, { leftMs: bleed.left, rightMs: bleed.right }, duration)
        : { left: null, right: null },
    [sel, bleed, duration],
  );
  const bleedLeftSecs = bleedWin.left?.len ?? 0;
  const bleedRightSecs = bleedWin.right?.len ?? 0;
  /** The pane's x-axis: the loop WITH its bookends. The level lane shares
   *  it, so a point dropped over a bookend is written at the time that
   *  bookend's material has on the timeline — which is what makes the
   *  three envelopes independent where the audio overlaps. */
  const laneRange = useMemo(
    () => (sel ? { start: sel.start - bleedLeftSecs, end: sel.end + bleedRightSecs } : null),
    [sel, bleedLeftSecs, bleedRightSecs],
  );

  /** Move the playhead — on whichever owner has it. Declared here beside
   *  the owners because the editing gestures below seek too. */
  const seek = useCallback(
    (secs: number) => {
      if (liveOn && sel) liveRef.current?.seekPhase(secs - sel.start);
      else transportRef.current?.seek(secs);
    },
    [liveOn, sel],
  );

  // What the owners need to read at CALL time, not at render time: their
  // hosts close over this ref so a single instance of each survives every
  // edit.
  //
  // The mirror is updated in a LAYOUT effect, which React flushes during
  // the commit. A passive effect is flushed later — after the browser can
  // dispatch the next click — so pressing play in that gap read the
  // previous render's duration, computed an empty window, and silently
  // played nothing.
  const live = useRef({
    clip,
    request,
    dryRequest,
    duration,
    program,
    sectionBeats,
    smoothing,
    sel,
    liveOn,
  });
  useLayoutEffect(() => {
    live.current = {
      clip,
      request,
      dryRequest,
      duration,
      program,
      sectionBeats,
      smoothing,
      sel,
      liveOn,
    };
  });

  // Playback stopping is what turns the pass's taps into the beat grid —
  // but the grid is MEASURED, not averaged: the tracker runs over the
  // tapped span and the taps choose among its seeds (clip_tap_beats),
  // falling back to the taps themselves when nothing fits. The chosen
  // beat times go through the same rules either way: covering only the
  // tapped span, stretch-corrected every `sectionBeats` beats, ONE
  // program edit (one undo step); a lone tap builds nothing and is simply
  // cleared. Both owners of playback call this when they stop, so it
  // takes no arguments and reads what is current through `live` — all the
  // setters it uses are React's stable ones.
  //
  // The taps are taken from a REF, not from `live`: stopping notifies
  // twice (playing, then where the playhead parked) and a mirror that
  // only refreshes on render still held them the second time — two
  // tracker runs and two undo steps for one pass.
  const commitTaps = useCallback(() => {
    const rawTaps = tapRun.current;
    const oneTaps = oneRun.current;
    if (rawTaps.length === 0) {
      // Ones alone mark nothing: there is no grid for them to flag.
      oneRun.current = [];
      setOneTaps([]);
      return;
    }
    tapRun.current = [];
    oneRun.current = [];
    setTaps([]);
    setOneTaps([]);
    const prev = live.current.program;
    void (async () => {
      let beats = rawTaps;
      let seeds: ClipTapSeed[] = [];
      let seed: string | null = null;
      let note: string | null = null;
      try {
        const heard = await live.current.clip.tapBeats(live.current.dryRequest, rawTaps);
        if (heard && heard.times.length >= 2) {
          beats = heard.times;
          seeds = heard.seeds ?? [];
          seed = heard.seed || null;
          note = heard.detail || null;
        } else if (heard?.detail) {
          note = `${heard.detail} — the grid is your taps as they were`;
        }
      } catch {
        // The tracker not answering never loses the taps.
      }
      // An edit landing while the tracker measured would put the grid's
      // anchors under different audio: drop the pass.
      if (live.current.program !== prev) return;
      const built = sessionProgram({
        base: prev,
        present: prev,
        beats,
        rawTaps,
        oneTaps,
        sectionBeats: live.current.sectionBeats,
        smoothing: live.current.smoothing,
        extBack: 0,
        extFwd: 0,
      });
      if (!built) return;
      setPast((h) => [...h.slice(-HISTORY_DEPTH), prev]);
      setFuture([]);
      setProgram(built.program);
      setTapSession({
        base: prev,
        rawTaps,
        oneTaps,
        seeds,
        seed,
        beats,
        grid: built.grid,
        warp: built.warp,
        stats: built.stats,
        extBack: 0,
        extFwd: 0,
      });
      // The selection in hand is quantized to the new grid at once.
      const dur = programDuration(built.program);
      setSelection((cur) => (cur ? quantizeRange(built.grid, cur, dur) : cur));
      if (note) setStatus(note);
    })();
  }, []);

  // One effect creates the owners and one effect destroys them, so React
  // StrictMode's mount/unmount/mount leaves nothing of the first pair
  // behind: they are disposed (which stops everything and makes them
  // refuse further commands) and replaced. The hosts are built here rather
  // than memoized above so neither owner holds anything that outlives it,
  // and both read what changes through `live`.
  useEffect(() => {
    const host: TransportHost = {
      duration: () => live.current.duration,
      // The editor only renders an <audio> element once a track is open,
      // so the transport looks it up when it needs it.
      element: () => audioRef.current,
      // The FULL program: with no live graph in this path, the backend is
      // the only place tone can be applied.
      render: (start, len) => live.current.clip.previewAudio(live.current.request, start, len),
      onStatus: (s) => {
        if (!s.playing) commitTaps();
        // The live player owns the readout while a selection is armed;
        // the transport's parting status must not overwrite it.
        if (live.current.liveOn) return;
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

    const liveHost: LiveHost = {
      // The DRY span: this graph applies the tone itself.
      render: (start, len) => live.current.clip.previewAudio(live.current.dryRequest, start, len),
      duration: () => live.current.duration,
      onBuffer: (buffer, bleedAudio) => {
        setSelBuffer(buffer);
        setBleedBuffers(bleedAudio);
      },
      onStatus: (s) => {
        if (!s.playing) commitTaps();
        if (!live.current.liveOn) return;
        setPlaying(s.playing);
        setPlayhead((live.current.sel?.start ?? 0) + s.phase);
        setSelLoading(s.loading);
      },
    };
    const player = new ClipLivePlayer(liveHost, { tickMs: LOOP_TICK_MS });
    liveRef.current = player;
    return () => {
      transportRef.current = null;
      liveRef.current = null;
      transport.dispose();
      player.dispose();
    };
  }, [commitTaps]);

  // Viewport, clamped against the current duration (edits shrink clips).
  const { start: vpStart, end: vpEnd } = viewSpan(vp, duration);

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

  // Debounced preview render: the source track's peaks are the real
  // rendered output, not a client-side guess. It is the DRY render — the
  // material as it was cut — so the waveform you are editing against
  // holds still while the level automation moves. What that does to the
  // audio is
  // drawn under the selection instead.
  useEffect(() => {
    if (program.regions.length === 0 || sources.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const buckets = Math.min(
          MAX_BUCKETS,
          Math.max(MIN_BUCKETS, Math.round(programDuration(program) * PEAKS_PER_SEC)),
        );
        const out = await clip.renderPreview(dryRequest, buckets);
        if (!cancelled && out) setPreview(out);
      })();
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [clip, dryRequest, program, sources.length]);

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
        const { warp, warp_smoothing } = p;
        return edit(dropGrid(p), (t) => warpSource(warp, t, warp_smoothing));
      });
    },
    [apply],
  );

  /** Snapshot for gestures (level-point drags) that then stream edits
   *  through setProgram directly. */
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
  // The slider, the seed picker and the +/− extensions re-derive the grid
  // and warp from the session's taps and REPLACE the present program (no
  // history push): however much the correction is tuned, one undo removes
  // the whole session.
  //
  // A session is live while the GRID IT MADE is the one on the program.
  // Whole-program identity used to gate this, which quietly ended the
  // session at the first tone edit: a stray click in the automation lane
  // left the grid drawn and every one of its controls dead until the
  // next tapping pass. Tone edits do not touch
  // the grid, and the timeline edits that would invalidate it drop it
  // (`dropGrid`), so the grid IS the session's lifetime.
  const tunable = tapSession !== null && program.beat_grid === tapSession.grid;

  const regenerate = useCallback(
    (session: TapSession, tweak: TapTweak) => {
      const beats = tweak.beats ?? session.beats;
      const extBack = tweak.extBack ?? session.extBack;
      const extFwd = tweak.extFwd ?? session.extFwd;
      // Re-derived against the PRESENT program, so tone edits made since
      // the taps survive a tune of the correction.
      const built = sessionProgram({
        base: session.base,
        present: program,
        beats,
        rawTaps: session.rawTaps,
        oneTaps: session.oneTaps,
        sectionBeats: tweak.sectionBeats ?? sectionBeats,
        smoothing: tweak.smoothing ?? smoothing,
        extBack,
        extFwd,
      });
      if (!built) return;
      setProgram(built.program);
      setTapSession({
        ...session,
        seed: tweak.seed ?? session.seed,
        beats,
        extBack,
        extFwd,
        grid: built.grid,
        warp: built.warp,
        stats: built.stats,
      });
    },
    [program, sectionBeats, smoothing],
  );

  const retime = useCallback(
    (beats: number) => {
      setSectionBeats(beats);
      if (tunable && tapSession) regenerate(tapSession, { sectionBeats: beats });
    },
    [regenerate, tapSession, tunable],
  );

  const smooth = useCallback(
    (ease: number) => {
      setSmoothing(ease);
      if (tunable && tapSession) regenerate(tapSession, { smoothing: ease });
    },
    [regenerate, tapSession, tunable],
  );

  const extend = useCallback(
    (edge: 'back' | 'fwd', by: 1 | -1) => {
      if (!tunable || !tapSession) return;
      regenerate(tapSession, {
        extBack: tapSession.extBack + (edge === 'back' ? by : 0),
        extFwd: tapSession.extFwd + (edge === 'fwd' ? by : 0),
      });
    },
    [regenerate, tapSession, tunable],
  );

  /** Overrule the seed the taps chose: the same span, heard by another
   *  checkpoint. Every hearing came back with the measurement, so this
   *  costs no second tracker run — and it stays ONE undo step. */
  const pickSeed = useCallback(
    (seed: string) => {
      if (!tunable || !tapSession) return;
      const heard = tapSession.seeds.find((s) => s.seed === seed);
      if (!heard) return;
      regenerate(tapSession, { seed, beats: heard.times });
    },
    [regenerate, tapSession, tunable],
  );

  /** Open a track: the page edits ONE source, so this starts the edit
   *  over rather than adding a lane to the one in hand. */
  const loadTrack = useCallback(
    async (trackId: number, stemsWanted = stemSet(stemsOn)) => {
      const stems = stemsWanted;
      setBusy(true);
      setError(null);
      try {
        const source = await clip.loadSource(trackId, stems, MIN_BUCKETS);
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
        setSources([source]);
        setProgram(appendSource(emptyProgram(), 0, source.duration_secs));
        setPast([]);
        setFuture([]);
        setSelection(null);
        setTapSession(null);
        setVp(null);
        // A new source is a new clip: saves stop going back to whatever
        // was filed from the last one.
        setEditing(null);
        setUnopenable(null);
        // A different program entirely: stop, don't play the old render.
        transportRef.current?.stop(0);
        setName(stems.length ? `${source.title} (${stemLabel(stems)})` : `${source.title} (clip)`);
      } finally {
        setBusy(false);
      }
    },
    [clip, stemsOn],
  );

  /** Flip one stem of the picked track on or off.
   *
   *  The change lands on the audio straight away — swapping the loaded
   *  lane for the new mix — rather than waiting for another Open. Stems
   *  are the same length as the track they came from, so the edit itself
   *  (regions, level) survives untouched: only what those regions are
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
      seek(target);
    },
    [applyTimeline, seek],
  );

  // --- level automation lane -------------------------------------------
  //
  // The lane lives UNDER THE SELECTION, not under the source track: a
  // fade is drawn against the span you are auditioning, at the zoom that
  // span already gives you, and the audio follows the drag live. Its
  // x-axis is therefore the selection's, and the breakpoints it writes
  // are still absolute output-timeline times — automation belongs to the
  // edit, not to the window you happened to be looking through.
  const laneRef = useRef<SVGSVGElement | null>(null);
  const dragBase = useRef<ClipProgram | null>(null);
  const [dragPoint, setDragPoint] = useState(false);

  const laneTimeAt = useCallback(
    (clientX: number, rect: DOMRect | null) => {
      if (!rect || rect.width <= 0 || !laneRange) return 0;
      const frac = (clientX - rect.left) / rect.width;
      return laneRange.start + Math.min(1, Math.max(0, frac)) * (laneRange.end - laneRange.start);
    },
    [laneRange],
  );

  const addLevelPoint = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      if (duration <= 0 || !sel) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const t = laneTimeAt(e.clientX, rect);
      const y = ((e.clientY - rect.top) / (rect.height || LEVEL_H)) * LEVEL_H;
      apply((p) => setLevelPoint(p, t, Math.round(levelDbFromY(y) * 10) / 10));
    },
    [apply, duration, laneTimeAt, sel],
  );

  useEffect(() => {
    if (!dragPoint) return;
    const move = (e: MouseEvent) => {
      const rect = laneRef.current?.getBoundingClientRect();
      const base = dragBase.current;
      if (!rect || rect.width <= 0 || !base) return;
      const t = laneTimeAt(e.clientX, rect);
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
  }, [dragPoint, laneTimeAt]);

  // Opening from the Library page. An edit that has been touched but not
  // saved would be lost, so that case asks first — the source track is
  // never written, so the only thing at stake is the editing itself.
  const openFromLibrary = useCallback(
    (trackId: number) => {
      setPendingOpen(null);
      setPick(trackId);
      setStemChoice({ trackId, on: [...STEM_NAMES] });
      void loadTrack(trackId, []);
    },
    [loadTrack],
  );

  /** Open a SAVED beat clip: put its edit back on the page and aim the
   *  save row at it. The sources come back as library track ids resolved
   *  from the hashes the clip filed, so a re-imported track still opens;
   *  a clip that names one the library has lost — or that was filed
   *  before clips carried their edit — shows its problem instead of an
   *  editor, because there is nothing here to cut. */
  const openSavedClip = useCallback(
    async (clipId: string) => {
      setBusy(true);
      setError(null);
      setStatus(null);
      try {
        const open = await clip.openBeatClip(clipId);
        if (!open) {
          logError('clip.openBeatClip', `could not open beat clip ${clipId}`);
          setError('Could not open that beat clip');
          return;
        }
        if (open.problem || !open.program) {
          setUnopenable({
            name: open.name,
            problem: open.problem ?? 'this clip records no edit to open',
          });
          return;
        }
        const loaded = await Promise.all(
          open.sources.map((s) => clip.loadSource(s.track_id, s.stems, MIN_BUCKETS)),
        );
        if (loaded.some((s) => !s)) {
          setUnopenable({
            name: open.name,
            problem: 'one of the tracks this clip was cut from could not be decoded',
          });
          return;
        }
        transportRef.current?.stop(0);
        setUnopenable(null);
        setSources(loaded as ClipSource[]);
        setProgram(open.program);
        setPast([]);
        setFuture([]);
        setTapSession(null);
        setVp(null);
        setSelection({ start: open.startSecs, end: open.endSecs });
        bleedEdges.current = { start: open.startSecs, end: open.endSecs };
        setBleed({ left: open.leftBleedMs, right: open.rightBleedMs });
        setName(open.name);
        setEditing({ clipId: open.clipId });
        const first = open.sources[0];
        if (first) {
          setPick(first.track_id);
          setStemChoice({
            trackId: first.track_id,
            on: first.stems.length > 0 ? [...first.stems] : [...STEM_NAMES],
          });
        }
        setStatus(`Editing the beat clip “${open.name}” — saving files it back`);
      } finally {
        setBusy(false);
      }
    },
    [clip],
  );

  const dirtyEdit = past.length > 0 && program.regions.length > 0;
  useImperativeHandle(
    ref,
    () => ({
      open: (trackId: number) => {
        if (dirtyEdit) setPendingOpen(trackId);
        else openFromLibrary(trackId);
      },
      openClip: (clipId: string) => void openSavedClip(clipId),
    }),
    [dirtyEdit, openFromLibrary, openSavedClip],
  );

  // --- playback: commands -------------------------------------------------
  //
  // A SELECTION ALWAYS LOOPS: choosing a span is asking to hear it round
  // and round while you shape it, so there is nothing to arm. The Loop
  // button is left for the case it is still a question — the whole clip,
  // with nothing selected.
  const loopRange = useMemo(
    () => sel ?? (loop && duration > 0 ? { start: 0, end: duration } : null),
    [loop, sel, duration],
  );

  const togglePlay = useCallback(() => {
    if (liveOn) {
      const player = liveRef.current;
      if (!player) return;
      if (player.playing) player.pause();
      else player.play();
      return;
    }
    const transport = transportRef.current;
    if (!transport) return;
    if (transport.playing) transport.pause();
    else transport.play(transport.playhead, loopRange);
  }, [liveOn, loopRange]);

  const stop = useCallback(() => {
    if (liveOn) {
      liveRef.current?.stop();
      setPlayhead(sel?.start ?? 0);
      return;
    }
    transportRef.current?.stop(sel ? sel.start : 0);
  }, [liveOn, sel]);

  // WHO PLAYS WHAT, in one place. Arming a selection hands playback to
  // the live player; clearing it hands playback back to the source
  // track. The one being handed to starts stopped and at the playhead the
  // other left behind, and the one handed from is stopped FIRST — that
  // ordering is what keeps two sources from ever sounding at once.
  const liveWasOn = useRef(false);
  /** Tone changed while the live graph owned playback: the transport's
   *  loaded window predates it. */
  const toneDirty = useRef(false);
  useEffect(() => {
    const player = liveRef.current;
    const transport = transportRef.current;
    if (liveOn === liveWasOn.current) return;
    liveWasOn.current = liveOn;
    if (liveOn) {
      // Sweeping a span WHILE the clip plays drops straight into
      // looping it; sweeping one in silence stays silent.
      const wasPlaying = transport?.playing ?? false;
      transport?.pause();
      if (wasPlaying) player?.play();
      else player?.publish();
    } else {
      // Handing back PARKS rather than resumes: clearing a selection is
      // not a request to hear the whole clip, and this is also the path
      // an "open another track" takes. What the live player decoded is
      // left alone rather than cleared — the pane below reads it only
      // while the live graph owns playback.
      player?.pause();
      // Tone the transport never saw (it was applied live) makes the
      // window it is holding wrong: drop it so the next play renders.
      if (toneDirty.current) transport?.invalidate();
      toneDirty.current = false;
      // Re-publish the source track's own playhead: it is where the
      // transport was left, which is not where the selection got to (and
      // this path is also how "open another track" lands).
      transport?.publish();
    }
  }, [liveOn]);

  // The selection IS the live player's span: moving an edge re-fetches
  // that stretch (and only that stretch).
  useEffect(() => {
    if (!liveOn || !sel) return;
    liveRef.current?.setSpan(sel.start, sel.end);
  }, [liveOn, sel]);

  // The bookends are AUDITIONED, not just filed: the live loop plays the
  // bleed over its seam, so a millisecond typed here is heard on the next
  // pass and can be dialled in by ear.
  useEffect(() => {
    liveRef.current?.setBleed(bleed.left, bleed.right);
  }, [bleed]);

  // A BLEED BELONGS TO THE EDGE IT WAS DIALLED AT. Move that edge and the
  // material behind it is different audio, so the milliseconds set by ear
  // no longer mean anything: each side resets when — and only when — its
  // own edge moves. `bleedEdges` is written by whoever else sets the two
  // together (opening a saved clip), so a restored bleed is not read as a
  // moved edge.
  useEffect(() => {
    const prev = bleedEdges.current;
    const now = sel ? { start: sel.start, end: sel.end } : null;
    bleedEdges.current = now;
    if (!prev || !now) return;
    const left = Math.abs(prev.start - now.start) > 1e-6;
    const right = Math.abs(prev.end - now.end) > 1e-6;
    if (!left && !right) return;
    setBleed((b) =>
      (left && b.left !== 0) || (right && b.right !== 0)
        ? { left: left ? 0 : b.left, right: right ? 0 : b.right }
        : b,
    );
  }, [sel]);

  // TONE IS NOT A RENDER. Level goes straight into the running graph
  // — no fetch, no gap, and the drag that produced them is still under
  // the user's finger.
  useEffect(() => {
    liveRef.current?.setEq(program.eq.bands);
  }, [program.eq]);

  useEffect(() => {
    liveRef.current?.setLevel(program.level);
  }, [program.level]);

  // The PICTURE of the live audio: the decoded selection re-rendered
  // through the same tone stage offline, so the waveform under the
  // knob is what the knob is doing. Debounced, because only the drawing
  // has to wait — the audio changed the moment the band moved.
  useEffect(() => {
    if (!liveOn || !selBuffer || !sel) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        // Every piece is drawn from ITS OWN place on the timeline: the
        // loop from the span's start, each bookend from where its
        // material was cut. A bookend's level is therefore its own, and
        // the picture says so before the ear does.
        const buckets = (secs: number) =>
          Math.max(MIN_BLEED_BUCKETS, Math.round((SEL_BUCKETS * secs) / (sel.end - sel.start)));
        const piece = (buffer: AudioBuffer | null, window: BleedWindow | null) =>
          buffer && window
            ? tonePeaks(buffer, program.eq.bands, program.level, window.start, buckets(window.len))
            : Promise.resolve(null);
        const [loop, left, right] = await Promise.all([
          tonePeaks(selBuffer, program.eq.bands, program.level, sel.start, SEL_BUCKETS),
          piece(bleedBuffers.left, bleedWin.left),
          piece(bleedBuffers.right, bleedWin.right),
        ]);
        // Null where the runtime has no OfflineAudioContext: the pane
        // keeps drawing the dry material, which is better than nothing.
        if (!cancelled && loop) {
          setSelPeaks({ loop, left: left ?? [], right: right ?? [] });
        }
      })();
    }, SEL_PEAKS_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [liveOn, selBuffer, bleedBuffers, program.eq, program.level, sel, bleedWin]);

  // An edit makes the fetched audio stale. What that costs playback
  // depends on WHAT changed:
  //
  // - the TIMELINE (regions/crossfade/warp): every output time
  //   now means something else, so the transport stops rather than play
  //   the old render (the live player re-fetches its span instead);
  // - the MATERIAL (a stem switched): the timeline still means what it
  //   meant, so re-render in place and swap — a stem toggle used to stop
  //   playback dead and wait for a press of ▶;
  // - TONE (level): nothing to do here at all where the live graph
  //   owns playback. Only the fallback path re-renders for it.
  const lastRequest = useRef(dryRequest);
  useEffect(() => {
    const prev = lastRequest.current;
    // Unrelated state moved (selection, zoom, …): leave any pending
    // re-render alone rather than re-arming its timer.
    if (prev === dryRequest) return;
    lastRequest.current = dryRequest;
    const timelineChanged =
      prev.program.regions !== dryRequest.program.regions ||
      prev.program.crossfade_ms !== dryRequest.program.crossfade_ms ||
      prev.program.warp !== dryRequest.program.warp ||
      prev.program.warp_smoothing !== dryRequest.program.warp_smoothing;
    const sourcesChanged = prev.sources !== dryRequest.sources;
    if (timelineChanged || sourcesChanged) liveRef.current?.refresh();
    if (timelineChanged) transportRef.current?.invalidate();
    else if (sourcesChanged) transportRef.current?.refreshMaterial();
  }, [dryRequest]);

  // With no live graph in the path, tone is still something the backend
  // has to bake in: re-render the playing window, debounced, without
  // stopping (pausing for a level tweak makes the control useless).
  const lastTone = useRef(request.program);
  useEffect(() => {
    const prev = lastTone.current;
    if (prev === request.program) return;
    lastTone.current = request.program;
    if (prev.eq === request.program.eq && prev.level === request.program.level) return;
    // Live: the graph has it already, but the transport's window is now
    // audio nobody asked for — remember to throw it away at the handover.
    if (liveOn) toneDirty.current = true;
    else transportRef.current?.refreshTone();
  }, [liveOn, request.program]);

  // Keep the fallback path's loop in step with the selection, so it
  // follows its edges live instead of looping the old span.
  useEffect(() => {
    transportRef.current?.setLoop(loopRange);
  }, [loopRange]);

  // Leaving the page pauses (its shortcuts detach with it).
  useEffect(() => {
    if (!active) {
      transportRef.current?.pause();
      liveRef.current?.pause();
    }
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
      } else if ((e.code === 'ShiftRight' || e.code === 'ShiftLeft') && !e.repeat) {
        // A beat, tapped at the playhead — during playback only, and read
        // LIVE off the sounding source (whichever owns it): the status
        // playhead only advances on a tick, far too coarse for a tapped
        // beat. LEFT shift is the same gesture for a ONE: it is kept in
        // its own list and never becomes a beat, since the beat it means
        // is whichever right-shift tap it landed nearest.
        const player = liveRef.current;
        const transport = transportRef.current;
        const at =
          liveOn && sel && player?.playing
            ? sel.start + player.phase()
            : !liveOn && transport?.playing
              ? (transport.position() ?? transport.playhead)
              : null;
        if (at !== null) {
          if (e.code === 'ShiftRight') {
            tapRun.current = [...tapRun.current, at];
            setTaps(tapRun.current);
          } else {
            oneRun.current = [...oneRun.current, at];
            setOneTaps(oneRun.current);
          }
        }
      } else if (!mod && e.key === 'Escape') {
        // Clicking no longer drops the selection, so this is the way out
        // of one.
        setSelection(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, liveOn, redo, sel, togglePlay, undo]);

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
          const beats = await clip.detectBeats(dryRequest, start, end);
          if (!cancelled) setDetected({ request: dryRequest, start, end, beats });
        } finally {
          if (!cancelled) setDetecting(false);
        }
      })();
    }, detectDelayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, clip, detectDelayMs, disabled, dryRequest, grid, range]);

  /** The measurement, only if it still describes the span being saved. */
  const measured =
    detected &&
    detected.request === dryRequest &&
    detected.start === range.start &&
    detected.end === range.end
      ? detected.beats
      : null;

  /** BPM + whole beats for the span: the tapped grid's when there is
   *  one, the tracker's otherwise. `padded` says the span was fractional
   *  and the last beat will be filled with silence. Against a grid the
   *  count comes from its ACTUAL beats (`beatSpan`) — a selection
   *  quantized to two beats IS two, even where flam makes its seconds
   *  run a hair long — and the save sends this count, so the clip filed
   *  is the clip the page showed.
   *
   *  The rounding is deliberately blunt: a hundredth of a beat is far
   *  below anything anyone chose, so a span that is four beats bar a
   *  float's worth of error is FOUR, not five padded with silence. */
  const tempo = useMemo(() => {
    const span = range.end - range.start;
    if (span <= 0) return null;
    const of = (bpm: number, beatsF: number) => {
      const beats = Math.max(1, Math.ceil(beatsF - BEAT_EPS));
      return { bpm, beats, padded: beats - beatsF > BEAT_EPS };
    };
    if (grid) return of(grid.bpm, beatSpan(grid, range.start, range.end));
    return measured ? of(measured.bpm, (span * measured.bpm) / 60) : null;
  }, [grid, measured, range]);

  /** File the span: OVER the clip this page is editing, or as a new one.
   *  Overwriting is only offered once there is something to overwrite,
   *  and either way the page ends up bound to what it filed. */
  const save = useCallback(
    async (overwrite: boolean) => {
      if (!tempo) return;
      setBusy(true);
      setError(null);
      setStatus(null);
      setFiled(null);
      try {
        const saved = await clip.saveBeatClip(
          request,
          name,
          range.start,
          range.end,
          tempo.bpm,
          tempo.beats,
          bleed.left,
          bleed.right,
          overwrite ? (editing?.clipId ?? null) : null,
        );
        if (saved) {
          // The page now works ON the clip it filed: saving again can
          // revise it, until a different track is picked up top.
          setEditing({ clipId: saved.id });
          setFiled({ request, name, range, bleed });
        }
      } finally {
        setBusy(false);
      }
    },
    [bleed, clip, editing, name, range, request, tempo],
  );

  /** Is what the page holds now exactly what the last save filed? */
  const savedNow =
    filed !== null &&
    filed.request === request &&
    filed.name === name &&
    filed.range === range &&
    filed.bleed === bleed;

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
  const peaks = useMemo(() => preview?.peaks ?? [], [preview]);
  /** Can the picked track be loaded stem by stem right now? */
  const stemsReady = picked?.state === 'ready';

  /** WHAT THE SPAN IS, in one line over the pane: the beats it will be
   *  filed as, its length, its ends and its tempo. The count is `tempo`'s
   *  — the very number the save sends — so the page cannot show one beat
   *  count here and file another. Its length and ends are known whatever
   *  the tempo is, and are written even while that is being measured. */
  const selHeading = sel ? (
    <>
      {tempo ? `Selected ${tempo.beats} ${tempo.beats === 1 ? 'beat' : 'beats'} · ` : ''}
      {`${timecode(sel.end - sel.start)} · ${timecode(sel.start)}–${timecode(sel.end)} · `}
      {tempo ? (
        <>
          {`${fixed(tempo.bpm, 1)} bpm`}
          {grid ? '' : ' (measured)'}
          {tempo.padded && (
            <span
              className="clip-sel-padded"
              title="the span is fractional: the last beat is filled with silence"
            >
              {' '}
              last beat filled with silence
            </span>
          )}
        </>
      ) : detecting ? (
        'measuring the tempo…'
      ) : (
        'no tempo yet — tap beats with right-shift during playback'
      )}
    </>
  ) : null;

  /** The grid drawn ON the selection: the beats (and ones) inside the
   *  pane's window, bookends included, so the picture of the result is
   *  read against the same grid the source track above is cut on. */
  const selBeats = useMemo(
    () => (grid && laneRange ? gridBeatTimes(grid, laneRange.start, laneRange.end) : undefined),
    [grid, laneRange],
  );
  const selOnes = useMemo(
    () => (grid && laneRange ? gridOneTimes(grid, laneRange.start, laneRange.end) : undefined),
    [grid, laneRange],
  );

  /** The selection pane's x-mapping: the span AND its bookends fill the
   *  pane, so the level lane under it lines up with the waveform piece
   *  for piece — including over the bleed, which is the only way a point
   *  can be dropped on a bookend and mean that bookend. */
  const laneXOf = (secs: number) =>
    laneRange && laneRange.end > laneRange.start
      ? ((secs - laneRange.start) / (laneRange.end - laneRange.start)) * W
      : 0;

  /** Source-track peaks over an output-timeline window: the picture the
   *  pane falls back to until the live graph has drawn its own. */
  const windowPeaks = useCallback(
    (from: number, to: number) => {
      if (duration <= 0 || peaks.length === 0 || to <= from) return [];
      const a = Math.max(0, Math.floor((from / duration) * peaks.length));
      const b = Math.min(peaks.length, Math.ceil((to / duration) * peaks.length));
      return peaks.slice(a, Math.max(a + 1, b));
    },
    [duration, peaks],
  );

  /** What the selection pane draws: the toned peaks when the live graph
   *  has computed them, the source track's own peaks over each piece
   *  until it has (a picture arriving a moment late beats an empty one). */
  const selPeaksShown = useMemo<PiecePeaks>(() => {
    if (liveOn && selPeaks) return selPeaks;
    if (!sel) return { loop: [], left: [], right: [] };
    return {
      loop: windowPeaks(sel.start, sel.end),
      left: bleedWin.left ? windowPeaks(bleedWin.left.start, sel.start) : [],
      right: bleedWin.right ? windowPeaks(sel.end, bleedWin.right.start + bleedWin.right.len) : [],
    };
  }, [liveOn, selPeaks, sel, bleedWin, windowPeaks]);

  /** One BOOKEND of the selection: how many milliseconds of the material
   *  beyond that edge ride with the clip as bleed. Not an edit — nothing
   *  about the program moves, so it sits outside the undo stacks — but
   *  the live loop lays it over the seam, so it is set by ear. */
  const bleedBookend = (side: 'left' | 'right') => (
    <label
      className={`clip-bleed clip-bleed-${side}`}
      title={
        side === 'left'
          ? 'Left bleed: milliseconds from BEFORE the selection, laid over the END of the loop so it leans into the next pass — skipped on the last pass (a dropped deck)'
          : 'Right bleed: milliseconds from AFTER the selection, laid over the START of the loop so a pass carries the last one\u2019s tail — skipped the first time it plays'
      }
    >
      <input
        type="number"
        min={0}
        step={5}
        data-testid={`clip-bleed-${side}`}
        value={bleed[side]}
        onChange={(e) =>
          setBleed({ ...bleed, [side]: Math.max(0, Math.round(Number(e.target.value) || 0)) })
        }
      />
      <span>ms</span>
    </label>
  );

  /** Level automation, drawn against the SELECTION AND ITS BOOKENDS —
   *  the same three pieces the waveform above shows, so one point-and-
   *  click lane levels the bleed start, the loop and the bleed end
   *  independently: they are different stretches of the timeline, and a
   *  breakpoint belongs to whichever it lands in, however they overlap
   *  when played. Points beyond all three are still in the program (and
   *  still heard) — they belong to a stretch this pane is not showing. */
  const levelLane = laneRange ? (
    <svg
      ref={laneRef}
      data-testid="clip-level-lane"
      className="clip-level-lane"
      viewBox={`0 0 ${W} ${LEVEL_H}`}
      preserveAspectRatio="none"
      onMouseDown={addLevelPoint}
    >
      {/* Where the loop begins and ends, so it is plain which piece a
          point is being dropped on. */}
      {sel && (bleedLeftSecs > 0 || bleedRightSecs > 0)
        ? [sel.start, sel.end].map((t, i) => (
            <line
              key={i}
              className="clip-sel-seam"
              x1={laneXOf(t)}
              x2={laneXOf(t)}
              y1={0}
              y2={LEVEL_H}
            />
          ))
        : null}
      <polyline
        className="clip-level-line"
        data-testid="clip-level-line"
        points={[
          laneRange.start,
          ...program.level
            .map((p) => p.time_secs)
            .filter((t) => t > laneRange.start && t < laneRange.end),
          laneRange.end,
        ]
          .map((t) => `${laneXOf(t)},${levelY(levelDbAt(program.level, t))}`)
          .join(' ')}
      />
      {program.level.map((p, i) =>
        p.time_secs >= laneRange.start - 1e-6 && p.time_secs <= laneRange.end + 1e-6 ? (
          <circle
            key={`${p.time_secs}:${i}`}
            data-testid={`clip-level-point-${i}`}
            className="clip-level-point"
            cx={laneXOf(p.time_secs)}
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
        ) : null,
      )}
    </svg>
  ) : null;

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
          onClick={() => pick !== null && void loadTrack(pick)}
        >
          Open
        </button>
        <span className="clip-sources" data-testid="clip-sources">
          {sources.map((s, i) => (
            <span
              className="tag tag-source"
              key={`${s.track_id}:${s.stems.join('+') || 'mix'}:${i}`}
            >
              {sourceLabel(s)}
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
        {stemsReady ? null : picked?.state === 'loading' ? (
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

      {unopenable ? (
        <p className="clip-empty" data-testid="clip-unopenable">
          “{unopenable.name}” cannot be edited: {unopenable.problem} Open a track above to start a
          new clip.
        </p>
      ) : disabled ? (
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
            loop={loop || sel !== null}
            onTogglePlay={togglePlay}
            onStop={stop}
            onToggleLoop={() => setLoop((v) => !v)}
            onSeek={seek}
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
                {tunable &&
                  tapSession &&
                  stretchBands(tapSession.warp).map((b, i) => (
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
                {grid &&
                  gridOneTimes(grid, vpStart, vpEnd).map((t, i) => (
                    <line
                      key={`one${i}`}
                      data-testid="clip-one-line"
                      className="clip-one-line"
                      x1={xOf(t)}
                      x2={xOf(t)}
                      y1={0}
                      y2={WAVE_H}
                    >
                      <title>the one</title>
                    </line>
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
                {oneTaps.map((t, i) => (
                  <line
                    key={`onetap${i}`}
                    data-testid="clip-one-tap-line"
                    className="clip-one-line"
                    x1={xOf(t)}
                    x2={xOf(t)}
                    y1={0}
                    y2={WAVE_H}
                  />
                ))}
              </>
            )}
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
              <label className="clip-grid-section">
                <span>Smooth</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={SMOOTHING_STEP}
                  data-testid="clip-grid-smooth"
                  disabled={!tunable}
                  value={smoothing}
                  onChange={(e) => smooth(Number(e.target.value))}
                  title="How much each correction eases in and out across its section instead of changing rate at the boundary"
                />
                <span data-testid="clip-grid-smooth-readout">
                  {smoothing <= 0 ? 'hard' : `${Math.round(smoothing * 100)}%`}
                </span>
              </label>
              {tunable && tapSession && tapSession.seeds.length > 0 && (
                <label className="clip-grid-seed">
                  <span>Seed</span>
                  <select
                    data-testid="clip-grid-seed"
                    value={tapSession.seed ?? ''}
                    onChange={(e) => pickSeed(e.target.value)}
                    title="Which of the tracker's hearings the grid is built from — the one your taps fit best is chosen for you"
                  >
                    {tapSession.seeds.map((s) => (
                      <option key={s.seed} value={s.seed}>
                        {s.seed} · {fixed(s.bpm, 1)} BPM · fit {Math.round(s.fit * 100)}%
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {tunable && tapSession && (
                <span
                  className="clip-grid-stats"
                  data-testid="clip-grid-stats"
                  title="max/average, over the tapped span: flam is how far a beat sits from its ideal slot, stretch how much a correction section moves the audio, tap miss how far your taps landed from the beats the grid chose"
                >
                  {statsLine(tapSession.stats)}
                </span>
              )}
            </div>
          )}

          <hr className="clip-rule" />

          {/* THE LIVE HALF. The source track above is the reference and
              never moves under a tone edit; this is the selection as it
              actually sounds — stems and automation on it, looping, and
              updating under the hand rather than after it. */}
          {sel ? (
            <ClipSelectionPane
              span={sel}
              peaks={selPeaksShown.loop}
              bleed={
                bleedLeftSecs > 0 || bleedRightSecs > 0
                  ? {
                      left: { secs: bleedLeftSecs, peaks: selPeaksShown.left },
                      right: { secs: bleedRightSecs, peaks: selPeaksShown.right },
                    }
                  : undefined
              }
              beats={selBeats}
              ones={selOnes}
              waveHeight={SEL_WAVE_H}
              playing={playing}
              playhead={playhead}
              loading={selLoading}
              onTogglePlay={togglePlay}
              onSeek={seek}
              timecode={timecode}
              levelLane={levelLane}
              bookends={{ left: bleedBookend('left'), right: bleedBookend('right') }}
              title={selHeading}
              actions={
                <button
                  data-testid="clip-clear-level"
                  disabled={program.level.length === 0}
                  onClick={() => apply(clearLevel)}
                >
                  Clear automation
                </button>
              }
            />
          ) : (
            <p className="clip-sel-empty" data-testid="clip-selection-empty">
              Sweep the source track to pick a span: it loops here with the stems and level
              automation on it, live, while the track above stays as it was cut.
            </p>
          )}

          <div className="clip-save">
            <label>
              <span>Name</span>
              <input
                data-testid="clip-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {/* Overwrite is only there once there is something to
                overwrite: the clip this page filed (or opened). */}
            {editing && (
              <button
                className="clip-save-button"
                data-testid="clip-save"
                disabled={busy || name.trim() === '' || !tempo}
                title="Save over the clip this page is editing"
                onClick={() => void save(true)}
              >
                Overwrite
              </button>
            )}
            <button
              className="clip-save-button"
              data-testid="clip-save-new"
              disabled={busy || name.trim() === '' || !tempo}
              title="File this span as a new beat clip"
              onClick={() => void save(false)}
            >
              Create new
            </button>
            {savedNow && (
              <span className="clip-save-done" data-testid="clip-save-done" title="Saved">
                ✓
              </span>
            )}
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
