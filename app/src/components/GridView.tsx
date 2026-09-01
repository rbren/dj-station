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
// its next beat. Dragging across the ruler marks a loop; dragging across
// the cells marks a selection, which copies and pastes at the playhead.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { beatClip as defaultClips, type BeatClipApi, type BeatClipEntry } from '../beatClip';
import { MAX_BPM, MIN_BPM } from '../decks';
import { fixed } from '../format';
import { isEditableTarget } from '../fileShortcuts';
import {
  addRow,
  cellKind,
  clampBpm,
  clearRow,
  copySelection,
  deleteSelection,
  emptyGrid,
  fromDocument,
  gridColumns,
  groupRows,
  inRange,
  isEmptyGrid,
  leadOne,
  loopFromDrag,
  moveLevelPoint,
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
import { GridTransport } from '../gridTransport';
import { AutomationLane, type LanePoint } from './AutomationLane';
import { GridClipPicker } from './GridClipPicker';

/** Column width in px at 1×. The grid zooms about this. */
export const GRID_CELL_W = 22;
export const GRID_LANE_H = 96;

/** How far the grid can be zoomed, as a multiple of `GRID_CELL_W`. Out
 *  far enough to see an arrangement whole, in far enough to place a clip
 *  against a beat without squinting. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
const ZOOM_STEP = 1.15;

/** One notch of the wheel, as a zoom factor. */
export function zoomBy(zoom: number, deltaY: number): number {
  const next = deltaY < 0 ? zoom * ZOOM_STEP : zoom / ZOOM_STEP;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
}

/** Shared so a row with no peaks yet keeps the SAME array between
 *  renders: a fresh `[]` would be a new prop and would defeat the memo. */
const EMPTY_PEAKS: readonly number[] = [];

/** How close to an edge counts as GRABBING it, in beats. A fixed pixel
 *  target would be most of a bar when zoomed out and invisible when
 *  zoomed in, so it is measured in beats and widened as they narrow. */
export function grabBeats(zoom: number): number {
  return Math.max(1, Math.round(0.5 / zoom));
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

/** The bpm rules the tempo lane marks. */
const BPM_TICKS = [60, 90, 120, 150, 180];
/** What the lane's vertical axis spans — the useful part of MIN..MAX. */
const LANE_MIN_BPM = 40;
const LANE_MAX_BPM = 200;

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
  | { kind: 'saveAs'; name: string }
  | { kind: 'open'; names: string[] }
  | { kind: 'confirm'; message: string; proceed: () => void }
  | null;

export function GridView(props: GridViewProps) {
  const clipApi = props.clips ?? defaultClips;
  const active = props.active ?? true;
  const [grid, setGrid] = useState<GridState>(() => emptyGrid());
  const [clips, setClips] = useState<BeatClipEntry[]>([]);
  const [peaks, setPeaks] = useState<Record<string, readonly number[]>>({});
  const [dialog, setDialog] = useState<Dialog>(null);
  const [name, setName] = useState('untitled');
  const [saved, setSaved] = useState<string | null>(null);
  const [selection, setSelection] = useState<GridSelection | null>(null);
  const [board, setBoard] = useState<GridClipboard | null>(null);
  const [fileMenu, setFileMenu] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [playhead, setPlayhead] = useState<{ playing: boolean; column: number }>({
    playing: false,
    column: 0,
  });
  const transport = useMemo(
    () => props.transport ?? new GridTransport(clipApi),
    [props.transport, clipApi],
  );
  /** The loop drag in flight: the edge held STILL, and whether the
   *  pointer has moved since the press. */
  const loopDrag = useRef<{ anchor: number; moved: boolean } | null>(null);
  const cellDrag = useRef<{ rowId: string; col: number } | null>(null);
  const levelDrag = useRef<{ rowId: string; beat: number } | null>(null);

  useEffect(() => () => transport.dispose(), [transport]);

  useEffect(() => {
    let live = true;
    void clipApi.list().then((list) => {
      if (live && list) setClips(list);
    });
    return () => {
      live = false;
    };
  }, [clipApi]);

  const byId = useMemo(() => new Map(clips.map((c) => [c.clipId, c])), [clips]);
  const columns = useMemo(() => gridColumns(grid, byId), [grid, byId]);
  const groups = useMemo(() => groupRows(grid.rows, byId), [grid.rows, byId]);
  const range = useMemo(() => playRange(grid, columns), [grid, columns]);
  const cellW = GRID_CELL_W * zoom;
  const width = columns * cellW;

  /** The scrolling box the grid lives in, and the beat a zoom should
   *  hold still under the pointer. */
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
  useEffect(() => {
    const hold = keepBeat.current;
    const box = scroller.current;
    keepBeat.current = null;
    if (!hold || !box) return;
    box.scrollLeft = Math.max(0, hold.beat * cellW - hold.x);
  }, [cellW]);

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

  // EVERY EDIT REACHES THE TRANSPORT. This is what makes the grid live:
  // the transport decides for itself what a given change means (a new
  // placement is laid down on its own beat; a tempo or loop change
  // re-cues), so the page just tells it the truth after every edit.
  useEffect(() => {
    transport.update(grid, byId, columns);
  }, [transport, grid, byId, columns]);

  const dirty = saved !== JSON.stringify(toDocument(grid));

  const addClips = useCallback((picked: BeatClipEntry[]) => {
    setDialog(null);
    setGrid((prev) => picked.reduce((state, clip) => addRow(state, clip), prev));
  }, []);

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
    [byId],
  );

  // The row's handlers. They are held HERE, and stable, because each one
  // is a prop of a memoised row: a handler rebuilt every render would
  // make every row re-render every time and undo the memo entirely. The
  // grid's own state is reached through the setter's callback form, and
  // what a handler needs to read (`selection`) it reads from a ref.
  // Written in an effect, not in the render body: a render React
  // discards must not leave these pointing at state that never landed.
  const selectionRef = useRef<GridSelection | null>(null);
  const rowsRef = useRef<GridRow[]>(grid.rows);
  useEffect(() => {
    selectionRef.current = selection;
    rowsRef.current = grid.rows;
  }, [selection, grid.rows]);

  const onCellDown = useCallback((_e: MouseEvent<HTMLElement>, rowId: string, col: number) => {
    cellDrag.current = { rowId, col };
    setSelection(null);
  }, []);

  const onCellEnter = useCallback((rowId: string, col: number) => {
    const from = cellDrag.current;
    if (!from) return;
    setSelection(selectionFromDrag(rowsRef.current, from.rowId, from.col, rowId, col));
  }, []);

  const onCellUp = useCallback(() => {
    cellDrag.current = null;
  }, []);

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

  const onLevelDown = useCallback((e: MouseEvent<HTMLElement>, rowId: string) => {
    e.preventDefault();
    const { beat, level } = levelFromPointer(
      e,
      e.currentTarget.getBoundingClientRect(),
      zoomRef.current,
    );
    levelDrag.current = { rowId, beat };
    setGrid((prev) => ({
      ...prev,
      rows: prev.rows.map((r) => (r.id === rowId ? setLevelPoint(r, beat, level) : r)),
    }));
  }, []);

  const onLevelMove = useCallback((e: MouseEvent<HTMLElement>, rowId: string) => {
    const drag = levelDrag.current;
    if (!drag || drag.rowId !== rowId) return;
    const { beat, level } = levelFromPointer(
      e,
      e.currentTarget.getBoundingClientRect(),
      zoomRef.current,
    );
    levelDrag.current = { rowId, beat };
    setGrid((prev) => ({
      ...prev,
      rows: prev.rows.map((r) => (r.id === rowId ? moveLevelPoint(r, drag.beat, beat, level) : r)),
    }));
  }, []);

  const onLevelUp = useCallback(() => {
    levelDrag.current = null;
  }, []);

  const onLevelClear = useCallback((e: MouseEvent<HTMLElement>, rowId: string) => {
    e.preventDefault();
    const { beat } = levelFromPointer(e, e.currentTarget.getBoundingClientRect(), zoomRef.current);
    setGrid((prev) => ({
      ...prev,
      rows: prev.rows.map((r) => (r.id === rowId ? removeLevelPoint(r, beat) : r)),
    }));
  }, []);

  const play = useCallback(
    (from?: number) => {
      void transport.play(grid, byId, columns, from);
      setPlayhead({ playing: true, column: from ?? range.start });
    },
    [transport, grid, byId, columns, range.start],
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

  /** Move the playhead by whole beats, playing or not: a seek while the
   *  music runs re-cues there, which is what a scrub means. */
  const seekBy = useCallback(
    (delta: number) => {
      const at = Math.min(Math.max(playhead.column + delta, range.start), range.end - 1);
      if (playhead.playing) play(at);
      else {
        transport.seek(at);
        setPlayhead({ playing: false, column: at });
      }
    },
    [playhead, range, play, transport],
  );

  const seekTo = useCallback(
    (col: number) => {
      const at = Math.min(Math.max(col, range.start), range.end - 1);
      if (playhead.playing) play(at);
      else {
        transport.seek(at);
        setPlayhead({ playing: false, column: at });
      }
    },
    [playhead.playing, range, play, transport],
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
  }, [board, byId, playhead.column]);

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
      setGrid(emptyGrid());
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
        setGrid(state);
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
  ]);

  const tempoPoints: LanePoint[] = useMemo(
    () => grid.tempo.points.map((p) => ({ at: p.beat, value: p.bpm })),
    [grid.tempo.points],
  );

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
            title={`Paste at the selection, or at the playhead (${MOD}V)`}
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
            value={Number(grid.tempo.bpm.toFixed(2))}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next))
                setGrid((prev) => ({ ...prev, tempo: { ...prev.tempo, bpm: clampBpm(next) } }));
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
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next)) setGrid((prev) => ({ ...prev, barBeats: clampBar(next) }));
            }}
          />
        </div>
        <div className="grid-zoom">
          <button
            className="decks-btn"
            data-testid="grid-zoom-out"
            aria-label="Zoom out"
            title="Zoom out (or scroll over the ruler)"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((z) => zoomBy(z, 1))}
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
            title="Zoom in (or scroll over the ruler)"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((z) => zoomBy(z, -1))}
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
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next))
                setGrid((prev) => ({ ...prev, beats: Math.max(1, Math.round(next)) }));
            }}
          />
          {columns > grid.beats && (
            <span className="grid-beats-note mono" title="A clip is placed past the grid's end">
              {columns} used
            </span>
          )}
        </div>
      </header>

      <div className="grid-body" data-testid="grid-body">
        <div className="grid-gutter">
          <div className="grid-gutter-head">master</div>
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

        <div className="grid-scroll" data-testid="grid-scroll" ref={scroller}>
          <div className="grid-lanes" style={{ width }}>
            {/* MASTER TEMPO over the same columns as the grid below it. */}
            <AutomationLane
              testId="grid-tempo-lane"
              ariaLabel="Master tempo automation"
              width={width}
              height={GRID_LANE_H}
              domain={columns}
              min={LANE_MIN_BPM}
              max={LANE_MAX_BPM}
              base={grid.tempo.bpm}
              points={tempoPoints}
              ticks={BPM_TICKS}
              quantize={(v) => Math.round(v * 2) / 2}
              label={(v) => `${v}`}
              onAdd={(at, value) =>
                setGrid((prev) => ({ ...prev, tempo: setTempoPoint(prev.tempo, at, value) }))
              }
              onMove={(fromAt, at, value) =>
                setGrid((prev) => ({
                  ...prev,
                  tempo: moveTempoPoint(prev.tempo, fromAt, at, value),
                }))
              }
              onRemove={(at) =>
                setGrid((prev) => ({ ...prev, tempo: removeTempoPoint(prev.tempo, at) }))
              }
            />

            {/* THE RULER: bar numbers, the drag that marks a loop, and
                the wheel that zooms. */}
            <div
              className="grid-ruler"
              data-testid="grid-ruler"
              onMouseDown={(e) => {
                const col = colAt(e.clientX, e.currentTarget.getBoundingClientRect());
                // A press on a loop EDGE takes hold of that edge and
                // leaves the other one where it is, so a loop can be
                // stretched a beat at a time instead of being redrawn
                // from scratch every time it is not quite right.
                const edge = loopEdgeAt(grid.loop, col, grabBeats(zoom));
                loopDrag.current = edge
                  ? {
                      anchor: edge === 'start' ? grid.loop!.end - 1 : grid.loop!.start,
                      moved: true,
                    }
                  : { anchor: col, moved: false };
                if (edge)
                  setGrid((prev) => ({
                    ...prev,
                    loop: loopFromDrag(loopDrag.current!.anchor, col),
                  }));
                else setGrid((prev) => ({ ...prev, loop: loopFromDrag(col, col) }));
              }}
              onMouseMove={(e) => {
                const drag = loopDrag.current;
                if (!drag) return;
                const col = colAt(e.clientX, e.currentTarget.getBoundingClientRect());
                drag.moved = true;
                setGrid((prev) => ({ ...prev, loop: loopFromDrag(drag.anchor, col) }));
              }}
              onMouseUp={() => {
                loopDrag.current = null;
              }}
              onMouseLeave={() => {
                loopDrag.current = null;
              }}
              // THE WHEEL ZOOMS while the pointer is over the ruler, which
              // is the one strip of the page with nothing to scroll.
              onWheel={(e) => {
                if (e.deltaY === 0) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                const beat = (e.clientX - rect.left + scrollLeft()) / cellW;
                const next = zoomBy(zoom, e.deltaY);
                setZoom(next);
                // Hold the beat under the pointer STILL, so zooming reads
                // as the grid growing around it rather than the view
                // jumping somewhere else.
                keepBeat.current = { beat, x: e.clientX - rect.left };
              }}
            >
              {Array.from({ length: columns }, (_, col) => (
                <span
                  className="grid-ruler-cell"
                  data-testid={`grid-ruler-${col}`}
                  data-bar={col % grid.barBeats === 0 ? 'true' : 'false'}
                  data-loop={inRange(range, col) && grid.loop ? 'true' : 'false'}
                  key={col}
                  style={{ width: cellW }}
                >
                  {col % grid.barBeats === 0 && cellW * grid.barBeats >= 18
                    ? col / grid.barBeats + 1
                    : ''}
                </span>
              ))}
              {/* The loop's edges, as handles you can take hold of. */}
              {grid.loop && (
                <>
                  <span
                    className="grid-loop-handle"
                    data-testid="grid-loop-handle-start"
                    data-edge="start"
                    style={{ left: grid.loop.start * cellW }}
                  />
                  <span
                    className="grid-loop-handle"
                    data-testid="grid-loop-handle-end"
                    data-edge="end"
                    style={{ left: grid.loop.end * cellW }}
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
                    cellW={cellW}
                    barBeats={grid.barBeats}
                    peaks={peaks[row.clipId] ?? EMPTY_PEAKS}
                    loop={grid.loop ? range : null}
                    selection={selectionFor(selection, row.id)}
                    onCellDown={onCellDown}
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
                without a single row re-rendering. */}
            {playing && (
              <>
                <div
                  className="grid-now"
                  data-testid="grid-now"
                  style={{ left: nowCol * cellW, width: cellW }}
                />
                <div
                  className="grid-playhead"
                  data-testid="grid-playhead"
                  style={{ left: playhead.column * cellW }}
                />
              </>
            )}
          </div>
          {grid.rows.length === 0 && (
            <p className="empty-state" data-testid="grid-empty">
              Nothing on the grid yet. Add a beat clip — a whole track, or one clip inside it — then
              click a cell to place it: its first one lands on the beat you click.
            </p>
          )}
        </div>
      </div>

      {dialog?.kind === 'pick' && (
        <GridClipPicker clips={clips} onPick={addClips} onClose={() => setDialog(null)} />
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
function LevelLine({
  row,
  columns,
  cellW,
}: {
  row: GridState['rows'][number];
  columns: number;
  cellW: number;
}) {
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
      style={{ width: columns * cellW }}
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
          style={{ left: p.beat * cellW, top: `${y(p.level)}%` }}
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

interface RowCellsProps {
  row: GridRow;
  clip: BeatClipEntry | undefined;
  columns: number;
  cellW: number;
  barBeats: number;
  peaks: readonly number[];
  /** The play range, when a loop is set — else null. */
  loop: ColumnRange | null;
  /** This row's slice of the selection, or null. */
  selection: ColumnRange | null;
  onCellDown: (e: MouseEvent<HTMLElement>, rowId: string, col: number) => void;
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
 *  difference between 200 closures per render and 60,000. */
const GridRowCells = memo(function GridRowCells({
  row,
  clip,
  columns,
  cellW,
  barBeats,
  peaks,
  loop,
  selection,
  onCellDown,
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
        // cmd/ctrl writes on the level line; a bare press is the grid's.
        if (e.metaKey || e.ctrlKey) {
          onLevelDown(e, row.id);
          return;
        }
        const col = colOf(e);
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
      onMouseLeave={() => {
        onCellUp();
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
          return (
            <div
              className="grid-clip"
              data-testid={`grid-clip-${row.id}-${start}`}
              key={start}
              style={{ left: span.start * cellW, width: (span.end - span.start) * cellW }}
            >
              <ClipWave peaks={peaks} />
              {clip.ones.map((beat) => (
                <span
                  className="grid-clip-one"
                  data-lead={beat === leadOne(clip) ? 'true' : 'false'}
                  key={beat}
                  style={{ left: beat * cellW }}
                />
              ))}
            </div>
          );
        })}

      <LevelLine row={row} columns={columns} cellW={cellW} />

      {Array.from({ length: columns }, (_, col) => {
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
            data-loop={loop && col >= loop.start && col < loop.end ? 'true' : 'false'}
            data-selected={
              selection && col >= selection.start && col < selection.end ? 'true' : 'false'
            }
            aria-label={`Row ${row.id}, beat ${col + 1}`}
            key={col}
            style={{ width: cellW }}
          />
        );
      })}
    </div>
  );
});
