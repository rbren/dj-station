// dj-station M0 shell: loads the demo patch into the engine (when running
// under Tauri), renders manifest-driven panels with live jack telemetry,
// a module library sidebar for adding modules, and click-to-wire jacks
// with an SVG cable overlay.
//
// Rack state (nodes, wires, telemetry, positions, selection, pending wire)
// lives in an external store (rackStore.ts); App subscribes to the slices
// it renders and each RackModule subscribes to its own, so telemetry ticks
// and knob drags re-render only the affected panels.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { engine, onMenuAction } from './engine';
import { library, type Track } from './library';
import { ContextMenu, type ContextMenuItem } from './components/ContextMenu';
import { DeckUIContext } from './components/DeckPanel';
import { DocsPanel } from './components/DocsPanel';
import { ErrorBanner } from './components/ErrorBanner';
import { reportError } from './errors';
import { LibraryView } from './components/LibraryView';
import { MODULE_DRAG_TYPE, ModuleLibrary, nextInstanceId } from './components/ModuleLibrary';
import { GRID, snap } from './components/ModulePanel';
import { RackModule } from './components/RackModule';
import { TooltipLayer } from './components/TooltipLayer';
import { WIRE_COLORS, WireOverlay } from './components/WireOverlay';
import { defaultPosition, moduleRect, rectsOverlap, type Rect } from './rackLayout';
import {
  createRackStore,
  loadJson,
  POSITIONS_KEY,
  RackStoreContext,
  saveJson,
  useStoreSelector,
  type PendingWire,
  type Positions,
} from './rackStore';
import type { Manifest } from './types';

export type { PendingWire };

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
  const [store] = useState(createRackStore);
  const nodes = useStoreSelector(store, (s) => s.nodes);
  const wires = useStoreSelector(store, (s) => s.wires);
  const positions = useStoreSelector(store, (s) => s.positions);
  const selected = useStoreSelector(store, (s) => s.selected);
  const pending = useStoreSelector(store, (s) => s.pending);

  const [moduleLib, setModuleLib] = useState<Manifest[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [backend, setBackend] = useState<string | null>(null);
  const [view, setView] = useState<'rack' | 'library'>('rack');
  const [wireColors, setWireColors] = useState<Record<string, number>>(() =>
    loadJson(WIRE_COLORS_KEY, {}),
  );
  const [patchName, setPatchName] = useState('untitled');
  const [patchList, setPatchList] = useState<string[]>([]);
  // File-menu dialogs (Save As… / Open Patch…), driven by native menu events.
  const [fileDialog, setFileDialog] = useState<null | 'save-as' | 'open'>(null);
  const [saveAsName, setSaveAsName] = useState('untitled');
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([]);
  const [collapseName, setCollapseName] = useState<string | null>(null);
  // Right-click menu: over a module (instance set) or the rack background.
  const [ctxMenu, setCtxMenu] = useState<null | { x: number; y: number; instance?: string }>(null);
  // In-app module documentation (opened from the module context menu).
  const [docs, setDocs] = useState<null | { typeId: string; manifest: Manifest }>(null);
  const [zoom, setZoom] = useState<number>(() => loadZoom());
  // Callback ref (state, not useRef) so the overlay re-renders once the
  // rack element mounts.
  const [rackEl, setRackEl] = useState<HTMLDivElement | null>(null);

  const setPositions = useCallback(
    (updater: (prev: Positions) => Positions) => {
      const prev = store.getState().positions;
      const next = updater(prev);
      if (next !== prev) store.set({ positions: next });
    },
    [store],
  );

  const setPending = useCallback((pending: PendingWire | null) => store.set({ pending }), [store]);

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
      const nodes = store.getState().nodes;
      setPositions((prev) => {
        const otherRects: Rect[] = [];
        for (const [i, node] of nodes.entries()) {
          if (node.instance_id === instance) continue;
          const otherPos = prev[node.instance_id] ?? defaultPosition(i);
          otherRects.push(moduleRect(node.instance_id, otherPos));
        }
        const rectAt = (pos: { x: number; y: number }) => moduleRect(instance, pos);
        const overlapsAny = (pos: { x: number; y: number }) =>
          otherRects.some((r) => rectsOverlap(rectAt(pos), r));

        const selfIdx = nodes.findIndex((n) => n.instance_id === instance);
        const currentPos = prev[instance] ?? defaultPosition(Math.max(selfIdx, 0));

        // Modules never overlap: when the requested spot is occupied, push
        // the dragged panel out to the nearest free grid spot along the
        // drag's dominant axis. Near-side pushes make the panel stop
        // against its neighbour; once the pointer crosses the neighbour's
        // midpoint the far-side push wins and the panel jumps over it.
        const resolve = (requested: { x: number; y: number }) => {
          const rect = rectAt(requested);
          const hits = otherRects.filter((r) => rectsOverlap(rect, r));
          const horizFirst =
            Math.abs(requested.x - currentPos.x) >= Math.abs(requested.y - currentPos.y);
          for (const axis of horizFirst ? (['x', 'y'] as const) : (['y', 'x'] as const)) {
            let best: { x: number; y: number } | null = null;
            let bestDist = Infinity;
            for (const r of hits) {
              const cands =
                axis === 'x'
                  ? [
                      { x: snap(r.x + r.w), y: requested.y },
                      { x: snap(r.x - rect.w), y: requested.y },
                    ]
                  : [
                      { x: requested.x, y: snap(r.y + r.h) },
                      { x: requested.x, y: snap(r.y - rect.h) },
                    ];
              for (const c of cands) {
                if (overlapsAny(c)) continue;
                const dist = Math.abs(c.x - requested.x) + Math.abs(c.y - requested.y);
                if (dist < bestDist) {
                  best = c;
                  bestDist = dist;
                }
              }
            }
            if (best) return best;
          }
          return null;
        };

        let target = { x, y };
        if (overlapsAny(target)) {
          const resolved = resolve(target);
          if (resolved) target = resolved;
          // No free spot nearby: hold position, but always allow escaping
          // when the module is already overlapping (bad legacy placement).
          else if (!overlapsAny(currentPos)) return prev;
        }
        if (target.x === currentPos.x && target.y === currentPos.y) return prev;
        const next = { ...prev, [instance]: target };
        saveJson(POSITIONS_KEY, next);
        return next;
      });
    },
    [store, setPositions],
  );

  // Post-render placement pass: with real panel sizes in the DOM, nudge any
  // module that overlaps an earlier one straight down to the next free row.
  // Covers click-to-add, drops estimated with fallback sizes, and stale
  // saved layouts.
  useEffect(() => {
    const timer = setTimeout(() => {
      setPositions((prev) => {
        const placed: Rect[] = [];
        const next: Positions = { ...prev };
        let changed = false;
        for (const [i, node] of nodes.entries()) {
          const id = node.instance_id;
          let pos = next[id] ?? defaultPosition(i);
          let rect = moduleRect(id, pos);
          let tries = 0;
          while (placed.some((r) => rectsOverlap(rect, r)) && tries < 400) {
            pos = { x: pos.x, y: pos.y + GRID };
            rect = moduleRect(id, pos);
            tries++;
          }
          if (next[id]?.x !== pos.x || next[id]?.y !== pos.y) {
            next[id] = pos;
            changed = true;
          }
          placed.push(rect);
        }
        if (!changed) return prev;
        saveJson(POSITIONS_KEY, next);
        return next;
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [nodes, setPositions]);

  const refresh = useCallback(async () => {
    const snapshot = await engine.nodes();
    setConnected(snapshot !== null);
    if (snapshot) store.setNodes(snapshot);
    const wireList = await engine.wires();
    if (wireList) store.set({ wires: wireList });
    const tracks = await library.tracks();
    if (tracks) setLibraryTracks(tracks);
  }, [store]);

  useEffect(() => {
    void (async () => {
      try {
        await engine.loadDemoPatch();
        setBackend(await engine.start());
        const modules = await engine.listModules();
        if (modules) setModuleLib(modules);
        const current = await engine.currentPatch();
        if (current) setPatchName(current);
        setPatchList((await engine.listPatches()) ?? []);
        await refresh();
      } catch (err) {
        // Startup problems land in the banner; the shell still renders.
        reportError('startup', err);
      }
    })();
  }, [refresh]);

  const savePatch = useCallback(
    async (name?: string) => {
      const finalName = (name ?? patchName).trim() || 'untitled';
      await engine.savePatchAs(finalName);
      setPatchName(finalName);
      setPatchList((await engine.listPatches()) ?? []);
    },
    [patchName],
  );

  const loadNamedPatch = useCallback(
    async (name: string) => {
      await engine.loadPatchByName(name);
      setPatchName(name);
      await refresh();
    },
    [refresh],
  );

  // Native File menu (Save handled fully in the backend; Save As / Open
  // open in-app dialogs). Tests drive this via `dj-menu` CustomEvents.
  useEffect(
    () =>
      onMenuAction((action) => {
        if (action === 'saved') {
          void engine.currentPatch().then((n) => {
            if (n) setPatchName(n);
          });
          void engine.listPatches().then((l) => setPatchList(l ?? []));
        } else if (action === 'save-as') {
          setSaveAsName(patchName);
          setFileDialog('save-as');
        } else if (action === 'open') {
          void engine.listPatches().then((l) => setPatchList(l ?? []));
          setFileDialog('open');
        }
      }),
    [patchName],
  );

  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          // One batched IPC round-trip per tick for the whole rack; the
          // backend acquires the engine lock once and taps every jack.
          const next = await engine.tapAll();
          if (next) store.setTelemetry(next);
        } catch (err) {
          // A broken meter must never stop the rack from rendering.
          reportError('telemetry', err);
        }
      })();
    }, 100);
    return () => clearInterval(timer);
  }, [connected, store]);

  const addModule = useCallback(
    async (typeId: string, at?: { x: number; y: number }) => {
      const { nodes, positions } = store.getState();
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
    [store, refresh, moveModule],
  );

  const toggleSelected = useCallback(
    (instance: string) => {
      const prev = store.getState().selected;
      store.set({
        selected: prev.includes(instance)
          ? prev.filter((i) => i !== instance)
          : [...prev, instance],
      });
    },
    [store],
  );

  const collapseToMacro = useCallback(
    async (name: string) => {
      const selected = store.getState().selected;
      if (!name.trim() || selected.length === 0) return;
      await engine.collapseMacro(selected, name.trim());
      store.set({ selected: [] });
      setCollapseName(null);
      const modules = await engine.listModules();
      if (modules) setModuleLib(modules);
      await refresh();
    },
    [store, refresh],
  );

  // Global shortcuts: undo/redo (cmd/ctrl+Z, cmd/ctrl+Y, cmd/ctrl+shift+Z)
  // and rack zoom (cmd/ctrl +/-/0).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        store.set({ pending: null, selected: [] });
        setCollapseName(null);
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
  }, [store, refresh, changeZoom, savePatch]);

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
    async (instance: string, kind: 'input' | 'output', jack: string, shift = false) => {
      const { wires, pending } = store.getState();
      // Shift+click unplugs the jack's most recent wire (LIFO — the wires
      // snapshot preserves connection order). Outputs fan out to many
      // wires, so repeated shift+clicks peel them off newest-first.
      if (shift) {
        const attached = wires.filter((w) =>
          kind === 'input'
            ? w.to_instance === instance && w.to_jack === jack
            : w.from_instance === instance && w.from_jack === jack,
        );
        const last = attached[attached.length - 1];
        if (last) {
          await engine.disconnectWire(
            { instance: last.from_instance, jack: last.from_jack },
            { instance: last.to_instance, jack: last.to_jack },
          );
          await refresh();
        }
        return;
      }
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
      // No pending wire: clicking a wired input picks its cable up — the
      // wire detaches but stays armed from its source output in its own
      // color, so it can be dropped on another input to move it (or
      // abandoned with Esc / a background click to remove it). Anything
      // else arms a new wire (starting from an output or a free input).
      if (kind === 'input') {
        const existing = wires.find((w) => w.to_instance === instance && w.to_jack === jack);
        if (existing) {
          const key = `${existing.from_instance}:${existing.from_jack}->${instance}:${jack}`;
          const color = wireColors[key] ?? loadJson(LAST_WIRE_COLOR_KEY, 0);
          await engine.disconnectWire(
            { instance: existing.from_instance, jack: existing.from_jack },
            { instance, jack },
          );
          setWireColors((prev) => {
            const next = { ...prev };
            delete next[key];
            saveJson(WIRE_COLORS_KEY, next);
            return next;
          });
          setPending({
            instance: existing.from_instance,
            jack: existing.from_jack,
            kind: 'output',
            color,
          });
          await refresh();
          return;
        }
      }
      setPending({ instance, jack, kind, color: loadJson(LAST_WIRE_COLOR_KEY, 0) });
    },
    [store, wireColors, refresh, setPending],
  );

  // Right-click never shows the browser/Tauri context menu anywhere in the
  // app; specific surfaces (modules, rack background) open the app-styled
  // ContextMenu instead.
  useEffect(() => {
    const suppress = (e: Event) => e.preventDefault();
    window.addEventListener('contextmenu', suppress);
    return () => window.removeEventListener('contextmenu', suppress);
  }, []);

  const onModuleContextMenu = useCallback((instance: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, instance });
  }, []);

  const onRackContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const removeModule = useCallback(
    async (instance: string) => {
      await engine.removeModule(instance);
      setPositions((prev) => {
        if (!(instance in prev)) return prev;
        const next = { ...prev };
        delete next[instance];
        saveJson(POSITIONS_KEY, next);
        return next;
      });
      const pending = store.getState().pending;
      if (pending?.instance === instance) setPending(null);
      await refresh();
    },
    [store, setPositions, setPending, refresh],
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

  const ctxMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!ctxMenu) return [];
    const instance = ctxMenu.instance;
    if (!instance) {
      // Rack background: just Save, the same action as File > Save / cmd+S.
      return [{ label: 'Save', testId: 'ctx-save', onSelect: () => void savePatch() }];
    }
    return [
      {
        label: 'Delete',
        testId: 'ctx-delete',
        onSelect: () => void removeModule(instance),
      },
      {
        label: 'Documentation',
        testId: 'ctx-docs',
        onSelect: () => {
          const node = store.getState().nodes.find((n) => n.instance_id === instance);
          if (node) setDocs({ typeId: node.type_id, manifest: node.manifest });
        },
      },
      {
        label: 'Reset to defaults',
        testId: 'ctx-reset',
        disabled: true,
        hint: 'not implemented',
      },
      {
        label: 'Save patch',
        testId: 'ctx-save-patch',
        disabled: true,
        hint: 'not implemented',
      },
    ];
  }, [ctxMenu, savePatch, removeModule, store]);

  return (
    <main className="app">
      <TooltipLayer />
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
        <span
          className="patch-title"
          data-testid="patch-title"
          data-tip="Current patch (File menu to save/load)"
        >
          {patchName}
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
      <ErrorBanner />
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenuItems}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {docs && (
        <DocsPanel typeId={docs.typeId} manifest={docs.manifest} onClose={() => setDocs(null)} />
      )}
      {fileDialog && (
        <div
          className="file-dialog-backdrop"
          data-testid="file-dialog"
          onClick={() => setFileDialog(null)}
        >
          <div className="file-dialog" onClick={(e) => e.stopPropagation()}>
            {fileDialog === 'save-as' ? (
              <>
                <h3>Save Patch As</h3>
                <input
                  className="patch-name"
                  data-testid="file-dialog-name"
                  value={saveAsName}
                  autoFocus
                  onChange={(e) => setSaveAsName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void savePatch(saveAsName);
                      setFileDialog(null);
                    }
                  }}
                />
                <button
                  data-testid="file-dialog-confirm"
                  onClick={() => {
                    void savePatch(saveAsName);
                    setFileDialog(null);
                  }}
                >
                  Save
                </button>
              </>
            ) : (
              <>
                <h3>Open Patch</h3>
                {patchList.length === 0 && <p className="file-dialog-empty">no saved patches</p>}
                <ul className="file-dialog-list">
                  {patchList.map((n) => (
                    <li key={n}>
                      <button
                        data-testid={`file-dialog-patch-${n}`}
                        onClick={() => {
                          void loadNamedPatch(n);
                          setFileDialog(null);
                        }}
                      >
                        {n}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <button
              className="file-dialog-cancel"
              data-testid="file-dialog-cancel"
              onClick={() => setFileDialog(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {view === 'library' && <LibraryView client={library} />}
      <div className="app-body" style={view === 'rack' ? undefined : { display: 'none' }}>
        <ModuleLibrary modules={moduleLib} onAdd={(typeId) => void addModule(typeId)} />
        <RackStoreContext.Provider value={store}>
          <DeckUIContext.Provider value={deckUI}>
            <div
              className="rack-area"
              ref={setRackEl}
              data-testid="rack-area"
              onDragOver={onRackDragOver}
              onDrop={onRackDrop}
              onContextMenu={onRackContextMenu}
              onClick={(e) => {
                // Clicking the rack background abandons a pending wire.
                if (
                  store.getState().pending &&
                  !(e.target as HTMLElement).closest?.('.module-panel')
                ) {
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
                  <RackModule
                    key={node.instance_id}
                    instanceId={node.instance_id}
                    index={i}
                    refresh={refresh}
                    moveModule={moveModule}
                    removeModule={removeModule}
                    toggleSelected={toggleSelected}
                    onJackClick={onJackClick}
                    onContextMenu={onModuleContextMenu}
                  />
                ))}
                {nodes.length === 0 && (
                  <p className="rack-empty">
                    No engine connection — run via <code>./run.sh</code> (Tauri) to see the live
                    rack.
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
        </RackStoreContext.Provider>
      </div>
    </main>
  );
}
