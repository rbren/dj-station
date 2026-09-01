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
// that copy away again.
//
// TEMPO is master automation over the same columns (`AutomationLane`,
// the Clip page's level-lane control): flat at the base bpm until you
// draw on it, and every beat->time conversion below integrates it, so a
// ramp plays in tune with the grid rather than drifting off it.
//
// PLAYBACK is the webview's, not the engine's (`GridTransport`): the grid
// is an arrangement of rendered clips, so it schedules decoded buffers on
// the audio clock. Dragging across the ruler marks a LOOP; the playhead
// walks the loop if there is one and the whole grid otherwise.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { beatClip as defaultClips, type BeatClipApi, type BeatClipEntry } from '../beatClip';
import { MAX_BPM, MIN_BPM } from '../decks';
import { fixed } from '../format';
import {
  addRow,
  bpmAt,
  cellKind,
  clampBpm,
  clearRow,
  clearTempo,
  emptyGrid,
  gridColumns,
  groupRows,
  GRID_GROW_BEATS,
  GRID_MIN_BEATS,
  inRange,
  loopFromDrag,
  moveTempoPoint,
  placeClip,
  playRange,
  removeRow,
  removeTempoPoint,
  setTempoPoint,
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

/** The bpm rules the tempo lane marks. */
const BPM_TICKS = [60, 90, 120, 150, 180];
/** What the lane's vertical axis spans — the useful part of MIN..MAX. */
const LANE_MIN_BPM = 40;
const LANE_MAX_BPM = 200;

export interface GridViewProps {
  clips?: BeatClipApi;
  /** The page polls the playhead only while it is the open tab. */
  active?: boolean;
  pollMs?: number;
  /** Substituted in tests; the real one plays through Web Audio. */
  transport?: GridTransport;
}

export function GridView(props: GridViewProps) {
  const clipApi = props.clips ?? defaultClips;
  const active = props.active ?? true;
  const [grid, setGrid] = useState<GridState>(() => emptyGrid());
  const [clips, setClips] = useState<BeatClipEntry[]>([]);
  const [picking, setPicking] = useState(false);
  const [playhead, setPlayhead] = useState<{ playing: boolean; column: number }>({
    playing: false,
    column: 0,
  });
  const transport = useMemo(
    () => props.transport ?? new GridTransport(clipApi),
    [props.transport, clipApi],
  );
  const loopDrag = useRef<number | null>(null);

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
  // deck the room is listening to. The transport is the only thing the
  // effect touches — what the page DRAWS follows from `active` below, so
  // coming back re-reads the truth off the transport rather than trusting
  // a flag written on the way out.
  useEffect(() => {
    if (!active) transport.stop();
  }, [active, transport]);

  const addClips = useCallback((picked: BeatClipEntry[]) => {
    setPicking(false);
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

  const stop = useCallback(() => {
    transport.stop();
    setPlayhead({ playing: false, column: range.start });
  }, [transport, range.start]);

  const tempoPoints: LanePoint[] = useMemo(
    () => grid.tempo.points.map((p) => ({ at: p.beat, value: p.bpm })),
    [grid.tempo.points],
  );

  // A page that is not looking is not playing, whatever the last poll
  // said — the effect above has already stopped the transport.
  const playing = active && playhead.playing;
  const nowCol = Math.floor(playhead.column);

  return (
    <div
      className="grid-view"
      data-testid="grid-view"
      style={active ? undefined : { display: 'none' }}
    >
      <header className="grid-bar">
        <div className="grid-transport">
          <button
            className={`decks-btn decks-btn-start${playing ? ' is-on' : ''}`}
            data-testid="grid-play"
            aria-pressed={playing}
            onClick={() => play()}
          >
            Play
          </button>
          <button
            className={`decks-btn${playing ? '' : ' is-on'}`}
            data-testid="grid-stop"
            aria-pressed={!playing}
            onClick={stop}
          >
            Stop
          </button>
          <button
            className="decks-btn"
            data-testid="grid-rewind"
            title="Back to the start of the play range"
            onClick={() =>
              playing
                ? play(range.start)
                : setPlayhead({ playing: false, column: range.start })
            }
          >
            ⏮
          </button>
          <span className="grid-position mono" data-testid="grid-position">
            beat {Math.floor(playhead.column) + 1}/{columns}
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
          <span className="grid-loop-readout mono" data-testid="grid-loop">
            {grid.loop
              ? `loop ${grid.loop.start + 1}–${grid.loop.end}`
              : 'no loop — drag the ruler'}
          </span>
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
          <button
            className="decks-btn"
            data-testid="grid-shorten"
            aria-label="Fewer beats"
            disabled={grid.beats <= GRID_MIN_BEATS}
            onClick={() =>
              setGrid((prev) => ({
                ...prev,
                beats: Math.max(GRID_MIN_BEATS, prev.beats - GRID_GROW_BEATS),
              }))
            }
          >
            −
          </button>
          <span className="mono" data-testid="grid-beats">
            {columns} beats
          </span>
          <button
            className="decks-btn"
            data-testid="grid-lengthen"
            aria-label="More beats"
            onClick={() => setGrid((prev) => ({ ...prev, beats: prev.beats + GRID_GROW_BEATS }))}
          >
            +
          </button>
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
            <button className="decks-btn" data-testid="grid-add" onClick={() => setPicking(true)}>
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
                    >
                      {Array.from({ length: columns }, (_, col) => {
                        const kind = clip ? cellKind(row, clip, col) : 'empty';
                        return (
                          <button
                            className="grid-cell"
                            data-testid={`grid-cell-${row.id}-${col}`}
                            data-kind={kind}
                            data-now={playing && col === nowCol ? 'true' : 'false'}
                            data-loop={grid.loop && inRange(range, col) ? 'true' : 'false'}
                            aria-label={`Row ${row.id}, beat ${col + 1}`}
                            key={col}
                            style={{ width: GRID_CELL_W }}
                            onClick={() => clickCell(row.id, col)}
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

      {picking && (
        <GridClipPicker clips={clips} onPick={addClips} onClose={() => setPicking(false)} />
      )}
    </div>
  );
}
