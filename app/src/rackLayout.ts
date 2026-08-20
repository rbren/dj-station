// Rack placement geometry shared by App (drag/collision resolution) and
// RackModule (panel positioning): default slots, measured module rects and
// overlap tests.

import { GRID } from './components/ModulePanel';

/** Default slot for modules without a saved position: 3 columns of
 *  grid-aligned cells below/right of existing modules. */
export function defaultPosition(index: number): { x: number; y: number } {
  return { x: (index % 3) * GRID * 10, y: Math.floor(index / 3) * GRID * 8 };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rack rect for a module at `pos`, measured from its rendered panel
 *  (offset sizes ignore the zoom transform). Falls back to a nominal
 *  4×2-cell footprint for panels not yet in the DOM. */
export function moduleRect(instance: string, pos: { x: number; y: number }): Rect {
  const el = document.querySelector<HTMLElement>(`[data-testid="module-${instance}"]`);
  return {
    x: pos.x,
    y: pos.y,
    w: el?.offsetWidth || GRID * 4,
    h: el?.offsetHeight || GRID * 2,
  };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Smallest rect covering all of `rects` (must be non-empty). Groups
 *  (multi-module drags, group pastes) collide as this one bounding box. */
export function boundingBox(rects: Rect[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Breathing room between a macro's member panels and its box border. */
export const MACRO_PAD = 10;
/** Space above a macro box for its name tab — must match the
 *  `.macro-box-label` height in styles.css (the tab is styled as a
 *  module-title-like bar spanning the box's top edge). */
export const MACRO_LABEL_H = 44;

/** The full on-screen rect of a macro's bounding box (member bbox plus
 *  padding and the label tab). Macro groups collide as this one solid
 *  rect — exactly like a module's own bounding box. */
export function macroBoxRect(members: Rect): Rect {
  return {
    x: members.x - MACRO_PAD,
    y: members.y - MACRO_PAD - MACRO_LABEL_H,
    w: members.w + MACRO_PAD * 2,
    h: members.h + MACRO_PAD * 2 + MACRO_LABEL_H,
  };
}

/** Drag push-out: when a `size` footprint requested at `requested` overlaps
 *  neighbours, find the nearest free grid spot along the drag's dominant
 *  axis (near-side pushes stop the panel against its neighbour; far-side
 *  pushes jump over it once the pointer commits). Returns null when neither
 *  axis has a free spot. Shared by single-module and group drags. */
export function resolvePush(
  requested: { x: number; y: number },
  current: { x: number; y: number },
  size: { w: number; h: number },
  others: Rect[],
): { x: number; y: number } | null {
  const snap = (v: number) => Math.round(v / GRID) * GRID;
  const overlapsAny = (pos: { x: number; y: number }) =>
    others.some((o) => rectsOverlap({ ...pos, ...size }, o));
  const hits = others.filter((o) => rectsOverlap({ ...requested, ...size }, o));
  const horizFirst = Math.abs(requested.x - current.x) >= Math.abs(requested.y - current.y);
  for (const axis of horizFirst ? (['x', 'y'] as const) : (['y', 'x'] as const)) {
    let best: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    for (const r of hits) {
      const cands =
        axis === 'x'
          ? [
              { x: snap(r.x + r.w), y: requested.y },
              { x: snap(r.x - size.w), y: requested.y },
            ]
          : [
              { x: requested.x, y: snap(r.y + r.h) },
              { x: requested.x, y: snap(r.y - size.h) },
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
}

/** Nearest free grid spot for a `size` footprint around `want`: returns
 *  `want` itself when free, otherwise scans grid offsets ring by ring
 *  outwards (closest Euclidean candidate within each ring, ties broken
 *  deterministically by scan order), so placement never jumps far from
 *  the requested point. Returns null only if nothing is free within
 *  `maxRings` grid cells. */
export function nearestFreeSpot(
  want: { x: number; y: number },
  size: { w: number; h: number },
  others: Rect[],
  maxRings = 40,
): { x: number; y: number } | null {
  // The canvas is infinite in every direction, so any grid spot (negative
  // coordinates included) is fair game.
  const free = (pos: { x: number; y: number }) =>
    !others.some((r) => rectsOverlap({ ...pos, ...size }, r));
  if (free(want)) return want;
  for (let ring = 1; ring <= maxRings; ring++) {
    let best: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const pos = { x: want.x + dx * GRID, y: want.y + dy * GRID };
        const dist = dx * dx + dy * dy;
        if (dist < bestDist && free(pos)) {
          best = pos;
          bestDist = dist;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** Absolute rack placement, matching how ModulePanel positions itself — used
 *  by the fallback card that stands in for a panel that failed to render. */
export function panelStyle(pos: { x: number; y: number }): React.CSSProperties {
  return { left: pos.x, top: pos.y };
}
