// dj-station M0 shell: loads the demo patch into the engine (when running
// under Tauri), renders manifest-driven panels with live jack telemetry,
// a module library sidebar for adding modules, and click-to-wire jacks
// with an SVG cable overlay.
//
// Rack state (nodes, wires, telemetry, positions, selection, pending wire)
// lives in an external store (rackStore.ts); App subscribes to the slices
// it renders and each RackModule subscribes to its own, so telemetry ticks
// and knob drags re-render only the affected panels.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { engine, onMenuAction } from './engine';
import { library, type Track } from './library';
import { ContextMenu, type ContextMenuItem } from './components/ContextMenu';
import { DeckUIContext } from './components/DeckPanel';
import { DocsPanel } from './components/DocsPanel';
import { ErrorBanner } from './components/ErrorBanner';
import { reportError } from './errors';
import { LibraryView } from './components/LibraryView';
import { MODULE_DRAG_TYPE, ModulePicker, nextInstanceId } from './components/ModulePicker';
import { GRID, snap } from './components/ModulePanel';
import { RackModule } from './components/RackModule';
import { TooltipLayer } from './components/TooltipLayer';
import { WIRE_COLORS, WireOverlay } from './components/WireOverlay';
import {
  defaultPosition,
  moduleRect,
  nearestFreeSpot,
  rectsOverlap,
  type Rect,
} from './rackLayout';
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

const PAN_KEY = 'dj-rack-pan';

function loadPan(): { x: number; y: number } {
  const p = loadJson<{ x: number; y: number }>(PAN_KEY, { x: 0, y: 0 });
  return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : { x: 0, y: 0 };
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
  // Cmd+M module picker modal.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [zoom, setZoom] = useState<number>(() => loadZoom());
  // Infinite canvas: the rack is translated by `pan` (screen px) before the
  // zoom scale, so scrolling/dragging the background opens up new area in
  // every direction — positions themselves may be negative.
  const [pan, setPan] = useState<{ x: number; y: number }>(() => loadPan());
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

  // Overscroll pan: wheel/trackpad scrolling over the rack shifts the
  // canvas in any direction. Native non-passive listener so the page never
  // rubber-bands instead.
  useEffect(() => {
    if (!rackEl) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setPan((prev) => {
        const next = { x: prev.x - e.deltaX, y: prev.y - e.deltaY };
        saveJson(PAN_KEY, next);
        return next;
      });
    };
    rackEl.addEventListener('wheel', onWheel, { passive: false });
    return () => rackEl.removeEventListener('wheel', onWheel);
  }, [rackEl]);

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
    // Cmd+0 is "reset view": zoom 1 AND pan back to the origin, so a user
    // lost in empty canvas always has a way home.
    if (direction === 0) {
      setPan({ x: 0, y: 0 });
      saveJson(PAN_KEY, { x: 0, y: 0 });
    }
  }, []);

  // A drag-induced neighbour bump in flight: `bumped` was displaced from
  // `from` to open a slot for `dragged`. Provisional until the drag ends —
  // every move first re-evaluates with the bump virtually reverted, so the
  // neighbour springs back the moment the dragged panel fits elsewhere.
  const dragBump = useRef<null | {
    dragged: string;
    bumped: string;
    from: { x: number; y: number };
  }>(null);

  const endModuleDrag = useCallback((instance: string) => {
    // Releasing the drag makes any surviving bump permanent (positions,
    // including the neighbour's, were already committed by moveModule
    // through the one shared setPositions/saveJson path).
    if (dragBump.current?.dragged === instance) dragBump.current = null;
  }, []);

  const moveModule = useCallback(
    (instance: string, x: number, y: number) => {
      const nodes = store.getState().nodes;
      setPositions((prev) => {
        const bump = dragBump.current?.dragged === instance ? dragBump.current : null;
        // Two views of the neighbours: `others` virtually reverts an active
        // bump (the bump only survives if this move still needs it), while
        // `realRects` reflects what is actually on screen.
        const others: { id: string; pos: { x: number; y: number }; rect: Rect }[] = [];
        const realRects: Rect[] = [];
        for (const [i, node] of nodes.entries()) {
          const id = node.instance_id;
          if (id === instance) continue;
          const realPos = prev[id] ?? defaultPosition(i);
          const pos = bump && bump.bumped === id ? bump.from : realPos;
          others.push({ id, pos, rect: moduleRect(id, pos) });
          realRects.push(moduleRect(id, realPos));
        }
        const rectAt = (pos: { x: number; y: number }) => moduleRect(instance, pos);
        const overlapsAny = (pos: { x: number; y: number }) =>
          others.some((o) => rectsOverlap(rectAt(pos), o.rect));

        const selfIdx = nodes.findIndex((n) => n.instance_id === instance);
        const currentPos = prev[instance] ?? defaultPosition(Math.max(selfIdx, 0));
        // No-op move: keep everything (including an active bump) as-is —
        // re-resolving against the virtually-reverted neighbour would yank
        // the panel out of a bumped-open slot it already occupies.
        if (x === currentPos.x && y === currentPos.y) return prev;

        // Modules never overlap: when the requested spot is occupied, push
        // the dragged panel out to the nearest free grid spot along the
        // drag's dominant axis. Near-side pushes make the panel stop
        // against its neighbour; once the pointer crosses the neighbour's
        // midpoint the far-side push wins and the panel jumps over it.
        const resolve = (requested: { x: number; y: number }) => {
          const rect = rectAt(requested);
          const hits = others.filter((o) => rectsOverlap(rect, o.rect)).map((o) => o.rect);
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

        // Co-operative bump: the drag has committed past a neighbour (the
        // panel's center crossed the neighbour's center along the drag
        // axis) but there is no room for it on the far side — displace
        // that one neighbour the opposite way, just enough (grid-snapped)
        // to open a slot for the panel at the cursor. No cascades: if the
        // bump would push the neighbour out of the rack or into a third
        // module, give up and keep today's blocked feel.
        const tryBump = (requested: { x: number; y: number }) => {
          const rect = rectAt(requested);
          const hits = others.filter((o) => rectsOverlap(rect, o.rect));
          if (hits.length === 0) return null;
          const dx = requested.x - currentPos.x;
          const dy = requested.y - currentPos.y;
          const axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
          const dir = Math.sign(axis === 'x' ? dx : dy);
          if (dir === 0) return null;
          const center = (r: Rect) => (axis === 'x' ? r.x + r.w / 2 : r.y + r.h / 2);
          const aCenter = center(rect);
          // Exactly one overlapped neighbour may have been dragged past.
          const passed = hits.filter((o) =>
            dir > 0 ? aCenter >= center(o.rect) : aCenter <= center(o.rect),
          );
          if (passed.length !== 1) return null;
          const hit = passed[0];
          const r = hit.rect;
          // Only bump when the normal jump over that neighbour is blocked.
          const far =
            axis === 'x'
              ? { x: snap(dir > 0 ? r.x + r.w : r.x - rect.w), y: requested.y }
              : { x: requested.x, y: snap(dir > 0 ? r.y + r.h : r.y - rect.h) };
          if (!overlapsAny(far)) return null;
          // Land the panel at the cursor, clamped back against the other
          // obstacles it overlaps, so only `hit` has to give way.
          const aPos = { ...requested };
          for (const o of hits) {
            if (o === hit) continue;
            if (axis === 'x') {
              aPos.x =
                dir > 0
                  ? Math.min(aPos.x, Math.floor((o.rect.x - rect.w) / GRID) * GRID)
                  : Math.max(aPos.x, Math.ceil((o.rect.x + o.rect.w) / GRID) * GRID);
            } else {
              aPos.y =
                dir > 0
                  ? Math.min(aPos.y, Math.floor((o.rect.y - rect.h) / GRID) * GRID)
                  : Math.max(aPos.y, Math.ceil((o.rect.y + o.rect.h) / GRID) * GRID);
            }
          }
          const aRect = rectAt(aPos);
          if (!rectsOverlap(aRect, r)) return null; // clamped clear — no bump needed
          if (others.some((o) => o !== hit && rectsOverlap(aRect, o.rect))) return null;
          // Displace the neighbour the opposite way, just enough to clear.
          const to =
            axis === 'x'
              ? {
                  x:
                    dir > 0
                      ? Math.floor((aPos.x - r.w) / GRID) * GRID
                      : Math.ceil((aPos.x + aRect.w) / GRID) * GRID,
                  y: r.y,
                }
              : {
                  x: r.x,
                  y:
                    dir > 0
                      ? Math.floor((aPos.y - r.h) / GRID) * GRID
                      : Math.ceil((aPos.y + aRect.h) / GRID) * GRID,
                };
          const bumpedRect = moduleRect(hit.id, to);
          if (rectsOverlap(bumpedRect, aRect)) return null;
          if (others.some((o) => o.id !== hit.id && rectsOverlap(bumpedRect, o.rect))) {
            return null;
          }
          return { aPos, bumped: hit.id, from: hit.pos, to };
        };

        let target = { x, y };
        let nextBump: { bumped: string; from: { x: number; y: number }; to: typeof target } | null =
          null;
        if (overlapsAny(target)) {
          const plan = tryBump(target);
          if (plan) {
            target = plan.aPos;
            nextBump = { bumped: plan.bumped, from: plan.from, to: plan.to };
          } else {
            const resolved = resolve(target);
            if (resolved) target = resolved;
            // No free spot nearby: hold position (keeping any active bump),
            // but always allow escaping when the module is already really
            // overlapping (bad legacy placement).
            else if (!realRects.some((r) => rectsOverlap(rectAt(currentPos), r))) return prev;
          }
        }
        const sameBump =
          (nextBump === null && bump === null) ||
          (nextBump !== null &&
            bump !== null &&
            nextBump.bumped === bump.bumped &&
            prev[nextBump.bumped]?.x === nextBump.to.x &&
            prev[nextBump.bumped]?.y === nextBump.to.y);
        if (target.x === currentPos.x && target.y === currentPos.y && sameBump) return prev;

        // One positions update covers the panel's move plus any bump
        // apply/revert, so the whole gesture persists (and coalesces)
        // through the same path as a plain move.
        const next = { ...prev, [instance]: target };
        if (bump && bump.bumped !== nextBump?.bumped) next[bump.bumped] = bump.from;
        if (nextBump) next[nextBump.bumped] = nextBump.to;
        dragBump.current = nextBump
          ? { dragged: instance, bumped: nextBump.bumped, from: nextBump.from }
          : null;
        saveJson(POSITIONS_KEY, next);
        return next;
      });
    },
    [store, setPositions],
  );

  // Post-render placement pass: with real panel sizes in the DOM, move any
  // module that overlaps an earlier one to the nearest free grid spot (same
  // search as drop placement, so corrections stay near the intended point).
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
          const size = moduleRect(id, pos);
          pos = nearestFreeSpot(pos, { w: size.w, h: size.h }, placed) ?? pos;
          if (next[id]?.x !== pos.x || next[id]?.y !== pos.y) {
            next[id] = pos;
            changed = true;
          }
          placed.push(moduleRect(id, pos));
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

  // Sync the UI after the engine was replaced by a New Patch (the backend
  // reset already happened — native menu path — or is done by newPatch).
  const afterNewPatch = useCallback(async () => {
    store.set({ selected: [], pending: null });
    setPatchName('untitled');
    await refresh();
  }, [store, refresh]);

  const newPatch = useCallback(async () => {
    await engine.newPatch();
    await afterNewPatch();
  }, [afterNewPatch]);

  const openSaveAsDialog = useCallback(() => {
    setSaveAsName(patchName);
    setFileDialog('save-as');
  }, [patchName]);

  const openOpenDialog = useCallback(() => {
    void engine.listPatches().then((l) => setPatchList(l ?? []));
    setFileDialog('open');
  }, []);

  // Native File menu (New/Save handled fully in the backend; Save As /
  // Open open in-app dialogs). Tests drive this via `dj-menu` CustomEvents.
  useEffect(
    () =>
      onMenuAction((action) => {
        if (action === 'saved') {
          void engine.currentPatch().then((n) => {
            if (n) setPatchName(n);
          });
          void engine.listPatches().then((l) => setPatchList(l ?? []));
        } else if (action === 'new') {
          void afterNewPatch();
        } else if (action === 'save-as') {
          openSaveAsDialog();
        } else if (action === 'open') {
          openOpenDialog();
        }
      }),
    [afterNewPatch, openSaveAsDialog, openOpenDialog],
  );

  // The File menu as context-menu items: the rack-background right-click
  // menu renders exactly this list, and each entry reuses the same action
  // the native File menu triggers, so the two menus stay in sync.
  const fileMenuItems = useMemo<ContextMenuItem[]>(
    () => [
      { label: 'New Patch', testId: 'ctx-new-patch', onSelect: () => void newPatch() },
      { label: 'Save Patch', testId: 'ctx-save', onSelect: () => void savePatch() },
      { label: 'Save Patch As…', testId: 'ctx-save-as', onSelect: openSaveAsDialog },
      { label: 'Open Patch…', testId: 'ctx-open', onSelect: openOpenDialog },
    ],
    [newPatch, savePatch, openSaveAsDialog, openOpenDialog],
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
        // Deterministic, near-the-cursor placement: the drop point itself
        // when free, otherwise the nearest free grid spot (ring search) —
        // never a far-away jump.
        const rect = moduleRect(instance, at);
        const others = nodes.map((node, i) =>
          moduleRect(node.instance_id, positions[node.instance_id] ?? defaultPosition(i)),
        );
        const spot = nearestFreeSpot(at, { w: rect.w, h: rect.h }, others) ?? at;
        moveModule(instance, spot.x, spot.y);
      }
      await refresh();
    },
    [store, refresh, moveModule],
  );

  // Selection model (standard desktop semantics): a plain click on a module
  // selects exactly that module, shift/cmd/ctrl-click toggles membership,
  // a rack-background click or Escape clears, cmd/ctrl+A selects all.
  // Engine refreshes prune ids that no longer exist (rackStore.setNodes),
  // so a selection can never outlive its modules.
  const selectModule = useCallback(
    (instance: string, additive: boolean) => {
      const prev = store.getState().selected;
      if (!additive) {
        store.set({ selected: [instance] });
        return;
      }
      store.set({
        selected: prev.includes(instance)
          ? prev.filter((i) => i !== instance)
          : [...prev, instance],
      });
    },
    [store],
  );

  // Module clipboard: an opaque engine payload (modules + wires internal
  // to the copied set) plus the copied panels' rack positions, so pastes
  // land near their sources. Frontend-owned so it survives engine edits.
  const clipboard = useRef<null | { payload: string; positions: Positions }>(null);
  // Rendered state for the paste menu items (a ref alone wouldn't
  // re-render the menu when the first copy happens).
  const [clipboardFilled, setClipboardFilled] = useState(false);

  const copyModules = useCallback(
    async (instances: string[]) => {
      if (instances.length === 0) return;
      const payload = await engine.copyModules(instances);
      if (!payload) return;
      const { positions } = store.getState();
      const copied: Positions = {};
      for (const id of instances) {
        if (positions[id]) copied[id] = positions[id];
      }
      clipboard.current = { payload, positions: copied };
      setClipboardFilled(true);
    },
    [store],
  );

  const pasteModules = useCallback(async () => {
    const clip = clipboard.current;
    if (!clip) return;
    const renames = await engine.pasteModules(clip.payload);
    if (!renames) return;
    // Place each pasted panel one grid step down-right of its source
    // (falling back to the nearest free spot), and select the new set.
    setPositions((prev) => {
      const next = { ...prev };
      const placed: Rect[] = Object.entries(next).map(([id, pos]) => moduleRect(id, pos));
      for (const [oldId, newId] of Object.entries(renames)) {
        const src = clip.positions[oldId];
        const at = src ? { x: src.x + GRID, y: src.y + GRID } : { x: 0, y: 0 };
        const rect = moduleRect(newId, at);
        const spot = nearestFreeSpot(at, { w: rect.w, h: rect.h }, placed) ?? at;
        next[newId] = spot;
        placed.push(moduleRect(newId, spot));
      }
      saveJson(POSITIONS_KEY, next);
      return next;
    });
    // Select the pasted set only after the refresh has brought the new
    // nodes in — setNodes prunes selection against the live node list, so
    // selecting first would race the prune.
    await refresh();
    store.set({ selected: Object.values(renames) });
  }, [store, setPositions, refresh]);

  const removeModules = useCallback(
    async (instances: string[]) => {
      if (instances.length === 0) return;
      await engine.removeModules(instances);
      setPositions((prev) => {
        const next = { ...prev };
        for (const id of instances) delete next[id];
        saveJson(POSITIONS_KEY, next);
        return next;
      });
      const { pending, selected } = store.getState();
      store.set({ selected: selected.filter((i) => !instances.includes(i)) });
      if (pending && instances.includes(pending.instance)) setPending(null);
      await refresh();
    },
    [store, setPositions, setPending, refresh],
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

  // Global shortcuts: undo/redo (cmd/ctrl+Z, cmd/ctrl+Y, cmd/ctrl+shift+Z),
  // rack zoom (cmd/ctrl +/-/0), select-all (cmd/ctrl+A), selection
  // copy/paste (cmd/ctrl+C/V) and selection delete (Backspace).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        store.set({ pending: null, selected: [] });
        setCollapseName(null);
        return;
      }
      if (e.key === 'Backspace' && !isEditableTarget(e.target)) {
        const selected = store.getState().selected;
        if (selected.length > 0) {
          e.preventDefault();
          void removeModules(selected);
        }
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
      } else if (key === 'c') {
        // Leave cmd+C alone when the user is copying text.
        if (window.getSelection()?.toString()) return;
        const selected = store.getState().selected;
        if (selected.length > 0) {
          e.preventDefault();
          void copyModules(selected);
        }
      } else if (key === 'v') {
        e.preventDefault();
        void pasteModules();
      } else if (key === 'a') {
        e.preventDefault();
        store.set({ selected: store.getState().nodes.map((n) => n.instance_id) });
      } else if (key === 'm') {
        e.preventDefault();
        setPickerOpen((open) => !open);
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
  }, [store, refresh, changeZoom, savePatch, copyModules, pasteModules, removeModules]);

  // Click-to-add from the picker: land the module at the center of the
  // current view (pan/zoom-aware), then close the modal.
  const addFromPicker = useCallback(
    (typeId: string) => {
      let at: { x: number; y: number } | undefined;
      if (rackEl) {
        const rect = rackEl.getBoundingClientRect();
        at = {
          x: snap((rect.width / 2 - pan.x) / zoom),
          y: snap((rect.height / 2 - pan.y) / zoom),
        };
      }
      setPickerOpen(false);
      void addModule(typeId, at);
    },
    [rackEl, pan, zoom, addModule],
  );

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
        // Screen -> rack coordinates: undo the pan translate, then the
        // zoom scale (both applied to the .rack wrapper).
        const snap = (v: number) => Math.round(v / zoom / GRID) * GRID;
        at = {
          x: snap(e.clientX - rect.left - pan.x),
          y: snap(e.clientY - rect.top - pan.y),
        };
      }
      setPickerOpen(false);
      void addModule(typeId, at);
    },
    [rackEl, zoom, pan, addModule],
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

  const onModuleContextMenu = useCallback(
    (instance: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Right-clicking outside the current selection retargets it to the
      // clicked module (standard desktop behavior); inside it, the menu
      // acts on the whole group.
      if (!store.getState().selected.includes(instance)) {
        store.set({ selected: [instance] });
      }
      setCtxMenu({ x: e.clientX, y: e.clientY, instance });
    },
    [store],
  );

  const openDocs = useCallback(
    (instance: string) => {
      const node = store.getState().nodes.find((n) => n.instance_id === instance);
      if (node) setDocs({ typeId: node.type_id, manifest: node.manifest });
    },
    [store],
  );

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
    const paste: ContextMenuItem = {
      label: 'Paste',
      testId: 'ctx-paste',
      disabled: !clipboardFilled,
      onSelect: () => void pasteModules(),
    };
    if (!instance) {
      // Rack background: Add Module + Paste plus the same items as the
      // native File menu.
      return [
        {
          label: 'Add Module… (⌘M)',
          testId: 'ctx-add-module',
          onSelect: () => setPickerOpen(true),
        },
        paste,
        ...fileMenuItems,
      ];
    }
    // Right-click inside a multi-selection acts on the whole group; on any
    // other module it acts on just that module.
    const group = selected.includes(instance) && selected.length > 1 ? selected : [instance];
    const suffix = group.length > 1 ? ` (${group.length} modules)` : '';
    return [
      {
        label: `Copy${suffix}`,
        testId: 'ctx-copy',
        onSelect: () => void copyModules(group),
      },
      paste,
      {
        label: `Delete${suffix}`,
        testId: 'ctx-delete',
        onSelect: () => void removeModules(group),
      },
      ...(group.length === 1
        ? [
            {
              label: 'Documentation',
              testId: 'ctx-docs',
              onSelect: () => openDocs(instance),
            },
          ]
        : []),
      {
        label: `Reset to defaults${suffix}`,
        testId: 'ctx-reset',
        onSelect: () => {
          void engine.resetModules(group).then(refresh);
        },
      },
    ];
  }, [
    ctxMenu,
    fileMenuItems,
    selected,
    clipboardFilled,
    copyModules,
    pasteModules,
    removeModules,
    openDocs,
    refresh,
  ]);

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
        <button
          className="add-module-btn"
          data-testid="add-module-btn"
          data-tip="Add a module (⌘M)"
          onClick={() => setPickerOpen(true)}
        >
          + Add Module
        </button>
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
      {pickerOpen && (
        <ModulePicker
          modules={moduleLib}
          onAdd={addFromPicker}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <div className="app-body" style={view === 'rack' ? undefined : { display: 'none' }}>
        <RackStoreContext.Provider value={store}>
          <DeckUIContext.Provider value={deckUI}>
            <div
              className="rack-area"
              ref={setRackEl}
              data-testid="rack-area"
              style={{
                backgroundPosition: `${pan.x}px ${pan.y}px`,
                backgroundSize: `${GRID * zoom}px ${GRID * zoom}px`,
              }}
              onDragOver={onRackDragOver}
              onDrop={onRackDrop}
              onContextMenu={onRackContextMenu}
              onClick={(e) => {
                // Clicking the rack background abandons a pending wire and
                // clears the selection.
                if ((e.target as HTMLElement).closest?.('.module-panel')) return;
                const { pending, selected } = store.getState();
                if (pending) setPending(null);
                if (selected.length > 0) store.set({ selected: [] });
              }}
            >
              <div
                className="rack"
                data-testid="rack"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: '0 0',
                }}
              >
                {nodes.map((node, i) => (
                  <RackModule
                    key={node.instance_id}
                    instanceId={node.instance_id}
                    index={i}
                    refresh={refresh}
                    moveModule={moveModule}
                    endModuleDrag={endModuleDrag}
                    zoom={zoom}
                    removeModule={removeModule}
                    openDocs={openDocs}
                    selectModule={selectModule}
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
                layoutKey={`${JSON.stringify(positions)}@${zoom}@${pan.x},${pan.y}`}
              />
            </div>
          </DeckUIContext.Provider>
        </RackStoreContext.Provider>
      </div>
    </main>
  );
}
