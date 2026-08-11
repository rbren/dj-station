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
  const free = (pos: { x: number; y: number }) =>
    pos.x >= 0 && pos.y >= 0 && !others.some((r) => rectsOverlap({ ...pos, ...size }, r));
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
