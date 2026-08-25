// A searchable track picker: type to narrow, ↑/↓ to walk, Enter to take.
//
// A library runs to thousands of tracks, which a <select> turns into a
// scroll and a guess at spelling. This is the same choice made TYPEABLE:
// every word you type has to appear somewhere in the title, artist or
// album, in any order, so "dylan boys" and "boys dylan" find the same
// record. It owns no data — the caller passes the list and takes the id.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Track } from '../library';

export interface TrackPickerProps {
  tracks: Track[];
  /** The track currently chosen, if any. */
  value: number | null;
  onChange(trackId: number): void;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  /** test-id / CSS class prefix, so two pickers can share a page. */
  idPrefix?: string;
}

/** How many matches are drawn. More than this is a search nobody has
 *  narrowed yet, and drawing all of it costs more than it tells you. */
export const MAX_SHOWN = 60;

export function trackLabel(track: Track): string {
  return track.artist ? `${track.title} — ${track.artist}` : track.title;
}

/** Every word must appear somewhere in the track, in any order. */
export function matchTracks(tracks: Track[], query: string): Track[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return tracks;
  return tracks.filter((t) => {
    const hay = `${t.title} ${t.artist} ${t.album}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function TrackPicker({
  tracks,
  value,
  onChange,
  disabled = false,
  autoFocus = false,
  placeholder = 'Search the library…',
  idPrefix: p = 'track-picker',
}: TrackPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const chosen = useMemo(() => tracks.find((t) => t.id === value) ?? null, [tracks, value]);
  const matches = useMemo(() => matchTracks(tracks, query), [query, tracks]);
  const shown = matches.slice(0, MAX_SHOWN);

  const choose = useCallback(
    (track: Track) => {
      onChange(track.id);
      setOpen(false);
      setQuery('');
    },
    [onChange],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  // A click anywhere else is a dismissal — including on the modal behind
  // it, which is why this listens on the document rather than on blur.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [close, open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // The list is the keyboard's while it is open: the page below must
      // not also hear these (space, in particular, plays something).
      e.stopPropagation();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => Math.min(shown.length - 1, Math.max(0, i + step)));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const track = shown[active];
        if (open && track) choose(track);
      } else if (e.key === 'Escape') {
        // Only the list closes here; the dialog around it keeps its own
        // Escape, which is why this one is swallowed only when open.
        if (open) {
          e.preventDefault();
          close();
        }
      }
    },
    [active, choose, close, open, shown],
  );

  const listId = `${p}-options`;
  return (
    <div className="track-picker" data-testid={`${p}-picker`} ref={rootRef}>
      <input
        type="text"
        role="combobox"
        className="track-picker-input"
        data-testid={`${p}-search`}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder={chosen ? trackLabel(chosen) : placeholder}
        value={open ? query : chosen ? trackLabel(chosen) : ''}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          // A narrowed list is a different list: an active row two
          // matches down means nothing once the query moves under it.
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onMouseDown={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul className="track-picker-list" role="listbox" id={listId} data-testid={listId}>
          {shown.length === 0 && (
            <li className="track-picker-empty" data-testid={`${p}-empty`}>
              nothing in the library matches “{query}”
            </li>
          )}
          {shown.map((track, i) => (
            <li key={track.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={`track-picker-option${i === active ? ' active' : ''}`}
                data-testid={`${p}-option-${track.id}`}
                // Keep the focus in the input: a blur here would close
                // the list before the click ever lands.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(track)}
              >
                <span className="track-picker-title">{track.title}</span>
                <span className="track-picker-sub">
                  {track.artist}
                  {track.album ? ` · ${track.album}` : ''}
                </span>
              </button>
            </li>
          ))}
          {matches.length > shown.length && (
            <li className="track-picker-more" data-testid={`${p}-more`}>
              …and {matches.length - shown.length} more — keep typing
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
