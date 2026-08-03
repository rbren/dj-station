// Manifest-driven auto-generated module panel (PRD §7.1): every input is a
// jack + knob; wiring a jack supersedes its knob (attenuverter/offset live
// in the right-click config menu). Numeric params get their own knobs —
// for modules with a custom UI (e.g. ADSR) both stay in sync through the
// engine's param state. Clicking an output jack then an input jack makes a
// wire; clicking a wired input removes its wire.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { JackTelemetry, KnobConfig, KnobState, Manifest, ModuleHandle } from '../types';
import { Jack } from './Jack';
import { Knob } from './Knob';

export interface JackRef {
  instance: string;
  jack: string;
}

/** Coarse placement grid, ~0.5in at 96dpi. */
export const GRID = 48;

export const snap = (v: number) => Math.max(0, Math.round(v / GRID) * GRID);

/** Panels occupy whole grid cells: round a content size up to the grid. */
export const snapUpToGrid = (px: number) => Math.max(GRID, Math.ceil(px / GRID) * GRID);

export interface ModulePanelProps {
  instanceId: string;
  manifest: Manifest;
  knobs: Record<string, KnobState>;
  wired: Record<string, boolean>;
  telemetry?: Record<string, JackTelemetry>;
  handle: ModuleHandle;
  customUI?: ComponentType<{ handle: ModuleHandle; instanceId?: string }>;
  /** Extra panel content (e.g. the MIDI module's mapping editor). */
  extra?: ReactNode;
  /** Rack position; when set the panel is absolutely positioned and its
   *  header becomes a drag handle snapping to the coarse GRID. */
  position?: { x: number; y: number };
  onMove?(x: number, y: number): void;
  /** Delete this module instance (renders a ✕ button in the corner). */
  onRemove?(): void;
  /** Called on pointer-up after knob/param drags (undo gesture boundary). */
  onEditEnd?(): void;
  /** Jack currently armed as a pending wire end, if any. */
  pendingSource?: (JackRef & { kind: 'input' | 'output' }) | null;
  onJackClick?(kind: 'input' | 'output', jackId: string): void;
  onKnobPosition(jackId: string, position: number): void;
  onKnobConfig(jackId: string, config: KnobConfig): void;
  onAttenOffset(jackId: string, atten: number, offset: number): void;
  onParam?(paramId: string, value: number): void;
}

const DEFAULT_KNOB: KnobConfig = { style: 'continuous', min: 0, max: 10, curve: 'linear' };

export function ModulePanel(props: ModulePanelProps) {
  const { manifest, instanceId, knobs, wired, telemetry, pendingSource, position, onMove } = props;
  const CustomUI = props.customUI;
  const numericParams = manifest.params.filter((p) => typeof (p.default ?? 0) === 'number');

  const drag = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );
  const onDragMove = useCallback(
    (e: MouseEvent) => {
      const d = drag.current;
      if (!d || !onMove) return;
      onMove(snap(d.origX + e.clientX - d.startX), snap(d.origY + e.clientY - d.startY));
    },
    [onMove],
  );
  const onDragEnd = useCallback(() => {
    drag.current = null;
  }, []);
  useEffect(() => {
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
    return () => {
      window.removeEventListener('mousemove', onDragMove);
      window.removeEventListener('mouseup', onDragEnd);
    };
  }, [onDragMove, onDragEnd]);

  // Panels occupy whole grid cells: measure the natural content size
  // (offsetWidth/Height — unaffected by the rack's zoom transform) and
  // round the panel up to grid multiples.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (!w || !h) return;
      // +2 for the panel's own 1px border on each side.
      const snapped = { w: snapUpToGrid(w + 2), h: snapUpToGrid(h + 2) };
      setSize((prev) => (prev && prev.w === snapped.w && prev.h === snapped.h ? prev : snapped));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      className={`module-panel${position ? ' module-panel-placed' : ''}`}
      data-testid={`module-${instanceId}`}
      style={{
        ...(position ? { left: position.x, top: position.y } : undefined),
        ...(size ? { width: size.w, height: size.h } : undefined),
      }}
    >
      <div className="module-panel-content" ref={contentRef}>
      <header
        className={`module-title${onMove ? ' module-title-draggable' : ''}`}
        data-testid={`module-header-${instanceId}`}
        onMouseDown={(e) => {
          if (!onMove || !position || e.button !== 0) return;
          e.preventDefault();
          drag.current = {
            startX: e.clientX,
            startY: e.clientY,
            origX: position.x,
            origY: position.y,
          };
        }}
      >
        {manifest.name}
        <span className="module-instance">{instanceId}</span>
        {props.onRemove && (
          <button
            className="module-remove"
            data-testid={`module-remove-${instanceId}`}
            title="Delete module"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => props.onRemove?.()}
          >
            ✕
          </button>
        )}
      </header>
      {CustomUI && (
        <div className="module-custom-ui">
          <CustomUI handle={props.handle} instanceId={instanceId} />
        </div>
      )}
      {props.extra}
      {numericParams.length > 0 && (
        <div className="module-params">
          {numericParams.map((p) => {
            const min = p.min ?? 0;
            const max = p.max ?? 1;
            const value = props.handle.paramValue(p.id);
            const position = max === min ? 0 : (value - min) / (max - min);
            const config: KnobConfig = { style: 'continuous', min, max, curve: 'linear' };
            return (
              <div className="module-param" key={p.id}>
                <Knob
                  label={p.id}
                  config={config}
                  position={position}
                  onPosition={(pos) => props.onParam?.(p.id, min + pos * (max - min))}
                  onRelease={props.onEditEnd}
                />
                <span className="param-name">{p.id}</span>
              </div>
            );
          })}
        </div>
      )}
      <div
        className={`module-inputs${manifest.inputs.length > 8 ? ' module-inputs-condensed' : ''}`}
      >
        {manifest.inputs.map((input) => {
          const state = knobs[input.id];
          const config = state?.config ?? input.knob ?? DEFAULT_KNOB;
          const isWired = wired[input.id] ?? false;
          return (
            <div className="module-row" key={input.id}>
              <Jack
                instance={instanceId}
                id={input.id}
                kind="input"
                telemetry={telemetry?.[input.id]}
                wired={isWired}
                selected={
                  pendingSource?.kind === 'input' &&
                  pendingSource.instance === instanceId &&
                  pendingSource.jack === input.id
                }
                onClick={() => props.onJackClick?.('input', input.id)}
              />
              <Knob
                label={input.id}
                config={config}
                position={state?.position ?? 0}
                wired={isWired}
                atten={state?.atten}
                offset={state?.offset}
                onPosition={(p) => props.onKnobPosition(input.id, p)}
                onConfigChange={(c) => props.onKnobConfig(input.id, c)}
                onAttenOffset={(a, o) => props.onAttenOffset(input.id, a, o)}
                onRelease={props.onEditEnd}
              />
            </div>
          );
        })}
      </div>
      <div className="module-outputs">
        {manifest.outputs.map((output) => (
          <Jack
            key={output.id}
            instance={instanceId}
            id={output.id}
            kind="output"
            telemetry={telemetry?.[`out:${output.id}`]}
            selected={
              pendingSource?.kind === 'output' &&
              pendingSource.instance === instanceId &&
              pendingSource.jack === output.id
            }
            onClick={() => props.onJackClick?.('output', output.id)}
          />
        ))}
      </div>
      </div>
    </div>
  );
}
