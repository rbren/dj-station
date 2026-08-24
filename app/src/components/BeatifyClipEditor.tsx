// The clip editor: the grid a clip is built in (PRD "Beatify" §BC).
//
// Columns are BEATS and rows are tracks that sound together. What is in a
// cell is never a cell: it is part of a `Placement`, a run of beats that
// arrived in one drop, and the editor draws it as ONE block so three
// beats read as three-beats-wide rather than three things that happen to
// be adjacent. Runs that abut get a seam drawn between them, because
// "these are two clips" is otherwise invisible.
//
// The editor does not own audio. It reports gestures; the builder above
// owns the transport (and the rule that only one thing sounds at a time).

import { useCallback, type ReactNode } from 'react';
import {
  abutsLeft,
  drawnColumns,
  rowPlacements,
  sourceTint,
  type ClipDraft,
  type Placement,
  type SourceId,
} from '../beatifyClip';

/** Pixels per beat. Wide enough to read a beat number in. */
const COL_W = 34;
const ROW_H = 46;

export interface BeatifyClipEditorProps {
  draft: ClipDraft;
  /** Source order, for stable per-source colours. */
  sourceOrder: readonly SourceId[];
  /** Label for a source id, shown on the blocks. */
  labelOf(id: SourceId): string;
  /** Beats per second, for the playhead. */
  period: number;
  playing: boolean;
  /** Seconds into the clip. */
  playhead: number;
  /** Which pane is making the sound, if either. */
  live: 'source' | 'clip' | null;
  /** A drop is in progress and this is where it would land. */
  dropAt: { row: number; col: number; beats: number } | null;
  onHoverCell(row: number, col: number): void;
  onDropCell(row: number, col: number): void;
  onGrabPlacement(id: string, e: React.MouseEvent): void;
  onRemovePlacement(id: string): void;
  onTogglePlay(): void;
  onStop(): void;
  onAddRow(): void;
  onRemoveRow(): void;
  onRename(name: string): void;
  onSave(): void;
  saving: boolean;
  status: ReactNode;
}

export function BeatifyClipEditor({
  draft,
  sourceOrder,
  labelOf,
  period,
  playing,
  playhead,
  live,
  dropAt,
  onHoverCell,
  onDropCell,
  onGrabPlacement,
  onRemovePlacement,
  onTogglePlay,
  onStop,
  onAddRow,
  onRemoveRow,
  onRename,
  onSave,
  saving,
  status,
}: BeatifyClipEditorProps) {
  const columns = drawnColumns(draft);
  const width = columns * COL_W;

  const cellsOf = useCallback(
    (row: number) =>
      Array.from({ length: columns }, (_, col) => (
        <div
          key={col}
          className="beatify-clip-cell"
          data-testid={`beatify-clip-cell-${row}-${col}`}
          style={{ width: COL_W }}
          onMouseEnter={() => onHoverCell(row, col)}
          onMouseUp={() => onDropCell(row, col)}
        />
      )),
    [columns, onDropCell, onHoverCell],
  );

  return (
    <section className="beatify-clip-editor" data-testid="beatify-clip-editor">
      <header className="beatify-clip-head">
        <h3>Clip editor</h3>
        <input
          data-testid="beatify-clip-name"
          className="beatify-clip-name"
          value={draft.name}
          aria-label="Clip name"
          onChange={(e) => onRename(e.target.value)}
        />
        <button
          data-testid="beatify-clip-play"
          className={playing ? 'clip-toggle-on' : undefined}
          title="Play the clip, looped (only one of source and clip sounds at a time)"
          onClick={onTogglePlay}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button data-testid="beatify-clip-stop" onClick={onStop}>
          ■
        </button>
        {/* Which pane the sound is coming from, said plainly. */}
        <span
          className={live ? `beatify-clip-live on ${live}` : 'beatify-clip-live'}
          data-testid="beatify-clip-live"
        >
          {live === 'clip'
            ? 'playing the clip'
            : live === 'source'
              ? 'playing the source'
              : 'stopped'}
        </span>
        <span className="beatify-clip-count" data-testid="beatify-clip-count">
          {draft.placements.length} run{draft.placements.length === 1 ? '' : 's'} · {draft.rows}{' '}
          track{draft.rows === 1 ? '' : 's'}
        </span>
        <button data-testid="beatify-clip-add-row" onClick={onAddRow}>
          + track
        </button>
        <button
          data-testid="beatify-clip-remove-row"
          onClick={onRemoveRow}
          disabled={draft.rows <= 1}
        >
          − track
        </button>
        <button data-testid="beatify-clip-save" onClick={onSave} disabled={saving}>
          Save clip
        </button>
        {status}
      </header>

      <div className="beatify-clip-grid" data-testid="beatify-clip-grid">
        <div className="beatify-clip-ruler" style={{ width }}>
          {Array.from({ length: columns }, (_, col) => (
            <div key={col} className="beatify-clip-tick" style={{ width: COL_W }}>
              {col % 4 === 0 ? col + 1 : ''}
            </div>
          ))}
        </div>

        {Array.from({ length: draft.rows }, (_, row) => (
          <div
            key={row}
            className="beatify-clip-row"
            data-testid={`beatify-clip-row-${row}`}
            style={{ width, height: ROW_H }}
          >
            <div className="beatify-clip-cells">{cellsOf(row)}</div>

            {dropAt && dropAt.row === row && (
              <div
                className="beatify-clip-ghost"
                data-testid="beatify-clip-ghost"
                style={{ left: dropAt.col * COL_W, width: dropAt.beats * COL_W }}
              />
            )}

            {rowPlacements(draft, row).map((p) => (
              <Block
                key={p.id}
                placement={p}
                seam={abutsLeft(draft, p)}
                tint={sourceTint(p.source, sourceOrder)}
                label={labelOf(p.source)}
                onGrab={onGrabPlacement}
                onRemove={onRemovePlacement}
              />
            ))}
          </div>
        ))}

        {playing && (
          <div
            className="beatify-clip-playhead"
            data-testid="beatify-clip-playhead"
            style={{ left: (playhead / Math.max(1e-6, period)) * COL_W }}
          />
        )}
      </div>
    </section>
  );
}

interface BlockProps {
  placement: Placement;
  /** Something ends exactly where this starts: draw the join. */
  seam: boolean;
  tint: number;
  label: string;
  onGrab(id: string, e: React.MouseEvent): void;
  onRemove(id: string): void;
}

function Block({ placement, seam, tint, label, onGrab, onRemove }: BlockProps) {
  const p = placement;
  return (
    <div
      className={`beatify-clip-block tint-${tint}${seam ? ' seam' : ''}`}
      data-testid={`beatify-clip-block-${p.id}`}
      data-beats={p.beats}
      data-col={p.col}
      style={{ left: p.col * COL_W, width: p.beats * COL_W }}
      title={`${label} · beats ${p.sourceBeat + 1}–${p.sourceBeat + p.beats}`}
      onMouseDown={(e) => onGrab(p.id, e)}
    >
      <span className="beatify-clip-block-label">
        {label} · {p.beats}
      </span>
      <button
        className="beatify-clip-block-x"
        data-testid={`beatify-clip-remove-${p.id}`}
        title="Remove this run"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => onRemove(p.id)}
      >
        ×
      </button>
    </div>
  );
}
