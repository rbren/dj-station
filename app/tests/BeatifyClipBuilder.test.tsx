// The clip builder: sources on the left, the open one across the top,
// the clip being built underneath.
//
// The model's arithmetic is pinned in BeatifyClip.test.ts; this file is
// about the parts only a mounted page has — dragging beats out of the
// source into a cell, the grid growing, and the rule that the source and
// the clip never sound at once.

import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BeatifyProject, BeatifySeed } from '../src/beatify';
import type { BeatifyClipClientApi, SavedClip } from '../src/beatifyClip';
import { BeatifyClipBuilder } from '../src/components/BeatifyClipBuilder';

const GRID = { bpm: 120, period: 0.5, phase: 0.5, beats: 64 };
/** The warped render: 64 beats of half a second, plus the head padding. */
const DURATION = 32.5;

function beatified(id = 's1', title = 'Live Set A'): BeatifySeed {
  return {
    id,
    sourceBpm: 120,
    speed: 1,
    sourceMissing: false,
    projectId: 'p1',
    projectName: 'Live Set A',
    trackId: 3,
    title,
    artist: 'Band',
    durationSecs: DURATION,
    sampleRate: 44100,
    channels: 2,
    peaks: Array.from({ length: 40 }, (_, i) => (i % 8) / 8),
    record: {
      source: '/music/live-a.wav',
      sourceHash: 'deadbeefdeadbeef',
      sourceSpan: [0, 60],
      warped: 'live-a.beatified.wav',
      grid: GRID,
      leadIn: 0.014,
      ruler: { group: 4 },
      warp: { strength: 0.3, anchorStride: 8, map: [] },
      quality: { worstFlamMs: 2.1, peakStretchPct: 0.84, rmsMs: 0.7, inBandPct: 99 },
      analysis: {
        tracker: 'dsp',
        agreement: {
          verdict: 'singleTracker',
          tempoSpreadBpm: 0,
          phaseAgreementPct: 100,
          metricalSplit: false,
          readings: [],
          disagreementSpans: [],
        },
        confidence: Array.from({ length: 64 }, () => 0.8),
      },
      reading: { factor: 1, halfShift: false },
    },
  };
}

function project(seeds: BeatifySeed[] = [beatified()]): BeatifyProject {
  return { id: 'p1', name: 'Live Set A', bpm: seeds.length ? GRID.bpm : null, seeds };
}

/** One seed's entry in the source list, stems and all. */
function seedInfo(seedId: string, label: string, stemsReady = true) {
  return {
    source: { kind: 'seed' as const, id: seedId, stems: [] },
    seedId,
    label,
    beats: 64,
    sourceBpm: 120,
    speed: 1,
    available: true,
    hint: null,
    stems: ['drums', 'bass', 'other', 'vocals'].map((name) => ({
      name,
      available: stemsReady,
      hint: stemsReady ? null : 'no demucs stems yet — separate this track on the Clip page first',
    })),
  };
}

function clipsMock(overrides: Partial<BeatifyClipClientApi> = {}): BeatifyClipClientApi {
  const saved: SavedClip[] = [];
  return {
    sources: vi.fn(async () => ({
      sources: [seedInfo('s1', 'Live Set A')],
      clips: saved,
      grid: GRID,
    })),
    open: vi.fn(async (_trackId, source) => ({
      source,
      label:
        source.kind === 'seed'
          ? source.stems.length
            ? `Live Set A · ${source.stems.join(' + ')}`
            : 'Live Set A'
          : 'clip',
      durationSecs: DURATION,
      sampleRate: 44100,
      channels: 2,
      beats: 64,
      peaks: Array.from({ length: 40 }, (_, i) => (i % 8) / 8),
    })),
    audio: vi.fn(async () => new ArrayBuffer(8)),
    preview: vi.fn(async () => new ArrayBuffer(8)),
    save: vi.fn(async (_trackId, clip) => {
      const id = clip.id || String(saved.length + 1);
      const at = saved.findIndex((c) => c.id === id);
      if (at < 0) saved.push({ ...clip, id });
      else saved[at] = { ...clip, id };
      return { id, clips: [...saved] };
    }),
    remove: vi.fn(async (_trackId, id) => {
      const at = saved.findIndex((c) => c.id === id);
      if (at >= 0) saved.splice(at, 1);
      return [...saved];
    }),
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:beatify-clip');
  globalThis.URL.revokeObjectURL = vi.fn();
  window.HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  window.HTMLMediaElement.prototype.pause = vi.fn();
});

function builder(open: BeatifyProject, clips: BeatifyClipClientApi) {
  return (
    <BeatifyClipBuilder
      project={open}
      clips={clips}
      onRebeatify={() => {}}
      onImport={() => {}}
      onRemoveSeed={() => {}}
    />
  );
}

async function mount(clips: BeatifyClipClientApi = clipsMock(), open: BeatifyProject = project()) {
  const { rerender } = render(builder(open, clips));
  await screen.findByTestId('beatify-clip-list');
  await screen.findByTestId('beatify-track-waveform');
  return Object.assign(clips, {
    /** The page re-rendered with a changed project — a tempo change, a
     *  seed imported — WITHOUT being torn down, which is what the view
     *  above does to it. */
    reopen: (next: BeatifyProject) => rerender(builder(next, clips)),
  });
}

/** Sweep a selection over the source waveform. The pane is 325 px wide
 *  for 32.5 s, so a beat (0.5 s) is 5 px and beat n starts at
 *  `(0.5 + 0.5n) × 10` px. */
const x = (beat: number) => (0.5 + 0.5 * beat) * 10;

function selectBeats(fromBeat: number, beats: number) {
  const wave = screen.getByTestId('beatify-track-waveform');
  wave.getBoundingClientRect = () => ({ left: 0, width: 325, top: 0, height: 100 }) as DOMRect;
  fireEvent.mouseDown(wave, { clientX: x(fromBeat) });
  fireEvent.mouseMove(wave, { clientX: x(fromBeat + beats) });
  fireEvent.mouseUp(wave, { clientX: x(fromBeat + beats) });
}

/** Drag one END of the selection with ⌘ held: off the grid, where the
 *  ends are the user's to the millisecond. */
function cmdDragEdge(fromX: number, toX: number) {
  const wave = screen.getByTestId('beatify-track-waveform');
  wave.getBoundingClientRect = () => ({ left: 0, width: 325, top: 0, height: 100 }) as DOMRect;
  fireEvent.mouseDown(wave, { clientX: fromX, metaKey: true });
  fireEvent.mouseMove(wave, { clientX: toX, metaKey: true });
  fireEvent.mouseUp(wave, { clientX: toX, metaKey: true });
}

/** Drag whatever is selected into a cell of the clip editor. */
function dragInto(row: number, col: number) {
  fireEvent.mouseDown(screen.getByTestId('beatify-drag-beats'), { button: 0 });
  const cell = screen.getByTestId(`beatify-clip-cell-${row}-${col}`);
  fireEvent.mouseEnter(cell);
  fireEvent.mouseUp(cell);
}

const blocks = () =>
  Array.from(document.querySelectorAll('[data-testid^="beatify-clip-block-"]')) as HTMLElement[];

/** Sweep a rectangle of the clip editor's grid. */
function sweepCells(row0: number, col0: number, row1: number, col1: number) {
  fireEvent.mouseDown(screen.getByTestId(`beatify-clip-cell-${row0}-${col0}`), { button: 0 });
  fireEvent.mouseEnter(screen.getByTestId(`beatify-clip-cell-${row1}-${col1}`));
  fireEvent.mouseUp(window);
}

/** Build the four-beat clip most of these cases start from. */
async function fourBeatsAt(col: number) {
  selectBeats(0, 4);
  await waitFor(() =>
    expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('4 beats'),
  );
  dragInto(0, col);
}

/** Save the current draft under a name, and wait for it to be filed. */
async function saveAs(name: string) {
  fireEvent.change(screen.getByTestId('beatify-clip-name'), { target: { value: name } });
  fireEvent.click(screen.getByTestId('beatify-clip-save'));
  await screen.findByTestId('beatify-clip-source-clip:1');
}

describe('the source list', () => {
  it('lists the seeds of the project, each with its own stem switches', async () => {
    const clips = clipsMock({
      sources: vi.fn(async () => ({
        sources: [seedInfo('s1', 'Live Set A'), seedInfo('s2', 'Boys')],
        clips: [],
        grid: GRID,
      })),
    });
    await mount(clips, project([beatified('s1'), beatified('s2', 'Boys')]));
    expect(screen.getByTestId('beatify-clip-source-s1').textContent).toContain('Live Set A');
    expect(screen.getByTestId('beatify-clip-source-s2').textContent).toContain('Boys');
    // Stems hang off the seed they came out of, not off the list: the
    // same stem name appears once per seed and means a different thing.
    expect(screen.getByTestId('beatify-stem-s1-drums')).toBeTruthy();
    expect(screen.getByTestId('beatify-stem-s2-drums')).toBeTruthy();
  });

  it("shows a seed's stems as unavailable, with the fix, until they are separated", async () => {
    const clips = clipsMock({
      sources: vi.fn(async () => ({
        sources: [seedInfo('s1', 'Live Set A', false)],
        clips: [],
        grid: GRID,
      })),
    });
    await mount(clips);
    const vocals = screen.getByTestId('beatify-stem-s1-vocals') as HTMLButtonElement;
    expect(vocals.disabled).toBe(true);
    expect(screen.getByTestId('beatify-clip-list').textContent).toContain('separate this track');
  });

  it('opens the seed you click into the pane above', async () => {
    const clips = clipsMock({
      sources: vi.fn(async () => ({
        sources: [seedInfo('s1', 'Live Set A'), seedInfo('s2', 'Boys')],
        clips: [],
        grid: GRID,
      })),
    });
    await mount(clips, project([beatified('s1'), beatified('s2', 'Boys')]));
    fireEvent.click(screen.getByTestId('beatify-clip-source-s2'));
    await waitFor(() =>
      expect(clips.open).toHaveBeenCalledWith(
        'p1',
        { kind: 'seed', id: 's2', stems: [] },
        expect.any(Number),
      ),
    );
  });

  // Switching a part off is not a different source: it is the same seed,
  // with less of it playing — which is what gets dragged into a clip.
  it('opens the seed with only the parts left switched on', async () => {
    const clips = await mount();
    fireEvent.click(screen.getByTestId('beatify-stem-s1-vocals'));
    await waitFor(() =>
      expect(clips.open).toHaveBeenCalledWith(
        'p1',
        { kind: 'seed', id: 's1', stems: ['drums', 'bass', 'other'] },
        expect.any(Number),
      ),
    );
    // Turning it back on is the whole render again, not three stems summed.
    fireEvent.click(screen.getByTestId('beatify-stem-s1-vocals'));
    await waitFor(() =>
      expect(clips.open).toHaveBeenLastCalledWith(
        'p1',
        { kind: 'seed', id: 's1', stems: [] },
        expect.any(Number),
      ),
    );
  });

  it('will not let you switch off the last part of a seed', async () => {
    await mount();
    for (const name of ['drums', 'bass', 'other']) {
      fireEvent.click(screen.getByTestId(`beatify-stem-s1-${name}`));
    }
    fireEvent.click(screen.getByTestId('beatify-stem-s1-vocals'));
    await waitFor(() =>
      expect(screen.getByTestId('beatify-clip-note').textContent).toContain('at least one stem on'),
    );
    expect(screen.getByTestId('beatify-stem-s1-vocals').getAttribute('aria-pressed')).toBe('true');
  });

  it('says so, rather than drawing an empty pane, when nothing is imported yet', async () => {
    const clips = clipsMock({
      sources: vi.fn(async () => ({ sources: [], clips: [], grid: GRID })),
    });
    render(
      <BeatifyClipBuilder
        project={project([])}
        clips={clips}
        onRebeatify={() => {}}
        onImport={() => {}}
        onRemoveSeed={() => {}}
      />,
    );
    expect((await screen.findByTestId('beatify-builder-empty')).textContent).toContain(
      'sets the tempo',
    );
    expect(clips.open).not.toHaveBeenCalled();
  });
});

// ⌘ frees the ends of a selection from the beat grid (TV-14a): a cut can
// start inside a beat to catch a pickup, or stop short of one to leave a
// tail behind. What lands in the clip is still whole beats of the clip's
// grid — the fraction bought you the OFFSET into the source, not a
// fractional column.
describe('⌘-dragging the ends of the selection off the grid', () => {
  const readout = () => screen.getByTestId('beatify-track-readout').textContent;
  const handle = () => screen.getByTestId('beatify-drag-beats').textContent;

  it('measures what was really selected, in fractions of a beat', async () => {
    await mount();
    selectBeats(4, 8);
    await waitFor(() => expect(handle()).toContain('8 beats'));
    // A whole-beat count reads out its groups; a fraction has none,
    // which is how the readout says the selection is off the grid.
    expect(readout()).toContain('8 beats · 2 groups');
    // The END, half a beat further on.
    cmdDragEdge(x(12), x(12) + 2.5);
    expect(readout()).toContain('8.5 beats');
    expect(readout()).not.toContain('group');
    expect(handle()).toContain('8.5 beats');
  });

  it('lands on the clip grid, from where the cut really started', async () => {
    const clips = await mount();
    selectBeats(4, 6);
    await waitFor(() => expect(handle()).toContain('6 beats'));
    // The START, a quarter of a beat earlier: beats 3.75–10.
    cmdDragEdge(x(4), x(4) - 1.25);
    expect(readout()).toContain('6.25 beats');

    dragInto(0, 0);
    const block = blocks()[0];
    // Whole columns, at a column — the clip's grid is beats, and stays
    // beats. The quarter beat lives in where it reads FROM.
    expect(block.dataset.beats).toBe('6');
    expect(block.dataset.col).toBe('0');
    expect(block.title).toContain('4.75');

    await saveAs('Pickup');
    const draft = (clips.save as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(draft.placements[0]).toMatchObject({ col: 0, beats: 6, sourceBeat: 3.75 });
  });

  it('still snaps when ⌘ is not held', async () => {
    await mount();
    selectBeats(4, 6);
    await waitFor(() => expect(handle()).toContain('6 beats'));
    const wave = screen.getByTestId('beatify-track-waveform');
    wave.getBoundingClientRect = () => ({ left: 0, width: 325, top: 0, height: 100 }) as DOMRect;
    fireEvent.mouseDown(wave, { clientX: x(10) });
    fireEvent.mouseMove(wave, { clientX: x(10) + 2.5 });
    fireEvent.mouseUp(wave, { clientX: x(10) + 2.5 });
    expect(handle()).toContain('7 beats');
  });
});

// Switching a part off is a MIX change, not a new source: the pane must
// carry on where it was — same zoom, same selection, same playhead, and
// still sounding — with the new mix swapped in underneath.
describe('switching a stem off leaves the source where it was', () => {
  const readout = () => screen.getByTestId('beatify-track-readout').textContent;
  const mixOf = (clips: BeatifyClipClientApi) =>
    (clips.audio as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];

  /** The pane's title is the mix it is showing, so this waits for the new
   *  audio to have LANDED rather than merely been asked for. */
  const showing = (label: string) =>
    waitFor(() => expect(screen.getByTestId('beatify-track-title').textContent).toBe(label));

  const wave = () => {
    const el = screen.getByTestId('beatify-track-waveform');
    el.getBoundingClientRect = () => ({ left: 0, width: 325, top: 0, height: 100 }) as DOMRect;
    return el;
  };
  const zoomTo = (times: number) => {
    for (let i = 0; i < times; i++) fireEvent.click(screen.getByTestId('beatify-track-zoom-in'));
  };
  /** Scroll the zoomed view sideways, the way the trackpad does. */
  const pan = (deltaX: number) => fireEvent.wheel(wave(), { deltaX, deltaY: 0, shiftKey: true });
  /** A press that goes nowhere is a seek, snapped to the nearest beat. */
  const seekAt = (clientX: number) => {
    fireEvent.mouseDown(wave(), { clientX });
    fireEvent.mouseUp(wave(), { clientX });
  };

  /** A submix is its own audio — its own peaks and its own label — on the
   *  seed's grid and so exactly as long as the whole render. */
  const openMix: BeatifyClipClientApi['open'] = async (_projectId, source) => {
    const stems = source.kind === 'seed' ? source.stems : [];
    return {
      source,
      label: stems.length ? `Live Set A · ${stems.join(' + ')}` : 'Live Set A',
      durationSecs: DURATION,
      sampleRate: 44100,
      channels: 2,
      beats: 64,
      peaks: Array.from({ length: 40 }, (_, i) => ((i + stems.length) % 8) / 8),
    };
  };

  it('keeps the zoom, the scroll and the selection', async () => {
    const clips = await mount();
    selectBeats(4, 6);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('6 beats'),
    );
    fireEvent.click(screen.getByTestId('beatify-track-zoom-in'));
    fireEvent.click(screen.getByTestId('beatify-track-zoom-in'));
    const zoomed = readout();

    fireEvent.click(screen.getByTestId('beatify-stem-s1-vocals'));
    await waitFor(() =>
      expect(clips.open).toHaveBeenLastCalledWith(
        'p1',
        { kind: 'seed', id: 's1', stems: ['drums', 'bass', 'other'] },
        expect.any(Number),
      ),
    );

    expect(readout()).toBe(zoomed);
    expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('6 beats');
    // Still the same six beats, so they can still be dragged in.
    dragInto(0, 0);
    expect(blocks()).toHaveLength(1);
    expect(blocks()[0].dataset.beats).toBe('6');
  });

  it('keeps playing, and swaps the mix under the playhead', async () => {
    const clips = await mount();
    fireEvent.click(screen.getByTestId('beatify-track-play'));
    await waitFor(() => expect(screen.getByTestId('beatify-track-play').textContent).toBe('❚❚'));
    expect(mixOf(clips)).toEqual({ kind: 'seed', id: 's1', stems: [] });

    fireEvent.click(screen.getByTestId('beatify-stem-s1-vocals'));

    // The window in flight is re-rendered from the new mix rather than
    // the transport being torn down: it never stops sounding.
    await waitFor(() =>
      expect(mixOf(clips)).toEqual({ kind: 'seed', id: 's1', stems: ['drums', 'bass', 'other'] }),
    );
    expect(screen.getByTestId('beatify-track-play').textContent).toBe('❚❚');
  });

  // The whole of it, both ways round, against a backend that answers a
  // submix with its OWN audio (as the real one does): switching a part
  // off and back on is a change of tone, and a change of tone leaves the
  // zoom, the scroll, the selection, the loop and the playhead alone.
  it('keeps the view, the loop and the playhead, off and back on', async () => {
    await mount(clipsMock({ open: openMix }));
    selectBeats(20, 4);
    await waitFor(() => expect(readout()).toContain('selection'));
    zoomTo(2);
    pan(30);
    fireEvent.click(screen.getByTestId('beatify-track-loop'));
    seekAt(120);
    const before = readout();
    const head = screen.getByTestId('beatify-track-playhead-readout').textContent;
    expect(before).toContain('view');
    expect(before).toContain('selection');
    expect(head).not.toBe('0:00.000');

    fireEvent.click(screen.getByTestId('beatify-stem-s1-vocals'));
    await showing('Live Set A · drums + bass + other');
    expect(readout()).toBe(before);
    expect(screen.getByTestId('beatify-track-loop').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('beatify-track-playhead-readout').textContent).toBe(head);

    fireEvent.click(screen.getByTestId('beatify-stem-s1-vocals'));
    await showing('Live Set A');
    expect(readout()).toBe(before);
    expect(screen.getByTestId('beatify-track-loop').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('beatify-track-playhead-readout').textContent).toBe(head);
  });

  // The boundary: a DIFFERENT seed is different material, so that pane
  // does start fresh. Only the mix is a change the view can sit through.
  it('does start fresh when another seed is opened', async () => {
    const clips = clipsMock({
      sources: vi.fn(async () => ({
        sources: [seedInfo('s1', 'Live Set A'), seedInfo('s2', 'Boys')],
        clips: [],
        grid: GRID,
      })),
    });
    await mount(clips, project([beatified('s1'), beatified('s2', 'Boys')]));
    fireEvent.click(screen.getByTestId('beatify-track-zoom-in'));
    expect(readout()).toContain('view');

    fireEvent.click(screen.getByTestId('beatify-clip-source-s2'));
    await waitFor(() => expect(readout()).not.toContain('view'));
  });
});

// The tempo belongs to the PROJECT, so changing it re-renders every
// seed — but a clip is a run of BEATS, and a beat is a beat at any
// tempo. Whatever is half-built on the grid has to survive it.
describe('the project tempo changing under the builder', () => {
  const retempo = (bpm: number) => {
    const seed = beatified();
    const period = 60 / bpm;
    return project([{ ...seed, record: { ...seed.record, grid: { ...GRID, bpm, period } } }]);
  };

  it('leaves the clip in progress exactly where it was', async () => {
    const clips = await mount();
    await fourBeatsAt(2);
    fireEvent.change(screen.getByTestId('beatify-clip-name'), { target: { value: 'Intro loop' } });

    clips.reopen(retempo(128));

    // Same block, same beats, same column — and the name box is still
    // the one that was being typed into.
    await waitFor(() => expect(blocks()).toHaveLength(1));
    expect(blocks()[0].dataset.beats).toBe('4');
    expect(blocks()[0].dataset.col).toBe('2');
    expect((screen.getByTestId('beatify-clip-name') as HTMLInputElement).value).toBe('Intro loop');
  });

  it('plays the clip at the NEW tempo', async () => {
    const clips = await mount();
    await fourBeatsAt(0);
    clips.reopen(retempo(60));
    fireEvent.click(screen.getByTestId('beatify-clip-play'));

    // Sixteen beats at 60 BPM is sixteen seconds of audio to render,
    // where at 120 it was eight.
    await waitFor(() => {
      const call = (clips.preview as ReturnType<typeof vi.fn>).mock.calls.at(-1);
      expect(call?.[3]).toBeCloseTo(16, 5);
    });
  });

  it('fetches the re-rendered source, and shows it at the new tempo', async () => {
    const clips = await mount();
    const opens = (clips.open as ReturnType<typeof vi.fn>).mock.calls.length;
    clips.reopen(retempo(128));

    // Every seed was re-rendered under the tempo change, so what the
    // pane is holding is last week's audio: it asks again.
    await waitFor(() =>
      expect((clips.open as ReturnType<typeof vi.fn>).mock.calls.length).toBe(opens + 1),
    );
    expect(clips.sources).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('beatify-track-view').textContent).toContain('128.00 BPM');
  });
});

describe('dragging beats into the clip', () => {
  it('drops a selection in as ONE block of that many beats', async () => {
    await mount();
    selectBeats(4, 3);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('3 beats'),
    );
    dragInto(0, 2);

    const placed = blocks();
    expect(placed).toHaveLength(1);
    expect(placed[0].dataset.beats).toBe('3');
    expect(placed[0].dataset.col).toBe('2');
    // Three beats is three columns wide, not three separate cells —
    // and the grid fills the pane, so that width is a fraction of it.
    expect(placed[0].style.width).toBe(`${(3 / 16) * 100}%`);
    expect(placed[0].style.left).toBe(`${(2 / 16) * 100}%`);
  });

  it('keeps a six-beat run and a three-beat run visibly different', async () => {
    await mount();
    selectBeats(0, 3);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('3 beats'),
    );
    dragInto(0, 0);
    selectBeats(16, 6);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('6 beats'),
    );
    dragInto(0, 3);

    const placed = blocks().sort((a, b) => Number(a.dataset.col) - Number(b.dataset.col));
    expect(placed.map((b) => b.dataset.beats)).toEqual(['3', '6']);
    // They touch, so the second one is drawn with a seam — two clips, not
    // one nine-beat lump.
    expect(placed[1].className).toContain('seam');
    expect(placed[0].className).not.toContain('seam');
  });

  it('grows the grid to the right when the run runs off the end', async () => {
    await mount();
    expect(screen.queryByTestId('beatify-clip-cell-0-17')).toBeNull();
    selectBeats(0, 6);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('6 beats'),
    );
    dragInto(0, 14);
    expect(screen.getByTestId('beatify-clip-cell-0-19')).toBeTruthy();
  });

  it('adds the row when beats are dropped below the last one', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('beatify-clip-add-row'));
    selectBeats(0, 4);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('4 beats'),
    );
    dragInto(1, 0);
    expect(screen.getByTestId('beatify-clip-row-1').textContent).toContain('4');
    expect(screen.getByTestId('beatify-clip-count').textContent).toContain('2 tracks');
  });

  it('survives a click-to-seek: the beats stay selected and still drag', async () => {
    await mount();
    selectBeats(8, 4);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('4 beats'),
    );

    // Auditioning somewhere else must not cost the selection — clicking
    // the waveform moves the playhead and nothing more.
    const wave = screen.getByTestId('beatify-track-waveform');
    fireEvent.mouseDown(wave, { clientX: 200 });
    fireEvent.mouseUp(wave, { clientX: 200 });
    expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('4 beats');
    expect(screen.getByTestId('beatify-track-selection')).toBeTruthy();

    dragInto(0, 0);
    expect(blocks()[0].dataset.beats).toBe('4');
  });

  it('drags the beats straight down out of the source waveform', async () => {
    await mount();
    selectBeats(8, 4);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('4 beats'),
    );

    // Press the MIDDLE of the selection (its edges are resize handles)
    // and pull DOWN: no handle, no menu — the material comes with the
    // pointer.
    const wave = screen.getByTestId('beatify-track-waveform');
    fireEvent.mouseDown(wave, { clientX: x(10), clientY: 40 });
    fireEvent.mouseMove(window, { clientX: x(10), clientY: 90 });
    const cell = screen.getByTestId('beatify-clip-cell-0-2');
    fireEvent.mouseEnter(cell);
    expect(screen.getByTestId('beatify-clip-ghost')).toBeTruthy();
    fireEvent.mouseUp(cell);

    const placed = blocks();
    expect(placed).toHaveLength(1);
    expect(placed[0].dataset.beats).toBe('4');
    expect(placed[0].dataset.col).toBe('2');
  });

  it('slides sideways as before — only DOWN pulls material out', async () => {
    await mount();
    selectBeats(8, 4);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('4 beats'),
    );
    const wave = screen.getByTestId('beatify-track-waveform');
    fireEvent.mouseDown(wave, { clientX: x(10), clientY: 40 });
    fireEvent.mouseMove(window, { clientX: x(14), clientY: 44 });
    fireEvent.mouseUp(window);
    // Nothing was dropped into the clip; the selection just moved.
    expect(blocks()).toHaveLength(0);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('4 beats'),
    );
  });

  it('has nothing to drag until beats are selected', async () => {
    await mount();
    expect((screen.getByTestId('beatify-drag-beats') as HTMLButtonElement).disabled).toBe(true);
  });

  it('removes a run', async () => {
    await mount();
    selectBeats(0, 4);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('4 beats'),
    );
    dragInto(0, 0);
    const id = blocks()[0].dataset.testid ?? blocks()[0].getAttribute('data-testid');
    const pid = (id ?? '').replace('beatify-clip-block-', '');
    fireEvent.click(screen.getByTestId(`beatify-clip-remove-${pid}`));
    expect(blocks()).toHaveLength(0);
  });
});

describe('playback', () => {
  async function withOneRun() {
    const clips = await mount();
    selectBeats(0, 4);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('4 beats'),
    );
    dragInto(0, 0);
    return clips;
  }

  it('plays the clip from what is on screen, looped', async () => {
    const clips = await withOneRun();
    fireEvent.click(screen.getByTestId('beatify-clip-play'));
    await waitFor(() => expect(clips.preview).toHaveBeenCalled());
    const [, draft, start, secs] = (clips.preview as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(draft.placements).toHaveLength(1);
    expect(start).toBe(0);
    // Sixteen beats at 120 BPM: the clip's LENGTH, not the four beats of
    // material in it — the rest is silence, and it loops with the rest.
    expect(secs).toBeCloseTo(8, 6);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-clip-live').textContent).toBe('playing the clip'),
    );
  });

  it('will not play an empty clip, and says so', async () => {
    const clips = await mount();
    fireEvent.click(screen.getByTestId('beatify-clip-play'));
    expect(screen.getByTestId('beatify-clip-note').textContent).toContain('Nothing in the clip');
    expect(clips.preview).not.toHaveBeenCalled();
  });

  it('hands the sound to the source when the source is played, and back', async () => {
    await withOneRun();
    fireEvent.click(screen.getByTestId('beatify-clip-play'));
    await waitFor(() =>
      expect(screen.getByTestId('beatify-clip-live').textContent).toBe('playing the clip'),
    );

    // Only one of the two ever sounds: starting the source pane pauses
    // the clip, and the badge says which has it.
    fireEvent.click(screen.getByTestId('beatify-track-play'));
    await waitFor(() =>
      expect(screen.getByTestId('beatify-clip-live').textContent).toBe('playing the source'),
    );
    // …and the clip really did stop, not just lose the label.
    expect(screen.getByTestId('beatify-clip-play').textContent).toBe('\u25b6');
  });
});

describe('the clip length', () => {
  it('is sixteen beats to begin with, and is what plays', async () => {
    const clips = await mount();
    expect((screen.getByTestId('beatify-clip-length') as HTMLInputElement).value).toBe('16');
    expect(screen.getByTestId('beatify-clip-cell-0-15')).toBeTruthy();
    expect(screen.queryByTestId('beatify-clip-cell-0-16')).toBeNull();
    expect(clips.preview).not.toHaveBeenCalled();
  });

  it('is set in beats, and the grid follows', async () => {
    const clips = await mount();
    selectBeats(0, 4);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('4 beats'),
    );
    dragInto(0, 0);

    fireEvent.change(screen.getByTestId('beatify-clip-length'), { target: { value: '8' } });
    expect(screen.getByTestId('beatify-clip-cell-0-7')).toBeTruthy();
    expect(screen.queryByTestId('beatify-clip-cell-0-8')).toBeNull();

    fireEvent.click(screen.getByTestId('beatify-clip-play'));
    await waitFor(() => expect(clips.preview).toHaveBeenCalled());
    const [, , , secs] = (clips.preview as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(secs).toBeCloseTo(4, 6);
  });

  it('trims material that a shorter clip no longer has room for', async () => {
    await mount();
    selectBeats(0, 6);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('6 beats'),
    );
    dragInto(0, 4);
    expect(blocks()[0].dataset.beats).toBe('6');

    fireEvent.change(screen.getByTestId('beatify-clip-length'), { target: { value: '6' } });
    expect(blocks()[0].dataset.beats).toBe('2');
  });
});

describe('saving', () => {
  it('saves what was built and lists it as a source', async () => {
    const clips = await mount();
    selectBeats(0, 16);
    await waitFor(() =>
      expect(screen.getByTestId('beatify-drag-beats').textContent).toContain('16 beats'),
    );
    dragInto(0, 0);
    fireEvent.change(screen.getByTestId('beatify-clip-name'), { target: { value: 'Intro loop' } });
    fireEvent.click(screen.getByTestId('beatify-clip-save'));

    await waitFor(() => expect(clips.save).toHaveBeenCalled());
    const [, clip] = (clips.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(clip.name).toBe('Intro loop');
    expect(clip.placements).toEqual([
      expect.objectContaining({
        row: 0,
        col: 0,
        beats: 16,
        // The run remembers the seed it came from, by id.
        source: { kind: 'seed', id: 's1', stems: [] },
      }),
    ]);
    await screen.findByTestId('beatify-clip-source-clip:1');
  });

  // The clip in the list under that name is the receipt; a line saying
  // "Saved" is the same news twice, and the note line has refusals to
  // carry.
  it('does not congratulate you for saving', async () => {
    await mount();
    await fourBeatsAt(0);
    await saveAs('Intro loop');
    expect(screen.queryByTestId('beatify-clip-note')).toBeNull();
    expect(screen.getByTestId('beatify-clip-source-clip:1').textContent).toContain('Intro loop');
  });

  it('refuses to save an empty clip', async () => {
    const clips = await mount();
    fireEvent.click(screen.getByTestId('beatify-clip-save'));
    expect(clips.save).not.toHaveBeenCalled();
    expect(screen.getByTestId('beatify-clip-note').textContent).toContain('Nothing to save');
  });
});

describe('a drag is a drag, not a text selection', () => {
  it('never lets the browser start selecting text under one', async () => {
    await mount();
    // The grid…
    const cell = screen.getByTestId('beatify-clip-cell-0-3');
    const onCell = createEvent.mouseDown(cell, { button: 0 });
    fireEvent(cell, onCell);
    expect(onCell.defaultPrevented).toBe(true);

    // …and the waveform the beats come from.
    const wave = screen.getByTestId('beatify-track-waveform');
    const onWave = createEvent.mouseDown(wave, { button: 0, clientX: x(4) });
    fireEvent(wave, onWave);
    expect(onWave.defaultPrevented).toBe(true);
  });
});

describe('copying a chunk of the clip', () => {
  it('copies what was swept and pastes it where the next selection is', async () => {
    await mount();
    await fourBeatsAt(0);

    sweepCells(0, 0, 0, 3);
    expect(screen.getByTestId('beatify-clip-marquee-0')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    expect(screen.getByTestId('beatify-clip-note').textContent).toContain('Copied 1 run');

    sweepCells(0, 8, 0, 8);
    fireEvent.keyDown(window, { key: 'v', metaKey: true });

    const placed = blocks().sort((a, b) => Number(a.dataset.col) - Number(b.dataset.col));
    expect(placed.map((b) => [b.dataset.col, b.dataset.beats])).toEqual([
      ['0', '4'],
      ['8', '4'],
    ]);
  });

  it('copies only what the selection covers, not the whole run', async () => {
    await mount();
    await fourBeatsAt(0);

    sweepCells(0, 0, 0, 1);
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    sweepCells(0, 8, 0, 8);
    fireEvent.keyDown(window, { key: 'v', metaKey: true });

    const pasted = blocks().find((b) => b.dataset.col === '8');
    expect(pasted?.dataset.beats).toBe('2');
  });

  it('leaves the clip alone when the selection is empty, and Escape drops it', async () => {
    await mount();
    sweepCells(0, 4, 0, 6);
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    expect(screen.getByTestId('beatify-clip-note').textContent).toContain('Nothing in that');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('beatify-clip-marquee-0')).toBeNull();
  });
});

describe('the clips drawer and the editor are separate', () => {
  it('opens a clip as a SOURCE without touching the editor', async () => {
    const clips = await mount();
    await fourBeatsAt(0);
    await saveAs('Intro loop');

    fireEvent.click(screen.getByTestId('beatify-clip-new'));
    expect(blocks()).toHaveLength(0);

    fireEvent.click(screen.getByTestId('beatify-clip-source-clip:1'));
    await waitFor(() =>
      expect(clips.open).toHaveBeenCalledWith('p1', { kind: 'clip', id: '1' }, expect.any(Number)),
    );
    // The editor is still the empty clip we started: opening material to
    // cut up is not opening it to edit.
    expect(blocks()).toHaveLength(0);
    expect((screen.getByTestId('beatify-clip-name') as HTMLInputElement).value).toBe(
      'Untitled clip',
    );
  });

  it('opens a clip in the EDITOR from the pencil, without touching the source', async () => {
    const clips = await mount();
    await fourBeatsAt(0);
    await saveAs('Intro loop');
    fireEvent.click(screen.getByTestId('beatify-clip-new'));

    const opens = (clips.open as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByTestId('beatify-clip-edit-clip:1'));

    expect(blocks()).toHaveLength(1);
    expect((screen.getByTestId('beatify-clip-name') as HTMLInputElement).value).toBe('Intro loop');
    expect((clips.open as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(opens);
    expect(screen.getByTestId('beatify-track-title').textContent).toBe('Live Set A');
  });

  it('starts a fresh clip on "+ new clip"', async () => {
    await mount();
    await fourBeatsAt(0);
    fireEvent.change(screen.getByTestId('beatify-clip-name'), { target: { value: 'Scratch' } });

    fireEvent.click(screen.getByTestId('beatify-clip-new'));
    expect(blocks()).toHaveLength(0);
    expect((screen.getByTestId('beatify-clip-name') as HTMLInputElement).value).toBe(
      'Untitled clip',
    );
  });
});

describe('saving and deleting the clip in front of you', () => {
  it('saves on Enter in the name box', async () => {
    const clips = await mount();
    await fourBeatsAt(0);
    fireEvent.change(screen.getByTestId('beatify-clip-name'), { target: { value: 'Verse' } });
    fireEvent.keyDown(screen.getByTestId('beatify-clip-name'), { key: 'Enter' });

    await waitFor(() => expect(clips.save).toHaveBeenCalled());
    expect((clips.save as ReturnType<typeof vi.fn>).mock.calls[0][1].name).toBe('Verse');
  });

  it('files the same clip twice under one id rather than two', async () => {
    const clips = await mount();
    await fourBeatsAt(0);
    await saveAs('Intro loop');

    fireEvent.click(screen.getByTestId('beatify-clip-save'));
    await waitFor(() =>
      expect((clips.save as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2),
    );
    expect((clips.save as ReturnType<typeof vi.fn>).mock.calls[1][1].id).toBe('1');
  });

  it('cannot delete a clip that was never saved', async () => {
    await mount();
    await fourBeatsAt(0);
    expect((screen.getByTestId('beatify-clip-delete') as HTMLButtonElement).disabled).toBe(true);
  });

  it('deletes the saved clip, leaving the material unsaved on the grid', async () => {
    const clips = await mount();
    await fourBeatsAt(0);
    await saveAs('Intro loop');
    expect((screen.getByTestId('beatify-clip-delete') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('beatify-clip-delete'));
    await waitFor(() => expect(clips.remove).toHaveBeenCalledWith('p1', '1'));
    await waitFor(() => expect(screen.queryByTestId('beatify-clip-source-clip:1')).toBeNull());

    expect(blocks()).toHaveLength(1);
    expect(screen.getByTestId('beatify-clip-note').textContent).toContain('now unsaved');
    expect((screen.getByTestId('beatify-clip-delete') as HTMLButtonElement).disabled).toBe(true);
  });
});
