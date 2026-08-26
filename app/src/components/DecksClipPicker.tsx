// Choosing a clip for a deck: the module picker's Clips tab, in a dialog.
// Same rows, same classes, same gesture — type, ↑/↓, Enter — because it
// is the same act, and a second way of listing clips would be a second
// thing to learn.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BeatClipEntry } from '../beatClip';
import { StemTags } from './StemTags';

export interface DecksClipPickerProps {
  /** Which deck the clip is for (1-based, for the title). */
  deck: number;
  clips: BeatClipEntry[];
  onPick(clip: BeatClipEntry): void;
  onClose(): void;
}

export function DecksClipPicker({ deck, clips, onPick, onClose }: DecksClipPickerProps) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    search.current?.focus();
  }, []);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return clips;
    return clips.filter((c) => {
      const hay = `${c.name} ${c.projectName}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [clips, query]);

  // Typing re-aims at the first match; ↑/↓ walk from there, clamped.
  const active = Math.min(index, Math.max(shown.length - 1, 0));

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
        {shown.length > 0 ? (
          <ul className="picker-clip-list" role="listbox" aria-label="Clips">
            {shown.map((c, i) => (
              <li
                key={`${c.projectId}/${c.clipId}`}
                className={`picker-clip-row${i === active ? ' active' : ''}`}
                data-testid={`decks-clip-${c.projectId}-${c.clipId}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setIndex(i)}
                onClick={() => onPick(c)}
              >
                <span className="picker-clip-name">{c.name}</span>
                <span className="picker-clip-project">{c.projectName}</span>
                <StemTags stems={c.stems} testId={`decks-clip-stems-${c.projectId}-${c.clipId}`} />
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
              ? 'No clips yet. Cut one in the Beatify tab and it will show up here.'
              : `No clips match “${query}”.`}
          </p>
        )}
        <button className="file-dialog-cancel" data-testid="decks-clip-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
