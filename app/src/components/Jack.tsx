// A patch jack with an activation glow driven by telemetry (PRD §6).
// The signal value is not printed inline — it lives in the hover tooltip
// and in the glow. Clicking jacks is how wires are made (output → input).
// Input cells render the jack label themselves (showLabel=false); output
// groups keep the inline label.

import { fixed, safeNumber } from '../format';
import type { JackTelemetry } from '../types';

export function Jack({
  instance,
  id,
  kind,
  label,
  telemetry,
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
  wired?: boolean;
  selected?: boolean;
  /** Outline color while armed — the pending wire's cable color. */
  selectedColor?: string;
  onClick?(shift: boolean): void;
  showLabel?: boolean;
}) {
  // `display` is typed number but crosses IPC as JSON, where a non-finite
  // f32 becomes `null` — read it defensively.
  const level = telemetry ? Math.min(1, Math.abs(safeNumber(telemetry.display)) / 10) : 0;
  const tooltip = telemetry
    ? `${id}: ${fixed(telemetry.display)}${telemetry.is_fast ? ' (rms)' : ''}`
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
          className="jack-glow"
          data-testid={`jack-glow-${id}`}
          style={{ opacity: 0.15 + 0.85 * level }}
        />
      </span>
      {showLabel && <span className="jack-name">{label ?? id}</span>}
    </button>
  );
}
