// Right-click editor for per-patch knob config overrides (PRD §7.2):
// style, endpoints and curve are data, not code. When the jack is wired
// this menu also hosts the wire spread — the value range the incoming
// signal can swing the knob's baseline through.
//
// Rendered in a portal at the cursor: module panels clip their content, so
// an in-flow menu would be cut off at the panel edge.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { CurveName, KnobConfig, KnobStyle } from '../types';
import { attenOffsetForSpread, spreadRange } from './Knob';

export function KnobConfigMenu({
  config,
  at,
  onChange,
  onClose,
  wired,
  position,
  atten,
  offset,
  onAttenOffset,
}: {
  config: KnobConfig;
  /** Viewport coordinates to anchor the menu at (the right-click point). */
  at?: { x: number; y: number };
  onChange(config: KnobConfig): void;
  onClose(): void;
  wired?: boolean;
  /** Knob position: the spread is shown as absolute values around it. */
  position?: number;
  atten?: number;
  offset?: number;
  onAttenOffset?(atten: number, offset: number): void;
}) {
  const curveName = typeof config.curve === 'string' ? config.curve : 'custom';
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Capture phase so a click that also lands on another control still
    // closes this menu first.
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const spread = spreadRange(config, position ?? 0, atten ?? 1, offset ?? 0);
  const setSpread = (min: number, max: number) => {
    const next = attenOffsetForSpread(config, position ?? 0, min, max);
    onAttenOffset?.(next.atten, next.offset);
  };

  const menu = (
    <div
      ref={ref}
      className="knob-config-menu"
      role="dialog"
      aria-label="Knob configuration"
      style={at ? { position: 'fixed', left: at.x, top: at.y } : undefined}
    >
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
          <option value="wire">wire</option>
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
      {wired && onAttenOffset && (
        <>
          <div className="knob-config-section">Wire spread</div>
          <label>
            Spread min
            <input
              type="number"
              aria-label="wire spread min"
              step={0.1}
              value={Number(spread.min.toFixed(4))}
              onChange={(e) => setSpread(Number(e.target.value), spread.max)}
            />
          </label>
          <label>
            Spread max
            <input
              type="number"
              aria-label="wire spread max"
              step={0.1}
              value={Number(spread.max.toFixed(4))}
              onChange={(e) => setSpread(spread.min, Number(e.target.value))}
            />
          </label>
        </>
      )}
      <button onClick={onClose}>Close</button>
    </div>
  );

  return at && typeof document !== 'undefined' ? createPortal(menu, document.body) : menu;
}
