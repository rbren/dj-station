// Manifest-driven auto-generated module panel (PRD §7.1): every input is a
// jack + knob; wiring a jack supersedes its knob (attenuverter/offset live
// in the right-click config menu). Numeric params get their own knobs —
// for modules with a custom UI (e.g. ADSR) both stay in sync through the
// engine's param state. Clicking an output jack then an input jack makes a
// wire; clicking a wired input removes its wire.

import type { ComponentType } from 'react';
import type { JackTelemetry, KnobConfig, KnobState, Manifest, ModuleHandle } from '../types';
import { Jack } from './Jack';
import { Knob } from './Knob';

export interface JackRef {
  instance: string;
  jack: string;
}

export interface ModulePanelProps {
  instanceId: string;
  manifest: Manifest;
  knobs: Record<string, KnobState>;
  wired: Record<string, boolean>;
  telemetry?: Record<string, JackTelemetry>;
  handle: ModuleHandle;
  customUI?: ComponentType<{ handle: ModuleHandle }>;
  /** Output jack currently armed as a pending wire source, if any. */
  pendingSource?: JackRef | null;
  onJackClick?(kind: 'input' | 'output', jackId: string): void;
  onKnobPosition(jackId: string, position: number): void;
  onKnobConfig(jackId: string, config: KnobConfig): void;
  onAttenOffset(jackId: string, atten: number, offset: number): void;
  onParam?(paramId: string, value: number): void;
}

const DEFAULT_KNOB: KnobConfig = { style: 'continuous', min: 0, max: 10, curve: 'linear' };

export function ModulePanel(props: ModulePanelProps) {
  const { manifest, instanceId, knobs, wired, telemetry, pendingSource } = props;
  const CustomUI = props.customUI;
  const numericParams = manifest.params.filter((p) => typeof (p.default ?? 0) === 'number');
  return (
    <div className="module-panel" data-testid={`module-${instanceId}`}>
      <header className="module-title">
        {manifest.name}
        <span className="module-instance">{instanceId}</span>
      </header>
      {CustomUI && (
        <div className="module-custom-ui">
          <CustomUI handle={props.handle} />
        </div>
      )}
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
                />
                <span className="param-name">{p.id}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="module-inputs">
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
                selected={false}
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
            selected={pendingSource?.instance === instanceId && pendingSource?.jack === output.id}
            onClick={() => props.onJackClick?.('output', output.id)}
          />
        ))}
      </div>
    </div>
  );
}
