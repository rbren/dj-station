// dj-station M0 shell: loads the demo patch into the engine (when running
// under Tauri), renders manifest-driven panels with live jack telemetry,
// a module library sidebar for adding modules, and click-to-wire jacks
// with an SVG cable overlay.

import { useCallback, useEffect, useMemo, useState } from 'react';
import AdsrUI from '../../extensions/adsr/ui-src/AdsrUI';
import { engine, type NodeSnapshot, type WireSnapshot } from './engine';
import { library, type Track } from './library';
import { DeckCustomUI, DeckUIContext } from './components/DeckPanel';
import { LibraryView } from './components/LibraryView';
import { GesturePanel } from './components/GesturePanel';
import { MidiPanel } from './components/MidiPanel';
import { MODULE_DRAG_TYPE, ModuleLibrary, nextInstanceId } from './components/ModuleLibrary';
import { GRID, ModulePanel, type JackRef } from './components/ModulePanel';
import { WIRE_COLORS, WireOverlay } from './components/WireOverlay';
import type { JackTelemetry, KnobConfig, Manifest, ModuleHandle } from './types';

/** Module types with a host-registered custom UI (PRD §5.3). */
const CUSTOM_UIS = {
  'com.dj.adsr': AdsrUI,
  'builtin.deck': DeckCustomUI,
} as const;

type Positions = Record<string, { x: number; y: number }>;

const POSITIONS_KEY = 'dj-rack-positions';

function loadPositions(): Positions {
  try {
    return JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

/** Default slot for modules without a saved position: 3 columns of
 *  grid-aligned cells below/right of existing modules. */
function defaultPosition(index: number): { x: number; y: number } {
  return { x: (index % 3) * GRID * 10, y: Math.floor(index / 3) * GRID * 8 };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rack rect for a module at `pos`, measured from its rendered panel
 *  (offset sizes ignore the zoom transform). Falls back to a nominal
 *  4×2-cell footprint for panels not yet in the DOM. */
function moduleRect(instance: string, pos: { x: number; y: number }): Rect {
  const el = document.querySelector<HTMLElement>(`[data-testid="module-${instance}"]`);
  return {
    x: pos.x,
    y: pos.y,
    w: el?.offsetWidth || GRID * 4,
    h: el?.offsetHeight || GRID * 2,
  };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const ZOOM_KEY = 'dj-rack-zoom';
const ZOOM_STEP = 1.2;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;

function loadZoom(): number {
  const z = Number(localStorage.getItem(ZOOM_KEY));
  return Number.isFinite(z) && z >= ZOOM_MIN && z <= ZOOM_MAX ? z : 1;
}

const WIRE_COLORS_KEY = 'dj-wire-colors';
const LAST_WIRE_COLOR_KEY = 'dj-wire-last-color';
const NUM_WIRE_COLORS = WIRE_COLORS.length;

/** A jack armed as one end of a wire, with the selected cable color. */
export interface PendingWire extends JackRef {
  kind: 'input' | 'output';
  color: number;
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // persistence is best-effort
  }
}

/** True when a shortcut keydown should be left to a form control. */
function isEditableTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'SELECT' ||
      t.tagName === 'TEXTAREA' ||
      t.isContentEditable)
  );
}

export default function App() {
  const [nodes, setNodes] = useState<NodeSnapshot[]>([]);
  const [wires, setWires] = useState<WireSnapshot[]>([]);
  const [moduleLib, setModuleLib] = useState<Manifest[]>([]);
  const [telemetry, setTelemetry] = useState<Record<string, Record<string, JackTelemetry>>>({});
  const [connected, setConnected] = useState<boolean | null>(null);
  const [backend, setBackend] = useState<string | null>(null);
  const [view, setView] = useState<'rack' | 'library'>('rack');
  const [pending, setPending] = useState<PendingWire | null>(null);
  const [wireColors, setWireColors] = useState<Record<string, number>>(() =>
    loadJson(WIRE_COLORS_KEY, {}),
  );
  const [patchName, setPatchName] = useState('untitled');
  const [patchList, setPatchList] = useState<string[]>([]);
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([]);
  // Multi-select for collapse-to-macro (PRD §6): shift-click panel headers.
  const [selected, setSelected] = useState<string[]>([]);
  const [collapseName, setCollapseName] = useState<string | null>(null);
  const [positions, setPositions] = useState<Positions>(() => loadPositions());
  const [zoom, setZoom] = useState<number>(() => loadZoom());
  // Callback ref (state, not useRef) so the overlay re-renders once the
  // rack element mounts.
  const [rackEl, setRackEl] = useState<HTMLDivElement | null>(null);

  const changeZoom = useCallback((direction: 1 | -1 | 0) => {
    setZoom((prev) => {
      const next =
        direction === 0 ? 1 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev * ZOOM_STEP ** direction));
      try {
        localStorage.setItem(ZOOM_KEY, String(next));
      } catch {
        // persistence is best-effort
      }
      return next;
    });
  }, []);

  const moveModule = useCallback(
    (instance: string, x: number, y: number) => {
      setPositions((prev) => {
        // Reject moves that would overlap another module: the dragged
        // panel simply stops against its neighbours.
        const rect = moduleRect(instance, { x, y });
        for (const [i, node] of nodes.entries()) {
          if (node.instance_id === instance) continue;
          const otherPos = prev[node.instance_id] ?? defaultPosition(i);
          if (rectsOverlap(rect, moduleRect(node.instance_id, otherPos))) return prev;
        }
        const next = { ...prev, [instance]: { x, y } };
        try {
          localStorage.setItem(POSITIONS_KEY, JSON.stringify(next));
        } catch {
          // persistence is best-effort
        }
        return next;
      });
    },
    [nodes],
  );

  const refresh = useCallback(async () => {
    const snapshot = await engine.nodes();
    setConnected(snapshot !== null);
    if (snapshot) setNodes(snapshot);
    const wireList = await engine.wires();
    if (wireList) setWires(wireList);
    const tracks = await library.tracks();
    if (tracks) setLibraryTracks(tracks);
  }, []);

  useEffect(() => {
    (async () => {
      await engine.loadDemoPatch();
      setBackend(await engine.start());
      const modules = await engine.listModules();
      if (modules) setModuleLib(modules);
      const current = await engine.currentPatch();
      if (current) setPatchName(current);
      setPatchList((await engine.listPatches()) ?? []);
      await refresh();
    })();
  }, [refresh]);

  const savePatch = useCallback(async () => {
    const name = patchName.trim() || 'untitled';
    await engine.savePatchAs(name);
    setPatchName(name);
    setPatchList((await engine.listPatches()) ?? []);
  }, [patchName]);

  const loadNamedPatch = useCallback(
    async (name: string) => {
      await engine.loadPatchByName(name);
      setPatchName(name);
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(async () => {
      const next: Record<string, Record<string, JackTelemetry>> = {};
      for (const node of nodes) {
        next[node.instance_id] = {};
        for (const input of node.manifest.inputs) {
          const t = await engine.tap(node.instance_id, input.id);
          if (t) next[node.instance_id][input.id] = t;
        }
      }
      setTelemetry(next);
    }, 100);
    return () => clearInterval(timer);
  }, [connected, nodes]);

  const addModule = useCallback(
    async (typeId: string, at?: { x: number; y: number }) => {
      const taken = new Set(nodes.map((n) => n.instance_id));
      const instance = nextInstanceId(typeId, taken);
      await engine.addModule(instance, typeId);
      if (at) {
        // Nudge the drop point down one grid row at a time until it does
        // not overlap an existing module.
        let y = at.y;
        for (let tries = 0; tries < 200; tries++) {
          const rect = moduleRect(instance, { x: at.x, y });
          const collides = nodes.some((node, i) => {
            const pos = positions[node.instance_id] ?? defaultPosition(i);
            return rectsOverlap(rect, moduleRect(node.instance_id, pos));
          });
          if (!collides) break;
          y += GRID;
        }
        moveModule(instance, at.x, y);
      }
      await refresh();
    },
    [nodes, positions, refresh, moveModule],
  );

  const toggleSelected = useCallback((instance: string) => {
    setSelected((prev) =>
      prev.includes(instance) ? prev.filter((i) => i !== instance) : [...prev, instance],
    );
  }, []);

  const collapseToMacro = useCallback(
    async (name: string) => {
      if (!name.trim() || selected.length === 0) return;
      await engine.collapseMacro(selected, name.trim());
      setSelected([]);
      setCollapseName(null);
      const modules = await engine.listModules();
      if (modules) setModuleLib(modules);
      await refresh();
    },
    [selected, refresh],
  );

  // Global shortcuts: undo/redo (cmd/ctrl+Z, cmd/ctrl+Y, cmd/ctrl+shift+Z)
  // and rack zoom (cmd/ctrl +/-/0).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPending(null);
        setCollapseName(null);
        setSelected([]);
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      // cmd/ctrl+S saves even while the patch-name input has focus.
      if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        void savePatch();
        return;
      }
      if (isEditableTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        void (e.shiftKey ? engine.redo() : engine.undo()).then(refresh);
      } else if (key === 'y') {
        e.preventDefault();
        void engine.redo().then(refresh);
      } else if (key === '=' || key === '+') {
        e.preventDefault();
        changeZoom(1);
      } else if (key === '-' || key === '_') {
        e.preventDefault();
        changeZoom(-1);
      } else if (key === '0') {
        e.preventDefault();
        changeZoom(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refresh, changeZoom, savePatch]);

  // Drop a module dragged out of the library at the pointer position,
  // snapped to the rack grid (in unzoomed rack coordinates).
  const onRackDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(MODULE_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onRackDrop = useCallback(
    (e: React.DragEvent) => {
      const typeId = e.dataTransfer.getData(MODULE_DRAG_TYPE);
      if (!typeId) return;
      e.preventDefault();
      let at: { x: number; y: number } | undefined;
      if (rackEl) {
        const rect = rackEl.getBoundingClientRect();
        const snap = (v: number) => Math.max(0, Math.round(v / zoom / GRID) * GRID);
        at = {
          x: snap(e.clientX - rect.left + rackEl.scrollLeft),
          y: snap(e.clientY - rect.top + rackEl.scrollTop),
        };
      }
      void addModule(typeId, at);
    },
    [rackEl, zoom, addModule],
  );

  const onJackClick = useCallback(
    async (instance: string, kind: 'input' | 'output', jack: string) => {
      if (pending) {
        // Re-clicking the armed jack cycles through the 8 cable colors.
        if (pending.instance === instance && pending.kind === kind && pending.jack === jack) {
          setPending({ ...pending, color: (pending.color + 1) % NUM_WIRE_COLORS });
          return;
        }
        // Opposite-kind click completes the wire (either direction).
        if (pending.kind !== kind) {
          const armed = { instance: pending.instance, jack: pending.jack };
          const from = kind === 'input' ? armed : { instance, jack };
          const to = kind === 'input' ? { instance, jack } : armed;
          await engine.connectWire(from, to);
          const key = `${from.instance}:${from.jack}->${to.instance}:${to.jack}`;
          setWireColors((prev) => {
            const next = { ...prev, [key]: pending.color };
            saveJson(WIRE_COLORS_KEY, next);
            return next;
          });
          saveJson(LAST_WIRE_COLOR_KEY, pending.color);
          setPending(null);
          await refresh();
          return;
        }
        // Same-kind click re-arms the wire from the new jack.
        setPending({ instance, jack, kind, color: pending.color });
        return;
      }
      // No pending wire: clicking a wired input unplugs it; anything else
      // arms a new wire (starting from an output or a free input).
      if (kind === 'input') {
        const existing = wires.find((w) => w.to_instance === instance && w.to_jack === jack);
        if (existing) {
          await engine.disconnectWire(
            { instance: existing.from_instance, jack: existing.from_jack },
            { instance, jack },
          );
          await refresh();
          return;
        }
      }
      setPending({ instance, jack, kind, color: loadJson(LAST_WIRE_COLOR_KEY, 0) });
    },
    [pending, wires, refresh],
  );

  const makeHandle = useCallback(
    (node: NodeSnapshot): ModuleHandle => ({
      paramValue: (id) => {
        const live = node.params[id];
        if (typeof live === 'number') return live;
        const p = node.manifest.params.find((p) => p.id === id);
        return typeof p?.default === 'number' ? p.default : 0;
      },
      setParam: (id, v) => {
        void engine.setParam(node.instance_id, id, v).then(refresh);
      },
      signalTap: (jackId) =>
        telemetry[node.instance_id]?.[jackId] ?? {
          instantaneous: 0,
          rms_100ms: 0,
          display: 0,
          is_fast: false,
        },
      endEdit: () => void engine.endEdit(),
      size: { w: 360, h: 200 },
    }),
    [telemetry, refresh],
  );

  const removeModule = useCallback(
    async (instance: string) => {
      await engine.removeModule(instance);
      setPositions((prev) => {
        if (!(instance in prev)) return prev;
        const next = { ...prev };
        delete next[instance];
        try {
          localStorage.setItem(POSITIONS_KEY, JSON.stringify(next));
        } catch {
          // persistence is best-effort
        }
        return next;
      });
      setPending((p) => (p?.instance === instance ? null : p));
      await refresh();
    },
    [refresh],
  );

  const handles = useMemo(
    () => new Map(nodes.map((n) => [n.instance_id, makeHandle(n)])),
    [nodes, makeHandle],
  );

  // Shared state for DeckPanel custom UIs (track list, sync candidates,
  // play_gate control) — via context so the panel component stays stable
  // across renders.
  const deckUI = useMemo(
    () => ({
      tracks: libraryTracks,
      deckInstances: nodes.filter((n) => n.type_id === 'builtin.deck').map((n) => n.instance_id),
      setPlayGate: (instance: string, high: boolean) => {
        void engine.setKnobPosition(instance, 'play_gate', high ? 1 : 0).then(refresh);
      },
    }),
    [libraryTracks, nodes, refresh],
  );

  return (
    <main className="app">
      <header className="app-header">
        <h1>dj-station</h1>
        <nav className="app-tabs">
          <button
            className={view === 'rack' ? 'tab active' : 'tab'}
            onClick={() => setView('rack')}
            data-testid="tab-rack"
          >
            Rack
          </button>
          <button
            className={view === 'library' ? 'tab active' : 'tab'}
            onClick={() => setView('library')}
            data-testid="tab-library"
          >
            Library
          </button>
        </nav>
        <span className="patch-controls">
          <input
            className="patch-name"
            data-testid="patch-name"
            value={patchName}
            onChange={(e) => setPatchName(e.target.value)}
            title="Patch name"
          />
          <button className="patch-save" data-testid="patch-save" onClick={() => void savePatch()}>
            Save
          </button>
          <select
            className="patch-load"
            data-testid="patch-load"
            value=""
            onChange={(e) => {
              if (e.target.value) void loadNamedPatch(e.target.value);
            }}
          >
            <option value="">load…</option>
            {patchList.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </span>
        <span className="engine-status" data-testid="engine-status">
          {connected === null
            ? 'connecting…'
            : connected
              ? `engine connected (${backend ?? '?'}${backend === 'null' ? ' — SILENT' : ''})`
              : 'no engine (dev)'}
        </span>
        {selected.length > 0 && collapseName === null && (
          <button
            className="collapse-macro-btn"
            data-testid="collapse-macro-btn"
            onClick={() => setCollapseName('')}
          >
            Collapse to Module ({selected.length})
          </button>
        )}
        {collapseName !== null && (
          <form
            className="collapse-macro-form"
            data-testid="collapse-macro-form"
            onSubmit={(e) => {
              e.preventDefault();
              void collapseToMacro(collapseName);
            }}
          >
            <input
              autoFocus
              placeholder="macro name"
              data-testid="collapse-macro-name"
              value={collapseName}
              onChange={(e) => setCollapseName(e.target.value)}
            />
            <button type="submit" data-testid="collapse-macro-confirm">
              Create
            </button>
            <button type="button" onClick={() => setCollapseName(null)}>
              Cancel
            </button>
          </form>
        )}
        {pending && (
          <span className="wiring-hint" data-testid="wiring-hint">
            <span
              className="wire-color-swatch"
              data-testid="wire-color-swatch"
              style={{ background: WIRE_COLORS[pending.color] }}
            />
            wiring from {pending.instance}:{pending.jack} — click an{' '}
            {pending.kind === 'output' ? 'input' : 'output'} jack (re-click to change color, esc to
            cancel)
          </span>
        )}
      </header>
      {view === 'library' && <LibraryView client={library} />}
      <div className="app-body" style={view === 'rack' ? undefined : { display: 'none' }}>
        <ModuleLibrary modules={moduleLib} onAdd={(typeId) => void addModule(typeId)} />
        <DeckUIContext.Provider value={deckUI}>
          <div
            className="rack-area"
            ref={setRackEl}
            data-testid="rack-area"
            onDragOver={onRackDragOver}
            onDrop={onRackDrop}
            onClick={(e) => {
              // Clicking the rack background abandons a pending wire.
              if (pending && !(e.target as HTMLElement).closest?.('.module-panel')) {
                setPending(null);
              }
            }}
          >
            <div
              className="rack"
              data-testid="rack"
              style={{ transform: `scale(${zoom})`, transformOrigin: '0 0' }}
            >
              {nodes.map((node, i) => (
                <ModulePanel
                  key={node.instance_id}
                  instanceId={node.instance_id}
                  manifest={node.manifest}
                  knobs={node.knobs}
                  wired={Object.fromEntries(node.wired_inputs.map((j) => [j, true]))}
                  telemetry={telemetry[node.instance_id]}
                  handle={handles.get(node.instance_id)!}
                  customUI={CUSTOM_UIS[node.type_id as keyof typeof CUSTOM_UIS]}
                  extra={
                    node.type_id === 'builtin.midi' ? (
                      <MidiPanel
                        instance={node.instance_id}
                        mappings={node.midi_mappings}
                        onAdd={(kind, num, name) =>
                          void engine
                            .addMidiMapping(node.instance_id, kind, num, name)
                            .then(refresh)
                        }
                        onRemove={(name) =>
                          void engine.removeMidiMapping(node.instance_id, name).then(refresh)
                        }
                        ledMappings={node.midi_led_mappings}
                        onAddLed={(kind, num, name) =>
                          void engine
                            .addMidiLedMapping(node.instance_id, kind, num, name)
                            .then(refresh)
                        }
                        onRemoveLed={(name) =>
                          void engine.removeMidiLedMapping(node.instance_id, name).then(refresh)
                        }
                        onMidi={(data) => void engine.injectMidi(node.instance_id, 0, data)}
                      />
                    ) : node.type_id === 'builtin.gesture' ? (
                      <GesturePanel
                        instance={node.instance_id}
                        api={{
                          status: (i) => engine.gestureStatus(i),
                          setMode: (i, m) => engine.gestureSetMode(i, m),
                          addMapping: (i, n, m, c) => engine.gestureAddMapping(i, n, m, c),
                          removeMapping: (i, n) => engine.gestureRemoveMapping(i, n),
                          learnBegin: (i) => engine.gestureLearnBegin(i),
                          learnPoll: (i, n) => engine.gestureLearnPoll(i, n),
                          feedStart: (i, src) => engine.gestureFeedStart(i, src),
                          feedStop: (i) => engine.gestureFeedStop(i),
                        }}
                        onChanged={() => void refresh()}
                      />
                    ) : undefined
                  }
                  position={positions[node.instance_id] ?? defaultPosition(i)}
                  onMove={(x, y) => moveModule(node.instance_id, x, y)}
                  onRemove={() => void removeModule(node.instance_id)}
                  onEditEnd={() => void engine.endEdit()}
                  selected={selected.includes(node.instance_id)}
                  onSelectToggle={() => toggleSelected(node.instance_id)}
                  pendingSource={pending}
                  onJackClick={(kind, jack) => void onJackClick(node.instance_id, kind, jack)}
                  onKnobPosition={(jack, position) => {
                    void engine.setKnobPosition(node.instance_id, jack, position).then(refresh);
                  }}
                  onKnobConfig={(jack, config: KnobConfig) => {
                    void engine.setKnobConfig(node.instance_id, jack, config).then(refresh);
                  }}
                  onAttenOffset={(jack, atten, offset) => {
                    void engine.setAttenOffset(node.instance_id, jack, atten, offset).then(refresh);
                  }}
                  onParam={(param, value) => {
                    void engine.setParam(node.instance_id, param, value).then(refresh);
                  }}
                />
              ))}
              {nodes.length === 0 && (
                <p className="rack-empty">
                  No engine connection — run via <code>./run.sh</code> (Tauri) to see the live rack.
                </p>
              )}
            </div>
            <WireOverlay
              wires={wires}
              container={rackEl}
              colors={wireColors}
              pending={pending}
              layoutKey={`${JSON.stringify(positions)}@${zoom}`}
            />
          </div>
        </DeckUIContext.Provider>
      </div>
    </main>
  );
}
