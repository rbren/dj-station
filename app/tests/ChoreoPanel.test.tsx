// Choreography panel: beat ruler + lanes render from status, boolean
// cells toggle, note cells set/clear/velocity (cmd+click), continuous
// drawing sends value runs, track add/rename/reorder/remove wire through
// the API, and the CHOREO_SCALES table stays pinned to the engine's
// canonical SCALES in crates/dj-engine/src/choreo.rs.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CHOREO_SCALES,
  ChoreoPanel,
  degreeName,
  noteName,
  type ChoreoApi,
} from '../src/components/ChoreoPanel';
import type { ChoreoStatus } from '../src/engine';

function makeStatus(overrides: Partial<ChoreoStatus> = {}): ChoreoStatus {
  return {
    beats: 8,
    tracks: [
      {
        name: 'kick',
        jack: 0,
        data: { kind: 'boolean', steps: [true, false, true, false, false, false, false, false] },
      },
      { name: 'sweep', jack: 1, data: { kind: 'continuous', values: [0, 2, 4, 6, 8, 6, 4, 2] } },
      {
        name: 'lead',
        jack: 2,
        data: {
          kind: 'note',
          octaves: 1,
          scale: 'penta maj',
          base_note: 60,
          steps: [{ degree: 0, velocity: 1 }, null, null, null, null, null, null, null],
        },
      },
    ],
    playhead: 2,
    ...overrides,
  };
}

function makeApi(status: ChoreoStatus): ChoreoApi & { status: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn().mockResolvedValue(status),
    setBeats: vi.fn().mockResolvedValue(undefined),
    addTrack: vi.fn().mockResolvedValue(undefined),
    removeTrack: vi.fn().mockResolvedValue(undefined),
    renameTrack: vi.fn().mockResolvedValue(undefined),
    moveTrack: vi.fn().mockResolvedValue(undefined),
    setBool: vi.fn().mockResolvedValue(undefined),
    setValues: vi.fn().mockResolvedValue(undefined),
    setNote: vi.fn().mockResolvedValue(undefined),
    setNoteSettings: vi.fn().mockResolvedValue(undefined),
    endEdit: vi.fn().mockResolvedValue(undefined),
  };
}

// jsdom has no PointerEvent; without this, fireEvent.pointerDown drops
// clientX/clientY (they come out NaN in the handler).
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const noop = () => {};

async function renderPanel(api: ChoreoApi) {
  render(<ChoreoPanel instance="ch1" api={api} onChanged={noop} pollMs={100000} />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}

/** JSDOM has no layout: give lane SVGs a real bounding box. */
function mockRect(el: Element, width: number, height: number) {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 }) as DOMRect;
  (el as unknown as { setPointerCapture(id: number): void }).setPointerCapture = () => {};
}

describe('ChoreoPanel', () => {
  it('renders all lanes, active boolean cells, notes and the playhead', async () => {
    await renderPanel(makeApi(makeStatus()));
    for (const i of [0, 1, 2]) {
      expect(screen.getByTestId(`choreo-lane-ch1-${i}`)).toBeTruthy();
    }
    expect(screen.getByTestId('choreo-bool-ch1-0-0')).toBeTruthy();
    expect(screen.getByTestId('choreo-bool-ch1-0-2')).toBeTruthy();
    expect(screen.queryByTestId('choreo-bool-ch1-0-1')).toBeNull();
    expect(screen.getByTestId('choreo-note-ch1-2-0').getAttribute('data-degree')).toBe('0');
    const playhead = screen.getByTestId('choreo-playhead-ch1');
    // Beat 2 at 14 px/beat behind the 116 px label column.
    expect(playhead.style.left).toBe(`${116 + 2 * 14}px`);
  });

  it('hides the playhead before the first clock (playhead -1)', async () => {
    await renderPanel(makeApi(makeStatus({ playhead: -1 })));
    expect(screen.queryByTestId('choreo-playhead-ch1')).toBeNull();
  });

  it('toggles a boolean cell on click', async () => {
    const api = makeApi(makeStatus());
    await renderPanel(api);
    const lane = screen.getByTestId('choreo-lane-ch1-0');
    mockRect(lane, 8 * 14, 26);
    // Beat 1 (x = 1.5 * 14) is currently off -> toggles on.
    fireEvent.pointerDown(lane, { clientX: 21, clientY: 13 });
    expect(api.setBool).toHaveBeenCalledWith('ch1', 0, 1, true);
    // Beat 0 is on -> toggles off.
    fireEvent.pointerDown(lane, { clientX: 7, clientY: 13 });
    expect(api.setBool).toHaveBeenCalledWith('ch1', 0, 0, false);
    fireEvent.pointerUp(lane);
    expect(api.endEdit).toHaveBeenCalled();
  });

  it('draws continuous values from pointer position', async () => {
    const api = makeApi(makeStatus());
    await renderPanel(api);
    const lane = screen.getByTestId('choreo-lane-ch1-1');
    mockRect(lane, 8 * 14, 56);
    // Top of the lane = +10 V at that beat.
    fireEvent.pointerDown(lane, { clientX: 7, clientY: 0 });
    expect(api.setValues).toHaveBeenCalledWith('ch1', 1, 0, [10]);
    // Middle = 0 V.
    fireEvent.pointerMove(lane, { clientX: 35, clientY: 28 });
    expect(api.setValues).toHaveBeenCalledWith('ch1', 1, 2, [0]);
  });

  it('sets, clears and velocity-adjusts notes (one per beat)', async () => {
    const api = makeApi(makeStatus());
    await renderPanel(api);
    const lane = screen.getByTestId('choreo-lane-ch1-2');
    const rows = CHOREO_SCALES['penta maj'].length; // 5 rows, 12 px each
    mockRect(lane, 8 * 14, rows * 12);
    // Click the top row (degree 4) of beat 1: sets that note.
    fireEvent.pointerDown(lane, { clientX: 21, clientY: 6 });
    expect(api.setNote).toHaveBeenCalledWith('ch1', 2, 1, { degree: 4, velocity: 1 });
    // Click beat 0's existing note cell (degree 0 = bottom row): clears it.
    fireEvent.pointerDown(lane, { clientX: 7, clientY: rows * 12 - 6 });
    expect(api.setNote).toHaveBeenCalledWith('ch1', 2, 0, null);
    // Cmd+click then drag down: sets and lowers velocity.
    fireEvent.pointerDown(lane, { clientX: 7, clientY: rows * 12 - 6, metaKey: true });
    expect(api.setNote).toHaveBeenCalledWith('ch1', 2, 0, { degree: 0, velocity: 1 });
    fireEvent.pointerMove(lane, { clientX: 7, clientY: rows * 12 - 6 + 50 });
    expect(api.setNote).toHaveBeenCalledWith('ch1', 2, 0, { degree: 0, velocity: 0.5 });
    fireEvent.pointerUp(lane);
    expect(api.endEdit).toHaveBeenCalled();
  });

  it('adds, renames, removes and reorders tracks through the API', async () => {
    const api = makeApi(makeStatus());
    await renderPanel(api);

    fireEvent.change(screen.getByTestId('choreo-new-name-ch1'), { target: { value: 'bass' } });
    fireEvent.change(screen.getByTestId('choreo-new-kind-ch1'), { target: { value: 'note' } });
    fireEvent.click(screen.getByTestId('choreo-add-ch1'));
    expect(api.addTrack).toHaveBeenCalledWith('ch1', 'bass', 'note');

    fireEvent.change(screen.getByTestId('choreo-name-ch1-0'), { target: { value: 'kick2' } });
    expect(api.renameTrack).toHaveBeenCalledWith('ch1', 0, 'kick2');

    fireEvent.click(screen.getByTestId('choreo-remove-ch1-1'));
    expect(api.removeTrack).toHaveBeenCalledWith('ch1', 1);

    // Drag track 0's handle over track 2, release.
    fireEvent.pointerDown(screen.getByTestId('choreo-drag-ch1-0'));
    fireEvent.pointerEnter(screen.getByTestId('choreo-track-ch1-2'));
    await act(async () => {
      window.dispatchEvent(new Event('pointerup'));
      await Promise.resolve();
    });
    expect(api.moveTrack).toHaveBeenCalledWith('ch1', 0, 2);
  });

  it('note settings edit octaves/scale/base note', async () => {
    const api = makeApi(makeStatus());
    await renderPanel(api);
    fireEvent.click(screen.getByTestId('choreo-settings-ch1-2'));
    fireEvent.change(screen.getByTestId('choreo-scale-ch1-2'), { target: { value: 'minor' } });
    expect(api.setNoteSettings).toHaveBeenCalledWith('ch1', 2, 1, 'minor', 60);
    fireEvent.change(screen.getByTestId('choreo-octaves-ch1-2'), { target: { value: '3' } });
    expect(api.setNoteSettings).toHaveBeenCalledWith('ch1', 2, 3, 'penta maj', 60);
  });

  it('changes the timeline length', async () => {
    const api = makeApi(makeStatus());
    await renderPanel(api);
    fireEvent.change(screen.getByTestId('choreo-beats-ch1'), { target: { value: '128' } });
    expect(api.setBeats).toHaveBeenCalledWith('ch1', 128);
  });
});

describe('note naming', () => {
  it('names MIDI notes and scale degrees', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(57)).toBe('A3');
    expect(degreeName('major', 60, 0)).toBe('C4');
    expect(degreeName('major', 60, 7)).toBe('C5'); // octave wrap
    expect(degreeName('penta maj', 60, 5)).toBe('C5'); // 5 degrees/octave
  });
});

describe('scale table pin', () => {
  it('CHOREO_SCALES matches the engine SCALES table in choreo.rs', () => {
    const src = readFileSync(join(__dirname, '../../crates/dj-engine/src/choreo.rs'), 'utf8');
    const block = src.match(/pub const SCALES[^;]+;/)?.[0];
    expect(block).toBeTruthy();
    const rust: Record<string, number[]> = {};
    for (const m of block!.matchAll(/\("([^"]+)",\s*&\[([^\]]+)\]\)/g)) {
      rust[m[1]] = m[2].split(',').map((s) => Number(s.trim()));
    }
    expect(CHOREO_SCALES).toEqual(rust);
  });
});
