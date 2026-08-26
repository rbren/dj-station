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
import { beatCount } from '../beatify';
import {
  abutsLeft,
  audioBeats,
  drawnColumns,
  isSaved,
  rowPlacements,
  sourceTint,
  type CellRange,
  type ClipDraft,
  type Placement,
  type SourceId,
} from '../beatifyClip';

/** The grid fills the width of the pane, so a beat is a FRACTION of it
 *  rather than a fixed number of pixels: the columns then line up with
 *  the source waveform directly above, which is the point of stacking
 *  them in one column. */
const pct = (n: number, columns: number) => `${(n / Math.max(1, columns)) * 100}%`;
const ROW_H = 72;

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
  /** The chunk of grid the user has swept out, for copy and paste. */
  selection: CellRange | null;
  onHoverCell(row: number, col: number): void;
  onDropCell(row: number, col: number): void;
  /** Pressing an empty cell: the start of a sweep, not a drop. */
  onPressCell(row: number, col: number): void;
  onGrabPlacement(id: string, e: React.MouseEvent): void;
  onRemovePlacement(id: string): void;
  onTogglePlay(): void;
  onAddRow(): void;
  onRemoveRow(): void;
  onRename(name: string): void;
  /** Set the clip's length in beats. */
  onSetLength(beats: number): void;
  onSave(): void;
  /** Delete the saved clip this draft came from. */
  onDelete(): void;
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
  selection,
  onHoverCell,
  onDropCell,
  onPressCell,
  onGrabPlacement,
  onRemovePlacement,
  onTogglePlay,
  onAddRow,
  onRemoveRow,
  onRename,
  onSetLength,
  onSave,
  onDelete,
  saving,
  status,
}: BeatifyClipEditorProps) {
  const columns = drawnColumns(draft);

  const cellsOf = useCallback(
    (row: number) =>
      Array.from({ length: columns }, (_, col) => (
        <div
          key={col}
          className="beatify-clip-cell"
          data-testid={`beatify-clip-cell-${row}-${col}`}
          style={{ width: pct(1, columns) }}
          onMouseDown={(e) => {
            // The browser would otherwise start selecting the page's
            // text under a sweep across the grid.
            e.preventDefault();
            onPressCell(row, col);
          }}
          onMouseEnter={() => onHoverCell(row, col)}
          onMouseUp={() => onDropCell(row, col)}
        />
      )),
    [columns, onDropCell, onHoverCell, onPressCell],
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
          onKeyDown={(e) => {
            // Naming a clip and saving it are one thought.
            if (e.key === 'Enter') onSave();
          }}
        />
        <button
          data-testid="beatify-clip-play"
          className={playing ? 'clip-toggle-on' : undefined}
          title="Play the clip, looped (only one of source and clip sounds at a time)"
          onClick={onTogglePlay}
        >
          {playing ? '❚❚' : '▶'}
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
        <label className="beatify-clip-length">
          beats
          <input
            type="number"
            min={1}
            max={512}
            data-testid="beatify-clip-length"
            value={columns}
            onChange={(e) => onSetLength(Number(e.target.value) || 1)}
          />
        </label>
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
        <button
          data-testid="beatify-clip-delete"
          className="beatify-clip-danger"
          onClick={onDelete}
          disabled={saving || !isSaved(draft)}
          title={
            isSaved(draft) ? `Delete "${draft.name}"` : 'Nothing to delete until the clip is saved'
          }
        >
          Delete clip
        </button>
        {status}
      </header>

      <div className="beatify-clip-grid" data-testid="beatify-clip-grid">
        <div className="beatify-clip-ruler">
          {Array.from({ length: columns }, (_, col) => (
            <div key={col} className="beatify-clip-tick" style={{ width: pct(1, columns) }}>
              {col % 4 === 0 ? col + 1 : ''}
            </div>
          ))}
        </div>

        {Array.from({ length: draft.rows }, (_, row) => (
          <div
            key={row}
            className="beatify-clip-row"
            data-testid={`beatify-clip-row-${row}`}
            style={{ height: ROW_H }}
          >
            <div className="beatify-clip-cells">{cellsOf(row)}</div>

            {selection && row >= selection.row0 && row <= selection.row1 && (
              <div
                className="beatify-clip-marquee"
                data-testid={`beatify-clip-marquee-${row}`}
                style={{
                  left: pct(selection.col0, columns),
                  width: pct(selection.col1 - selection.col0, columns),
                }}
              />
            )}

            {dropAt && dropAt.row === row && (
              <div
                className="beatify-clip-ghost"
                data-testid="beatify-clip-ghost"
                style={{ left: pct(dropAt.col, columns), width: pct(dropAt.beats, columns) }}
              />
            )}

            {rowPlacements(draft, row).map((p) => (
              <Block
                key={p.id}
                columns={columns}
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
            style={{ left: pct(playhead / Math.max(1e-6, period), columns) }}
          />
        )}
      </div>
    </section>
  );
}

interface BlockProps {
  placement: Placement;
  /** The clip's length, which is what the geometry is a fraction of. */
  columns: number;
  /** Something ends exactly where this starts: draw the join. */
  seam: boolean;
  tint: number;
  label: string;
  onGrab(id: string, e: React.MouseEvent): void;
  onRemove(id: string): void;
}

function Block({ placement, columns, seam, tint, label, onGrab, onRemove }: BlockProps) {
  const p = placement;
  const audio = audioBeats(p);
  // A run cut with ⌘ holds less audio than the columns it occupies; the
  // rest of the last column is silence, and it is drawn as such so a
  // fractional cut is something you can SEE in the clip.
  const rest = p.beats - audio;
  return (
    <div
      className={`beatify-clip-block tint-${tint}${seam ? ' seam' : ''}`}
      data-testid={`beatify-clip-block-${p.id}`}
      data-beats={p.beats}
      data-audio-beats={rest > 0 ? beatCount(audio) : undefined}
      data-col={p.col}
      style={{ left: pct(p.col, columns), width: pct(p.beats, columns) }}
      title={
        `${label} · beats ${beatCount(p.sourceBeat + 1)}–${beatCount(p.sourceBeat + audio)}` +
        (rest > 0 ? ` · ${beatCount(rest)} silent` : '')
      }
      onMouseDown={(e) => onGrab(p.id, e)}
    >
      {rest > 0 && (
        <span
          className="beatify-clip-block-rest"
          style={{ width: pct(rest, p.beats) }}
          data-testid={`beatify-clip-rest-${p.id}`}
        />
      )}
      <span className="beatify-clip-block-label">
        {label} · {beatCount(audio)}
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
