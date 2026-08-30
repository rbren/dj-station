// Chrome-to-canvas cable GEOMETRY. The Decks page draws the wires that
// touch the bank with a second WireOverlay in SCREEN coordinates over the
// whole app body (zoom 1): one end sits on a fixed chrome jack (a deck
// strip, the clock in the top bar), the other on a module socket inside
// the pan/zoom-transformed canvas. These tests pin the actual endpoint
// numbers — where a cable is anchored, relative to the overlay's
// container — and that a pan/zoom (overlayLayoutKey change) re-measures
// the MODULE end while the chrome end stays put.

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecksView } from '../src/components/DecksView';
import type { DecksApi, DecksStatus, DeckSlotStatus } from '../src/decks';
import type { BeatClipApi } from '../src/beatClip';

function slotFixture(slot: number): DeckSlotStatus {
  return {
    slot,
    clip: null,
    loaded: false,
    beats: 0,
    tail: 0,
    phase: 0,
    source_bpm: 120,
    stretch: 1,
    level: 0.8,
    low: 1,
    mid: 1,
    high: 1,
    mute: true,
    monitor: false,
    insert: false,
    tone_patched: [false, false, false],
    duration_secs: 0,
    position_secs: 0,
    beat: -1,
    sounding: false,
    playing: false,
    arm: 'none',
  };
}

const STATUS: DecksStatus = {
  bpm: 128,
  beat: 0,
  cycle_beats: 0,
  surface: false,
  surface_connected: false,
  master_live: 1,
  master_monitor: 1,
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
    setBpm: vi.fn().mockResolvedValue(null),
    setSurface: vi.fn().mockResolvedValue(null),
    reset: vi.fn().mockResolvedValue(null),
    rehydrate: vi.fn().mockResolvedValue(0),
    endEdit: vi.fn().mockResolvedValue(null),
  };
}

const clipsApi: BeatClipApi = {
  list: vi.fn().mockResolvedValue([]),
  load: vi.fn().mockResolvedValue(null),
  status: vi.fn().mockResolvedValue(null),
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

// The app-body stand-in: the element the chrome overlay renders over and
// measures against. Its own rect has a non-zero origin so the tests
// prove endpoints are CONTAINER-relative, not window-relative.
let body: HTMLDivElement;

beforeEach(() => {
  document.body.innerHTML = '';
  body = document.createElement('div');
  body.getBoundingClientRect = () => fakeRect(40, 60, 800, 600);
  document.body.appendChild(body);
});

afterEach(() => {
  document.body.innerHTML = '';
});

/** A module jack socket "inside the canvas": in the app it lives in the
 *  transformed .rack, but to the screen-space overlay it is just an
 *  element whose boundingClientRect already includes pan and zoom. */
function addModuleSocket(key: string, x: number, y: number): HTMLElement {
  const el = document.createElement('span');
  el.setAttribute('data-jack', key);
  el.getBoundingClientRect = () => fakeRect(x, y);
  body.appendChild(el);
  return el;
}

function mockChromeJack(key: string, x: number, y: number): HTMLElement {
  const el = body.querySelector(`[data-jack="${key}"]`) as HTMLElement;
  expect(el).toBeTruthy();
  el.getBoundingClientRect = () => fakeRect(x, y);
  return el;
}

const WIRE = { from_instance: 'decks1', from_jack: 'd1_l', to_instance: 'vca1', to_jack: 'in' };
const KEY = 'decks1:d1_l->vca1:in';

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

describe('chrome-to-canvas cables', () => {
  it('anchors one end on the chrome jack and the other on the module, in container coordinates', async () => {
    show();
    await screen.findByTestId('decks-io-0');
    // Deck 1's send jack sits in the bottom chrome at screen (120, 500);
    // the module's input reads at screen (600, 200) (a rect that already
    // includes whatever pan/zoom the canvas has).
    mockChromeJack('decks1:output:d1_l', 120, 500);
    addModuleSocket('vca1:input:in', 600, 200);
    // Socket centers, relative to the container's (40, 60) origin:
    // chrome (120+9-40, 500+9-60) = (89, 449); module (569, 149).
    await waitFor(() => {
      const line = screen.getByTestId(`cable-${KEY}`);
      expect(line.getAttribute('x1')).toBe('89');
      expect(line.getAttribute('y1')).toBe('449');
      expect(line.getAttribute('x2')).toBe('569');
      expect(line.getAttribute('y2')).toBe('149');
    });
  });

  it('a pan/zoom (overlayLayoutKey change) re-measures the module end; the chrome end stays put', async () => {
    const view = show();
    await screen.findByTestId('decks-io-0');
    mockChromeJack('decks1:output:d1_l', 120, 500);
    const module = addModuleSocket('vca1:input:in', 600, 200);
    await waitFor(() => expect(screen.getByTestId(`cable-${KEY}`).getAttribute('x2')).toBe('569'));

    // The canvas pans 100px right and zooms: the module socket now READS
    // at a new screen position while the chrome jack has not moved. The
    // overlay cannot see a CSS transform change (no DOM mutation), so the
    // layout key is what forces the re-measure.
    module.getBoundingClientRect = () => fakeRect(700, 260);
    view.rerender(
      <DecksView
        api={makeApi()}
        clips={clipsApi}
        pollMs={100000}
        wires={[WIRE]}
        overlayContainer={body}
        overlayLayoutKey="pan:100,60 zoom:1.2"
      />,
    );
    await waitFor(() => {
      const line = screen.getByTestId(`cable-${KEY}`);
      expect(line.getAttribute('x2')).toBe('669'); // 700 + 9 - 40
      expect(line.getAttribute('y2')).toBe('209'); // 260 + 9 - 60
      // The chrome end did not move with the canvas.
      expect(line.getAttribute('x1')).toBe('89');
      expect(line.getAttribute('y1')).toBe('449');
    });
  });

  it('a wire to a bank jack with no chrome socket is not drawn here', async () => {
    show({
      wires: [
        WIRE,
        // The tempo input has no chrome socket (the bar drives it with a
        // number and a slider, not a jack) — its cable must not be
        // invented.
        { from_instance: 'lfo1', from_jack: 'out', to_instance: 'decks1', to_jack: 'bpm' },
      ],
    });
    await screen.findByTestId('decks-io-0');
    mockChromeJack('decks1:output:d1_l', 120, 500);
    addModuleSocket('vca1:input:in', 600, 200);
    addModuleSocket('lfo1:output:out', 300, 300);
    await waitFor(() => expect(screen.getByTestId(`cable-${KEY}`)).toBeTruthy());
    expect(screen.queryByTestId('cable-lfo1:out->decks1:bpm')).toBeNull();
  });

  it('the live and monitor pairs are chrome sockets of their own', async () => {
    show({
      wires: [
        { from_instance: 'decks1', from_jack: 'audio_l', to_instance: 'out1', to_jack: 'in_l' },
        { from_instance: 'decks1', from_jack: 'mon_r', to_instance: 'mon1', to_jack: 'in_r' },
      ],
    });
    await screen.findByTestId('decks-outs');
    mockChromeJack('decks1:output:audio_l', 300, 80);
    mockChromeJack('decks1:output:mon_r', 340, 100);
    addModuleSocket('out1:input:in_l', 600, 200);
    addModuleSocket('mon1:input:in_r', 640, 240);
    await waitFor(() => {
      // Container origin (40, 60), socket centers 9px in.
      const live = screen.getByTestId('cable-decks1:audio_l->out1:in_l');
      expect(live.getAttribute('x1')).toBe('269');
      expect(live.getAttribute('y1')).toBe('29');
      expect(live.getAttribute('x2')).toBe('569');
      expect(live.getAttribute('y2')).toBe('149');
      const cue = screen.getByTestId('cable-decks1:mon_r->mon1:in_r');
      expect(cue.getAttribute('x1')).toBe('309');
      expect(cue.getAttribute('y1')).toBe('49');
      expect(cue.getAttribute('x2')).toBe('609');
      expect(cue.getAttribute('y2')).toBe('189');
    });
  });

  it('the armed preview starts at the chrome jack it was armed on', async () => {
    show({ pending: { instance: 'decks1', jack: 'clock', kind: 'output', color: 2 } });
    await screen.findByTestId('decks-clock-jack');
    mockChromeJack('decks1:output:clock', 200, 80);
    // A mutation nudges the overlay to re-measure the pending start.
    addModuleSocket('vca1:input:in', 600, 200);
    await waitFor(() => {
      const preview = screen.getByTestId('pending-cable');
      expect(preview.getAttribute('x1')).toBe('169'); // 200 + 9 - 40
      expect(preview.getAttribute('y1')).toBe('29'); // 80 + 9 - 60
    });
  });
});
