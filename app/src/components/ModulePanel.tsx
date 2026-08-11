// Manifest-driven module panel (PRD §7.1): every input renders as a tight
// InputCell (wire jack stacked on its control), arranged by the module's
// declarative layout (panelLayouts.ts) into titled groups, columns and
// grids. A wired jack blends with its knob baseline (drag sets the
// baseline, cmd-drag the wire amount). Clicking an output jack then an
// input jack makes a wire; clicking a wired input picks its cable up to
// move it, and shift+click unplugs a jack's most recent wire.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { JackTelemetry, KnobConfig, KnobState, Manifest, ModuleHandle } from '../types';
import { InputCell } from './InputCell';
import { Jack } from './Jack';
import { resolveLayout } from './panelLayouts';
import { WIRE_COLORS } from './WireOverlay';

/** Panel accent hue per library category (border + title tint). */
const CATEGORY_ACCENTS: Record<string, string> = {
  Sources: '#e0876a',
  Shaping: '#d4b45f',
  Modulation: '#8f7fe0',
  'Clock & Sequencing': '#5fb6d4',
  Effects: '#c96a9e',
  Utilities: '#7fae8b',
  DJ: '#62d0ff',
  'Analysis & I/O': '#9aa7b5',
};

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
  /** Right-click on the panel (module context menu). */
  onContextMenu?(e: React.MouseEvent<HTMLDivElement>): void;
  /** Jack currently armed as a pending wire end, if any. */
  pendingSource?: (JackRef & { kind: 'input' | 'output'; color?: number }) | null;
  /** Multi-select for collapse-to-macro (PRD §6): shift-click toggles. */
  selected?: boolean;
  onSelectToggle?(): void;
  onJackClick?(kind: 'input' | 'output', jackId: string, shift?: boolean): void;
  onKnobPosition(jackId: string, position: number): void;
  onKnobConfig(jackId: string, config: KnobConfig): void;
  onAttenOffset(jackId: string, atten: number, offset: number): void;
}

export function ModulePanel(props: ModulePanelProps) {
  const { manifest, instanceId, knobs, wired, telemetry, pendingSource, position, onMove } = props;
  const pendingColor =
    pendingSource?.color !== undefined
      ? WIRE_COLORS[pendingSource.color % WIRE_COLORS.length]
      : undefined;
  const CustomUI = props.customUI;
  const layout = useMemo(() => resolveLayout(manifest), [manifest]);
  const accent = CATEGORY_ACCENTS[manifest.category ?? ''] ?? '#8a93a2';
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
      className={`module-panel${position ? ' module-panel-placed' : ''}${
        props.selected ? ' module-panel-selected' : ''
      }`}
      data-testid={`module-${instanceId}`}
      data-selected={props.selected ? 'true' : undefined}
      onContextMenu={props.onContextMenu}
      style={{
        ...(position ? { left: position.x, top: position.y } : undefined),
        ...(size ? { width: size.w, height: size.h } : undefined),
        ['--accent' as string]: accent,
      }}
    >
      <div className="module-panel-content" ref={contentRef}>
        <header
          className={`module-title${onMove ? ' module-title-draggable' : ''}`}
          data-testid={`module-header-${instanceId}`}
          onClick={(e) => {
            if (e.shiftKey) {
              e.preventDefault();
              props.onSelectToggle?.();
            }
          }}
          onMouseDown={(e) => {
            if (!onMove || !position || e.button !== 0 || e.shiftKey) return;
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
              data-tip="Delete module"
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
        {layout.groups.length > 0 && (
          <div className="module-inputs">
            {layout.groups.map((group, gi) => (
              <div
                key={group.title ?? gi}
                className={`input-group input-group-${group.kind ?? 'row'}${
                  group.break ? ' input-group-break' : ''
                }`}
              >
                {group.title && <span className="input-group-title">{group.title}</span>}
                <div
                  className="input-group-cells"
                  style={
                    group.kind === 'grid' && group.columns
                      ? { gridTemplateColumns: `repeat(${group.columns}, max-content)` }
                      : undefined
                  }
                >
                  {group.cells.map((cell) => {
                    const decl = manifest.inputs.find((i) => i.id === cell.jack);
                    return (
                      <InputCell
                        key={cell.jack}
                        instance={instanceId}
                        cell={cell}
                        manifestKnob={decl?.knob}
                        state={knobs[cell.jack]}
                        wired={wired[cell.jack] ?? false}
                        telemetry={telemetry?.[cell.jack]}
                        selected={
                          pendingSource?.kind === 'input' &&
                          pendingSource.instance === instanceId &&
                          pendingSource.jack === cell.jack
                        }
                        selectedColor={pendingColor}
                        onJackClick={(shift) => props.onJackClick?.('input', cell.jack, shift)}
                        onKnobPosition={(p) => props.onKnobPosition(cell.jack, p)}
                        onKnobConfig={(c) => props.onKnobConfig(cell.jack, c)}
                        onAttenOffset={(a, o) => props.onAttenOffset(cell.jack, a, o)}
                        onEditEnd={props.onEditEnd}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        {layout.outputGroups.length > 0 && (
          <div className="module-outputs">
            {layout.outputGroups.map((group, gi) => (
              <div key={group.title ?? gi} className="output-group">
                {group.title && <span className="output-group-title">{group.title}</span>}
                <div
                  className={`output-group-jacks${group.columns ? ' output-group-grid' : ''}`}
                  style={
                    group.columns
                      ? { gridTemplateColumns: `repeat(${group.columns}, max-content)` }
                      : undefined
                  }
                >
                  {group.outputs.map((id) => (
                    <Jack
                      key={id}
                      instance={instanceId}
                      id={id}
                      kind="output"
                      telemetry={telemetry?.[`out:${id}`]}
                      selected={
                        pendingSource?.kind === 'output' &&
                        pendingSource.instance === instanceId &&
                        pendingSource.jack === id
                      }
                      selectedColor={pendingColor}
                      onClick={(shift) => props.onJackClick?.('output', id, shift)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
