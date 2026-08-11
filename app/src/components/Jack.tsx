// A patch jack with an activation indicator driven by telemetry (PRD §6).
// The signal value is not printed inline — it lives in the hover tooltip
// and in the indicator color. Clicking jacks is how wires are made
// (output → input). Input cells render the jack label themselves
// (showLabel=false); output groups keep the inline label.
//
// Indicator color language (both inputs and outputs):
// - near zero      → neutral GRAY (not a dim blue/red)
// - positive value → ramps gray → saturated BLUE at +10 V
// - negative value → ramps gray → saturated ORANGE-RED (hue 18°) at −10 V
// - volatile (>10 Hz fluctuation the smoothed display can't follow)
//   → PURE RED (hue 0°), saturation/depth scaled by telemetry.volatility,
//     plus a pulsing halo. The hue split (orange-red vs pure red) and the
//     pulse keep "negative" and "too fast to display" visually distinct.
// The displayed level uses `telemetry.display`, which the engine low-pass
// smooths over its 100 ms (10 Hz) window.

import { formatDisplay } from '../display';
import { safeNumber } from '../format';
import type { DisplaySpec, JackTelemetry, KnobConfig } from '../types';

/** Volatility below this renders as an ordinary value, not an alert. */
const VOLATILE_MIN = 0.05;

/** Indicator color + halo for a telemetry reading (exported for tests). */
export function indicatorStyle(telemetry: JackTelemetry | undefined): {
  volatile: boolean;
  color: string;
  halo: string;
} {
  const display = safeNumber(telemetry?.display);
  const volatility = safeNumber(telemetry?.volatility);
  if (volatility > VOLATILE_MIN) {
    // Volatile: pure red, deeper/more saturated the faster it fluctuates.
    const s = Math.round(55 + 45 * volatility);
    const l = Math.round(66 - 22 * volatility);
    const color = `hsl(0, ${s}%, ${l}%)`;
    return { volatile: true, color, halo: `0 0 10px 2px ${color}` };
  }
  // Signed value: neutral gray at 0 ramping to a saturated hue at ±10 V.
  const level = Math.min(1, Math.abs(display) / 10);
  const hue = display >= 0 ? 210 : 18;
  const s = Math.round(12 + 88 * level);
  const l = Math.round(64 - 12 * level);
  const color = `hsl(${hue}, ${s}%, ${l}%)`;
  return {
    volatile: false,
    color,
    halo: `0 0 ${Math.round(3 + 8 * level)}px ${Math.round(1 + 2 * level)}px ${color}`,
  };
}

export function Jack({
  instance,
  id,
  kind,
  label,
  telemetry,
  display,
  knob,
  wired,
  selected,
  selectedColor,
  onClick,
  showLabel = true,
}: {
  instance: string;
  id: string;
  kind: 'input' | 'output';
  /** Display label (defaults to the jack id). */
  label?: string;
  telemetry?: JackTelemetry;
  /** Manifest display spec for the tooltip value; absent = Volts. */
  display?: DisplaySpec | null;
  /** Knob config, used to resolve step labels for stepped inputs. */
  knob?: KnobConfig | null;
  wired?: boolean;
  selected?: boolean;
  /** Outline color while armed — the pending wire's cable color. */
  selectedColor?: string;
  onClick?(shift: boolean): void;
  showLabel?: boolean;
}) {
  // `display` is typed number but crosses IPC as JSON, where a non-finite
  // f32 becomes `null` — read it defensively.
  const style = telemetry ? indicatorStyle(telemetry) : null;
  const volatile = style?.volatile ?? false;
  const tooltip = telemetry
    ? `${id}: ${formatDisplay(display, telemetry.display, knob)}${
        telemetry.is_fast ? ' (rms)' : ''
      }${volatile ? ' ⚡ >10 Hz' : ''}`
    : id;
  return (
    <button
      type="button"
      className={`jack jack-${kind}${wired ? ' jack-wired' : ''}${selected ? ' jack-selected' : ''}`}
      data-testid={`jack-${kind}-${id}`}
      data-tip={tooltip}
      style={selected && selectedColor ? { outlineColor: selectedColor } : undefined}
      onClick={(e) => onClick?.(e.shiftKey)}
    >
      {/* The socket is the wire anchor point (data-jack), styled like a
          hardware panel jack: metal ring around a dark bore. */}
      <span className="jack-socket" data-jack={`${instance}:${kind}:${id}`}>
        <span
          className={`jack-glow${volatile ? ' jack-glow-volatile' : ''}`}
          data-testid={`jack-glow-${id}`}
          data-indicator={style?.color}
          style={style ? { background: style.color, boxShadow: style.halo } : undefined}
        />
      </span>
      {showLabel && <span className="jack-name">{label ?? id}</span>}
    </button>
  );
}
