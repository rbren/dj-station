// Right-click editor for per-patch knob config overrides (PRD §7.2):
// style, endpoints and curve are data, not code.

import type { CurveName, KnobConfig, KnobStyle } from '../types';

export function KnobConfigMenu({
  config,
  onChange,
  onClose,
}: {
  config: KnobConfig;
  onChange(config: KnobConfig): void;
  onClose(): void;
}) {
  const curveName = typeof config.curve === 'string' ? config.curve : 'custom';
  return (
    <div className="knob-config-menu" role="dialog" aria-label="Knob configuration">
      <label>
        Style
        <select
          aria-label="knob style"
          value={config.style}
          onChange={(e) => onChange({ ...config, style: e.target.value as KnobStyle })}
        >
          <option value="continuous">continuous</option>
          <option value="stepped">stepped</option>
          <option value="switch">switch</option>
          <option value="button">button</option>
        </select>
      </label>
      {config.style === 'stepped' && (
        <label>
          Steps
          <input
            type="number"
            aria-label="knob steps"
            min={2}
            value={config.steps ?? 2}
            onChange={(e) => onChange({ ...config, steps: Number(e.target.value) })}
          />
        </label>
      )}
      <label>
        Min
        <input
          type="number"
          aria-label="knob min"
          value={config.min}
          onChange={(e) => onChange({ ...config, min: Number(e.target.value) })}
        />
      </label>
      <label>
        Max
        <input
          type="number"
          aria-label="knob max"
          value={config.max}
          onChange={(e) => onChange({ ...config, max: Number(e.target.value) })}
        />
      </label>
      <label>
        Curve
        <select
          aria-label="knob curve"
          value={curveName}
          disabled={curveName === 'custom'}
          onChange={(e) => onChange({ ...config, curve: e.target.value as CurveName })}
        >
          <option value="linear">linear</option>
          <option value="exp">exp</option>
          <option value="log">log</option>
          {curveName === 'custom' && <option value="custom">custom</option>}
        </select>
      </label>
      <button onClick={onClose}>Close</button>
    </div>
  );
}
