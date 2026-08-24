// The clip builder's left-hand column: everything this track can be cut
// up into.
//
// The seed render, its stems and every clip saved so far are the same
// kind of thing here — a source you can open in the pane above and take
// beats from — because they all sit on the one beatified grid. Stems that
// have not been separated yet are listed but not selectable, with the
// reason and the fix, exactly as the Clip page treats a missing demucs.

import type { SourceId } from '../beatifyClip';

export interface ClipListEntry {
  id: SourceId;
  label: string;
  /** `stem`, `clip`, or nothing for the seed. */
  kind: string;
  available: boolean;
  hint: string | null;
}

export interface BeatifyClipListProps {
  entries: readonly ClipListEntry[];
  selected: SourceId;
  onSelect(id: SourceId): void;
  onDelete(id: SourceId): void;
}

export function BeatifyClipList({ entries, selected, onSelect, onDelete }: BeatifyClipListProps) {
  return (
    <aside className="beatify-clip-list" data-testid="beatify-clip-list">
      <h3>Clips</h3>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              data-testid={`beatify-clip-source-${entry.id}`}
              className={entry.id === selected ? 'selected' : undefined}
              disabled={!entry.available}
              title={entry.hint ?? `Open ${entry.label}`}
              onClick={() => onSelect(entry.id)}
            >
              <span className="beatify-clip-source-label">{entry.label}</span>
              {entry.kind && <span className="beatify-clip-source-kind">{entry.kind}</span>}
            </button>
            {entry.kind === 'clip' && (
              <button
                className="beatify-clip-source-x"
                data-testid={`beatify-clip-delete-${entry.id}`}
                title={`Delete ${entry.label}`}
                onClick={() => onDelete(entry.id)}
              >
                ×
              </button>
            )}
            {!entry.available && entry.hint && (
              <span className="beatify-clip-source-hint">{entry.hint}</span>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
