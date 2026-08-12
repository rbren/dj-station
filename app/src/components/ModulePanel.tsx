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

export const snap = (v: number) => Math.round(v / GRID) * GRID;

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
  /** Called once when a header drag gesture ends (mouseup). */
  onMoveEnd?(): void;
  /** Rack scale factor: pointer deltas are screen px, positions are
   *  unzoomed rack coordinates, so drags divide deltas by this. */
  zoom?: number;
  /** Delete this module instance (renders a ✕ button in the corner). */
  onRemove?(): void;
  /** Open this module's documentation (renders a ? button in the title bar). */
  onDocs?(): void;
  /** Called on pointer-up after knob/param drags (undo gesture boundary). */
  onEditEnd?(): void;
  /** Right-click on the panel (module context menu). */
  onContextMenu?(e: React.MouseEvent<HTMLDivElement>): void;
  /** Jack currently armed as a pending wire end, if any. */
  pendingSource?: (JackRef & { kind: 'input' | 'output'; color?: number }) | null;
  /** Selection (copy/paste/delete/collapse-to-macro): a plain mousedown on
   *  any non-interactive part of the panel selects it (`additive` false —
   *  the selection is replaced); shift/cmd/ctrl toggles membership. */
  selected?: boolean;
  onSelect?(additive: boolean): void;
  onJackClick?(kind: 'input' | 'output', jackId: string, shift?: boolean): void;
  onKnobPosition(jackId: string, position: number): void;
  onKnobConfig(jackId: string, config: KnobConfig): void;
  onAttenOffset(jackId: string, atten: number, offset: number): void;
  /** Double-click knob reset to the default value (incl. wire spread). */
  onKnobReset?(jackId: string): void;
}

export function ModulePanel(props: ModulePanelProps) {
  const {
    manifest,
    instanceId,
    knobs,
    wired,
    telemetry,
    pendingSource,
    position,
    onMove,
    onMoveEnd,
    onSelect,
    zoom = 1,
  } = props;
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
      // Pointer deltas are screen px while the rack is scaled by `zoom`:
      // divide so the panel tracks the cursor 1:1 at any zoom level.
      onMove(
        snap(d.origX + (e.clientX - d.startX) / zoom),
        snap(d.origY + (e.clientY - d.startY) / zoom),
      );
    },
    [onMove, zoom],
  );
  const onDragEnd = useCallback(() => {
    if (drag.current) {
      drag.current = null;
      onMoveEnd?.();
    }
  }, [onMoveEnd]);

  // Select on MOUSEDOWN, not click (canvas-editor convention: pressing a
  // module selects it, a drag then moves the already-selected module).
  // Click-based selection is ambiguous with header drags — a few px of
  // wobble during a "click" either selects mid-drag or forces the click to
  // be swallowed, and a swallowed click silently leaves the previous
  // selection (and thus the copy buffer) live. Mousedowns aimed at an
  // interactive control (buttons, jacks, knobs, faders, form fields, a
  // custom UI's surface) never touch the selection. Plain press replaces
  // the selection; shift/cmd/ctrl-press toggles membership (multi-select).
  const onPanelMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!onSelect || e.button !== 0) return;
      const interactive = (e.target as HTMLElement).closest?.(
        'button, input, select, textarea, a, [role="slider"], [role="switch"], ' +
          '[contenteditable="true"], .knob, .jack, .module-custom-ui, .knob-config-menu',
      );
      if (interactive) return;
      onSelect(e.shiftKey || e.metaKey || e.ctrlKey);
    },
    [onSelect],
  );
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
      onMouseDown={onPanelMouseDown}
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
          {props.onDocs && (
            <button
              className="module-docs-btn"
              data-testid={`module-docs-${instanceId}`}
              data-tip="Documentation"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => props.onDocs?.()}
            >
              ?
            </button>
          )}
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
                      ? // Columns share the panel's --cell-w token so custom-UI
                        // strips (e.g. the step sequencer playhead) can render
                        // an identically-sized grid that lines up column-for-
                        // column with the cells.
                        {
                          gridTemplateColumns: `repeat(${group.columns}, var(--cell-w, max-content))`,
                        }
                      : undefined
                  }
                >
                  {group.cells.map((cell) => {
                    if (cell.output) {
                      // Inline output jack (e.g. the attenuverter's per-
                      // channel out at the foot of its input column).
                      return (
                        <div className="input-cell output-cell" key={cell.jack}>
                          <Jack
                            instance={instanceId}
                            id={cell.jack}
                            kind="output"
                            telemetry={telemetry?.[`out:${cell.jack}`]}
                            display={manifest.outputs.find((o) => o.id === cell.jack)?.display}
                            selected={
                              pendingSource?.kind === 'output' &&
                              pendingSource.instance === instanceId &&
                              pendingSource.jack === cell.jack
                            }
                            selectedColor={pendingColor}
                            onClick={(shift) => props.onJackClick?.('output', cell.jack, shift)}
                            showLabel={false}
                          />
                          {!cell.hideLabel && (
                            <span className="input-cell-label">{cell.label ?? cell.jack}</span>
                          )}
                        </div>
                      );
                    }
                    const decl = manifest.inputs.find((i) => i.id === cell.jack);
                    return (
                      <InputCell
                        key={cell.jack}
                        instance={instanceId}
                        cell={cell}
                        manifestKnob={decl?.knob}
                        audio={decl?.audio}
                        display={decl?.display}
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
                        onKnobReset={
                          props.onKnobReset ? () => props.onKnobReset?.(cell.jack) : undefined
                        }
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
          <div
            className={`module-outputs${
              layout.outputGroups.some((g) => g.break) ? ' module-outputs-rows' : ''
            }`}
          >
            {layout.outputGroups.map((group, gi) => (
              <div
                key={group.title ?? gi}
                className="output-group"
                style={group.indent ? { paddingLeft: group.indent } : undefined}
              >
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
                      display={manifest.outputs.find((o) => o.id === id)?.display}
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
