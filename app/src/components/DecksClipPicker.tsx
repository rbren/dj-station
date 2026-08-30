// Choosing a clip for a deck: the Library page's clip table, in a dialog.
// Same columns, same sort, same stem filters — because it is the same
// list — plus the gesture a dialog owes: type, ↑/↓, Enter. What it does
// NOT offer is editing or deleting a clip (`onEdit`/`onDelete` absent):
// loading one is the only thing a deck asked for.

import { useEffect, useMemo, useRef, useState } from 'react';
import { filterClips, sortClips, type BeatClipEntry, type ClipSort } from '../beatClip';
import { type StemName } from '../clip';
import { BeatClipTable, ClipStemFilter } from './BeatClipTable';

export interface DecksClipPickerProps {
  /** Which deck the clip is for (1-based, for the title). */
  deck: number;
  clips: BeatClipEntry[];
  onPick(clip: BeatClipEntry): void;
  onClose(): void;
}

export function DecksClipPicker({ deck, clips, onPick, onClose }: DecksClipPickerProps) {
  const [query, setQuery] = useState('');
  // Stem tags as filters: each selected part narrows the list to clips
  // containing it (a mix clip names all four, so it always qualifies; a
  // clip that says nothing about its parts makes no claim and drops out).
  const [stemFilter, setStemFilter] = useState<StemName[]>([]);
  const [sort, setSort] = useState<ClipSort | null>(null);
  const [index, setIndex] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLDivElement>(null);

  useEffect(() => {
    search.current?.focus();
  }, []);

  const shown = useMemo(
    () => sortClips(filterClips(clips, { query, stems: stemFilter }), sort),
    [clips, query, stemFilter, sort],
  );

  // A filter change re-aims the cursor like typing does, and hands focus
  // back to the search box so the type-↑/↓-Enter gesture keeps working.
  const setFilter = (stems: StemName[]) => {
    setStemFilter(stems);
    setIndex(0);
    search.current?.focus();
  };

  // Typing re-aims at the first match; ↑/↓ walk from there, clamped.
  const active = Math.min(index, Math.max(shown.length - 1, 0));

  useEffect(() => {
    // jsdom has no scrollIntoView; the optional call keeps tests honest.
    rows.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  return (
    <div
      className="file-dialog-backdrop"
      data-testid="decks-clip-picker"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        className="file-dialog decks-clip-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Load a clip into deck ${deck}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Load a clip into deck {deck}</h3>
        <input
          ref={search}
          className="library-search"
          data-testid="decks-clip-search"
          placeholder="Search clips"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, shown.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter' && shown[active]) {
              onPick(shown[active]);
            } else if (e.key === 'Escape') {
              onClose();
            }
          }}
        />
        <ClipStemFilter testId="decks-clip" selected={stemFilter} onChange={setFilter} />
        {shown.length > 0 ? (
          <div className="decks-clip-rows" ref={rows}>
            <BeatClipTable
              clips={shown}
              sort={sort}
              onSortChange={setSort}
              testId="decks-clip"
              label="Clips"
              selectedClipId={shown[active]?.clipId ?? null}
              onSelect={(c) => setIndex(shown.indexOf(c))}
              onActivate={onPick}
            />
          </div>
        ) : (
          <p className="empty-state" data-testid="decks-no-clips">
            {clips.length === 0
              ? 'No clips yet. Cut one on the Clip page and it will show up here.'
              : query
                ? `No clips match “${query}”.`
                : 'No clips contain those stems.'}
          </p>
        )}
        <button className="file-dialog-cancel" data-testid="decks-clip-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
