// The Decks page against a mock bank: what a strip says about its clip,
// what the controls send, and what the page does when there is no bank
// (or no clips) yet.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DecksView } from '../src/components/DecksView';
import {
  alignLabel,
  stretchLabel,
  type DecksApi,
  type DecksStatus,
  type DeckSlotStatus,
} from '../src/decks';
import type { BeatClipApi, BeatClipEntry } from '../src/beatClip';

function emptySlot(slot: number): DeckSlotStatus {
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
    solo: false,
    align_beats: 1,
    aligned: true,
    duration_secs: 0,
    position_secs: 0,
    beat: -1,
    playing: false,
  };
}

function loadedSlot(slot: number, over: Partial<DeckSlotStatus> = {}): DeckSlotStatus {
  return {
    ...emptySlot(slot),
    clip: { project: 'p1', clip: `c${slot}`, name: `clip ${slot}`, stems: ['drums'] },
    loaded: true,
    beats: 8,
    source_bpm: 120,
    stretch: 128 / 120,
    beat: 2,
    playing: true,
    mute: false,
    ...over,
  };
}

function makeStatus(over: Partial<DecksStatus> = {}): DecksStatus {
  return {
    bpm: 128,
    beat: 4.25,
    cycle_beats: 8,
    surface: true,
    surface_connected: true,
    slots: Array.from({ length: 8 }, (_, i) => emptySlot(i)),
    ...over,
  };
}

function makeApi(status: DecksStatus, over: Partial<DecksApi> = {}): DecksApi {
  return {
    banks: vi.fn().mockResolvedValue(['decks1']),
    ensure: vi.fn().mockResolvedValue('decks1'),
    status: vi.fn().mockResolvedValue(status),
    load: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue(null),
    setControl: vi.fn().mockResolvedValue(null),
    setTail: vi.fn().mockResolvedValue(null),
    setPhase: vi.fn().mockResolvedValue(null),
    setBpm: vi.fn().mockResolvedValue(null),
    setSurface: vi.fn().mockResolvedValue(null),
    reset: vi.fn().mockResolvedValue(null),
    endEdit: vi.fn().mockResolvedValue(null),
    ...over,
  };
}

const CLIPS: BeatClipEntry[] = [
  {
    projectId: 'p1',
    clipId: 'c1',
    name: 'intro loop',
    projectName: 'set one',
    beats: 8,
    bpm: 120,
    stems: ['drums', 'bass'],
  },
  {
    projectId: 'p1',
    clipId: 'c2',
    name: 'hat stab',
    projectName: 'set one',
    beats: 2,
    bpm: 120,
    stems: [],
  },
];

function makeClips(entries = CLIPS): BeatClipApi {
  return {
    list: vi.fn().mockResolvedValue(entries),
    load: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue(null),
  };
}

const NO_POLL = 100000;

function show(api: DecksApi, clips: BeatClipApi = makeClips()) {
  return render(<DecksView api={api} clips={clips} pollMs={NO_POLL} />);
}

describe('DecksView', () => {
  it('offers to make the bank when the patch has none, instead of showing eight dead strips', async () => {
    const ensure = vi.fn().mockResolvedValue('decks1');
    const api = makeApi(makeStatus(), {
      banks: vi.fn().mockResolvedValue([]),
      ensure,
    });
    show(api);
    await waitFor(() => expect(screen.getByTestId('decks-empty')).toBeTruthy());
    expect(screen.queryByTestId('decks-strips')).toBeNull();

    fireEvent.click(screen.getByTestId('decks-add-bank'));
    await waitFor(() => expect(screen.getByTestId('decks-strips')).toBeTruthy());
    await waitFor(() => expect(ensure).toHaveBeenCalled());
  });

  it('draws eight decks, loaded or not', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[0] = loadedSlot(0);
    show(makeApi(makeStatus({ slots })));
    await waitFor(() => expect(screen.getByTestId('decks-strips').children.length).toBe(8));
    expect(screen.getByTestId('decks-name-0').textContent).toBe('clip 0');
    expect(screen.getByTestId('decks-name-3').textContent).toBe('empty');
  });

  it('a strip reports the clip against the bank: beats, its own tempo and the stretch', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[0] = loadedSlot(0, { tail: 2 });
    show(makeApi(makeStatus({ slots })));
    await waitFor(() => expect(screen.getByTestId('decks-beats-0').textContent).toBe('8 + 2'));
    expect(screen.getByTestId('decks-source-bpm-0').textContent).toBe('120.0');
    expect(screen.getByTestId('decks-stretch-0').textContent).toBe('+6.7%');
    // Ten dots: the clip's eight beats and the two of silence after them,
    // with the playing beat lit.
    const dots = [...screen.getByTestId('decks-dots-0').children];
    expect(dots.length).toBe(10);
    expect(dots.filter((d) => d.className.includes('on')).length).toBe(1);
    expect(dots[2].className).toContain('on');
    expect(dots[8].className).toContain('decks-beat-tail');
  });

  it('says how a clip locks to the bank, and says when it does not', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[0] = loadedSlot(0, { beats: 8, align_beats: 1, aligned: false });
    slots[1] = loadedSlot(1, { beats: 6, align_beats: 2, aligned: true });
    show(makeApi(makeStatus({ slots })));
    await waitFor(() =>
      expect(screen.getByTestId('decks-align-1').textContent).toBe('locks every 2 beats'),
    );
    expect(screen.getByTestId('decks-align-0').textContent).toContain('shares no beat');
    expect(screen.getByTestId('decks-align-0').className).toContain('decks-slot-adrift');
    // A slot with nothing to lock to says nothing at all.
    expect(screen.queryByTestId('decks-align-4')).toBeNull();
  });

  it('the level fader, the tone knobs and mute/solo all write the slot', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[2] = loadedSlot(2);
    const api = makeApi(makeStatus({ slots }));
    show(api);
    await waitFor(() => expect(screen.getByTestId('decks-mute-2')).toBeTruthy());

    fireEvent.click(screen.getByTestId('decks-mute-2'));
    await waitFor(() => expect(api.setControl).toHaveBeenCalledWith('decks1', 2, 'mute', 1));
    fireEvent.click(screen.getByTestId('decks-solo-2'));
    await waitFor(() => expect(api.setControl).toHaveBeenCalledWith('decks1', 2, 'solo', 1));

    // The three tone controls are the rack's own knobs, one per band.
    expect(screen.getByTestId('knob-3 HIGH')).toBeTruthy();
    expect(screen.getByTestId('knob-3 MID')).toBeTruthy();
    expect(screen.getByTestId('knob-3 LOW')).toBeTruthy();
    expect(screen.getByTestId('knob-3 LEVEL')).toBeTruthy();
  });

  it('a mute the user just pressed stays pressed until the engine agrees', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[0] = loadedSlot(0, { mute: false });
    // The bank keeps reporting the OLD value: a poll landing mid-gesture
    // must not flick the button back.
    const api = makeApi(makeStatus({ slots }));
    show(api);
    await waitFor(() => expect(screen.getByTestId('decks-mute-0')).toBeTruthy());
    expect(screen.getByTestId('decks-mute-0').getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByTestId('decks-mute-0'));
    await waitFor(() =>
      expect(screen.getByTestId('decks-mute-0').getAttribute('aria-pressed')).toBe('true'),
    );
  });

  it('silence and shift move a beat at a time, and cannot go below no silence at all', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[1] = loadedSlot(1, { tail: 1, phase: 2 });
    const api = makeApi(makeStatus({ slots }));
    show(api);
    await waitFor(() => expect(screen.getByTestId('decks-tail-1')).toBeTruthy());

    const tail = within(screen.getByTestId('decks-tail-1'));
    fireEvent.click(tail.getByLabelText('One more beat of silence after deck 2'));
    await waitFor(() => expect(api.setTail).toHaveBeenCalledWith('decks1', 1, 2));
    fireEvent.click(tail.getByLabelText('One beat less silence after deck 2'));
    await waitFor(() => expect(api.setTail).toHaveBeenCalledWith('decks1', 1, 0));

    const phase = within(screen.getByTestId('decks-phase-1'));
    fireEvent.click(phase.getByLabelText('Shift deck 2 on one beat'));
    await waitFor(() => expect(api.setPhase).toHaveBeenCalledWith('decks1', 1, 3));
    fireEvent.click(phase.getByLabelText('Shift deck 2 back one beat'));
    await waitFor(() => expect(api.setPhase).toHaveBeenCalledWith('decks1', 1, 1));

    // An empty deck has nothing to shift.
    const empty = within(screen.getByTestId('decks-phase-4'));
    expect(empty.getByLabelText('Shift deck 5 on one beat').hasAttribute('disabled')).toBe(true);
  });

  it('the tempo drives the whole bank, and the drag ends as one edit', async () => {
    const api = makeApi(makeStatus());
    show(api);
    const bpm = await screen.findByTestId<HTMLInputElement>('decks-bpm');
    await waitFor(() => expect(bpm.value).toBe('128'));

    fireEvent.change(bpm, { target: { value: '140' } });
    await waitFor(() => expect(api.setBpm).toHaveBeenCalledWith('decks1', 140));
    fireEvent.blur(bpm);
    await waitFor(() => expect(api.endEdit).toHaveBeenCalled());

    // Out-of-range typing is clamped rather than sent to the engine raw.
    fireEvent.change(bpm, { target: { value: '900' } });
    await waitFor(() => expect(api.setBpm).toHaveBeenCalledWith('decks1', 300));
  });

  it('loading a clip picks it by name and puts it in the deck that asked', async () => {
    const api = makeApi(makeStatus());
    show(api);
    await waitFor(() => expect(screen.getByTestId('decks-name-5')).toBeTruthy());
    fireEvent.click(screen.getByTestId('decks-name-5'));

    const dialog = await screen.findByTestId('decks-clip-picker');
    expect(within(dialog).getByTestId('decks-clip-p1-c1')).toBeTruthy();
    fireEvent.change(screen.getByTestId('decks-clip-search'), { target: { value: 'hat' } });
    expect(within(dialog).queryByTestId('decks-clip-p1-c1')).toBeNull();
    fireEvent.click(within(dialog).getByTestId('decks-clip-p1-c2'));

    await waitFor(() => expect(api.load).toHaveBeenCalledWith('decks1', 5, 'p1', 'c2'));
    await waitFor(() => expect(screen.queryByTestId('decks-clip-picker')).toBeNull());
  });

  it('with no clips cut yet the picker says where clips come from', async () => {
    show(makeApi(makeStatus()), makeClips([]));
    await waitFor(() => expect(screen.getByTestId('decks-name-0')).toBeTruthy());
    fireEvent.click(screen.getByTestId('decks-name-0'));
    const empty = await screen.findByTestId('decks-no-clips');
    expect(empty.textContent).toContain('Beatify');
  });

  it('a deck says what its clip is made of, here and in the picker', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[0] = loadedSlot(0);
    show(makeApi(makeStatus({ slots })));
    await waitFor(() => expect(screen.getByTestId('decks-stems-0-drums')).toBeTruthy());
    // Nothing known, nothing shown — an empty deck holds no clip.
    expect(screen.queryByTestId('decks-stems-3')).toBeNull();

    fireEvent.click(screen.getByTestId('decks-name-3'));
    const dialog = await screen.findByTestId('decks-clip-picker');
    expect(within(dialog).getByTestId('decks-clip-stems-p1-c1-bass')).toBeTruthy();
  });

  it('ejecting a deck clears it', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[3] = loadedSlot(3);
    const api = makeApi(makeStatus({ slots }));
    show(api);
    await waitFor(() => expect(screen.getByTestId('decks-eject-3')).toBeTruthy());
    fireEvent.click(screen.getByTestId('decks-eject-3'));
    await waitFor(() => expect(api.clear).toHaveBeenCalledWith('decks1', 3));
    // An empty deck has nothing to eject.
    expect(screen.queryByTestId('decks-eject-4')).toBeNull();
  });

  it('shows whether the Launch Control XL is driving the bank, and can stop it', async () => {
    const api = makeApi(makeStatus({ surface: true, surface_connected: false }));
    show(api);
    await waitFor(() =>
      expect(screen.getByTestId('decks-surface').getAttribute('data-state')).toBe('waiting'),
    );
    expect(screen.getByTestId('decks-surface').textContent).toContain('not found');

    fireEvent.click(screen.getByTestId('decks-surface-toggle'));
    await waitFor(() => expect(api.setSurface).toHaveBeenCalledWith('decks1', false));
  });

  it('says when the bank comes round, and restarts it on demand', async () => {
    const api = makeApi(makeStatus({ cycle_beats: 24, beat: 5.5 }));
    show(api);
    await waitFor(() => expect(screen.getByTestId('decks-cycle').textContent).toContain('24'));
    expect(screen.getByTestId('decks-beat').textContent).toBe('beat 6');
    fireEvent.click(screen.getByTestId('decks-restart'));
    await waitFor(() => expect(api.reset).toHaveBeenCalledWith('decks1'));
  });

  it('a bound deck whose clip cannot be assembled says so rather than looking loaded', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[0] = loadedSlot(0, { loaded: false });
    show(makeApi(makeStatus({ slots })));
    await waitFor(() => expect(screen.getByTestId('decks-missing-0')).toBeTruthy());
  });

  it('polls only while the tab is the one on screen', async () => {
    const api = makeApi(makeStatus());
    render(<DecksView api={api} clips={makeClips()} active={false} pollMs={1} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.status).not.toHaveBeenCalled();
  });
});

describe('decks readouts', () => {
  it('reads a stretch the way a pitch fader reads', () => {
    expect(stretchLabel(1)).toBe('±0.0%');
    expect(stretchLabel(128 / 120)).toBe('+6.7%');
    expect(stretchLabel(0.94)).toBe('−6.0%');
  });

  it('has nothing to say about alignment until there is something to align with', () => {
    const slot = { ...loadedSlot(0), align_beats: 4, aligned: true };
    expect(alignLabel(slot, 1)).toBeNull();
    expect(alignLabel(slot, 2)).toBe('locks every 4 beats');
    expect(alignLabel({ ...slot, align_beats: 1 }, 2)).toBe('locks every beat');
    expect(alignLabel({ ...emptySlot(0) }, 3)).toBeNull();
  });
});
