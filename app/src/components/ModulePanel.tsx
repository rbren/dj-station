// Manifest-driven auto-generated module panel (PRD §7.1): every input is a
// jack + knob; when the jack is wired the knob becomes attenuverter+offset.
// Extensions with a custom UI render it alongside the generated controls.

import type { ComponentType } from 'react';
import type { JackTelemetry, KnobConfig, KnobState, Manifest, ModuleHandle } from '../types';
import { Jack } from './Jack';
import { Knob } from './Knob';

export interface ModulePanelProps {
  instanceId: string;
  manifest: Manifest;
  knobs: Record<string, KnobState>;
  wired: Record<string, boolean>;
  telemetry?: Record<string, JackTelemetry>;
  handle: ModuleHandle;
  customUI?: ComponentType<{ handle: ModuleHandle }>;
  onKnobPosition(jackId: string, position: number): void;
  onKnobConfig(jackId: string, config: KnobConfig): void;
  onAttenOffset(jackId: string, atten: number, offset: number): void;
}

const DEFAULT_KNOB: KnobConfig = { style: 'continuous', min: 0, max: 10, curve: 'linear' };

export function ModulePanel(props: ModulePanelProps) {
  const { manifest, instanceId, knobs, wired, telemetry } = props;
  const CustomUI = props.customUI;
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
      <div className="module-inputs">
        {manifest.inputs.map((input) => {
          const state = knobs[input.id];
          const config = state?.config ?? input.knob ?? DEFAULT_KNOB;
          const isWired = wired[input.id] ?? false;
          return (
            <div className="module-row" key={input.id}>
              <Jack id={input.id} kind="input" telemetry={telemetry?.[input.id]} />
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
            id={output.id}
            kind="output"
            telemetry={telemetry?.[`out:${output.id}`]}
          />
        ))}
      </div>
    </div>
  );
}
