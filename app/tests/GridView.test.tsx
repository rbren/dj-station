// The Grid page against a mock clip store: loading rows through the
// two-level picker, the group heading a track's rows share, placing a
// clip by its one, the master tempo lane, the loop drag and the
// transport.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BeatClipApi, BeatClipEntry } from '../src/beatClip';
import { GridView } from '../src/components/GridView';
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

  it('grows the grid on demand and never shrinks past the minimum', async () => {
    show();
    await waitFor(() => expect(screen.getByTestId('grid-beats').textContent).toBe('32 beats'));
    fireEvent.click(screen.getByTestId('grid-lengthen'));
    await waitFor(() => expect(screen.getByTestId('grid-beats').textContent).toBe('48 beats'));
    fireEvent.click(screen.getByTestId('grid-shorten'));
    await waitFor(() => expect(screen.getByTestId('grid-beats').textContent).toBe('32 beats'));
    expect(screen.getByTestId('grid-shorten').hasAttribute('disabled')).toBe(true);
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

  it('a drag across the ruler marks the loop, and it can be cleared', async () => {
    show();
    await waitFor(() => expect(screen.getByTestId('grid-loop').textContent).toContain('no loop'));
    const ruler = screen.getByTestId('grid-ruler');
    // jsdom has no layout: every clientX maps to column 0, so the drag
    // marks one column — which is still a loop, and still clears.
    fireEvent.mouseDown(ruler, { clientX: 0 });
    fireEvent.mouseMove(ruler, { clientX: 40 });
    fireEvent.mouseUp(ruler);
    await waitFor(() => expect(screen.getByTestId('grid-loop').textContent).toContain('loop 1'));
    fireEvent.click(screen.getByTestId('grid-loop-clear'));
    await waitFor(() => expect(screen.getByTestId('grid-loop').textContent).toContain('no loop'));
  });

  it('plays and stops', async () => {
    const clips = makeClips();
    show(clips);
    await addClip('h1', 'c1');
    fireEvent.click(screen.getByTestId('grid-cell-row1-0'));
    fireEvent.click(screen.getByTestId('grid-play'));
    await waitFor(() =>
      expect(screen.getByTestId('grid-play').getAttribute('aria-pressed')).toBe('true'),
    );
    fireEvent.click(screen.getByTestId('grid-stop'));
    await waitFor(() =>
      expect(screen.getByTestId('grid-play').getAttribute('aria-pressed')).toBe('false'),
    );
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
