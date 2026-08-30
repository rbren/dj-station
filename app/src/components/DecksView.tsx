// The Decks page: eight beat clips on one clock, as eight channel
// strips under one tempo — CHROME around the real rack canvas. App keeps
// the one rack (`.rack-area`, panels, wire overlay, pan/zoom) mounted and
// visible on this tab, and this component renders the deck furniture
// around it: the tempo bar above — the BPM (number and slider, one
// control in one unit), the clock beside it, and where the bank comes
// out: a master fader for the live pair over one for the monitor pair.
// The pairs themselves carry no chrome jacks — where they go is implied
// (decks_ensure keeps them wired to outputs) — and the eight strips
// (each with its send/return and tone-CV jacks) sit below.
//
// The bank is STOPPED until the bar's Start is pressed — opening the tab
// is not a reason to make a noise, and a bank restored with the app comes
// back parked — and Stop puts it back on beat 0, so the next Start comes
// in from the top of every clip.
//
// The page is a big panel for a single rack module (`builtin.decks`) — the
// bank is in the patch and a started one keeps RUNNING when the tab is not
// looking (it is the OUTPUT that the open page owns, see
// `audioFocusForView`), so this file only reads its state and writes edits
// back. Everything the page shows comes from ONE poll of `decks_status`
// (the engine owns the phase arithmetic and the stretch), which is what
// keeps the page and a Launch Control XL saying the same thing: the
// hardware writes the same state through the same commands.
//
// PATCHING here is the Rack tab's own machinery, not a copy: jack clicks
// go through App's `onJackClick` (same pending-wire grammar, same colors),
// the wires prop is the same store slice the rack overlay draws, and the
// bank's chrome jacks carry the same `data-jack` sockets. What is special
// is only GEOMETRY: chrome jacks live outside the pan/zoom-transformed
// rack, so the cables that touch the bank are drawn by a second
// WireOverlay in SCREEN coordinates over the whole app body (zoom 1), and
// re-measured whenever the canvas pans/zooms (overlayLayoutKey). The bank
// module's own panel is NOT rendered on this tab (App skips it) — the
// chrome IS the bank, so each bank jack resolves to exactly one socket.
//
// The strip row is a DOCK the user sizes: a handle on its top edge drags
// its height (clamped, persisted in localStorage like the rack's zoom and
// pan) and its label collapses it to a bar. Every pixel it gives up goes
// to the canvas — and because both moves slide the chrome jacks, the
// dock's geometry is part of the cable overlay's layout key, so the wires
// follow the drag frame by frame.
//
// The other piece of local state is a DRAFT of a control being dragged: a
// fader streams faster than the poll, so the drag's value wins until the
// engine's own reading agrees with it. Drafts converge and clear
// themselves — there is no timer, and no "who is right" ambiguity.
//
// The tempo box is that draft with a WALK behind it. Ticked, "smooth"
// makes the number a destination: the bank's tempo moves toward it at
// SMOOTH_BPM_PER_SEC, written a step at a time down the same
// `decks_set_bpm` path (one coalesced undo step, closed when it lands),
// and the reading beside the box says where the bank actually is
// meanwhile. Unticked, the write goes out whole, as it always did.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { beatClip as defaultClips, type BeatClipApi, type BeatClipEntry } from '../beatClip';
import {
  decks as defaultApi,
  CLOCK_JACK,
  MASTER_BUSES,
  MAX_BPM,
  MIN_BPM,
  rampBpm,
  type DecksApi,
  type DecksStatus,
  type DeckSlotStatus,
  type MasterBus,
  type SlotControl,
} from '../decks';
import type { WireSnapshot } from '../engine';
import { loadJson, saveJson, type PendingWire } from '../rackStore';
import { DecksClipPicker } from './DecksClipPicker';
import { DecksSlot } from './DecksSlot';
import { LiveJack } from './Jack';
import { WIRE_COLORS, WireOverlay } from './WireOverlay';

const POLL_MS = 100;

/** How often the smooth ramp writes the tempo on its way to the target:
 *  the poll's cadence, so the actual reading and the walk that moves it
 *  step together. */
const SMOOTH_TICK_MS = 100;

/** How tall the strip dock is, and whether it is open at all: cosmetic
 *  app-layer state, persisted in localStorage beside the rack's zoom and
 *  pan (never in the patch — the bank is the same bank at any height). */
export const DOCK_HEIGHT_KEY = 'dj-decks-dock-height';
export const DOCK_COLLAPSED_KEY = 'dj-decks-dock-collapsed';
/** Under this a strip loses its faders before it loses anything else. */
export const DOCK_MIN_HEIGHT = 140;
export const DOCK_DEFAULT_HEIGHT = 300;
/** The canvas is the point of the page: the decks never take more than
 *  this share of the body, however hard the handle is dragged. */
const DOCK_MAX_FRACTION = 0.7;
/** Arrow-key nudge on the focused handle. */
const DOCK_KEY_STEP = 24;

/** What the clamps are measured against: the app body the chrome shares
 *  with the canvas, or the window when the page is rendered standalone
 *  (headless tests, where nothing has a layout box). */
function viewportHeight(container: HTMLElement | null | undefined): number {
  return container?.clientHeight || window.innerHeight || DOCK_DEFAULT_HEIGHT;
}

export function dockMaxHeight(viewport: number): number {
  return Math.max(DOCK_MIN_HEIGHT, Math.round(viewport * DOCK_MAX_FRACTION));
}

export function clampDockHeight(px: number, viewport: number): number {
  if (!Number.isFinite(px)) return DOCK_DEFAULT_HEIGHT;
  return Math.min(dockMaxHeight(viewport), Math.max(DOCK_MIN_HEIGHT, Math.round(px)));
}

export interface DecksViewProps {
  api?: DecksApi;
  clips?: BeatClipApi;
  /** The page keeps polling only while it is the open tab. */
  active?: boolean;
  pollMs?: number;
  /** The Rack tab's jack-click grammar (App.onJackClick): arm, complete,
   *  pick up or shift-unplug a wire at a bank jack. Absent = the chrome
   *  jacks are inert (headless tests). */
  onJackClick?(
    instance: string,
    kind: 'input' | 'output',
    jack: string,
    shift?: boolean,
  ): Promise<void> | void;
  /** The patch's wires — the same rack-store slice the rack overlay
   *  draws, so a chrome jack knows when it holds a cable. */
  wires?: WireSnapshot[];
  /** The armed wire end (rack-store slice), for the lit jack and the
   *  cursor-following preview cable. */
  pending?: PendingWire | null;
  /** Wire key → color index, shared with the rack overlay. */
  wireColors?: Record<string, number>;
  /** The element the chrome cable overlay renders inside and measures
   *  against: the app body that contains BOTH the chrome bars and the
   *  rack canvas. Absent = no chrome cables (standalone render). */
  overlayContainer?: HTMLElement | null;
  /** Changes whenever module jacks may have MOVED ON SCREEN — pan, zoom,
   *  module positions. Chrome jacks are fixed while the canvas moves
   *  under them, so unlike the rack overlay this one re-measures on
   *  every pan/zoom change. */
  overlayLayoutKey?: string;
  /** Called after this page changed the graph (made or wired the bank),
   *  so App re-reads nodes/wires. */
  onGraphChange?(): void;
}

type DraftKey = `${number}:${SlotControl}`;

export function DecksView(props: DecksViewProps) {
  const api = props.api ?? defaultApi;
  const clipApi = props.clips ?? defaultClips;
  const active = props.active ?? true;
  const [bank, setBank] = useState<string | null>(null);
  const [status, setStatus] = useState<DecksStatus | null>(null);
  const [clips, setClips] = useState<BeatClipEntry[]>([]);
  const [picking, setPicking] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Partial<Record<DraftKey, number>>>({});
  // The tempo the box is ASKING for, and whether the bank walks to it or
  // jumps. The target is a draft like any other — it clears itself once
  // the engine's reading agrees — but with `smooth` ticked it outlives
  // the keystroke that set it, because the walk that answers it takes
  // seconds (`SMOOTH_BPM_PER_SEC`) and the box has to keep saying where
  // the bank is going while the readout beside it says where it is.
  const [bpmTarget, setBpmTarget] = useState<number | null>(null);
  const [smooth, setSmooth] = useState(true);
  // The last tempo the walk wrote, so a target changed mid-walk carries
  // on from where the bank actually is rather than from the poll's
  // reading; null between walks.
  const ramp = useRef<number | null>(null);
  const [masterDrafts, setMasterDrafts] = useState<Partial<Record<MasterBus, number>>>({});
  const rehydrated = useRef(false);
  // Where the bank's grid is BETWEEN polls: the last reading and the
  // moment it landed. A control that means "now" — clicking a strip's
  // SFT label — cannot read a status a tenth of a second old, because
  // that is a fifth of a beat at 120 bpm and enough to round onto the
  // wrong beat; so the reading is carried forward at the tempo it came
  // with. Nothing is DRAWN from this, so it stays a ref.
  const clock = useRef<{ beat: number; bpm: number; running: boolean; at: number } | null>(null);
  const [collapsed, setCollapsed] = useState(
    () => loadJson<boolean>(DOCK_COLLAPSED_KEY, false) === true,
  );
  const [dockHeight, setDockHeight] = useState(() =>
    clampDockHeight(loadJson(DOCK_HEIGHT_KEY, DOCK_DEFAULT_HEIGHT), viewportHeight(null)),
  );
  const [resizing, setResizing] = useState(false);
  const grab = useRef<{ y: number; height: number } | null>(null);
  const heightRef = useRef(dockHeight);

  const poll = useCallback(async () => {
    if (!bank) return;
    const st = await api.status(bank);
    if (!st) return;
    clock.current = { beat: st.beat, bpm: st.bpm, running: st.running, at: performance.now() };
    setStatus(st);
    // The tempo the bank has arrived at is no longer a target — the box
    // goes back to reading the engine, so a tempo moved from anywhere
    // else (the surface) shows up in it.
    setBpmTarget((t) => (t !== null && Math.abs(st.bpm - clampBpm(t)) < 1e-3 ? null : t));
    // A draft the engine has caught up with is no longer a draft.
    setDrafts((live) => {
      const settled = Object.fromEntries(
        (Object.entries(live) as [DraftKey, number][]).filter(([key, value]) => {
          const [slot, control] = key.split(':') as [string, SlotControl];
          return Math.abs(controlValue(st.slots[Number(slot)], control) - value) >= 1e-3;
        }),
      ) as Partial<Record<DraftKey, number>>;
      return Object.keys(settled).length === Object.keys(live).length ? live : settled;
    });
  }, [api, bank]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      const found = await api.banks();
      // A bank that is here already still has to be able to PLAY: one
      // whose live pair goes nowhere (a bank added to a patch with no
      // Audio Output) is given one here, which is why opening the page
      // asks rather than just reading. `ensure` creates nothing else and
      // is not an edit when there is nothing to do.
      const bank = found?.[0] ? ((await api.ensure()) ?? found[0]) : null;
      if (!cancelled && found) setBank(bank);
      // `ensure` may have wired an output for the bank — a graph change
      // the rack canvas behind this chrome must re-read.
      if (!cancelled && bank) props.onGraphChange?.();
      const list = await clipApi.list();
      if (!cancelled && list) setClips(list);
      // A bank restored at startup can come back bound but silent — its
      // clips are re-assembled from disk and that can fail while the app
      // is still coming up. Asking once, when the page opens, is what
      // turns "it played yesterday" back into sound.
      if (!cancelled && !rehydrated.current) {
        rehydrated.current = true;
        const filled = await api.rehydrate();
        if (!cancelled && filled) void poll();
      }
    })();
    return () => {
      cancelled = true;
    };
    // `poll` is deliberately out: this runs when the tab opens, not on
    // every status change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, clipApi, active]);

  useEffect(() => {
    if (!active || !bank) return;
    const first = setTimeout(() => void poll(), 0);
    const timer = setInterval(() => void poll(), props.pollMs ?? POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active, bank, poll, props.pollMs]);

  const addBank = useCallback(async () => {
    setBusy(true);
    const created = await api.ensure();
    setBusy(false);
    if (created) {
      setBank(created);
      // A new module (and its outputs) just entered the patch — the rack
      // canvas behind this chrome must re-read the graph.
      props.onGraphChange?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, props.onGraphChange]);

  // The chrome's own patching hooks: the Rack tab's grammar, on the
  // bank's jacks. All optional — a standalone render is inert chrome.
  const wires = props.wires;
  const pending = props.pending;
  const onJack = useCallback(
    (jack: string, kind: 'input' | 'output', shift: boolean) => {
      if (bank) void props.onJackClick?.(bank, kind, jack, shift);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bank, props.onJackClick],
  );
  const isWired = useCallback(
    (jack: string, kind: 'input' | 'output') =>
      (wires ?? []).some((w) =>
        kind === 'input'
          ? w.to_instance === bank && w.to_jack === jack
          : w.from_instance === bank && w.from_jack === jack,
      ),
    [wires, bank],
  );
  const isArmed = useCallback(
    (jack: string, kind: 'input' | 'output') =>
      pending?.instance === bank && pending.kind === kind && pending.jack === jack,
    [pending, bank],
  );
  const armedColor = pending ? WIRE_COLORS[pending.color % WIRE_COLORS.length] : undefined;
  // The cables the CHROME overlay owns: every wire touching the bank.
  // Module-to-module cables stay with the rack overlay (they pan/zoom for
  // free); a bank wire's chrome end sits still while the canvas moves, so
  // these are measured in screen coordinates and re-measured on pan/zoom
  // (overlayLayoutKey). A bank jack with no chrome socket (the tempo and
  // reset inputs, the two output pairs) simply does not resolve, and its
  // cable is not drawn here.
  const chromeWires = useMemo(
    () => (wires ?? []).filter((w) => w.from_instance === bank || w.to_instance === bank),
    [wires, bank],
  );

  const write = useCallback(
    async (fn: () => Promise<unknown>) => {
      await fn();
      void poll();
    },
    [poll],
  );

  // The tempo in two halves: the TARGET the box asks for, and how the
  // bank gets there. Unticked, it gets there in one step — the write
  // goes straight out, as it always did.
  const setBpmTo = useCallback(
    (next: number) => {
      if (!bank || !Number.isFinite(next)) return;
      setBpmTarget(next);
      if (!smooth) void write(() => api.setBpm(bank, clampBpm(next)));
    },
    [api, bank, smooth, write],
  );

  // Closing the tempo's undo window is the WALK's business while it is
  // walking, so a blur or a released slider only ends the edit when the
  // write has already gone out.
  const endBpmEdit = useCallback(() => {
    if (smooth) return;
    setBpmTarget(null);
    void api.endEdit();
  }, [api, smooth]);

  // SMOOTH: the bank WALKS to the target at SMOOTH_BPM_PER_SEC rather
  // than jumping there, so a tempo change is something a floor moves
  // with. Each step is the same tempo write the box makes — one undo
  // step (`EditKey::Knob` coalesces until `end_edit`), closed when the
  // walk arrives — and the actual tempo beside the box is the engine's
  // own reading of it, never this loop's arithmetic.
  useEffect(() => {
    if (!bank || !smooth || bpmTarget === null) return;
    const goal = clampBpm(bpmTarget);
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const next = rampBpm(ramp.current ?? clock.current?.bpm ?? goal, goal, (now - last) / 1000);
      last = now;
      void api.setBpm(bank, next);
      if (next === goal) {
        ramp.current = null;
        clearInterval(timer);
        void api.endEdit();
      } else {
        ramp.current = next;
      }
    }, SMOOTH_TICK_MS);
    return () => clearInterval(timer);
  }, [api, bank, bpmTarget, smooth]);

  const toggleSmooth = useCallback(
    (on: boolean) => {
      setSmooth(on);
      // Unticking it mid-walk means "be there now": the target the box
      // still shows is applied whole, and the edit closes with it.
      if (!on && bank && bpmTarget !== null) {
        ramp.current = null;
        void write(() => api.setBpm(bank, clampBpm(bpmTarget)));
        void api.endEdit();
      }
    },
    [api, bank, bpmTarget, write],
  );

  // The bank's beat position right now: the last poll's reading plus the
  // beats that have gone by since it landed. A stopped bank is parked, so
  // its reading is already now.
  const beatNow = useCallback(() => {
    const c = clock.current;
    if (!c) return 0;
    if (!c.running) return c.beat;
    return c.beat + ((performance.now() - c.at) / 1000) * (c.bpm / 60);
  }, []);

  const setControl = useCallback(
    (slot: number, control: SlotControl, value: number) => {
      if (!bank) return;
      setDrafts((d) => ({ ...d, [`${slot}:${control}`]: value }));
      void write(() => api.setControl(bank, slot, control, value));
    },
    [api, bank, write],
  );

  // The two output faders, drafted while they are being dragged exactly
  // like the tempo: the drag streams faster than the poll.
  const master = useCallback(
    (bus: MasterBus) =>
      masterDrafts[bus] ??
      (bus === 'live' ? (status?.master_live ?? 1) : (status?.master_monitor ?? 1)),
    [masterDrafts, status],
  );
  const setMaster = useCallback(
    (bus: MasterBus, value: number) => {
      if (!bank) return;
      setMasterDrafts((d) => ({ ...d, [bus]: value }));
      void write(() => api.setMaster(bank, bus, value));
    },
    [api, bank, write],
  );
  const releaseMaster = useCallback(
    (bus: MasterBus) => {
      setMasterDrafts((d) => ({ ...d, [bus]: undefined }));
      void api.endEdit();
    },
    [api],
  );

  // The dock: how much of the body the strips take, and whether they are
  // showing at all. Both are pure chrome geometry — the bank plays the
  // same either way — but they MOVE THE CHROME JACKS, so every change is
  // folded into the cable overlay's layout key below and the wires are
  // re-measured mid-drag, not just at the end.
  const applyHeight = useCallback(
    (px: number) => {
      const next = clampDockHeight(px, viewportHeight(props.overlayContainer));
      heightRef.current = next;
      setDockHeight(next);
      return next;
    },
    [props.overlayContainer],
  );

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: PointerEvent) => {
      const from = grab.current;
      if (!from) return;
      // The handle is on TOP of the dock, so dragging up makes it taller.
      applyHeight(from.height + (from.y - e.clientY));
    };
    const onUp = () => {
      grab.current = null;
      setResizing(false);
      saveJson(DOCK_HEIGHT_KEY, heightRef.current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [resizing, applyHeight]);

  const nudgeHeight = useCallback(
    (delta: number) => saveJson(DOCK_HEIGHT_KEY, applyHeight(heightRef.current + delta)),
    [applyHeight],
  );

  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    setCollapsed(next);
    saveJson(DOCK_COLLAPSED_KEY, next);
  }, [collapsed]);

  // What the box asks for, and what the bank is actually running: the
  // same number until a smooth walk is between them.
  const bpm = bpmTarget ?? status?.bpm ?? 120;
  const actualBpm = status?.bpm ?? bpm;
  const running = status?.running ?? false;
  const slots = useMemo(() => status?.slots ?? [], [status]);
  const shownSlots = useMemo(() => slots.map((s) => withDrafts(s, drafts)), [slots, drafts]);

  if (!bank) {
    return (
      <div className="decks-view" data-testid="decks-view">
        <p className="empty-state decks-empty-bar" data-testid="decks-empty">
          A deck bank plays eight beat clips together, on one tempo.
          <br />
          <button
            className="is-primary decks-add"
            data-testid="decks-add-bank"
            disabled={busy}
            onClick={() => void addBank()}
          >
            Add the deck bank
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="decks-view" data-testid="decks-view">
      <header className="decks-bar decks-chrome">
        {/* The tempo, its slider and the clock the two of them run: one
            number in one unit, so it is labelled ONCE, and the jack that
            carries that number to the rack stands right beside it. */}
        <div className="decks-tempo">
          {/* Whether the bank WALKS to a new tempo or steps to it, beside
              the box that asks for one: ticked, the number is a
              destination the bank takes a second per beat to reach. */}
          <label className="decks-smooth" data-testid="decks-smooth">
            <input
              type="checkbox"
              checked={smooth}
              onChange={(e) => toggleSmooth(e.target.checked)}
            />
            smooth
          </label>
          <div className="decks-tempo-stack">
            <label className="decks-tempo-label" htmlFor="decks-bpm">
              BPM
            </label>
            <input
              id="decks-bpm"
              className="decks-bpm mono"
              data-testid="decks-bpm"
              type="number"
              min={MIN_BPM}
              max={MAX_BPM}
              step={0.5}
              value={Number(bpm.toFixed(2))}
              onChange={(e) => setBpmTo(Number(e.target.value))}
              onBlur={endBpmEdit}
            />
            <input
              className="decks-tempo-slider"
              data-testid="decks-bpm-slider"
              type="range"
              aria-label="Bank tempo"
              min={MIN_BPM}
              max={MAX_BPM}
              step={0.5}
              value={bpm}
              onChange={(e) => setBpmTo(Number(e.target.value))}
              onPointerUp={endBpmEdit}
            />
          </div>
          {/* Where the bank IS while it walks to where it was sent: the
              engine's own reading of its tempo, which is the box's number
              again the moment the walk arrives. */}
          <span className="decks-bpm-actual" data-testid="decks-bpm-actual">
            <span className="decks-bpm-actual-label">actual</span>
            <span className="decks-bpm-actual-value mono">{actualBpm.toFixed(1)}</span>
          </span>
          {/* The bank's clock, on a jack: one pulse per beat, wired into
              the rack below (an LFO, a sequencer) to run it on the same
              grid the decks are on. */}
          <span className="decks-clock-jack" data-testid="decks-clock-jack">
            <LiveJack
              instance={bank}
              id={CLOCK_JACK}
              kind="output"
              label="clock"
              wired={isWired(CLOCK_JACK, 'output')}
              selected={isArmed(CLOCK_JACK, 'output')}
              selectedColor={armedColor}
              onClick={(shift) => onJack(CLOCK_JACK, 'output', shift)}
            />
          </span>
        </div>
        <div className="decks-readout">
          <span
            className="decks-beat mono"
            data-testid="decks-beat"
            data-state={running ? 'running' : 'stopped'}
          >
            beat {Math.floor(status?.beat ?? 0) + 1}
            {status && status.cycle_beats > 0 ? `/${status.cycle_beats}` : ''}
          </span>
          {(!status || status.cycle_beats <= 0) && (
            <span className="decks-cycle" data-testid="decks-cycle">
              nothing loaded
            </span>
          )}
        </div>
        {/* Where the bank comes out, one row per pair: the room above the
            headphones, each just its fader — the pairs themselves carry
            no chrome jacks, because where they go is implied
            (decks_ensure keeps them wired to outputs). */}
        <div className="decks-outs" data-testid="decks-outs">
          {MASTER_BUSES.map((bus) => (
            <div className="decks-out" data-bus={bus} data-testid={`decks-out-${bus}`} key={bus}>
              <span className="decks-out-label">{bus}</span>
              <input
                className="decks-master"
                data-testid={`decks-master-${bus}`}
                type="range"
                aria-label={`${bus} master volume`}
                min={0}
                max={1}
                step={0.01}
                value={master(bus)}
                onChange={(e) => setMaster(bus, Number(e.target.value))}
                onPointerUp={() => releaseMaster(bus)}
              />
              <span className="decks-master-value mono">{Math.round(master(bus) * 100)}%</span>
            </div>
          ))}
        </div>
        <div className="decks-bar-actions">
          <span
            className="decks-surface"
            data-testid="decks-surface"
            data-state={!status?.surface ? 'off' : status.surface_connected ? 'on' : 'waiting'}
          >
            {!status?.surface
              ? 'Launch Control XL ignored'
              : status.surface_connected
                ? 'Launch Control XL connected'
                : 'Launch Control XL not found'}
          </span>
          <button
            className={`decks-btn${status?.surface ? ' is-on' : ''}`}
            data-testid="decks-surface-toggle"
            aria-pressed={status?.surface ?? false}
            onClick={() => void write(() => api.setSurface(bank, !status?.surface))}
          >
            Follow surface
          </button>
          {/* The transport. A bank is stopped until it is asked to play —
              opening this tab is not a reason to make a noise — and Stop
              parks it back on beat 0, so Start always comes in from the
              top of every clip. */}
          <button
            className={`decks-btn decks-btn-start${running ? ' is-on' : ''}`}
            data-testid="decks-start"
            aria-pressed={running}
            onClick={() => void write(() => api.setRunning(bank, true))}
          >
            Start
          </button>
          <button
            className={`decks-btn${running ? '' : ' is-on'}`}
            data-testid="decks-stop"
            aria-pressed={!running}
            onClick={() => void write(() => api.setRunning(bank, false))}
          >
            Stop
          </button>
        </div>
      </header>

      {/* The strip dock: a band of chrome the canvas gets back when it is
          made shorter or shut. Collapsed it is just its own bar — the
          strips (and with them their send/return/tone jacks) leave the
          DOM, so their cables stop resolving and are not drawn, exactly
          like a bank jack that has no chrome socket. */}
      <div
        className={`decks-dock decks-chrome${resizing ? ' is-resizing' : ''}`}
        data-testid="decks-dock"
        data-collapsed={collapsed ? 'true' : 'false'}
        style={collapsed ? undefined : { height: dockHeight }}
      >
        <div className="decks-dock-bar">
          <button
            className="decks-dock-toggle"
            data-testid="decks-dock-toggle"
            aria-expanded={!collapsed}
            aria-controls="decks-strips"
            title={collapsed ? 'Show the decks' : 'Hide the decks'}
            onClick={toggleCollapsed}
          >
            <span className="decks-dock-chevron" aria-hidden="true" />
            Decks
          </button>
          {collapsed ? (
            <span className="decks-dock-summary" data-testid="decks-dock-summary">
              {slots.filter((s) => s.loaded).length} of {slots.length} loaded
            </span>
          ) : (
            <div
              className="decks-dock-grip"
              data-testid="decks-dock-grip"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize the decks"
              aria-valuenow={dockHeight}
              aria-valuemin={DOCK_MIN_HEIGHT}
              aria-valuemax={dockMaxHeight(viewportHeight(props.overlayContainer))}
              tabIndex={0}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                // Never let the grab turn into a text selection.
                e.preventDefault();
                grab.current = { y: e.clientY, height: dockHeight };
                setResizing(true);
              }}
              onDoubleClick={() => nudgeHeight(DOCK_DEFAULT_HEIGHT - heightRef.current)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp') nudgeHeight(DOCK_KEY_STEP);
                else if (e.key === 'ArrowDown') nudgeHeight(-DOCK_KEY_STEP);
                else return;
                e.preventDefault();
              }}
            />
          )}
        </div>
        {!collapsed && (
          <div className="decks-strips" id="decks-strips" data-testid="decks-strips">
            {shownSlots.map((slot) => (
              <DecksSlot
                key={slot.slot}
                slot={slot}
                instance={bank}
                onLoad={() => setPicking(slot.slot)}
                onClear={() => void write(() => api.clear(bank, slot.slot))}
                onControl={(control, value) => setControl(slot.slot, control, value)}
                onToggle={(control) => setControl(slot.slot, control, slot[control] ? 0 : 1)}
                onArm={(arm) => void write(() => api.arm(bank, slot.slot, arm))}
                onTail={(tail) => void write(() => api.setTail(bank, slot.slot, Math.max(0, tail)))}
                onPhase={(phase) => void write(() => api.setPhase(bank, slot.slot, phase))}
                beatNow={beatNow}
                onRatio={(ratio) => void write(() => api.setRatio(bank, slot.slot, ratio))}
                onRelease={() => void api.endEdit()}
                onJack={onJack}
                isArmed={isArmed}
                isWired={isWired}
                armedColor={armedColor}
              />
            ))}
          </div>
        )}
      </div>

      {/* The chrome cable layer: every wire that touches the bank, drawn
          in SCREEN coordinates over the whole app body — one end on a
          fixed chrome jack, the other on a module inside the pan/zoomed
          canvas. The pending preview also lives here while this page is
          up, so it is never clipped at the canvas edge. */}
      {props.overlayContainer && (
        <div className="decks-chrome-overlay" data-testid="decks-chrome-overlay">
          <WireOverlay
            wires={chromeWires}
            container={props.overlayContainer}
            colors={props.wireColors}
            pending={pending}
            zoom={1}
            // The dock's own geometry is part of the layout: its height
            // changes by an inline style on a `.decks-chrome` element,
            // which the overlay's mutation filter ignores by design, so
            // the key is what re-measures the chrome ends every frame of
            // a resize and on collapse.
            layoutKey={`${props.overlayLayoutKey ?? ''}|${collapsed ? 'shut' : dockHeight}`}
          />
        </div>
      )}

      {picking !== null && (
        <DecksClipPicker
          deck={picking + 1}
          clips={clips}
          onClose={() => setPicking(null)}
          onPick={(clip) => {
            const slot = picking;
            setPicking(null);
            void write(() => api.load(bank, slot, clip.clipId));
          }}
        />
      )}
    </div>
  );
}

function clampBpm(bpm: number): number {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}

function controlValue(slot: DeckSlotStatus | undefined, control: SlotControl): number {
  if (!slot) return NaN;
  switch (control) {
    case 'mute':
      return slot.mute ? 1 : 0;
    case 'monitor':
      return slot.monitor ? 1 : 0;
    case 'insert_monitor':
      return slot.insert_monitor ? 1 : 0;
    default:
      return slot[control];
  }
}

/** The slot as the page should draw it: engine state, with any control
 *  the user is still holding shown where they are holding it. */
function withDrafts(
  slot: DeckSlotStatus,
  drafts: Partial<Record<DraftKey, number>>,
): DeckSlotStatus {
  let out = slot;
  const controls: SlotControl[] = [
    'level',
    'high',
    'mid',
    'low',
    'wet',
    'mute',
    'monitor',
    'insert_monitor',
  ];
  for (const control of controls) {
    const draft = drafts[`${slot.slot}:${control}`];
    if (draft === undefined) continue;
    if (out === slot) out = { ...slot };
    if (control === 'mute' || control === 'monitor' || control === 'insert_monitor')
      out[control] = draft >= 1;
    else out[control] = draft;
  }
  return out;
}
