// Rack state store: nodes, wires, telemetry, module positions, selection
// and the pending wire live outside React and are read through
// useSyncExternalStore selectors. Panels subscribe to their own slice, so a
// telemetry tick or a knob drag re-renders only the panels whose slice
// actually changed instead of the whole rack. No external store dependency:
// this is a ~hundred-line hand-rolled store (React's own
// useSyncExternalStore does the subscription work).
//
// The store is created per <App> mount (not module-level) so tests get a
// fresh one per render; it is handed to children via RackStoreContext.

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { NodeSnapshot, WireSnapshot } from './engine';
import type { JackTelemetry } from './types';

export type Positions = Record<string, { x: number; y: number }>;

/** A jack armed as one end of a wire, with the selected cable color. */
export interface PendingWire {
  instance: string;
  jack: string;
  kind: 'input' | 'output';
  color: number;
}

export type RackTelemetry = Record<string, Record<string, JackTelemetry>>;

export interface RackState {
  nodes: NodeSnapshot[];
  wires: WireSnapshot[];
  telemetry: RackTelemetry;
  positions: Positions;
  selected: string[];
  pending: PendingWire | null;
  /** User-chosen input jack colors (`instance:jack` → WIRE_COLORS index).
   *  Absent = no color. App-layer cosmetic state persisted in localStorage,
   *  like wire colors — never part of the patch. */
  inputColors: Record<string, number>;
}

export interface RackStore {
  getState(): RackState;
  set(patch: Partial<RackState>): void;
  /** Replace nodes, keeping the previous object for any node whose snapshot
   *  is unchanged so memoized panels skip re-rendering. Also prunes
   *  `selected` and `pending` of instances that no longer exist, so ghost
   *  selections can never survive an engine-side change (undo, patch load,
   *  collapse, paste). */
  setNodes(nodes: NodeSnapshot[]): void;
  /** Replace telemetry, keeping object identity per instance slice AND per
   *  jack when a reading is visually unchanged, so per-jack subscribers
   *  (useLiveJackTelemetry) re-render only for jacks that actually moved
   *  (an idle rack causes zero re-renders). */
  setTelemetry(telemetry: RackTelemetry): void;
  /** Set (or clear, with null) an input jack's color. */
  setInputColor(instance: string, jack: string, color: number | null): void;
  subscribe(listener: () => void): () => void;
}

export const POSITIONS_KEY = 'dj-rack-positions';
export const INPUT_COLORS_KEY = 'dj-input-colors';

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // persistence is best-effort
  }
}

/** Equality at DISPLAY resolution: readings are compared quantized to what
 *  the UI can actually show (indicator hue steps ~0.1 V, tooltips 2–3
 *  decimals), so a slowly-drifting-but-visually-steady signal is a no-op
 *  tick instead of a re-render. 0.005 V / 0.005 volatility grains are well
 *  below anything the glow or tooltip can resolve. */
const VALUE_GRAIN = 0.005;

function jackTelemetryEqual(x: JackTelemetry, y: JackTelemetry): boolean {
  const q = (v: number) => Math.round(v / VALUE_GRAIN);
  // Only the fields something renders (glow color, tooltips, meters, custom
  // UIs read display/volatility/is_fast) participate: `instantaneous` is a
  // raw sample that differs every tick on any live audio jack and nothing
  // in the UI shows it, so comparing it would force re-renders for
  // invisible changes. A stale `instantaneous` inside a kept object is
  // harmless for the same reason.
  return (
    q(x.display) === q(y.display) && q(x.volatility) === q(y.volatility) && x.is_fast === y.is_fast
  );
}

export function createRackStore(): RackStore {
  let state: RackState = {
    nodes: [],
    wires: [],
    telemetry: {},
    positions: loadJson<Positions>(POSITIONS_KEY, {}),
    selected: [],
    pending: null,
    inputColors: loadJson<Record<string, number>>(INPUT_COLORS_KEY, {}),
  };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  return {
    getState: () => state,
    set(patch) {
      state = { ...state, ...patch };
      notify();
    },
    setNodes(next) {
      const prevById = new Map(state.nodes.map((n) => [n.instance_id, n]));
      const stabilized = next.map((n) => {
        const prev = prevById.get(n.instance_id);
        return prev && JSON.stringify(prev) === JSON.stringify(n) ? prev : n;
      });
      const live = new Set(stabilized.map((n) => n.instance_id));
      const selected = state.selected.filter((id) => live.has(id));
      const pending = state.pending && !live.has(state.pending.instance) ? null : state.pending;
      const unchanged =
        stabilized.length === state.nodes.length &&
        stabilized.every((n, i) => n === state.nodes[i]) &&
        selected.length === state.selected.length &&
        pending === state.pending;
      if (unchanged) return;
      state = { ...state, nodes: stabilized, selected, pending };
      notify();
    },
    setTelemetry(next) {
      const prev = state.telemetry;
      const out: RackTelemetry = {};
      let allSame = Object.keys(prev).length === Object.keys(next).length;
      for (const [id, jacks] of Object.entries(next)) {
        const p = prev[id];
        if (!p) {
          out[id] = jacks;
          allSame = false;
          continue;
        }
        // Rebuild the instance slice reusing the previous object for every
        // jack that reads the same, so per-jack subscribers skip; if every
        // jack was reused (and none disappeared), reuse the slice itself.
        const jackIds = Object.keys(jacks);
        let sliceSame = jackIds.length === Object.keys(p).length;
        const slice: Record<string, JackTelemetry> = {};
        for (const k of jackIds) {
          const x = p[k];
          if (x && jackTelemetryEqual(x, jacks[k])) {
            slice[k] = x;
          } else {
            slice[k] = jacks[k];
            sliceSame = false;
          }
        }
        if (sliceSame) {
          out[id] = p;
        } else {
          out[id] = slice;
          allSame = false;
        }
      }
      if (allSame) return;
      state = { ...state, telemetry: out };
      notify();
    },
    setInputColor(instance, jack, color) {
      const key = `${instance}:${jack}`;
      const inputColors = { ...state.inputColors };
      if (color === null) delete inputColors[key];
      else inputColors[key] = color;
      saveJson(INPUT_COLORS_KEY, inputColors);
      state = { ...state, inputColors };
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const RackStoreContext = createContext<RackStore | null>(null);

/** Subscribe to a slice of an explicit store (used by App, which owns the
 *  store and cannot consume its own provider). Selectors must return stable
 *  references — pick slices off the state, don't build fresh objects. */
export function useStoreSelector<T>(store: RackStore, selector: (s: RackState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

/** Subscribe to a slice of the context store (used by rack children). */
export function useRackSelector<T>(selector: (s: RackState) => T): T {
  const store = useContext(RackStoreContext);
  if (!store) throw new Error('useRackSelector outside RackStoreContext');
  return useStoreSelector(store, selector);
}

const noopSubscribe = () => () => {};

/** One jack's live telemetry: subscribes to exactly that reading, so a
 *  telemetry tick re-renders only the jacks that moved — never the panel
 *  around them. Outside a RackStoreContext (docs previews, storeless unit
 *  tests) it returns `fallback` and never re-renders. `key` is the tap_all
 *  telemetry key: the input jack id, or `out:<id>` for outputs. */
export function useLiveJackTelemetry(
  instance: string,
  key: string,
  fallback?: JackTelemetry,
): JackTelemetry | undefined {
  const store = useContext(RackStoreContext);
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? () => store.getState().telemetry[instance]?.[key] ?? fallback : () => fallback,
  );
}

/** A module's whole live telemetry slice (identity-stable across unchanged
 *  ticks): re-renders the caller whenever ANY of the module's jacks moved.
 *  Used by the custom-UI host so meters/playheads that read
 *  `handle.signalTap()` at render time stay live without the whole panel
 *  re-rendering. Outside a store: undefined, never re-renders. */
export function useLiveInstanceTelemetry(
  instance: string,
): Record<string, JackTelemetry> | undefined {
  const store = useContext(RackStoreContext);
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? () => store.getState().telemetry[instance] : () => undefined,
  );
}
