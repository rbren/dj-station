// Custom panel body for the built-in Choreography module: a beat-indexed
// multi-track timeline (hundreds/thousands of beats) with one output jack
// per track. A shared beat ruler + grid overlays every lane inside one
// horizontally scrolling viewport; the track name column stays pinned via
// position: sticky. Track rows drag to reorder vertically (jacks stay with
// their tracks). Lane interactions:
//   - boolean: click a cell to toggle (drag paints the initial state).
//   - continuous: click/drag draws the -10..+10 V curve.
//   - note: click toggles the note at that beat/row (one note per beat);
//     cmd/ctrl+click then vertical drag sets that note's velocity.

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePoll } from '../usePoll';
import { forwardCycle } from '../../../extensions/ui-lib/stepFollower';
import { useStepFollowers } from '../../../extensions/ui-lib/useStepFollower';
import type { ChoreoStatus, ChoreoTrack, NoteStep } from '../engine';

/** IPC surface the panel needs; RackModule adapts EngineClient onto this. */
export interface ChoreoApi {
  status(instance: string): Promise<ChoreoStatus | null>;
  setBeats(instance: string, beats: number): Promise<unknown>;
  addTrack(instance: string, name: string, kind: string): Promise<unknown>;
  removeTrack(instance: string, track: number): Promise<unknown>;
  renameTrack(instance: string, track: number, name: string): Promise<unknown>;
  moveTrack(instance: string, from: number, to: number): Promise<unknown>;
  setBool(instance: string, track: number, beat: number, on: boolean): Promise<unknown>;
  setValues(instance: string, track: number, start: number, values: number[]): Promise<unknown>;
  setNote(instance: string, track: number, beat: number, note: NoteStep | null): Promise<unknown>;
  setNoteSettings(
    instance: string,
    track: number,
    octaves: number,
    scale: string,
    baseNote: number,
  ): Promise<unknown>;
  endEdit(): Promise<unknown>;
}

export interface ChoreoPanelProps {
  instance: string;
  api: ChoreoApi;
  /** Called after any track add/remove/rename so the rack refreshes jacks. */
  onChanged(): void;
  /** Playhead poll interval in ms (tests dial it down). */
  pollMs?: number;
}

export const BEAT_W = 14;
const LABEL_W = 116;
const BOOL_H = 26;
const CONT_H = 56;
const NOTE_ROW_H = 12;
const VIEW_W = 560;

/** Must mirror `SCALES` in crates/dj-engine/src/choreo.rs (pinned by
 *  ChoreoPanel.test.tsx + the display_units convention). */
export const CHOREO_SCALES: Record<string, number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  'harm minor': [0, 2, 3, 5, 7, 8, 11],
  'penta maj': [0, 2, 4, 7, 9],
  'penta min': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  'whole tone': [0, 2, 4, 6, 8, 10],
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI note -> display name ("C4" = 60). */
export function noteName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Row label for a note-grid degree above the base note. */
export function degreeName(scale: string, baseNote: number, degree: number): string {
  const iv = CHOREO_SCALES[scale] ?? CHOREO_SCALES.chromatic;
  const semis = iv[degree % iv.length] + 12 * Math.floor(degree / iv.length);
  return noteName(baseNote + semis);
}

function trackHeight(t: ChoreoTrack): number {
  if (t.data.kind === 'boolean') return BOOL_H;
  if (t.data.kind === 'continuous') return CONT_H;
  const rows = (CHOREO_SCALES[t.data.scale] ?? CHOREO_SCALES.chromatic).length * t.data.octaves;
  return rows * NOTE_ROW_H;
}

/** Vertical beat grid lines for one lane (heavy line every 4 beats). */
function GridLines({ beats, height }: { beats: number; height: number }) {
  const lines = [];
  for (let b = 0; b <= beats; b++) {
    lines.push(
      <line
        key={b}
        x1={b * BEAT_W}
        x2={b * BEAT_W}
        y1={0}
        y2={height}
        className={b % 4 === 0 ? 'choreo-grid-bar' : 'choreo-grid-beat'}
      />,
    );
  }
  return <g>{lines}</g>;
}

interface LaneProps {
  instance: string;
  index: number;
  track: ChoreoTrack;
  beats: number;
  api: ChoreoApi;
  refresh(): void;
}

function BooleanLane({ instance, index, track, beats, api, refresh }: LaneProps) {
  const steps = track.data.kind === 'boolean' ? track.data.steps : [];
  // Drag paints with the value the first toggled cell got.
  const paint = useRef<{ on: boolean; last: number } | null>(null);
  const beatAt = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(beats - 1, Math.floor((e.clientX - rect.left) / BEAT_W)));
  };
  return (
    <svg
      width={beats * BEAT_W}
      height={BOOL_H}
      className="choreo-lane"
      data-testid={`choreo-lane-${instance}-${index}`}
      onPointerDown={(e) => {
        const b = beatAt(e);
        const on = !steps[b];
        paint.current = { on, last: b };
        void api.setBool(instance, index, b, on).then(refresh);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!paint.current) return;
        const b = beatAt(e);
        if (b === paint.current.last) return;
        paint.current.last = b;
        void api.setBool(instance, index, b, paint.current.on).then(refresh);
      }}
      onPointerUp={() => {
        paint.current = null;
        void api.endEdit();
      }}
    >
      <GridLines beats={beats} height={BOOL_H} />
      {steps.map((on, b) =>
        on ? (
          <rect
            key={b}
            x={b * BEAT_W + 1}
            y={2}
            width={BEAT_W - 2}
            height={BOOL_H - 4}
            className="choreo-bool-on"
            data-testid={`choreo-bool-${instance}-${index}-${b}`}
          />
        ) : null,
      )}
    </svg>
  );
}

function ContinuousLane({ instance, index, track, beats, api, refresh }: LaneProps) {
  const values = track.data.kind === 'continuous' ? track.data.values : [];
  const drawing = useRef(false);
  const yToVolts = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / CONT_H));
    return Math.round((frac * 20 - 10) * 10) / 10;
  };
  const beatAt = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(beats - 1, Math.floor((e.clientX - rect.left) / BEAT_W)));
  };
  const drawAt = (e: React.PointerEvent<SVGSVGElement>) => {
    void api.setValues(instance, index, beatAt(e), [yToVolts(e)]).then(refresh);
  };
  const y = (v: number) => ((10 - v) / 20) * CONT_H;
  const path = values.map((v, b) => `${b === 0 ? 'M' : 'L'} ${(b + 0.5) * BEAT_W} ${y(v)}`);
  return (
    <svg
      width={beats * BEAT_W}
      height={CONT_H}
      className="choreo-lane"
      data-testid={`choreo-lane-${instance}-${index}`}
      onPointerDown={(e) => {
        drawing.current = true;
        drawAt(e);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drawing.current) drawAt(e);
      }}
      onPointerUp={() => {
        drawing.current = false;
        void api.endEdit();
      }}
    >
      <GridLines beats={beats} height={CONT_H} />
      <line x1={0} x2={beats * BEAT_W} y1={CONT_H / 2} y2={CONT_H / 2} className="choreo-zero" />
      <path d={path.join(' ')} className="choreo-curve" fill="none" />
    </svg>
  );
}

function NoteLane({ instance, index, track, beats, api, refresh }: LaneProps) {
  const data = track.data.kind === 'note' ? track.data : null;
  // cmd/ctrl+drag adjusts the grabbed note's velocity vertically.
  const velDrag = useRef<{ beat: number; degree: number; startY: number; startVel: number } | null>(
    null,
  );
  if (!data) return null;
  const iv = CHOREO_SCALES[data.scale] ?? CHOREO_SCALES.chromatic;
  const rows = iv.length * data.octaves;
  const height = rows * NOTE_ROW_H;
  const cellAt = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const beat = Math.max(0, Math.min(beats - 1, Math.floor((e.clientX - rect.left) / BEAT_W)));
    const row = Math.max(0, Math.min(rows - 1, Math.floor((e.clientY - rect.top) / NOTE_ROW_H)));
    return { beat, degree: rows - 1 - row }; // top row = highest degree
  };
  return (
    <svg
      width={beats * BEAT_W}
      height={height}
      className="choreo-lane"
      data-testid={`choreo-lane-${instance}-${index}`}
      onPointerDown={(e) => {
        const { beat, degree } = cellAt(e);
        const existing = data.steps[beat];
        if (e.metaKey || e.ctrlKey) {
          const startVel = existing && existing.degree === degree ? existing.velocity : 1.0;
          velDrag.current = { beat, degree, startY: e.clientY, startVel };
          void api.setNote(instance, index, beat, { degree, velocity: startVel }).then(refresh);
          e.currentTarget.setPointerCapture(e.pointerId);
          return;
        }
        // Plain click: toggle (same cell clears; anything else sets, since
        // a beat holds at most one note).
        if (existing && existing.degree === degree) {
          void api.setNote(instance, index, beat, null).then(refresh);
        } else {
          void api
            .setNote(instance, index, beat, { degree, velocity: existing?.velocity ?? 1.0 })
            .then(refresh);
        }
      }}
      onPointerMove={(e) => {
        const d = velDrag.current;
        if (!d) return;
        // 100 px of vertical travel spans the full 0..1 velocity range.
        const vel = Math.max(0, Math.min(1, d.startVel + (d.startY - e.clientY) / 100));
        void api
          .setNote(instance, index, d.beat, { degree: d.degree, velocity: vel })
          .then(refresh);
      }}
      onPointerUp={() => {
        velDrag.current = null;
        void api.endEdit();
      }}
    >
      {Array.from({ length: rows }, (_, r) => (
        <line
          key={r}
          x1={0}
          x2={beats * BEAT_W}
          y1={r * NOTE_ROW_H}
          y2={r * NOTE_ROW_H}
          className={(rows - 1 - r) % iv.length === 0 ? 'choreo-grid-octave' : 'choreo-grid-row'}
        />
      ))}
      <GridLines beats={beats} height={height} />
      {data.steps.map((n, b) =>
        n ? (
          <rect
            key={b}
            x={b * BEAT_W + 1}
            y={(rows - 1 - Math.min(n.degree, rows - 1)) * NOTE_ROW_H + 1}
            width={BEAT_W - 2}
            height={NOTE_ROW_H - 2}
            className="choreo-note-on"
            style={{ opacity: 0.35 + 0.65 * n.velocity }}
            data-testid={`choreo-note-${instance}-${index}-${b}`}
            data-degree={n.degree}
            data-velocity={n.velocity.toFixed(2)}
          />
        ) : null,
      )}
    </svg>
  );
}

/** Left column labels for a note track's grid rows (top = highest). */
function NoteRowLabels({ track }: { track: ChoreoTrack }) {
  if (track.data.kind !== 'note') return null;
  const { scale, octaves, base_note } = track.data;
  const iv = CHOREO_SCALES[scale] ?? CHOREO_SCALES.chromatic;
  const rows = iv.length * octaves;
  return (
    <div className="choreo-row-labels">
      {Array.from({ length: rows }, (_, r) => {
        const degree = rows - 1 - r;
        return (
          <span key={r} style={{ height: NOTE_ROW_H }}>
            {degree % iv.length === 0 ? degreeName(scale, base_note, degree) : ''}
          </span>
        );
      })}
    </div>
  );
}

export function ChoreoPanel({ instance, api, onChanged, pollMs = 100 }: ChoreoPanelProps) {
  const [status, setStatus] = useState<ChoreoStatus | null>(null);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('boolean');
  const [settingsFor, setSettingsFor] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const disposedRef = useRef(false);
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    const s = await api.status(instance);
    // Null status is an expected race (module just removed / undo rebuild).
    if (s && !disposedRef.current) setStatus(s);
  }, [api, instance]);

  usePoll(refresh, pollMs);

  const changed = useCallback(() => {
    void refresh();
    onChanged();
  }, [refresh, onChanged]);

  // The playhead is EXTRAPOLATED between status polls: a beat index
  // sampled at ~10 Hz aliases against tempos past a few beats/s — see
  // extensions/ui-lib/stepFollower.ts. Between polls the rAF loop moves
  // the existing playhead div directly (a beat tick must not re-render
  // the whole timeline); the null→visible transition always comes from a
  // poll-driven render, so the patcher only ever moves an existing div.
  const panelRef = useRef<HTMLDivElement>(null);
  const [shownPlayhead] = useStepFollowers(
    [
      {
        cycle: forwardCycle(status?.beats ?? 1),
        sampled: status && status.playhead >= 0 ? status.playhead : null,
      },
    ],
    panelRef,
    (root, values) => {
      const beat = values[0];
      if (beat === null) return;
      const el = root.querySelector<HTMLElement>('.choreo-playhead');
      if (el) el.style.left = `${LABEL_W + beat * BEAT_W}px`;
    },
  );

  if (!status) {
    return (
      <div className="choreo-panel" data-testid={`choreo-panel-${instance}`}>
        loading…
      </div>
    );
  }
  const { beats, tracks } = status;
  const playhead = shownPlayhead ?? -1;
  const totalW = beats * BEAT_W;

  const rulerCells = [];
  for (let b = 0; b < beats; b += 4) {
    rulerCells.push(
      <span key={b} className="choreo-ruler-num" style={{ left: b * BEAT_W }}>
        {b + 1}
      </span>,
    );
  }

  return (
    <div className="choreo-panel" data-testid={`choreo-panel-${instance}`} ref={panelRef}>
      <div className="choreo-toolbar">
        <label>
          beats
          <input
            type="number"
            min={1}
            max={4096}
            value={beats}
            data-testid={`choreo-beats-${instance}`}
            onChange={(e) => {
              const v = Math.max(1, Math.min(4096, Number(e.target.value) || 1));
              void api.setBeats(instance, v).then(changed);
            }}
          />
        </label>
        <input
          placeholder="track name"
          value={newName}
          data-testid={`choreo-new-name-${instance}`}
          onChange={(e) => setNewName(e.target.value)}
        />
        <select
          value={newKind}
          data-testid={`choreo-new-kind-${instance}`}
          onChange={(e) => setNewKind(e.target.value)}
        >
          <option value="boolean">boolean</option>
          <option value="continuous">continuous</option>
          <option value="note">note</option>
        </select>
        <button
          data-testid={`choreo-add-${instance}`}
          disabled={newName.trim() === ''}
          onClick={() => {
            void api.addTrack(instance, newName.trim(), newKind).then(() => {
              setNewName('');
              changed();
            });
          }}
        >
          + track
        </button>
      </div>

      <div className="choreo-scroll" style={{ width: VIEW_W }}>
        <div className="choreo-timeline" style={{ width: LABEL_W + totalW }}>
          <div className="choreo-row choreo-ruler">
            <div className="choreo-label" />
            <div className="choreo-ruler-lane" style={{ width: totalW }}>
              {rulerCells}
            </div>
          </div>

          {tracks.map((t, i) => (
            <div
              key={`${t.jack}`}
              className={`choreo-row${dragOver === i && dragFrom !== null && dragFrom !== i ? ' choreo-row-dragover' : ''}`}
              data-testid={`choreo-track-${instance}-${i}`}
              onPointerEnter={() => {
                if (dragFrom !== null) setDragOver(i);
              }}
            >
              <div className="choreo-label" style={{ height: trackHeight(t) }}>
                <div
                  className="choreo-drag-handle"
                  data-testid={`choreo-drag-${instance}-${i}`}
                  title="drag to reorder"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setDragFrom(i);
                    setDragOver(i);
                    const up = () => {
                      setDragFrom((from) => {
                        setDragOver((over) => {
                          if (from !== null && over !== null && from !== over) {
                            void api.moveTrack(instance, from, over).then(changed);
                          }
                          return null;
                        });
                        return null;
                      });
                      window.removeEventListener('pointerup', up);
                    };
                    window.addEventListener('pointerup', up);
                  }}
                >
                  ⋮⋮
                </div>
                <div className="choreo-label-main">
                  <input
                    className="choreo-name"
                    value={t.name}
                    data-testid={`choreo-name-${instance}-${i}`}
                    onChange={(e) => {
                      void api.renameTrack(instance, i, e.target.value).then(changed);
                    }}
                    onBlur={() => void api.endEdit()}
                  />
                  <span className="choreo-kind">
                    {t.data.kind} → t{t.jack}
                    {t.data.kind === 'note' ? `+t${t.jack + 1}` : ''}
                  </span>
                  <div className="choreo-label-actions">
                    {t.data.kind === 'note' && (
                      <button
                        data-testid={`choreo-settings-${instance}-${i}`}
                        onClick={() => setSettingsFor(settingsFor === i ? null : i)}
                      >
                        ⚙
                      </button>
                    )}
                    <button
                      data-testid={`choreo-remove-${instance}-${i}`}
                      title="remove track"
                      onClick={() => void api.removeTrack(instance, i).then(changed)}
                    >
                      ✕
                    </button>
                  </div>
                  {settingsFor === i && t.data.kind === 'note' && (
                    <div className="choreo-note-settings">
                      <label>
                        oct
                        <select
                          value={t.data.octaves}
                          data-testid={`choreo-octaves-${instance}-${i}`}
                          onChange={(e) => {
                            if (t.data.kind !== 'note') return;
                            void api
                              .setNoteSettings(
                                instance,
                                i,
                                Number(e.target.value),
                                t.data.scale,
                                t.data.base_note,
                              )
                              .then(changed);
                          }}
                        >
                          <option value={1}>1</option>
                          <option value={2}>2</option>
                          <option value={3}>3</option>
                        </select>
                      </label>
                      <label>
                        scale
                        <select
                          value={t.data.scale}
                          data-testid={`choreo-scale-${instance}-${i}`}
                          onChange={(e) => {
                            if (t.data.kind !== 'note') return;
                            void api
                              .setNoteSettings(
                                instance,
                                i,
                                t.data.octaves,
                                e.target.value,
                                t.data.base_note,
                              )
                              .then(changed);
                          }}
                        >
                          {Object.keys(CHOREO_SCALES).map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        base
                        <select
                          value={t.data.base_note}
                          data-testid={`choreo-base-${instance}-${i}`}
                          onChange={(e) => {
                            if (t.data.kind !== 'note') return;
                            void api
                              .setNoteSettings(
                                instance,
                                i,
                                t.data.octaves,
                                t.data.scale,
                                Number(e.target.value),
                              )
                              .then(changed);
                          }}
                        >
                          {Array.from({ length: 61 }, (_, k) => 24 + k).map((m) => (
                            <option key={m} value={m}>
                              {noteName(m)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                </div>
                <NoteRowLabels track={t} />
              </div>
              {t.data.kind === 'boolean' && (
                <BooleanLane
                  instance={instance}
                  index={i}
                  track={t}
                  beats={beats}
                  api={api}
                  refresh={() => void refresh()}
                />
              )}
              {t.data.kind === 'continuous' && (
                <ContinuousLane
                  instance={instance}
                  index={i}
                  track={t}
                  beats={beats}
                  api={api}
                  refresh={() => void refresh()}
                />
              )}
              {t.data.kind === 'note' && (
                <NoteLane
                  instance={instance}
                  index={i}
                  track={t}
                  beats={beats}
                  api={api}
                  refresh={() => void refresh()}
                />
              )}
            </div>
          ))}

          {playhead >= 0 && (
            <div
              className="choreo-playhead"
              data-testid={`choreo-playhead-${instance}`}
              style={{ left: LABEL_W + playhead * BEAT_W, width: BEAT_W }}
            />
          )}
        </div>
      </div>
      {tracks.length === 0 && <div className="choreo-empty">no tracks — add one above</div>}
    </div>
  );
}
