// The Grid page against a mock clip store: loading rows through the
// two-level picker, the group heading a track's rows share, placing a
// clip by its one, the master tempo lane, the loop drag and the
// transport.

import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BeatClipApi, BeatClipEntry } from '../src/beatClip';
import { AutomationLane } from '../src/components/AutomationLane';
import {
  GridView,
  BPM_WINDOW,
  bpmTicks,
  bpmWindow,
  grabBeats,
  loopEdgeAt,
  zoomAnchor,
  zoomBy,
  MAX_ZOOM,
  MIN_ZOOM,
} from '../src/components/GridView';
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
    // A breakpoint comes off the way it went on — on the lane itself,
    // right-clicked. The "flat" button that used to do this is gone.
    fireEvent.contextMenu(screen.getByTestId('grid-tempo-lane-point-0'));
    await waitFor(() => expect(screen.queryByTestId('grid-tempo-lane-point-0')).toBeNull());
  });

  it('the BPM box sets the tempo the grid runs at', async () => {
    show();
    const bpm = await screen.findByTestId('grid-bpm');
    fireEvent.change(bpm, { target: { value: '145' } });
    // The box IS the readout now — the separate "here" line it used to
    // be checked against is gone.
    await waitFor(() => expect((bpm as HTMLInputElement).value).toBe('145'));
  });

  it('a drag across the ruler marks the loop, and it can be cleared', async () => {
    show();
    await screen.findByTestId('grid-ruler');
    expect(screen.queryByTestId('grid-loop-handle-start')).toBeNull();
    const ruler = screen.getByTestId('grid-ruler');
    // jsdom has no layout: every clientX maps to column 0, so the drag
    // marks one column — which is still a loop, and still clears.
    fireEvent.mouseDown(ruler, { clientX: 0 });
    fireEvent.mouseMove(ruler, { clientX: 40 });
    fireEvent.mouseUp(ruler);
    // The loop shows as marked columns and a pair of handles, not as a
    // line of text saying "loop 1–2".
    await waitFor(() =>
      expect(screen.getByTestId('grid-ruler-0').getAttribute('data-loop')).toBe('true'),
    );
    expect(screen.getByTestId('grid-loop-handle-start')).toBeTruthy();
    expect(screen.getByTestId('grid-loop-handle-end')).toBeTruthy();
    fireEvent.click(screen.getByTestId('grid-loop-clear'));
    await waitFor(() => expect(screen.queryByTestId('grid-loop-handle-start')).toBeNull());
  });

  it('zooms in and out, and stops at the ends', async () => {
    show();
    await screen.findByTestId('grid-view');
    expect(screen.getByTestId('grid-zoom').textContent).toBe('100%');
    fireEvent.click(screen.getByTestId('grid-zoom-in'));
    await waitFor(() => expect(screen.getByTestId('grid-zoom').textContent).toBe('115%'));
    fireEvent.click(screen.getByTestId('grid-zoom-out'));
    await waitFor(() => expect(screen.getByTestId('grid-zoom').textContent).toBe('100%'));
  });

  it('the wheel over the ruler zooms, and nowhere else does', async () => {
    show();
    const ruler = await screen.findByTestId('grid-ruler');
    // A NOTCH of the wheel is 100 units of delta and one 15% step; the
    // zoom itself is continuous in between, and lands on the next frame.
    fireEvent.wheel(ruler, { deltaY: -100 });
    await waitFor(() => expect(screen.getByTestId('grid-zoom').textContent).toBe('115%'));
    // The body is for scrolling. A wheel there must not resize anything.
    fireEvent.wheel(screen.getByTestId('grid-scroll'), { deltaY: -100 });
    expect(screen.getByTestId('grid-zoom').textContent).toBe('115%');
  });

  it('takes a half-notch of the wheel as half a step, not a whole one', async () => {
    show();
    const ruler = await screen.findByTestId('grid-ruler');
    // The clicky part of the old zoom was a fixed step per EVENT: a
    // trackpad's small deltas each jumped a full 15%.
    fireEvent.wheel(ruler, { deltaY: -50 });
    await waitFor(() => expect(screen.getByTestId('grid-zoom').textContent).toBe('107%'));
  });

  it('zooms on cmd +/-', async () => {
    show();
    await screen.findByTestId('grid-view');
    fireEvent.keyDown(window, { key: '=', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('grid-zoom').textContent).toBe('115%'));
    fireEvent.keyDown(window, { key: '-', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('grid-zoom').textContent).toBe('100%'));
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
    // Geometry is written in BEATS off the zoom variable, so the block
    // follows a zoom without React re-rendering the row.
    expect(block.style.width).toBe('calc(var(--grid-cell-w) * 8)');
    expect(block.style.left).toBe('calc(var(--grid-cell-w) * 9)');
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

describe('GridView selection drags', () => {
  /** Mark a rectangle across one row. */
  function sweep(rowId: string, from: number, to: number) {
    fireEvent.mouseDown(screen.getByTestId(`grid-cell-${rowId}-${from}`));
    fireEvent.mouseOver(screen.getByTestId(`grid-cell-${rowId}-${to}`));
    fireEvent.mouseUp(screen.getByTestId(`grid-cell-${rowId}-${to}`));
  }

  it('drags what is selected to another beat', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-4'));
    await screen.findByTestId('grid-clip-row1-4');

    sweep('row1', 3, 8);
    await waitFor(() =>
      expect(screen.getByTestId('grid-cell-row1-4').getAttribute('data-selected')).toBe('true'),
    );

    // A press INSIDE the rectangle takes hold of it; the drag carries
    // the copy along and leaves nothing behind.
    fireEvent.mouseDown(screen.getByTestId('grid-cell-row1-4'));
    fireEvent.mouseOver(screen.getByTestId('grid-cell-row1-12'));
    fireEvent.mouseUp(screen.getByTestId('grid-cell-row1-12'));
    await waitFor(() => expect(screen.getByTestId('grid-clip-row1-12')).toBeTruthy());
    expect(document.querySelectorAll('[data-testid^="grid-clip-row1-"]')).toHaveLength(1);
    // The selection travelled with it, so it can be dragged on again.
    expect(screen.getByTestId('grid-cell-row1-12').getAttribute('data-selected')).toBe('true');
  });

  it('cmd+drag leaves the original and carries a copy', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-4'));
    await screen.findByTestId('grid-clip-row1-4');

    sweep('row1', 3, 8);
    await waitFor(() =>
      expect(screen.getByTestId('grid-cell-row1-4').getAttribute('data-selected')).toBe('true'),
    );

    fireEvent.mouseDown(screen.getByTestId('grid-cell-row1-4'), { metaKey: true });
    fireEvent.mouseOver(screen.getByTestId('grid-cell-row1-12'));
    fireEvent.mouseUp(screen.getByTestId('grid-cell-row1-12'));
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid^="grid-clip-row1-"]')).toHaveLength(2),
    );
    // The copy is a copy: the original is still on beat 4, and no level
    // point was written where cmd normally writes one.
    expect(screen.getByTestId('grid-clip-row1-4')).toBeTruthy();
    expect(screen.getByTestId('grid-level-row1').getAttribute('data-written')).toBe('false');
  });

  // A whole drag is ONE undo step, however many columns it passed
  // through on the way.
  it('takes a whole drag back in one undo', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-4'));
    await screen.findByTestId('grid-clip-row1-4');
    sweep('row1', 3, 8);
    await waitFor(() =>
      expect(screen.getByTestId('grid-cell-row1-4').getAttribute('data-selected')).toBe('true'),
    );

    fireEvent.mouseDown(screen.getByTestId('grid-cell-row1-4'));
    fireEvent.mouseOver(screen.getByTestId('grid-cell-row1-8'));
    fireEvent.mouseOver(screen.getByTestId('grid-cell-row1-12'));
    fireEvent.mouseUp(screen.getByTestId('grid-cell-row1-12'));
    await waitFor(() => expect(screen.getByTestId('grid-clip-row1-12')).toBeTruthy());

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('grid-clip-row1-4')).toBeTruthy());
  });

  it('fills a marked rectangle with clips on Enter', async () => {
    show();
    await addClip('h1', 'c1');
    sweep('row1', 0, 11);
    await waitFor(() =>
      expect(screen.getByTestId('grid-cell-row1-4').getAttribute('data-selected')).toBe('true'),
    );
    fireEvent.keyDown(window, { key: 'Enter' });
    // Twelve beats of a four-beat clip: three copies, back to back.
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid^="grid-clip-row1-"]')).toHaveLength(3),
    );
    expect(screen.getByTestId('grid-clip-row1-0')).toBeTruthy();
    expect(screen.getByTestId('grid-clip-row1-4')).toBeTruthy();
    expect(screen.getByTestId('grid-clip-row1-8')).toBeTruthy();
  });
});

describe('the tempo lane window', () => {
  it('spans 15 bpm either side of the grid tempo, and says so', async () => {
    show();
    const readout = await screen.findByTestId('grid-bpm-range');
    expect(readout.textContent).toContain('105–135');
  });

  it('opens each end on its own, and closes it again', async () => {
    show();
    const readout = await screen.findByTestId('grid-bpm-range');
    fireEvent.click(screen.getByTestId('grid-bpm-up-more'));
    await waitFor(() => expect(readout.textContent).toContain('105–150'));
    fireEvent.click(screen.getByTestId('grid-bpm-down-more'));
    await waitFor(() => expect(readout.textContent).toContain('90–150'));
    fireEvent.click(screen.getByTestId('grid-bpm-up-less'));
    await waitFor(() => expect(readout.textContent).toContain('90–135'));
    // The default window is as narrow as it goes.
    expect(screen.getByTestId('grid-bpm-up-less').hasAttribute('disabled')).toBe(true);
  });

  it('takes a window around the tempo, widened by whatever is written outside it', () => {
    expect(bpmWindow(128, [], { up: BPM_WINDOW, down: BPM_WINDOW })).toEqual({
      min: 113,
      max: 143,
    });
    // A point outside the window is still reachable — a breakpoint you
    // cannot see is one you cannot take back.
    expect(bpmWindow(128, [{ bpm: 170 }], { up: BPM_WINDOW, down: BPM_WINDOW })).toEqual({
      min: 113,
      max: 170,
    });
    // And nothing outside what the engine will play.
    expect(bpmWindow(25, [], { up: 15, down: 90 }).min).toBe(20);
  });

  it('rules every 5 bpm, coarsening as the window opens', () => {
    expect(bpmTicks(105, 135)).toEqual([105, 110, 115, 120, 125, 130, 135]);
    // Sixty bpm of window is twelve rules at 5; wider than that and the
    // step coarsens rather than drawing a hatch.
    expect(bpmTicks(60, 180).every((v) => v % 10 === 0)).toBe(true);
    expect(bpmTicks(60, 180).length).toBeLessThanOrEqual(13);
  });
});

describe('the BPM box', () => {
  // THE BUG: every keystroke was read as a tempo, so the "1" on the way
  // to "140" was clamped to the minimum and the rest was typed onto it.
  it('does not take the tempo until Enter', async () => {
    show();
    const bpm = (await screen.findByTestId('grid-bpm')) as HTMLInputElement;
    fireEvent.change(bpm, { target: { value: '1' } });
    fireEvent.change(bpm, { target: { value: '14' } });
    fireEvent.change(bpm, { target: { value: '140' } });
    expect(bpm.value).toBe('140');
    // The lane's window still reads the tempo in force, which has not
    // moved yet.
    expect(screen.getByTestId('grid-bpm-range').textContent).toContain('105–135');
    fireEvent.keyDown(bpm, { key: 'Enter' });
    await waitFor(() =>
      expect(screen.getByTestId('grid-bpm-range').textContent).toContain('125–155'),
    );
  });

  it('takes it on blur too, and Escape puts the box back', async () => {
    show();
    const bpm = (await screen.findByTestId('grid-bpm')) as HTMLInputElement;
    fireEvent.change(bpm, { target: { value: '90' } });
    fireEvent.blur(bpm);
    await waitFor(() => expect(bpm.value).toBe('90'));

    fireEvent.change(bpm, { target: { value: '7' } });
    fireEvent.keyDown(bpm, { key: 'Escape' });
    await waitFor(() => expect(bpm.value).toBe('90'));
  });
});

describe('what a drag does to the sound', () => {
  /** The transport, with its `update` counted: the page must hand it one
   *  state per finished edit, not one per pointer move. */
  function withSpy() {
    const clips = makeClips();
    const transport = new GridTransport(clips);
    const update = vi.spyOn(transport, 'update');
    show(clips, { transport });
    return update;
  }

  it('holds the loop until the drag is let go', async () => {
    const update = withSpy();
    const ruler = await screen.findByTestId('grid-ruler');
    // The clip list lands after the first render and is itself an
    // update; the drag is what this test counts.
    await act(async () => {});
    update.mockClear();
    fireEvent.mouseDown(ruler, { clientX: 0 });
    fireEvent.mouseMove(window, { clientX: 40 });
    fireEvent.mouseMove(window, { clientX: 80 });
    await waitFor(() => expect(screen.getByTestId('grid-loop-handle-start')).toBeTruthy());
    // The loop is drawn, but the sound has not been asked to follow it.
    expect(update).not.toHaveBeenCalled();
    fireEvent.mouseUp(window, { clientX: 80 });
    await waitFor(() => expect(update).toHaveBeenCalled());
  });

  it('holds the tempo envelope until the drag is let go', async () => {
    const update = withSpy();
    const lane = await screen.findByTestId('grid-tempo-lane');
    await act(async () => {});
    update.mockClear();
    fireEvent.mouseDown(lane);
    await waitFor(() => expect(screen.getByTestId('grid-tempo-lane-point-0')).toBeTruthy());
    fireEvent.mouseDown(screen.getByTestId('grid-tempo-lane-point-0'));
    fireEvent.mouseMove(window, { clientX: 40, clientY: 10, buttons: 1 });
    expect(update).not.toHaveBeenCalled();
    fireEvent.mouseUp(window);
    await waitFor(() => expect(update).toHaveBeenCalled());
  });
});

describe('the automation lane drag', () => {
  function lane(over: Partial<React.ComponentProps<typeof AutomationLane>> = {}) {
    const props = {
      width: 200,
      height: 100,
      domain: 32,
      min: 100,
      max: 140,
      base: 120,
      points: [{ at: 4, value: 120 }],
      testId: 'lane',
      onAdd: vi.fn(),
      onMove: vi.fn(),
      onRemove: vi.fn(),
      onRelease: vi.fn(),
      ...over,
    };
    render(<AutomationLane {...props} />);
    return props;
  }

  // THE BUG: the mouse-up that ends a point drag can be eaten — the
  // browser starts a selection of its own over the SVG — and the point
  // then followed the pointer until it was clicked again.
  it('ends when the pointer comes back with no button down', () => {
    const props = lane();
    fireEvent.mouseDown(screen.getByTestId('lane-point-0'));
    fireEvent.mouseMove(window, { clientX: 20, clientY: 20, buttons: 1 });
    expect(props.onMove).toHaveBeenCalledTimes(1);

    fireEvent.mouseMove(window, { clientX: 30, clientY: 30, buttons: 0 });
    expect(props.onRelease).toHaveBeenCalled();
    (props.onMove as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.mouseMove(window, { clientX: 40, clientY: 40, buttons: 1 });
    expect(props.onMove).not.toHaveBeenCalled();
  });

  it('lets go on mouse-up, and says so once', () => {
    const props = lane();
    fireEvent.mouseDown(screen.getByTestId('lane-point-0'));
    fireEvent.mouseUp(window);
    expect(props.onRelease).toHaveBeenCalledTimes(1);
    fireEvent.mouseMove(window, { clientX: 40, clientY: 40, buttons: 1 });
    expect(props.onMove).not.toHaveBeenCalled();
  });
});

describe('GridView clipboard', () => {
  /** Sweep a selection across a row. `mouseOver` and not `mouseEnter`:
   *  the cells delegate to their row, and enter does not bubble. */
  /** Walk the playhead on by whole bars, the way cmd+arrow does. */
  function seekBars(n: number) {
    for (let i = 0; i < n; i += 1) fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true });
  }

  function sweep(rowId: string, from: number, to: number) {
    fireEvent.mouseDown(screen.getByTestId(`grid-cell-${rowId}-${from}`));
    fireEvent.mouseOver(screen.getByTestId(`grid-cell-${rowId}-${to}`));
    fireEvent.mouseUp(screen.getByTestId(`grid-cell-${rowId}-${to}`));
  }

  // THE BUG: copy then paste left ONE copy on the grid, not two. Paste
  // was landing on the selection, which is still sitting on the thing
  // that was just copied — so the copy went back where it already was
  // and nothing appeared to happen.
  it('copies a selection and pastes it where the playhead is', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-4'));
    await screen.findByTestId('grid-clip-row1-4');

    sweep('row1', 3, 8);
    await waitFor(() =>
      expect(screen.getByTestId('grid-cell-row1-4').getAttribute('data-selected')).toBe('true'),
    );

    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    // Three bars along, which is clear of the four-beat copy already
    // sitting at beat 4 — a copy cannot overlap itself in a row.
    seekBars(3);
    fireEvent.keyDown(window, { key: 'v', metaKey: true });

    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid^="grid-clip-row1-"]')).toHaveLength(2),
    );
    // The first copy is untouched: a paste ADDS, it does not move.
    expect(screen.getByTestId('grid-clip-row1-4')).toBeTruthy();
  });

  it('the Copy and Paste buttons do the same as the shortcuts', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-4'));
    await screen.findByTestId('grid-clip-row1-4');

    expect(screen.getByTestId('grid-copy').hasAttribute('disabled')).toBe(true);
    sweep('row1', 3, 8);
    await waitFor(() =>
      expect(screen.getByTestId('grid-copy').hasAttribute('disabled')).toBe(false),
    );

    fireEvent.click(screen.getByTestId('grid-copy'));
    // Nothing has been copied yet from an empty board, so Paste only
    // wakes up once there is something on it.
    await waitFor(() =>
      expect(screen.getByTestId('grid-paste').hasAttribute('disabled')).toBe(false),
    );
    seekBars(3);
    fireEvent.click(screen.getByTestId('grid-paste'));
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid^="grid-clip-row1-"]')).toHaveLength(2),
    );
  });
});

describe('GridView files', () => {
  /** The file options live behind the arrangement's NAME now: the
   *  New/Open/Save buttons that used to sit in the header are gone, so
   *  every one of these has to open that menu first. */
  function fileMenu(item: 'new' | 'open' | 'save' | 'save-as') {
    fireEvent.click(screen.getByTestId('grid-name'));
    fireEvent.click(screen.getByTestId(`grid-${item}`));
  }

  it('the title opens the file menu, and Escape closes it', async () => {
    show();
    await screen.findByTestId('grid-view');
    expect(screen.queryByTestId('grid-open')).toBeNull();
    fireEvent.click(screen.getByTestId('grid-name'));
    expect(screen.getByTestId('grid-new')).toBeTruthy();
    expect(screen.getByTestId('grid-open')).toBeTruthy();
    expect(screen.getByTestId('grid-save')).toBeTruthy();
    expect(screen.getByTestId('grid-save-as')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('grid-open')).toBeNull());
  });

  it('saves under a typed name, and stops calling itself dirty', async () => {
    const clips = makeClips();
    show(clips);
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-0'));
    await waitFor(() => expect(screen.getByTestId('grid-name').textContent).toContain('•'));
    fileMenu('save-as');
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
    fileMenu('open');
    fireEvent.click(await screen.findByTestId('grid-open-friday set'));
    await waitFor(() =>
      expect(screen.getByTestId('grid-name').textContent).toContain('friday set'),
    );
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
    fileMenu('new');
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
    fileMenu('new');
    fireEvent.click(await screen.findByTestId('grid-confirm-discard'));
    await waitFor(() => expect(screen.getByTestId('grid-empty')).toBeTruthy());
    expect(screen.getByTestId('grid-name').textContent).toContain('untitled');
  });

  // An untouched grid is what New makes: there is nothing to warn about.
  it('does not warn when there is nothing to lose', async () => {
    show();
    await screen.findByTestId('grid-view');
    fileMenu('new');
    expect(screen.queryByTestId('grid-confirm')).toBeNull();
  });
});

// jsdom has no layout, so the geometry these two do is checked directly
// rather than through a drag that would land on column 0 whatever it was
// given.
describe('grid zoom', () => {
  it('steps up and down, and stops at the ends', () => {
    expect(zoomBy(1, -100)).toBeCloseTo(1.15, 5);
    expect(zoomBy(1, 100)).toBeCloseTo(1 / 1.15, 5);
    expect(zoomBy(MAX_ZOOM, -100)).toBe(MAX_ZOOM);
    expect(zoomBy(MIN_ZOOM, 100)).toBe(MIN_ZOOM);
  });

  it('a step out then in comes back to where it started', () => {
    expect(zoomBy(zoomBy(2, 100), -100)).toBeCloseTo(2, 5);
  });
});

// ZOOMING ABOUT THE POINTER. The scroller is put back to
// `beat * cellW - x` afterwards, so these two numbers are the whole of
// whether a zoom holds still or throws the view sideways.
describe('the zoom anchor', () => {
  // Beat 0 sits at viewport x 222 when nothing is scrolled: the window's
  // edge, the body's padding and the 210 px gutter.
  const ORIGIN = 222;
  /** The ruler's viewport left, which scrolls with the content. */
  const rulerLeft = (scroll: number) => ORIGIN - scroll;

  it('takes the beat under the pointer, unscrolled', () => {
    expect(zoomAnchor(ORIGIN + 10 * 22, rulerLeft(0), 0, 22)).toEqual({ beat: 10, x: 220 });
  });

  it('takes the scroll OUT of the offset it holds', () => {
    // The same beat, now scrolled to the very left of the lanes. Read as
    // `contentX` — the old arithmetic — this would have been 220, and the
    // zoom would have jumped the view by a bar.
    expect(zoomAnchor(ORIGIN, rulerLeft(220), 220, 22)).toEqual({ beat: 10, x: 0 });
  });

  it('puts the beat back under the pointer at the new zoom', () => {
    const clientX = ORIGIN + 100;
    for (const scroll of [220, 517, 1000]) {
      for (const next of [11, 33, 44]) {
        const hold = zoomAnchor(clientX, rulerLeft(scroll), scroll, 22);
        // What the effect does after the zoom lands.
        const scrolled = hold.beat * next - hold.x;
        expect(scrolled).toBeGreaterThanOrEqual(0);
        // Where that beat ends up on screen: back under the pointer.
        expect(ORIGIN - scrolled + hold.beat * next).toBeCloseTo(clientX, 6);
      }
    }
  });

  it('gives up gracefully at the left end, where there is no scroll to give', () => {
    // Zoomed out with the grid already against its left edge, holding the
    // pointer's beat would need a NEGATIVE scroll. The clamp wins and the
    // view simply stays at the start — the one case a zoom cannot be
    // perfectly still, and it is the browser's floor, not an error.
    const hold = zoomAnchor(ORIGIN + 100, rulerLeft(0), 0, 22);
    expect(hold.beat * 11 - hold.x).toBeLessThan(0);
  });
});

describe('loop edges', () => {
  const loop = { start: 8, end: 16 };

  it('takes the near edge, and nothing in the middle', () => {
    expect(loopEdgeAt(loop, 8, 1)).toBe('start');
    // `end` is exclusive, so the last beat INSIDE the loop is 15 — that
    // is the one the end handle answers to.
    expect(loopEdgeAt(loop, 15, 1)).toBe('end');
    expect(loopEdgeAt(loop, 12, 1)).toBeNull();
    expect(loopEdgeAt(null, 8, 1)).toBeNull();
  });

  it('reaches a beat either side of the edge', () => {
    expect(loopEdgeAt(loop, 7, 1)).toBe('start');
    expect(loopEdgeAt(loop, 9, 1)).toBe('start');
    expect(loopEdgeAt(loop, 16, 1)).toBe('end');
  });

  it('on a one-beat loop the edges do not fight', () => {
    // start and end-1 are the SAME column; whichever it answers, taking
    // hold of it must not crash or invert the loop.
    expect(loopEdgeAt({ start: 4, end: 5 }, 4, 1)).toBe('start');
  });

  it('widens the grab as the beats narrow', () => {
    expect(grabBeats(1)).toBe(1);
    expect(grabBeats(4)).toBe(1);
    // Zoomed right out a beat is a few pixels, so the grab has to cover
    // more of them to stay catchable.
    expect(grabBeats(0.25)).toBe(2);
  });
});

// THE LOOP IS DRAWN ON THE RULER, and the gesture that draws it belongs
// to the WINDOW: a drag is a horizontal thing and the ruler is 26 px
// tall, so the pointer leaves it almost immediately.
describe('the ruler gesture', () => {
  it('keeps marking the loop when the pointer leaves the ruler vertically', async () => {
    show();
    const ruler = await screen.findByTestId('grid-ruler');
    fireEvent.mouseDown(ruler, { clientX: 0 });
    // Out of the strip and down over the rows, which used to end the
    // drag on the spot.
    fireEvent.mouseMove(document.body, { clientX: 5 * 22, clientY: 300 });
    await waitFor(() =>
      expect(screen.getByTestId('grid-ruler-5').getAttribute('data-loop')).toBe('true'),
    );
    fireEvent.mouseUp(document.body, { clientX: 5 * 22, clientY: 300 });
    expect(screen.getByTestId('grid-ruler-3').getAttribute('data-loop')).toBe('true');
  });

  it('a CLICK puts the playback there instead of marking a one-beat loop', async () => {
    show();
    const ruler = await screen.findByTestId('grid-ruler');
    fireEvent.mouseDown(ruler, { clientX: 5 * 22 });
    fireEvent.mouseUp(ruler, { clientX: 5 * 22 });
    await waitFor(() =>
      expect(screen.getByTestId('grid-position').textContent).toContain('beat 6/'),
    );
    // …and nothing has been looped.
    expect(screen.queryByTestId('grid-loop-handle-start')).toBeNull();
  });

  it('marks the loop with EDGES on the grid rather than a wash over it', async () => {
    show();
    await addClip('h1', 'c1');
    const ruler = screen.getByTestId('grid-ruler');
    fireEvent.mouseDown(ruler, { clientX: 0 });
    fireEvent.mouseMove(document.body, { clientX: 3 * 22 });
    fireEvent.mouseUp(document.body, { clientX: 3 * 22 });
    await waitFor(() =>
      expect(screen.getByTestId('grid-cell-row1-0').getAttribute('data-loop-edge')).toBe('start'),
    );
    expect(screen.getByTestId('grid-cell-row1-3').getAttribute('data-loop-edge')).toBe('end');
    // The columns between the edges are left alone.
    expect(screen.getByTestId('grid-cell-row1-2').getAttribute('data-loop-edge')).toBe('none');
    // The ruler keeps its highlight the whole way across.
    expect(screen.getByTestId('grid-ruler-2').getAttribute('data-loop')).toBe('true');
  });
});

// N COLUMNS MARKED BY THE LOOP is what the ruler's menu operates on.
describe('beat surgery from the ruler', () => {
  /** Mark a loop `n` columns wide from column 0. */
  async function loopOf(n: number) {
    const ruler = screen.getByTestId('grid-ruler');
    fireEvent.mouseDown(ruler, { clientX: 0 });
    fireEvent.mouseMove(document.body, { clientX: (n - 1) * 22 });
    fireEvent.mouseUp(document.body, { clientX: (n - 1) * 22 });
    await waitFor(() => expect(screen.getByTestId('grid-loop-handle-start')).toBeTruthy());
  }

  it('offers the five operations, counted in the beats the loop marks', async () => {
    show();
    await addClip('h1', 'c1');
    await loopOf(2);
    fireEvent.contextMenu(screen.getByTestId('grid-ruler'), { clientX: 10, clientY: 10 });
    const menu = await screen.findByTestId('context-menu');
    expect(menu.textContent).toContain('Insert 2 beats left');
    expect(menu.textContent).toContain('Insert 2 beats right');
    expect(menu.textContent).toContain('Copy 2 beats left');
    expect(menu.textContent).toContain('Copy 2 beats right');
    expect(menu.textContent).toContain('Delete 2 beats');
  });

  it('says nothing when no loop is marked', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.contextMenu(screen.getByTestId('grid-ruler'), { clientX: 10, clientY: 10 });
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('inserts beats to the right, pushing what follows along', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-8'));
    await screen.findByTestId('grid-clip-row1-8');
    await loopOf(2);
    fireEvent.contextMenu(screen.getByTestId('grid-ruler'), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByTestId('grid-beats-insert-right'));
    await waitFor(() => expect(screen.getByTestId('grid-clip-row1-10')).toBeTruthy());
  });

  it('copies the loop to the right, so the phrase is there twice', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-0'));
    await screen.findByTestId('grid-clip-row1-0');
    await loopOf(4);
    fireEvent.contextMenu(screen.getByTestId('grid-ruler'), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByTestId('grid-beats-copy-right'));
    await waitFor(() => expect(screen.getByTestId('grid-clip-row1-4')).toBeTruthy());
    expect(screen.getByTestId('grid-clip-row1-0')).toBeTruthy();
  });

  it('deletes the marked beats, closing the gap behind them', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-8'));
    await screen.findByTestId('grid-clip-row1-8');
    await loopOf(4);
    fireEvent.contextMenu(screen.getByTestId('grid-ruler'), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByTestId('grid-beats-delete'));
    await waitFor(() => expect(screen.getByTestId('grid-clip-row1-4')).toBeTruthy());
  });
});

describe('GridView undo', () => {
  it('takes back a placement, and puts it back on redo', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-4'));
    await screen.findByTestId('grid-clip-row1-4');

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid^="grid-clip-row1-"]')).toHaveLength(0),
    );
    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByTestId('grid-clip-row1-4')).toBeTruthy());
  });

  it('undoes a loop DRAG as one step, not one per beat crossed', async () => {
    show();
    const ruler = await screen.findByTestId('grid-ruler');
    fireEvent.mouseDown(ruler, { clientX: 0 });
    fireEvent.mouseMove(document.body, { clientX: 22 });
    fireEvent.mouseMove(document.body, { clientX: 2 * 22 });
    fireEvent.mouseMove(document.body, { clientX: 5 * 22 });
    fireEvent.mouseUp(document.body, { clientX: 5 * 22 });
    await waitFor(() => expect(screen.getByTestId('grid-loop-handle-start')).toBeTruthy());

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(screen.queryByTestId('grid-loop-handle-start')).toBeNull());
  });

  it('offers Undo and Redo in the file menu, greyed until there is one', async () => {
    show();
    await screen.findByTestId('grid-view');
    fireEvent.click(screen.getByTestId('grid-name'));
    expect(screen.getByTestId('grid-undo').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByTestId('grid-name'));

    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-4'));
    await screen.findByTestId('grid-clip-row1-4');
    fireEvent.click(screen.getByTestId('grid-name'));
    fireEvent.click(screen.getByTestId('grid-undo'));
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid^="grid-clip-row1-"]')).toHaveLength(0),
    );
    fireEvent.click(screen.getByTestId('grid-name'));
    fireEvent.click(screen.getByTestId('grid-redo'));
    await waitFor(() => expect(screen.getByTestId('grid-clip-row1-4')).toBeTruthy());
  });

  it('does not walk back into the document a New replaced', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-4'));
    await screen.findByTestId('grid-clip-row1-4');
    fireEvent.click(screen.getByTestId('grid-name'));
    fireEvent.click(screen.getByTestId('grid-new'));
    fireEvent.click(await screen.findByTestId('grid-confirm-discard'));
    await waitFor(() => expect(screen.getByTestId('grid-empty')).toBeTruthy());

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(screen.getByTestId('grid-empty')).toBeTruthy();
  });
});

// A SELECTION IS ANY RECTANGLE: the rows a drag crosses, not the one it
// started on. The rows are separate elements, so leaving one used to end
// the drag before it ever reached the next.
describe('GridView selection across rows', () => {
  it('grows onto the rows below as the drag passes over them', async () => {
    show();
    await addTrack('h1');
    fireEvent.mouseDown(screen.getByTestId('grid-cell-row1-2'));
    // Leaving row 1 is what a drag DOWN the grid does first.
    fireEvent.mouseLeave(screen.getByTestId('grid-cells-row1'));
    fireEvent.mouseOver(screen.getByTestId('grid-cell-row2-6'));
    await waitFor(() =>
      expect(screen.getByTestId('grid-cell-row2-4').getAttribute('data-selected')).toBe('true'),
    );
    expect(screen.getByTestId('grid-cell-row1-4').getAttribute('data-selected')).toBe('true');
    // …and the columns outside the drag are not in it.
    expect(screen.getByTestId('grid-cell-row2-8').getAttribute('data-selected')).toBe('false');
  });

  it('ends when the mouse is let go anywhere, not only over a row', async () => {
    show();
    await addTrack('h1');
    fireEvent.mouseDown(screen.getByTestId('grid-cell-row1-2'));
    fireEvent.mouseOver(screen.getByTestId('grid-cell-row2-6'));
    await waitFor(() =>
      expect(screen.getByTestId('grid-cell-row2-4').getAttribute('data-selected')).toBe('true'),
    );
    fireEvent.mouseUp(document.body);
    // The drag is over: passing back over the grid must not resize it.
    fireEvent.mouseOver(screen.getByTestId('grid-cell-row2-12'));
    expect(screen.getByTestId('grid-cell-row2-12').getAttribute('data-selected')).toBe('false');
  });
});

// CSS-LEVEL PINS. jsdom loads no stylesheet, so the parts of this ticket
// that are only a paint — the automation line's weight, the loop's edges,
// what covers what as the grid scrolls — cannot be asserted through the
// DOM. They are read out of the stylesheet instead, the way the app
// shell's layout is (`AppShellLayout.test.tsx`).
describe('Grid paint (CSS-level pin)', () => {
  const css = readFileSync('src/styles.css', 'utf-8');
  /** The bodies of every rule whose selector list matches `pattern`. */
  const rules = (pattern: RegExp): string[] =>
    [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((m) => m[1].split(',').some((s) => pattern.test(s.trim().split('\n').pop()!.trim())))
      .map((m) => m[2]);
  const rule = (selector: string): string => {
    const bodies = rules(new RegExp(`^${selector.replace(/[.[\]()*+?^$|\\]/g, '\\$&')}$`));
    expect(bodies.length, `rule for ${selector}`).toBeGreaterThan(0);
    return bodies.join(';');
  };

  it('draws a WRITTEN level line exactly like a resting one', () => {
    // The whole of the request: a row with automation in it must read the
    // same as a row without. Nothing may re-colour or thicken the line
    // once it has points on it.
    for (const body of rules(/\.grid-level\[data-written='true'\]/)) {
      expect(body).not.toMatch(/stroke/);
    }
    const line = rule('.grid-level-svg polyline');
    expect(line).toMatch(/stroke:\s*color-mix\(in srgb, var\(--ink\)/);
    expect(line).toMatch(/stroke-width:\s*1;/);
    // …and the handles are gray too, not the accent they used to be.
    expect(rule('.grid-level-point')).toMatch(/background:\s*color-mix\(in srgb, var\(--ink\)/);
  });

  it('marks the loop on the grid with edges, and only on the ruler with a wash', () => {
    // No rule may tint a looped CELL: that is what buried the clips.
    expect(rules(/\.grid-cell\[data-loop='true'\]/)).toHaveLength(0);
    for (const body of rules(/\.grid-cell\[data-loop-edge/)) {
      expect(body).toMatch(/var\(--loop\)/);
      expect(body).not.toMatch(/background/);
    }
    // The ruler keeps its highlight, in the same purple.
    expect(rule(".grid-ruler-cell[data-loop='true']")).toMatch(/var\(--loop\)/);
  });

  it('keeps the ruler flush with the chrome and the gutter over the grid', () => {
    // A sticky child sticks to the top of the scrollport's padding box, so
    // ANY top padding here is a strip the rows show through.
    expect(rule('.grid-body')).toMatch(/padding:\s*0 /);
    const zOf = (selector: string) => Number(/z-index:\s*(\d+)/.exec(rule(selector))?.[1]);
    // Both come BEFORE the cells and the level lines in the DOM, so they
    // need the higher z-index to cover them rather than be painted over.
    expect(zOf('.grid-gutter')).toBeGreaterThan(zOf('.grid-level'));
    expect(zOf('.grid-ruler')).toBeGreaterThan(zOf('.grid-level'));
    expect(zOf('.grid-ruler')).toBeGreaterThan(zOf('.grid-cell'));
    // An opaque title blocks the grid scrolling under it.
    expect(rule('.grid-row-title')).toMatch(/background:\s*var\(--canvas\)/);
  });
});

// A CLICK ON THE RULER AIMS THE PAGE: it says where playback starts and
// where a paste lands. The gesture reached `seekTo` already and the
// readout in the header moved, but on screen nothing did — which is the
// only part the user can see.
describe('the ruler click, end to end', () => {
  /** Press and release on one column of the ruler: a click, not a drag. */
  function clickRuler(col: number) {
    const ruler = screen.getByTestId('grid-ruler');
    fireEvent.mouseDown(ruler, { clientX: col * 22 });
    fireEvent.mouseUp(ruler, { clientX: col * 22 });
  }

  /** Mark a loop over columns `from`..`to` inclusive. */
  async function markLoop(from: number, to: number) {
    const ruler = screen.getByTestId('grid-ruler');
    fireEvent.mouseDown(ruler, { clientX: from * 22 });
    fireEvent.mouseMove(document.body, { clientX: to * 22 });
    fireEvent.mouseUp(document.body, { clientX: to * 22 });
    await waitFor(() => expect(screen.getByTestId('grid-loop-handle-start')).toBeTruthy());
  }

  it('SHOWS the playhead where it was put, with the grid stopped', async () => {
    show();
    await addClip('h1', 'c1');
    clickRuler(5);
    // The playhead was drawn only while the grid was PLAYING, so aiming a
    // stopped grid moved a marker nobody could see.
    const head = await screen.findByTestId('grid-playhead');
    expect(head.style.left).toBe(`${5 * 22}px`);
    expect(head.getAttribute('data-playing')).toBe('false');
    // …and the beat it sits on is lit, so a paste target is a column and
    // not a hairline.
    expect(screen.getByTestId('grid-now').style.left).toBe(`${5 * 22}px`);
  });

  it('puts the playhead OUTSIDE a marked loop when that is where the click was', async () => {
    show();
    await addClip('h1', 'c1');
    await markLoop(0, 3);
    clickRuler(20);
    // The seek was clamped to the range being PLAYED, which is the loop:
    // once a loop was marked the playhead could not leave it, so every
    // click past it landed on its last beat.
    await waitFor(() =>
      expect(screen.getByTestId('grid-position').textContent).toContain('beat 21/'),
    );
    expect(screen.getByTestId('grid-playhead').style.left).toBe(`${20 * 22}px`);
    // The loop is untouched: a click aims the playhead, it does not edit.
    expect(screen.getByTestId('grid-ruler-2').getAttribute('data-loop')).toBe('true');
    expect(screen.getByTestId('grid-ruler-20').getAttribute('data-loop')).toBe('false');
  });

  it('seeks on a click that lands on a loop EDGE, without redrawing the loop', async () => {
    show();
    await addClip('h1', 'c1');
    await markLoop(4, 11);
    clickRuler(4);
    // Pressing an edge takes hold of it, but taking hold of something and
    // letting go without moving is still a click.
    await waitFor(() =>
      expect(screen.getByTestId('grid-position').textContent).toContain('beat 5/'),
    );
    expect(screen.getByTestId('grid-ruler-4').getAttribute('data-loop')).toBe('true');
    expect(screen.getByTestId('grid-ruler-11').getAttribute('data-loop')).toBe('true');
    expect(screen.getByTestId('grid-ruler-12').getAttribute('data-loop')).toBe('false');
  });

  it('still trims the loop when the press on an edge is DRAGGED', async () => {
    show();
    await addClip('h1', 'c1');
    await markLoop(4, 11);
    const ruler = screen.getByTestId('grid-ruler');
    fireEvent.mouseDown(ruler, { clientX: 4 * 22 });
    fireEvent.mouseMove(document.body, { clientX: 8 * 22 });
    fireEvent.mouseUp(document.body, { clientX: 8 * 22 });
    await waitFor(() =>
      expect(screen.getByTestId('grid-ruler-4').getAttribute('data-loop')).toBe('false'),
    );
    expect(screen.getByTestId('grid-ruler-8').getAttribute('data-loop')).toBe('true');
    expect(screen.getByTestId('grid-ruler-11').getAttribute('data-loop')).toBe('true');
  });

  it('parks the TRANSPORT there too, so play starts from the click', async () => {
    const transport = new GridTransport(makeClips());
    const seek = vi.spyOn(transport, 'seek');
    const play = vi.spyOn(transport, 'play');
    render(<GridView clips={makeClips()} pollMs={NO_POLL} transport={transport} active />);
    await screen.findByTestId('grid-ruler');

    clickRuler(12);
    await waitFor(() => expect(seek).toHaveBeenCalledWith(12));
    // The page's marker and the transport's own place agree: a seek while
    // STOPPED parks the playhead rather than only moving a highlight.
    expect(transport.status().column).toBe(12);

    fireEvent.keyDown(window, { key: ' ' });
    expect(play).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(Number), 12);
  });

  it('pastes where the ruler was clicked, loop or no loop', async () => {
    show();
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-0'));
    await screen.findByTestId('grid-clip-row1-0');
    fireEvent.mouseDown(screen.getByTestId('grid-cell-row1-0'));
    fireEvent.mouseOver(screen.getByTestId('grid-cell-row1-3'));
    fireEvent.mouseUp(screen.getByTestId('grid-cell-row1-3'));
    fireEvent.keyDown(window, { key: 'c', metaKey: true });

    await markLoop(0, 3);
    clickRuler(20);
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    // The paste anchor is the playhead, so a playhead trapped inside the
    // loop dropped the copy back on top of the original.
    await waitFor(() => expect(screen.getByTestId('grid-clip-row1-20')).toBeTruthy());
  });
});
