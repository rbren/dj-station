// The ONE table the saved clips are listed in — the Library page's Beat
// Clips tab and the deck bank's load dialog — and the sort/filter both
// surfaces run over the list they already hold.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  filterClips,
  nextClipSort,
  songNearestBpm,
  songsByBpm,
  sortClips,
  type BeatClipEntry,
  type ClipSort,
} from '../src/beatClip';
import { BeatClipTable } from '../src/components/BeatClipTable';

function clip(over: Partial<BeatClipEntry> = {}): BeatClipEntry {
  return {
    clipId: 'c1',
    name: 'main drums',
    bpm: 120,
    beats: 8,
    stems: ['drums'],
    editable: true,
    sources: [{ trackHash: 'h1', title: 'Basement Loop', artist: 'Nadia' }],
    ...over,
  };
}

const CLIPS = [
  clip(),
  clip({
    clipId: 'c2',
    name: 'chorus stack',
    bpm: 174,
    beats: 16,
    stems: ['vocals', 'drums', 'bass', 'other'],
    sources: [{ trackHash: 'h2', title: 'Rooftop Take', artist: 'Ovid' }],
  }),
  clip({ clipId: 'c3', name: 'old bass run', bpm: 90, beats: 2, stems: [], sources: [] }),
];

function show(props: Partial<Parameters<typeof BeatClipTable>[0]> = {}) {
  const onSortChange = vi.fn();
  render(
    <BeatClipTable
      clips={CLIPS}
      sort={null}
      onSortChange={onSortChange}
      testId="beat-clip"
      label="Beat clips"
      {...props}
    />,
  );
  return onSortChange;
}

const cells = (row: HTMLElement) => [...row.children].map((c) => c.textContent);

describe('BeatClipTable', () => {
  it('gives the track and the artist a column each, and the stems their tags', () => {
    show();
    // One header per field, each cell under its own: the source track's
    // title is called Title, and BPM is a column of its own — not a
    // second line under the title.
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Name', 'Title', 'Artist', 'BPM', 'Beats', 'Stems']);
    const rows = screen.getAllByTestId('beat-clip-row');
    expect(cells(rows[0])).toEqual(['main drums', 'Basement Loop', 'Nadia', '120.0', '8', 'drums']);
    // What a clip holds is said the way every other surface says it: all
    // four parts are the one "mix" chip, and a clip that says nothing
    // about its parts draws no tags at all.
    expect(screen.getByTestId('beat-clip-stems-c2-mix')).toBeTruthy();
    expect(screen.queryByTestId('beat-clip-stems-c3')).toBeNull();
    // The column is called what the tags are.
    expect(screen.getByTestId('beat-clip-sort-stems').textContent).toContain('Stems');
  });

  it('says so when a clip has no source to show, and never hides the clip', () => {
    render(
      <BeatClipTable
        clips={[
          clip({ clipId: 'x', sources: [{ trackHash: 'gone', title: null, artist: null }] }),
          clip({ clipId: 'y', sources: [] }),
        ]}
        sort={null}
        onSortChange={vi.fn()}
        testId="beat-clip"
        label="Beat clips"
      />,
    );
    const rows = screen.getAllByTestId('beat-clip-row');
    expect(within(rows[0]).getByTestId('clip-source-missing').textContent).toBe('source deleted');
    expect(within(rows[1]).getByTestId('clip-source-none').textContent).toBe('not recorded');
    // No artist to credit is a dash, not a blank cell.
    expect(within(rows[1]).getByTestId('clip-artist-none').textContent).toBe('—');
  });

  it('sorts by the column whose title was clicked, then back to the store order', () => {
    const onSortChange = show();
    fireEvent.click(screen.getByTestId('beat-clip-sort-bpm'));
    expect(onSortChange).toHaveBeenLastCalledWith({ field: 'bpm', desc: false });

    // The header says which way it is pointing, for the eye and for a
    // screen reader.
    const sorted: ClipSort = { field: 'bpm', desc: false };
    render(
      <BeatClipTable
        clips={sortClips(CLIPS, sorted)}
        sort={sorted}
        onSortChange={onSortChange}
        testId="sorted"
        label="Beat clips"
      />,
    );
    const head = screen.getByTestId('sorted-sort-bpm');
    expect(head.parentElement?.getAttribute('aria-sort')).toBe('ascending');
    expect(head.textContent).toContain('▲');
    const names = screen.getAllByTestId('sorted-row').map((r) => r.children[0].textContent);
    expect(names).toEqual(['old bass run', 'main drums', 'chorus stack']);
  });

  it('lets a track or an artist be clicked to filter by it — where a click means that', () => {
    const onFilterTrack = vi.fn();
    const onFilterArtist = vi.fn();
    show({ onFilterTrack, onFilterArtist });
    fireEvent.click(screen.getAllByTestId('clip-source')[0]);
    expect(onFilterTrack).toHaveBeenCalledWith(expect.objectContaining({ trackHash: 'h1' }));
    fireEvent.click(screen.getAllByTestId('clip-artist')[1]);
    expect(onFilterArtist).toHaveBeenCalledWith('Ovid');

    // A surface that offers no such filter (the deck dialog, where a
    // click already means "load this") prints the same names as text.
    render(
      <BeatClipTable
        clips={CLIPS}
        sort={null}
        onSortChange={vi.fn()}
        testId="plain"
        label="Clips"
      />,
    );
    const plain = screen.getByTestId('plain');
    expect(within(plain).getAllByTestId('clip-source')[0].tagName).toBe('SPAN');
  });

  it('offers Edit and Delete only where the host asked for them', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    show({ onEdit, onDelete });
    const row = screen.getAllByTestId('beat-clip-row')[0];
    // Both verbs sit in the same cell, side by side.
    const actions = within(row).getByTestId('beat-clip-edit').parentElement!;
    expect(actions.className).toBe('row-actions');
    expect(within(actions).getByTestId('beat-clip-delete')).toBeTruthy();

    fireEvent.click(within(row).getByTestId('beat-clip-edit'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ clipId: 'c1' }));
    fireEvent.click(within(row).getByTestId('beat-clip-delete'));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ clipId: 'c1' }));

    // The picker passes neither, so its rows carry no such column.
    render(
      <BeatClipTable
        clips={CLIPS}
        sort={null}
        onSortChange={vi.fn()}
        testId="picking"
        label="Clips"
        onActivate={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('picking-edit')).toBeNull();
    expect(screen.queryByTestId('picking-delete')).toBeNull();
  });

  it('marks the row a picker is on, and picks the one that is clicked', () => {
    const onActivate = vi.fn();
    const onSelect = vi.fn();
    show({ onActivate, onSelect, selectedClipId: 'c2', testId: 'decks-clip' });
    const rows = screen.getAllByTestId('decks-clip-row');
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
    expect(rows[0].getAttribute('aria-selected')).toBe('false');
    fireEvent.mouseEnter(rows[0]);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ clipId: 'c1' }));
    fireEvent.click(screen.getByTestId('decks-clip-c3'));
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ clipId: 'c3' }));
  });
});

describe('clip sort and filter', () => {
  it('walks a column through ascending, descending and off', () => {
    const asc = nextClipSort(null, 'name');
    expect(asc).toEqual({ field: 'name', desc: false });
    const desc = nextClipSort(asc, 'name');
    expect(desc).toEqual({ field: 'name', desc: true });
    // Off again, because the store's own order (oldest first) is worth
    // being able to get back.
    expect(nextClipSort(desc, 'name')).toBeNull();
    // A different column starts over, ascending.
    expect(nextClipSort(desc, 'bpm')).toEqual({ field: 'bpm', desc: false });
    expect(sortClips(CLIPS, null)).toBe(CLIPS);
  });

  it('orders by every field a column offers', () => {
    const names = (sort: ClipSort) => sortClips(CLIPS, sort).map((c) => c.name);
    expect(names({ field: 'name', desc: false })).toEqual([
      'chorus stack',
      'main drums',
      'old bass run',
    ]);
    expect(names({ field: 'beats', desc: true })).toEqual([
      'chorus stack',
      'main drums',
      'old bass run',
    ]);
    expect(names({ field: 'artist', desc: false })).toEqual([
      'old bass run',
      'main drums',
      'chorus stack',
    ]);
    // A clip with no source sorts on the empty name it shows, not on a
    // hash nobody reads.
    expect(names({ field: 'track', desc: false })[0]).toBe('old bass run');
  });

  it('narrows by text, stems, track and artist, all at once', () => {
    const names = (f: Parameters<typeof filterClips>[1]) =>
      filterClips(CLIPS, f).map((c) => c.name);
    // The search box reads every name a row shows: the clip's, its
    // track's and its artist's.
    expect(names({ query: 'basement' })).toEqual(['main drums']);
    expect(names({ query: 'ovid' })).toEqual(['chorus stack']);
    // Word by word, so the order they are typed in does not matter.
    expect(names({ query: 'stack rooftop' })).toEqual(['chorus stack']);
    // A mix clip contains every part; a clip that says nothing about its
    // parts makes no claim and drops out.
    expect(names({ stems: ['bass'] })).toEqual(['chorus stack']);
    // The pointer is the hash, so the filter follows a rename.
    expect(names({ trackHash: 'h1' })).toEqual(['main drums']);
    expect(names({ artist: 'nadia' })).toEqual(['main drums']);
    expect(names({ artist: 'Nadia', query: 'chorus' })).toEqual([]);
  });
});

describe('songs by tempo', () => {
  it('groups the clips by source, slowest song first, on the songs’ own tempo', () => {
    const songs = songsByBpm([
      ...CLIPS,
      clip({
        clipId: 'c4',
        name: 'second chorus',
        bpm: 174,
        sources: [{ trackHash: 'h2', title: 'Rooftop Take', artist: 'Ovid' }],
      }),
      clip({ clipId: 'c5', name: 'more drums', bpm: 120 }),
      // Same song again, at half its tempo: the song takes the MEDIAN of
      // its clips, so one outlier does not decide where it sorts.
      clip({ clipId: 'c6', name: 'half-time drums', bpm: 60 }),
    ]);
    expect(songs.map((s) => [s.title, s.bpm])).toEqual([
      // c3 has no source at all: still offered, under a heading of its own.
      ['no source recorded', 90],
      ['Basement Loop', 120],
      ['Rooftop Take', 174],
    ]);
    // A song holds every clip cut from it, whatever their tempo.
    expect(songs[1].clips.map((c) => c.clipId)).toEqual(['c1', 'c5', 'c6']);
    expect(songs[2].clips.map((c) => c.clipId)).toEqual(['c2', 'c4']);
  });

  it('finds the song nearest a bank’s tempo, and says so about an empty list', () => {
    const songs = songsByBpm(CLIPS);
    expect(songs[songNearestBpm(songs, 128)].title).toBe('Basement Loop');
    expect(songs[songNearestBpm(songs, 170)].title).toBe('Rooftop Take');
    // Below everything: the slowest, not a failure.
    expect(songs[songNearestBpm(songs, 20)].title).toBe('no source recorded');
    expect(songNearestBpm([], 120)).toBe(-1);
  });
});
