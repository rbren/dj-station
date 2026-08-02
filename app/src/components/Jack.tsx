// A patch jack with an activation glow driven by telemetry (PRD §6).

import type { JackTelemetry } from '../types';

export function Jack({
  id,
  kind,
  telemetry,
}: {
  id: string;
  kind: 'input' | 'output';
  telemetry?: JackTelemetry;
}) {
  const level = telemetry ? Math.min(1, Math.abs(telemetry.display) / 10) : 0;
  return (
    <div className={`jack jack-${kind}`} data-testid={`jack-${kind}-${id}`}>
      <span
        className="jack-glow"
        data-testid={`jack-glow-${id}`}
        style={{ opacity: 0.15 + 0.85 * level }}
      />
      <span className="jack-name">{id}</span>
      {telemetry && (
        <span className="jack-readout" data-testid={`jack-readout-${id}`}>
          {telemetry.display.toFixed(2)}
          {telemetry.is_fast ? ' rms' : ''}
        </span>
      )}
    </div>
  );
}
