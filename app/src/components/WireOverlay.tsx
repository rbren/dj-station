// SVG cable layer: draws a bezier for every wire between jack DOM positions
// (jacks carry data-jack="instance:kind:jack" attributes).

import { useLayoutEffect, useState } from 'react';
import type { WireSnapshot } from '../engine';

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

export function WireOverlay({
  wires,
  container,
  layoutKey,
}: {
  wires: WireSnapshot[];
  container: HTMLElement | null;
  /** Any string that changes when jack positions may have moved
   *  (e.g. serialized module positions) to trigger a re-measure. */
  layoutKey?: string;
}) {
  const [cables, setCables] = useState<Cable[]>([]);

  useLayoutEffect(() => {
    if (!container) return;
    const measure = () => {
      const origin = container.getBoundingClientRect();
      const next: Cable[] = [];
      for (const w of wires) {
        const a = jackCenter(container, origin, w.from_instance, 'output', w.from_jack);
        const b = jackCenter(container, origin, w.to_instance, 'input', w.to_jack);
        if (a && b) {
          next.push({
            key: `${w.from_instance}:${w.from_jack}->${w.to_instance}:${w.to_jack}`,
            x1: a.x,
            y1: a.y,
            x2: b.x,
            y2: b.y,
          });
        }
      }
      setCables(next);
    };
    measure();
    window.addEventListener('resize', measure);
    // jsdom (tests) has no ResizeObserver.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(container);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [wires, container, layoutKey]);

  return (
    <svg className="wire-overlay" data-testid="wire-overlay">
      {cables.map((c) => {
        const sag = Math.min(60, 20 + Math.abs(c.x2 - c.x1) * 0.1);
        const midY = Math.max(c.y1, c.y2) + sag;
        return (
          <path
            key={c.key}
            data-testid={`cable-${c.key}`}
            d={`M ${c.x1} ${c.y1} C ${c.x1} ${midY}, ${c.x2} ${midY}, ${c.x2} ${c.y2}`}
            className="wire-cable"
          />
        );
      })}
    </svg>
  );
}
