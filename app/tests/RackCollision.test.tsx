// Rack collision system: zoom-corrected module drags, nearest-free-spot
// placement, and the co-operative bump — dragging A past B when there is
// no room on B's far side displaces B minimally (provisional until the
// drag is released; reverted if A moves on).
//
// jsdom reports offsetWidth/Height of 0, so every panel uses moduleRect's
// nominal fallback footprint of 4×2 grid cells (192×96 px) — the
// geometry below relies on that.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nearestFreeSpot, rectsOverlap, spotInView } from '../src/rackLayout';
import type { Manifest } from '../src/types';

const OSC: Manifest = {
  id: 'com.dj.oscillator',
  name: 'Oscillator',
  version: '0.1.0',
  abi: 'wasm-1',
  inputs: [{ id: 'pitch', name: 'Pitch' }],
  outputs: [{ id: 'audio', name: 'Audio' }],
  params: [],
};

const state = { nodes: [] as unknown[] };

const fakeEngine = {
  loadDemoPatch: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  listModules: vi.fn(async () => [OSC]),
  nodes: vi.fn(async () => state.nodes),
  wires: vi.fn(async () => []),
  tap: vi.fn(async () => null),
  tapAll: vi.fn(async () => ({})),
  macroGroups: vi.fn(async () => []),
  macroLayout: vi.fn(async () => ({})),
  breakMacro: vi.fn(async () => ({})),
  addModule: vi.fn(async () => {}),
  currentPatch: vi.fn(async () => null),
  listPatches: vi.fn(async () => []),
  savePatchAs: vi.fn(async () => {}),
  removeModule: vi.fn(async () => {}),
  endEdit: vi.fn(async () => {}),
  moveModules: vi.fn(async () => {}),
  syncPositions: vi.fn(async () => {}),
};

vi.mock('../src/engine', () => ({
  engine: new Proxy({}, { get: (_t, prop) => fakeEngine[prop as keyof typeof fakeEngine] }),
  onMenuAction: () => () => {},
}));

import App from '../src/App';

function node(instance: string) {
  return {
    instance_id: instance,
    type_id: OSC.id,
    manifest: OSC,
    knobs: {},
    params: {},
    wired_inputs: [],
    midi_mappings: [],
  };
}

function setPositions(positions: Record<string, { x: number; y: number }>) {
  localStorage.setItem('dj-rack-positions', JSON.stringify(positions));
}

function savedPositions(): Record<string, { x: number; y: number }> {
  return JSON.parse(localStorage.getItem('dj-rack-positions') ?? '{}');
}

function panelPos(instance: string): { x: number; y: number } {
  const el = screen.getByTestId(`module-${instance}`);
  return { x: parseInt(el.style.left, 10), y: parseInt(el.style.top, 10) };
}

async function renderApp(instances: string[]) {
  state.nodes = instances.map(node);
  render(<App />);
  for (const i of instances) {
    await waitFor(() => expect(screen.getByTestId(`module-${i}`)).toBeTruthy());
  }
}

/** mousedown on a module header at a fixed pointer origin. */
function grab(instance: string, at = { x: 500, y: 500 }) {
  fireEvent.mouseDown(screen.getByTestId(`module-header-${instance}`), {
    button: 0,
    clientX: at.x,
    clientY: at.y,
  });
  return at;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  state.nodes = [];
});

describe('nearestFreeSpot', () => {
  const SIZE = { w: 192, h: 96 };

  it('returns the wanted spot itself when free', () => {
    expect(nearestFreeSpot({ x: 96, y: 48 }, SIZE, [])).toEqual({ x: 96, y: 48 });
  });

  it('picks the nearest free grid cell when the spot is occupied', () => {
    const others = [{ x: 0, y: 0, w: 192, h: 96 }];
    // (96, 48) collides; one cell down (96, 96) is the closest free spot.
    expect(nearestFreeSpot({ x: 96, y: 48 }, SIZE, others)).toEqual({ x: 96, y: 96 });
  });

  it('never returns a far-away spot; negative coordinates are fair game', () => {
    // Blocked near the origin: the search walks outward ring by ring and
    // lands just past the blockers, not rows away. The canvas is infinite,
    // so a spot above the origin (negative y) is a legal nearest answer.
    const others = [
      { x: 0, y: 0, w: 192, h: 96 },
      { x: 192, y: 0, w: 192, h: 96 },
    ];
    const spot = nearestFreeSpot({ x: 48, y: 0 }, SIZE, others)!;
    expect(Math.abs(spot.x - 48) + Math.abs(spot.y - 0)).toBeLessThanOrEqual(96 + 48);
    expect(others.some((r) => rectsOverlap({ ...spot, ...SIZE }, r))).toBe(false);
  });
});

describe('spotInView (module picker placement)', () => {
  const SIZE = { w: 192, h: 96 };
  // A viewport scrolled away from the rack origin, as after a pan.
  const VIEW = { x: 1000, y: 500, w: 960, h: 480 };
  const inside = (p: { x: number; y: number }) =>
    p.x >= VIEW.x &&
    p.y >= VIEW.y &&
    p.x + SIZE.w <= VIEW.x + VIEW.w &&
    p.y + SIZE.h <= VIEW.y + VIEW.h;

  it('lands on the cursor, grid-snapped, when the spot is free', () => {
    expect(spotInView({ x: 1300, y: 700 }, SIZE, [], VIEW)).toEqual({ x: 1296, y: 720 });
  });

  it('pulls a cursor outside the view back inside it', () => {
    // Picked with the pointer parked over the header, way above the rack.
    const spot = spotInView({ x: 1200, y: -4000 }, SIZE, [], VIEW);
    expect(inside(spot)).toBe(true);
    expect(spot.y).toBe(528); // first grid row fully inside the view
  });

  it('keeps the whole footprint inside the view at the far edge', () => {
    const spot = spotInView({ x: VIEW.x + VIEW.w, y: VIEW.y + VIEW.h }, SIZE, [], VIEW);
    expect(inside(spot)).toBe(true);
  });

  it('steps aside from an occupied spot without leaving the view', () => {
    const others = [{ x: 1248, y: 672, w: 288, h: 192 }];
    const spot = spotInView({ x: 1300, y: 700 }, SIZE, others, VIEW);
    expect(rectsOverlap({ ...spot, ...SIZE }, others[0])).toBe(false);
    expect(inside(spot)).toBe(true);
    // Nearby, not across the canvas: one grid step off the blocker's edge.
    expect(Math.abs(spot.x - 1296) + Math.abs(spot.y - 720)).toBeLessThanOrEqual(288);
  });

  it('crosses a wall of modules to the free area on the other side', () => {
    // Everything left of x=1600 in the view is taken: the module lands in
    // the free strip on the right rather than off screen.
    const others = [{ x: 900, y: 400, w: 700, h: 700 }];
    const spot = spotInView({ x: 1100, y: 700 }, SIZE, others, VIEW);
    expect(rectsOverlap({ ...spot, ...SIZE }, others[0])).toBe(false);
    expect(inside(spot)).toBe(true);
  });

  it('stays visible even when the view is full', () => {
    const others = [{ x: 0, y: 0, w: 10000, h: 10000 }];
    const spot = spotInView({ x: 1300, y: 700 }, SIZE, others, VIEW);
    expect(inside(spot)).toBe(true);
  });

  it('shows the top-left corner of a footprint bigger than the view', () => {
    const huge = { w: 4000, h: 2000 };
    const spot = spotInView({ x: 9999, y: 9999 }, huge, [], VIEW);
    expect(spot).toEqual({ x: 1008, y: 528 });
  });
});

describe('module picker insert placement', () => {
  // jsdom measures nothing, so the rack viewport is given a box by hand —
  // without one the placement has no view to keep the module inside.
  function viewport(width: number, height: number) {
    const el = screen.getByTestId('rack-area');
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, width, height }) as DOMRect;
  }

  async function pickOscillator() {
    fireEvent.keyDown(window, { key: 'm', metaKey: true });
    fireEvent.click(await screen.findByTestId('library-add-com.dj.oscillator'));
    await waitFor(() => expect(savedPositions().oscillat1).toBeTruthy());
    return savedPositions().oscillat1;
  }

  it('lands the module at the cursor, not at the rack origin', async () => {
    // Panned far from the origin: what is on screen is the rack around
    // (1000, 500), so a placement that ignores the pan is off screen.
    localStorage.setItem('dj-rack-pan', JSON.stringify({ x: -1000, y: -500 }));
    await renderApp([]);
    viewport(800, 600);
    // Deliberately NOT the middle of the view, which is where an insert
    // used to land however far the cursor was from it.
    fireEvent.mouseMove(window, { clientX: 200, clientY: 120 });
    expect(await pickOscillator()).toEqual({ x: 1200, y: 624 });
  });

  it('pulls a cursor that is off the rack back into the viewport', async () => {
    localStorage.setItem('dj-rack-pan', JSON.stringify({ x: -1000, y: -500 }));
    await renderApp([]);
    viewport(800, 600);
    // Picked with the pointer up in the header, above the rack entirely.
    fireEvent.mouseMove(window, { clientX: 400, clientY: -200 });
    const pos = await pickOscillator();
    expect(pos.y).toBeGreaterThanOrEqual(500);
    expect(pos.y + 96).toBeLessThanOrEqual(1100);
  });

  it('steps aside from the module already under the cursor', async () => {
    localStorage.setItem('dj-rack-pan', JSON.stringify({ x: -1000, y: -500 }));
    setPositions({ a: { x: 1200, y: 624 } });
    await renderApp(['a']);
    viewport(800, 600);
    fireEvent.mouseMove(window, { clientX: 200, clientY: 120 });
    const pos = await pickOscillator();
    expect(rectsOverlap({ ...pos, w: 192, h: 96 }, { x: 1200, y: 624, w: 192, h: 96 })).toBe(false);
    // Still on screen, and still next to where the cursor was.
    expect(pos.x).toBeGreaterThanOrEqual(1000);
    expect(pos.y).toBeGreaterThanOrEqual(500);
    expect(Math.abs(pos.x - 1200) + Math.abs(pos.y - 624)).toBeLessThanOrEqual(192);
  });
});

describe('module drag at zoom levels', () => {
  it('divides pointer deltas by the zoom so panels track the cursor 1:1', async () => {
    localStorage.setItem('dj-rack-zoom', '0.5');
    setPositions({ a: { x: 0, y: 0 } });
    await renderApp(['a']);
    const at = grab('a');
    // 48px/24px of screen travel at zoom 0.5 is 96px/48px of rack travel.
    fireEvent.mouseMove(window, { clientX: at.x + 48, clientY: at.y + 24 });
    expect(panelPos('a')).toEqual({ x: 96, y: 48 });
    fireEvent.mouseUp(window);
    expect(savedPositions().a).toEqual({ x: 96, y: 48 });
  });
});

describe('co-operative bump', () => {
  // Row layout (192×96 fallback panels): a | b | c packed tight, so a
  // dragged right past b has no room on b's far side.
  const ROW = { a: { x: 0, y: 0 }, b: { x: 192, y: 0 }, c: { x: 384, y: 0 } };

  it('(a) dragging past a neighbour with no room behind bumps it minimally', async () => {
    setPositions(ROW);
    await renderApp(['a', 'b', 'c']);
    const at = grab('a');
    // 240px right: a's center crosses b's center, but a cannot fit
    // between b and c — b gives way to its left (minimum displacement).
    fireEvent.mouseMove(window, { clientX: at.x + 240, clientY: at.y });
    expect(panelPos('a')).toEqual({ x: 192, y: 0 });
    expect(panelPos('b')).toEqual({ x: 0, y: 0 });
    expect(panelPos('c')).toEqual({ x: 384, y: 0 });
  });

  it('(b) dragging on to a free spot reverts the provisional bump', async () => {
    setPositions(ROW);
    await renderApp(['a', 'b', 'c']);
    const at = grab('a');
    fireEvent.mouseMove(window, { clientX: at.x + 240, clientY: at.y });
    expect(panelPos('b')).toEqual({ x: 0, y: 0 }); // bumped
    // Keep dragging a to open space below the row: b springs back.
    fireEvent.mouseMove(window, { clientX: at.x + 480, clientY: at.y + 240 });
    expect(panelPos('a')).toEqual({ x: 480, y: 240 });
    expect(panelPos('b')).toEqual({ x: 192, y: 0 });
  });

  it('(c) releasing in the bumped-open slot makes both positions permanent', async () => {
    setPositions(ROW);
    await renderApp(['a', 'b', 'c']);
    const at = grab('a');
    fireEvent.mouseMove(window, { clientX: at.x + 240, clientY: at.y });
    fireEvent.mouseUp(window);
    expect(savedPositions().a).toEqual({ x: 192, y: 0 });
    expect(savedPositions().b).toEqual({ x: 0, y: 0 });
    // A later drag of a elsewhere must NOT revert b's committed position.
    const at2 = grab('a');
    fireEvent.mouseMove(window, { clientX: at2.x + 240, clientY: at2.y + 240 });
    fireEvent.mouseUp(window);
    expect(savedPositions().a).toEqual({ x: 432, y: 240 });
    expect(savedPositions().b).toEqual({ x: 0, y: 0 });
  });

  it('(d) bump impossible (would displace a third module): neighbours hold', async () => {
    // Row 0: d | b | c | e packed tight; row 1: a | f | g. Dragging a
    // up-right past b cannot bump b left (d is there) and every in-row
    // push-out spot is taken — no neighbour moves. On the infinite canvas
    // the dragged panel itself escapes to the free space above the row
    // instead of staying pinned.
    setPositions({
      d: { x: 192, y: 0 },
      b: { x: 384, y: 0 },
      c: { x: 576, y: 0 },
      e: { x: 768, y: 0 },
      a: { x: 192, y: 96 },
      f: { x: 384, y: 96 },
      g: { x: 576, y: 96 },
    });
    await renderApp(['d', 'b', 'c', 'e', 'a', 'f', 'g']);
    const at = grab('a');
    fireEvent.mouseMove(window, { clientX: at.x + 240, clientY: at.y - 96 });
    expect(panelPos('a')).toEqual({ x: 432, y: -96 });
    expect(panelPos('b')).toEqual({ x: 384, y: 0 });
    expect(panelPos('d')).toEqual({ x: 192, y: 0 });
  });

  it('keeps the blocked-until-committed feel short of the midpoint', async () => {
    setPositions(ROW);
    await renderApp(['a', 'b', 'c']);
    const at = grab('a');
    // 96px right: overlaps b but a's center has not crossed b's center —
    // a stops against its neighbour, no bump.
    fireEvent.mouseMove(window, { clientX: at.x + 96, clientY: at.y });
    expect(panelPos('a')).toEqual({ x: 0, y: 0 });
    expect(panelPos('b')).toEqual({ x: 192, y: 0 });
  });
});
