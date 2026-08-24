// The clip builder: sources on the left, the open one across the top,
// the clip being built underneath.
//
// The model's arithmetic is pinned in BeatifyClip.test.ts; this file is
// about the parts only a mounted page has — dragging beats out of the
// source into a cell, the grid growing, and the rule that the source and
// the clip never sound at once.

import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BeatifyTrack } from '../src/beatify';
import type { BeatifyClipClientApi, SavedClip } from '../src/beatifyClip';
import { BeatifyClipBuilder } from '../src/components/BeatifyClipBuilder';

const GRID = { bpm: 120, period: 0.5, phase: 0.5, beats: 64 };
/** The warped render: 64 beats of half a second, plus the head padding. */
const DURATION = 32.5;

function beatified(): BeatifyTrack {
  return {
    trackId: 3,
    title: 'Live Set A',
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

function clipsMock(overrides: Partial<BeatifyClipClientApi> = {}): BeatifyClipClientApi {
  const saved: SavedClip[] = [];
  return {
    sources: vi.fn(async () => ({
      sources: [
        { source: { kind: 'seed' as const }, label: 'Seed track', available: true, hint: null },
        {
          source: { kind: 'stem' as const, name: 'drums' },
          label: 'drums',
          available: true,
          hint: null,
        },
        {
          source: { kind: 'stem' as const, name: 'vocals' },
          label: 'vocals',
          available: false,
          hint: 'no demucs stems yet — separate this track on the Clip page first',
        },
      ],
      clips: saved,
      grid: GRID,
    })),
    open: vi.fn(async (_trackId, source) => ({
      source,
      label: source.kind === 'stem' ? source.name : 'Seed track',
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

async function mount(clips: BeatifyClipClientApi = clipsMock()) {
  render(<BeatifyClipBuilder track={beatified()} clips={clips} onRebeatify={() => {}} />);
  await screen.findByTestId('beatify-clip-list');
  await screen.findByTestId('beatify-track-waveform');
  return clips;
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

describe('the clip list', () => {
  it('offers the seed track and its stems as the same kind of thing', async () => {
    await mount();
    expect(screen.getByTestId('beatify-clip-source-seed').textContent).toContain('Seed track');
    expect(screen.getByTestId('beatify-clip-source-stem:drums')).toBeTruthy();
  });

  it('lists a stem that has not been separated, disabled, with the fix', async () => {
    await mount();
    const vocals = screen.getByTestId('beatify-clip-source-stem:vocals') as HTMLButtonElement;
    expect(vocals.disabled).toBe(true);
    expect(screen.getByTestId('beatify-clip-list').textContent).toContain('separate this track');
  });

  it('opens the source you click into the pane above', async () => {
    const clips = await mount();
    fireEvent.click(screen.getByTestId('beatify-clip-source-stem:drums'));
    await waitFor(() =>
      expect(clips.open).toHaveBeenCalledWith(
        3,
        { kind: 'stem', name: 'drums' },
        expect.any(Number),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('beatify-track-title').textContent).toBe('drums'),
    );
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
      expect.objectContaining({ row: 0, col: 0, beats: 16, source: { kind: 'seed' } }),
    ]);
    await screen.findByTestId('beatify-clip-source-clip:1');
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
      expect(clips.open).toHaveBeenCalledWith(3, { kind: 'clip', id: '1' }, expect.any(Number)),
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
    expect(screen.getByTestId('beatify-track-title').textContent).toBe('Seed track');
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
    await waitFor(() => expect(clips.remove).toHaveBeenCalledWith(3, '1'));
    await waitFor(() => expect(screen.queryByTestId('beatify-clip-source-clip:1')).toBeNull());

    expect(blocks()).toHaveLength(1);
    expect(screen.getByTestId('beatify-clip-note').textContent).toContain('now unsaved');
    expect((screen.getByTestId('beatify-clip-delete') as HTMLButtonElement).disabled).toBe(true);
  });
});
