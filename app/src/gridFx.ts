// A Grid track's EFFECTS RACK: the modules, cables and chrome controls
// that belong to one row of one grid.
//
// This is the state, and it is PURE — the modal that draws it
// (components/GridFxModal.tsx) reuses the rack's own panels, so nothing
// about a module lives here except its type, where it sits and the
// values its knobs have been turned to. Values, not knob POSITIONS: a
// position only means something against a manifest (which arrives from
// the engine at render time), while "the multiplier is 2x" is true on
// its own and survives a manifest whose range changed.
//
// The rack hangs off the row inside the grid document (`GridRow.fx`), so
// it travels with the arrangement and comes back on reload. A row that
// has never been touched stores NOTHING: `defaultTrackFx()` is what the
// modal shows and what `isTrackFxModified` compares against, which is
// also what tells the Grid page whether to light the row's button.
//
// The rack does not process sound yet — the Grid plays in the webview
// and the modules are the engine's. The two chrome controls that need no
// DSP to mean something are wired to the transport anyway: `level` is
// the row's BASELINE gain (its automation is read against it) and `pan`
// places the row in the stereo field.

import type { WireSnapshot } from './engine';

/** The rack's edge, drawn as chrome above it rather than as a panel: the
 *  grid's clock and the track's audio, which are what a per-track rack
 *  has to reach. Reserved as an instance id — a module can never take
 *  it, so a cable to `chrome:outL` is never ambiguous. */
export const FX_CHROME = 'chrome';

/** Chrome jacks. The outputs are what the TRACK sends into the rack (its
 *  clock and its audio); the inputs are what the rack sends back. Mono
 *  is just L, which is why the pairs are separate jacks rather than one
 *  stereo jack. */
export const FX_CLOCK = 'clock';
export const FX_OUT_L = 'outL';
export const FX_OUT_R = 'outR';
export const FX_IN_L = 'inL';
export const FX_IN_R = 'inR';

export const FX_CHROME_OUTPUTS = [
  { id: FX_CLOCK, name: 'Clock' },
  { id: FX_OUT_L, name: 'Out L' },
  { id: FX_OUT_R, name: 'Out R' },
] as const;

export const FX_CHROME_INPUTS = [
  { id: FX_IN_L, name: 'In L' },
  { id: FX_IN_R, name: 'In R' },
] as const;

/** One module in a track's rack. `values` holds only the knobs turned
 *  away from their manifest default, keyed by input jack id. */
export interface FxModule {
  id: string;
  type: string;
  x: number;
  y: number;
  values: Record<string, number>;
}

/** A cable, in the same shape the rack's own overlay draws
 *  (`WireOverlay`), so the two need no translation between them. */
export type FxWire = WireSnapshot;

export interface TrackFx {
  /** The row's BASELINE gain: 1 is unity, and the row's level automation
   *  is read against it (`levelRamp` multiplies the two). */
  level: number;
  /** −1 hard left … +1 hard right. */
  pan: number;
  /** 0 = the original signal alone, 1 = the rack's alone. */
  wet: number;
  modules: FxModule[];
  wires: FxWire[];
}

export const FX_LEVEL_MAX = 2;

export const FX_EQ = 'com.dj.eq';
export const FX_SCOPE = 'com.dj.scope';
export const FX_CLOCK_MULT = 'com.dj.clock_mult';
export const FX_LFO = 'com.dj.lfo';

/** Where the default rack's four panels sit, on the rack's own coarse
 *  grid (`GRID` in ModulePanel). */
const COL2 = 384;
const ROW2 = 288;

export function fxWire(
  from_instance: string,
  from_jack: string,
  to_instance: string,
  to_jack: string,
): FxWire {
  return { from_instance, from_jack, to_instance, to_jack };
}

/** The rack every track starts with: an EQ across the mono (L) path with
 *  a scope watching what leaves it, and a clock multiplier at 2x driving
 *  an LFO that is not patched into anything yet — the modulation is
 *  there, waiting to be aimed. */
export function defaultTrackFx(): TrackFx {
  return {
    level: 1,
    pan: 0,
    wet: 1,
    modules: [
      { id: 'eq1', type: FX_EQ, x: 0, y: 0, values: {} },
      { id: 'scope1', type: FX_SCOPE, x: COL2, y: 0, values: {} },
      { id: 'clockmult1', type: FX_CLOCK_MULT, x: 0, y: ROW2, values: { mult: 2 } },
      { id: 'lfo1', type: FX_LFO, x: COL2, y: ROW2, values: {} },
    ],
    wires: [
      fxWire(FX_CHROME, FX_OUT_L, 'eq1', 'in'),
      fxWire('eq1', 'out', 'scope1', 'in'),
      fxWire('scope1', 'thru', FX_CHROME, FX_IN_L),
      fxWire(FX_CHROME, FX_CLOCK, 'clockmult1', 'clock'),
      fxWire('clockmult1', 'out', 'lfo1', 'clock'),
    ],
  };
}

/** A row with no rack of its own plays through the default one. */
export function fxOrDefault(fx: TrackFx | null | undefined): TrackFx {
  return fx ?? defaultTrackFx();
}

const clampTo = (v: number, lo: number, hi: number, fallback: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

export const clampFxLevel = (v: number): number => clampTo(v, 0, FX_LEVEL_MAX, 1);
export const clampFxPan = (v: number): number => clampTo(v, -1, 1, 0);
export const clampFxWet = (v: number): number => clampTo(v, 0, 1, 1);

/** Has this rack been touched? Anything the user can change — a knob, a
 *  cable, a module, a panel's place, the chrome's three controls — makes
 *  it true, and undoing that change makes it false again, because the
 *  answer is a comparison against the default rack and not a flag
 *  somebody has to remember to clear. It is what colors the row's
 *  button on the Grid page. */
export function isTrackFxModified(fx: TrackFx | null | undefined): boolean {
  if (!fx) return false;
  return JSON.stringify(canonical(fx)) !== JSON.stringify(canonical(defaultTrackFx()));
}

/** The GRAPH of a rack — modules (sans position) and wires — as the
 *  backend render spec (`dj_engine::track_fx::TrackFxSpec`), or null for
 *  a graph identical to the default rack's. Null is the "play dry"
 *  answer: the default rack is audibly neutral (flat EQ on the L path),
 *  so an untouched row costs no render and no second voice. Positions,
 *  level, pan and wetness are all outside the graph on purpose — moving
 *  a panel or riding the Wetness knob must not re-render audio. */
export function fxRenderSpec(fx: TrackFx | null | undefined): string | null {
  if (!fx) return null;
  const graph = (f: TrackFx) =>
    JSON.stringify({
      modules: f.modules.map((m) => ({
        id: m.id,
        type: m.type,
        values: Object.fromEntries(Object.entries(m.values).sort(([a], [b]) => a.localeCompare(b))),
      })),
      wires: f.wires.map((w) => ({
        from_instance: w.from_instance,
        from_jack: w.from_jack,
        to_instance: w.to_instance,
        to_jack: w.to_jack,
      })),
    });
  const spec = graph(fx);
  return spec === graph(defaultTrackFx()) ? null : spec;
}

/** The same rack written the same way twice, so two of them can be
 *  compared as text (key order is what a hand-built object gets wrong). */
function canonical(fx: TrackFx): unknown {
  return {
    level: fx.level,
    pan: fx.pan,
    wet: fx.wet,
    modules: fx.modules.map((m) => ({
      id: m.id,
      type: m.type,
      x: m.x,
      y: m.y,
      values: Object.fromEntries(Object.entries(m.values).sort(([a], [b]) => a.localeCompare(b))),
    })),
    wires: fx.wires.map((w) => [w.from_instance, w.from_jack, w.to_instance, w.to_jack]),
  };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** An instance id nothing in the rack (and not the chrome) is using. */
export function nextFxId(typeId: string, taken: ReadonlySet<string>): string {
  const base = typeId.split('.').pop() ?? 'mod';
  const short = base.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'mod';
  for (let n = 1; ; n += 1) {
    const id = `${short}${n}`;
    if (id !== FX_CHROME && !taken.has(id)) return id;
  }
}

export function addFxModule(fx: TrackFx, typeId: string, x = 0, y = 0): TrackFx {
  const id = nextFxId(typeId, new Set(fx.modules.map((m) => m.id)));
  return { ...fx, modules: [...fx.modules, { id, type: typeId, x, y, values: {} }] };
}

/** Take a module out, and its cables with it — a cable to a panel that
 *  is gone anchors on nothing and would simply not be drawn. */
export function removeFxModule(fx: TrackFx, id: string): TrackFx {
  return {
    ...fx,
    modules: fx.modules.filter((m) => m.id !== id),
    wires: fx.wires.filter((w) => w.from_instance !== id && w.to_instance !== id),
  };
}

export function moveFxModule(fx: TrackFx, id: string, x: number, y: number): TrackFx {
  return { ...fx, modules: fx.modules.map((m) => (m.id === id ? { ...m, x, y } : m)) };
}

/** Turn a knob. `value` is the engine value the position maps to, and
 *  `defaultValue` (the manifest's) is what makes an untouched knob store
 *  nothing — a rack left alone is the default rack. */
export function setFxValue(
  fx: TrackFx,
  instance: string,
  jack: string,
  value: number,
  defaultValue?: number,
): TrackFx {
  return {
    ...fx,
    modules: fx.modules.map((m) => {
      if (m.id !== instance) return m;
      const values = { ...m.values };
      if (defaultValue !== undefined && value === defaultValue) delete values[jack];
      else values[jack] = value;
      return { ...m, values };
    }),
  };
}

export function fxValue(m: FxModule, jack: string, fallback: number): number {
  const v = m.values[jack];
  return v === undefined || !Number.isFinite(v) ? fallback : v;
}

const sameWire = (a: FxWire, b: FxWire): boolean =>
  a.from_instance === b.from_instance &&
  a.from_jack === b.from_jack &&
  a.to_instance === b.to_instance &&
  a.to_jack === b.to_jack;

/** Patch an output into an input. An input takes ONE cable (plugging a
 *  second one into it replaces the first, the way a socket does), an
 *  output fans out to as many as it likes. */
export function connectFx(fx: TrackFx, from: FxJack, to: FxJack): TrackFx {
  const wire = fxWire(from.instance, from.jack, to.instance, to.jack);
  const kept = fx.wires.filter(
    (w) => !(w.to_instance === to.instance && w.to_jack === to.jack) && !sameWire(w, wire),
  );
  return { ...fx, wires: [...kept, wire] };
}

export function disconnectFx(fx: TrackFx, wire: FxWire): TrackFx {
  return { ...fx, wires: fx.wires.filter((w) => !sameWire(w, wire)) };
}

export interface FxJack {
  instance: string;
  jack: string;
}

/** A jack armed as one end of a cable. */
export interface FxPending extends FxJack {
  kind: 'input' | 'output';
}

/** The rack's patching gesture, exactly the grammar the main rack uses
 *  (App.onJackClick): a click arms a jack, a click on the opposite kind
 *  lands the cable, a click on the same jack disarms, and shift+click
 *  unplugs the jack's most recent cable. Clicking a wired input with
 *  nothing armed PICKS THE CABLE UP — it comes off but stays armed from
 *  its source, so it can be dropped somewhere else. */
export function fxJackClick(
  fx: TrackFx,
  pending: FxPending | null,
  click: FxPending & { shift?: boolean },
): { fx: TrackFx; pending: FxPending | null } {
  const { instance, jack, kind, shift } = click;
  if (shift) {
    const attached = fx.wires.filter((w) =>
      kind === 'input'
        ? w.to_instance === instance && w.to_jack === jack
        : w.from_instance === instance && w.from_jack === jack,
    );
    const last = attached[attached.length - 1];
    return { fx: last ? disconnectFx(fx, last) : fx, pending };
  }
  if (pending) {
    if (pending.instance === instance && pending.jack === jack && pending.kind === kind) {
      return { fx, pending: null };
    }
    if (pending.kind !== kind) {
      const armed = { instance: pending.instance, jack: pending.jack };
      const from = kind === 'input' ? armed : { instance, jack };
      const to = kind === 'input' ? { instance, jack } : armed;
      return { fx: connectFx(fx, from, to), pending: null };
    }
    return { fx, pending: { instance, jack, kind } };
  }
  if (kind === 'input') {
    const existing = fx.wires.find((w) => w.to_instance === instance && w.to_jack === jack);
    if (existing) {
      return {
        fx: disconnectFx(fx, existing),
        pending: { instance: existing.from_instance, jack: existing.from_jack, kind: 'output' },
      };
    }
  }
  return { fx, pending: { instance, jack, kind } };
}

/** Is this jack holding a cable? (What draws a jack as plugged in.) */
export function fxJackWired(fx: TrackFx, instance: string, jack: string): boolean {
  return fx.wires.some(
    (w) =>
      (w.from_instance === instance && w.from_jack === jack) ||
      (w.to_instance === instance && w.to_jack === jack),
  );
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** Read a row's rack out of a saved grid. A missing or unreadable rack
 *  is `undefined` — the row plays through the default one, the same as a
 *  file written before racks existed. */
export function parseTrackFx(raw: unknown): TrackFx | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const fx = raw as Partial<TrackFx>;
  if (!Array.isArray(fx.modules) || !Array.isArray(fx.wires)) return undefined;
  return {
    level: clampFxLevel(Number(fx.level ?? 1)),
    pan: clampFxPan(Number(fx.pan ?? 0)),
    wet: clampFxWet(Number(fx.wet ?? 1)),
    modules: fx.modules.map((m, i) => ({
      id: String(m?.id ?? `mod${i + 1}`),
      type: String(m?.type ?? ''),
      x: Number(m?.x ?? 0) || 0,
      y: Number(m?.y ?? 0) || 0,
      values: parseValues(m?.values),
    })),
    wires: fx.wires.map((w) =>
      fxWire(
        String(w?.from_instance ?? ''),
        String(w?.from_jack ?? ''),
        String(w?.to_instance ?? ''),
        String(w?.to_jack ?? ''),
      ),
    ),
  };
}

function parseValues(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}
