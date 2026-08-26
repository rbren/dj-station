// The Decks page: eight Beatify clips on one clock, as eight channel
// strips under one tempo.
//
// The page is a big panel for a single rack module (`builtin.decks`) — the
// bank is in the patch and keeps playing when the tab is not looking, so
// this file only reads its state and writes edits back. Everything the
// page shows comes from ONE poll of `decks_status` (the engine owns the
// phase arithmetic, the stretch and the alignment), which is what keeps
// the page and a Launch Control XL saying the same thing: the hardware
// writes the same state through the same commands.
//
// The one piece of local state is a DRAFT of a control being dragged: a
// fader streams faster than the poll, so the drag's value wins until the
// engine's own reading agrees with it. Drafts converge and clear
// themselves — there is no timer, and no "who is right" ambiguity.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { beatClip as defaultClips, type BeatClipApi, type BeatClipEntry } from '../beatClip';
import {
  decks as defaultApi,
  MAX_BPM,
  MIN_BPM,
  type DecksApi,
  type DecksStatus,
  type DeckSlotStatus,
  type SlotControl,
} from '../decks';
import { DecksClipPicker } from './DecksClipPicker';
import { DecksSlot } from './DecksSlot';

const POLL_MS = 100;

export interface DecksViewProps {
  api?: DecksApi;
  clips?: BeatClipApi;
  /** The page keeps polling only while it is the open tab. */
  active?: boolean;
  pollMs?: number;
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
      if (!cancelled && found) setBank(found[0] ?? null);
      const list = await clipApi.list();
      if (!cancelled && list) setClips(list);
    })();
    return () => {
      cancelled = true;
    };
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

  const bpm = bpmDraft ?? status?.bpm ?? 120;
  const slots = useMemo(() => status?.slots ?? [], [status]);
  const loadedSlots = slots.filter((s) => s.beats > 0).length;
  const shownSlots = useMemo(() => slots.map((s) => withDrafts(s, drafts)), [slots, drafts]);

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

      <div className="decks-strips" data-testid="decks-strips">
        {shownSlots.map((slot) => (
          <DecksSlot
            key={slot.slot}
            slot={slot}
            loadedSlots={loadedSlots}
            onLoad={() => setPicking(slot.slot)}
            onClear={() => void write(() => api.clear(bank, slot.slot))}
            onControl={(control, value) => setControl(slot.slot, control, value)}
            onToggle={(control) => setControl(slot.slot, control, slot[control] ? 0 : 1)}
            onTail={(tail) => void write(() => api.setTail(bank, slot.slot, Math.max(0, tail)))}
            onPhase={(phase) => void write(() => api.setPhase(bank, slot.slot, phase))}
            onRelease={() => void api.endEdit()}
          />
        ))}
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
    case 'solo':
      return slot.solo ? 1 : 0;
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
  for (const control of ['level', 'high', 'mid', 'low', 'mute', 'solo'] as SlotControl[]) {
    const draft = drafts[`${slot.slot}:${control}`];
    if (draft === undefined) continue;
    if (out === slot) out = { ...slot };
    if (control === 'mute' || control === 'solo') out[control] = draft >= 1;
    else out[control] = draft;
  }
  return out;
}
