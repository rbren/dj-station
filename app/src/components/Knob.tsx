// Data-driven knob (PRD §7.2): what renders is determined by the config
// style — a dial (continuous/stepped), a toggle (switch/button), or nothing
// at all ('wire': the input is a plain jack). Values are not printed inline;
// they appear in the hover tooltip. Right-click opens the config editor
// (which also hosts attenuverter/offset when the jack is wired).

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
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (onConfigChange) setMenuOpen(true);
  };
  const menu = menuOpen && onConfigChange && (
    <KnobConfigMenu
      config={config}
      onChange={(c) => onConfigChange(c)}
      onClose={() => setMenuOpen(false)}
      wired={wired}
      atten={props.atten}
      offset={props.offset}
      onAttenOffset={props.onAttenOffset}
    />
  );

  // A wired jack's own knob is superseded by the incoming signal
  // (attenuverter/offset live in the right-click menu); 'wire' style means
  // "no knob at all". Both render only the config affordance.
  if (config.style === 'wire' || wired) {
    return (
      <div className="knob knob-wire" data-testid={`knob-${label}`} onContextMenu={openMenu}>
        {menu}
      </div>
    );
  }

  if (config.style === 'switch' || config.style === 'button') {
    const on = position >= 0.5;
    return (
      <div className="knob" data-testid={`knob-${label}`}>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={label}
          title={`${label}: ${value.toFixed(2)}`}
          className={`knob-toggle${on ? ' knob-toggle-on' : ''}`}
          onClick={() => onPosition(on ? 0 : 1)}
          onContextMenu={openMenu}
        />
        {menu}
      </div>
    );
  }

  return (
    <div className="knob" data-testid={`knob-${label}`}>
      <div
        className="knob-dial"
        role="slider"
        aria-label={label}
        aria-valuemin={config.min}
        aria-valuemax={config.max}
        aria-valuenow={value}
        title={`${label}: ${value.toFixed(2)}`}
        tabIndex={0}
        onMouseDown={(e) => {
          e.preventDefault();
          drag.current = { startY: e.clientY, startPos: position };
        }}
        onContextMenu={openMenu}
      >
        <div className="knob-pointer" style={{ transform: `rotate(${angle}deg)` }} />
      </div>
      {menu}
    </div>
  );
}
