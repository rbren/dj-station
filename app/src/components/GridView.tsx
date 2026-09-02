// The Grid page: a DAW-style arrangement of beat clips.
//
// One row per loaded clip, grouped by the TRACK the clips were cut from —
// the group's title is said once, above its rows, because "which song is
// this" is asked of a block of rows, not of each of them. Every column is
// one beat of the grid, and the grid is as long as you make it.
//
// PLACING. A row arrives EMPTY: loading a clip says which material the
// row can play, not when it plays. Clicking a cell places the clip with
// its FIRST ONE on that column — a 4-beat clip whose one is beat 2,
// clicked at column 10, fills 9..12 — so what you aim at is the downbeat,
// which is the beat you actually hear land. Clicking a filled cell takes
// that copy away again. A placed clip is drawn as ONE BLOCK: its own
// waveform behind it, its ones marked, rounded only at its two ends,
// because a clip is a thing and not four adjacent things.
//
// TEMPO is master automation over the same columns (`AutomationLane`,
// the Clip page's level-lane control), and each row carries a LEVEL LINE
// through its middle — cmd/ctrl+click writes a point on it. Both are
// envelopes: the tempo one is integrated for every beat->time conversion
// below, so a ramp plays in tune with the grid rather than drifting.
//
// PLAYBACK is the webview's, not the engine's (`GridTransport`), and the
// grid stays LIVE while it sounds: placing a clip mid-play is heard on
// its next beat. Dragging across the ruler marks a loop and CLICKING it
// puts the playhead there; dragging across the cells marks a selection of
// any n x m rectangle, which copies and pastes at the playhead. Both
// drags belong to the WINDOW, so a pointer that wanders off the strip or
// off the row it started on keeps the gesture it began.
//
// Right-clicking the ruler with a loop marked opens the beat surgery the
// loop's span defines (insert / copy / delete N beats), and every edit on
// the page — placement, level, tempo, loop, surgery, the header's fields
// — goes through one recorded setter, so cmd+Z takes back whatever it was
// (`gridHistory`).

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import { beatClip as defaultClips, type BeatClipApi, type BeatClipEntry } from '../beatClip';
import { MAX_BPM, MIN_BPM } from '../decks';
import { fixed } from '../format';
import { isEditableTarget } from '../fileShortcuts';
import {
  addRow,
  cellKind,
  clampBpm,
  clearRow,
  copyBeats,
  copySelection,
  deleteBeats,
  deleteSelection,
  emptyGrid,
  fillSelection,
  fromDocument,
  gridColumns,
  groupRows,
  inRange,
  insertBeats,
  isEmptyGrid,
  leadOne,
  loopFromDrag,
  moveLevelPoint,
  moveSelection,
  moveTempoPoint,
  pasteAt,
  placeClip,
  placementAt,
  placementSpan,
  playRange,
  rangeSecs,
  removeLevelPoint,
  removeRow,
  removeTempoPoint,
  selectionFor,
  selectionFromDrag,
  setLevelPoint,
  setTempoPoint,
  toDocument,
  clampBar,
  MAX_BAR,
  MAX_LEVEL,
  MIN_BAR,
  type ColumnRange,
  type GridClipboard,
  type GridRow,
  type GridSelection,
  type GridState,
} from '../grid';
import {
  canRedo,
  canUndo,
  endGesture,
  initHistory,
  record,
  redo as redoHistory,
  undo as undoHistory,
} from '../gridHistory';
import { fxOrDefault, isTrackFxModified, type TrackFx } from '../gridFx';
import { GridTransport } from '../gridTransport';
import { AutomationLane, type LanePoint } from './AutomationLane';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { GridClipPicker } from './GridClipPicker';
import { GridFxModal } from './GridFxModal';

/** Column width in px at 1×. The grid zooms about this. */
export const GRID_CELL_W = 22;
export const GRID_LANE_H = 96;

/** How far the grid can be zoomed, as a multiple of `GRID_CELL_W`. Out
 *  far enough to see an arrangement whole, in far enough to place a clip
 *  against a beat without squinting. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
/** A notch of the wheel — 100 units of `deltaY` — is this much zoom. The
 *  buttons and the keys step by exactly one notch. */
const ZOOM_STEP = 1.15;
export const ZOOM_NOTCH = 100;
/** Zoom is CONTINUOUS in the wheel's delta, not one step per event: a
 *  trackpad sends a stream of small deltas and stepping each of them made
 *  the zoom lurch a notch at a time. The rate is set so a full notch
 *  still lands on `ZOOM_STEP`, which is what the buttons and keys use. */
const ZOOM_RATE = Math.log(ZOOM_STEP) / ZOOM_NOTCH;

/** Zoom moved by `deltaY` of wheel (negative zooms in). */
export function zoomBy(zoom: number, deltaY: number): number {
  const next = zoom * Math.exp(-deltaY * ZOOM_RATE);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
}

/** Shared so a row with no peaks yet keeps the SAME array between
 *  renders: a fresh `[]` would be a new prop and would defeat the memo. */
const EMPTY_PEAKS: readonly number[] = [];

/** The CSS custom property one beat's width is published as.
 *
 *  ZOOM IS A CSS VARIABLE, not a prop. Everything laid out on the grid
 *  measures itself in beats through `beatsWide`, so a zoom changes ONE
 *  declaration on the lanes container and the browser re-lays the whole
 *  grid out itself — no row re-renders, which is what turned zooming from
 *  a stutter into a smooth thing at fifty rows. */
export const CELL_W_VAR = '--grid-cell-w';

/** `n` beats, as a CSS length that follows the zoom. */
export function beatsWide(n: number): string {
  return `calc(var(${CELL_W_VAR}) * ${n})`;
}

/** How many beats the rendered window is snapped out to.
 *
 *  ONLY WHAT IS ON SCREEN IS IN THE DOM. A set is a few hundred beats and
 *  fifty rows, which is tens of thousands of cells — enough that the
 *  webview stops scrolling on the compositor and repaints the lot every
 *  frame, which is exactly what a janky horizontal scroll is. The window
 *  is rounded out to whole blocks and carries a block of slack on each
 *  side, so scrolling costs nothing at all until it crosses a boundary,
 *  and there is always a block of grid drawn past the edge of the view to
 *  scroll into. */
export const WINDOW_BLOCK = 32;

/** The columns worth drawing: what a scrollport `width` px wide, scrolled
 *  to `scroll`, has on screen at `cellW` a beat — rounded out to blocks.
 *
 *  The gutter is pinned over the first ~200 px of the scrollport, so the
 *  beat at `scroll / cellW` is the leftmost one anybody can see and the
 *  right edge is an over-estimate by the gutter's width. A width of 0 is
 *  a box nothing has measured yet (the first render, or jsdom): the whole
 *  grid is drawn rather than nothing at all. */
export function columnWindow(
  scroll: number,
  width: number,
  cellW: number,
  columns: number,
): ColumnRange {
  if (width <= 0 || cellW <= 0) return { start: 0, end: columns };
  const first = Math.floor(Math.max(0, scroll) / cellW / WINDOW_BLOCK) - 1;
  const last = Math.ceil((Math.max(0, scroll) + width) / cellW / WINDOW_BLOCK) + 1;
  return {
    start: Math.max(0, first * WINDOW_BLOCK),
    end: Math.min(columns, last * WINDOW_BLOCK),
  };
}

/** The beat under the pointer and where to keep it, for a zoom about
 *  that point. Measured against the RULER, which scrolls with the
 *  content: its left edge IS beat 0, wherever the grid has been scrolled
 *  to. `x` is that beat's offset from where beat 0 sits at scroll 0,
 *  which is what the scroller is put back to afterwards
 *  (`scrollLeft = beat * cellW - x`) — so it must have the scroll taken
 *  out of it, or a zoom on a scrolled grid throws the view sideways. */
export function zoomAnchor(
  clientX: number,
  rulerLeft: number,
  scroll: number,
  cellW: number,
): { beat: number; x: number } {
  const contentX = clientX - rulerLeft;
  return { beat: contentX / cellW, x: contentX - scroll };
}

/** `col` held inside a range, on a column that is part of it. */
export function clampTo(col: number, range: ColumnRange): number {
  return Math.max(range.start, Math.min(col, range.end - 1));
}

/** How close to an edge counts as GRABBING it, in beats. A fixed pixel
 *  target would be most of a bar when zoomed out and invisible when
 *  zoomed in, so it is measured in beats and widened as they narrow. */
export function grabBeats(zoom: number): number {
  return Math.max(1, Math.round(0.5 / zoom));
}

/** Which of the loop's two edges a cell carries: the loop's first column
 *  owns its LEFT border, its last column owns its RIGHT one, and a
 *  one-beat loop owns both. */
export function loopEdge(loop: ColumnRange | null, col: number): 'start' | 'end' | 'both' | 'none' {
  if (!loop) return 'none';
  const start = col === loop.start;
  const end = col === loop.end - 1;
  if (start && end) return 'both';
  if (start) return 'start';
  return end ? 'end' : 'none';
}

/** Which edge of the loop, if either, a press at `col` takes hold of.
 *  The END is checked against the last beat inside the loop, because
 *  `end` is exclusive and the beat past the loop is not part of it. */
export function loopEdgeAt(
  loop: ColumnRange | null,
  col: number,
  grab: number,
): 'start' | 'end' | null {
  if (!loop) return null;
  const fromStart = Math.abs(col - loop.start);
  const fromEnd = Math.abs(col - (loop.end - 1));
  if (fromStart > grab && fromEnd > grab) return null;
  return fromStart <= fromEnd ? 'start' : 'end';
}

/** The modifier this machine writes shortcuts with, for the labels only
 *  — both are accepted wherever a shortcut is read. */
const MOD =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '') ? '⌘' : 'Ctrl+';

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <polygon points="3,2 14,8 3,14" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <rect x="3" y="2" width="4" height="12" fill="currentColor" />
      <rect x="9" y="2" width="4" height="12" fill="currentColor" />
    </svg>
  );
}

function RewindIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="2.5" height="12" fill="currentColor" />
      <polygon points="14,2 14,14 5,8" fill="currentColor" />
    </svg>
  );
}
/** How often the playhead is re-read from the transport. */
const POLL_MS = 60;
/** Peaks fetched per clip — enough to see the shape of a bar or two. */
const PEAK_BUCKETS = 256;

/** What the tempo lane shows without being asked: this much bpm either
 *  side of the grid's own tempo. A lane spanning 40..200 gave a whole
 *  96 px to 160 bpm, so the two bpm a set is really automated over were
 *  a pixel apart and unaimable. Each `+` at the lane's ends widens that
 *  side by the same amount again. */
export const BPM_WINDOW = 15;
/** The bpm a guide line is drawn every, while the window is small
 *  enough to carry them. */
export const BPM_GUIDE = 5;
/** How many guides the lane will draw before the step is coarsened. */
const MAX_GUIDES = 12;

/** What the tempo lane's vertical axis spans: the window around the
 *  grid's tempo, widened by whatever the ends have been opened to and by
 *  any breakpoint already written outside it — a point you cannot see is
 *  a point you cannot take back. */
export function bpmWindow(
  bpm: number,
  points: readonly { bpm: number }[],
  view: { up: number; down: number },
): { min: number; max: number } {
  let min = bpm - view.down;
  let max = bpm + view.up;
  for (const p of points) {
    min = Math.min(min, p.bpm);
    max = Math.max(max, p.bpm);
  }
  return {
    min: Math.max(MIN_BPM, Math.floor(min)),
    max: Math.min(MAX_BPM, Math.ceil(max)),
  };
}

/** The rules the tempo lane marks: every 5 bpm, coarsened as the window
 *  is opened so a wide range does not become a hatch. */
export function bpmTicks(min: number, max: number): number[] {
  const step = [BPM_GUIDE, 10, 20, 50].find((s) => (max - min) / s <= MAX_GUIDES) ?? 100;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out;
}

/** mm:ss.s — a duration as a musician reads a clock. */
export function clockTime(secs: number): string {
  const safe = Math.max(0, secs);
  const mins = Math.floor(safe / 60);
  const rest = safe - mins * 60;
  return `${mins}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

export interface GridViewProps {
  clips?: BeatClipApi;
  /** The page polls the playhead only while it is the open tab. */
  active?: boolean;
  pollMs?: number;
  /** Substituted in tests; the real one plays through Web Audio. */
  transport?: GridTransport;
}

type Dialog =
  | { kind: 'pick' }
  /** A row's effects rack, open over the arrangement. */
  | { kind: 'fx'; rowId: string }
  | { kind: 'saveAs'; name: string }
  | { kind: 'open'; names: string[] }
  | { kind: 'confirm'; message: string; proceed: () => void }
  | null;

export function GridView(props: GridViewProps) {
  const clipApi = props.clips ?? defaultClips;
  const active = props.active ?? true;
  // THE GRID IS A HISTORY, not a state: every edit below goes through
  // `setGrid`, which records it, so undo/redo covers the page rather than
  // a list of operations someone remembered to wire up.
  const [history, setHistory] = useState(() => initHistory(emptyGrid()));
  const grid = history.present;
  /** Edit the grid. `gesture` names a continuous one (a drag, a field
   *  being typed into): consecutive edits under the same name are ONE
   *  undo step until `endEdit` closes it. */
  const setGrid = useCallback(
    (update: GridState | ((prev: GridState) => GridState), gesture?: string) => {
      setHistory((h) =>
        record(h, typeof update === 'function' ? update(h.present) : update, gesture ?? null),
      );
    },
    [],
  );
  // A DRAG IS NOT AN EDIT UNTIL IT IS LET GO, as far as the sound is
  // concerned. Dragging the tempo envelope or the loop re-cues the
  // transport on every pointer move, which tore the playback apart while
  // the pointer was still down; the page holds the transport at the
  // state the drag began on and hands it the result once.
  const [holdAudio, setHoldAudio] = useState(false);
  const endEdit = useCallback(() => {
    setHistory(endGesture);
    setHoldAudio(false);
  }, []);
  const [clips, setClips] = useState<BeatClipEntry[]>([]);
  const [peaks, setPeaks] = useState<Record<string, readonly number[]>>({});
  const [dialog, setDialog] = useState<Dialog>(null);
  const [name, setName] = useState('untitled');
  const [saved, setSaved] = useState<string | null>(null);
  const [selection, setSelection] = useState<GridSelection | null>(null);
  const [board, setBoard] = useState<GridClipboard | null>(null);
  const [fileMenu, setFileMenu] = useState(false);
  const [zoom, setZoom] = useState(1);
  /** How far the tempo lane has been opened past `BPM_WINDOW`, each end
   *  on its own. Cosmetic: it is how much of the axis is on screen, not
   *  anything the arrangement means, so it never reaches the document. */
  const [bpmView, setBpmView] = useState({ up: BPM_WINDOW, down: BPM_WINDOW });
  /** What is being typed into the BPM box, while it is being typed.
   *  THE FIELD IS NOT THE VALUE until it is committed: reading every
   *  keystroke through `clampBpm` turned a half-typed "1" of "140" into
   *  the minimum and ate the rest. Enter and blur commit; Escape drops
   *  the draft. */
  const [bpmDraft, setBpmDraft] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState<{ playing: boolean; column: number }>({
    playing: false,
    column: 0,
  });
  const transport = useMemo(
    () => props.transport ?? new GridTransport(clipApi),
    [props.transport, clipApi],
  );
  /** The loop drag in flight: the edge held STILL, and whether the
   *  pointer has moved off the column it was pressed on. */
  const loopDrag = useRef<{ anchor: number; from: number; moved: boolean } | null>(null);
  const cellDrag = useRef<{ rowId: string; col: number } | null>(null);
  const levelDrag = useRef<{ rowId: string; beat: number } | null>(null);
  /** A selection being dragged about: where it was taken hold of, the
   *  grid it was taken hold of ON (every move is measured from there, so
   *  the drag is one operation and not a walk), and whether it leaves
   *  the original behind. */
  const moveDrag = useRef<{
    rowId: string;
    col: number;
    copy: boolean;
    base: GridState;
    from: GridSelection;
  } | null>(null);
  const ruler = useRef<HTMLDivElement | null>(null);
  /** The ruler's right-click menu, while it is open. */
  const [rulerMenu, setRulerMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    __pageRenderCount.bump();
  });

  useEffect(() => () => transport.dispose(), [transport]);

  /** The revision each clip was at when the store was last read. An edit
   *  keeps the clip's id, so this is the only thing that says the audio
   *  behind a row has moved. */
  const clipRevs = useRef(new Map<string, string>());

  // CLIPS ARE MADE AND EDITED ON ANOTHER PAGE, so the store is re-read
  // every time the grid becomes the open tab — a clip saved while the
  // grid was away belongs in the picker without restarting the app. And
  // everything held ABOUT a clip whose revision has moved is dropped
  // with it: its decoded audio in the transport and its peaks here, both
  // keyed by an id the edit did not change.
  useEffect(() => {
    if (!active) return;
    let live = true;
    void clipApi.list().then((list) => {
      if (!live || !list) return;
      const revs = clipRevs.current;
      const edited = list
        .filter((c) => revs.has(c.clipId) && revs.get(c.clipId) !== (c.rev ?? ''))
        .map((c) => c.clipId);
      clipRevs.current = new Map(list.map((c) => [c.clipId, c.rev ?? '']));
      if (edited.length > 0) {
        transport.forget(edited);
        setPeaks((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([id]) => !edited.includes(id))),
        );
      }
      setClips(list);
    });
    return () => {
      live = false;
    };
  }, [active, clipApi, transport]);

  const byId = useMemo(() => new Map(clips.map((c) => [c.clipId, c])), [clips]);
  const columns = useMemo(() => gridColumns(grid, byId), [grid, byId]);
  const groups = useMemo(() => groupRows(grid.rows, byId), [grid.rows, byId]);
  const range = useMemo(() => playRange(grid, columns), [grid, columns]);
  const cellW = GRID_CELL_W * zoom;
  const width = columns * cellW;
  /** The row whose effects rack is open, read off the CURRENT grid: an
   *  edit inside the modal must be what the modal draws next. */
  const fxRow = dialog?.kind === 'fx' ? grid.rows.find((r) => r.id === dialog.rowId) : undefined;

  /** The scrolling box the grid lives in (`.grid-body`, the one with the
   *  overflow), and the beat a zoom should hold still under the
   *  pointer. */
  const scroller = useRef<HTMLDivElement | null>(null);
  const keepBeat = useRef<{ beat: number; x: number } | null>(null);
  const scrollLeft = useCallback(() => scroller.current?.scrollLeft ?? 0, []);
  /** The column a page-x sits on, at the zoom in force. */
  const colAt = useCallback(
    (clientX: number, rect: { left: number }) =>
      Math.max(0, Math.floor((clientX - rect.left) / cellW)),
    [cellW],
  );

  // After a zoom, put the beat that was under the pointer back under it.
  // BEFORE THE FRAME IS PAINTED, not after: a plain effect runs once the
  // new geometry is already on screen, so every notch of the zoom showed
  // one frame of the grid thrown sideways and then snapped back.
  useLayoutEffect(() => {
    const hold = keepBeat.current;
    const box = scroller.current;
    keepBeat.current = null;
    if (!hold || !box) return;
    box.scrollLeft = Math.max(0, hold.beat * cellW - hold.x);
  }, [cellW]);

  /** The columns actually drawn — see `columnWindow`. */
  const [visible, setVisible] = useState<ColumnRange>({ start: 0, end: columns });
  const measureWindow = useCallback(() => {
    const box = scroller.current;
    const next = columnWindow(box?.scrollLeft ?? 0, box?.clientWidth ?? 0, cellW, columns);
    setVisible((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, [cellW, columns]);

  // The window follows the box: its size (a zoom, a resized page) and how
  // far it has been scrolled. Measured in a LAYOUT effect so the columns a
  // zoom brings into view are there in the frame the zoom lands in.
  useLayoutEffect(measureWindow, [measureWindow]);
  useEffect(() => {
    window.addEventListener('resize', measureWindow);
    return () => window.removeEventListener('resize', measureWindow);
  }, [measureWindow]);

  // SCROLLING IS COALESCED TO A FRAME, like the zoom: a scroll fires far
  // faster than the screen refreshes and most of those events do not move
  // the window at all, so they are answered once per frame and the answer
  // is usually "the same columns as before".
  const scrollFrame = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      measureWindow();
    });
  }, [measureWindow]);
  useEffect(
    () => () => {
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    },
    [],
  );

  // ZOOMING IS COALESCED TO A FRAME. A trackpad fires wheel events far
  // faster than the screen refreshes, and a React state update per event
  // is what made the zoom feel clicky: the deltas are added up in a ref
  // and applied ONCE per animation frame, so a flick of the wheel costs
  // one re-layout instead of thirty.
  const wheelDelta = useRef(0);
  const wheelAnchor = useRef<{ beat: number; x: number } | null>(null);
  const zoomFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (zoomFrame.current !== null) cancelAnimationFrame(zoomFrame.current);
    },
    [],
  );

  /** Zoom, holding `anchor` (a beat and the x it sits at inside the
   *  scroller) still under the pointer. */
  const applyZoom = useCallback((delta: number, anchor: { beat: number; x: number } | null) => {
    keepBeat.current = anchor;
    setZoom((z) => zoomBy(z, delta));
  }, []);

  const zoomStep = useCallback(
    (dir: -1 | 1) => {
      // Keyboard and buttons hold the LEFT EDGE of the view still: there
      // is no pointer to zoom about.
      applyZoom(-dir * ZOOM_NOTCH, { beat: scrollLeft() / cellW, x: 0 });
    },
    [applyZoom, cellW, scrollLeft],
  );

  const onRulerWheel = useCallback(
    (e: {
      deltaX?: number;
      deltaY: number;
      shiftKey?: boolean;
      clientX: number;
      preventDefault(): void;
    }) => {
      // A SIDEWAYS GESTURE SCROLLS, it does not zoom. A trackpad swipe is
      // never purely horizontal, so taking any deltaY as a zoom meant
      // that scrolling across the ruler zoomed a little on every event
      // AND put the scroll back where the zoom's anchor said — the grid
      // lurching about under the pointer. Shift+wheel is the same
      // gesture with a mouse. Both are left to the scrollport, which
      // needs the event UNPREVENTED to act on it.
      if (e.shiftKey || Math.abs(e.deltaX ?? 0) > Math.abs(e.deltaY)) return;
      if (e.deltaY === 0) return;
      e.preventDefault();
      wheelDelta.current += e.deltaY;
      if (wheelAnchor.current === null) {
        const rect = ruler.current?.getBoundingClientRect() ?? { left: 0 };
        wheelAnchor.current = zoomAnchor(e.clientX, rect.left, scrollLeft(), cellW);
      }
      if (zoomFrame.current !== null) return;
      zoomFrame.current = requestAnimationFrame(() => {
        zoomFrame.current = null;
        const delta = wheelDelta.current;
        const anchor = wheelAnchor.current;
        wheelDelta.current = 0;
        wheelAnchor.current = null;
        applyZoom(delta, anchor);
      });
    },
    [applyZoom, cellW, scrollLeft],
  );

  // Waveforms for whatever the grid holds. Peaks are a drawing, so they
  // are fetched once per clip and kept: re-placing a clip redraws from
  // what is already here.
  useEffect(() => {
    let live = true;
    const wanted = [...new Set(grid.rows.map((r) => r.clipId))].filter((id) => !(id in peaks));
    if (wanted.length === 0) return;
    void Promise.all(
      wanted.map(async (id) => {
        const got = await clipApi.peaks(id, PEAK_BUCKETS);
        // A clip with no peaks keeps the SHARED empty array, so that the
        // rows drawing it are handed the same value they already had and
        // stay memoised.
        return [id, got && got.length > 0 ? got : EMPTY_PEAKS] as const;
      }),
    ).then((pairs) => {
      if (live) setPeaks((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
    });
    return () => {
      live = false;
    };
  }, [grid.rows, clipApi, peaks]);

  // The playhead is READ, never counted: the transport derives it from
  // the audio clock, so a slow frame cannot walk the highlight off the
  // sound.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const status = transport.status();
      setPlayhead((prev) =>
        prev.playing === status.playing && Math.floor(prev.column) === Math.floor(status.column)
          ? prev
          : status,
      );
    }, props.pollMs ?? POLL_MS);
    return () => clearInterval(timer);
  }, [active, transport, props.pollMs]);

  // Leaving the page stops the sound: the grid is a page you edit, not a
  // deck the room is listening to.
  useEffect(() => {
    if (!active) transport.stop();
  }, [active, transport]);

  // EVERY FINISHED EDIT REACHES THE TRANSPORT. This is what makes the
  // grid live: the transport decides for itself what a given change
  // means (a new placement is laid down on its own beat; a tempo or loop
  // change re-cues), so the page just tells it the truth after every
  // edit.
  //
  // NOT DURING A DRAG, though. A tempo or loop change cannot be spliced
  // into the pass in flight, so it re-cues — and a drag makes one of
  // those per pointer move, which is a stutter for as long as the mouse
  // is down. The state the pointer is passing through is not a state
  // anyone asked to hear: `holdAudio` keeps the sound on the last
  // finished edit, and the release (which is where the undo step closes
  // too) hands the transport the one result.
  useEffect(() => {
    if (holdAudio) return;
    transport.update(grid, byId, columns);
  }, [transport, grid, byId, columns, holdAudio]);

  const dirty = saved !== JSON.stringify(toDocument(grid));

  const addClips = useCallback(
    (picked: BeatClipEntry[]) => {
      setDialog(null);
      setGrid((prev) => picked.reduce((state, clip) => addRow(state, clip), prev));
    },
    [setGrid],
  );

  /** Write a row's effects rack back into the grid. A gesture name from
   *  the modal (a knob drag, a panel being dragged) is namespaced by the
   *  row, so two rows' drags never coalesce into one undo step. */
  const setRowFx = useCallback(
    (rowId: string, fx: TrackFx, gesture?: string) => {
      setGrid(
        (prev) => ({
          ...prev,
          rows: prev.rows.map((r) => (r.id === rowId ? { ...r, fx } : r)),
        }),
        gesture ? `fx:${rowId}:${gesture}` : undefined,
      );
    },
    [setGrid],
  );

  const clickCell = useCallback(
    (rowId: string, col: number) => {
      setGrid((prev) => ({
        ...prev,
        rows: prev.rows.map((row) => {
          if (row.id !== rowId) return row;
          const clip = byId.get(row.clipId);
          return clip ? placeClip(row, clip, col) : row;
        }),
      }));
    },
    [byId, setGrid],
  );

  // The row's handlers. They are held HERE, and stable, because each one
  // is a prop of a memoised row: a handler rebuilt every render would
  // make every row re-render every time and undo the memo entirely. The
  // grid's own state is reached through the setter's callback form, and
  // what a handler needs to read (`selection`) it reads from a ref.
  // Written in an effect, not in the render body: a render React
  // discards must not leave these pointing at state that never landed.
  const selectionRef = useRef<GridSelection | null>(null);
  /** The rows in the order they are DRAWN in (grouped by track), which is
   *  the order a drag down the page crosses them in. */
  const orderedRows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const rowsRef = useRef<GridRow[]>(orderedRows);
  const gridRef = useRef<GridState>(grid);
  const byIdRef = useRef(byId);
  useEffect(() => {
    selectionRef.current = selection;
    rowsRef.current = orderedRows;
    gridRef.current = grid;
    byIdRef.current = byId;
  }, [selection, orderedRows, grid, byId]);

  const onCellDown = useCallback((_e: MouseEvent<HTMLElement>, rowId: string, col: number) => {
    cellDrag.current = { rowId, col };
    setSelection(null);
  }, []);

  // A PRESS INSIDE THE SELECTION PICKS IT UP. Marking a rectangle and
  // then dragging it is how a phrase is moved a bar later; cmd+drag
  // leaves the original where it was and carries a copy, the gesture
  // every arranger already has in their hands.
  const onSelectionDown = useCallback((e: MouseEvent<HTMLElement>, rowId: string, col: number) => {
    const from = selectionRef.current;
    if (!from) return;
    e.preventDefault();
    moveDrag.current = {
      rowId,
      col,
      copy: e.metaKey || e.ctrlKey,
      base: gridRef.current,
      from,
    };
    setHoldAudio(true);
  }, []);

  const onCellEnter = useCallback(
    (rowId: string, col: number) => {
      const move = moveDrag.current;
      if (move) {
        const order = rowsRef.current.map((r) => r.id);
        const moved = moveSelection(
          move.base,
          byIdRef.current,
          order,
          move.from,
          order.indexOf(rowId) - order.indexOf(move.rowId),
          col - move.col,
          move.copy,
        );
        setGrid(moved.state, 'move');
        setSelection(moved.selection);
        return;
      }
      const from = cellDrag.current;
      if (!from) return;
      setSelection(selectionFromDrag(rowsRef.current, from.rowId, from.col, rowId, col));
    },
    [setGrid],
  );

  const onCellUp = useCallback(() => {
    cellDrag.current = null;
    moveDrag.current = null;
  }, []);

  // A DRAG ENDS WHEREVER IT IS LET GO. The rows only see a mouse-up that
  // happens over them, so a selection dragged off the bottom of the grid
  // (or off the window) used to stay live and keep growing on the next
  // pass of the mouse. The window is where a gesture really ends, and it
  // is also where an undo step is closed.
  useEffect(() => {
    const up = () => {
      cellDrag.current = null;
      levelDrag.current = null;
      moveDrag.current = null;
      endEdit();
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [endEdit]);

  // PLACING stays on click, which fires only when press and release
  // share a cell. A drag that crossed cells has made a selection by now,
  // and a selection is not a placement.
  const onCellClick = useCallback(
    (e: MouseEvent<HTMLElement>, rowId: string, col: number) => {
      if (e.metaKey || e.ctrlKey || selectionRef.current) return;
      clickCell(rowId, col);
    },
    [clickCell],
  );

  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  const onLevelDown = useCallback(
    (e: MouseEvent<HTMLElement>, rowId: string) => {
      e.preventDefault();
      const { beat, level } = levelFromPointer(
        e,
        e.currentTarget.getBoundingClientRect(),
        zoomRef.current,
      );
      levelDrag.current = { rowId, beat };
      // One drag of a level point is ONE undo step, from the press to the
      // release: the gesture is named here and closed on mouse-up.
      setGrid(
        (prev) => ({
          ...prev,
          rows: prev.rows.map((r) => (r.id === rowId ? setLevelPoint(r, beat, level) : r)),
        }),
        `level:${rowId}`,
      );
    },
    [setGrid],
  );

  const onLevelMove = useCallback(
    (e: MouseEvent<HTMLElement>, rowId: string) => {
      const drag = levelDrag.current;
      if (!drag || drag.rowId !== rowId) return;
      const { beat, level } = levelFromPointer(
        e,
        e.currentTarget.getBoundingClientRect(),
        zoomRef.current,
      );
      levelDrag.current = { rowId, beat };
      setGrid(
        (prev) => ({
          ...prev,
          rows: prev.rows.map((r) =>
            r.id === rowId ? moveLevelPoint(r, drag.beat, beat, level) : r,
          ),
        }),
        `level:${rowId}`,
      );
    },
    [setGrid],
  );

  const onLevelUp = useCallback(() => {
    levelDrag.current = null;
    endEdit();
  }, [endEdit]);

  const onLevelClear = useCallback(
    (e: MouseEvent<HTMLElement>, rowId: string) => {
      e.preventDefault();
      const { beat } = levelFromPointer(
        e,
        e.currentTarget.getBoundingClientRect(),
        zoomRef.current,
      );
      setGrid((prev) => ({
        ...prev,
        rows: prev.rows.map((r) => (r.id === rowId ? removeLevelPoint(r, beat) : r)),
      }));
    },
    [setGrid],
  );

  /** Where the playhead may be put: anywhere on the grid, playing or
   *  not. A loop is something marked ON the music, not a pen the cursor
   *  is kept in — play from before it and the lead-in is heard once
   *  before the loop takes over, which is also the transport's rule. */
  const cursor = useMemo(() => ({ start: 0, end: Math.max(1, columns) }), [columns]);

  const play = useCallback(
    (from?: number) => {
      const at = clampTo(from ?? range.start, cursor);
      void transport.play(grid, byId, columns, at);
      setPlayhead({ playing: true, column: at });
    },
    [transport, grid, byId, columns, range, cursor],
  );

  /** Pause keeps the place; the next play resumes from it. */
  const pause = useCallback(() => {
    const at = transport.pause();
    setPlayhead({ playing: false, column: at });
  }, [transport]);

  const toggle = useCallback(() => {
    if (playhead.playing) pause();
    else play(playhead.column);
  }, [playhead.playing, playhead.column, pause, play]);

  /** Put the playhead on `col`, playing or not: a seek while the music
   *  runs re-cues there, which is what a scrub means. */
  const seekTo = useCallback(
    (col: number) => {
      const at = clampTo(col, cursor);
      if (playhead.playing) play(at);
      else {
        transport.seek(at);
        setPlayhead({ playing: false, column: at });
      }
    },
    [playhead.playing, cursor, play, transport],
  );

  const seekBy = useCallback(
    (delta: number) => seekTo(playhead.column + delta),
    [playhead.column, seekTo],
  );

  const copy = useCallback(() => {
    if (selection) setBoard(copySelection(grid, byId, selection));
  }, [selection, grid, byId]);

  // PASTE LANDS ON THE PLAYHEAD, always. It used to land on the
  // selection, which read well until you noticed the selection is
  // normally still sitting on the thing you just copied: pasting there
  // put the copy back exactly where it already was, and since a copy
  // does not stack on itself the paste looked like it had done nothing
  // at all. The selection says what to copy; the playhead says where it
  // goes, and moving the playhead is how you aim it.
  const paste = useCallback(() => {
    if (!board) return;
    setGrid((prev) => pasteAt(prev, byId, board, Math.round(playhead.column)));
    setSelection(null);
  }, [board, byId, playhead.column, setGrid]);

  // File actions. New/Open go behind a warning when there is work to
  // lose; Save falls through to Save As until the grid has a name.
  const doSave = useCallback(
    async (as?: string) => {
      const target = (as ?? name).trim() || 'untitled';
      const doc = JSON.stringify(toDocument(grid));
      await clipApi.gridSave(target, doc);
      setName(target);
      setSaved(doc);
      setDialog(null);
    },
    [clipApi, grid, name],
  );

  const guard = useCallback(
    (what: string, proceed: () => void) => {
      if (!dirty || isEmptyGrid(grid)) proceed();
      else setDialog({ kind: 'confirm', message: what, proceed });
    },
    [dirty, grid],
  );

  const doNew = useCallback(() => {
    guard('Start a new grid', () => {
      transport.stop();
      // A NEW DOCUMENT IS A NEW HISTORY: undo must not walk back into the
      // arrangement that was replaced.
      setHistory(initHistory(emptyGrid()));
      setName('untitled');
      setSaved(null);
      setSelection(null);
      setDialog(null);
      setPlayhead({ playing: false, column: 0 });
    });
  }, [guard, transport]);

  const doOpen = useCallback(() => {
    guard('Open another grid', () => {
      void clipApi.gridList().then((names) => setDialog({ kind: 'open', names: names ?? [] }));
    });
  }, [guard, clipApi]);

  const openNamed = useCallback(
    async (which: string) => {
      const raw = await clipApi.gridLoad(which);
      if (!raw) return;
      try {
        const state = fromDocument(JSON.parse(raw));
        transport.stop();
        setHistory(initHistory(state));
        setName(which);
        setSaved(JSON.stringify(toDocument(state)));
        setSelection(null);
        setPlayhead({ playing: false, column: 0 });
      } catch {
        // A file that will not parse is left alone rather than replacing
        // what the user has; the dialog simply closes.
      }
      setDialog(null);
    },
    [clipApi, transport],
  );

  /** The column a page-x sits on in the RULER, whatever the pointer is
   *  over now: a loop drag is measured against the ruler even after the
   *  pointer has left it. */
  const rulerCol = useCallback(
    (clientX: number) => colAt(clientX, ruler.current?.getBoundingClientRect() ?? { left: 0 }),
    [colAt],
  );

  const onRulerDown = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const col = rulerCol(e.clientX);
      // A PRESS ALONE MARKS NOTHING, on a loop edge or anywhere else: the
      // loop is only redrawn once the drag has reached another column, so
      // a press and release on one column stays a CLICK — and a click on
      // the ruler puts the playback there. Pressing an EDGE only chooses
      // what the drag will pivot about, the loop's other end, so that a
      // loop can be trimmed a beat at a time instead of being redrawn
      // from scratch every time it is not quite right.
      const edge = loopEdgeAt(grid.loop, col, grabBeats(zoom));
      const anchor =
        edge && grid.loop ? (edge === 'start' ? grid.loop.end - 1 : grid.loop.start) : col;
      loopDrag.current = { anchor, from: col, moved: false };
    },
    [grid.loop, rulerCol, zoom],
  );

  // THE LOOP DRAG BELONGS TO THE WINDOW, not to the ruler. Hung off the
  // ruler's own move/leave handlers, it ended the moment the pointer
  // strayed a few pixels up or down out of a 26 px strip — which is most
  // of the way through any real drag.
  useEffect(() => {
    const move = (e: globalThis.MouseEvent) => {
      const drag = loopDrag.current;
      if (!drag) return;
      const col = rulerCol(e.clientX);
      if (col !== drag.from) drag.moved = true;
      if (!drag.moved) return;
      // The loop only reaches the sound once the drag is over: every
      // column it is dragged through would otherwise re-cue the pass.
      setHoldAudio(true);
      setGrid((prev) => ({ ...prev, loop: loopFromDrag(drag.anchor, col) }), 'loop');
    };
    const up = (e: globalThis.MouseEvent) => {
      const drag = loopDrag.current;
      if (!drag) return;
      loopDrag.current = null;
      endEdit();
      if (!drag.moved) seekTo(rulerCol(e.clientX));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [endEdit, rulerCol, seekTo, setGrid]);

  // BEAT SURGERY on the loop's span, from the ruler's right-click menu:
  // what N is, is the loop — the columns the user has already marked.
  const beatMenu: ContextMenuItem[] = useMemo(() => {
    const loop = grid.loop;
    if (!loop) return [];
    const n = Math.max(1, loop.end - loop.start);
    const beats = `${n} ${n === 1 ? 'beat' : 'beats'}`;
    return [
      {
        label: `Insert ${beats} left`,
        testId: 'grid-beats-insert-left',
        onSelect: () => setGrid((prev) => insertBeats(prev, byId, loop.start, n)),
      },
      {
        label: `Insert ${beats} right`,
        testId: 'grid-beats-insert-right',
        onSelect: () => setGrid((prev) => insertBeats(prev, byId, loop.end, n)),
      },
      {
        label: `Copy ${beats} left`,
        testId: 'grid-beats-copy-left',
        onSelect: () => setGrid((prev) => copyBeats(prev, byId, loop, 'left')),
      },
      {
        label: `Copy ${beats} right`,
        testId: 'grid-beats-copy-right',
        onSelect: () => setGrid((prev) => copyBeats(prev, byId, loop, 'right')),
      },
      {
        label: `Delete ${beats}`,
        testId: 'grid-beats-delete',
        onSelect: () => setGrid((prev) => deleteBeats(prev, byId, loop)),
      },
    ];
  }, [byId, grid.loop, setGrid]);

  const undo = useCallback(() => {
    setHistory(undoHistory);
    setSelection(null);
  }, []);

  const redo = useCallback(() => {
    setHistory(redoHistory);
    setSelection(null);
  }, []);

  // Keyboard: space plays, the arrows move the playhead (bare = a beat,
  // cmd = a bar, ctrl = to the ends), cmd+C/V copy and paste. They stand
  // down for a focused form control and while a dialog owns the keyboard,
  // the same rule every other page here follows.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (dialog || isEditableTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const back = e.key === 'ArrowLeft';
        if (e.ctrlKey && !e.metaKey) seekTo(back ? range.start : range.end - 1);
        else if (e.metaKey) seekBy(back ? -grid.barBeats : grid.barBeats);
        else seekBy(back ? -1 : 1);
      } else if (mod && key === 'c') {
        copy();
      } else if (mod && key === 'v') {
        e.preventDefault();
        paste();
      } else if (mod && key === 'z') {
        // UNDO/REDO for everything on the page, the standard pair.
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && key === 'y') {
        e.preventDefault();
        e.stopPropagation();
        redo();
      } else if (mod && (key === '=' || key === '+')) {
        // cmd/ctrl +/− zoom, the way every timeline does. `=` is the
        // unshifted key `+` lives on, and both arrive here.
        e.preventDefault();
        zoomStep(1);
      } else if (mod && (key === '-' || key === '_')) {
        e.preventDefault();
        zoomStep(-1);
      } else if (mod && key === 's') {
        // FILE SHORTCUTS, now that the buttons are gone. They are caught
        // here rather than through `useFileShortcuts` because that hook
        // is the PATCH's — on this page the same keys mean the grid.
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) setDialog({ kind: 'saveAs', name });
        else void doSave();
      } else if (mod && key === 'o') {
        e.preventDefault();
        e.stopPropagation();
        doOpen();
      } else if (mod && key === 'n') {
        e.preventDefault();
        e.stopPropagation();
        doNew();
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && selection) {
        e.preventDefault();
        setGrid((prev) => deleteSelection(prev, byId, selection));
      } else if (e.key === 'Enter' && selection) {
        // ENTER FILLS WHAT IS MARKED. Sixteen bars of a four-beat clip is
        // sixteen clicks otherwise, and the rectangle already says both
        // which rows and how far.
        e.preventDefault();
        setGrid((prev) => fillSelection(prev, byId, selection));
      } else if (e.key === 'Escape') {
        setSelection(null);
        setFileMenu(false);
      }
    };
    // CAPTURE, so the page's own Save beats the patch's global one while
    // the Grid is the visible tab.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [
    active,
    dialog,
    toggle,
    seekBy,
    seekTo,
    range,
    copy,
    paste,
    selection,
    byId,
    grid.barBeats,
    name,
    doSave,
    doOpen,
    doNew,
    undo,
    redo,
    zoomStep,
    setGrid,
  ]);

  const tempoPoints: LanePoint[] = useMemo(
    () => grid.tempo.points.map((p) => ({ at: p.beat, value: p.bpm })),
    [grid.tempo.points],
  );
  const laneRange = useMemo(
    () => bpmWindow(grid.tempo.bpm, grid.tempo.points, bpmView),
    [grid.tempo.bpm, grid.tempo.points, bpmView],
  );
  const laneTicks = useMemo(() => bpmTicks(laneRange.min, laneRange.max), [laneRange]);
  /** Open (or close again) one end of the tempo lane's window. */
  const widenLane = useCallback((end: 'up' | 'down', by: number) => {
    setBpmView((was) => ({ ...was, [end]: Math.max(BPM_WINDOW, was[end] + by) }));
  }, []);

  /** Take what is in the BPM box as the tempo. Called on Enter and on
   *  blur — never per keystroke, which is what made a "1" on the way to
   *  "140" snap to the minimum. */
  const commitBpm = useCallback(() => {
    const draft = bpmDraft;
    setBpmDraft(null);
    endEdit();
    if (draft === null) return;
    const next = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(next)) return;
    setGrid((prev) => ({ ...prev, tempo: { ...prev.tempo, bpm: clampBpm(next) } }), 'bpm');
  }, [bpmDraft, endEdit, setGrid]);

  // A page that is not looking is not playing, whatever the last poll
  // said — the effect above has already stopped the transport.
  const playing = active && playhead.playing;
  const nowCol = Math.floor(playhead.column);
  const totalSecs = rangeSecs(grid.tempo, { start: 0, end: columns });

  return (
    <div
      className="grid-view"
      data-testid="grid-view"
      style={active ? undefined : { display: 'none' }}
    >
      <header className="grid-bar">
        {/* THE NAME IS THE FILE MENU. New/Open/Save/Save As were four
            buttons for something done a handful of times a session; the
            shortcuts do the work and this is where they are discovered. */}
        <div className="grid-file">
          <button
            className="decks-btn grid-name mono"
            data-testid="grid-name"
            aria-haspopup="menu"
            aria-expanded={fileMenu}
            title="This arrangement — click for New, Open, Save"
            onClick={() => setFileMenu((was) => !was)}
          >
            {name}
            {dirty ? ' •' : ''}
          </button>
          {fileMenu && (
            <div className="grid-file-menu" data-testid="grid-file-menu" role="menu">
              <button
                className="grid-file-item"
                data-testid="grid-new"
                role="menuitem"
                onClick={() => {
                  setFileMenu(false);
                  doNew();
                }}
              >
                New <span className="grid-file-key mono">{MOD}N</span>
              </button>
              <button
                className="grid-file-item"
                data-testid="grid-open"
                role="menuitem"
                onClick={() => {
                  setFileMenu(false);
                  doOpen();
                }}
              >
                Open… <span className="grid-file-key mono">{MOD}O</span>
              </button>
              <button
                className="grid-file-item"
                data-testid="grid-undo"
                role="menuitem"
                disabled={!canUndo(history)}
                onClick={() => {
                  setFileMenu(false);
                  undo();
                }}
              >
                Undo <span className="grid-file-key mono">{MOD}Z</span>
              </button>
              <button
                className="grid-file-item"
                data-testid="grid-redo"
                role="menuitem"
                disabled={!canRedo(history)}
                onClick={() => {
                  setFileMenu(false);
                  redo();
                }}
              >
                Redo <span className="grid-file-key mono">{MOD}⇧Z</span>
              </button>
              <button
                className="grid-file-item"
                data-testid="grid-save"
                role="menuitem"
                onClick={() => {
                  setFileMenu(false);
                  void doSave();
                }}
              >
                Save <span className="grid-file-key mono">{MOD}S</span>
              </button>
              <button
                className="grid-file-item"
                data-testid="grid-save-as"
                role="menuitem"
                onClick={() => {
                  setFileMenu(false);
                  setDialog({ kind: 'saveAs', name });
                }}
              >
                Save As… <span className="grid-file-key mono">{MOD}⇧S</span>
              </button>
            </div>
          )}
        </div>
        <div className="grid-transport">
          <button
            className={`decks-btn grid-icon-btn decks-btn-start${playing ? ' is-on' : ''}`}
            data-testid="grid-play"
            aria-pressed={playing}
            aria-label="Play"
            title={`Play (${playing ? 'playing' : 'space'})`}
            onClick={() => play(playhead.column)}
          >
            <PlayIcon />
          </button>
          <button
            className="decks-btn grid-icon-btn"
            data-testid="grid-pause"
            aria-pressed={!playing}
            aria-label="Pause"
            title="Pause (space)"
            disabled={!playing}
            onClick={pause}
          >
            <PauseIcon />
          </button>
          <button
            className="decks-btn grid-icon-btn"
            data-testid="grid-rewind"
            aria-label="Back to the start of the play range"
            title="Back to the start of the play range"
            onClick={() => seekTo(range.start)}
          >
            <RewindIcon />
          </button>
          <span className="grid-position mono" data-testid="grid-position">
            beat {Math.floor(playhead.column) + 1}/{columns}
          </span>
          <span className="grid-duration mono" data-testid="grid-duration">
            {columns} beats · {clockTime(totalSecs)}
          </span>
        </div>
        {/* COPY AND PASTE, said out loud: the shortcuts are easy to miss
            and there is no menu bar on this page to find them in. */}
        <div className="grid-clipboard">
          <button
            className="decks-btn"
            data-testid="grid-copy"
            disabled={!selection}
            title={`Copy the selection (${MOD}C)`}
            onClick={copy}
          >
            Copy
          </button>
          <button
            className="decks-btn"
            data-testid="grid-paste"
            disabled={!board}
            title={`Paste at the playhead — click the ruler to aim it (${MOD}V)`}
            onClick={paste}
          >
            Paste
          </button>
        </div>
        <div className="grid-tempo">
          <label className="decks-tempo-label" htmlFor="grid-bpm">
            BPM
          </label>
          <input
            id="grid-bpm"
            className="decks-bpm mono"
            data-testid="grid-bpm"
            type="number"
            min={MIN_BPM}
            max={MAX_BPM}
            step={0.5}
            value={bpmDraft ?? String(Number(grid.tempo.bpm.toFixed(2)))}
            title="The tempo the grid runs at — Enter or click away to set it"
            onBlur={commitBpm}
            onChange={(e) => setBpmDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitBpm();
              // Escape puts the box back to the tempo in force, the way
              // out of a half-typed number.
              else if (e.key === 'Escape') setBpmDraft(null);
            }}
          />
          <label className="decks-tempo-label" htmlFor="grid-bar-beats">
            bar
          </label>
          <input
            id="grid-bar-beats"
            className="decks-bpm mono grid-bar-input"
            data-testid="grid-bar-beats"
            type="number"
            min={MIN_BAR}
            max={MAX_BAR}
            step={1}
            value={grid.barBeats}
            title="Beats to a bar: what the ruler counts and what cmd+arrow steps by"
            onBlur={endEdit}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next))
                setGrid((prev) => ({ ...prev, barBeats: clampBar(next) }), 'bar');
            }}
          />
        </div>
        <div className="grid-zoom">
          <button
            className="decks-btn"
            data-testid="grid-zoom-out"
            aria-label="Zoom out"
            title={`Zoom out (${MOD}−, or scroll over the ruler)`}
            disabled={zoom <= MIN_ZOOM}
            onClick={() => zoomStep(-1)}
          >
            −
          </button>
          <span className="grid-zoom-readout mono" data-testid="grid-zoom">
            {Math.round(zoom * 100)}%
          </span>
          <button
            className="decks-btn"
            data-testid="grid-zoom-in"
            aria-label="Zoom in"
            title={`Zoom in (${MOD}+, or scroll over the ruler)`}
            disabled={zoom >= MAX_ZOOM}
            onClick={() => zoomStep(1)}
          >
            +
          </button>
        </div>
        <div className="grid-loop-controls">
          <button
            className="decks-btn"
            data-testid="grid-loop-clear"
            disabled={grid.loop === null}
            onClick={() => setGrid((prev) => ({ ...prev, loop: null }))}
          >
            clear loop
          </button>
        </div>
        <div className="grid-length">
          <label className="decks-tempo-label" htmlFor="grid-beats">
            beats
          </label>
          <input
            id="grid-beats"
            className="grid-beats-input mono"
            data-testid="grid-beats"
            type="number"
            min={1}
            step={4}
            value={grid.beats}
            onBlur={endEdit}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next))
                setGrid((prev) => ({ ...prev, beats: Math.max(1, Math.round(next)) }), 'beats');
            }}
          />
          {columns > grid.beats && (
            <span className="grid-beats-note mono" title="A clip is placed past the grid's end">
              {columns} used
            </span>
          )}
        </div>
      </header>

      {/* THE SCROLLPORT. `.grid-scroll` inside it is only the column the
          lanes live in — this is the box with `overflow: auto` on it, so
          this is the only element whose `scrollLeft` means anything. */}
      <div className="grid-body" data-testid="grid-body" ref={scroller} onScroll={onScroll}>
        <div className="grid-gutter">
          {/* THE TEMPO LANE'S WINDOW, opened from its two ends. The lane
              shows ±15 bpm around the grid's tempo, which is where a set
              is actually automated; the + at each end asks for another
              15 in that direction, and the − gives it back. */}
          <div className="grid-gutter-head">
            <div className="grid-bpm-window">
              <button
                className="grid-bpm-wider"
                data-testid="grid-bpm-up-more"
                title={`Show ${BPM_WINDOW} bpm more above`}
                aria-label="Show a higher tempo range"
                onClick={() => widenLane('up', BPM_WINDOW)}
              >
                +
              </button>
              <button
                className="grid-bpm-wider"
                data-testid="grid-bpm-up-less"
                title={`Show ${BPM_WINDOW} bpm less above`}
                aria-label="Show a smaller tempo range above"
                disabled={bpmView.up <= BPM_WINDOW}
                onClick={() => widenLane('up', -BPM_WINDOW)}
              >
                −
              </button>
            </div>
            <span className="grid-gutter-head-label" data-testid="grid-bpm-range">
              master {laneRange.min}–{laneRange.max}
            </span>
            <div className="grid-bpm-window">
              <button
                className="grid-bpm-wider"
                data-testid="grid-bpm-down-more"
                title={`Show ${BPM_WINDOW} bpm more below`}
                aria-label="Show a lower tempo range"
                onClick={() => widenLane('down', BPM_WINDOW)}
              >
                +
              </button>
              <button
                className="grid-bpm-wider"
                data-testid="grid-bpm-down-less"
                title={`Show ${BPM_WINDOW} bpm less below`}
                aria-label="Show a smaller tempo range below"
                disabled={bpmView.down <= BPM_WINDOW}
                onClick={() => widenLane('down', -BPM_WINDOW)}
              >
                −
              </button>
            </div>
          </div>
          <div className="grid-gutter-ruler">bar</div>
          {groups.map((group) => (
            <div className="grid-group-titles" key={group.key}>
              {/* THE TRACK, said once for the whole group. */}
              <div className="grid-group-title" data-testid={`grid-group-${group.key}`}>
                <span className="grid-group-name" title={group.title}>
                  {group.title}
                </span>
                {group.artist && <span className="grid-group-artist">{group.artist}</span>}
              </div>
              {group.rows.map((row) => {
                const clip = byId.get(row.clipId);
                return (
                  <div className="grid-row-title" data-testid={`grid-title-${row.id}`} key={row.id}>
                    <span className="grid-row-name" title={clip?.name}>
                      {clip?.name ?? 'clip missing'}
                    </span>
                    <span className="grid-row-meta mono">
                      {clip ? `${clip.beats}b · ${fixed(clip.bpm, 0)}` : '—'}
                    </span>
                    {/* GRAY LIKE THE REST until the rack has been
                        changed, then BLUE: the button is the only place
                        a row says it is running effects. */}
                    <button
                      className="grid-row-fx"
                      data-testid={`grid-fx-${row.id}`}
                      data-modified={isTrackFxModified(row.fx) ? 'true' : 'false'}
                      title="Effects rack for this track"
                      onClick={() => setDialog({ kind: 'fx', rowId: row.id })}
                    >
                      fx
                    </button>
                    <button
                      className="grid-row-clear"
                      data-testid={`grid-clear-${row.id}`}
                      title="Take this row's clips off the grid"
                      disabled={row.placements.length === 0}
                      onClick={() =>
                        setGrid((prev) => ({
                          ...prev,
                          rows: prev.rows.map((r) => (r.id === row.id ? clearRow(r) : r)),
                        }))
                      }
                    >
                      ⌫
                    </button>
                    <button
                      className="grid-row-eject"
                      data-testid={`grid-eject-${row.id}`}
                      title="Remove this row"
                      onClick={() => setGrid((prev) => removeRow(prev, row.id))}
                    >
                      ⏏
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
          <div className="grid-adds">
            <button
              className="decks-btn"
              data-testid="grid-add"
              onClick={() => setDialog({ kind: 'pick' })}
            >
              + Beat clip
            </button>
          </div>
        </div>

        <div className="grid-scroll" data-testid="grid-scroll">
          {/* ZOOM IS PUBLISHED HERE, once, as a CSS variable: everything
              below measures itself in beats off it, so a zoom re-lays the
              grid out without re-rendering a single row. */}
          <div
            className="grid-lanes"
            style={{ width, [CELL_W_VAR]: `${cellW}px` } as CSSProperties}
          >
            {/* MASTER TEMPO over the same columns as the grid below it. */}
            <AutomationLane
              testId="grid-tempo-lane"
              ariaLabel="Master tempo automation"
              width={width}
              height={GRID_LANE_H}
              domain={columns}
              min={laneRange.min}
              max={laneRange.max}
              base={grid.tempo.bpm}
              points={tempoPoints}
              ticks={laneTicks}
              quantize={(v) => Math.round(v * 2) / 2}
              label={(v) => `${v}`}
              onAdd={(at, value) => {
                setHoldAudio(true);
                setGrid(
                  (prev) => ({ ...prev, tempo: setTempoPoint(prev.tempo, at, value) }),
                  'tempo',
                );
              }}
              onMove={(fromAt, at, value) => {
                // The envelope reaches the transport on release, not
                // under the pointer: a tempo change re-cues, and one per
                // pointer move is what made a drag during playback
                // unlistenable.
                setHoldAudio(true);
                setGrid(
                  (prev) => ({
                    ...prev,
                    tempo: moveTempoPoint(prev.tempo, fromAt, at, value),
                  }),
                  'tempo',
                );
              }}
              onRelease={endEdit}
              onRemove={(at) =>
                setGrid((prev) => ({ ...prev, tempo: removeTempoPoint(prev.tempo, at) }))
              }
            />

            {/* THE RULER: bar numbers, the drag that marks a loop, and
                the wheel that zooms. */}
            <div
              className="grid-ruler"
              data-testid="grid-ruler"
              ref={ruler}
              onMouseDown={onRulerDown}
              // THE WHEEL ZOOMS while the pointer is over the ruler, which
              // is the one strip of the page with nothing to scroll.
              onWheel={onRulerWheel}
              // RIGHT-CLICK OPERATES ON THE LOOP: with N columns marked,
              // this is where N beats are opened, doubled or taken out.
              onContextMenu={(e) => {
                e.preventDefault();
                if (grid.loop) setRulerMenu({ x: e.clientX, y: e.clientY });
              }}
            >
              {/* The beats before the window, as one blank of their
                  width — see `columnWindow`. */}
              <span className="grid-gap" style={{ width: beatsWide(visible.start) }} />
              {Array.from({ length: Math.max(0, visible.end - visible.start) }, (_, i) => {
                const col = visible.start + i;
                return (
                  <span
                    className="grid-ruler-cell"
                    data-testid={`grid-ruler-${col}`}
                    data-bar={col % grid.barBeats === 0 ? 'true' : 'false'}
                    data-loop={inRange(range, col) && grid.loop ? 'true' : 'false'}
                    key={col}
                    style={{ width: beatsWide(1) }}
                  >
                    {col % grid.barBeats === 0 && cellW * grid.barBeats >= 18
                      ? col / grid.barBeats + 1
                      : ''}
                  </span>
                );
              })}
              {/* The loop's edges, as handles you can take hold of. */}
              {grid.loop && (
                <>
                  <span
                    className="grid-loop-handle"
                    data-testid="grid-loop-handle-start"
                    data-edge="start"
                    style={{ left: beatsWide(grid.loop.start) }}
                  />
                  <span
                    className="grid-loop-handle"
                    data-testid="grid-loop-handle-end"
                    data-edge="end"
                    style={{ left: beatsWide(grid.loop.end) }}
                  />
                </>
              )}
            </div>

            {groups.map((group) => (
              <div className="grid-group-cells" key={group.key}>
                <div className="grid-group-spacer" />
                {group.rows.map((row) => (
                  <GridRowCells
                    key={row.id}
                    row={row}
                    clip={byId.get(row.clipId)}
                    columns={columns}
                    visible={visible}
                    barBeats={grid.barBeats}
                    peaks={peaks[row.clipId] ?? EMPTY_PEAKS}
                    loop={grid.loop ? range : null}
                    selection={selectionFor(selection, row.id)}
                    onCellDown={onCellDown}
                    onSelectionDown={onSelectionDown}
                    onCellEnter={onCellEnter}
                    onCellUp={onCellUp}
                    onCellClick={onCellClick}
                    onLevelDown={onLevelDown}
                    onLevelMove={onLevelMove}
                    onLevelUp={onLevelUp}
                    onLevelClear={onLevelClear}
                  />
                ))}
              </div>
            ))}

            {/* THE MOVING PARTS, drawn once over the whole grid rather
                than marked on every cell. This is what lets the rows be
                memoised: the playhead can move sixteen times a second
                without a single row re-rendering.

                DRAWN WHILE STOPPED TOO, dimmed. It is not only a picture
                of the sound: it is where playback will start and where a
                paste lands, so a marker that appeared only once the music
                ran left a click on the ruler looking like it had done
                nothing at all. */}
            <div
              className="grid-now"
              data-testid="grid-now"
              data-playing={playing ? 'true' : 'false'}
              style={{ left: nowCol * cellW, width: cellW }}
            />
            <div
              className="grid-playhead"
              data-testid="grid-playhead"
              data-playing={playing ? 'true' : 'false'}
              style={{ left: playhead.column * cellW }}
            />
          </div>
          {grid.rows.length === 0 && (
            <p className="empty-state" data-testid="grid-empty">
              Nothing on the grid yet. Add a beat clip — a whole track, or one clip inside it — then
              click a cell to place it: its first one lands on the beat you click.
            </p>
          )}
        </div>
      </div>

      {rulerMenu && (
        <ContextMenu
          x={rulerMenu.x}
          y={rulerMenu.y}
          items={beatMenu}
          onClose={() => setRulerMenu(null)}
        />
      )}

      {dialog?.kind === 'pick' && (
        <GridClipPicker clips={clips} onPick={addClips} onClose={() => setDialog(null)} />
      )}

      {fxRow && (
        <GridFxModal
          title={byId.get(fxRow.clipId)?.name ?? fxRow.id}
          fx={fxOrDefault(fxRow.fx)}
          bpm={grid.tempo.bpm}
          onChange={(next, gesture) => setRowFx(fxRow.id, next, gesture)}
          onEditEnd={endEdit}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'saveAs' && (
        <div className="file-dialog-backdrop" data-testid="grid-save-dialog">
          <div className="file-dialog" role="dialog" aria-label="Save the grid as">
            <h3>Save grid as</h3>
            <input
              data-testid="grid-save-name"
              autoFocus
              value={dialog.name}
              onChange={(e) => setDialog({ kind: 'saveAs', name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doSave(dialog.name);
              }}
            />
            <button data-testid="grid-save-confirm" onClick={() => void doSave(dialog.name)}>
              Save
            </button>
            <button className="file-dialog-cancel" onClick={() => setDialog(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {dialog?.kind === 'open' && (
        <div className="file-dialog-backdrop" data-testid="grid-open-dialog">
          <div className="file-dialog" role="dialog" aria-label="Open a grid">
            <h3>Open grid</h3>
            <div className="file-dialog-list">
              {dialog.names.length === 0 && (
                <p className="file-dialog-empty">No saved grids yet.</p>
              )}
              {dialog.names.map((n) => (
                <button data-testid={`grid-open-${n}`} key={n} onClick={() => void openNamed(n)}>
                  {n}
                </button>
              ))}
            </div>
            <button className="file-dialog-cancel" onClick={() => setDialog(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {dialog?.kind === 'confirm' && (
        <div className="file-dialog-backdrop" data-testid="grid-confirm">
          <div className="file-dialog" role="dialog" aria-label="Unsaved changes">
            <h3>Unsaved changes</h3>
            <p className="file-dialog-empty">
              “{name}” has unsaved changes. {dialog.message} anyway?
            </p>
            <button
              data-testid="grid-confirm-save"
              onClick={() => {
                const go = dialog.proceed;
                void doSave().then(go);
              }}
            >
              Save first
            </button>
            <button
              data-testid="grid-confirm-discard"
              onClick={() => {
                const go = dialog.proceed;
                setDialog(null);
                go();
              }}
            >
              Discard
            </button>
            <button
              className="file-dialog-cancel"
              data-testid="grid-confirm-cancel"
              onClick={() => setDialog(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A clip's waveform, drawn faintly inside the block it occupies. It is
 *  one path over the whole clip, so what you see is the shape of the
 *  material rather than a bar chart of its beats. */
function ClipWave({ peaks }: { peaks: readonly number[] }) {
  if (peaks.length === 0) return null;
  const step = 100 / peaks.length;
  const top = peaks.map((p, i) => `${i * step},${50 - Math.min(1, p) * 48}`).join(' ');
  const bottom = peaks
    .map((p, i) => `${(peaks.length - 1 - i) * step},${50 + Math.min(1, p) * 48}`)
    .join(' ');
  return (
    <svg
      className="grid-clip-wave"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polygon points={`${top} ${bottom}`} />
    </svg>
  );
}

/** Where a pointer is on a row, as a beat and a level: x quantized to a
 *  column, y read against the row's height with the MIDDLE as unity. */
export function levelFromPointer(
  e: { clientX: number; clientY: number },
  rect: { left: number; top: number; height: number },
  zoom = 1,
): { beat: number; level: number } {
  const beat = Math.max(0, Math.round((e.clientX - rect.left) / (GRID_CELL_W * zoom)));
  const height = rect.height || 1;
  const level = Math.max(0, Math.min(MAX_LEVEL, (1 - (e.clientY - rect.top) / height) * MAX_LEVEL));
  return { beat, level };
}

/** The line drawn through a row: unity down the MIDDLE until someone
 *  writes on it. Purely a drawing — the gesture that writes on it lives
 *  on the row itself, because the cells have to stay clickable and a line
 *  a pixel thick is not a hit target. */
function LevelLine({ row, columns }: { row: GridState['rows'][number]; columns: number }) {
  const y = (level: number) => (1 - level / MAX_LEVEL) * 100;
  const points = [...row.levels].sort((a, b) => a.beat - b.beat);
  const x = (beat: number) => (beat / Math.max(1, columns)) * 100;
  const path =
    points.length === 0
      ? `0,${y(1)} 100,${y(1)}`
      : [
          `0,${y(points[0].level)}`,
          ...points.map((p) => `${x(p.beat)},${y(p.level)}`),
          `100,${y(points[points.length - 1].level)}`,
        ].join(' ');

  return (
    <div
      className="grid-level"
      data-testid={`grid-level-${row.id}`}
      data-written={points.length > 0 ? 'true' : 'false'}
      style={{ width: beatsWide(columns) }}
    >
      <svg
        className="grid-level-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polyline points={path} />
      </svg>
      {points.map((p) => (
        <span
          className="grid-level-point"
          data-testid={`grid-level-point-${row.id}-${p.beat}`}
          key={p.beat}
          style={{ left: beatsWide(p.beat), top: `${y(p.level)}%` }}
        />
      ))}
    </div>
  );
}

/** How many times a row has drawn itself. Read by the performance tests,
 *  which are the only thing standing between this page and the crawl it
 *  had at fifty clips. Counted from an effect rather than from the render
 *  body: a render that React throws away never reaches the screen and
 *  should not be counted as work the user paid for. */
export const __rowRenderCount = {
  n: 0,
  get(): number {
    return this.n;
  },
  bump(): void {
    this.n += 1;
  },
  reset(): void {
    this.n = 0;
  },
};

/** How many times the PAGE has drawn itself. What the zoom performance
 *  tests count: a wheel spun through thirty events must cost one render
 *  per frame, not one per event. */
export const __pageRenderCount = {
  n: 0,
  get(): number {
    return this.n;
  },
  bump(): void {
    this.n += 1;
  },
  reset(): void {
    this.n = 0;
  },
};

interface RowCellsProps {
  row: GridRow;
  clip: BeatClipEntry | undefined;
  columns: number;
  /** The columns to draw — see `columnWindow`. */
  visible: ColumnRange;
  barBeats: number;
  peaks: readonly number[];
  /** The play range, when a loop is set — else null. */
  loop: ColumnRange | null;
  /** This row's slice of the selection, or null. */
  selection: ColumnRange | null;
  onCellDown: (e: MouseEvent<HTMLElement>, rowId: string, col: number) => void;
  /** A press that landed INSIDE this row's slice of the selection. */
  onSelectionDown: (e: MouseEvent<HTMLElement>, rowId: string, col: number) => void;
  onCellEnter: (rowId: string, col: number) => void;
  onCellUp: () => void;
  onCellClick: (e: MouseEvent<HTMLElement>, rowId: string, col: number) => void;
  onLevelDown: (e: MouseEvent<HTMLElement>, rowId: string) => void;
  onLevelMove: (e: MouseEvent<HTMLElement>, rowId: string) => void;
  onLevelUp: () => void;
  onLevelClear: (e: MouseEvent<HTMLElement>, rowId: string) => void;
}

/** One row of cells.
 *
 *  MEMOISED, and deliberately ignorant of the playhead. A row that knew
 *  where the playhead was would redraw sixteen times a second, and fifty
 *  rows of a few hundred cells redrawing at that rate is what made the
 *  page crawl and the scrolling stick. The moving parts — the playhead
 *  line and the lit column — are drawn ONCE over the whole grid instead,
 *  so a poll costs one small render no matter how much is on the grid.
 *
 *  The cell handlers are the row's, not the cell's: one set of four
 *  closures per row rather than four per cell, with the column read back
 *  off the target. At fifty rows and three hundred columns that is the
 *  difference between 200 closures per render and 60,000.
 *
 *  Only the columns in `visible` are drawn, behind a blank of whatever
 *  the ones before them are worth — see `columnWindow`. */
const GridRowCells = memo(function GridRowCells({
  row,
  clip,
  columns,
  visible,
  barBeats,
  peaks,
  loop,
  selection,
  onCellDown,
  onSelectionDown,
  onCellEnter,
  onCellUp,
  onCellClick,
  onLevelDown,
  onLevelMove,
  onLevelUp,
  onLevelClear,
}: RowCellsProps) {
  useEffect(() => {
    __rowRenderCount.bump();
  });

  /** The column a delegated pointer event happened on, or -1. */
  const colOf = (e: MouseEvent<HTMLElement>): number => {
    const cell = (e.target as HTMLElement).closest('[data-col]');
    if (!cell) return -1;
    return Number((cell as HTMLElement).dataset.col);
  };

  return (
    <div
      className="grid-row-cells"
      data-testid={`grid-cells-${row.id}`}
      onMouseDown={(e) => {
        const col = colOf(e);
        // A PRESS INSIDE THE MARKED RECTANGLE TAKES HOLD OF IT — dragging
        // moves what is selected, and cmd+dragging carries a copy. That
        // is why this is checked before the level gesture: inside a
        // selection, cmd means "copy this", not "write a level point".
        if (col >= 0 && selection && col >= selection.start && col < selection.end) {
          onSelectionDown(e, row.id, col);
          return;
        }
        // cmd/ctrl writes on the level line; a bare press is the grid's.
        if (e.metaKey || e.ctrlKey) {
          onLevelDown(e, row.id);
          return;
        }
        if (col >= 0) onCellDown(e, row.id, col);
      }}
      onMouseMove={(e) => {
        onLevelMove(e, row.id);
      }}
      onMouseOver={(e) => {
        const col = colOf(e);
        if (col >= 0) onCellEnter(row.id, col);
      }}
      onMouseUp={() => {
        onCellUp();
        onLevelUp();
      }}
      onContextMenu={(e) => {
        if (row.levels.length > 0) onLevelClear(e, row.id);
      }}
      // A cell drag that leaves the row is a selection GROWING onto the
      // next row, not one ending: only the level drag (which belongs to
      // this row's line) stops at the row's edge. The cell drag is ended
      // by the window's mouse-up instead.
      onMouseLeave={() => {
        onLevelUp();
      }}
      onClick={(e) => {
        const col = colOf(e);
        if (col >= 0) onCellClick(e, row.id, col);
      }}
    >
      {/* The clips, drawn as blocks BEHIND the cells: one run per copy,
          with its waveform inside it. */}
      {clip &&
        row.placements.map((start) => {
          const span = placementSpan(clip, start);
          // Off the window: not drawn at all. A clip block carries a
          // waveform of a couple of hundred points, and a set's worth of
          // them is what the scroll was rasterising every frame.
          if (span.end <= visible.start || span.start >= visible.end) return null;
          return (
            <div
              className="grid-clip"
              data-testid={`grid-clip-${row.id}-${start}`}
              key={start}
              style={{ left: beatsWide(span.start), width: beatsWide(span.end - span.start) }}
            >
              <ClipWave peaks={peaks} />
              {clip.ones.map((beat) => (
                <span
                  className="grid-clip-one"
                  data-lead={beat === leadOne(clip) ? 'true' : 'false'}
                  key={beat}
                  style={{ left: beatsWide(beat) }}
                />
              ))}
            </div>
          );
        })}

      <LevelLine row={row} columns={columns} />

      {/* The beats before the window, as one blank of their width. */}
      <span className="grid-gap" style={{ width: beatsWide(visible.start) }} />

      {Array.from({ length: Math.max(0, visible.end - visible.start) }, (_, i) => {
        const col = visible.start + i;
        const kind = clip ? cellKind(row, clip, col) : 'empty';
        const hit = clip ? placementAt(row, clip, col) : -1;
        const span = hit >= 0 && clip ? placementSpan(clip, row.placements[hit]) : null;
        return (
          <button
            className="grid-cell"
            data-testid={`grid-cell-${row.id}-${col}`}
            data-col={col}
            data-kind={kind}
            // THE ONE, marked the whole way down the grid and not only
            // where a clip sits: an empty downbeat is still the beat you
            // count from.
            data-downbeat={col % barBeats === 0 ? 'true' : 'false'}
            data-edge={
              span ? (span.start === col ? 'start' : span.end - 1 === col ? 'end' : 'mid') : 'none'
            }
            // THE LOOP IS AN EDGE, not a wash. Colouring every looped
            // column tinted half the arrangement and buried the clips
            // under it; what actually has to be legible is where the loop
            // BEGINS and ENDS, so those two cells carry the same bright
            // purple the ruler's handles do and the rest is left alone.
            data-loop-edge={loopEdge(loop, col)}
            data-selected={
              selection && col >= selection.start && col < selection.end ? 'true' : 'false'
            }
            aria-label={`Row ${row.id}, beat ${col + 1}`}
            key={col}
          />
        );
      })}
    </div>
  );
});
