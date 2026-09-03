// A Grid track's effects rack: what the default one is, what counts as
// having modified it (the row button's colour), how patching behaves,
// what the chrome's Level and Pan do to the sound, and that the whole
// thing survives a save/open round trip.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BeatClipApi, BeatClipEntry } from '../src/beatClip';
import { GridFxModal } from '../src/components/GridFxModal';
import { GridView } from '../src/components/GridView';
import {
  emptyGrid,
  fromDocument,
  placeClip,
  scheduleRange,
  toDocument,
  type GridRow,
  type GridState,
} from '../src/grid';
import {
  addFxModule,
  connectFx,
  defaultTrackFx,
  fxJackClick,
  fxJackWired,
  isTrackFxModified,
  removeFxModule,
  setFxValue,
  FX_CHROME,
  FX_CLOCK,
  FX_CLOCK_MULT,
  FX_EQ,
  FX_IN_L,
  FX_LFO,
  FX_OUT_L,
  FX_SCOPE,
  type TrackFx,
} from '../src/gridFx';
import type { Manifest } from '../src/types';

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

function row(over: Partial<GridRow> = {}): GridRow {
  return { id: 'row1', clipId: 'c1', placements: [], levels: [], ...over };
}

const wireOf = (fx: TrackFx, from: string, jack: string) =>
  fx.wires.find((w) => w.from_instance === from && w.from_jack === jack);

describe('the default track rack', () => {
  const fx = defaultTrackFx();

  it('is an EQ on the mono (L) path with a scope between it and the way back', () => {
    expect(fx.modules.map((m) => m.type)).toEqual([FX_EQ, FX_SCOPE, FX_CLOCK_MULT, FX_LFO]);
    expect(wireOf(fx, FX_CHROME, FX_OUT_L)?.to_instance).toBe('eq1');
    expect(wireOf(fx, 'eq1', 'out')?.to_instance).toBe('scope1');
    expect(wireOf(fx, 'scope1', 'thru')).toMatchObject({
      to_instance: FX_CHROME,
      to_jack: FX_IN_L,
    });
  });

  it('runs the grid clock into a 2x multiplier feeding an LFO that goes nowhere yet', () => {
    expect(wireOf(fx, FX_CHROME, FX_CLOCK)?.to_instance).toBe('clockmult1');
    expect(fx.modules.find((m) => m.id === 'clockmult1')?.values.mult).toBe(2);
    expect(wireOf(fx, 'clockmult1', 'out')).toMatchObject({ to_instance: 'lfo1' });
    // The modulation is patched IN but not OUT: nothing takes the LFO.
    expect(fx.wires.some((w) => w.from_instance === 'lfo1')).toBe(false);
  });

  it('starts at unity, centred and FULL WET', () => {
    expect(fx).toMatchObject({ level: 1, pan: 0, wet: 1 });
  });
});

describe('has the rack been modified', () => {
  it('is false for a row that has never been opened, and for the default rack', () => {
    expect(isTrackFxModified(undefined)).toBe(false);
    expect(isTrackFxModified(defaultTrackFx())).toBe(false);
  });

  it('is true for a knob, a cable, a module or a chrome control — and false again undone', () => {
    const base = defaultTrackFx();
    expect(isTrackFxModified({ ...base, wet: 0.5 })).toBe(true);
    expect(isTrackFxModified(setFxValue(base, 'clockmult1', 'mult', 4))).toBe(true);
    expect(isTrackFxModified(addFxModule(base, FX_LFO))).toBe(true);
    expect(isTrackFxModified(removeFxModule(base, 'lfo1'))).toBe(true);
    // Back to what it was: the answer is a comparison, not a flag.
    expect(
      isTrackFxModified(
        setFxValue(setFxValue(base, 'clockmult1', 'mult', 4), 'clockmult1', 'mult', 2),
      ),
    ).toBe(false);
  });

  it('a knob put back to its manifest default stores nothing at all', () => {
    const fx = setFxValue(defaultTrackFx(), 'eq1', 'gain1', 3);
    expect(fx.modules.find((m) => m.id === 'eq1')?.values.gain1).toBe(3);
    const back = setFxValue(fx, 'eq1', 'gain1', 0, 0);
    expect(back.modules.find((m) => m.id === 'eq1')?.values).toEqual({});
    expect(isTrackFxModified(back)).toBe(false);
  });
});

describe('patching the rack', () => {
  it('arms an output and lands the cable on an input', () => {
    const base = defaultTrackFx();
    const armed = fxJackClick(base, null, { instance: 'lfo1', jack: 'bi', kind: 'output' });
    expect(armed.pending).toMatchObject({ instance: 'lfo1', jack: 'bi' });
    const done = fxJackClick(armed.fx, armed.pending, {
      instance: 'eq1',
      jack: 'gain1',
      kind: 'input',
    });
    expect(done.pending).toBeNull();
    expect(wireOf(done.fx, 'lfo1', 'bi')).toMatchObject({ to_instance: 'eq1', to_jack: 'gain1' });
  });

  it('gives an input ONE cable: a second one replaces the first', () => {
    const fx = connectFx(
      defaultTrackFx(),
      { instance: 'lfo1', jack: 'uni' },
      { instance: 'eq1', jack: 'in' },
    );
    expect(fx.wires.filter((w) => w.to_instance === 'eq1' && w.to_jack === 'in')).toHaveLength(1);
    expect(wireOf(fx, FX_CHROME, FX_OUT_L)).toBeUndefined();
  });

  it('shift+click unplugs, and a click on a wired input picks the cable up', () => {
    const base = defaultTrackFx();
    const unplugged = fxJackClick(base, null, {
      instance: 'eq1',
      jack: 'in',
      kind: 'input',
      shift: true,
    });
    expect(fxJackWired(unplugged.fx, 'eq1', 'in')).toBe(false);
    expect(unplugged.pending).toBeNull();

    const picked = fxJackClick(base, null, { instance: 'eq1', jack: 'in', kind: 'input' });
    expect(fxJackWired(picked.fx, 'eq1', 'in')).toBe(false);
    expect(picked.pending).toMatchObject({ instance: FX_CHROME, jack: FX_OUT_L, kind: 'output' });
  });

  it('takes a module out with its cables', () => {
    const fx = removeFxModule(defaultTrackFx(), 'scope1');
    expect(fx.wires.some((w) => w.from_instance === 'scope1' || w.to_instance === 'scope1')).toBe(
      false,
    );
  });
});

describe('what the chrome does to the sound', () => {
  const c = clip();
  const clips = new Map([['c1', c]]);
  const state = (fx?: TrackFx): GridState => ({
    ...emptyGrid(120),
    rows: [placeClip(row({ fx }), c, 0)],
  });

  it('LEVEL is the BASELINE the row automation is read against', () => {
    const plain = scheduleRange(state(), clips, { start: 0, end: 32 })[0];
    expect(plain.levels[0][1]).toBe(1);

    const half = scheduleRange(state({ ...defaultTrackFx(), level: 0.5 }), clips, {
      start: 0,
      end: 32,
    })[0];
    expect(half.levels[0][1]).toBe(0.5);
  });

  it('scales a written fade by the baseline rather than replacing it', () => {
    const fx = { ...defaultTrackFx(), level: 0.5 };
    const withFade = {
      ...state(fx),
      rows: [
        placeClip(
          row({
            fx,
            levels: [
              { beat: 0, level: 1 },
              { beat: 4, level: 0 },
            ],
          }),
          c,
          0,
        ),
      ],
    };
    const copy = scheduleRange(withFade, clips, { start: 0, end: 32 })[0];
    expect(copy.levels[0][1]).toBe(0.5);
    expect(copy.levels[copy.levels.length - 1][1]).toBe(0);
  });

  it("hands the player the row's pan", () => {
    const copy = scheduleRange(state({ ...defaultTrackFx(), pan: -1 }), clips, {
      start: 0,
      end: 32,
    })[0];
    expect(copy.pan).toBe(-1);
  });
});

describe('the rack in the document', () => {
  it('survives a save/open round trip, and an older file simply has none', () => {
    const fx = setFxValue({ ...defaultTrackFx(), wet: 0.25 }, 'eq1', 'gain1', 6);
    const state: GridState = { ...emptyGrid(120), rows: [row({ fx })] };
    const back = fromDocument(JSON.parse(JSON.stringify(toDocument(state))));
    expect(back.rows[0].fx).toEqual(fx);
    expect(isTrackFxModified(back.rows[0].fx)).toBe(true);

    const old = fromDocument({
      version: 1,
      state: { rows: [{ id: 'row1', clipId: 'c1', placements: [], levels: [] }] },
    });
    expect(old.rows[0].fx).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The page and the modal
// ---------------------------------------------------------------------------

const manifest = (
  id: string,
  name: string,
  inputs: Manifest['inputs'],
  outputs: Manifest['outputs'],
): Manifest => ({ id, name, version: '0.1.0', abi: 'wasm-1', inputs, outputs, params: [] });

const MODULES: Manifest[] = [
  manifest(
    FX_EQ,
    'EQ',
    [
      { id: 'in', name: 'In', default: 0, audio: true },
      {
        id: 'gain1',
        name: 'Gain 1',
        default: 0,
        knob: { style: 'continuous', min: -15, max: 15, curve: 'linear' },
      },
    ],
    [{ id: 'out', name: 'Out' }],
  ),
  manifest(
    FX_SCOPE,
    'Scope',
    [{ id: 'in', name: 'In', default: 0 }],
    [{ id: 'thru', name: 'Thru' }],
  ),
  manifest(
    FX_CLOCK_MULT,
    'Clock Multiplier',
    [
      { id: 'clock', name: 'Clock', default: 0 },
      {
        id: 'mult',
        name: 'Multiplier',
        default: 1,
        knob: { style: 'continuous', min: -64, max: 64, curve: 'linear' },
      },
    ],
    [{ id: 'out', name: 'Clock Out' }],
  ),
  manifest(
    FX_LFO,
    'LFO',
    [{ id: 'clock', name: 'Clock', default: 0 }],
    [{ id: 'bi', name: 'Bipolar' }],
  ),
];

function makeClips(): BeatClipApi {
  return {
    list: vi.fn().mockResolvedValue([clip()]),
    load: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue([]),
    peaks: vi.fn().mockResolvedValue([]),
    gridSave: vi.fn().mockResolvedValue(undefined),
    gridLoad: vi.fn().mockResolvedValue(null),
    gridList: vi.fn().mockResolvedValue([]),
  };
}

describe('the Grid page button', () => {
  async function addRowThroughPicker() {
    render(<GridView clips={makeClips()} pollMs={100000} />);
    fireEvent.click(screen.getByTestId('grid-add'));
    await waitFor(() => expect(screen.getByTestId('grid-picker')).toBeTruthy());
    fireEvent.click(screen.getByTestId('grid-picker-track-h1'));
    await waitFor(() => expect(screen.queryByTestId('grid-picker')).toBeNull());
  }

  it('is gray until the rack is changed, then blue', async () => {
    await addRowThroughPicker();
    const button = screen.getByTestId('grid-fx-row1');
    expect(button.getAttribute('data-modified')).toBe('false');

    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('grid-fx-modal')).toBeTruthy());
    // ARMING a jack is not an edit — nothing about the rack has changed
    // until a cable lands.
    fireEvent.click(screen.getByTestId(`jack-output-${FX_OUT_L}`));
    fireEvent.click(screen.getByTestId('grid-fx-close'));
    await waitFor(() =>
      expect(screen.getByTestId('grid-fx-row1').getAttribute('data-modified')).toBe('false'),
    );

    fireEvent.click(screen.getByTestId('grid-fx-row1'));
    await waitFor(() => expect(screen.getByTestId('grid-fx-modal')).toBeTruthy());
    fireEvent.click(screen.getByTestId(`jack-output-${FX_OUT_L}`));
    fireEvent.click(screen.getByTestId(`jack-input-${FX_IN_L}`));
    fireEvent.click(screen.getByTestId('grid-fx-close'));
    await waitFor(() =>
      expect(screen.getByTestId('grid-fx-row1').getAttribute('data-modified')).toBe('true'),
    );
  });
});

describe('the effects modal', () => {
  function showModal(fx: TrackFx, onChange = vi.fn()) {
    render(
      <GridFxModal
        title="main drums"
        fx={fx}
        bpm={128}
        modules={MODULES}
        onChange={onChange}
        onClose={vi.fn()}
      />,
    );
    return onChange;
  }

  it('draws the chrome: the grid clock, the track audio both ways, and three controls', () => {
    showModal(defaultTrackFx());
    expect(screen.getByTestId('grid-fx-clock').textContent).toContain('128');
    expect(screen.getByTestId(`jack-output-${FX_CLOCK}`)).toBeTruthy();
    expect(screen.getByTestId(`jack-output-${FX_OUT_L}`)).toBeTruthy();
    expect(screen.getByTestId(`jack-input-${FX_IN_L}`)).toBeTruthy();
    for (const label of ['Level', 'Pan', 'Wet']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('draws the rack as module panels and its cables between them', () => {
    showModal(defaultTrackFx());
    expect(screen.getByTestId('module-eq1')).toBeTruthy();
    expect(screen.getByTestId('module-lfo1')).toBeTruthy();
    // Every cable in the state resolves to two sockets that exist.
    expect(screen.getAllByTestId(/^cable-/)).toHaveLength(defaultTrackFx().wires.length);
  });

  it('reports a chrome knob turn as an edit', () => {
    const onChange = showModal(defaultTrackFx());
    const knob = screen.getByRole('slider', { name: 'Pan' });
    fireEvent.mouseDown(knob, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 0, clientY: -40 });
    fireEvent.mouseUp(window);
    expect(onChange).toHaveBeenCalled();
    const [next] = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect((next as TrackFx).pan).toBeGreaterThan(0);
  });

  it('opens zoomed out, and the buttons move the camera', () => {
    showModal(defaultTrackFx());
    expect(screen.getByTestId('grid-fx-zoom-reset').textContent).toBe('50%');
    const canvas = screen.getByTestId('grid-fx-canvas');
    expect(canvas.style.transform).toContain('scale(0.5)');
    fireEvent.click(screen.getByTestId('grid-fx-zoom-in'));
    expect(canvas.style.transform).toContain('scale(0.625)');
    fireEvent.click(screen.getByTestId('grid-fx-zoom-reset'));
    expect(canvas.style.transform).toContain('scale(0.5)');
  });

  it('pushes a dragged panel out of a neighbour instead of overlapping it', () => {
    const onChange = showModal(defaultTrackFx());
    // eq1 sits at (0,0) and scope1 at (384,0); headless panels measure as
    // the nominal 4×2-cell footprint (192×96). Screen deltas are HALVED
    // by the 0.5 zoom, so 192px of mouse is 384 rack px — exactly onto
    // scope1, whence the push-out slides the EQ past it.
    fireEvent.mouseDown(screen.getByTestId('module-header-eq1'), {
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.mouseMove(window, { clientX: 192, clientY: 0 });
    fireEvent.mouseUp(window);
    const [next] = onChange.mock.calls[onChange.mock.calls.length - 1];
    const eq = (next as TrackFx).modules.find((m) => m.id === 'eq1')!;
    expect(eq.y).toBe(0);
    expect(eq.x).toBe(576);
  });

  it('lands a module from the picker on a free spot in view', () => {
    const onChange = showModal(defaultTrackFx());
    fireEvent.click(screen.getByTestId('grid-fx-add'));
    fireEvent.click(screen.getByTestId(`library-add-${FX_EQ}`));
    const [next] = onChange.mock.calls[onChange.mock.calls.length - 1];
    const added = (next as TrackFx).modules[4];
    expect(added.type).toBe(FX_EQ);
    // Clear of all four default panels (nominal 192×96 footprints)…
    const rect = { x: added.x, y: added.y, w: 192, h: 96 };
    for (const m of defaultTrackFx().modules) {
      const other = { x: m.x, y: m.y, w: 192, h: 96 };
      const apart =
        rect.x + rect.w <= other.x ||
        other.x + other.w <= rect.x ||
        rect.y + rect.h <= other.y ||
        other.y + other.h <= rect.y;
      expect(apart).toBe(true);
    }
    // …and inside the (nominal, headless) viewport rather than off past
    // the canvas edge.
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(768);
    expect(rect.y + rect.h).toBeLessThanOrEqual(576);
  });
});
