// One input as a tight vertical cell: wire jack on top, control (knob /
// fader / toggle) directly under it, label at the bottom. Cells are the
// unit that panel layouts (panelLayouts.ts) group into rows, columns and
// grids. The label can be hidden and the control swapped for a fader or
// suppressed entirely ('jack') by the layout.

import { useState } from 'react';
import type { DisplaySpec, JackTelemetry, KnobConfig, KnobState, WireStyle } from '../types';
import type { CellSpec } from './panelLayouts';
import { LiveJack } from './Jack';
import { Knob } from './Knob';
import { KnobConfigMenu } from './KnobConfigMenu';
import { WIRE_COLORS } from './WireOverlay';

const DEFAULT_KNOB: KnobConfig = { style: 'continuous', min: 0, max: 10, curve: 'linear' };

export interface InputCellProps {
  instance: string;
  cell: CellSpec;
  manifestKnob?: KnobConfig | null;
  /** Audio pass-through input: plain jack only — no manual control and no
   *  CV/attenuverter settings (the value only ever arrives by wire). */
  audio?: boolean;
  /** Manifest display spec (unit / mapping / step labels); absent = Volts. */
  display?: DisplaySpec | null;
  state?: KnobState;
  wired: boolean;
  telemetry?: JackTelemetry;
  selected: boolean;
  /** Outline color while armed — the pending wire's cable color. */
  selectedColor?: string;
  /** User-chosen cosmetic color (WIRE_COLORS index; null/undefined = none):
   *  renders a prominent rounded border around the cell. */
  color?: number | null;
  onColor?(color: number | null): void;
  /** User-typed label override (null/undefined = the layout/manifest
   *  default). Edited from the same right-click menu as the color. */
  customLabel?: string | null;
  onLabel?(label: string | null): void;
  onJackClick?(shift: boolean): void;
  onKnobPosition(position: number): void;
  onKnobConfig(config: KnobConfig): void;
  onAttenOffset(atten: number, offset: number): void;
  onWireStyle?(style: WireStyle): void;
  /** Double-click reset to the default value (incl. wire spread). */
  onKnobReset?(): void;
  onEditEnd?(): void;
}

export function InputCell(props: InputCellProps) {
  const { cell, state, wired } = props;
  const config = state?.config ?? props.manifestKnob ?? DEFAULT_KNOB;
  // No knob declared anywhere = plain wire jack: the engine blends the
  // signal additively in value space (knob.rs JackRt::from_state).
  const plain = !state?.config && !props.manifestKnob;
  // Audio jacks carry sound, not a settable signal: jack only.
  const control = props.audio ? 'jack' : (cell.control ?? 'auto');
  const defaultLabel = cell.label ?? cell.jack;
  const label = props.customLabel ?? defaultLabel;
  const appearance = control === 'fader' ? 'fader' : control === 'hfader' ? 'hfader' : undefined;
  const cellColor =
    props.color !== null && props.color !== undefined
      ? WIRE_COLORS[props.color % WIRE_COLORS.length]
      : undefined;
  // Right-click on the cell (jack, label, or a jack-only cell's body)
  // opens a color-only config menu. The knob handles its own right-click
  // (full config menu, which includes the same Color row) and stops
  // propagation, so this never fires on the dial itself.
  const [colorMenuAt, setColorMenuAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <div
      className={`input-cell${appearance ? ` input-cell-${appearance}` : ''}${
        cellColor ? ' input-cell-colored' : ''
      }`}
      data-testid={`input-cell-${cell.jack}`}
      style={cellColor ? { borderColor: cellColor } : undefined}
      onContextMenu={
        props.onColor
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              setColorMenuAt({ x: e.clientX, y: e.clientY });
            }
          : undefined
      }
    >
      <LiveJack
        instance={props.instance}
        id={cell.jack}
        kind="input"
        telemetry={props.telemetry}
        display={props.display}
        knob={config}
        wired={wired}
        selected={props.selected}
        selectedColor={props.selectedColor}
        onClick={props.onJackClick}
        showLabel={false}
      />
      {control !== 'jack' && (
        <Knob
          label={cell.jack}
          config={config}
          display={props.display}
          appearance={appearance}
          position={state?.position ?? 0}
          wired={wired}
          plain={plain}
          atten={state?.atten}
          offset={state?.offset}
          wireStyle={state?.wire_style}
          onPosition={props.onKnobPosition}
          onConfigChange={props.onKnobConfig}
          onAttenOffset={props.onAttenOffset}
          onWireStyle={props.onWireStyle}
          onReset={props.onKnobReset}
          onRelease={props.onEditEnd}
          jackColor={props.color}
          onJackColor={props.onColor}
          jackLabel={props.customLabel}
          jackLabelDefault={defaultLabel}
          onJackLabel={props.onLabel}
        />
      )}
      {colorMenuAt && props.onColor && (
        <KnobConfigMenu
          config={config}
          at={colorMenuAt}
          onChange={() => {}}
          onClose={() => setColorMenuAt(null)}
          colorOnly
          jackColor={props.color}
          onJackColor={props.onColor}
          jackLabel={props.customLabel}
          jackLabelDefault={defaultLabel}
          onJackLabel={props.onLabel}
        />
      )}
      {!cell.hideLabel && (
        <span className="input-cell-label" title={cell.jack}>
          {label}
        </span>
      )}
    </div>
  );
}
