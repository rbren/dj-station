// A breakpoint automation lane: the Clip page's level-lane grammar
// (click the background to drop a point, drag one to move it, right-click
// to take it away) as a component, over whatever x-axis the caller has.
//
// The lane knows NOTHING about what it draws — it maps x to a domain
// value and y to a range value and hands both back. That is what lets the
// Grid page draw MASTER TEMPO over beats with the same control the Clip
// page draws dB over seconds with: the difference is the axes, not the
// interaction.
//
// A POINT IS IDENTIFIED BY WHERE IT IS, never by its index: an envelope
// keeps its points sorted, so dragging one past another renumbers the
// list under the drag. `onMove` therefore says which point moved by its
// CURRENT position, and the lane tracks that position as the drag goes —
// which is what keeps a drag on the point it grabbed.
//
// A lane with no points is drawing a DEFAULT, not a value the user set,
// and says so by going quiet (the flat line is dimmed via CSS).

import { useCallback, useEffect, useRef, useState } from 'react';

export interface LanePoint {
  /** Position along the lane's x-axis, in domain units. */
  at: number;
  value: number;
}

export interface AutomationLaneProps {
  /** Lane width in px; the x-axis spans [domainStart, domain] across it. */
  width: number;
  height: number;
  domain: number;
  domainStart?: number;
  min: number;
  max: number;
  /** The envelope, in any order (the lane sorts what it draws). */
  points: readonly LanePoint[];
  /** Drawn where there are no points at all: the value in force. */
  base: number;
  /** Horizontal rules, in range units (the tempo lane marks round bpms). */
  ticks?: readonly number[];
  /** Snap a value the pointer produced (the tempo lane rounds to 0.5). */
  quantize?: (value: number) => number;
  label?: (value: number) => string;
  testId?: string;
  ariaLabel?: string;
  onAdd(at: number, value: number): void;
  /** The point currently at `fromAt` has been dragged. Called throughout
   *  the drag, so the caller's state is the live one. */
  onMove(fromAt: number, at: number, value: number): void;
  onRemove(at: number): void;
  /** The drag is over — where a caller ends an undo/edit gesture. */
  onRelease?(): void;
  children?: React.ReactNode;
}

export function AutomationLane(props: AutomationLaneProps) {
  const {
    width,
    height,
    domain,
    domainStart = 0,
    min,
    max,
    points,
    base,
    quantize,
    onAdd,
    onMove,
    onRemove,
    onRelease,
  } = props;
  const svg = useRef<SVGSVGElement | null>(null);
  /** Where the dragged point sits right now (null = no drag). */
  const dragAt = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const span = Math.max(1e-9, domain - domainStart);
  const xOf = useCallback(
    (at: number) => ((at - domainStart) / span) * width,
    [domainStart, span, width],
  );
  const yOf = useCallback(
    (value: number) => {
      const clamped = Math.min(max, Math.max(min, value));
      return height - ((clamped - min) / Math.max(1e-9, max - min)) * height;
    },
    [height, max, min],
  );

  const fromPointer = useCallback(
    (clientX: number, clientY: number, rect: DOMRect) => {
      const fx = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      const fy = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
      const at = domainStart + Math.min(1, Math.max(0, fx)) * span;
      const raw = max - Math.min(1, Math.max(0, fy)) * (max - min);
      return { at, value: quantize ? quantize(raw) : raw };
    },
    [domainStart, max, min, quantize, span],
  );

  useEffect(() => {
    if (!dragging) return;
    const up = () => {
      dragAt.current = null;
      setDragging(false);
      onRelease?.();
    };
    const move = (e: MouseEvent) => {
      // A MOVE WITH NO BUTTON DOWN IS A RELEASE WE MISSED. The mouse-up
      // that ends a drag can be swallowed — the browser starts a
      // selection or an element drag of its own over an SVG, and from
      // then on the point stuck to the pointer until it was clicked
      // again. `mousedown` now says preventDefault so that gesture never
      // starts, and this catches whatever else eats a release.
      if (e.buttons === 0) {
        up();
        return;
      }
      const rect = svg.current?.getBoundingClientRect();
      const from = dragAt.current;
      if (!rect || from === null) return;
      const { at, value } = fromPointer(e.clientX, e.clientY, rect);
      dragAt.current = at;
      onMove(from, at, value);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [dragging, fromPointer, onMove, onRelease]);

  // The line: the value in force across the whole lane, bent at every
  // point. Flat at `base` while the lane is empty.
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const vertices = sorted.length
    ? [
        { at: domainStart, value: sorted[0].value },
        ...sorted,
        { at: domain, value: sorted[sorted.length - 1].value },
      ]
    : [
        { at: domainStart, value: base },
        { at: domain, value: base },
      ];

  return (
    <svg
      ref={svg}
      className="automation-lane"
      data-testid={props.testId}
      data-empty={sorted.length === 0 ? 'true' : 'false'}
      role="group"
      aria-label={props.ariaLabel}
      width={width}
      height={height}
      onMouseDown={(e) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const { at, value } = fromPointer(e.clientX, e.clientY, rect);
        onAdd(at, value);
      }}
    >
      {props.ticks?.map((value) => (
        <g key={value}>
          <line
            className="automation-lane-tick"
            x1={0}
            x2={width}
            y1={yOf(value)}
            y2={yOf(value)}
          />
          <text className="automation-lane-tick-label" x={3} y={yOf(value) - 3}>
            {props.label ? props.label(value) : value}
          </text>
        </g>
      ))}
      {props.children}
      <polyline
        className="automation-lane-line"
        data-testid={props.testId ? `${props.testId}-line` : undefined}
        points={vertices.map((v) => `${xOf(v.at)},${yOf(v.value)}`).join(' ')}
      />
      {sorted.map((point, i) => (
        <circle
          key={`${point.at}:${i}`}
          className="automation-lane-point"
          data-testid={props.testId ? `${props.testId}-point-${i}` : undefined}
          cx={xOf(point.at)}
          cy={yOf(point.value)}
          r={6}
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            dragAt.current = point.at;
            setDragging(true);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            onRemove(point.at);
          }}
        >
          <title>{props.label ? props.label(point.value) : String(point.value)}</title>
        </circle>
      ))}
    </svg>
  );
}
