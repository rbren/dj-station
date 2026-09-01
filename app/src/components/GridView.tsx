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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { beatClip as defaultClips, type BeatClipApi, type BeatClipEntry } from '../beatClip';
import { MAX_BPM, MIN_BPM } from '../decks';
import { fixed } from '../format';
import { isEditableTarget } from '../fileShortcuts';
import {
  addRow,
  bpmAt,
  cellKind,
  clampBpm,
  clearRow,
  clearTempo,
  copySelection,
  deleteSelection,
  emptyGrid,
  fromDocument,
  gridColumns,
  groupRows,
  GRID_MIN_BEATS,
  inRange,
  inSelection,
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
  selectionFromDrag,
  setLevelPoint,
  setTempoPoint,
  toDocument,
  MAX_LEVEL,
  type GridClipboard,
  type GridSelection,
  type GridState,
} from '../grid';
import { GridTransport } from '../gridTransport';
import { AutomationLane, type LanePoint } from './AutomationLane';
import { GridClipPicker } from './GridClipPicker';

/** Column width in px. Fixed: a beat is a beat, and the page scrolls. */
export const GRID_CELL_W = 22;
export const GRID_LANE_H = 96;
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
  const [peaks, setPeaks] = useState<Record<string, number[]>>({});
  const [dialog, setDialog] = useState<Dialog>(null);
  const [name, setName] = useState('untitled');
  const [saved, setSaved] = useState<string | null>(null);
  const [selection, setSelection] = useState<GridSelection | null>(null);
  const [board, setBoard] = useState<GridClipboard | null>(null);
  const [playhead, setPlayhead] = useState<{ playing: boolean; column: number }>({
    playing: false,
    column: 0,
  });
  const transport = useMemo(
    () => props.transport ?? new GridTransport(clipApi),
    [props.transport, clipApi],
  );
  const loopDrag = useRef<number | null>(null);
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
  const width = columns * GRID_CELL_W;

  // Waveforms for whatever the grid holds. Peaks are a drawing, so they
  // are fetched once per clip and kept: re-placing a clip redraws from
  // what is already here.
  useEffect(() => {
    let live = true;
    const wanted = [...new Set(grid.rows.map((r) => r.clipId))].filter((id) => !(id in peaks));
    if (wanted.length === 0) return;
    void Promise.all(
      wanted.map(async (id) => [id, (await clipApi.peaks(id, PEAK_BUCKETS)) ?? []] as const),
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

  const paste = useCallback(() => {
    if (board) setGrid((prev) => pasteAt(prev, byId, board, Math.round(playhead.column)));
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
      if (e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const back = e.key === 'ArrowLeft';
        if (e.ctrlKey && !e.metaKey) seekTo(back ? range.start : range.end - 1);
        else if (e.metaKey) seekBy(back ? -4 : 4);
        else seekBy(back ? -1 : 1);
      } else if (mod && e.key.toLowerCase() === 'c') {
        copy();
      } else if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        paste();
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && selection) {
        e.preventDefault();
        setGrid((prev) => deleteSelection(prev, byId, selection));
      } else if (e.key === 'Escape') {
        setSelection(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, dialog, toggle, seekBy, seekTo, range, copy, paste, selection, byId]);

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
        <div className="grid-file">
          <span className="grid-name mono" data-testid="grid-name" title="This arrangement">
            {name}
            {dirty ? ' •' : ''}
          </span>
          <button className="decks-btn" data-testid="grid-new" onClick={doNew}>
            New
          </button>
          <button className="decks-btn" data-testid="grid-open" onClick={doOpen}>
            Open
          </button>
          <button className="decks-btn" data-testid="grid-save" onClick={() => void doSave()}>
            Save
          </button>
          <button
            className="decks-btn"
            data-testid="grid-save-as"
            onClick={() => setDialog({ kind: 'saveAs', name })}
          >
            Save As
          </button>
        </div>
        <div className="grid-transport">
          <button
            className={`decks-btn decks-btn-start${playing ? ' is-on' : ''}`}
            data-testid="grid-play"
            aria-pressed={playing}
            onClick={() => play(playhead.column)}
          >
            Play
          </button>
          <button
            className="decks-btn"
            data-testid="grid-pause"
            aria-pressed={!playing}
            disabled={!playing}
            onClick={pause}
          >
            Pause
          </button>
          <button
            className="decks-btn"
            data-testid="grid-rewind"
            title="Back to the start of the play range"
            onClick={() => seekTo(range.start)}
          >
            ⏮
          </button>
          <span className="grid-position mono" data-testid="grid-position">
            beat {Math.floor(playhead.column) + 1}/{columns}
          </span>
          <span className="grid-duration mono" data-testid="grid-duration">
            {columns} beats · {clockTime(totalSecs)}
          </span>
        </div>
        <div className="grid-tempo">
          <label className="decks-tempo-label" htmlFor="grid-bpm">
            master BPM
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
          <span className="grid-bpm-here mono" data-testid="grid-bpm-here">
            {fixed(bpmAt(grid.tempo, playhead.column), 1)} here
          </span>
          <button
            className="decks-btn"
            data-testid="grid-tempo-clear"
            disabled={grid.tempo.points.length === 0}
            title="Drop every tempo breakpoint"
            onClick={() => setGrid((prev) => ({ ...prev, tempo: clearTempo(prev.tempo) }))}
          >
            flat
          </button>
        </div>
        <div className="grid-loop-controls">
          {grid.loop && (
            <span className="grid-loop-readout mono" data-testid="grid-loop">
              {`loop ${grid.loop.start + 1}–${grid.loop.end}`}
            </span>
          )}
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

        <div className="grid-scroll" data-testid="grid-scroll">
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

            {/* THE RULER: bar numbers, and the drag that marks a loop. */}
            <div
              className="grid-ruler"
              data-testid="grid-ruler"
              onMouseDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const col = Math.floor((e.clientX - rect.left) / GRID_CELL_W);
                loopDrag.current = col;
                setGrid((prev) => ({ ...prev, loop: loopFromDrag(col, col) }));
              }}
              onMouseMove={(e) => {
                if (loopDrag.current === null) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const col = Math.floor((e.clientX - rect.left) / GRID_CELL_W);
                const from = loopDrag.current;
                setGrid((prev) => ({ ...prev, loop: loopFromDrag(from, col) }));
              }}
              onMouseUp={() => {
                loopDrag.current = null;
              }}
              onMouseLeave={() => {
                loopDrag.current = null;
              }}
            >
              {Array.from({ length: columns }, (_, col) => (
                <span
                  className="grid-ruler-cell"
                  data-testid={`grid-ruler-${col}`}
                  data-bar={col % 4 === 0 ? 'true' : 'false'}
                  data-loop={inRange(range, col) && grid.loop ? 'true' : 'false'}
                  key={col}
                  style={{ width: GRID_CELL_W }}
                >
                  {col % 4 === 0 ? col / 4 + 1 : ''}
                </span>
              ))}
            </div>

            {groups.map((group) => (
              <div className="grid-group-cells" key={group.key}>
                <div className="grid-group-spacer" />
                {group.rows.map((row) => {
                  const clip = byId.get(row.clipId);
                  return (
                    <div
                      className="grid-row-cells"
                      data-testid={`grid-cells-${row.id}`}
                      key={row.id}
                      // THE LEVEL GESTURE lives on the row, not on the
                      // line: a line a pixel thick is not a hit target,
                      // and the whole row height is what the level is
                      // read against anyway. cmd/ctrl is what tells it
                      // apart from placing a clip.
                      onMouseDown={(e) => {
                        if (!(e.metaKey || e.ctrlKey)) return;
                        e.preventDefault();
                        const { beat, level } = levelFromPointer(
                          e,
                          e.currentTarget.getBoundingClientRect(),
                        );
                        levelDrag.current = { rowId: row.id, beat };
                        setGrid((prev) => ({
                          ...prev,
                          rows: prev.rows.map((r) =>
                            r.id === row.id ? setLevelPoint(r, beat, level) : r,
                          ),
                        }));
                      }}
                      onMouseMove={(e) => {
                        const drag = levelDrag.current;
                        if (!drag || drag.rowId !== row.id) return;
                        const { beat, level } = levelFromPointer(
                          e,
                          e.currentTarget.getBoundingClientRect(),
                        );
                        levelDrag.current = { rowId: row.id, beat };
                        setGrid((prev) => ({
                          ...prev,
                          rows: prev.rows.map((r) =>
                            r.id === row.id ? moveLevelPoint(r, drag.beat, beat, level) : r,
                          ),
                        }));
                      }}
                      onMouseUp={() => {
                        levelDrag.current = null;
                      }}
                      onContextMenu={(e) => {
                        if (row.levels.length === 0) return;
                        e.preventDefault();
                        const { beat } = levelFromPointer(
                          e,
                          e.currentTarget.getBoundingClientRect(),
                        );
                        setGrid((prev) => ({
                          ...prev,
                          rows: prev.rows.map((r) =>
                            r.id === row.id ? removeLevelPoint(r, beat) : r,
                          ),
                        }));
                      }}
                      onMouseLeave={() => {
                        cellDrag.current = null;
                        levelDrag.current = null;
                      }}
                    >
                      {/* The clips, drawn as blocks BEHIND the cells: one
                          run per copy, with its waveform inside it. */}
                      {clip &&
                        row.placements.map((start) => {
                          const span = placementSpan(clip, start);
                          const shape = peaks[row.clipId] ?? [];
                          return (
                            <div
                              className="grid-clip"
                              data-testid={`grid-clip-${row.id}-${start}`}
                              key={start}
                              style={{
                                left: span.start * GRID_CELL_W,
                                width: (span.end - span.start) * GRID_CELL_W,
                              }}
                            >
                              <ClipWave peaks={shape} />
                              {/* The ones, marked inside the block. */}
                              {clip.ones.map((beat) => (
                                <span
                                  className="grid-clip-one"
                                  data-lead={beat === leadOne(clip) ? 'true' : 'false'}
                                  key={beat}
                                  style={{ left: beat * GRID_CELL_W }}
                                />
                              ))}
                            </div>
                          );
                        })}

                      {/* The row's LEVEL LINE, through its middle. */}
                      <LevelLine row={row} columns={columns} />

                      {Array.from({ length: columns }, (_, col) => {
                        const kind = clip ? cellKind(row, clip, col) : 'empty';
                        const hit = clip ? placementAt(row, clip, col) : -1;
                        const span =
                          hit >= 0 && clip ? placementSpan(clip, row.placements[hit]) : null;
                        return (
                          <button
                            className="grid-cell"
                            data-testid={`grid-cell-${row.id}-${col}`}
                            data-kind={kind}
                            data-edge={
                              span
                                ? span.start === col
                                  ? 'start'
                                  : span.end - 1 === col
                                    ? 'end'
                                    : 'mid'
                                : 'none'
                            }
                            data-now={playing && col === nowCol ? 'true' : 'false'}
                            data-loop={grid.loop && inRange(range, col) ? 'true' : 'false'}
                            data-selected={inSelection(selection, row.id, col) ? 'true' : 'false'}
                            aria-label={`Row ${row.id}, beat ${col + 1}`}
                            key={col}
                            style={{ width: GRID_CELL_W }}
                            onMouseDown={(e) => {
                              // cmd/ctrl is the level line's gesture, not
                              // the grid's.
                              if (e.metaKey || e.ctrlKey) return;
                              cellDrag.current = { rowId: row.id, col };
                              setSelection(null);
                            }}
                            onMouseEnter={() => {
                              const from = cellDrag.current;
                              if (!from) return;
                              setSelection(
                                selectionFromDrag(grid.rows, from.rowId, from.col, row.id, col),
                              );
                            }}
                            onMouseUp={() => {
                              cellDrag.current = null;
                            }}
                            // PLACING stays on click, which fires only
                            // when press and release share a cell. A drag
                            // that crossed cells has made a selection by
                            // now, and a selection is not a placement.
                            onClick={(e) => {
                              if (e.metaKey || e.ctrlKey || selection) return;
                              clickCell(row.id, col);
                            }}
                          />
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ))}

            {playing && (
              <div
                className="grid-playhead"
                data-testid="grid-playhead"
                style={{ left: playhead.column * GRID_CELL_W }}
              />
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
                <button
                  data-testid={`grid-open-${n}`}
                  key={n}
                  onClick={() => void openNamed(n)}
                >
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
): { beat: number; level: number } {
  const beat = Math.max(0, Math.round((e.clientX - rect.left) / GRID_CELL_W));
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
}: {
  row: GridState['rows'][number];
  columns: number;
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
      style={{ width: columns * GRID_CELL_W }}
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
          style={{ left: p.beat * GRID_CELL_W, top: `${y(p.level)}%` }}
        />
      ))}
    </div>
  );
}


