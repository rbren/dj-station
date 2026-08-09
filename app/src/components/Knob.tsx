// Data-driven knob (PRD §7.2): what renders is determined by the config
// style — a dial (continuous/stepped), a toggle (switch/button), or nothing
// at all ('wire': the input is a plain jack). Values are not printed inline;
// they appear in the hover tooltip. Right-click opens the config editor.
//
// Wiring an input does not take the knob away: the knob sets the baseline
// value and the incoming signal adds on top, scaled by the wire amount
// (attenuverter). Drag sets the baseline; cmd/ctrl-drag sets the wire
// amount, drawn as a spread arc around the knob's notch.

import { useCallback, useEffect, useRef, useState } from 'react';
import { fixed } from '../format';
import type { KnobConfig } from '../types';
import { KnobConfigMenu } from './KnobConfigMenu';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Nominal peak of a patch signal (modules output ±5 V full scale); the
 *  wire amount is expressed against it, so atten = 1 means the wire can
 *  swing the value by ±5. */
export const WIRE_SIGNAL_REF = 5;

export function mapPosition(config: KnobConfig, position: number): number {
  let p = clamp01(position);
  if (config.style === 'switch' || config.style === 'button') {
    p = p >= 0.5 ? 1 : 0;
  } else if (config.style === 'stepped') {
    const steps = Math.max(2, config.steps ?? 2);
    p = Math.round(p * (steps - 1)) / (steps - 1);
  }
  if (config.curve === 'exp') p = p * p;
  else if (config.curve === 'log') p = Math.sqrt(p);
  else if (typeof config.curve === 'object') {
    // piecewise-linear custom curve
    const pts = config.curve.custom;
    for (let i = 1; i < pts.length; i++) {
      if (p <= pts[i][0]) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        p = x1 === x0 ? y1 : y0 + ((p - x0) / (x1 - x0)) * (y1 - y0);
        break;
      }
    }
  }
  return config.min + p * (config.max - config.min);
}

/** Inverse of `mapPosition`: the knob position whose mapped value is
 *  (approximately) `value`. Binary search over the monotone mapping,
 *  mirroring the engine's `position_for_value`. */
export function positionForValue(config: KnobConfig, value: number): number {
  let lo = 0;
  let hi = 1;
  const increasing = mapPosition(config, 1) >= mapPosition(config, 0);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (mapPosition(config, mid) < value === increasing) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Value range a wired input can reach: the knob baseline plus the wire's
 *  swing (`signal * atten + offset` for a ±WIRE_SIGNAL_REF signal). */
export function spreadRange(
  config: KnobConfig,
  position: number,
  atten: number,
  offset: number,
): { min: number; max: number } {
  const center = mapPosition(config, position) + offset;
  const half = WIRE_SIGNAL_REF * Math.abs(atten);
  return { min: center - half, max: center + half };
}

/** Inverse of `spreadRange`: the atten/offset that put the wire's swing
 *  between `min` and `max` around the current baseline. */
export function attenOffsetForSpread(
  config: KnobConfig,
  position: number,
  min: number,
  max: number,
): { atten: number; offset: number } {
  const base = mapPosition(config, position);
  return {
    atten: Math.max(-1, Math.min(1, (max - min) / (2 * WIRE_SIGNAL_REF))),
    offset: (min + max) / 2 - base,
  };
}

const angleFor = (position: number) => -135 + clamp01(position) * 270;

/** SVG arc along the dial's sweep between two knob positions. */
function arcPath(fromPos: number, toPos: number, cx: number, cy: number, r: number): string {
  const a0 = (angleFor(fromPos) * Math.PI) / 180;
  const a1 = (angleFor(toPos) * Math.PI) / 180;
  const pt = (a: number) =>
    `${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`;
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  return `M ${pt(a0)} A ${r} ${r} 0 ${large} 1 ${pt(a1)}`;
}

export interface KnobProps {
  label: string;
  config: KnobConfig;
  position: number;
  onPosition(position: number): void;
  /** End of an interaction gesture (drag release / toggle / momentary up). */
  onRelease?(): void;
  onConfigChange?(config: KnobConfig): void;
  wired?: boolean;
  atten?: number;
  offset?: number;
  onAttenOffset?(atten: number, offset: number): void;
}

export function Knob(props: KnobProps) {
  const { label, config, position, onPosition, onRelease, onConfigChange, wired } = props;
  const { onAttenOffset } = props;
  const atten = props.atten ?? 1;
  const offset = props.offset ?? 0;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{
    startY: number;
    startPos: number;
    startAtten: number;
    wire: boolean;
  } | null>(null);

  const onMove = useCallback(
    (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const delta = (d.startY - e.clientY) / 150;
      if (d.wire) {
        onAttenOffset?.(Math.max(-1, Math.min(1, d.startAtten + delta)), offset);
      } else {
        onPosition(clamp01(d.startPos + delta));
      }
    },
    [onPosition, onAttenOffset, offset],
  );
  const onUp = useCallback(() => {
    if (drag.current) {
      drag.current = null;
      onRelease?.();
    }
  }, [onRelease]);
  useEffect(() => {
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onMove, onUp]);

  const value = mapPosition(config, position);
  const angle = angleFor(position);
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (onConfigChange) setMenuAt({ x: e.clientX, y: e.clientY });
  };
  const menu = menuAt && onConfigChange && (
    <KnobConfigMenu
      config={config}
      at={menuAt}
      onChange={(c) => onConfigChange(c)}
      onClose={() => setMenuAt(null)}
      wired={wired}
      position={position}
      atten={props.atten}
      offset={props.offset}
      onAttenOffset={onAttenOffset}
    />
  );

  // 'wire' style means "no knob at all" — the input is a plain jack, so only
  // the config affordance renders. A wired jack keeps its knob: the knob is
  // the baseline the incoming signal adds to.
  if (config.style === 'wire') {
    return (
      <div className="knob knob-wire" data-testid={`knob-${label}`} onContextMenu={openMenu}>
        {menu}
      </div>
    );
  }

  // 'switch' toggles on click; 'button' is momentary — held down while the
  // mouse button is pressed, released on mouseup/leave.
  if (config.style === 'button') {
    const on = position >= 0.5;
    return (
      <div className="knob" data-testid={`knob-${label}`}>
        <button
          type="button"
          aria-pressed={on}
          aria-label={label}
          title={`${label}: hold for on`}
          className={`knob-toggle knob-momentary${on ? ' knob-toggle-on' : ''}`}
          onMouseDown={(e) => {
            if (e.button === 0) onPosition(1);
          }}
          onMouseUp={() => {
            onPosition(0);
            onRelease?.();
          }}
          onMouseLeave={() => {
            if (on) {
              onPosition(0);
              onRelease?.();
            }
          }}
          onContextMenu={openMenu}
        />
        {menu}
      </div>
    );
  }

  if (config.style === 'switch') {
    const on = position >= 0.5;
    return (
      <div className="knob" data-testid={`knob-${label}`}>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={label}
          title={`${label}: ${fixed(value)}`}
          className={`knob-toggle${on ? ' knob-toggle-on' : ''}`}
          onClick={() => {
            onPosition(on ? 0 : 1);
            onRelease?.();
          }}
          onContextMenu={openMenu}
        />
        {menu}
      </div>
    );
  }

  const spread = wired ? spreadRange(config, position, atten, offset) : null;
  const tooltip = spread
    ? `${label}: ${fixed(value)} (wire ${fixed(spread.min)}…${fixed(spread.max)})`
    : `${label}: ${fixed(value)}`;

  return (
    <div className="knob" data-testid={`knob-${label}`}>
      {spread && (
        <svg className="knob-spread" viewBox="0 0 44 44" aria-hidden="true">
          <path
            data-testid={`knob-spread-${label}`}
            d={arcPath(
              positionForValue(config, spread.min),
              positionForValue(config, spread.max),
              22,
              22,
              20,
            )}
          />
        </svg>
      )}
      <div
        className="knob-dial"
        role="slider"
        aria-label={label}
        aria-valuemin={config.min}
        aria-valuemax={config.max}
        aria-valuenow={value}
        title={tooltip}
        tabIndex={0}
        onMouseDown={(e) => {
          e.preventDefault();
          // cmd/ctrl-drag retargets the gesture at the wire amount.
          const wire = !!wired && (e.metaKey || e.ctrlKey) && !!onAttenOffset;
          drag.current = { startY: e.clientY, startPos: position, startAtten: atten, wire };
        }}
        onContextMenu={openMenu}
      >
        <div className="knob-pointer" style={{ transform: `rotate(${angle}deg)` }} />
      </div>
      {menu}
    </div>
  );
}
