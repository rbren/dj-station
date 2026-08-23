// Data-driven knob (PRD §7.2): what renders is determined by the config
// style — a dial (continuous/stepped), a toggle (switch/button), or nothing
// at all ('wire': the input is a plain jack). Values are not printed inline;
// they appear in the hover tooltip. Right-click opens the config editor.
//
// Wiring an input does not take the knob away: the knob sets the baseline
// and the incoming signal moves it, scaled by the wire amount
// (attenuverter). For knob-backed inputs the blend happens in POSITION
// space — mirroring knob.rs JackRt exactly — so the knob's curve shapes
// the modulation and the spread tracks the baseline (an exp rate knob
// gets a geometric spread). Plain wire jacks (no manifest knob) keep the
// additive value-space law so audio/gate paths pass through. Drag sets
// the baseline; cmd/ctrl-drag sets the wire amount, drawn as a spread
// arc around the knob's notch.

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDisplay, stepLabel } from '../display';
import { useLiveJackTelemetry } from '../rackStore';
import type { DisplaySpec, JackTelemetry, KnobConfig, WireStyle } from '../types';
import { KnobConfigMenu } from './KnobConfigMenu';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Nominal peak of a patch signal (modules output ±5 V full scale); the
 *  wire amount is expressed against it, so atten = 1 means the wire can
 *  swing the value by ±5 V (additive) or half the knob travel
 *  (positional). */
export const WIRE_SIGNAL_REF = 5;

/** The ±10 V signal rails — the positional blend's signal→position scale,
 *  matching knob.rs (`signal * atten / 10`). */
export const SIGNAL_RAIL = 10;

/** Style quantization of a raw 0..1 position (knob.rs KnobConfig::snap):
 *  detent rounding for stepped, on/off snap for switch/button. */
export function snapPosition(config: KnobConfig, position: number): number {
  const p = clamp01(position);
  if (config.style === 'switch' || config.style === 'button') {
    return p >= 0.5 ? 1 : 0;
  }
  if (config.style === 'stepped') {
    const steps = Math.max(2, config.steps ?? 2);
    return Math.round(p * (steps - 1)) / (steps - 1);
  }
  return p;
}

export function mapPosition(config: KnobConfig, position: number): number {
  return curveAt(config, snapPosition(config, position));
}

/** Curve mapping only, no style snap (knob.rs KnobConfig::curve_at) — the
 *  positional wire blend moves a snapped baseline continuously. */
export function curveAt(config: KnobConfig, position: number): number {
  let p = clamp01(position);
  if (config.curve === 'exp') {
    // Geometric interpolation when the range allows it, squared-position
    // fallback otherwise — exactly like knob.rs KnobConfig::map.
    if (config.min > 0 && config.max > 0) {
      return config.min * Math.pow(config.max / config.min, p);
    }
    p = p * p;
  } else if (config.curve === 'log') {
    if (config.min > 0 && config.max > 0) {
      const ratio = Math.log(config.max / config.min);
      return config.min + (Math.expm1(p * ratio) / Math.expm1(ratio)) * (config.max - config.min);
    }
    p = Math.sqrt(p);
  } else if (typeof config.curve === 'object') {
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

/** Knob-position swing of a ±WIRE_SIGNAL_REF signal in the positional
 *  blend: `signal * atten / SIGNAL_RAIL` = half the travel at atten 1. */
const positionalHalf = (atten: number) => (WIRE_SIGNAL_REF / SIGNAL_RAIL) * Math.abs(atten);

/** Positions the positional blend can reach for a ±WIRE_SIGNAL_REF signal. */
export function spreadPositions(
  config: KnobConfig,
  position: number,
  atten: number,
  offset: number,
): { min: number; max: number } {
  const center = snapPosition(config, position) + offset;
  const half = positionalHalf(atten);
  return { min: clamp01(center - half), max: clamp01(center + half) };
}

/** Value range a wired input can reach for a ±WIRE_SIGNAL_REF signal.
 *  Positional (knob-backed) blend by default; `plain` selects the additive
 *  value-space law of knob-less wire jacks (see the header comment). */
export function spreadRange(
  config: KnobConfig,
  position: number,
  atten: number,
  offset: number,
  plain = false,
): { min: number; max: number } {
  if (plain) {
    const center = mapPosition(config, position) + offset;
    const half = WIRE_SIGNAL_REF * Math.abs(atten);
    return { min: center - half, max: center + half };
  }
  const p = spreadPositions(config, position, atten, offset);
  return { min: curveAt(config, p.min), max: curveAt(config, p.max) };
}

/** Inverse of `curveAt` (no style snap): binary search over the monotone
 *  curve, used to turn spread-editor values back into positions. */
function positionForCurveValue(config: KnobConfig, value: number): number {
  let lo = 0;
  let hi = 1;
  const increasing = curveAt(config, 1) >= curveAt(config, 0);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (curveAt(config, mid) < value === increasing) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Inverse of `spreadRange`: the atten/offset that put the wire's swing
 *  between `min` and `max` around the current baseline. */
export function attenOffsetForSpread(
  config: KnobConfig,
  position: number,
  min: number,
  max: number,
  plain = false,
): { atten: number; offset: number } {
  if (plain) {
    const base = mapPosition(config, position);
    return {
      atten: Math.max(-1, Math.min(1, (max - min) / (2 * WIRE_SIGNAL_REF))),
      offset: (min + max) / 2 - base,
    };
  }
  const pMin = positionForCurveValue(config, min);
  const pMax = positionForCurveValue(config, max);
  return {
    atten: Math.max(-1, Math.min(1, (pMax - pMin) / (2 * positionalHalf(1)))),
    offset: (pMin + pMax) / 2 - snapPosition(config, position),
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
  /** Manifest display spec (unit / mapping / step labels); absent = Volts. */
  display?: DisplaySpec | null;
  position: number;
  /** Position to RENDER at, when that is not the knob's own: under wire
   *  override the signal sets the value, so the dial/fader follows the
   *  live reading (see LiveOverrideKnob). Drags still move `position`. */
  displayPosition?: number;
  onPosition(position: number): void;
  /** End of an interaction gesture (drag release / toggle / momentary up). */
  onRelease?(): void;
  onConfigChange?(config: KnobConfig): void;
  /** Double-click: reset to the manifest default value, including wire
   *  atten/offset (CV spread). */
  onReset?(): void;
  wired?: boolean;
  /** Plain wire jack (no knob declared in the manifest or the patch):
   *  the engine blends additively in value space, not position space. */
  plain?: boolean;
  atten?: number;
  offset?: number;
  onAttenOffset?(atten: number, offset: number): void;
  /** Wired blend mode ('cv' default): under 'override' the signal IS the
   *  value, so the spread arc and cmd-drag wire gesture are suppressed. */
  wireStyle?: WireStyle;
  onWireStyle?(style: WireStyle): void;
  /** Layout-chosen control look: default dial, or a slider ('fader'
   *  vertical / 'hfader' horizontal) for mixer-style channels. */
  appearance?: 'fader' | 'hfader';
  /** Cosmetic jack color (WIRE_COLORS index; null/undefined = none),
   *  editable from the config menu when onJackColor is provided. */
  jackColor?: number | null;
  onJackColor?(color: number | null): void;
  /** Custom jack label (default label as placeholder), editable from the
   *  config menu when onJackLabel is provided. */
  jackLabel?: string | null;
  jackLabelDefault?: string;
  onJackLabel?(label: string | null): void;
}

export function Knob(props: KnobProps) {
  const {
    label,
    config,
    position,
    onPosition,
    onRelease,
    onConfigChange,
    onReset,
    wired,
    plain,
    appearance,
  } = props;
  const display = props.display;
  const { onAttenOffset } = props;
  const atten = props.atten ?? 1;
  const offset = props.offset ?? 0;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const horizontal = appearance === 'hfader';
  const drag = useRef<{
    startX: number;
    startY: number;
    startPos: number;
    startAtten: number;
    wire: boolean;
  } | null>(null);

  const onMove = useCallback(
    (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const delta = horizontal ? (e.clientX - d.startX) / 90 : (d.startY - e.clientY) / 150;
      if (d.wire) {
        onAttenOffset?.(Math.max(-1, Math.min(1, d.startAtten + delta)), offset);
      } else {
        onPosition(clamp01(d.startPos + delta));
      }
    },
    [onPosition, onAttenOffset, offset, horizontal],
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

  // What the control shows. Normally its own position; under wire override
  // the live value the signal is setting (drags still act on `position`).
  const shownPosition = props.displayPosition ?? position;
  const value = mapPosition(config, shownPosition);
  const angle = angleFor(shownPosition);
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // Right-click is the knob's own gesture (its config menu, when
    // configurable) — never let it bubble up and open the module panel's
    // context menu on top of it.
    e.stopPropagation();
    if (onConfigChange) setMenuAt({ x: e.clientX, y: e.clientY });
  };
  const menu = menuAt && onConfigChange && (
    <KnobConfigMenu
      config={config}
      at={menuAt}
      onChange={(c) => onConfigChange(c)}
      onClose={() => setMenuAt(null)}
      wired={wired}
      plain={plain || config.style === 'wire'}
      position={position}
      onPosition={onPosition}
      onRelease={onRelease}
      atten={props.atten}
      offset={props.offset}
      onAttenOffset={onAttenOffset}
      wireStyle={props.wireStyle}
      onWireStyle={props.onWireStyle}
      display={display}
      jackColor={props.jackColor}
      onJackColor={props.onJackColor}
      jackLabel={props.jackLabel}
      jackLabelDefault={props.jackLabelDefault}
      onJackLabel={props.onJackLabel}
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
    const on = shownPosition >= 0.5;
    return (
      <div className="knob" data-testid={`knob-${label}`}>
        <button
          type="button"
          aria-pressed={on}
          aria-label={label}
          data-tip={`${label}: hold for on`}
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
    const on = shownPosition >= 0.5;
    return (
      <div className="knob" data-testid={`knob-${label}`}>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={label}
          data-tip={`${label}: ${formatDisplay(display, value, config)}`}
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

  // Under override the wire IS the value: the knob baseline and spread are
  // inert, so the spread arc, cmd-drag gesture and tooltip range all drop.
  const overridden = !!wired && props.wireStyle === 'override';

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    // cmd/ctrl-drag retargets the gesture at the wire amount.
    const wire = !!wired && !overridden && (e.metaKey || e.ctrlKey) && !!onAttenOffset;
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPos: position,
      startAtten: atten,
      wire,
    };
  };

  // Double-click resets to the default value — baseline position AND the
  // wire's atten/offset spread. The reset is its own undo step, so end the
  // gesture the double-click's drags may have opened.
  const onDoubleClick = onReset
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        drag.current = null;
        onReset();
        onRelease?.();
      }
    : undefined;

  if (appearance === 'fader' || appearance === 'hfader') {
    const pct = clamp01(shownPosition) * 100;
    return (
      <div
        className={`knob knob-fader-box${horizontal ? ' knob-hfader-box' : ''}`}
        data-testid={`knob-${label}`}
      >
        <div
          className={horizontal ? 'fader fader-h' : 'fader fader-v'}
          role="slider"
          aria-label={label}
          aria-valuemin={config.min}
          aria-valuemax={config.max}
          aria-valuenow={value}
          aria-orientation={horizontal ? 'horizontal' : 'vertical'}
          data-tip={`${label}: ${formatDisplay(display, value, config)}`}
          tabIndex={0}
          onMouseDown={startDrag}
          onDoubleClick={onDoubleClick}
          onContextMenu={openMenu}
        >
          <div className="fader-track" />
          <div
            className="fader-cap"
            style={horizontal ? { left: `${pct}%` } : { bottom: `${pct}%` }}
          />
        </div>
        {menu}
      </div>
    );
  }

  const spread = wired && !overridden ? spreadRange(config, position, atten, offset, plain) : null;
  // Arc endpoints in knob-position space: the positional blend already
  // works there; the additive law inverts its value range back.
  const arc = !spread
    ? null
    : plain
      ? {
          min: positionForValue(config, spread.min),
          max: positionForValue(config, spread.max),
        }
      : spreadPositions(config, position, atten, offset);
  const shown = formatDisplay(display, value, config);
  const tooltip = spread
    ? `${label}: ${shown} (wire ${formatDisplay(display, spread.min, config)}…${formatDisplay(
        display,
        spread.max,
        config,
      )})`
    : overridden
      ? `${label}: wire sets value`
      : `${label}: ${shown}`;
  // Stepped selectors with declared labels show the current step inline —
  // the one case where the value beats the tooltip (you can't tell "major"
  // from "dorian" by needle angle).
  const inlineStep = config.style === 'stepped' ? stepLabel(display, value, config) : null;

  return (
    <div className="knob" data-testid={`knob-${label}`}>
      {arc && (
        <svg className="knob-spread" viewBox="0 0 44 44" aria-hidden="true">
          {/* Overscrolling the cmd-drag past zero reverses the wire (negative
              atten); the arc flips color so the flipped range reads at a
              glance. */}
          <path
            data-testid={`knob-spread-${label}`}
            className={atten < 0 ? 'knob-spread-reversed' : undefined}
            d={arcPath(arc.min, arc.max, 22, 22, 20)}
          />
        </svg>
      )}
      <div
        className={`knob-dial${overridden ? ' knob-dial-overridden' : ''}`}
        role="slider"
        aria-label={label}
        aria-valuemin={config.min}
        aria-valuemax={config.max}
        aria-valuenow={value}
        data-tip={tooltip}
        tabIndex={0}
        onMouseDown={startDrag}
        onDoubleClick={onDoubleClick}
        onContextMenu={openMenu}
      >
        <div className="knob-pointer" style={{ transform: `rotate(${angle}deg)` }} />
      </div>
      {inlineStep !== null && (
        <span className="knob-step-label" data-testid={`knob-step-${label}`}>
          {inlineStep}
        </span>
      )}
      {menu}
    </div>
  );
}

/** The knob of an input in wire-override mode: there the incoming signal
 *  IS the value (knob.rs `WireStyle::Override`), so the control renders as
 *  a live readout of the jack's post-blend telemetry — the dial turns and
 *  the fader cap slides with the wire, instead of sitting on an inert
 *  baseline. Drags still edit that baseline (it takes over again when the
 *  mode goes back to CV). The telemetry subscription lives in this wrapper
 *  so a tick re-renders only the control, never the cell or the panel
 *  around it. */
export function LiveOverrideKnob({
  instance,
  jack,
  telemetry,
  ...props
}: KnobProps & {
  instance: string;
  jack: string;
  /** Storeless fallback reading (docs previews, unit tests). */
  telemetry?: JackTelemetry;
}) {
  const live = useLiveJackTelemetry(instance, jack, telemetry);
  // `display` is typed number but crosses IPC as JSON, where a non-finite
  // f32 becomes null: fall back to the baseline rather than jump to 0.
  const value = live?.display;
  return (
    <Knob
      {...props}
      displayPosition={
        typeof value === 'number' && Number.isFinite(value)
          ? positionForValue(props.config, value)
          : undefined
      }
    />
  );
}
