// ONE TABLE FOR THE SAVED CLIPS, wherever they are offered: the Library
// page's Beat Clips tab and the deck bank's load dialog. Same columns,
// same sort, same words for what a clip holds — a second way of listing
// clips would be a second thing to learn, and the two drifted apart the
// moment they were written twice.
//
// The surfaces differ only in what they let you DO with a row, and each
// of those is a prop that is simply absent where it does not belong: the
// deck dialog picks a clip (`onActivate`, with `selectedClipId` for the
// keyboard) and offers no Edit/Delete; the Library page edits and deletes
// (`onEdit`/`onDelete`) and lets a track or artist be clicked to filter
// by it (`onFilterTrack`/`onFilterArtist`), which a picker must not do —
// there a click already means "load this".
//
// The rows are handed in FILTERED AND SORTED (`filterClips`/`sortClips`
// in `beatClip.ts`): the picker walks the same array with ↑/↓, so the
// order has to be the host's to see.

import type { ReactNode } from 'react';
import {
  clipArtistNames,
  nextClipSort,
  type BeatClipEntry,
  type BeatClipSourceInfo,
  type ClipSort,
  type ClipSortField,
} from '../beatClip';
import { STEM_NAMES, type StemName } from '../clip';
import { fixed } from '../format';
import { StemTags, STEM_TAG_SHORT } from './StemTags';

const COLUMNS: { field: ClipSortField; label: string; numeric?: boolean }[] = [
  { field: 'name', label: 'Name' },
  { field: 'track', label: 'Title' },
  { field: 'artist', label: 'Artist' },
  { field: 'bpm', label: 'BPM', numeric: true },
  { field: 'beats', label: 'Beats', numeric: true },
  { field: 'stems', label: 'Stems' },
];

export interface BeatClipTableProps {
  /** The rows to draw, already filtered and in the order to draw them. */
  clips: BeatClipEntry[];
  sort: ClipSort | null;
  onSortChange(sort: ClipSort | null): void;
  /** Test id root: rows are `<testId>-row`, a clip's name cell
   *  `<testId>-<clipId>`, its tags `<testId>-stems-<clipId>`. */
  testId: string;
  /** Names the table for screen readers. */
  label: string;
  /** The row a picker's keyboard is on. Absent means nothing is picked
   *  and the rows are not a selection. */
  selectedClipId?: string | null;
  /** The row the LIST keyboard (j/k, the arrows) is on, by index. */
  cursor?: number | null;
  /** Aiming at a row (hover) — the picker's cursor follows the pointer. */
  onSelect?(clip: BeatClipEntry): void;
  /** Choosing a row (click). */
  onActivate?(clip: BeatClipEntry): void;
  /** Show only the clips cut from this source / crediting this artist. */
  onFilterTrack?(source: BeatClipSourceInfo): void;
  onFilterArtist?(artist: string): void;
  /** Open the clip in the Clip page. Disabled on a clip filed before
   *  edits were kept, which cannot be taken apart again. */
  onEdit?(clip: BeatClipEntry): void;
  onDelete?(clip: BeatClipEntry): void;
}

function ariaSort(sort: ClipSort | null, field: ClipSortField) {
  if (sort?.field !== field) return 'none' as const;
  return sort.desc ? ('descending' as const) : ('ascending' as const);
}

// Where a clip came from, as its row can show it. A clip points at its
// sources by the hash of their audio, so the title is whatever that hash
// is called NOW — and a source that was never recorded (clips cut before
// the pointer existed) or has since been deleted is a normal state, said
// plainly rather than hidden.
function TrackCell({
  sources,
  onFilter,
}: {
  sources: BeatClipSourceInfo[];
  onFilter?: (source: BeatClipSourceInfo) => void;
}) {
  if (sources.length === 0) {
    return (
      <span
        className="clip-source-none"
        data-testid="clip-source-none"
        data-tip="this clip was cut before clips recorded where they came from"
      >
        not recorded
      </span>
    );
  }
  return (
    <>
      {sources.map((s) => {
        if (s.title === null) {
          return (
            <span
              key={s.trackHash}
              className="tag tag-source clip-source-missing"
              data-testid="clip-source-missing"
              data-tip={`no track with audio ${s.trackHash.slice(0, 8)}… in the library`}
            >
              source deleted
            </span>
          );
        }
        return onFilter ? (
          <button
            key={s.trackHash}
            className="link-button clip-source"
            data-testid="clip-source"
            data-tip={`show only the clips cut from “${s.title}”`}
            onClick={() => onFilter(s)}
          >
            {s.title}
          </button>
        ) : (
          <span key={s.trackHash} className="clip-source" data-testid="clip-source">
            {s.title}
          </span>
        );
      })}
    </>
  );
}

function ArtistCell({
  clip,
  onFilter,
}: {
  clip: BeatClipEntry;
  onFilter?: (artist: string) => void;
}) {
  const artists = clipArtistNames(clip);
  if (artists.length === 0) {
    return (
      <span className="clip-source-none" data-testid="clip-artist-none">
        —
      </span>
    );
  }
  return (
    <>
      {artists.map((artist) =>
        onFilter ? (
          <button
            key={artist}
            className="link-button clip-artist"
            data-testid="clip-artist"
            data-tip={`show only the clips crediting “${artist}”`}
            onClick={() => onFilter(artist)}
          >
            {artist}
          </button>
        ) : (
          <span key={artist} className="clip-artist" data-testid="clip-artist">
            {artist}
          </span>
        ),
      )}
    </>
  );
}

export function BeatClipTable({
  clips,
  sort,
  onSortChange,
  testId,
  label,
  selectedClipId,
  cursor,
  onSelect,
  onActivate,
  onFilterTrack,
  onFilterArtist,
  onEdit,
  onDelete,
}: BeatClipTableProps) {
  const acts = Boolean(onEdit || onDelete);
  const picking = Boolean(onActivate);
  return (
    <table
      className={`beat-clip-table${picking ? ' beat-clip-table-picking' : ''}`}
      data-testid={testId}
      // A picker's rows are a selection the keyboard walks, which is what
      // a grid says and a plain table does not.
      role={picking ? 'grid' : undefined}
      aria-label={label}
    >
      <thead>
        <tr>
          {COLUMNS.map((col) => (
            <th
              key={col.field}
              className={col.numeric ? 'beat-clip-num' : undefined}
              aria-sort={ariaSort(sort, col.field)}
            >
              <button
                className="clip-sort"
                data-testid={`${testId}-sort-${col.field}`}
                data-tip={`sort by ${col.label.toLowerCase()}`}
                onClick={() => onSortChange(nextClipSort(sort, col.field))}
              >
                {col.label}
                <span className="clip-sort-arrow" aria-hidden="true">
                  {sort?.field === col.field ? (sort.desc ? '▼' : '▲') : ''}
                </span>
              </button>
            </th>
          ))}
          {acts && <th />}
        </tr>
      </thead>
      <tbody>
        {clips.map((c, i) => (
          <tr
            key={c.clipId}
            className="key-row"
            data-testid={`${testId}-row`}
            data-clip-id={c.clipId}
            data-cursor={i === cursor ? 'true' : 'false'}
            aria-selected={picking ? c.clipId === selectedClipId : undefined}
            onMouseEnter={onSelect && (() => onSelect(c))}
            onClick={onActivate && (() => onActivate(c))}
          >
            <td className="beat-clip-name" data-testid={`${testId}-${c.clipId}`}>
              {c.name}
            </td>
            {/* The flex that lays out multiple sources lives on a div
                INSIDE each cell: display:flex on the td itself knocks it
                out of the table layout, and the row's columns collapse
                out from under their headers. */}
            <td className="beat-clip-track">
              <div className="beat-clip-names">
                <TrackCell sources={c.sources} onFilter={onFilterTrack} />
              </div>
            </td>
            <td className="beat-clip-artist">
              <div className="beat-clip-names">
                <ArtistCell clip={c} onFilter={onFilterArtist} />
              </div>
            </td>
            <td className="beat-clip-num">{fixed(c.bpm, 1)}</td>
            <td className="beat-clip-num">{c.beats}</td>
            <td className="beat-clip-stems">
              <StemTags stems={c.stems} testId={`${testId}-stems-${c.clipId}`} />
            </td>
            {acts && (
              <td className="beat-clip-actions">
                <div className="row-actions">
                  {onEdit && (
                    <button
                      data-testid={`${testId}-edit`}
                      disabled={!c.editable}
                      data-tip={
                        c.editable
                          ? 'open this clip in the Clip page'
                          : 'this clip was cut before clips recorded how, so it cannot be reopened'
                      }
                      onClick={() => onEdit(c)}
                    >
                      Edit
                    </button>
                  )}
                  {onDelete && (
                    <button
                      className="is-danger"
                      data-testid={`${testId}-delete`}
                      data-tip="delete this beat clip"
                      onClick={() => onDelete(c)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface ClipStemFilterProps {
  /** Test id root, matching the table's: `<testId>-stem-filter`, and one
   *  `<testId>-filter-<part>` per chip (`-filter-all` clears them). */
  testId: string;
  selected: readonly StemName[];
  onChange(stems: StemName[]): void;
  /** Anything else that belongs on the filter row (an active filter). */
  children?: ReactNode;
}

/** The stem tags as FILTERS: the same chips the rows wear, printed
 *  short, as toggles. Each selected part narrows the list to clips
 *  containing it; ALL clears the lot. */
export function ClipStemFilter({ testId, selected, onChange, children }: ClipStemFilterProps) {
  return (
    <div className="clip-stem-filter" role="group" aria-label="Filter by stem">
      <div className="stem-filter-tags" data-testid={`${testId}-stem-filter`}>
        <button
          type="button"
          className="stem-filter-tag"
          data-testid={`${testId}-filter-all`}
          aria-pressed={selected.length === 0}
          title="Show every clip"
          onClick={() => onChange([])}
        >
          ALL
        </button>
        {STEM_NAMES.map((name) => (
          <button
            key={name}
            type="button"
            className={`stem-filter-tag stem-filter-${name}`}
            data-testid={`${testId}-filter-${name}`}
            aria-pressed={selected.includes(name)}
            title={`Only clips containing the ${name}`}
            onClick={() =>
              onChange(
                selected.includes(name) ? selected.filter((s) => s !== name) : [...selected, name],
              )
            }
          >
            {STEM_TAG_SHORT[name]}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}
