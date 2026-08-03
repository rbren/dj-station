// SVG cable layer: draws a straight wire for every connection between jack
// socket positions (sockets carry data-jack="instance:kind:jack").

import { useLayoutEffect, useState } from 'react';
import type { WireSnapshot } from '../engine';

/** The 8 selectable wire colors; index 0 is the default. */
export const WIRE_COLORS = [
  '#e6b450',
  '#e05c5c',
  '#62d0ff',
  '#7dde8a',
  '#c792ea',
  '#ff9e64',
  '#f7768e',
  '#7aa2f7',
];

export function wireKey(w: WireSnapshot): string {
  return `${w.from_instance}:${w.from_jack}->${w.to_instance}:${w.to_jack}`;
}

interface Cable {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function jackCenter(
  root: HTMLElement,
  origin: DOMRect,
  instance: string,
  kind: 'output' | 'input',
  jack: string,
): { x: number; y: number } | null {
  const el = root.querySelector(`[data-jack="${instance}:${kind}:${jack}"]`);
  if (!el) return null;
  const r = (el as HTMLElement).getBoundingClientRect();
  return { x: r.left + r.width / 2 - origin.left, y: r.top + r.height / 2 - origin.top };
}

export interface PendingEnd {
  instance: string;
  jack: string;
  kind: 'input' | 'output';
  color: number;
}

export function WireOverlay({
  wires,
  container,
  colors,
  pending,
  layoutKey,
}: {
  wires: WireSnapshot[];
  container: HTMLElement | null;
  /** Wire key → WIRE_COLORS index. */
  colors?: Record<string, number>;
  /** Armed wire end: a preview cable follows the cursor from this jack. */
  pending?: PendingEnd | null;
  /** Any string that changes when jack positions may have moved
   *  (e.g. serialized module positions) to trigger a re-measure. */
  layoutKey?: string;
}) {
  const [cables, setCables] = useState<Cable[]>([]);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  // While a wire end is armed, the free end tracks the mouse.
  useLayoutEffect(() => {
    if (!pending || !container) {
      return;
    }
    const onMove = (e: MouseEvent) => {
      const origin = container.getBoundingClientRect();
      setCursor({ x: e.clientX - origin.left, y: e.clientY - origin.top });
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      setCursor(null);
    };
  }, [pending, container]);

  const pendingStart =
    pending && container
      ? jackCenter(
          container,
          container.getBoundingClientRect(),
          pending.instance,
          pending.kind,
          pending.jack,
        )
      : null;

  useLayoutEffect(() => {
    if (!container) return;
    let raf = 0;
    const measure = () => {
      const origin = container.getBoundingClientRect();
      const next: Cable[] = [];
      for (const w of wires) {
        const a = jackCenter(container, origin, w.from_instance, 'output', w.from_jack);
        const b = jackCenter(container, origin, w.to_instance, 'input', w.to_jack);
        if (a && b) {
          next.push({ key: wireKey(w), x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        }
      }
      // Only update state on real changes so observer-triggered measures
      // don't loop through our own SVG re-render.
      setCables((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('resize', schedule);
    // Panels are absolutely positioned, so the container itself never
    // resizes when a panel grows (e.g. deck waveform loading in) — observe
    // every panel, and any DOM mutation outside the overlay itself.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(container);
    container.querySelectorAll('.module-panel').forEach((p) => ro?.observe(p));
    const mo =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver((records) => {
            if (records.some((r) => !(r.target as Element).closest?.('.wire-overlay'))) {
              schedule();
            }
          })
        : null;
    mo?.observe(container, { subtree: true, childList: true, attributes: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [wires, container, layoutKey]);

  return (
    <svg className="wire-overlay" data-testid="wire-overlay">
      {cables.map((c) => (
        <line
          key={c.key}
          data-testid={`cable-${c.key}`}
          x1={c.x1}
          y1={c.y1}
          x2={c.x2}
          y2={c.y2}
          className="wire-cable"
          style={{ stroke: WIRE_COLORS[(colors?.[c.key] ?? 0) % WIRE_COLORS.length] }}
        />
      ))}
      {pending && pendingStart && (
        <line
          data-testid="pending-cable"
          x1={pendingStart.x}
          y1={pendingStart.y}
          x2={cursor?.x ?? pendingStart.x}
          y2={cursor?.y ?? pendingStart.y}
          className="wire-cable wire-cable-pending"
          style={{ stroke: WIRE_COLORS[pending.color % WIRE_COLORS.length] }}
        />
      )}
    </svg>
  );
}
