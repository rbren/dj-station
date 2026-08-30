// Choosing a clip for a deck: the module picker's Clips tab, in a dialog.
// Same rows, same classes, same gesture — type, ↑/↓, Enter — because it
// is the same act, and a second way of listing clips would be a second
// thing to learn.

import { useEffect, useMemo, useRef, useState } from 'react';
import { clipSourceLabel, type BeatClipEntry } from '../beatClip';
import { STEM_NAMES, type StemName } from '../clip';
import { StemTags, STEM_TAG_SHORT } from './StemTags';

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
  const [index, setIndex] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    search.current?.focus();
  }, []);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return clips.filter((c) => {
      if (!stemFilter.every((s) => c.stems.includes(s))) return false;
      if (words.length === 0) return true;
      const hay = `${c.name} ${clipSourceLabel(c)}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [clips, query, stemFilter]);

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
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
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
        <div
          className="decks-clip-stem-filter"
          role="group"
          aria-label="Filter by stem"
          data-testid="decks-clip-stem-filter"
        >
          <button
            type="button"
            className="stem-filter-tag"
            data-testid="decks-clip-filter-all"
            aria-pressed={stemFilter.length === 0}
            title="Show every clip"
            onClick={() => setFilter([])}
          >
            ALL
          </button>
          {STEM_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              className={`stem-filter-tag stem-filter-${name}`}
              data-testid={`decks-clip-filter-${name}`}
              aria-pressed={stemFilter.includes(name)}
              title={`Only clips containing the ${name}`}
              onClick={() =>
                setFilter(
                  stemFilter.includes(name)
                    ? stemFilter.filter((s) => s !== name)
                    : [...stemFilter, name],
                )
              }
            >
              {STEM_TAG_SHORT[name]}
            </button>
          ))}
        </div>
        {shown.length > 0 ? (
          <ul ref={list} className="picker-clip-list" role="listbox" aria-label="Clips">
            {shown.map((c, i) => (
              <li
                key={c.clipId}
                className={`picker-clip-row${i === active ? ' active' : ''}`}
                data-testid={`decks-clip-${c.clipId}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setIndex(i)}
                onClick={() => onPick(c)}
              >
                <span className="picker-clip-name">{c.name}</span>
                <span className="picker-clip-project">{clipSourceLabel(c)}</span>
                <StemTags stems={c.stems} testId={`decks-clip-stems-${c.clipId}`} />
                <span className="picker-clip-beats">{c.beats} beats</span>
                <span className="picker-clip-bpm">
                  {c.bpm > 0 ? `${c.bpm.toFixed(1)} BPM` : '—'}
                </span>
              </li>
            ))}
          </ul>
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
