import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MAX_SHOWN, TrackPicker, matchTracks } from '../src/components/TrackPicker';
import type { Track } from '../src/library';

function track(id: number, title: string, artist = 'Band', album = ''): Track {
  return {
    id,
    title,
    artist,
    album,
    file_path: `/music/${id}.wav`,
    content_hash: `hash${id}`,
    format: 'wav',
    duration_secs: 60,
    sample_rate: 44100,
    channels: 2,
    source: 'watch',
    source_ref: '',
    added_at: '',
    updated_at: '',
  } as unknown as Track;
}

const LIBRARY = [
  track(1, 'Subterranean Homesick Blues', 'Bob Dylan', 'Bringing It All Back Home'),
  track(2, 'Boys of Summer', 'Don Henley'),
  track(3, 'Blue Monday', 'New Order'),
];

function picker(onChange = vi.fn(), value: number | null = null) {
  render(<TrackPicker tracks={LIBRARY} value={value} onChange={onChange} />);
  return onChange;
}

const search = () => screen.getByTestId('track-picker-search') as HTMLInputElement;
const open = () => fireEvent.focus(search());

describe('the searchable track picker', () => {
  it('takes the words in any order, and ignores case', () => {
    expect(matchTracks(LIBRARY, 'dylan blues').map((t) => t.id)).toEqual([1]);
    expect(matchTracks(LIBRARY, 'BLUES DYLAN').map((t) => t.id)).toEqual([1]);
    // The album counts as part of the track: it is how anyone finds the
    // one song on a record whose title they cannot remember.
    expect(matchTracks(LIBRARY, 'bringing').map((t) => t.id)).toEqual([1]);
    expect(matchTracks(LIBRARY, '').map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it('narrows as you type and hands back the id you click', () => {
    const onChange = picker();
    open();
    expect(screen.getAllByRole('option')).toHaveLength(3);

    fireEvent.change(search(), { target: { value: 'blue' } });
    const shown = screen.getAllByRole('option').map((o) => o.textContent);
    expect(shown).toHaveLength(2);
    expect(shown[0]).toContain('Subterranean Homesick Blues');

    fireEvent.click(screen.getByTestId('track-picker-option-3'));
    expect(onChange).toHaveBeenCalledWith(3);
    // Chosen: the list is put away and the input reads back the choice.
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('walks the list with the arrows and takes one with Enter', () => {
    const onChange = picker();
    open();
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(LIBRARY[2].id);
  });

  it('says so when nothing matches, instead of an empty box', () => {
    picker();
    open();
    fireEvent.change(search(), { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByTestId('track-picker-empty').textContent).toContain('zzz');
  });

  it('draws a page of matches and says how many more there are', () => {
    const many = Array.from({ length: MAX_SHOWN + 7 }, (_, i) => track(100 + i, `Take ${i}`));
    render(<TrackPicker tracks={many} value={null} onChange={vi.fn()} />);
    open();
    expect(screen.getAllByRole('option')).toHaveLength(MAX_SHOWN);
    expect(screen.getByTestId('track-picker-more').textContent).toContain('7 more');
  });

  it('shows the chosen track when it is closed, and the search when it is open', () => {
    picker(vi.fn(), 2);
    expect(search().value).toContain('Boys of Summer');
    open();
    expect(search().value).toBe('');
    // Escape puts the list away without changing the choice.
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(search().value).toContain('Boys of Summer');
  });

  // Space is play/pause on every page this can appear on: typing a query
  // must not also start the audio behind it.
  it('keeps its typing to itself', () => {
    const heard: string[] = [];
    const spy = (e: KeyboardEvent) => heard.push(e.key);
    window.addEventListener('keydown', spy);
    picker();
    open();
    fireEvent.keyDown(search(), { key: ' ' });
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    window.removeEventListener('keydown', spy);
    expect(heard).toEqual([]);
  });
});
