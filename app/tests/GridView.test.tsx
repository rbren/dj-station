// The Grid page against a mock clip store: loading rows through the
// two-level picker, the group heading a track's rows share, placing a
// clip by its one, the master tempo lane, the loop drag and the
// transport.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BeatClipApi, BeatClipEntry } from '../src/beatClip';
import { GridView } from '../src/components/GridView';
import { median, pickerTracks } from '../src/components/GridClipPicker';
import { GridTransport } from '../src/gridTransport';

function clip(over: Partial<BeatClipEntry> = {}): BeatClipEntry {
  return {
    clipId: 'c1',
    name: 'main drums',
    bpm: 120,
    beats: 4,
    stems: ['drums'],
    editable: true,
    ones: [0],
    sources: [{ trackHash: 'h1', title: 'Basement Loop', artist: 'Nadia' }],
    ...over,
  };
}

const CLIPS: BeatClipEntry[] = [
  clip(),
  clip({
    clipId: 'c2',
    name: 'chorus stack',
    beats: 8,
    // The one is the clip's SECOND beat: what makes the placement
    // arithmetic visible on screen.
    ones: [1, 5],
  }),
  clip({
    clipId: 'c3',
    name: 'amen roll',
    bpm: 174,
    beats: 4,
    sources: [{ trackHash: 'h2', title: 'Jungle Thing', artist: 'DJ X' }],
  }),
];

function makeClips(entries = CLIPS): BeatClipApi {
  return {
    list: vi.fn().mockResolvedValue(entries),
    load: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue([]),
    audio: vi.fn().mockResolvedValue(null),
    peaks: vi.fn().mockResolvedValue([]),
    gridSave: vi.fn().mockResolvedValue(undefined),
    gridLoad: vi.fn().mockResolvedValue(null),
    gridList: vi.fn().mockResolvedValue([]),
  };
}

const NO_POLL = 100000;

function show(
  clips: BeatClipApi = makeClips(),
  over: Partial<Parameters<typeof GridView>[0]> = {},
) {
  return render(<GridView clips={clips} pollMs={NO_POLL} {...over} />);
}

/** Add every clip cut from a track, through the picker. */
async function addTrack(hash: string) {
  fireEvent.click(screen.getByTestId('grid-add'));
  await waitFor(() => expect(screen.getByTestId('grid-picker')).toBeTruthy());
  fireEvent.click(screen.getByTestId(`grid-picker-track-${hash}`));
  await waitFor(() => expect(screen.queryByTestId('grid-picker')).toBeNull());
}

/** Add one clip, expanding its track first. */
async function addClip(hash: string, clipId: string) {
  fireEvent.click(screen.getByTestId('grid-add'));
  await waitFor(() => expect(screen.getByTestId('grid-picker')).toBeTruthy());
  fireEvent.click(screen.getByTestId(`grid-picker-expand-${hash}`));
  fireEvent.click(screen.getByTestId(`grid-picker-clip-${clipId}`));
  await waitFor(() => expect(screen.queryByTestId('grid-picker')).toBeNull());
}

describe('GridView', () => {
  it('starts empty and says how to begin', async () => {
    show();
    await waitFor(() => expect(screen.getByTestId('grid-empty')).toBeTruthy());
  });

  it('shows tracks first, and expands one to its clips', async () => {
    show();
    fireEvent.click(screen.getByTestId('grid-add'));
    await waitFor(() => expect(screen.getByTestId('grid-picker')).toBeTruthy());
    // The tracks are what the list offers; the clips inside are behind
    // the disclosure.
    expect(screen.getByTestId('grid-picker-track-h1')).toBeTruthy();
    expect(screen.queryByTestId('grid-picker-clip-c1')).toBeNull();
    fireEvent.click(screen.getByTestId('grid-picker-expand-h1'));
    expect(screen.getByTestId('grid-picker-clip-c1')).toBeTruthy();
    expect(screen.getByTestId('grid-picker-clip-c2')).toBeTruthy();
    // …and the other track's clips are not in there with them.
    expect(screen.queryByTestId('grid-picker-clip-c3')).toBeNull();
  });

  it('takes a whole track as one row per clip, under ONE title', async () => {
    show();
    await addTrack('h1');
    const group = screen.getByTestId('grid-group-h1');
    expect(group.textContent).toContain('Basement Loop');
    // Two rows, and the title is said once for both of them.
    expect(screen.getAllByTestId(/^grid-title-/)).toHaveLength(2);
    expect(screen.getAllByTestId('grid-group-h1')).toHaveLength(1);
  });

  it('groups a second track separately', async () => {
    show();
    await addTrack('h1');
    await addClip('h2', 'c3');
    expect(screen.getByTestId('grid-group-h1').textContent).toContain('Basement Loop');
    expect(screen.getByTestId('grid-group-h2').textContent).toContain('Jungle Thing');
  });

  it('a loaded row is EMPTY until a cell is clicked', async () => {
    show();
    await addClip('h1', 'c1');
    const cells = screen.getByTestId('grid-cells-row1');
    for (const cell of within(cells).getAllByRole('button')) {
      expect(cell.getAttribute('data-kind')).toBe('empty');
    }
  });

  it('places the clip centred on its first one', async () => {
    show();
    // c2: 8 beats, ones at 1 and 5. Clicked at column 10 it fills 9..16,
    // with its one ON 10.
    await addClip('h1', 'c2');
    fireEvent.click(screen.getByTestId('grid-cell-row1-10'));
    await waitFor(() =>
      expect(screen.getByTestId('grid-cell-row1-10').getAttribute('data-kind')).toBe('lead'),
    );
    expect(screen.getByTestId('grid-cell-row1-9').getAttribute('data-kind')).toBe('beat');
    expect(screen.getByTestId('grid-cell-row1-16').getAttribute('data-kind')).toBe('beat');
    expect(screen.getByTestId('grid-cell-row1-8').getAttribute('data-kind')).toBe('empty');
    expect(screen.getByTestId('grid-cell-row1-17').getAttribute('data-kind')).toBe('empty');
    // The clip's OTHER one gets its own treatment, short of the lead's.
    expect(screen.getByTestId('grid-cell-row1-14').getAttribute('data-kind')).toBe('one');
  });

  it('clicking a placed cell takes the copy away again', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-4'));
    await waitFor(() =>
      expect(screen.getByTestId('grid-cell-row1-4').getAttribute('data-kind')).toBe('lead'),
    );
    fireEvent.click(screen.getByTestId('grid-cell-row1-6'));
    await waitFor(() =>
      expect(screen.getByTestId('grid-cell-row1-4').getAttribute('data-kind')).toBe('empty'),
    );
  });

  it('clears a row without unloading it, and ejects it on demand', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-4'));
    await waitFor(() => expect(screen.getByTestId('grid-clear-row1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('grid-clear-row1'));
    await waitFor(() =>
      expect(screen.getByTestId('grid-cell-row1-4').getAttribute('data-kind')).toBe('empty'),
    );
    expect(screen.getByTestId('grid-title-row1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('grid-eject-row1'));
    await waitFor(() => expect(screen.queryByTestId('grid-title-row1')).toBeNull());
  });

  // The length is TYPED, not stepped: "how many beats is this piece" has
  // an answer, and clicking + four times to reach it is not it.
  it('takes the grid length as a number, and reports the beats in use', async () => {
    show();
    const beats = await screen.findByTestId('grid-beats');
    expect((beats as HTMLInputElement).value).toBe('32');
    fireEvent.change(beats, { target: { value: '64' } });
    await waitFor(() => expect((beats as HTMLInputElement).value).toBe('64'));
    fireEvent.change(beats, { target: { value: '0' } });
    await waitFor(() => expect((beats as HTMLInputElement).value).toBe('1'));
    expect(screen.getByTestId('grid-duration').textContent).toContain('beats');
  });

  it('the tempo lane is quiet until a breakpoint is drawn on it', async () => {
    show();
    const lane = await screen.findByTestId('grid-tempo-lane');
    expect(lane.getAttribute('data-empty')).toBe('true');
    expect(screen.queryByTestId('grid-tempo-lane-point-0')).toBeNull();
    // jsdom gives every element a zero-size rect, so the click lands at
    // beat 0 with the lane's top value — enough to prove the lane writes
    // through to the tempo the grid runs at.
    fireEvent.mouseDown(lane);
    await waitFor(() => expect(screen.getByTestId('grid-tempo-lane-point-0')).toBeTruthy());
    expect(screen.getByTestId('grid-tempo-lane').getAttribute('data-empty')).toBe('false');
    expect(screen.getByTestId('grid-tempo-clear').hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByTestId('grid-tempo-clear'));
    await waitFor(() => expect(screen.queryByTestId('grid-tempo-lane-point-0')).toBeNull());
  });

  it('the master BPM box sets the tempo the grid runs at', async () => {
    show();
    const bpm = await screen.findByTestId('grid-bpm');
    fireEvent.change(bpm, { target: { value: '145' } });
    await waitFor(() => expect(screen.getByTestId('grid-bpm-here').textContent).toContain('145.0'));
  });

  // The readout only APPEARS when there is a loop: an empty grid should
  // not carry a line of text telling you what you have not done.
  it('a drag across the ruler marks the loop, and it can be cleared', async () => {
    show();
    await screen.findByTestId('grid-ruler');
    expect(screen.queryByTestId('grid-loop')).toBeNull();
    const ruler = screen.getByTestId('grid-ruler');
    // jsdom has no layout: every clientX maps to column 0, so the drag
    // marks one column — which is still a loop, and still clears.
    fireEvent.mouseDown(ruler, { clientX: 0 });
    fireEvent.mouseMove(ruler, { clientX: 40 });
    fireEvent.mouseUp(ruler);
    await waitFor(() => expect(screen.getByTestId('grid-loop').textContent).toContain('loop 1'));
    fireEvent.click(screen.getByTestId('grid-loop-clear'));
    await waitFor(() => expect(screen.queryByTestId('grid-loop')).toBeNull());
  });

  it('plays and pauses', async () => {
    const clips = makeClips();
    show(clips);
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-0'));
    fireEvent.click(screen.getByTestId('grid-play'));
    await waitFor(() =>
      expect(screen.getByTestId('grid-play').getAttribute('aria-pressed')).toBe('true'),
    );
    fireEvent.click(screen.getByTestId('grid-pause'));
    await waitFor(() =>
      expect(screen.getByTestId('grid-play').getAttribute('aria-pressed')).toBe('false'),
    );
  });

  // PAUSE KEEPS THE PLACE. That is the whole difference from a stop: the
  // beat readout does not jump back to the top of the range.
  it('pauses where the playhead is rather than rewinding', async () => {
    const transport = new GridTransport(makeClips());
    vi.spyOn(transport, 'pause').mockReturnValue(9);
    render(<GridView clips={makeClips()} pollMs={NO_POLL} transport={transport} active />);
    await screen.findByTestId('grid-view');
    fireEvent.click(screen.getByTestId('grid-play'));
    fireEvent.click(screen.getByTestId('grid-pause'));
    await waitFor(() =>
      expect(screen.getByTestId('grid-position').textContent).toContain('beat 10'),
    );
  });

  // SPACE is play/pause and the arrows walk the playhead, the way every
  // editor with a transport works.
  it('takes space and the arrows as transport keys', async () => {
    const transport = new GridTransport(makeClips());
    const play = vi.spyOn(transport, 'play');
    const seek = vi.spyOn(transport, 'seek');
    render(<GridView clips={makeClips()} pollMs={NO_POLL} transport={transport} active />);
    await screen.findByTestId('grid-view');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(seek).toHaveBeenCalledWith(1));
    fireEvent.keyDown(window, { key: ' ' });
    await waitFor(() => expect(play).toHaveBeenCalled());
  });

  // A typed field owns the keyboard while it has focus: space in the bpm
  // box is a space, not a transport command.
  it('leaves the transport keys alone while a field is focused', async () => {
    const transport = new GridTransport(makeClips());
    const play = vi.spyOn(transport, 'play');
    render(<GridView clips={makeClips()} pollMs={NO_POLL} transport={transport} active />);
    const bpm = await screen.findByTestId('grid-bpm');
    bpm.focus();
    fireEvent.keyDown(bpm, { key: ' ' });
    expect(play).not.toHaveBeenCalled();
  });

  it('stops when the tab is left', async () => {
    const transport = new GridTransport(makeClips());
    const stop = vi.spyOn(transport, 'stop');
    const { rerender } = render(
      <GridView clips={makeClips()} pollMs={NO_POLL} transport={transport} active />,
    );
    await waitFor(() => expect(screen.getByTestId('grid-view')).toBeTruthy());
    rerender(
      <GridView clips={makeClips()} pollMs={NO_POLL} transport={transport} active={false} />,
    );
    await waitFor(() => expect(stop).toHaveBeenCalled());
    // Hidden, not unmounted: the arrangement survives the tab switch.
    expect(screen.getByTestId('grid-view').style.display).toBe('none');
  });
});

// The picker is ordered by TEMPO, slowest first: the grid runs at one
// master tempo, so how far a track has to be stretched to sit on it is
// the useful thing to sort by.
describe('the picker order', () => {
  it('orders tracks by their median clip tempo, and says what it is', () => {
    const tracks = pickerTracks(CLIPS);
    expect(tracks.map((t) => t.key)).toEqual(['h1', 'h2']);
    // h1 holds a 120 and a 120; h2 a single 174.
    expect(tracks[0].medianBpm).toBe(120);
    expect(tracks[1].medianBpm).toBe(174);
  });

  // MEDIAN, not mean: one clip read at half time should not drag the
  // whole track's number down with it.
  it('takes the median so an outlier clip does not move the track', () => {
    expect(median([120, 121, 122])).toBe(121);
    expect(median([60, 120, 122, 124])).toBe(121);
    expect(median([])).toBe(0);
  });
});

// A PLACED CLIP IS ONE BLOCK, not a run of squares: one element spanning
// the beats it covers, with the ones marked inside it.
describe('GridView clip blocks', () => {
  it('draws each copy as a single block spanning its beats', async () => {
    const clips = makeClips();
    show(clips);
    // 'chorus stack': 8 beats, first one on its second beat. Clicked at
    // column 10, it runs 9..16.
    await addClip('h1', 'c2');
    fireEvent.click(screen.getByTestId('grid-cell-row1-10'));
    const block = await screen.findByTestId('grid-clip-row1-9');
    expect(block.style.width).toBe(`${8 * 22}px`);
    expect(block.style.left).toBe(`${9 * 22}px`);
    // One block, not eight.
    expect(document.querySelectorAll('[data-testid^="grid-clip-row1-"]')).toHaveLength(1);
  });

  it('marks each cell with where it sits in the clip, for the edges', async () => {
    const clips = makeClips();
    show(clips);
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-4'));
    // 'main drums': 4 beats, one at its first, so 4..7.
    expect(screen.getByTestId('grid-cell-row1-4').getAttribute('data-edge')).toBe('start');
    expect(screen.getByTestId('grid-cell-row1-5').getAttribute('data-edge')).toBe('mid');
    expect(screen.getByTestId('grid-cell-row1-7').getAttribute('data-edge')).toBe('end');
    expect(screen.getByTestId('grid-cell-row1-8').getAttribute('data-edge')).toBe('none');
  });
});

describe('GridView level line', () => {
  it('draws a resting line through every row until one is written on', async () => {
    show();
    await addClip('h1', 'c1');
    const line = await screen.findByTestId('grid-level-row1');
    expect(line.getAttribute('data-written')).toBe('false');
    expect(screen.queryByTestId('grid-level-point-row1-0')).toBeNull();
  });

  // cmd/ctrl+click is the level gesture: a bare click on the same cell
  // places a clip, so the modifier is what tells them apart.
  it('writes a point on cmd+click, and leaves the row empty of clips', async () => {
    show();
    await addClip('h1', 'c1');
    const row = screen.getByTestId('grid-cells-row1');
    fireEvent.mouseDown(row, { metaKey: true, clientX: 0, clientY: 0 });
    await waitFor(() =>
      expect(screen.getByTestId('grid-level-row1').getAttribute('data-written')).toBe('true'),
    );
    // The clip was NOT placed by that gesture.
    expect(document.querySelectorAll('[data-testid^="grid-clip-row1-"]')).toHaveLength(0);
  });

  it('leaves the level alone for a plain click, which places the clip', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-0'));
    await waitFor(() => expect(screen.getByTestId('grid-clip-row1-0')).toBeTruthy());
    expect(screen.getByTestId('grid-level-row1').getAttribute('data-written')).toBe('false');
  });
});

describe('GridView selection', () => {
  it('marks a rectangle as a drag crosses cells, and clears on Escape', async () => {
    show();
    await addTrack('h1');
    const from = screen.getByTestId('grid-cell-row1-2');
    fireEvent.mouseDown(from);
    fireEvent.mouseEnter(screen.getByTestId('grid-cell-row2-6'));
    await waitFor(() =>
      expect(screen.getByTestId('grid-cell-row1-4').getAttribute('data-selected')).toBe('true'),
    );
    // Both rows, and the columns between the two ends.
    expect(screen.getByTestId('grid-cell-row2-4').getAttribute('data-selected')).toBe('true');
    expect(screen.getByTestId('grid-cell-row1-8').getAttribute('data-selected')).toBe('false');
    fireEvent.mouseUp(screen.getByTestId('grid-cell-row2-6'));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.getByTestId('grid-cell-row1-4').getAttribute('data-selected')).toBe('false'),
    );
  });

  // A drag that crossed cells is a SELECTION, so the click that ends it
  // must not also drop a clip where it landed.
  it('does not place a clip when the drag was a selection', async () => {
    show();
    await addClip('h1', 'c1');
    const from = screen.getByTestId('grid-cell-row1-2');
    fireEvent.mouseDown(from);
    fireEvent.mouseEnter(screen.getByTestId('grid-cell-row1-6'));
    fireEvent.mouseUp(screen.getByTestId('grid-cell-row1-6'));
    fireEvent.click(screen.getByTestId('grid-cell-row1-6'));
    expect(document.querySelectorAll('[data-testid^="grid-clip-row1-"]')).toHaveLength(0);
  });

  it('deletes what a selection covers', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-4'));
    await screen.findByTestId('grid-clip-row1-4');
    fireEvent.mouseDown(screen.getByTestId('grid-cell-row1-0'));
    fireEvent.mouseEnter(screen.getByTestId('grid-cell-row1-8'));
    fireEvent.mouseUp(screen.getByTestId('grid-cell-row1-8'));
    fireEvent.keyDown(window, { key: 'Backspace' });
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid^="grid-clip-row1-"]')).toHaveLength(0),
    );
  });
});

describe('GridView files', () => {
  it('saves under a typed name, and stops calling itself dirty', async () => {
    const clips = makeClips();
    show(clips);
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-0'));
    await waitFor(() => expect(screen.getByTestId('grid-name').textContent).toContain('•'));
    fireEvent.click(screen.getByTestId('grid-save-as'));
    const field = await screen.findByTestId('grid-save-name');
    fireEvent.change(field, { target: { value: 'friday set' } });
    fireEvent.click(screen.getByTestId('grid-save-confirm'));
    await waitFor(() => expect(clips.gridSave).toHaveBeenCalled());
    const [name, doc] = (clips.gridSave as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(name).toBe('friday set');
    expect(JSON.parse(doc).state.rows[0].clipId).toBe('c1');
    await waitFor(() => expect(screen.getByTestId('grid-name').textContent).not.toContain('•'));
  });

  it('opens a saved grid, replacing what was on screen', async () => {
    const clips = makeClips();
    (clips.gridList as ReturnType<typeof vi.fn>).mockResolvedValue(['friday set']);
    (clips.gridLoad as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        version: 1,
        state: {
          rows: [{ id: 'row1', clipId: 'c3', placements: [2], levels: [] }],
          tempo: { bpm: 174, points: [] },
          beats: 32,
          loop: null,
        },
      }),
    );
    show(clips);
    await screen.findByTestId('grid-view');
    fireEvent.click(screen.getByTestId('grid-open'));
    fireEvent.click(await screen.findByTestId('grid-open-friday set'));
    await waitFor(() => expect(screen.getByTestId('grid-name').textContent).toContain('friday set'));
    // The opened grid's tempo and its placed clip are both on screen.
    expect((screen.getByTestId('grid-bpm') as HTMLInputElement).value).toBe('174');
    expect(screen.getByTestId('grid-clip-row1-2')).toBeTruthy();
  });

  // WORK IS NOT THROWN AWAY SILENTLY. New and Open both ask first when
  // there is something to lose, and Cancel means nothing happens.
  it('warns before New replaces unsaved work, and cancel keeps it', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-0'));
    await screen.findByTestId('grid-clip-row1-0');
    fireEvent.click(screen.getByTestId('grid-new'));
    await screen.findByTestId('grid-confirm');
    fireEvent.click(screen.getByTestId('grid-confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('grid-confirm')).toBeNull());
    expect(screen.getByTestId('grid-clip-row1-0')).toBeTruthy();
  });

  it('discards on demand, leaving an empty grid', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-0'));
    await screen.findByTestId('grid-clip-row1-0');
    fireEvent.click(screen.getByTestId('grid-new'));
    fireEvent.click(await screen.findByTestId('grid-confirm-discard'));
    await waitFor(() => expect(screen.getByTestId('grid-empty')).toBeTruthy());
    expect(screen.getByTestId('grid-name').textContent).toContain('untitled');
  });

  // An untouched grid is what New makes: there is nothing to warn about.
  it('does not warn when there is nothing to lose', async () => {
    show();
    await screen.findByTestId('grid-view');
    fireEvent.click(screen.getByTestId('grid-new'));
    expect(screen.queryByTestId('grid-confirm')).toBeNull();
  });
});
