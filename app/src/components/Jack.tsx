// A patch jack with an activation glow driven by telemetry (PRD §6).
// The signal value is not printed inline — it lives in the hover tooltip
// and in the glow. Clicking jacks is how wires are made (output → input).

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
  const level = telemetry ? Math.min(1, Math.abs(telemetry.display) / 10) : 0;
  const tooltip = telemetry
    ? `${id}: ${telemetry.display.toFixed(2)}${telemetry.is_fast ? ' (rms)' : ''}`
    : id;
  return (
    <button
      type="button"
      className={`jack jack-${kind}${wired ? ' jack-wired' : ''}${selected ? ' jack-selected' : ''}`}
      data-testid={`jack-${kind}-${id}`}
      data-jack={`${instance}:${kind}:${id}`}
      title={tooltip}
      onClick={onClick}
    >
      <span
        className="jack-glow"
        data-testid={`jack-glow-${id}`}
        style={{ opacity: 0.15 + 0.85 * level }}
      />
      <span className="jack-name">{id}</span>
    </button>
  );
}
