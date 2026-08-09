// A patch jack with an activation glow driven by telemetry (PRD §6).
// The signal value is not printed inline — it lives in the hover tooltip
// and in the glow. Clicking jacks is how wires are made (output → input).

import { fixed, safeNumber } from '../format';
import type { JackTelemetry } from '../types';

export function Jack({
  instance,
  id,
  kind,
  telemetry,
  wired,
  selected,
  onClick,
}: {
  instance: string;
  id: string;
  kind: 'input' | 'output';
  telemetry?: JackTelemetry;
  wired?: boolean;
  selected?: boolean;
  onClick?(): void;
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
      title={tooltip}
      onClick={onClick}
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
      <span className="jack-name">{id}</span>
    </button>
  );
}
