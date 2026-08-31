// Choosing a clip for a deck, in two steps: WHICH SONG, then which of
// its clips.
//
// The song list is ordered by TEMPO, slowest first, and opens on the song
// nearest the bank's own — scrolled to the middle of the dialog and
// already picked, so the first thing under the hand is the thing most
// likely to fit, and ↑/↓ walk to something slower or faster from there.
// That is why the bank's tempo is a prop: without one (the V2 page, which
// adds a clip to a grid rather than to a running deck) the dialog is the
// flat clip list it has always been.
//
// The clip level is the Library page's clip table, in a dialog: same
// columns, same sort, same stem filters — because it is the same list —
// plus the gesture a dialog owes: type, ↑/↓, Enter. What it does NOT
// offer is editing or deleting a clip (`onEdit`/`onDelete` absent):
// loading one is the only thing a deck asked for.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  filterClips,
  songNearestBpm,
  songsByBpm,
  sortClips,
  type BeatClipEntry,
  type ClipSong,
  type ClipSort,
} from '../beatClip';
import { type StemName } from '../clip';
import { fixed } from '../format';
import { BeatClipTable, ClipStemFilter } from './BeatClipTable';

export interface DecksClipPickerProps {
  /** Which deck the clip is for (1-based, for the title). */
  deck: number;
  clips: BeatClipEntry[];
  /** The bank's tempo. Given, the dialog opens on the songs, ordered by
   *  tempo and aimed at the one nearest this; absent, it opens straight
   *  on the clips. */
  bankBpm?: number;
  onPick(clip: BeatClipEntry): void;
  onClose(): void;
}

export function DecksClipPicker({ deck, clips, bankBpm, onPick, onClose }: DecksClipPickerProps) {
  const [song, setSong] = useState<ClipSong | null>(null);
  const [query, setQuery] = useState('');
  // Stem tags as filters: each selected part narrows the list to clips
  // containing it (a mix clip names all four, so it always qualifies; a
  // clip that says nothing about its parts makes no claim and drops out).
  const [stemFilter, setStemFilter] = useState<StemName[]>([]);
  const [sort, setSort] = useState<ClipSort | null>(null);
  // Where the cursor is, or null for "wherever the list wants it" — the
  // top clip, or the song nearest the bank's tempo. Typing and filtering
  // put it back to null rather than to a row number, so a narrowed song
  // list re-aims at the nearest tempo instead of parking on row 0.
  const [index, setIndex] = useState<number | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLDivElement>(null);

  const songs = useMemo(() => (bankBpm === undefined ? [] : songsByBpm(clips)), [bankBpm, clips]);
  /** On the songs, or past them? A dialog with no tempo to sort by never
   *  shows them at all. */
  const picking = bankBpm !== undefined && song === null ? 'song' : 'clip';

  const shownSongs = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return songs;
    return songs.filter((s) => {
      const hay = `${s.title} ${s.artist ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [songs, query]);

  const shownClips = useMemo(
    () => sortClips(filterClips(song ? song.clips : clips, { query, stems: stemFilter }), sort),
    [clips, song, query, stemFilter, sort],
  );

  const length = picking === 'song' ? shownSongs.length : shownClips.length;
  // WHERE THE SONG LIST SITS UNTOUCHED: on the song closest in tempo to
  // what the bank is playing, of whatever the search has left. Derived
  // rather than remembered, so narrowing the songs re-aims at the most
  // likely one instead of parking on the top row.
  const home = picking === 'song' ? Math.max(0, songNearestBpm(shownSongs, bankBpm ?? 0)) : 0;
  // ↑/↓ walk from there, clamped to the list.
  const active = Math.min(index ?? home, Math.max(length - 1, 0));

  useEffect(() => {
    search.current?.focus();
  }, [picking]);

  useEffect(() => {
    const row = rows.current?.querySelector('[aria-selected="true"]');
    // The song it opens on sits in the MIDDLE, with what is slower above
    // it and what is faster below: the list is a tempo range, and the
    // dialog opens looking at the part of it worth playing.
    // (jsdom has no scrollIntoView; the optional call keeps tests honest.)
    row?.scrollIntoView?.({ block: picking === 'song' ? 'center' : 'nearest' });
  }, [active, picking, shownSongs]);

  // A filter change re-aims the cursor like typing does, and hands focus
  // back to the search box so the type-↑/↓-Enter gesture keeps working.
  const setFilter = (stems: StemName[]) => {
    setStemFilter(stems);
    setIndex(null);
    search.current?.focus();
  };

  /** Enter: INTO the song's clips, or onto the clip itself. */
  const choose = () => {
    if (picking === 'song') {
      const next = shownSongs[active];
      if (!next) return;
      setSong(next);
      setQuery('');
      setIndex(null);
    } else if (shownClips[active]) {
      onPick(shownClips[active]);
    }
  };

  /** Back out to the song list — a step, not a re-open: the tempo the
   *  songs are ordered by is still the bank's. */
  const back = () => {
    setSong(null);
    setQuery('');
    setStemFilter([]);
    setIndex(null);
  };

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
        <h3>
          {picking === 'song' ? (
            <>
              Load a clip into deck {deck}{' '}
              <span className="decks-song-note" data-testid="decks-song-note">
                — the song first, by tempo around {fixed(bankBpm ?? 0, 1)} bpm
              </span>
            </>
          ) : song ? (
            <>
              <button
                className="link-button decks-song-back"
                data-testid="decks-song-back"
                onClick={back}
              >
                ← songs
              </button>{' '}
              {song.title}
            </>
          ) : (
            <>Load a clip into deck {deck}</>
          )}
        </h3>
        <input
          ref={search}
          className="library-search"
          data-testid="decks-clip-search"
          placeholder={picking === 'song' ? 'Search songs' : 'Search clips'}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(null);
          }}
          onKeyDown={(e) => {
            // On the songs, ↑ is SLOWER and ↓ is FASTER — which is what
            // sorting the list by tempo buys: the arrows walk through
            // tempo rather than through an alphabet.
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex(Math.min(active + 1, length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex(Math.max(active - 1, 0));
            } else if (e.key === 'Enter') {
              choose();
            } else if (e.key === 'Escape') {
              onClose();
            } else if (e.key === 'Backspace' && query === '' && song) {
              back();
            }
          }}
        />
        {picking === 'clip' && (
          <ClipStemFilter testId="decks-clip" selected={stemFilter} onChange={setFilter} />
        )}
        {picking === 'song' ? (
          shownSongs.length > 0 ? (
            <div className="decks-clip-rows decks-song-rows" ref={rows} role="listbox">
              {shownSongs.map((s, i) => (
                <div
                  key={s.hash ?? ''}
                  className={i === active ? 'decks-song-row is-active' : 'decks-song-row'}
                  data-testid="decks-song-row"
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => {
                    setIndex(i);
                    setSong(s);
                    setQuery('');
                  }}
                >
                  <span className="decks-song-title">{s.title}</span>
                  <span className="decks-song-artist">{s.artist ?? ''}</span>
                  <span className="decks-song-bpm mono">{fixed(s.bpm, 1)}</span>
                  <span className="decks-song-count">
                    {s.clips.length} {s.clips.length === 1 ? 'clip' : 'clips'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty-state" data-testid="decks-no-clips">
              {clips.length === 0
                ? 'No clips yet. Cut one on the Clip page and it will show up here.'
                : `No songs match “${query}”.`}
            </p>
          )
        ) : shownClips.length > 0 ? (
          <div className="decks-clip-rows" ref={rows}>
            <BeatClipTable
              clips={shownClips}
              sort={sort}
              onSortChange={setSort}
              testId="decks-clip"
              label="Clips"
              selectedClipId={shownClips[active]?.clipId ?? null}
              onSelect={(c) => setIndex(shownClips.indexOf(c))}
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
