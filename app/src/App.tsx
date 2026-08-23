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
import { engine, onMenuAction, type MacroGroup, type MacroInfo, type ModuleMove } from './engine';
import { isEditableTarget, useFileShortcuts } from './fileShortcuts';
import { RackKeysContext } from './keyScope';
import { library, type Track } from './library';
import { ContextMenu, type ContextMenuItem } from './components/ContextMenu';
import { MacroBoxes } from './components/MacroBoxes';
import { AudioUIContext } from './components/AudioPanel';
import { DeckUIContext } from './components/DeckPanel';
import { DocsPanel } from './components/DocsPanel';
import { ErrorBanner } from './components/ErrorBanner';
import { reportError } from './errors';
import { LibraryView } from './components/LibraryView';
import { ClipView, type ClipViewHandle } from './components/ClipView';
import { clipClient } from './clip';
import { MODULE_DRAG_TYPE, ModulePicker, nextInstanceId } from './components/ModulePicker';
import { GRID, snap } from './components/ModulePanel';
import { RackModule } from './components/RackModule';
import { TooltipLayer } from './components/TooltipLayer';
import { WIRE_COLORS, WireOverlay } from './components/WireOverlay';
import {
  boundingBox,
  defaultPosition,
  macroBoxRect,
  moduleRect,
  nearestFreeSpot,
  rectsOverlap,
  resolvePush,
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
  const [view, setView] = useState<'rack' | 'library' | 'clip'>('rack');
  // The library's Edit button opens a track in the (always mounted) clip
  // editor, which owns what that costs the edit already in there.
  const clipView = useRef<ClipViewHandle>(null);
  const [wireColors, setWireColors] = useState<Record<string, number>>(() =>
    loadJson(WIRE_COLORS_KEY, {}),
  );
  const [patchName, setPatchName] = useState('untitled');
  const [patchList, setPatchList] = useState<string[]>([]);
  // File-menu dialogs (Save As… / Open Patch…), driven by native menu events.
  const [fileDialog, setFileDialog] = useState<null | 'save-as' | 'open'>(null);
  const [saveAsName, setSaveAsName] = useState('untitled');
  // Unsaved-changes prompt: a destructive action (New Patch, Open) found
  // edits since the last save; `proceed` runs it after Save or Discard.
  const [confirmDiscard, setConfirmDiscard] = useState<null | { proceed: () => void }>(null);
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([]);
  const [collapseName, setCollapseName] = useState<string | null>(null);
  // Collapse hit an existing same-named macro: confirm before overwriting.
  const [macroOverwrite, setMacroOverwrite] = useState<MacroInfo | null>(null);
  const [macroPull, setMacroPull] = useState<MacroGroup | null>(null);
  // Expanded macro instances (bounding-box overlay + grouping semantics).
  const [macroGroups, setMacroGroups] = useState<MacroGroup[]>([]);

  // Instance id -> owning top-level macro group. Macro members act as one
  // unit for selection/copy/delete/drag; per-member knob and wire edits
  // stay individual.
  const macroOwner = useMemo(() => {
    const map = new Map<string, MacroGroup>();
    for (const g of macroGroups) {
      for (const m of g.members) map.set(m, g);
    }
    return map;
  }, [macroGroups]);

  /** Expand a set of instance ids so macro groups are all-or-nothing. */
  const expandGroups = useCallback(
    (ids: string[]) => {
      const out = new Set<string>();
      for (const id of ids) {
        const g = macroOwner.get(id);
        if (g) for (const m of g.members) out.add(m);
        else out.add(id);
      }
      return [...out];
    },
    [macroOwner],
  );

  /** Engine-facing ids: macro members map to their instance id (which the
   *  engine's copy/remove/reset accept), plain modules pass through. */
  const toTopLevel = useCallback(
    (ids: string[]) => {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const id of ids) {
        const top = macroOwner.get(id)?.instance ?? id;
        if (!seen.has(top)) {
          seen.add(top);
          out.push(top);
        }
      }
      return out;
    },
    [macroOwner],
  );
  // Right-click menu: over a module (instance set), a macro box (group) or
  // the rack background.
  const [ctxMenu, setCtxMenu] = useState<null | {
    x: number;
    y: number;
    instance?: string;
    macroGroup?: MacroGroup;
  }>(null);
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

  // Layout-entry lifetime around edits that RENAME or REMOVE modules
  // (macro collapse/break, rename, delete). The rack keeps rendering the
  // PRE-edit snapshot until the edit's `refresh` lands — several IPC
  // round-trips later — and anything without a layout entry falls back to
  // `defaultPosition`: retiring entries up front teleports the old panels
  // (and the macro box drawn around them, title bar included) to the rack
  // origin for the whole round-trip, over whatever is parked there. So new
  // ids are seeded FIRST (`carryPositions`, additive) and the retired
  // entries are dropped only AFTER the refresh (`dropPositions`).
  const carryPositions = useCallback(
    (renames: Record<string, string>) => {
      setPositions((prev) => {
        let next = prev;
        for (const [oldId, newId] of Object.entries(renames)) {
          const at = prev[oldId];
          if (!at) continue;
          if (next === prev) next = { ...prev };
          next[newId] = at;
        }
        if (next === prev) return prev;
        saveJson(POSITIONS_KEY, next);
        return next;
      });
    },
    [setPositions],
  );

  const dropPositions = useCallback(
    (ids: Iterable<string>) => {
      setPositions((prev) => {
        let next = prev;
        for (const id of ids) {
          if (!(id in prev)) continue;
          if (next === prev) next = { ...prev };
          delete next[id];
        }
        if (next === prev) return prev;
        saveJson(POSITIONS_KEY, next);
        return next;
      });
    },
    [setPositions],
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

  // Every module the in-flight drag gesture has displaced (grabbed panel,
  // group/macro members, bumped neighbours) with its PRE-gesture position.
  // Flushed to the engine as one undoable batch on release.
  const dragMoved = useRef(new Map<string, { x: number; y: number }>());

  const noteMove = useCallback((id: string, before: { x: number; y: number }) => {
    if (!dragMoved.current.has(id)) dragMoved.current.set(id, before);
  }, []);

  const endModuleDrag = useCallback(
    (instance?: string) => {
      // Releasing the drag makes any surviving bump permanent (positions,
      // including the neighbour's, were already committed by moveModule
      // through the one shared setPositions/saveJson path).
      if (instance === undefined || dragBump.current?.dragged === instance) {
        dragBump.current = null;
      }
      // Commit the whole gesture to the engine as ONE undo step (bump
      // reverts drop out: they ended where they started).
      const moved = dragMoved.current;
      dragMoved.current = new Map();
      const positions = store.getState().positions;
      const moves: ModuleMove[] = [];
      for (const [id, from] of moved) {
        const to = positions[id];
        if (!to || (to.x === from.x && to.y === from.y)) continue;
        moves.push({ instance: id, from: [from.x, from.y], to: [to.x, to.y] });
      }
      if (moves.length > 0) void engine.moveModules(moves);
    },
    [store],
  );

  // Collision rects for everything outside `exclude`: macro groups count
  // as ONE solid rect — their full bounding box, border padding and label
  // tab included — exactly like a module's own footprint (nothing may park
  // inside another macro's box). Macro entries are marked so the
  // co-operative bump skips them (a box has no single position to write).
  const collisionRects = useCallback(
    (exclude: Set<string>, posOf: (id: string) => { x: number; y: number }) => {
      const nodes = store.getState().nodes;
      const out: { id: string; rect: Rect; isMacro: boolean }[] = [];
      const seen = new Set<string>();
      for (const n of nodes) {
        const id = n.instance_id;
        if (exclude.has(id)) continue;
        const g = macroOwner.get(id);
        if (!g) {
          out.push({ id, rect: moduleRect(id, posOf(id)), isMacro: false });
          continue;
        }
        if (seen.has(g.instance)) continue;
        seen.add(g.instance);
        const memberRects = g.members
          .filter((m) => !exclude.has(m) && nodes.some((nn) => nn.instance_id === m))
          .map((m) => moduleRect(m, posOf(m)));
        if (memberRects.length === 0) continue;
        out.push({ id: g.instance, rect: macroBoxRect(boundingBox(memberRects)), isMacro: true });
      }
      return out;
    },
    [store, macroOwner],
  );

  /** Footprint of a moving set: fully-included macro groups contribute
   *  their solid box rect (padding + label), loose modules their panel
   *  rect — so two macros can never overlap and modules keep out of a
   *  macro's frame while it drags. */
  const groupFootprint = useCallback(
    (group: string[], posOf: (id: string) => { x: number; y: number }) => {
      const inGroup = new Set(group);
      const rects: Rect[] = [];
      const seen = new Set<string>();
      for (const id of group) {
        const g = macroOwner.get(id);
        if (g && g.members.every((m) => inGroup.has(m))) {
          if (seen.has(g.instance)) continue;
          seen.add(g.instance);
          rects.push(macroBoxRect(boundingBox(g.members.map((m) => moduleRect(m, posOf(m))))));
        } else {
          rects.push(moduleRect(id, posOf(id)));
        }
      }
      return boundingBox(rects);
    },
    [macroOwner],
  );

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
        const bbox = groupFootprint(group, posOf);
        const others = collisionRects(new Set(group), posOf).map((o) => o.rect);
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
          noteMove(id, { x: memberRects[i].x, y: memberRects[i].y });
          next[id] = {
            x: memberRects[i].x + (target.x - bbox.x),
            y: memberRects[i].y + (target.y - bbox.y),
          };
        }
        saveJson(POSITIONS_KEY, next);
        return next;
      });
    },
    [store, setPositions, collisionRects, groupFootprint, noteMove],
  );

  const moveModule = useCallback(
    (instance: string, x: number, y: number) => {
      const { nodes, selected } = store.getState();
      if (selected.length > 1 && selected.includes(instance)) {
        dragBump.current = null;
        moveGroup(instance, x, y, selected);
        return;
      }
      // Dragging any macro member moves its whole group rigidly: a macro
      // is one unit on the rack (the bounding box goes along for free).
      const owner = macroOwner.get(instance);
      if (owner) {
        dragBump.current = null;
        moveGroup(instance, x, y, owner.members);
        return;
      }
      setPositions((prev) => {
        const bump = dragBump.current?.dragged === instance ? dragBump.current : null;
        // Two views of the neighbours: `others` virtually reverts an active
        // bump (the bump only survives if this move still needs it), while
        // `realRects` reflects what is actually on screen. Macro groups are
        // one solid box rect (frame + label) and never bump (a box has no
        // single position to displace).
        const others: {
          id: string;
          pos: { x: number; y: number };
          rect: Rect;
          bumpable: boolean;
        }[] = [];
        const realRects: Rect[] = [];
        const seenMacros = new Set<string>();
        for (const [i, node] of nodes.entries()) {
          const id = node.instance_id;
          if (id === instance) continue;
          const g = macroOwner.get(id);
          if (g) {
            if (seenMacros.has(g.instance)) continue;
            seenMacros.add(g.instance);
            const memberRects = g.members
              .filter((m) => nodes.some((nn) => nn.instance_id === m))
              .map((m) => {
                const mi = nodes.findIndex((nn) => nn.instance_id === m);
                return moduleRect(m, prev[m] ?? defaultPosition(Math.max(mi, 0)));
              });
            if (memberRects.length === 0) continue;
            const box = macroBoxRect(boundingBox(memberRects));
            others.push({
              id: g.instance,
              pos: { x: box.x, y: box.y },
              rect: box,
              bumpable: false,
            });
            realRects.push(box);
            continue;
          }
          const realPos = prev[id] ?? defaultPosition(i);
          const pos = bump && bump.bumped === id ? bump.from : realPos;
          others.push({ id, pos, rect: moduleRect(id, pos), bumpable: true });
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
          if (!hit.bumpable) return null;
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
        noteMove(instance, currentPos);
        const next = { ...prev, [instance]: target };
        if (bump && bump.bumped !== nextBump?.bumped) next[bump.bumped] = bump.from;
        if (nextBump) {
          noteMove(nextBump.bumped, nextBump.from);
          next[nextBump.bumped] = nextBump.to;
        }
        dragBump.current = nextBump
          ? { dragged: instance, bumped: nextBump.bumped, from: nextBump.from }
          : null;
        saveJson(POSITIONS_KEY, next);
        return next;
      });
    },
    [store, setPositions, moveGroup, macroOwner, noteMove],
  );

  // Post-render placement pass: with real panel sizes in the DOM, move any
  // module that overlaps an earlier one to the nearest free grid spot (same
  // search as drop placement, so corrections stay near the intended point).
  // Covers click-to-add, drops estimated with fallback sizes, and stale
  // saved layouts. Macro groups are one rigid unit here too: the whole
  // group relocates by its solid box footprint (padding + label) and its
  // internal arrangement is never disturbed.
  useEffect(() => {
    const timer = setTimeout(() => {
      setPositions((prev) => {
        const placed: Rect[] = [];
        const next: Positions = { ...prev };
        let changed = false;
        const posOf = (id: string, i: number) => next[id] ?? defaultPosition(i);
        const seenMacros = new Set<string>();
        for (const [i, node] of nodes.entries()) {
          const id = node.instance_id;
          const g = macroOwner.get(id);
          if (g) {
            if (seenMacros.has(g.instance)) continue;
            seenMacros.add(g.instance);
            const members = g.members.filter((m) => nodes.some((n) => n.instance_id === m));
            if (members.length === 0) continue;
            const rects = members.map((m) =>
              moduleRect(
                m,
                posOf(
                  m,
                  Math.max(
                    nodes.findIndex((n) => n.instance_id === m),
                    0,
                  ),
                ),
              ),
            );
            const box = macroBoxRect(boundingBox(rects));
            const spot = nearestFreeSpot({ x: box.x, y: box.y }, { w: box.w, h: box.h }, placed);
            const dx = spot ? spot.x - box.x : 0;
            const dy = spot ? spot.y - box.y : 0;
            if (dx !== 0 || dy !== 0) {
              for (const [mi, m] of members.entries()) {
                next[m] = { x: rects[mi].x + dx, y: rects[mi].y + dy };
              }
              changed = true;
            }
            placed.push({ x: box.x + dx, y: box.y + dy, w: box.w, h: box.h });
            continue;
          }
          let pos = posOf(id, i);
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
        // Mirror corrections into the engine layout (no undo step) so a
        // later refresh doesn't re-adopt the stale pre-fixup positions.
        const synced: Record<string, [number, number]> = {};
        for (const [id, p] of Object.entries(next)) {
          if (prev[id]?.x !== p.x || prev[id]?.y !== p.y) synced[id] = [p.x, p.y];
        }
        void engine.syncPositions(synced);
        return next;
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [nodes, setPositions, macroOwner]);

  const refresh = useCallback(async () => {
    const snapshot = await engine.nodes();
    setConnected(snapshot !== null);
    if (snapshot) {
      store.setNodes(snapshot);
      // Adopt engine-known rack positions: undo/redo restores (moves,
      // deletes, macro deletes) land here. Nodes the engine has no
      // position for keep their local layout.
      const prev = store.getState().positions;
      let adopted: Positions | null = null;
      for (const n of snapshot) {
        const p = n.position;
        if (!p) continue;
        const cur = prev[n.instance_id];
        if (!cur || cur.x !== p[0] || cur.y !== p[1]) {
          adopted = adopted ?? { ...prev };
          adopted[n.instance_id] = { x: p[0], y: p[1] };
        }
      }
      if (adopted) {
        store.set({ positions: adopted });
        saveJson(POSITIONS_KEY, adopted);
      }
    }
    const wireList = await engine.wires();
    if (wireList) store.set({ wires: wireList });
    const groups = await engine.macroGroups();
    if (groups) setMacroGroups(groups);
    const tracks = await library.tracks();
    if (tracks) setLibraryTracks(tracks);
  }, [store]);

  /** Place a macro instance's expanded members using the definition's
   *  saved arrangement (relative positions), anchored at `at` (falling
   *  back to any position stored under the instance id — e.g. a layout
   *  saved by the old collapsed view — then to a spot near the origin).
   *  Members the definition has no position for are left to the post-
   *  render placement fixup. */
  const placeMacroGroup = useCallback(
    async (instance: string, macroId: string, at?: { x: number; y: number }) => {
      const layout = (await engine.macroLayout(macroId)) ?? {};
      const entries = Object.entries(layout);
      if (entries.length === 0) return;
      const { nodes, positions: prev } = store.getState();
      const exclude = new Set(
        nodes.map((n) => n.instance_id).filter((id) => id.startsWith(`${instance}/`)),
      );
      const placed = collisionRects(
        exclude,
        (id) =>
          prev[id] ??
          defaultPosition(
            Math.max(
              nodes.findIndex((n) => n.instance_id === id),
              0,
            ),
          ),
      ).map((o) => o.rect);
      const rels = entries.map(([id, [x, y]]) => ({
        id: `${instance}/${id}`,
        rect: moduleRect(`${instance}/${id}`, { x, y }),
      }));
      // Search with the group's SOLID box footprint (frame + label) so the
      // new macro lands clear of other macro boxes, not just their panels.
      const bbox = macroBoxRect(boundingBox(rels.map((r) => r.rect)));
      const want = at ?? prev[instance] ?? { x: GRID, y: GRID };
      const spot = nearestFreeSpot(want, { w: bbox.w, h: bbox.h }, placed) ?? want;
      setPositions((p) => {
        const next = { ...p };
        // A paste/legacy layout may have parked a position under the
        // instance id itself; the members replace it.
        delete next[instance];
        for (const r of rels) {
          next[r.id] = { x: spot.x + (r.rect.x - bbox.x), y: spot.y + (r.rect.y - bbox.y) };
        }
        saveJson(POSITIONS_KEY, next);
        return next;
      });
      // Mirror the placement into the engine layout (no undo step) so a
      // later delete+undo of the group restores this arrangement.
      const synced: Record<string, [number, number]> = {};
      for (const r of rels) {
        synced[r.id] = [spot.x + (r.rect.x - bbox.x), spot.y + (r.rect.y - bbox.y)];
      }
      void engine.syncPositions(synced);
    },
    [store, setPositions, collisionRects],
  );

  /** Lay out any macro group whose members have no stored positions yet
   *  (fresh patch load on this machine, pasted/recreated instances). */
  const placeUnplacedMacros = useCallback(
    async (groups?: MacroGroup[]) => {
      const list = groups ?? (await engine.macroGroups()) ?? [];
      for (const g of list) {
        const prev = store.getState().positions;
        if (g.members.some((m) => prev[m])) continue;
        await placeMacroGroup(g.instance, g.macro_id);
      }
    },
    [store, placeMacroGroup],
  );

  // Whatever brought a macro group in (patch load, undo/redo recreation,
  // startup) — if its members have no saved positions on this machine,
  // lay them out from the definition's arrangement.
  useEffect(() => {
    if (macroGroups.length > 0) void placeUnplacedMacros(macroGroups);
  }, [macroGroups, placeUnplacedMacros]);

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

  // Gate a destructive action (New Patch, loading another patch) behind
  // the unsaved-changes prompt: when the live patch has edits since the
  // last save/load/new, ask to save or discard before running it.
  const guardUnsaved = useCallback((action: () => void) => {
    void engine.patchDirty().then((dirty) => {
      if (dirty) setConfirmDiscard({ proceed: action });
      else action();
    });
  }, []);

  const requestNewPatch = useCallback(
    () => guardUnsaved(() => void newPatch()),
    [guardUnsaved, newPatch],
  );

  const requestLoadPatch = useCallback(
    (name: string) => guardUnsaved(() => void loadNamedPatch(name)),
    [guardUnsaved, loadNamedPatch],
  );

  const openSaveAsDialog = useCallback(() => {
    setSaveAsName(patchName);
    setFileDialog('save-as');
  }, [patchName]);

  const openOpenDialog = useCallback(() => {
    void engine.listPatches().then((l) => setPatchList(l ?? []));
    setFileDialog('open');
  }, []);

  // Native File menu (Save is handled fully in the backend; Save As /
  // Open open in-app dialogs; New asks the frontend so the unsaved-changes
  // prompt can run first). Tests drive this via `dj-menu` CustomEvents.
  useEffect(
    () =>
      onMenuAction((action) => {
        if (action === 'saved') {
          void engine.currentPatch().then((n) => {
            if (n) setPatchName(n);
          });
          void engine.listPatches().then((l) => setPatchList(l ?? []));
        } else if (action === 'request-new') {
          requestNewPatch();
        } else if (action === 'save-as') {
          openSaveAsDialog();
        } else if (action === 'open') {
          openOpenDialog();
        }
      }),
    [requestNewPatch, openSaveAsDialog, openOpenDialog],
  );

  // cmd/ctrl+S / +O / +N mirror File > Save / Open Patch… / New Patch.
  useFileShortcuts({
    save: savePatch,
    open: openOpenDialog,
    create: requestNewPatch,
    modalOpen:
      fileDialog !== null ||
      confirmDiscard !== null ||
      collapseName !== null ||
      macroOverwrite !== null ||
      pickerOpen,
  });

  // The File menu as context-menu items: the rack-background right-click
  // menu renders exactly this list, and each entry reuses the same action
  // the native File menu triggers, so the two menus stay in sync.
  const fileMenuItems = useMemo<ContextMenuItem[]>(
    () => [
      { label: 'New Patch', testId: 'ctx-new-patch', onSelect: requestNewPatch },
      { label: 'Save Patch', testId: 'ctx-save', onSelect: () => void savePatch() },
      { label: 'Save Patch As…', testId: 'ctx-save-as', onSelect: openSaveAsDialog },
      { label: 'Open Patch…', testId: 'ctx-open', onSelect: openOpenDialog },
    ],
    [requestNewPatch, savePatch, openSaveAsDialog, openOpenDialog],
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
      const isMacro = moduleLib.find((m) => m.id === typeId)?.abi === 'macro-1';
      if (isMacro) {
        // A macro expands to a group of panels: lay them out from the
        // definition's saved arrangement, anchored at the drop point.
        await placeMacroGroup(instance, typeId, at);
      } else if (at) {
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
    [store, refresh, moveModule, moduleLib, placeMacroGroup],
  );

  // Selection model (standard desktop semantics): a plain click on a module
  // selects exactly that module, shift/cmd/ctrl-click toggles membership,
  // a rack-background click or Escape clears, cmd/ctrl+A selects all.
  // Macro members select as a group (all-or-nothing), so a macro always
  // moves/copies/deletes as one unit. Engine refreshes prune ids that no
  // longer exist (rackStore.setNodes), so a selection can never outlive
  // its modules.
  const selectModule = useCallback(
    (instance: string, additive: boolean) => {
      const prev = store.getState().selected;
      const unit = expandGroups([instance]);
      if (!additive) {
        // Pressing an already-selected module keeps the whole selection
        // (selection happens on mousedown, so a header drag of one member
        // must not collapse the group).
        if (!prev.includes(instance)) setSelected(unit);
        else window.getSelection()?.removeAllRanges();
        return;
      }
      setSelected(
        prev.includes(instance)
          ? prev.filter((i) => !unit.includes(i))
          : [...new Set([...prev, ...unit])],
      );
    },
    [store, setSelected, expandGroups],
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
      // The engine's clipboard speaks top-level ids: macro members copy as
      // their whole instance (a macro is all-or-nothing).
      const topIds = toTopLevel(instances);
      const payload = await engine.copyModules(topIds);
      if (!payload) return;
      const { nodes, positions } = store.getState();
      const posOf = (id: string) => {
        const idx = nodes.findIndex((n) => n.instance_id === id);
        return positions[id] ?? defaultPosition(Math.max(idx, 0));
      };
      const rects: Record<string, Rect> = {};
      for (const id of topIds) {
        const group = macroGroups.find((g) => g.instance === id);
        rects[id] = group
          ? boundingBox(group.members.map((m) => moduleRect(m, posOf(m))))
          : moduleRect(id, posOf(id));
      }
      clipboard.current = { payload, rects };
      setClipboardFilled(true);
    },
    [store, toTopLevel, macroGroups],
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
    // Pasted macro instances arrive with unplaced internals: lay each out
    // from its definition, anchored where the paste put the group.
    await placeUnplacedMacros();
    const pasted = (await engine.macroGroups()) ?? [];
    setSelected(
      Object.values(renames).flatMap(
        (id) => pasted.find((g) => g.instance === id)?.members ?? [id],
      ),
    );
  }, [setPositions, refresh, setSelected, placeUnplacedMacros]);

  const removeModules = useCallback(
    async (instances: string[]) => {
      if (instances.length === 0) return;
      // Macro members delete as their whole instance (all-or-nothing).
      const topIds = toTopLevel(instances);
      const gone = expandGroups(instances);
      // Seed the engine layout with the doomed modules' on-screen spots
      // (no undo step) BEFORE deleting, so the delete's undo snapshot
      // restores them — macro members included — right where they were.
      const { nodes: curNodes, positions: curPositions } = store.getState();
      const seed: Record<string, [number, number]> = {};
      for (const id of gone) {
        const p =
          curPositions[id] ??
          defaultPosition(
            Math.max(
              curNodes.findIndex((n) => n.instance_id === id),
              0,
            ),
          );
        seed[id] = [p.x, p.y];
      }
      await engine.syncPositions(seed);
      await engine.removeModules(topIds);
      const { pending, selected } = store.getState();
      setSelected(selected.filter((i) => !gone.includes(i)));
      if (pending && gone.includes(pending.instance)) setPending(null);
      await refresh();
      dropPositions(gone);
    },
    [store, dropPositions, setPending, refresh, setSelected, toTopLevel, expandGroups],
  );

  const collapseToMacro = useCallback(
    async (name: string, overwrite?: boolean) => {
      const selected = store.getState().selected;
      if (!name.trim() || selected.length === 0) return;
      // The selection may contain macro members; the engine collapses
      // top-level ids (nested macros collapse whole).
      const topIds = toTopLevel(selected);
      // Definition positions: each collapsed unit's current rack position
      // (a nested macro's is its group bounding-box corner).
      const { nodes, positions: prev } = store.getState();
      const posOf = (id: string) => {
        const idx = nodes.findIndex((n) => n.instance_id === id);
        return prev[id] ?? defaultPosition(Math.max(idx, 0));
      };
      const defPositions: Record<string, [number, number]> = {};
      for (const id of topIds) {
        const group = macroGroups.find((g) => g.instance === id);
        if (group) {
          const box = boundingBox(group.members.map((m) => moduleRect(m, posOf(m))));
          defPositions[id] = [box.x, box.y];
        } else {
          const p = posOf(id);
          defPositions[id] = [p.x, p.y];
        }
      }
      const outcome = await engine.collapseMacro(topIds, name.trim(), defPositions, overwrite);
      // A same-named macro already exists: keep the form up and ask before
      // overwriting (retried with overwrite=true from the confirm dialog).
      if (outcome?.conflict) {
        setMacroOverwrite(outcome.conflict);
        return;
      }
      const instance = outcome?.instance ?? null;
      setSelected([]);
      setCollapseName(null);
      const modules = await engine.listModules();
      if (modules) setModuleLib(modules);
      // The engine rebuilt the selection as <instance>/<old id> nodes
      // (nested macro members gain the same prefix): carry every panel's
      // position over so nothing moves on screen.
      const retired: string[] = [];
      if (instance) {
        const prevPositions = store.getState().positions;
        const prefixed: Record<string, string> = {};
        for (const id of topIds) {
          for (const key of Object.keys(prevPositions)) {
            if (key === id || key.startsWith(`${id}/`)) prefixed[key] = `${instance}/${key}`;
          }
        }
        carryPositions(prefixed);
        retired.push(...Object.keys(prefixed));
        // Units that were never placed have no entry to carry: record the
        // default slot they render at, so they don't move either.
        setPositions((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const id of topIds) {
            const key = `${instance}/${id}`;
            if (next[key] || macroGroups.some((g) => g.instance === id)) continue;
            next[key] = posOf(id);
            changed = true;
          }
          if (!changed) return prev;
          saveJson(POSITIONS_KEY, next);
          return next;
        });
      }
      await refresh();
      dropPositions(retired);
    },
    [
      store,
      refresh,
      setSelected,
      toTopLevel,
      macroGroups,
      setPositions,
      carryPositions,
      dropPositions,
    ],
  );

  // Right-click actions on macro entries in the module picker. Rename
  // keeps the id (references and instances stay valid); delete refuses
  // while instances are on the rack (the shell enforces it — errors
  // surface through the standard toast path).
  const renameMacroDef = useCallback(
    async (macroId: string, name: string) => {
      await engine.renameMacro(macroId, name);
      const modules = await engine.listModules();
      if (modules) setModuleLib(modules);
      await refresh();
    },
    [refresh],
  );
  const deleteMacroDef = useCallback(async (macroId: string) => {
    await engine.deleteMacro(macroId);
    const modules = await engine.listModules();
    if (modules) setModuleLib(modules);
  }, []);

  // The three macro-instance verbs (PRD §6). Each instance owns its copy
  // of the definition, so these are the only ways a definition and an
  // instance exchange state: publish up, re-adopt down, or revert to the
  // copy this instance was adopted with.
  const saveMacroInstance = useCallback(
    async (group: MacroGroup) => {
      const published = await engine.saveMacroInstance(group.instance);
      if (published === false) return;
      const modules = await engine.listModules();
      if (modules) setModuleLib(modules);
      await refresh();
    },
    [refresh],
  );
  const pullMacroInstance = useCallback(
    async (group: MacroGroup) => {
      const warnings = (await engine.pullMacroInstance(group.instance)) ?? [];
      for (const w of warnings) reportError(`pull ${group.name}`, w);
      setSelected([]);
      await refresh();
    },
    [refresh, setSelected],
  );
  const resetMacroInstance = useCallback(
    async (group: MacroGroup) => {
      await engine.resetMacroInstance(group.instance);
      await refresh();
    },
    [refresh],
  );

  // Right-click "Break Macro": internals become ordinary modules in place;
  // positions carry over through the returned rename map so nothing moves.
  const breakMacro = useCallback(
    async (group: MacroGroup) => {
      const renames = await engine.breakMacro(group.instance);
      if (renames) carryPositions(renames);
      setSelected([]);
      await refresh();
      if (renames) dropPositions([...Object.keys(renames), group.instance]);
    },
    [refresh, carryPositions, dropPositions, setSelected],
  );

  // Rack shortcuts: undo/redo (cmd/ctrl+Z, cmd/ctrl+Y, cmd/ctrl+shift+Z),
  // rack zoom (cmd/ctrl +/-/0), select-all (cmd/ctrl+A), selection
  // copy/paste (cmd/ctrl+C/V) and selection delete (Backspace). All of it
  // acts on the patch/canvas, so none of it listens on other pages (only
  // Save/Open/New in fileShortcuts.ts is app-global).
  useEffect(() => {
    if (view !== 'rack') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        store.set({ pending: null });
        setSelected([]);
        setCollapseName(null);
        setMacroOverwrite(null);
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
  }, [view, store, refresh, changeZoom, copyModules, pasteModules, removeModules, setSelected]);

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
      // the swept modules. Sweeping any macro member pulls in its whole
      // group (all-or-nothing selection).
      const hitAll = expandGroups(hit);
      setSelected(m.additive ? [...new Set([...selected, ...hitAll])] : hitAll);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [marqueeActive, toRackCoords, store, setSelected, expandGroups]);

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
      // clicked module (standard desktop behavior — macro members retarget
      // to their whole group); inside it, the menu acts on the whole group.
      if (!store.getState().selected.includes(instance)) {
        setSelected(expandGroups([instance]));
      }
      setCtxMenu({ x: e.clientX, y: e.clientY, instance, macroGroup: macroOwner.get(instance) });
    },
    [store, setSelected, expandGroups, macroOwner],
  );

  // Right-click on a macro bounding box (its label): macro menu for that
  // group, selection retargeted to its members.
  const onMacroBoxContextMenu = useCallback(
    (group: MacroGroup, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setSelected(group.members);
      setCtxMenu({ x: e.clientX, y: e.clientY, instance: group.members[0], macroGroup: group });
    },
    [setSelected],
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
      // A macro member's ✕ deletes the whole instance (all-or-nothing);
      // removeModules already routes through toTopLevel/expandGroups.
      if (macroOwner.has(instance)) {
        await removeModules([instance]);
        return;
      }
      await engine.removeModule(instance);
      const pending = store.getState().pending;
      if (pending?.instance === instance) setPending(null);
      await refresh();
      dropPositions([instance]);
    },
    [store, dropPositions, setPending, refresh, macroOwner, removeModules],
  );

  const renameModule = useCallback(
    async (instance: string, name: string) => {
      // The backend normalizes the typed name into the new instance id and
      // rejects duplicates/empty names — a rejection reports to the error
      // banner, resolves null, and the refresh below reverts the display.
      const newId = await engine.renameModule(instance, name);
      const renamedTo = newId && newId !== instance ? newId : null;
      if (renamedTo) {
        carryPositions({ [instance]: renamedTo });
        setSelected(store.getState().selected.map((id) => (id === instance ? renamedTo : id)));
        const pending = store.getState().pending;
        if (pending?.instance === instance) setPending(null);
      }
      await refresh();
      if (renamedTo) dropPositions([instance]);
    },
    [store, carryPositions, dropPositions, setSelected, setPending, refresh],
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

  // Audio module panels need the track list, a refresh after a load
  // (adopting the track's tempo moves the module's BPM/speed knobs) and
  // the loop switch, which is a knob-backed input like play_gate.
  const audioUI = useMemo(
    () => ({
      tracks: libraryTracks,
      onLoaded: () => void refresh(),
      setLoop: (instance: string, on: boolean) => {
        void engine.setKnobPosition(instance, 'loop', on ? 1 : 0).then(refresh);
      },
    }),
    [libraryTracks, refresh],
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
    const macroGroup = ctxMenu.macroGroup;
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
      ...(macroGroup
        ? [
            {
              label: `Break Macro "${macroGroup.name}"`,
              testId: 'ctx-break-macro',
              onSelect: () => void breakMacro(macroGroup),
            },
            {
              label: `Save Macro "${macroGroup.name}"`,
              testId: 'ctx-save-macro',
              onSelect: () => void saveMacroInstance(macroGroup),
            },
            {
              label: `Pull Latest "${macroGroup.name}"`,
              testId: 'ctx-pull-macro',
              onSelect: () => setMacroPull(macroGroup),
            },
            {
              label: `Reset Macro "${macroGroup.name}"`,
              testId: 'ctx-reset-macro',
              onSelect: () => void resetMacroInstance(macroGroup),
            },
          ]
        : []),
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
          void engine.resetModules(toTopLevel(group)).then(refresh);
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
    breakMacro,
    saveMacroInstance,
    resetMacroInstance,
    openDocs,
    refresh,
    toTopLevel,
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
          <button
            className={view === 'clip' ? 'tab active' : 'tab'}
            onClick={() => setView('clip')}
            data-testid="tab-clip"
          >
            Clip
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
            Collapse to Macro ({selected.length})
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
                          setFileDialog(null);
                          requestLoadPatch(n);
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
      {confirmDiscard && (
        <div
          className="file-dialog-backdrop"
          data-testid="unsaved-dialog"
          onClick={() => setConfirmDiscard(null)}
        >
          <div className="file-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Unsaved Changes</h3>
            <p className="file-dialog-empty">
              “{patchName}” has unsaved changes. Save them before continuing?
            </p>
            <button
              data-testid="unsaved-save"
              onClick={() => {
                const { proceed } = confirmDiscard;
                setConfirmDiscard(null);
                void savePatch().then(proceed);
              }}
            >
              Save
            </button>
            <button
              data-testid="unsaved-discard"
              onClick={() => {
                const { proceed } = confirmDiscard;
                setConfirmDiscard(null);
                proceed();
              }}
            >
              Discard
            </button>
            <button
              className="file-dialog-cancel"
              data-testid="unsaved-cancel"
              onClick={() => setConfirmDiscard(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {macroOverwrite && (
        <div
          className="file-dialog-backdrop"
          data-testid="macro-overwrite-dialog"
          onClick={() => setMacroOverwrite(null)}
        >
          <div className="file-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Overwrite Macro?</h3>
            <p className="file-dialog-empty">
              A macro named “{macroOverwrite.name}” already exists. Saving will replace its
              definition — rack instances keep their own copies until they pull it.
            </p>
            <button
              data-testid="macro-overwrite-confirm"
              onClick={() => {
                const name = collapseName;
                setMacroOverwrite(null);
                if (name) void collapseToMacro(name, true);
              }}
            >
              Overwrite
            </button>
            <button
              className="file-dialog-cancel"
              data-testid="macro-overwrite-cancel"
              onClick={() => setMacroOverwrite(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {macroPull && (
        <div
          className="file-dialog-backdrop"
          data-testid="macro-pull-dialog"
          onClick={() => setMacroPull(null)}
        >
          <div className="file-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Pull Latest?</h3>
            <p className="file-dialog-empty">
              “{macroPull.name}” goes back to the saved definition. Every edit made inside this
              instance is discarded.
            </p>
            <button
              data-testid="macro-pull-confirm"
              onClick={() => {
                const group = macroPull;
                setMacroPull(null);
                void pullMacroInstance(group);
              }}
            >
              Pull Latest
            </button>
            <button
              className="file-dialog-cancel"
              data-testid="macro-pull-cancel"
              onClick={() => setMacroPull(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {view === 'library' && (
        <LibraryView
          client={library}
          onEdit={(t) => {
            clipView.current?.open(t.id);
            setView('clip');
          }}
        />
      )}
      {/* The clip editor stays mounted so the edit survives tab switches;
          it hides itself and pauses playback while inactive. */}
      <ClipView
        clip={clipClient}
        library={library}
        active={view === 'clip'}
        onSaved={() => void refresh()}
        ref={clipView}
      />
      {pickerOpen && (
        <ModulePicker
          modules={moduleLib}
          onAdd={addFromPicker}
          onClose={() => setPickerOpen(false)}
          onRenameMacro={renameMacroDef}
          onDeleteMacro={deleteMacroDef}
        />
      )}
      {/* The rack stays mounted on other pages (hidden, not unmounted, so
          panel state survives) — RackKeysContext tells its window key
          listeners (QwertyPanel, MidiPanel) to go quiet and release. */}
      <div className="app-body" style={view === 'rack' ? undefined : { display: 'none' }}>
        <RackKeysContext.Provider value={view === 'rack'}>
          <RackStoreContext.Provider value={store}>
            <DeckUIContext.Provider value={deckUI}>
              <AudioUIContext.Provider value={audioUI}>
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
                    // A module's input config menu is portaled to <body>,
                    // but its events still bubble the REACT tree to here.
                    // Presses that landed outside the rack's own DOM subtree
                    // are not background presses — and the preventDefault
                    // below would cancel the mousedown's default action,
                    // which in WebKit is what opens a <select>'s options.
                    if (!e.currentTarget.contains(e.target as Node)) return;
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
                    <MacroBoxes
                      groups={macroGroups}
                      zoom={zoom}
                      onMoveGroup={(anchor, x, y, members) => moveGroup(anchor, x, y, members)}
                      onMoveEnd={() => endModuleDrag()}
                      onContextMenu={onMacroBoxContextMenu}
                    />
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
                        renameModule={renameModule}
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
                    they are deliberately NOT part of layoutKey. */}
                    <WireOverlay
                      wires={wires}
                      container={rackInnerEl}
                      colors={wireColors}
                      pending={pending}
                      zoom={zoom}
                      layoutKey={JSON.stringify(positions)}
                    />
                  </div>
                </div>
              </AudioUIContext.Provider>
            </DeckUIContext.Provider>
          </RackStoreContext.Provider>
        </RackKeysContext.Provider>
      </div>
    </main>
  );
}
