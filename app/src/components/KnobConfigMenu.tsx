// Right-click editor for per-patch knob config overrides (PRD §7.2):
// style, endpoints and curve are data, not code. It also hosts a direct
// numeric entry for the knob's value (exact values are hard to hit by
// drag), and when the jack is wired the wire spread — the value range the
// incoming signal can swing the knob's baseline through.
//
// Rendered in a portal at the cursor: module panels clip their content, so
// an in-flow menu would be cut off at the panel edge.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_UNIT, displayNumber, displayToRaw, noteOptions } from '../display';
import type { CurveName, DisplaySpec, KnobConfig, KnobStyle, WireStyle } from '../types';
import { attenOffsetForSpread, mapPosition, positionForValue, spreadRange } from './Knob';

export function KnobConfigMenu({
  config,
  at,
  onChange,
  onClose,
  wired,
  plain,
  position,
  onPosition,
  onRelease,
  atten,
  offset,
  onAttenOffset,
  wireStyle,
  onWireStyle,
  display,
}: {
  config: KnobConfig;
  /** Viewport coordinates to anchor the menu at (the right-click point). */
  at?: { x: number; y: number };
  onChange(config: KnobConfig): void;
  onClose(): void;
  wired?: boolean;
  /** Plain wire jack — additive value-space blend (see Knob.tsx). */
  plain?: boolean;
  /** Knob position: the spread is shown as absolute values around it. */
  position?: number;
  /** Direct value entry: sets the knob position for a typed value. */
  onPosition?(position: number): void;
  onRelease?(): void;
  atten?: number;
  offset?: number;
  onAttenOffset?(atten: number, offset: number): void;
  /** Wired blend mode: 'cv' (signal modulates the knob baseline) or
   *  'override' (signal IS the value — auto-picked for pitch wires). */
  wireStyle?: WireStyle;
  onWireStyle?(style: WireStyle): void;
  /** Manifest display spec: the Value field is entered in DISPLAY units
   *  (the same numbers the tooltip shows), converted back through the
   *  spec's map. Hz units additionally get a note picker. */
  display?: DisplaySpec | null;
}) {
  const curveName = typeof config.curve === 'string' ? config.curve : 'custom';
  const ref = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef<HTMLInputElement | null>(null);
  // While the user is typing, the field shows their raw text instead of the
  // knob-derived number — otherwise partial input ("", "-", "1e") parses to
  // NaN, is ignored, and the controlled value snaps the text right back,
  // making the field impossible to clear or retype.
  const [draft, setDraft] = useState<string | null>(null);

  // Right-click is a "type a value" gesture: focus the field with its
  // content selected so typing immediately replaces it.
  useEffect(() => {
    valueRef.current?.focus();
    valueRef.current?.select();
  }, []);

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

  const spread = spreadRange(config, position ?? 0, atten ?? 1, offset ?? 0, plain);
  const setSpread = (min: number, max: number) => {
    const next = attenOffsetForSpread(config, position ?? 0, min, max, plain);
    onAttenOffset?.(next.atten, next.offset);
  };

  // Direct entry works in DISPLAY units — the same numbers the tooltip
  // shows (e.g. Hz for a volt-per-octave pitch knob) — converted back to a
  // raw engine value through the display map before solving for position.
  const unit = display?.unit ?? DEFAULT_UNIT;
  const value = displayNumber(display, mapPosition(config, position ?? 0));
  const setValue = (v: number) => {
    if (!Number.isFinite(v)) return;
    const raw = displayToRaw(display, v);
    if (Number.isFinite(raw)) onPosition?.(positionForValue(config, raw));
  };
  const displayMin = displayNumber(display, Math.min(config.min, config.max));
  const displayMax = displayNumber(display, Math.max(config.min, config.max));
  const notes =
    unit === 'Hz' ? noteOptions().filter((n) => n.hz >= displayMin && n.hz <= displayMax) : [];
  // The picker shows the nearest note when the current value matches one
  // (within a cent), else a blank placeholder.
  const currentNote = notes.find((n) => Math.abs(Math.log2(value / n.hz)) < 1 / 1200)?.name ?? '';

  const menu = (
    <div
      ref={ref}
      className="knob-config-menu"
      role="dialog"
      aria-label="Knob configuration"
      style={at ? { position: 'fixed', left: at.x, top: at.y } : undefined}
    >
      {onPosition && config.style !== 'wire' && (
        <>
          <label>
            Value{unit ? ` (${unit})` : ''}
            <input
              ref={valueRef}
              type="number"
              aria-label="knob value"
              step={0.1}
              min={displayMin}
              max={displayMax}
              value={draft ?? Number(value.toFixed(4))}
              // valueAsNumber: NaN for empty/partial input (Number('') is 0,
              // which would slam the knob while the user is still typing).
              onChange={(e) => {
                setDraft(e.target.value);
                setValue(e.target.valueAsNumber);
              }}
              onBlur={() => {
                setDraft(null);
                onRelease?.();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onRelease?.();
                  onClose();
                }
              }}
            />
          </label>
          {notes.length > 0 && (
            <label>
              Note
              <select
                aria-label="knob note"
                value={currentNote}
                onChange={(e) => {
                  const note = notes.find((n) => n.name === e.target.value);
                  if (note) {
                    setValue(note.hz);
                    onRelease?.();
                  }
                }}
              >
                <option value="" disabled hidden>
                  —
                </option>
                {notes.map((n) => (
                  <option key={n.name} value={n.name}>
                    {n.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
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
      {wired && onWireStyle && (
        <label>
          Wire mode
          <select
            aria-label="wire mode"
            value={wireStyle ?? 'cv'}
            onChange={(e) => onWireStyle(e.target.value as WireStyle)}
          >
            <option value="cv">CV (adds to knob)</option>
            <option value="override">override (sets value)</option>
          </select>
        </label>
      )}
      {wired && onAttenOffset && wireStyle !== 'override' && (
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
