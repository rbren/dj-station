// The Decks page: eight Beatify clips on one clock, as eight channel
// strips under one tempo, with the rack they can be routed through above
// them.
//
// The page is a big panel for a single rack module (`builtin.decks`) — the
// bank is in the patch and keeps playing when the tab is not looking, so
// this file only reads its state and writes edits back. Everything the
// page shows comes from ONE poll of `decks_status` (the engine owns the
// phase arithmetic, the stretch and the alignment), which is what keeps
// the page and a Launch Control XL saying the same thing: the hardware
// writes the same state through the same commands.
//
// The rack strip and the cables are the PATCH's own modules and wires,
// through the same engine commands the Rack tab uses; the graph is
// polled only when it can have changed (mount, and after an edit made
// here), because a structural snapshot is not telemetry.
//
// The one piece of local state is a DRAFT of a control being dragged: a
// fader streams faster than the poll, so the drag's value wins until the
// engine's own reading agrees with it. Drafts converge and clear
// themselves — there is no timer, and no "who is right" ambiguity.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  audioOutputs as defaultOutputs,
  type AudioOutputSettings,
  type AudioOutputsApi,
} from '../audioOutputs';
import { beatClip as defaultClips, type BeatClipApi, type BeatClipEntry } from '../beatClip';
import {
  decks as defaultApi,
  CLOCK_JACK,
  DECKS_TYPE,
  MAX_BPM,
  MIN_BPM,
  type DecksApi,
  type DecksStatus,
  type DeckSlotStatus,
  type SlotControl,
} from '../decks';
import { engine as defaultEngine, type EngineApi, type WireSnapshot } from '../engine';
import type { NodeSnapshot } from '../engine';
import type { Manifest } from '../types';
import { DecksClipPicker } from './DecksClipPicker';
import { DecksRack } from './DecksRack';
import { DecksSlot } from './DecksSlot';
import { LiveJack } from './Jack';
import { WireOverlay } from './WireOverlay';

const POLL_MS = 100;

export interface DecksViewProps {
  api?: DecksApi;
  clips?: BeatClipApi;
  /** The patch graph the rack strip shows and patches. */
  rack?: EngineApi;
  outputs?: AudioOutputsApi;
  /** The page keeps polling only while it is the open tab. */
  active?: boolean;
  pollMs?: number;
}

type DraftKey = `${number}:${SlotControl}`;

/** A jack armed as one end of a wire. */
interface Pending {
  instance: string;
  jack: string;
  kind: 'input' | 'output';
}

export function DecksView(props: DecksViewProps) {
  const api = props.api ?? defaultApi;
  const clipApi = props.clips ?? defaultClips;
  const rackApi = props.rack ?? defaultEngine;
  const outputsApi = props.outputs ?? defaultOutputs;
  const active = props.active ?? true;
  const [bank, setBank] = useState<string | null>(null);
  const [status, setStatus] = useState<DecksStatus | null>(null);
  const [clips, setClips] = useState<BeatClipEntry[]>([]);
  const [picking, setPicking] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Partial<Record<DraftKey, number>>>({});
  const [bpmDraft, setBpmDraft] = useState<number | null>(null);
  const [nodes, setNodes] = useState<NodeSnapshot[]>([]);
  const [wires, setWires] = useState<WireSnapshot[]>([]);
  const [modules, setModules] = useState<Manifest[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [outputs, setOutputs] = useState<AudioOutputSettings | null>(null);
  const [patchEl, setPatchEl] = useState<HTMLElement | null>(null);
  // Scrolling the rack or the decks moves their jacks under a cable
  // layer that does not scroll with them, so it is a re-measure.
  const [scrolled, setScrolled] = useState(0);
  const rehydrated = useRef(false);

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

  /** Re-read the patch graph. Structural, so it is called after edits
   *  rather than on the status poll's clock. */
  const refreshRack = useCallback(async () => {
    const [n, w] = await Promise.all([rackApi.nodes(), rackApi.wires()]);
    if (n) setNodes(n);
    if (w) setWires(w);
  }, [rackApi]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      const found = await api.banks();
      if (!cancelled && found) setBank(found[0] ?? null);
      const list = await clipApi.list();
      if (!cancelled && list) setClips(list);
      const lib = await rackApi.listModules();
      if (!cancelled && lib) setModules(lib);
      const outs = await outputsApi.get();
      if (!cancelled && outs) setOutputs(outs);
      if (!cancelled) await refreshRack();
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
  }, [api, clipApi, rackApi, outputsApi, refreshRack, active]);

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
    if (created) setBank(created);
  }, [api]);

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

  const wiredJack = useCallback(
    (instance: string, jack: string, kind: 'input' | 'output') =>
      wires.some((w) =>
        kind === 'input'
          ? w.to_instance === instance && w.to_jack === jack
          : w.from_instance === instance && w.from_jack === jack,
      ),
    [wires],
  );

  /** One click on a jack: arm it, complete the wire it finishes, or pull
   *  out the cable already in it — the Rack tab's own grammar, without
   *  the cable colors (nothing here is dragged around a canvas). */
  const onJack = useCallback(
    async (instance: string, jack: string, kind: 'input' | 'output') => {
      if (pending) {
        const same =
          pending.instance === instance && pending.jack === jack && pending.kind === kind;
        if (same) {
          setPending(null);
          return;
        }
        if (pending.kind !== kind) {
          const armed = { instance: pending.instance, jack: pending.jack };
          const from = kind === 'input' ? armed : { instance, jack };
          const to = kind === 'input' ? { instance, jack } : armed;
          setPending(null);
          await rackApi.connectWire(from, to);
          await refreshRack();
          void poll();
          return;
        }
        setPending({ instance, jack, kind });
        return;
      }
      // A wired input's cable comes out; anything else arms a wire.
      if (kind === 'input') {
        const existing = wires.find((w) => w.to_instance === instance && w.to_jack === jack);
        if (existing) {
          await rackApi.disconnectWire(
            { instance: existing.from_instance, jack: existing.from_jack },
            { instance, jack },
          );
          await refreshRack();
          void poll();
          return;
        }
      }
      setPending({ instance, jack, kind });
    },
    [pending, rackApi, refreshRack, poll, wires],
  );

  const addModule = useCallback(
    async (typeId: string) => {
      const base = typeId.split('.').pop() ?? 'module';
      const taken = new Set(nodes.map((n) => n.instance_id));
      let instance = base;
      for (let i = 2; taken.has(instance); i++) instance = `${base}${i}`;
      await rackApi.addModule(instance, typeId);
      await refreshRack();
    },
    [nodes, rackApi, refreshRack],
  );

  const removeModule = useCallback(
    async (instance: string) => {
      await rackApi.removeModule(instance);
      setPending((p) => (p?.instance === instance ? null : p));
      await refreshRack();
      void poll();
    },
    [rackApi, refreshRack, poll],
  );

  const setOutput = useCallback(
    async (bus: 'live' | 'monitor', device: string | null) => {
      const next = { ...(outputs ?? { devices: [], live: null, monitor: null }), [bus]: device };
      setOutputs(next);
      await outputsApi.set(next.live, next.monitor);
      const fresh = await outputsApi.get();
      if (fresh) setOutputs(fresh);
    },
    [outputs, outputsApi],
  );

  const bpm = bpmDraft ?? status?.bpm ?? 120;
  const slots = useMemo(() => status?.slots ?? [], [status]);
  const shownSlots = useMemo(() => slots.map((s) => withDrafts(s, drafts)), [slots, drafts]);
  // The bank is drawn as the decks themselves, so it is not a card in the
  // rack grid above them.
  const rackNodes = useMemo(() => nodes.filter((n) => n.type_id !== DECKS_TYPE), [nodes]);

  if (!bank) {
    return (
      <div className="decks-view" data-testid="decks-view">
        <p className="empty-state" data-testid="decks-empty">
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
      <header className="decks-bar">
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
          </span>
          <span className="decks-cycle" data-testid="decks-cycle">
            {status && status.cycle_beats > 0
              ? `bank comes round every ${status.cycle_beats} beats`
              : 'nothing loaded'}
          </span>
          {/* The bank's clock, on a jack: the rack can be driven by the
              same beat the decks are on. */}
          <span className="decks-clock-jack" data-testid="decks-clock-jack">
            <LiveJack
              instance={bank}
              id={CLOCK_JACK}
              kind="output"
              label="clock"
              wired={wiredJack(bank, CLOCK_JACK, 'output')}
              selected={
                pending?.instance === bank &&
                pending.jack === CLOCK_JACK &&
                pending.kind === 'output'
              }
              onClick={() => void onJack(bank, CLOCK_JACK, 'output')}
            />
          </span>
        </div>
        <div className="decks-outputs" data-testid="decks-outputs">
          {(['live', 'monitor'] as const).map((bus) => (
            <label className="decks-output" key={bus}>
              <span className="decks-output-label">{bus}</span>
              <select
                data-testid={`decks-output-${bus}`}
                aria-label={`${bus} audio output`}
                value={outputs?.[bus] ?? ''}
                onChange={(e) => void setOutput(bus, e.target.value || null)}
              >
                <option value="">system default</option>
                {(outputs?.devices ?? []).map((device) => (
                  <option key={device} value={device}>
                    {device}
                  </option>
                ))}
                {/* A remembered device that is not plugged in today still
                    has to be shown, or the picker would silently say
                    something the engine does not. */}
                {outputs?.[bus] && !outputs.devices.includes(outputs[bus]) && (
                  <option value={outputs[bus]}>{outputs[bus]} (not found)</option>
                )}
              </select>
            </label>
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
          <button data-testid="decks-restart" onClick={() => void write(() => api.reset(bank))}>
            Restart
          </button>
        </div>
      </header>

      {/* Rack and decks share one patch area so the cables between them
          are one overlay, measured off the jack sockets in both. */}
      <div
        className="decks-patch"
        data-testid="decks-patch"
        ref={setPatchEl}
        onScrollCapture={() => setScrolled((n) => n + 1)}
      >
        <DecksRack
          nodes={rackNodes}
          modules={modules}
          onAdd={(typeId) => void addModule(typeId)}
          onRemove={(instance) => void removeModule(instance)}
          onJack={(instance, jack, kind) => void onJack(instance, jack, kind)}
          isArmed={(instance, jack, kind) =>
            pending?.instance === instance && pending.jack === jack && pending.kind === kind
          }
          isWired={wiredJack}
        />

        <div className="decks-strips" data-testid="decks-strips">
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
              onJack={(jack, kind) => void onJack(bank, jack, kind)}
              isArmed={(jack, kind) =>
                pending?.instance === bank && pending.jack === jack && pending.kind === kind
              }
              isWired={(jack, kind) => wiredJack(bank, jack, kind)}
            />
          ))}
        </div>

        <WireOverlay
          wires={wires}
          container={patchEl}
          pending={pending ? { ...pending, color: 0 } : null}
          layoutKey={`${scrolled}:${rackNodes.length}:${shownSlots.map((s) => s.beats).join(',')}`}
        />
      </div>

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
