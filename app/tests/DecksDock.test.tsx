// The strip dock: the decks band is the user's to size and to shut, and
// the canvas above it takes back every pixel it gives up. Three things
// are pinned here — the affordances (a label that collapses, a handle
// that drags, clamped), that both survive a remount through localStorage
// (the same place the rack's zoom and pan live), and that the chrome
// cables are RE-MEASURED as the dock moves: a wire whose chrome end slid
// with the strips must follow it, and a strip that left the DOM must not
// leave a cable hanging where it used to be.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DecksView,
  DOCK_COLLAPSED_KEY,
  DOCK_DEFAULT_HEIGHT,
  DOCK_HEIGHT_KEY,
  DOCK_MIN_HEIGHT,
  dockMaxHeight,
} from '../src/components/DecksView';
import type { DecksApi, DecksStatus, DeckSlotStatus } from '../src/decks';
import type { BeatClipApi } from '../src/beatClip';

// jsdom has no PointerEvent; without this, fireEvent.pointerDown drops
// clientY (it comes out NaN in the handler).
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

function slotFixture(slot: number): DeckSlotStatus {
  return {
    slot,
    clip: null,
    loaded: slot === 0,
    beats: 0,
    ones: [],
    lead_one: null,
    tail: 0,
    phase: 0,
    source_bpm: 120,
    ratio: 1,
    stretch: 1,
    level: 0.8,
    low: 1,
    mid: 1,
    high: 1,
    mute: true,
    monitor: false,
    wet: 1,
    insert_monitor: false,
    insert: false,
    tone_patched: [false, false, false],
    duration_secs: 0,
    position_secs: 0,
    beat: -1,
    sounding: false,
    playing: false,
    output_level: 0,
    arm: 'none',
    live_level: 1,
    live_mute: true,
    live_phase: 0,
    live_lead_one: null,
  };
}

const STATUS: DecksStatus = {
  bpm: 128,
  running: true,
  beat: 0,
  cycle_beats: 0,
  surface: false,
  surface_connected: false,
  master_live: 1,
  master_monitor: 1,
  v2: false,
  transition: 'none',
  transition_done: false,
  xfade: 0,
  slots: Array.from({ length: 8 }, (_, i) => slotFixture(i)),
};

function makeApi(): DecksApi {
  return {
    banks: vi.fn().mockResolvedValue(['decks1']),
    ensure: vi.fn().mockResolvedValue('decks1'),
    status: vi.fn().mockResolvedValue(STATUS),
    load: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue(null),
    setControl: vi.fn().mockResolvedValue(null),
    setMaster: vi.fn().mockResolvedValue(null),
    arm: vi.fn().mockResolvedValue(null),
    setTail: vi.fn().mockResolvedValue(null),
    setPhase: vi.fn().mockResolvedValue(null),
    setRatio: vi.fn().mockResolvedValue(null),
    setBpm: vi.fn().mockResolvedValue(null),
    setSurface: vi.fn().mockResolvedValue(null),
    setRunning: vi.fn().mockResolvedValue(null),
    rehydrate: vi.fn().mockResolvedValue(0),
    endEdit: vi.fn().mockResolvedValue(null),
  };
}

const clipsApi: BeatClipApi = {
  list: vi.fn().mockResolvedValue([]),
  load: vi.fn().mockResolvedValue(null),
  status: vi.fn().mockResolvedValue(null),
  delete: vi.fn().mockResolvedValue([]),
  audio: vi.fn().mockResolvedValue(null),
};

function fakeRect(x: number, y: number, w = 18, h = 18): DOMRect {
  return {
    left: x,
    top: y,
    width: w,
    height: h,
    right: x + w,
    bottom: y + h,
    x,
    y,
    toJSON: () => ({}),
  } as DOMRect;
}

// The app-body stand-in the chrome overlay measures against, with a
// non-zero origin so endpoints are proven container-relative.
let body: HTMLDivElement;

/** A fresh app-body stand-in (a render into an unmounted container is a
 *  dead React root, so a remount test needs a new one). */
function freshBody() {
  document.body.innerHTML = '';
  body = document.createElement('div');
  body.getBoundingClientRect = () => fakeRect(40, 60, 800, 600);
  document.body.appendChild(body);
}

beforeEach(() => {
  localStorage.clear();
  freshBody();
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

const WIRE = { from_instance: 'decks1', from_jack: 'd1_out', to_instance: 'vca1', to_jack: 'in' };
const KEY = 'decks1:d1_out->vca1:in';

function show(overrides: Partial<Parameters<typeof DecksView>[0]> = {}) {
  return render(
    <DecksView
      api={makeApi()}
      clips={clipsApi}
      pollMs={100000}
      wires={[WIRE]}
      overlayContainer={body}
      overlayLayoutKey="pan:0,0 zoom:1"
      {...overrides}
    />,
    { container: body },
  );
}

/** Give a chrome jack a screen rect (jsdom has no layout). */
function mockChromeJack(key: string, x: number, y: number): HTMLElement {
  const el = body.querySelector(`[data-jack="${key}"]`) as HTMLElement;
  expect(el).toBeTruthy();
  el.getBoundingClientRect = () => fakeRect(x, y);
  return el;
}

function addModuleSocket(key: string, x: number, y: number): HTMLElement {
  const el = document.createElement('span');
  el.setAttribute('data-jack', key);
  el.getBoundingClientRect = () => fakeRect(x, y);
  body.appendChild(el);
  return el;
}

/** Grab the handle at `from` and drag it to `to` (screen Y, upward is a
 *  taller dock), releasing unless told to keep holding. */
function dragGrip(from: number, to: number, release = true) {
  const grip = screen.getByTestId('decks-dock-grip');
  // One fireEvent per act: the window listeners are attached by the
  // effect the press schedules, so the move has to be a later turn.
  fireEvent.pointerDown(grip, { button: 0, clientY: from });
  fireEvent.pointerMove(window, { clientY: to });
  if (release) fireEvent.pointerUp(window, { clientY: to });
}

function dockHeight(): number {
  return Number.parseInt(screen.getByTestId('decks-dock').style.height, 10);
}

describe('the decks dock collapses', () => {
  it('shuts the strips away behind a bar that says how to get them back', async () => {
    show();
    await screen.findByTestId('decks-io-0');
    const toggle = screen.getByTestId('decks-dock-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggle);
    expect(screen.queryByTestId('decks-strips')).toBeNull();
    expect(screen.getByTestId('decks-dock').dataset.collapsed).toBe('true');
    // Collapsed, the bar is still the switch — and says what is loaded.
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('decks-dock-summary').textContent).toBe('1 of 8 loaded');
    // The dock claims no height of its own: the canvas gets the band.
    expect(screen.getByTestId('decks-dock').style.height).toBe('');

    fireEvent.click(toggle);
    expect(await screen.findByTestId('decks-strips')).toBeTruthy();
    expect(dockHeight()).toBe(DOCK_DEFAULT_HEIGHT);
  });

  it('remembers being shut, and being reopened', async () => {
    const first = show();
    await screen.findByTestId('decks-strips');
    fireEvent.click(screen.getByTestId('decks-dock-toggle'));
    expect(localStorage.getItem(DOCK_COLLAPSED_KEY)).toBe('true');
    first.unmount();
    freshBody();

    show();
    await screen.findByTestId('decks-dock-toggle');
    expect(screen.queryByTestId('decks-strips')).toBeNull();
    fireEvent.click(screen.getByTestId('decks-dock-toggle'));
    expect(localStorage.getItem(DOCK_COLLAPSED_KEY)).toBe('false');
  });
});

describe('the decks dock resizes', () => {
  it('follows the handle, and clamps at both ends', async () => {
    show();
    await screen.findByTestId('decks-strips');
    expect(dockHeight()).toBe(DOCK_DEFAULT_HEIGHT);

    // Dragging the handle UP (smaller Y) makes the band taller.
    dragGrip(500, 420);
    expect(dockHeight()).toBe(DOCK_DEFAULT_HEIGHT + 80);

    // Down past the floor: the strips keep a usable minimum.
    dragGrip(500, 5000);
    expect(dockHeight()).toBe(DOCK_MIN_HEIGHT);

    // Up past the ceiling: the canvas is never squeezed out.
    dragGrip(500, -5000);
    expect(dockHeight()).toBe(dockMaxHeight(window.innerHeight));
  });

  it('remembers the height it was let go at', async () => {
    const first = show();
    await screen.findByTestId('decks-strips');
    dragGrip(500, 460);
    expect(localStorage.getItem(DOCK_HEIGHT_KEY)).toBe(String(DOCK_DEFAULT_HEIGHT + 40));
    first.unmount();
    freshBody();

    show();
    await screen.findByTestId('decks-strips');
    expect(dockHeight()).toBe(DOCK_DEFAULT_HEIGHT + 40);
  });

  it('takes arrow keys on the focused handle', async () => {
    show();
    await screen.findByTestId('decks-strips');
    const grip = screen.getByTestId('decks-dock-grip');
    fireEvent.keyDown(grip, { key: 'ArrowUp' });
    expect(dockHeight()).toBe(DOCK_DEFAULT_HEIGHT + 24);
    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    expect(dockHeight()).toBe(DOCK_DEFAULT_HEIGHT);
    expect(grip.getAttribute('aria-valuenow')).toBe(String(DOCK_DEFAULT_HEIGHT));
    expect(localStorage.getItem(DOCK_HEIGHT_KEY)).toBe(String(DOCK_DEFAULT_HEIGHT));
  });
});

describe('the chrome cables through a resize', () => {
  it('re-measures the chrome end as the handle is dragged, not only when it is let go', async () => {
    show();
    await screen.findByTestId('decks-io-0');
    const send = mockChromeJack('decks1:output:d1_out', 120, 500);
    addModuleSocket('vca1:input:in', 600, 200);
    // Container origin is (40, 60), socket centers add half of 18.
    await waitFor(() => {
      expect(screen.getByTestId(`cable-${KEY}`).getAttribute('y1')).toBe('449');
    });

    // A taller dock pushes the strips (and their jacks) up the screen.
    // Mid-drag — the pointer is still down — the cable must already be
    // where the jack now is: nothing about the dock's height reaches the
    // overlay through the DOM (an inline style on `.decks-chrome` is
    // filtered out on purpose), so this is the layout key doing its job.
    send.getBoundingClientRect = () => fakeRect(120, 420);
    dragGrip(500, 420, false);
    await waitFor(() => {
      const line = screen.getByTestId(`cable-${KEY}`);
      expect(line.getAttribute('y1')).toBe('369'); // 420 + 9 - 60
      expect(line.getAttribute('x1')).toBe('89');
      // The module end never moved.
      expect(line.getAttribute('y2')).toBe('149');
    });
    act(() => {
      fireEvent.pointerUp(window, { clientY: 420 });
    });
    expect(screen.getByTestId(`cable-${KEY}`).getAttribute('y1')).toBe('369');
  });

  it('drops a strip cable when the strips go away, and keeps the top bar clock wired', async () => {
    show({
      wires: [
        WIRE,
        { from_instance: 'decks1', from_jack: 'clock', to_instance: 'lfo1', to_jack: 'sync' },
      ],
    });
    await screen.findByTestId('decks-io-0');
    mockChromeJack('decks1:output:d1_out', 120, 500);
    mockChromeJack('decks1:output:clock', 200, 80);
    addModuleSocket('vca1:input:in', 600, 200);
    addModuleSocket('lfo1:input:sync', 400, 240);
    await waitFor(() => expect(screen.getByTestId(`cable-${KEY}`)).toBeTruthy());

    // Collapsed, deck 1's send jack is not on screen at all, so its cable
    // resolves nowhere and is not drawn — like any bank jack with no
    // chrome socket. The clock lives in the top bar and stays.
    fireEvent.click(screen.getByTestId('decks-dock-toggle'));
    await waitFor(() => expect(screen.queryByTestId(`cable-${KEY}`)).toBeNull());
    expect(screen.getByTestId('cable-decks1:clock->lfo1:sync').getAttribute('y1')).toBe('29');

    // Reopening brings the strip cable back.
    fireEvent.click(screen.getByTestId('decks-dock-toggle'));
    await screen.findByTestId('decks-io-0');
    mockChromeJack('decks1:output:d1_out', 120, 500);
    await waitFor(() => expect(screen.getByTestId(`cable-${KEY}`)).toBeTruthy());
  });
});
