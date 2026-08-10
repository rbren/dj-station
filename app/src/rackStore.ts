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
}

export interface RackStore {
  getState(): RackState;
  set(patch: Partial<RackState>): void;
  /** Replace nodes, keeping the previous object for any node whose snapshot
   *  is unchanged so memoized panels skip re-rendering. */
  setNodes(nodes: NodeSnapshot[]): void;
  /** Replace telemetry, keeping per-instance slice identity when nothing
   *  moved (an idle rack causes zero re-renders). */
  setTelemetry(telemetry: RackTelemetry): void;
  subscribe(listener: () => void): () => void;
}

export const POSITIONS_KEY = 'dj-rack-positions';

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

function telemetrySliceEqual(
  a: Record<string, JackTelemetry>,
  b: Record<string, JackTelemetry>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const k of aKeys) {
    const x = a[k];
    const y = b[k];
    if (!y) return false;
    if (
      x.instantaneous !== y.instantaneous ||
      x.rms_100ms !== y.rms_100ms ||
      x.display !== y.display ||
      x.is_fast !== y.is_fast
    ) {
      return false;
    }
  }
  return true;
}

export function createRackStore(): RackStore {
  let state: RackState = {
    nodes: [],
    wires: [],
    telemetry: {},
    positions: loadJson<Positions>(POSITIONS_KEY, {}),
    selected: [],
    pending: null,
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
      const unchanged =
        stabilized.length === state.nodes.length &&
        stabilized.every((n, i) => n === state.nodes[i]);
      if (unchanged) return;
      state = { ...state, nodes: stabilized };
      notify();
    },
    setTelemetry(next) {
      const prev = state.telemetry;
      const out: RackTelemetry = {};
      let allSame = Object.keys(prev).length === Object.keys(next).length;
      for (const [id, jacks] of Object.entries(next)) {
        const p = prev[id];
        if (p && telemetrySliceEqual(p, jacks)) {
          out[id] = p;
        } else {
          out[id] = jacks;
          allSame = false;
        }
      }
      if (allSame) return;
      state = { ...state, telemetry: out };
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
