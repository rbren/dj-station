// Data-driven knob (PRD §7.2): style/endpoints/curve come from KnobConfig.
// Vertical drag changes position; right-click opens the config editor for
// per-patch overrides.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KnobConfig } from '../types';
import { KnobConfigMenu } from './KnobConfigMenu';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

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

export interface KnobProps {
  label: string;
  config: KnobConfig;
  position: number;
  onPosition(position: number): void;
  onConfigChange?(config: KnobConfig): void;
  wired?: boolean;
  atten?: number;
  offset?: number;
  onAttenOffset?(atten: number, offset: number): void;
}

export function Knob(props: KnobProps) {
  const { label, config, position, onPosition, onConfigChange, wired } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const drag = useRef<{ startY: number; startPos: number } | null>(null);

  const onMove = useCallback(
    (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      onPosition(clamp01(d.startPos + (d.startY - e.clientY) / 150));
    },
    [onPosition],
  );
  const onUp = useCallback(() => {
    drag.current = null;
  }, []);
  useEffect(() => {
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onMove, onUp]);

  const value = mapPosition(config, position);
  const angle = -135 + clamp01(position) * 270;

  return (
    <div className="knob" data-testid={`knob-${label}`}>
      <div
        className="knob-dial"
        role="slider"
        aria-label={label}
        aria-valuemin={config.min}
        aria-valuemax={config.max}
        aria-valuenow={value}
        tabIndex={0}
        onMouseDown={(e) => {
          e.preventDefault();
          drag.current = { startY: e.clientY, startPos: position };
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
      >
        <div className="knob-pointer" style={{ transform: `rotate(${angle}deg)` }} />
      </div>
      <span className="knob-label">{label}</span>
      <span className="knob-value" data-testid={`knob-value-${label}`}>
        {value.toFixed(2)}
      </span>
      {wired && props.onAttenOffset && (
        <div className="knob-attenuverter" data-testid={`atten-${label}`}>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.01}
            value={props.atten ?? 1}
            aria-label={`${label} attenuverter`}
            onChange={(e) => props.onAttenOffset!(Number(e.target.value), props.offset ?? 0)}
          />
          <input
            type="number"
            step={0.1}
            value={props.offset ?? 0}
            aria-label={`${label} offset`}
            onChange={(e) => props.onAttenOffset!(props.atten ?? 1, Number(e.target.value))}
          />
        </div>
      )}
      {menuOpen && onConfigChange && (
        <KnobConfigMenu
          config={config}
          onChange={(c) => onConfigChange(c)}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}
