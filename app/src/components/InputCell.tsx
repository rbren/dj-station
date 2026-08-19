// One input as a tight vertical cell: wire jack on top, control (knob /
// fader / toggle) directly under it, label at the bottom. Cells are the
// unit that panel layouts (panelLayouts.ts) group into rows, columns and
// grids. The label can be hidden and the control swapped for a fader or
// suppressed entirely ('jack') by the layout.

import type { DisplaySpec, JackTelemetry, KnobConfig, KnobState, WireStyle } from '../types';
import type { CellSpec } from './panelLayouts';
import { LiveJack } from './Jack';
import { Knob } from './Knob';

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
  const label = cell.label ?? cell.jack;
  const appearance = control === 'fader' ? 'fader' : control === 'hfader' ? 'hfader' : undefined;
  return (
    <div
      className={`input-cell${appearance ? ` input-cell-${appearance}` : ''}`}
      data-testid={`input-cell-${cell.jack}`}
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
