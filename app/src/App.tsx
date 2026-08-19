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
import { DawBar, type DawApi } from './components/DawBar';
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
  boundingBox,
  defaultPosition,
  moduleRect,
  nearestFreeSpot,
  rectsOverlap,
  resolvePush,
  type Rect,
} from './rackLayout';
import {
  createRackStore,
  DAW_INSTANCE,
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
  // Wires are split between two overlays: rack-internal cables live inside
  // the pan/zoom transform; cables touching the DAW bar span the column.
  const rackWires = useMemo(
    () => wires.filter((w) => w.from_instance !== DAW_INSTANCE && w.to_instance !== DAW_INSTANCE),
    [wires],
  );
  const dawWires = useMemo(
    () => wires.filter((w) => w.from_instance === DAW_INSTANCE || w.to_instance === DAW_INSTANCE),
    [wires],
  );
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
  // The pan/zoom-transformed rack surface: the wire overlay renders inside
  // it and measures jacks in rack coordinates, so panning/zooming moves
  // cables via the CSS transform with no re-measure.
  const [rackInnerEl, setRackInnerEl] = useState<HTMLDivElement | null>(null);
  // The column wrapping the rack AND the DAW bottom bar: the overlay's
  // auxiliary jack root, so wires can anchor on bar jacks in both
  // collapsed and expanded states.
  const [columnEl, setColumnEl] = useState<HTMLDivElement | null>(null);
  // Marquee select: dragging on the rack background sweeps a rectangle
  // (rack coordinates); on release every module whose rect intersects it
  // joins the selection (replacing it, or adding with shift/cmd/ctrl).
  const [marquee, setMarquee] = useState<null | {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    additive: boolean;
  }>(null);
  // Latest marquee for the window mouseup handler (kept in sync via
  // effect — refs must not be written during render).
  const marqueeRef = useRef(marquee);
  useEffect(() => {
    marqueeRef.current = marquee;
  }, [marquee]);

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

  // Group drag: dragging any member of a multi-selection moves the whole
  // selection rigidly (relative arrangement preserved). Collision is the
  // group's bounding box against every non-member (simpler than per-member
  // resolution and predictable for irregular shapes): the same push-out
  // law as single modules, no co-operative bump.
  const moveGroup = useCallback(
    (instance: string, x: number, y: number, group: string[]) => {
      const nodes = store.getState().nodes;
      setPositions((prev) => {
        const posOf = (id: string) => {
          const idx = nodes.findIndex((n) => n.instance_id === id);
          return prev[id] ?? defaultPosition(Math.max(idx, 0));
        };
        const currentPos = posOf(instance);
        if (x === currentPos.x && y === currentPos.y) return prev;
        const memberRects = group.map((id) => moduleRect(id, posOf(id)));
        const bbox = boundingBox(memberRects);
        const others = nodes
          .filter((n) => !group.includes(n.instance_id))
          .map((n) => moduleRect(n.instance_id, posOf(n.instance_id)));
        // The drag reports the grabbed member's position; the bbox moves by
        // the same delta and the push-out resolves in bbox space.
        const dx = x - currentPos.x;
        const dy = y - currentPos.y;
        const want = { x: bbox.x + dx, y: bbox.y + dy };
        let target = want;
        if (others.some((o) => rectsOverlap({ ...want, w: bbox.w, h: bbox.h }, o))) {
          const resolved = resolvePush(
            want,
            { x: bbox.x, y: bbox.y },
            { w: bbox.w, h: bbox.h },
            others,
          );
          if (!resolved) return prev;
          target = resolved;
        }
        if (target.x === bbox.x && target.y === bbox.y) return prev;
        const next = { ...prev };
        for (const [i, id] of group.entries()) {
          next[id] = {
            x: memberRects[i].x + (target.x - bbox.x),
            y: memberRects[i].y + (target.y - bbox.y),
          };
        }
        saveJson(POSITIONS_KEY, next);
        return next;
      });
    },
    [store, setPositions],
  );

  const moveModule = useCallback(
    (instance: string, x: number, y: number) => {
      const { nodes, selected } = store.getState();
      if (selected.length > 1 && selected.includes(instance)) {
        dragBump.current = null;
        moveGroup(instance, x, y, selected);
        return;
      }
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
        // drag's dominant axis (resolvePush in rackLayout.ts — shared with
        // group drags).
        const resolve = (requested: { x: number; y: number }) => {
          const { w, h } = rectAt(requested);
          return resolvePush(
            requested,
            currentPos,
            { w, h },
            others.map((o) => o.rect),
          );
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
    [store, setPositions, moveGroup],
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
      // Warnings are non-fatal (e.g. a wire dropped because a newer module
      // version no longer has the saved jack): the patch still loaded, but
      // the user should know what got dropped.
      const warnings = (await engine.loadPatchByName(name)) ?? [];
      for (const w of warnings) reportError(`load ${name}`, w);
      setPatchName(name);
      await refresh();
    },
    [refresh],
  );

  // EVERY write to the module selection goes through here: it also clears
  // any native text selection, because a stray text selection makes cmd+C
  // defer to text copy (drags and shift-clicks create them as a side
  // effect, and preventDefault on mousedown stops them collapsing).
  // Bypassing this with a raw store.set({ selected }) is a review smell.
  const setSelected = useCallback(
    (ids: string[]) => {
      window.getSelection()?.removeAllRanges();
      store.set({ selected: ids });
    },
    [store],
  );

  // Sync the UI after the engine was replaced by a New Patch (the backend
  // reset already happened — native menu path — or is done by newPatch).
  const afterNewPatch = useCallback(async () => {
    setSelected([]);
    store.set({ pending: null });
    setPatchName('untitled');
    await refresh();
  }, [store, refresh, setSelected]);

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
    // Ticks race: each interval fires an independent round-trip, so a slow
    // response can resolve AFTER a fresher one and step playheads (and the
    // step-follower extrapolation feeding on them) backwards. Tag requests
    // and drop any response that isn't the newest in flight.
    let issued = 0;
    let applied = 0;
    const timer = setInterval(() => {
      const seq = ++issued;
      void (async () => {
        try {
          // One batched IPC round-trip per tick for the whole rack; the
          // backend acquires the engine lock once and taps every jack.
          const next = await engine.tapAll();
          if (next && seq > applied) {
            applied = seq;
            store.setTelemetry(next);
          }
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
        // Pressing an already-selected module keeps the whole selection
        // (selection happens on mousedown, so a header drag of one member
        // must not collapse the group).
        if (!prev.includes(instance)) setSelected([instance]);
        else window.getSelection()?.removeAllRanges();
        return;
      }
      setSelected(
        prev.includes(instance) ? prev.filter((i) => i !== instance) : [...prev, instance],
      );
    },
    [store, setSelected],
  );

  // Module clipboard: an opaque engine payload (modules + wires internal
  // to the copied set) plus each copied panel's rack rect (position AND
  // measured size — the pasted panels aren't in the DOM yet when they're
  // placed, so sizes must travel with the clipboard). Frontend-owned so it
  // survives engine edits.
  const clipboard = useRef<null | { payload: string; rects: Record<string, Rect> }>(null);
  // Rendered state for the paste menu items (a ref alone wouldn't
  // re-render the menu when the first copy happens).
  const [clipboardFilled, setClipboardFilled] = useState(false);

  const copyModules = useCallback(
    async (instances: string[]) => {
      if (instances.length === 0) return;
      const payload = await engine.copyModules(instances);
      if (!payload) return;
      const { nodes, positions } = store.getState();
      const rects: Record<string, Rect> = {};
      for (const id of instances) {
        const idx = nodes.findIndex((n) => n.instance_id === id);
        const pos = positions[id] ?? defaultPosition(Math.max(idx, 0));
        rects[id] = moduleRect(id, pos);
      }
      clipboard.current = { payload, rects };
      setClipboardFilled(true);
    },
    [store],
  );

  // Last pointer position over the rack, in unzoomed rack coordinates —
  // pastes land the group there. Tracked in a ref (no re-renders).
  const rackMouse = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!rackEl) return;
    const onMove = (e: MouseEvent) => {
      const rect = rackEl.getBoundingClientRect();
      rackMouse.current = {
        x: (e.clientX - rect.left - pan.x) / zoom,
        y: (e.clientY - rect.top - pan.y) / zoom,
      };
    };
    const onLeave = () => {
      rackMouse.current = null;
    };
    rackEl.addEventListener('mousemove', onMove);
    rackEl.addEventListener('mouseleave', onLeave);
    return () => {
      rackEl.removeEventListener('mousemove', onMove);
      rackEl.removeEventListener('mouseleave', onLeave);
    };
  }, [rackEl, pan, zoom]);

  const pasteModules = useCallback(async () => {
    const clip = clipboard.current;
    if (!clip) return;
    const renames = await engine.pasteModules(clip.payload);
    if (!renames) return;
    // The group pastes as ONE rigid unit: relative arrangement preserved,
    // its bounding box centered on the pointer (or one grid step down-right
    // of the source when the pointer isn't over the rack), snapped to the
    // grid and pushed to the nearest free spot for the whole box.
    setPositions((prev) => {
      const next = { ...prev };
      const placed: Rect[] = Object.entries(next).map(([id, pos]) => moduleRect(id, pos));
      const srcRects = Object.keys(renames)
        .map((oldId) => clip.rects[oldId])
        .filter((r): r is Rect => !!r);
      const bbox = boundingBox(srcRects.length > 0 ? srcRects : [{ x: 0, y: 0, w: 0, h: 0 }]);
      const mouse = rackMouse.current;
      const want = mouse
        ? { x: snap(mouse.x - bbox.w / 2), y: snap(mouse.y - bbox.h / 2) }
        : { x: bbox.x + GRID, y: bbox.y + GRID };
      const spot = nearestFreeSpot(want, { w: bbox.w, h: bbox.h }, placed) ?? want;
      for (const [oldId, newId] of Object.entries(renames)) {
        const src = clip.rects[oldId];
        next[newId] = src
          ? { x: spot.x + (src.x - bbox.x), y: spot.y + (src.y - bbox.y) }
          : { x: spot.x, y: spot.y };
        placed.push({ ...next[newId], w: src?.w ?? GRID * 4, h: src?.h ?? GRID * 2 });
      }
      saveJson(POSITIONS_KEY, next);
      return next;
    });
    // Select the pasted set only after the refresh has brought the new
    // nodes in — setNodes prunes selection against the live node list, so
    // selecting first would race the prune.
    await refresh();
    setSelected(Object.values(renames));
  }, [setPositions, refresh, setSelected]);

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
      setSelected(selected.filter((i) => !instances.includes(i)));
      if (pending && instances.includes(pending.instance)) setPending(null);
      await refresh();
    },
    [store, setPositions, setPending, refresh, setSelected],
  );

  const collapseToMacro = useCallback(
    async (name: string) => {
      const selected = store.getState().selected;
      if (!name.trim() || selected.length === 0) return;
      await engine.collapseMacro(selected, name.trim());
      setSelected([]);
      setCollapseName(null);
      const modules = await engine.listModules();
      if (modules) setModuleLib(modules);
      await refresh();
    },
    [store, refresh, setSelected],
  );

  // Global shortcuts: undo/redo (cmd/ctrl+Z, cmd/ctrl+Y, cmd/ctrl+shift+Z),
  // rack zoom (cmd/ctrl +/-/0), select-all (cmd/ctrl+A), selection
  // copy/paste (cmd/ctrl+C/V) and selection delete (Backspace).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        store.set({ pending: null });
        setSelected([]);
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
        // Module selection wins: every selection write clears native text
        // selections (setSelected), so any that exists here is deliberate
        // text-copying — but only defer to it when NO modules are
        // selected, so a stray highlight can never silently eat a module
        // copy.
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
        setSelected(store.getState().nodes.map((n) => n.instance_id));
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
  }, [
    store,
    refresh,
    changeZoom,
    savePatch,
    copyModules,
    pasteModules,
    removeModules,
    setSelected,
  ]);

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

  // Marquee select: window-level move/up listeners while a background drag
  // is sweeping. Selection resolves on release — every module whose rect
  // intersects the swept rectangle (in rack coordinates) gets selected.
  const toRackCoords = useCallback(
    (clientX: number, clientY: number) => {
      const rect = rackEl?.getBoundingClientRect();
      return {
        x: ((rect ? clientX - rect.left : clientX) - pan.x) / zoom,
        y: ((rect ? clientY - rect.top : clientY) - pan.y) / zoom,
      };
    },
    [rackEl, pan, zoom],
  );
  const marqueeActive = marquee !== null;
  useEffect(() => {
    if (!marqueeActive) return;
    const onMove = (e: MouseEvent) => {
      const p = toRackCoords(e.clientX, e.clientY);
      setMarquee((m) => (m ? { ...m, x1: p.x, y1: p.y } : m));
    };
    const onUp = () => {
      const m = marqueeRef.current;
      setMarquee(null);
      if (!m) return;
      const box: Rect = {
        x: Math.min(m.x0, m.x1),
        y: Math.min(m.y0, m.y1),
        w: Math.abs(m.x1 - m.x0),
        h: Math.abs(m.y1 - m.y0),
      };
      // A motionless press is a plain background click (already cleared on
      // mousedown), not a selection sweep.
      if (box.w < 2 && box.h < 2) return;
      const { nodes, positions, selected } = store.getState();
      const hit = nodes
        .filter((n, i) =>
          rectsOverlap(
            box,
            moduleRect(n.instance_id, positions[n.instance_id] ?? defaultPosition(i)),
          ),
        )
        .map((n) => n.instance_id);
      // setSelected (not a raw store.set): the sweep drags across text
      // outside the panels and leaves a native text selection behind,
      // which would make the next cmd+C silently copy text instead of
      // the swept modules.
      setSelected(m.additive ? [...new Set([...selected, ...hit])] : hit);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [marqueeActive, toRackCoords, store, setSelected]);

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
        setSelected([instance]);
      }
      setCtxMenu({ x: e.clientX, y: e.clientY, instance });
    },
    [store, setSelected],
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

  // Stable IPC adapter for the DAW bottom bar (the ChoreoApi pattern).
  const dawApi = useMemo<DawApi>(
    () => ({
      status: () => engine.dawStatus(),
      addTrack: (n, k, s) => engine.dawAddTrack(n, k, s),
      removeTrack: (t) => engine.dawRemoveTrack(t),
      renameTrack: (t, n) => engine.dawRenameTrack(t, n),
      moveTrack: (f, t) => engine.dawMoveTrack(f, t),
      importClip: (t, p) => engine.dawImportClip(t, p),
      clearClip: (t) => engine.dawClearClip(t),
      play: () => engine.dawPlay(),
      stop: () => engine.dawStop(),
      seek: (f) => engine.dawSeek(f),
      recordStart: (t, s) => engine.dawRecordStart(t, s),
      recordStop: () => engine.dawRecordStop(),
      recordCancel: () => engine.dawRecordCancel(),
      clipPeaks: (t, b) => engine.dawClipPeaks(t, b),
      setBpm: (b) => engine.dawSetBpm(b),
      setLength: (b) => engine.dawSetLength(b),
      addNote: (t, n) => engine.dawAddNote(t, n.beat, n.len, n.pitch, n.velocity),
      removeNote: (t, beat, pitch) => engine.dawRemoveNote(t, beat, pitch),
      setKnobPosition: (jack, p) => engine.setKnobPosition('daw', jack, p),
      endEdit: () => engine.endEdit(),
    }),
    [],
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
            <div className="rack-column" ref={setColumnEl} data-testid="rack-column">
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
                onMouseDown={(e) => {
                  // Pressing the rack background abandons a pending wire,
                  // clears the selection (unless shift/cmd/ctrl — additive
                  // marquee), and arms a marquee sweep. Mousedown, not click:
                  // selection happens on mousedown too, and the synthetic
                  // click a module drag fires on the rack (mouseup landing
                  // over the background) must not wipe the drag's own
                  // selection.
                  if (e.button !== 0) return;
                  if ((e.target as HTMLElement).closest?.('.module-panel')) return;
                  // The sweep must never double as a native text-selection
                  // drag (a text selection hijacks cmd+C).
                  e.preventDefault();
                  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
                  const { pending, selected } = store.getState();
                  if (pending) setPending(null);
                  if (!additive && selected.length > 0) setSelected([]);
                  const p = toRackCoords(e.clientX, e.clientY);
                  setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive });
                }}
              >
                <div
                  className="rack"
                  data-testid="rack"
                  ref={setRackInnerEl}
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
                  {marquee && (
                    <div
                      className="marquee"
                      data-testid="marquee"
                      style={{
                        left: Math.min(marquee.x0, marquee.x1),
                        top: Math.min(marquee.y0, marquee.y1),
                        width: Math.abs(marquee.x1 - marquee.x0),
                        height: Math.abs(marquee.y1 - marquee.y0),
                      }}
                    />
                  )}
                  {/* Inside the transformed rack, in rack coordinates: pan
                      and zoom move the cables through the CSS transform, so
                      they are deliberately NOT part of layoutKey. Wires
                      touching the DAW bar (outside this transform) are
                      drawn by the column overlay below instead. */}
                  <WireOverlay
                    wires={rackWires}
                    container={rackInnerEl}
                    colors={wireColors}
                    pending={pending && pending.instance !== DAW_INSTANCE ? pending : null}
                    zoom={zoom}
                    layoutKey={JSON.stringify(positions)}
                  />
                </div>
              </div>
              <DawBar
                api={dawApi}
                libraryTracks={libraryTracks}
                onJackClick={(instance, kind, jack, shift) =>
                  void onJackClick(instance, kind, jack, shift)
                }
                onChanged={() => void refresh()}
              />
              {/* Wires with a DAW-bar end span the untransformed column, so
                  their rack-side sockets move on screen with pan/zoom —
                  unlike the rack overlay these few cables re-measure via
                  layoutKey. */}
              <WireOverlay
                wires={dawWires}
                container={columnEl}
                colors={wireColors}
                pending={pending && pending.instance === DAW_INSTANCE ? pending : null}
                layoutKey={`${JSON.stringify(positions)}@${zoom}@${pan.x},${pan.y}`}
              />
            </div>
          </DeckUIContext.Provider>
        </RackStoreContext.Provider>
      </div>
    </main>
  );
}
