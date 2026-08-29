// The Decks page: eight Beatify clips on one clock, as eight channel
// strips under one tempo — CHROME around the real rack canvas. App keeps
// the one rack (`.rack-area`, panels, wire overlay, pan/zoom) mounted and
// visible on this tab, and this component renders the deck furniture
// around it: the tempo bar (with the bank's clock on a jack) above, the
// eight strips (each with its send/return and tone-CV jacks) below.
//
// The page is a big panel for a single rack module (`builtin.decks`) — the
// bank is in the patch and keeps RUNNING when the tab is not looking (it
// is the OUTPUT that the open page owns, see `audioFocusForView`), so
// this file only reads its state and writes edits back. Everything the
// page shows comes from ONE poll of `decks_status` (the engine owns the
// phase arithmetic and the stretch), which is what keeps
// the page and a Launch Control XL saying the same thing: the hardware
// writes the same state through the same commands.
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { beatClip as defaultClips, type BeatClipApi, type BeatClipEntry } from '../beatClip';
import {
  decks as defaultApi,
  CLOCK_JACK,
  MAX_BPM,
  MIN_BPM,
  type DecksApi,
  type DecksStatus,
  type DeckSlotStatus,
  type SlotControl,
} from '../decks';
import type { WireSnapshot } from '../engine';
import { loadJson, saveJson, type PendingWire } from '../rackStore';
import { DecksClipPicker } from './DecksClipPicker';
import { DecksSlot } from './DecksSlot';
import { LiveJack } from './Jack';
import { WIRE_COLORS, WireOverlay } from './WireOverlay';

const POLL_MS = 100;

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
  const [bpmDraft, setBpmDraft] = useState<number | null>(null);
  const rehydrated = useRef(false);
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
    setStatus(st);
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
  // (overlayLayoutKey). A bank jack with no chrome socket (bpm, the mix
  // pairs) simply does not resolve, and its cable is not drawn here.
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

  const setControl = useCallback(
    (slot: number, control: SlotControl, value: number) => {
      if (!bank) return;
      setDrafts((d) => ({ ...d, [`${slot}:${control}`]: value }));
      void write(() => api.setControl(bank, slot, control, value));
    },
    [api, bank, write],
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

  const bpm = bpmDraft ?? status?.bpm ?? 120;
  const slots = useMemo(() => status?.slots ?? [], [status]);
  const shownSlots = useMemo(() => slots.map((s) => withDrafts(s, drafts)), [slots, drafts]);

  if (!bank) {
    return (
      <div className="decks-view" data-testid="decks-view">
        <p className="empty-state decks-empty-bar" data-testid="decks-empty">
          A deck bank plays eight Beatify clips together, on one tempo.
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
        <div className="decks-tempo">
          <label className="decks-tempo-label" htmlFor="decks-bpm">
            Tempo
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
            onChange={(e) => {
              const next = Number(e.target.value);
              if (!Number.isFinite(next)) return;
              setBpmDraft(next);
              void write(() => api.setBpm(bank, clampBpm(next)));
            }}
            onBlur={() => {
              setBpmDraft(null);
              void api.endEdit();
            }}
          />
          <span className="decks-tempo-unit">BPM</span>
          <input
            className="decks-tempo-slider"
            data-testid="decks-bpm-slider"
            type="range"
            aria-label="Bank tempo"
            min={MIN_BPM}
            max={MAX_BPM}
            step={0.5}
            value={bpm}
            onChange={(e) => {
              const next = Number(e.target.value);
              setBpmDraft(next);
              void write(() => api.setBpm(bank, next));
            }}
            onPointerUp={() => {
              setBpmDraft(null);
              void api.endEdit();
            }}
          />
        </div>
        <div className="decks-readout">
          <span className="decks-beat mono" data-testid="decks-beat">
            beat {Math.floor(status?.beat ?? 0) + 1}
            {status && status.cycle_beats > 0 ? `/${status.cycle_beats}` : ''}
          </span>
          {(!status || status.cycle_beats <= 0) && (
            <span className="decks-cycle" data-testid="decks-cycle">
              nothing loaded
            </span>
          )}
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
          <button data-testid="decks-restart" onClick={() => void write(() => api.reset(bank))}>
            Restart
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
                onTail={(tail) => void write(() => api.setTail(bank, slot.slot, Math.max(0, tail)))}
                onPhase={(phase) => void write(() => api.setPhase(bank, slot.slot, phase))}
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
            void write(() => api.load(bank, slot, clip.projectId, clip.clipId));
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
  for (const control of ['level', 'high', 'mid', 'low', 'mute', 'monitor'] as SlotControl[]) {
    const draft = drafts[`${slot.slot}:${control}`];
    if (draft === undefined) continue;
    if (out === slot) out = { ...slot };
    if (control === 'mute' || control === 'monitor') out[control] = draft >= 1;
    else out[control] = draft;
  }
  return out;
}
