// The Decks page against a mock bank: what a strip says about its clip,
// what the controls send, and what the page does when there is no bank
// (or no clips) yet.

import { readFileSync } from 'node:fs';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DecksView } from '../src/components/DecksView';
import {
  clipParts,
  clipTitle,
  stretchLabel,
  tempoLabel,
  DECK_GLOW_FULL,
  LEVEL_MAX,
  LEVEL_UNITY,
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
  };
}

function loadedSlot(slot: number, over: Partial<DeckSlotStatus> = {}): DeckSlotStatus {
  return {
    ...emptySlot(slot),
    clip: {
      project: 'p1',
      clip: `c${slot}`,
      name: `clip ${slot}`,
      project_name: 'set one',
      stems: ['drums'],
    },
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
    master_live: 1,
    master_monitor: 1,
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
    setMaster: vi.fn().mockResolvedValue(null),
    arm: vi.fn().mockResolvedValue(null),
    setTail: vi.fn().mockResolvedValue(null),
    setPhase: vi.fn().mockResolvedValue(null),
    setBpm: vi.fn().mockResolvedValue(null),
    setSurface: vi.fn().mockResolvedValue(null),
    reset: vi.fn().mockResolvedValue(null),
    rehydrate: vi.fn().mockResolvedValue(0),
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

/** How lit a strip is: the --deck-level the tint is mixed from. */
function deckLevel(slot: number): number {
  const strip = screen.getByTestId(`decks-slot-${slot}`) as HTMLElement;
  return Number(strip.style.getPropertyValue('--deck-level'));
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
    expect(screen.getByTestId('decks-clip-0').textContent).toBe('clip 0');
    expect(screen.getByTestId('decks-name-3').textContent).toBe('empty');
  });

  it('a strip reports the clip against the bank: its own tempo and the stretch, one line', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[0] = loadedSlot(0, { tail: 2 });
    show(makeApi(makeStatus({ slots })));
    // The tempo drops a trailing .0, and the length is the lamp row
    // below rather than a beat count of its own.
    await waitFor(() =>
      expect(screen.getByTestId('decks-tempo-0').textContent).toBe('120 bpm +6.7%'),
    );
    expect(screen.getByTestId('decks-tempo-3').textContent).toBe('—');
    // Ten dots: the clip's eight beats and the two of silence after them,
    // with the playing beat lit.
    const dots = [...screen.getByTestId('decks-dots-0').children];
    expect(dots.length).toBe(10);
    expect(dots.filter((d) => d.className.includes('on')).length).toBe(1);
    expect(dots[2].className).toContain('on');
    expect(dots[8].className).toContain('decks-beat-tail');
  });

  it('draws a lamp for every beat of the loop, however long, silence included', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    // A 32-beat clip with four beats of silence: 36 lamps, and the one
    // the bank is on lit — including when that beat is a SILENT one.
    slots[0] = loadedSlot(0, { beats: 32, tail: 4, beat: 33, sounding: false });
    show(makeApi(makeStatus({ slots })));
    await waitFor(() => expect(screen.getByTestId('decks-dots-0').children.length).toBe(36));
    const dots = [...screen.getByTestId('decks-dots-0').children];
    expect(dots.filter((d) => d.className.includes('on')).length).toBe(1);
    expect(dots[33].className).toContain('on');
    expect(dots[33].className).toContain('decks-beat-tail');
  });

  it('a deck names the Beatify project its clip was cut in, on a line above the clip', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[0] = loadedSlot(0);
    slots[1] = loadedSlot(1, {
      clip: { project: 'p9', clip: 'c9', name: 'stab', project_name: '', stems: [] },
    });
    show(makeApi(makeStatus({ slots })));
    await waitFor(() => expect(screen.getByTestId('decks-project-0').textContent).toBe('set one'));
    expect(screen.getByTestId('decks-clip-0').textContent).toBe('clip 0');
    // A patch saved before clips carried the project name falls back to
    // its id rather than leaving the line blank.
    expect(screen.getByTestId('decks-project-1').textContent).toBe('p9');
    expect(screen.getByTestId('decks-clip-1').textContent).toBe('stab');
    // An empty deck has no project line at all, only the one word.
    expect(screen.queryByTestId('decks-project-4')).toBeNull();
    expect(screen.getByTestId('decks-name-4').textContent).toBe('empty');
  });

  it("the header carries the clip's two names, a line each, and nothing else", async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[0] = loadedSlot(0, {
      clip: {
        project: 'p1',
        clip: 'c1',
        name: 'a very long clip name',
        project_name: 'a very long project name',
        stems: ['drums'],
      },
    });
    show(makeApi(makeStatus({ slots })));
    const name = await screen.findByTestId('decks-name-0');
    const head = name.parentElement!;
    expect(head.className).toContain('decks-slot-head');
    // No deck number, no eject: the name is the whole header.
    expect(head.children.length).toBe(1);
    expect(within(head).queryByTestId('decks-eject-0')).toBeNull();
    // A line each, so each truncates on its own and both stay readable —
    // and no separator is printed between them any more.
    expect(name.children.length).toBe(2);
    expect(name.querySelector('.decks-slot-project')!.textContent).toBe('a very long project name');
    expect(name.querySelector('.decks-slot-clip')!.textContent).toBe('a very long clip name');
    // Truncated on screen, so the whole of it is in the tooltip.
    expect(name.getAttribute('title')).toContain(
      'a very long project name - a very long clip name',
    );
  });

  it('styles.css draws the header as plain text, two lines, both ellipsized', () => {
    // vitest runs with the app directory as cwd (see PanelLayout.test.tsx).
    const css = readFileSync('src/styles.css', 'utf8');
    const rule = (selector: RegExp) => {
      const m = css.match(new RegExp(`${selector.source}\\s*{[^}]*}`));
      if (!m) throw new Error(`missing rule ${selector.source}`);
      return m[0];
    };
    const name = rule(/\.decks-slot-name/);
    // Plain text, not a padded input.
    expect(name).toContain('padding: 0');
    expect(name).toContain('border: 0');
    expect(name).toContain('background: none');
    // A line each, neither of them wrapping and each cut by its own
    // ellipsis rather than one pushing the other out.
    expect(name).toContain('flex-direction: column');
    expect(name).toContain('white-space: nowrap');
    expect(rule(/\.decks-slot-project,\s*\.decks-slot-clip/)).toContain('text-overflow: ellipsis');
    // The stem tags are abbreviated here and held to the one line the
    // eject button shares with them.
    expect(rule(/\.stem-tags-short/)).toContain('flex-wrap: nowrap');
    // The deck number is gone, rule and all.
    expect(css).not.toContain('.decks-slot-number');
    // The eject button is sized like the stem tags it now sits with.
    const tagSize = rule(/\.stem-tag/).match(/font-size: (.*);/)![1];
    expect(rule(/\.decks-slot-eject/)).toContain(`font-size: ${tagSize}`);
    // Both steppers are laid out on the same columns, so their buttons
    // line up down the strip.
    expect(rule(/\.decks-step/)).toContain('grid-template-columns:');
  });

  it('lights a strip with what its deck is putting out, and leaves a silent one black', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[0] = loadedSlot(0, { output_level: DECK_GLOW_FULL });
    slots[1] = loadedSlot(1, { output_level: DECK_GLOW_FULL / 2 });
    // A deck the engine says put out nothing — muted, dropped, or on a
    // silent beat — and one running past the top of the scale.
    slots[2] = loadedSlot(2, { mute: true, playing: false, output_level: 0 });
    slots[3] = loadedSlot(3, { output_level: DECK_GLOW_FULL * 4 });
    show(makeApi(makeStatus({ slots })));
    await waitFor(() => expect(deckLevel(0)).toBe(1));
    expect(deckLevel(1)).toBeCloseTo(0.5, 3);
    // Exactly the strip's own background: no floor under the tint.
    expect(deckLevel(2)).toBe(0);
    // And a loud deck stops at the top rather than swamping the others.
    expect(deckLevel(3)).toBe(1);
    expect(deckLevel(7)).toBe(0);
  });

  it('follows the engine down as a stopped deck fades, instead of snapping to black', async () => {
    const lit = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    lit[0] = loadedSlot(0, { output_level: DECK_GLOW_FULL });
    // The same deck a moment after its mute: the engine's own second-long
    // average is still coming down, and the strip shows where it IS.
    const fading = [...lit];
    fading[0] = loadedSlot(0, { mute: true, output_level: DECK_GLOW_FULL * 0.2 });
    let muted = false;
    const api = makeApi(makeStatus({ slots: lit }), {
      status: vi.fn(async () => makeStatus({ slots: muted ? fading : lit })),
    });
    render(<DecksView api={api} clips={makeClips()} pollMs={5} />);
    await waitFor(() => expect(deckLevel(0)).toBe(1));
    muted = true;
    await waitFor(() => expect(deckLevel(0)).toBeCloseTo(0.2, 3));
    expect(screen.getByTestId('decks-mute-0').getAttribute('aria-pressed')).toBe('true');
  });

  it('the level fader, the tone knobs and mute/monitor all write the slot', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[2] = loadedSlot(2);
    const api = makeApi(makeStatus({ slots }));
    show(api);
    await waitFor(() => expect(screen.getByTestId('decks-mute-2')).toBeTruthy());

    fireEvent.click(screen.getByTestId('decks-mute-2'));
    await waitFor(() => expect(api.setControl).toHaveBeenCalledWith('decks1', 2, 'mute', 1));
    fireEvent.click(screen.getByTestId('decks-monitor-2'));
    await waitFor(() => expect(api.setControl).toHaveBeenCalledWith('decks1', 2, 'monitor', 1));

    // The three tone controls are the rack's own knobs, one per band, and
    // the row is the EQ column on its side: it reads right to left.
    const tone = screen.getByTestId('decks-slot-2').querySelector('.decks-tone')!;
    expect(
      Array.from(tone.querySelectorAll('.knob')).map((k) => k.getAttribute('data-testid')),
    ).toEqual(['knob-3 LOW', 'knob-3 MID', 'knob-3 HIGH']);
    expect(screen.getByTestId('knob-3 LEVEL')).toBeTruthy();
  });

  it('the level fader is unity halfway up, and a double-click comes back to it', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[2] = loadedSlot(2, { level: LEVEL_UNITY });
    const api = makeApi(makeStatus({ slots }));
    show(api);
    await waitFor(() => expect(screen.getByTestId('knob-3 LEVEL')).toBeTruthy());

    // The clip as imported sits in the MIDDLE of the travel, so the half
    // above it is boost the deck can reach for.
    const box = screen.getByTestId('knob-3 LEVEL');
    const fader = box.querySelector('.fader') as HTMLElement;
    expect(fader.getAttribute('aria-valuenow')).toBe(String(LEVEL_UNITY));
    expect(fader.getAttribute('aria-valuemax')).toBe(String(LEVEL_MAX));
    expect((box.querySelector('.fader-cap') as HTMLElement).style.bottom).toBe('50%');

    // Dragged to the top it asks for the boost, in gain.
    fireEvent.mouseDown(fader, { clientX: 0, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 0, clientY: 25 });
    await waitFor(() =>
      expect(api.setControl).toHaveBeenCalledWith('decks1', 2, 'level', LEVEL_MAX),
    );
    fireEvent.mouseUp(window);

    // And a double-click puts the deck back at the clip's own volume.
    fireEvent.doubleClick(fader);
    await waitFor(() =>
      expect(api.setControl).toHaveBeenLastCalledWith('decks1', 2, 'level', LEVEL_UNITY),
    );
    expect(api.endEdit).toHaveBeenCalled();
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

  it('queue starts a muted deck on the grid, and drop stops a playing one', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[2] = loadedSlot(2, { mute: true, playing: false });
    slots[3] = loadedSlot(3);
    const api = makeApi(makeStatus({ slots }));
    show(api);
    await waitFor(() => expect(screen.getByTestId('decks-queue-2')).toBeTruthy());

    // A muted deck has nothing to drop, a playing one nothing to queue,
    // and an empty slot has neither.
    expect((screen.getByTestId('decks-drop-2') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('decks-queue-3') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('decks-queue-0') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('decks-drop-0') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('decks-queue-2'));
    await waitFor(() => expect(api.arm).toHaveBeenCalledWith('decks1', 2, 'queue'));
    fireEvent.click(screen.getByTestId('decks-drop-3'));
    await waitFor(() => expect(api.arm).toHaveBeenCalledWith('decks1', 3, 'drop'));
  });

  it('an armed deck says so, and pressing the button again takes the arm back', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    // A queued deck is already unmuted — the bank is holding it.
    slots[2] = loadedSlot(2, { mute: false, arm: 'queue' });
    slots[3] = loadedSlot(3, { mute: true, arm: 'drop' });
    const api = makeApi(makeStatus({ slots }));
    show(api);
    await waitFor(() => expect(screen.getByTestId('decks-queue-2')).toBeTruthy());

    const queue = screen.getByTestId('decks-queue-2');
    expect(queue.textContent).toBe('Queued');
    expect(queue.getAttribute('aria-pressed')).toBe('true');
    expect(queue.className).toContain('is-armed');
    const drop = screen.getByTestId('decks-drop-3');
    expect(drop.textContent).toBe('Dropping');
    expect(drop.className).toContain('is-armed');

    fireEvent.click(queue);
    await waitFor(() => expect(api.arm).toHaveBeenCalledWith('decks1', 2, 'none'));
    fireEvent.click(drop);
    await waitFor(() => expect(api.arm).toHaveBeenCalledWith('decks1', 3, 'none'));
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

  it('names the two steppers in three letters, with the word in their tooltips', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[1] = loadedSlot(1);
    show(makeApi(makeStatus({ slots })));
    await waitFor(() => expect(screen.getByTestId('decks-tail-1')).toBeTruthy());

    const label = (testId: string) =>
      screen.getByTestId(testId).querySelector('.decks-step-label')!;
    expect(label('decks-tail-1').textContent).toBe('SIL');
    expect(label('decks-tail-1').getAttribute('title')).toContain('Silence');
    expect(label('decks-phase-1').textContent).toBe('SFT');
    expect(label('decks-phase-1').getAttribute('title')).toContain('Shift');
    // Same four cells in the same order in both rows — that is what puts
    // one row's buttons under the other's.
    const shape = (testId: string) =>
      [...screen.getByTestId(testId).children].map((c) => `${c.tagName}.${c.className}`);
    expect(shape('decks-phase-1')).toEqual(shape('decks-tail-1'));
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

  it('the tempo is one control in one unit: the number and its slider under a single BPM label', async () => {
    const api = makeApi(makeStatus());
    show(api);
    const tempo = (await screen.findByTestId('decks-bpm')).closest('.decks-tempo-stack');
    expect(tempo).toBeTruthy();
    const labels = within(tempo as HTMLElement).getAllByText(/bpm/i);
    expect(labels).toHaveLength(1);
    expect(labels[0].getAttribute('for')).toBe('decks-bpm');
    // Both readings of the tempo live under that label, and nothing else.
    expect(within(tempo as HTMLElement).getByTestId('decks-bpm-slider')).toBeTruthy();
    // The clock the two of them run stands beside the stack, not across
    // the bar from it.
    const tempoGroup = screen.getByTestId('decks-clock-jack').closest('.decks-tempo');
    expect(tempoGroup?.contains(screen.getByTestId('decks-bpm'))).toBe(true);
  });

  it('the two output pairs are stacked, each just its master fader — no L/R jacks', async () => {
    const api = makeApi(makeStatus({ master_live: 0.8, master_monitor: 0.4 }));
    const { container } = show(api);
    const outs = await screen.findByTestId('decks-outs');
    // Live above monitor, in that order.
    const rows = Array.from(outs.children).map((row) => row.getAttribute('data-bus'));
    expect(rows).toEqual(['live', 'monitor']);

    // Where the pairs go is implied (decks_ensure keeps them wired to
    // outputs), so the rows carry no jack sockets at all.
    for (const jack of ['audio_l', 'audio_r', 'mon_l', 'mon_r']) {
      expect(container.querySelector(`[data-jack="decks1:output:${jack}"]`)).toBeNull();
    }
    expect(outs.querySelector('[data-jack]')).toBeNull();

    const live = screen.getByTestId<HTMLInputElement>('decks-master-live');
    const monitor = screen.getByTestId<HTMLInputElement>('decks-master-monitor');
    await waitFor(() => expect(live.value).toBe('0.8'));
    expect(monitor.value).toBe('0.4');

    fireEvent.change(live, { target: { value: '0.5' } });
    await waitFor(() => expect(api.setMaster).toHaveBeenCalledWith('decks1', 'live', 0.5));
    fireEvent.change(monitor, { target: { value: '1' } });
    await waitFor(() => expect(api.setMaster).toHaveBeenCalledWith('decks1', 'monitor', 1));
    fireEvent.pointerUp(monitor);
    await waitFor(() => expect(api.endEdit).toHaveBeenCalled());
  });

  it('a master the user is dragging stays where they are dragging it until the engine agrees', async () => {
    const api = makeApi(makeStatus({ master_live: 1 }));
    show(api);
    const live = await screen.findByTestId<HTMLInputElement>('decks-master-live');
    fireEvent.change(live, { target: { value: '0.25' } });
    // The poll keeps answering 1 — the drag wins while it is in hand.
    await waitFor(() => expect(api.setMaster).toHaveBeenCalled());
    expect(live.value).toBe('0.25');
    expect(screen.getByTestId('decks-out-live').textContent).toContain('25%');
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
    // A strip is too narrow to spell them out, so it takes the short
    // form — and the row is held to one line.
    expect(screen.getByTestId('decks-stems-0-drums').textContent).toBe('DRM');
    expect(screen.getByTestId('decks-stems-0').className).toContain('stem-tags-short');
    // Nothing known, nothing shown — an empty deck holds no clip.
    expect(screen.queryByTestId('decks-stems-3')).toBeNull();

    fireEvent.click(screen.getByTestId('decks-name-3'));
    const dialog = await screen.findByTestId('decks-clip-picker');
    expect(within(dialog).getByTestId('decks-clip-stems-p1-c1-bass')).toBeTruthy();
  });

  it('ejecting a deck clears it, from the row its stem tags are on', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[3] = loadedSlot(3);
    const api = makeApi(makeStatus({ slots }));
    show(api);
    await waitFor(() => expect(screen.getByTestId('decks-eject-3')).toBeTruthy());
    const tags = screen.getByTestId('decks-tag-row-3');
    expect(within(tags).getByTestId('decks-eject-3')).toBeTruthy();
    expect(within(tags).getByTestId('decks-stems-3-drums')).toBeTruthy();
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

  it('counts beats against the cycle length, and restarts the bank on demand', async () => {
    const api = makeApi(makeStatus({ cycle_beats: 24, beat: 5.5 }));
    show(api);
    await waitFor(() => expect(screen.getByTestId('decks-beat').textContent).toBe('beat 6/24'));
    expect(screen.queryByTestId('decks-cycle')).toBeNull();
    fireEvent.click(screen.getByTestId('decks-restart'));
    await waitFor(() => expect(api.reset).toHaveBeenCalledWith('decks1'));
  });

  it('a bank with no cycle length says nothing is loaded instead of a divisor', async () => {
    show(makeApi(makeStatus({ cycle_beats: 0, beat: 0 })));
    await waitFor(() =>
      expect(screen.getByTestId('decks-cycle').textContent).toBe('nothing loaded'),
    );
    expect(screen.getByTestId('decks-beat').textContent).toBe('beat 1');
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

  it('puts the clip tempo and the stretch on one line, without a trailing .0', () => {
    expect(tempoLabel(140, 1.093)).toBe('140 bpm +9.3%');
    expect(tempoLabel(128.5, 1)).toBe('128.5 bpm ±0.0%');
  });

  it('keeps the two halves of a clip name apart, one line each', () => {
    const clip = { project: 'p1', clip: 'c1', name: 'intro', project_name: 'set one' };
    expect(clipParts(clip)).toEqual({ project: 'set one', name: 'intro' });
    // Before clips carried the project name, the id is what there is.
    expect(clipParts({ project: 'p9', clip: 'c9', name: 'stab', project_name: '' })).toEqual({
      project: 'p9',
      name: 'stab',
    });
    expect(clipParts(null)).toBeNull();
    // The one-line form is what the load button's tooltip says.
    expect(clipTitle(clip)).toBe('set one - intro');
    expect(clipTitle(null)).toBe('empty');
  });
});

describe('a bank restored with the app', () => {
  it('asks for the audio behind its bindings once, when the page opens', async () => {
    const rehydrate = vi.fn().mockResolvedValue(2);
    const api = makeApi(makeStatus(), { rehydrate });
    show(api);
    await waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
  });

  it('makes sure the bank it found can be heard', async () => {
    // A bank whose live pair goes nowhere (added to a patch with no Audio
    // Output) is wired up by `ensure`, so opening the page is enough to
    // get the sound back; it is a no-op for a bank that already plays.
    const ensure = vi.fn().mockResolvedValue('decks1');
    const api = makeApi(makeStatus(), { ensure });
    show(api);
    await waitFor(() => expect(ensure).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('decks-strips')).toBeTruthy();
  });

  it('does not conjure a bank for a rack that has none', async () => {
    const ensure = vi.fn().mockResolvedValue('decks1');
    const api = makeApi(makeStatus(), { banks: vi.fn().mockResolvedValue([]), ensure });
    show(api);
    await waitFor(() => expect(screen.getByTestId('decks-empty')).toBeTruthy());
    expect(ensure).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// The deck chrome as a patch bay: the strips and the top bar carry the
// BANK's own jacks (a mono send and return per deck with the insert's
// wetness knob and cue button beside them, a CV out per tone knob,
// the clock in the bar), and clicking them goes through the Rack tab's
// own jack grammar. The screen-space cable overlay's GEOMETRY is pinned
// in DecksChromeWires.test.tsx.
// ---------------------------------------------------------------------

function jackSocket(container: HTMLElement, key: string): HTMLElement | null {
  return container.querySelector(`[data-jack="${key}"]`);
}

describe('the deck chrome is the bank, on jacks', () => {
  it('every deck carries its send, its return and a CV jack per tone knob', async () => {
    const api = makeApi(makeStatus());
    const { container } = show(api);
    await screen.findByTestId('decks-io-0');
    for (const deck of [1, 8]) {
      // One cable each way: the send and the return are mono.
      expect(jackSocket(container, `decks1:output:d${deck}_out`)).toBeTruthy();
      expect(jackSocket(container, `decks1:input:d${deck}_in`)).toBeTruthy();
      expect(jackSocket(container, `decks1:output:d${deck}_l`)).toBeNull();
      expect(jackSocket(container, `decks1:input:d${deck}_in_r`)).toBeNull();
      for (const tone of ['high', 'mid', 'low']) {
        expect(jackSocket(container, `decks1:output:d${deck}_${tone}`)).toBeTruthy();
      }
    }
    // Each socket is named once, by the arrow beside it: no "out"/"in"
    // words on the sockets themselves. The only other word on the row is
    // the wetness knob's.
    const io = screen.getByTestId('decks-io-0');
    expect([...io.querySelectorAll('.decks-io-label')].map((el) => el.textContent)).toEqual([
      '↑',
      '↓',
      'WET',
    ]);
    expect(within(io).getByTestId('jack-output-d1_out').querySelector('.jack-name')).toBeNull();
    expect(within(io).getByTestId('jack-input-d1_in').querySelector('.jack-name')).toBeNull();
    // The bank's clock rides in the top bar, beside the tempo it counts.
    const clock = screen.getByTestId('decks-clock-jack');
    expect(within(clock).getByTestId('jack-output-clock')).toBeTruthy();
    expect(jackSocket(container, 'decks1:output:clock')).toBeTruthy();
    // The two output pairs have NO chrome jacks: where the bank comes
    // out is implied (decks_ensure keeps the pairs wired to outputs), so
    // the rows carry only their master faders.
    for (const jack of ['audio_l', 'audio_r', 'mon_l', 'mon_r']) {
      expect(jackSocket(container, `decks1:output:${jack}`)).toBeNull();
    }
  });

  it('clicking a chrome jack goes through the rack grammar, bank instance first', async () => {
    const api = makeApi(makeStatus());
    const onJackClick = vi.fn();
    render(<DecksView api={api} clips={makeClips()} pollMs={NO_POLL} onJackClick={onJackClick} />);
    const io = await screen.findByTestId('decks-io-0');
    fireEvent.click(within(io).getByTestId('jack-output-d1_out'));
    expect(onJackClick).toHaveBeenCalledWith('decks1', 'output', 'd1_out', false);
    fireEvent.click(within(io).getByTestId('jack-input-d1_in'), { shiftKey: true });
    expect(onJackClick).toHaveBeenCalledWith('decks1', 'input', 'd1_in', true);
    fireEvent.click(screen.getByTestId('jack-output-clock'));
    expect(onJackClick).toHaveBeenCalledWith('decks1', 'output', 'clock', false);
  });

  it('a wired chrome jack shows its cable, and the armed one lights in the pending color', async () => {
    const api = makeApi(makeStatus());
    render(
      <DecksView
        api={api}
        clips={makeClips()}
        pollMs={NO_POLL}
        wires={[
          { from_instance: 'decks1', from_jack: 'd1_out', to_instance: 'vca1', to_jack: 'in' },
          { from_instance: 'lfo1', from_jack: 'out', to_instance: 'decks1', to_jack: 'd2_in' },
        ]}
        pending={{ instance: 'decks1', jack: 'clock', kind: 'output', color: 3 }}
      />,
    );
    const io0 = await screen.findByTestId('decks-io-0');
    expect(within(io0).getByTestId('jack-output-d1_out').className).toContain('jack-wired');
    expect(within(io0).getByTestId('jack-input-d1_in').className).not.toContain('jack-wired');
    const io1 = screen.getByTestId('decks-io-1');
    expect(within(io1).getByTestId('jack-input-d2_in').className).toContain('jack-wired');
    const clock = within(screen.getByTestId('decks-clock-jack')).getByTestId('jack-output-clock');
    expect(clock.className).toContain('jack-selected');
  });

  it('a patched tone knob says it is driving the rack, not its band', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[2] = { ...loadedSlot(2), tone_patched: [false, true, false] };
    // `tone_patched` is in TONES order (high, mid, low), whichever way
    // round the row is drawn.
    slots[3] = { ...loadedSlot(3), tone_patched: [true, false, false] };
    const api = makeApi(makeStatus({ slots }));
    show(api);
    await screen.findByTestId('decks-io-0');
    expect(screen.getByTestId('decks-tone-jack-2-mid').getAttribute('data-patched')).toBe('yes');
    expect(screen.getByTestId('decks-tone-jack-2-high').getAttribute('data-patched')).toBe('no');
    expect(screen.getByTestId('decks-tone-jack-3-high').getAttribute('data-patched')).toBe('yes');
    expect(screen.getByTestId('decks-tone-jack-3-low').getAttribute('data-patched')).toBe('no');
  });

  it('the insert row carries a wetness knob and the monitor button beside its sockets', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[4] = { ...loadedSlot(4), insert: true, wet: 0.25, insert_monitor: true };
    const api = makeApi(makeStatus({ slots }));
    show(api);
    await screen.findByTestId('decks-io-0');
    // The knob is where the deck's own cables are, and it reads the
    // engine's value: a quarter of the way round.
    const io = screen.getByTestId('decks-io-4');
    expect(within(io).getByLabelText('5 WET').getAttribute('aria-valuenow')).toBe('0.25');
    const cue = screen.getByTestId('decks-insert-monitor-4');
    expect(cue.textContent).toBe('M');
    expect(cue.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('decks-insert-monitor-0').getAttribute('aria-pressed')).toBe('false');
  });

  it('the wetness knob and the M button write the deck they sit on', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => emptySlot(i));
    slots[2] = loadedSlot(2, { insert: true, wet: 1 });
    const api = makeApi(makeStatus({ slots }));
    show(api);
    await screen.findByTestId('decks-io-2');

    const dial = within(screen.getByTestId('decks-io-2')).getByLabelText('3 WET');
    fireEvent.mouseDown(dial, { clientY: 100 });
    fireEvent.mouseMove(window, { clientY: 175 }); // half the travel down
    fireEvent.mouseUp(window);
    await waitFor(() => {
      const wet = vi.mocked(api.setControl).mock.calls.find((c) => c[2] === 'wet');
      expect(wet?.[3]).toBeCloseTo(0.5, 5);
    });

    fireEvent.click(screen.getByTestId('decks-insert-monitor-2'));
    await waitFor(() =>
      expect(api.setControl).toHaveBeenCalledWith('decks1', 2, 'insert_monitor', 1),
    );
  });
});
