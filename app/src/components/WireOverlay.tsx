// SVG cable layer: draws a straight wire for every connection between jack
// socket positions (sockets carry data-jack="instance:kind:jack").
//
// The overlay lives INSIDE the pan/zoom-transformed rack element and works
// in UNZOOMED rack coordinates (screen measurements divided by `zoom`), so
// panning/zooming moves the cables for free via the CSS transform — no
// re-measure, no re-render. Re-measures happen only when jacks can actually
// move: module add/remove/drag (childList mutations, layoutKey), panel
// growth (ResizeObserver), or window resize. Attribute mutations from
// telemetry visuals (jack glows, knob dials, meter fills — 10 Hz across the
// whole rack) are explicitly ignored.

import { useLayoutEffect, useState } from 'react';
import type { WireSnapshot } from '../engine';
import { timedOver } from '../perf';

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

function jackKey(instance: string, kind: 'output' | 'input', jack: string): string {
  return `${instance}:${kind}:${jack}`;
}

/** Every jack socket under `root`, by its `data-jack` key.
 *
 *  ONE pass over the DOM per measure. Looking each socket up with its own
 *  `querySelector` walks the whole rack subtree per wire END, which is
 *  quadratic in the patch size — measured at 176 ms per measure on a
 *  16-module fixture (`tests/RackPerf.test.tsx`), and a measure runs on
 *  every module add, drag and panel resize. */
function jackSockets(root: HTMLElement): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>();
  for (const el of root.querySelectorAll<HTMLElement>('[data-jack]')) {
    const key = el.dataset.jack;
    if (key !== undefined) map.set(key, el);
  }
  return map;
}

function jackCenter(
  el: HTMLElement | undefined,
  origin: DOMRect,
  zoom: number,
): { x: number; y: number } | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Screen px → unzoomed rack coordinates (the container is scaled by
  // `zoom` around origin 0 0, so its own rect already includes the pan).
  return {
    x: (r.left + r.width / 2 - origin.left) / zoom,
    y: (r.top + r.height / 2 - origin.top) / zoom,
  };
}

/** Telemetry-driven visuals mutate attributes at 10 Hz all over the rack
 *  (glow styles, knob dial rotations, meter fills, canvas sizes) but can
 *  never move a jack socket — only these mutations may trigger a
 *  re-measure. */
function mayMoveJacks(records: MutationRecord[]): boolean {
  return records.some((r) => {
    const el = r.target as Element;
    if (el.closest?.('.wire-overlay')) return false;
    if (r.type !== 'attributes') return true;
    // .macro-box: no jacks inside — it only moves when member panels move,
    // and those panels' own mutations already schedule a re-measure.
    // .decks-chrome: the Decks page's fixed bars restyle themselves on
    // every status poll (beat lamps, surface pill) but their jacks only
    // move on STRUCTURAL changes (childList) — those still count.
    return !el.closest?.(
      '.jack, .knob, .level-meter, .module-custom-ui, .macro-box, .decks-chrome',
    );
  });
}

function cablesEqual(a: Cable[], b: Cable[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.key !== y.key || x.x1 !== y.x1 || x.y1 !== y.y1 || x.x2 !== y.x2 || x.y2 !== y.y2) {
      return false;
    }
  }
  return true;
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
  zoom = 1,
}: {
  wires: WireSnapshot[];
  /** The pan/zoom-transformed rack element the overlay renders inside. */
  container: HTMLElement | null;
  /** Wire key → WIRE_COLORS index. */
  colors?: Record<string, number>;
  /** Armed wire end: a preview cable follows the cursor from this jack. */
  pending?: PendingEnd | null;
  /** Any string that changes when jack positions may have moved
   *  (e.g. serialized module positions) to trigger a re-measure. */
  layoutKey?: string;
  /** The rack scale factor, to convert screen measurements to rack
   *  coordinates. Pan/zoom changes need no re-measure: cables are stored
   *  unzoomed and the container's CSS transform moves them. */
  zoom?: number;
}) {
  const [cables, setCables] = useState<Cable[]>([]);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  // While a wire end is armed, the free end tracks the mouse. The cursor
  // is cleared in the cleanup so disarming never leaves a stale preview.
  useLayoutEffect(() => {
    if (!pending || !container) return;
    const onMove = (e: MouseEvent) => {
      const origin = container.getBoundingClientRect();
      setCursor({ x: (e.clientX - origin.left) / zoom, y: (e.clientY - origin.top) / zoom });
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      setCursor(null);
    };
  }, [pending, container, zoom]);

  const pendingStart =
    pending && container
      ? jackCenter(
          container.querySelector<HTMLElement>(
            `[data-jack="${jackKey(pending.instance, pending.kind, pending.jack)}"]`,
          ) ?? undefined,
          container.getBoundingClientRect(),
          zoom,
        )
      : null;

  useLayoutEffect(() => {
    if (!container) return;
    let raf = 0;
    // One forced layout per wire end, so this is the rack's dearest
    // stage on a big patch — timed under `rack.wireMeasure` for the perf
    // suites and the stress HUD.
    const measure = () =>
      timedOver('rack.wireMeasure', () => {
        const origin = container.getBoundingClientRect();
        const sockets = jackSockets(container);
        // Sockets seen, plus two lookups per wire. This is the count the
        // perf suite gates: it is jacks + 2×wires, and the quadratic
        // version of this stage (a `querySelector` per wire end, which is
        // what it used to be) is jacks × wires. A count says which one
        // you have; a millisecond on a shared runner does not.
        let touched = sockets.size;
        const next: Cable[] = [];
        for (const w of wires) {
          touched += 2;
          const a = jackCenter(
            sockets.get(jackKey(w.from_instance, 'output', w.from_jack)),
            origin,
            zoom,
          );
          const b = jackCenter(
            sockets.get(jackKey(w.to_instance, 'input', w.to_jack)),
            origin,
            zoom,
          );
          if (a && b) {
            next.push({ key: wireKey(w), x1: a.x, y1: a.y, x2: b.x, y2: b.y });
          }
        }
        // Only update state on real changes so observer-triggered measures
        // don't loop through our own SVG re-render.
        setCables((prev) => (cablesEqual(prev, next) ? prev : next));
        return { value: undefined, items: touched };
      });
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('resize', schedule);
    // Capture-phase scroll: an inner scroller (the Decks chrome's strip
    // row) moves its jacks under the overlay without any DOM mutation.
    // The rack canvas itself never scrolls (it pans by transform), so on
    // the Rack tab this never fires.
    window.addEventListener('scroll', schedule, true);
    // Panels are absolutely positioned, so the container itself never
    // resizes when a panel grows (e.g. deck waveform loading in) — observe
    // every panel, and jack-moving DOM mutations (mayMoveJacks filters out
    // the 10 Hz telemetry attribute churn).
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(container);
    container.querySelectorAll('.module-panel').forEach((p) => ro?.observe(p));
    const mo =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver((records) => {
            if (mayMoveJacks(records)) schedule();
          })
        : null;
    mo?.observe(container, { subtree: true, childList: true, attributes: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [wires, container, layoutKey, zoom]);

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
          vectorEffect="non-scaling-stroke"
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
          vectorEffect="non-scaling-stroke"
          style={{ stroke: WIRE_COLORS[pending.color % WIRE_COLORS.length] }}
        />
      )}
    </svg>
  );
}
