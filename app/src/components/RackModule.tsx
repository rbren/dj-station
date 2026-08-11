// One rack slot: subscribes to its own node snapshot, position, selection
// and telemetry slice from the rack store, so a telemetry tick or a knob
// drag re-renders only the panels whose slice actually changed — not the
// whole rack. Wrapped in React.memo with stable callback props from App.

import { memo, useContext, useMemo, type ComponentType } from 'react';
import AdsrUI from '../../../extensions/adsr/ui-src/AdsrUI';
import CameraUI from '../../../extensions/camera/ui-src/CameraUI';
import EuclidUI from '../../../extensions/euclid/ui-src/EuclidUI';
import LfoUI from '../../../extensions/lfo/ui-src/LfoUI';
import QuantizerUI from '../../../extensions/quantizer/ui-src/QuantizerUI';
import ScopeUI from '../../../extensions/scope/ui-src/ScopeUI';
import SeqSwitchUI from '../../../extensions/seq_switch/ui-src/SeqSwitchUI';
import StepSeqUI from '../../../extensions/step_seq/ui-src/StepSeqUI';
import TrigSeqUI from '../../../extensions/trig_seq/ui-src/TrigSeqUI';
import TuringUI from '../../../extensions/turing/ui-src/TuringUI';
import WaveshaperUI from '../../../extensions/waveshaper/ui-src/WaveshaperUI';
import { engine, type NodeSnapshot } from '../engine';
import { defaultPosition, panelStyle } from '../rackLayout';
import { RackStoreContext, useRackSelector } from '../rackStore';
import type { JackTelemetry, KnobConfig, ModuleHandle } from '../types';
import { DeckCustomUI } from './DeckPanel';
import { ErrorBoundary } from './ErrorBoundary';
import { GesturePanel } from './GesturePanel';
import { CompressorUI, FilterUI, MixerUI, VcaDualUI, VcaUI } from './LevelMeter';
import { MidiPanel } from './MidiPanel';
import { ModulePanel } from './ModulePanel';
import { mapPosition, positionForValue } from './Knob';

/** Module types with a host-registered custom UI (PRD §5.3). */
const CUSTOM_UIS: Record<string, ComponentType<{ handle: ModuleHandle; instanceId?: string }>> = {
  'com.dj.adsr': AdsrUI,
  'com.dj.camera': CameraUI,
  'com.dj.compressor': CompressorUI,
  'com.dj.euclid': EuclidUI,
  'com.dj.filter': FilterUI,
  'com.dj.lfo': LfoUI,
  'com.dj.mixer': MixerUI,
  'com.dj.quantizer': QuantizerUI,
  'com.dj.scope': ScopeUI,
  'com.dj.seq_switch': SeqSwitchUI,
  'com.dj.step_seq': StepSeqUI,
  'com.dj.trig_seq': TrigSeqUI,
  'com.dj.turing': TuringUI,
  'com.dj.vca': VcaUI,
  'com.dj.vca_dual': VcaDualUI,
  'com.dj.waveshaper': WaveshaperUI,
  'builtin.deck': DeckCustomUI,
};

export interface RackModuleProps {
  instanceId: string;
  /** Index in the nodes list, for the default-position fallback. */
  index: number;
  refresh(): Promise<void>;
  moveModule(instance: string, x: number, y: number): void;
  /** Header drag released — finalizes any provisional neighbour bump. */
  endModuleDrag?(instance: string): void;
  /** Rack scale factor, forwarded so drags convert px to rack coords. */
  zoom?: number;
  removeModule(instance: string): Promise<void>;
  toggleSelected(instance: string): void;
  onJackClick(
    instance: string,
    kind: 'input' | 'output',
    jack: string,
    shift?: boolean,
  ): Promise<void>;
  /** Right-click anywhere on the panel opens the module context menu. */
  onContextMenu?(instance: string, e: React.MouseEvent): void;
}

export const RackModule = memo(function RackModule(props: RackModuleProps) {
  const { instanceId, index, refresh, moveModule, removeModule, toggleSelected, onJackClick } =
    props;
  const store = useContext(RackStoreContext);
  if (!store) throw new Error('RackModule outside RackStoreContext');
  const node = useRackSelector((s) => s.nodes.find((n) => n.instance_id === instanceId));
  const position = useRackSelector((s) => s.positions[instanceId]);
  const selected = useRackSelector((s) => s.selected.includes(instanceId));
  const pending = useRackSelector((s) => s.pending);
  const telemetry = useRackSelector((s) => s.telemetry[instanceId]);

  // Handle identity follows the node snapshot, not the telemetry tick:
  // signalTap reads the live slice from the store on demand.
  const handle = useMemo<ModuleHandle | null>(() => {
    if (!node) return null;
    return makeHandle(node, refresh, () => store.getState().telemetry[instanceId]);
  }, [node, refresh, store, instanceId]);

  if (!node || !handle) return null;
  const pos = position ?? defaultPosition(index);

  return (
    <ErrorBoundary
      context={`module ${instanceId}`}
      fallback={(message, retry) => (
        <div
          className="module-panel module-panel-placed module-panel-error"
          data-testid={`module-error-${instanceId}`}
          style={panelStyle(pos)}
        >
          <strong>{instanceId}</strong>
          <code className="error-card-message">{message}</code>
          <div className="module-error-actions">
            <button onClick={retry}>Retry</button>
            <button onClick={() => void removeModule(instanceId)}>Remove</button>
          </div>
        </div>
      )}
    >
      <ModulePanel
        instanceId={instanceId}
        manifest={node.manifest}
        knobs={node.knobs}
        wired={Object.fromEntries(node.wired_inputs.map((j) => [j, true]))}
        telemetry={telemetry}
        handle={handle}
        customUI={CUSTOM_UIS[node.type_id]}
        extra={
          node.type_id === 'builtin.midi' ? (
            <MidiPanel
              instance={instanceId}
              mappings={node.midi_mappings}
              onAdd={(kind, num, name) =>
                void engine.addMidiMapping(instanceId, kind, num, name).then(refresh)
              }
              onRemove={(name) => void engine.removeMidiMapping(instanceId, name).then(refresh)}
              ledMappings={node.midi_led_mappings}
              onAddLed={(kind, num, name) =>
                void engine.addMidiLedMapping(instanceId, kind, num, name).then(refresh)
              }
              onRemoveLed={(name) =>
                void engine.removeMidiLedMapping(instanceId, name).then(refresh)
              }
              onMidi={(data) => void engine.injectMidi(instanceId, 0, data)}
            />
          ) : node.type_id === 'builtin.gesture' ? (
            <GesturePanel
              instance={instanceId}
              api={{
                status: (i) => engine.gestureStatus(i),
                setMode: (i, m) => engine.gestureSetMode(i, m),
                addMapping: (i, n, m, c) => engine.gestureAddMapping(i, n, m, c),
                removeMapping: (i, n) => engine.gestureRemoveMapping(i, n),
                learnBegin: (i) => engine.gestureLearnBegin(i),
                learnPoll: (i, n) => engine.gestureLearnPoll(i, n),
                feedStart: (i, src) => engine.gestureFeedStart(i, src),
                feedStop: (i) => engine.gestureFeedStop(i),
              }}
              onChanged={() => void refresh()}
            />
          ) : undefined
        }
        position={pos}
        onMove={(x, y) => moveModule(instanceId, x, y)}
        onMoveEnd={() => props.endModuleDrag?.(instanceId)}
        zoom={props.zoom}
        onRemove={() => void removeModule(instanceId)}
        onContextMenu={(e) => props.onContextMenu?.(instanceId, e)}
        onEditEnd={() => void engine.endEdit()}
        selected={selected}
        onSelectToggle={() => toggleSelected(instanceId)}
        pendingSource={pending}
        onJackClick={(kind, jack, shift) => void onJackClick(instanceId, kind, jack, shift)}
        onKnobPosition={(jack, position) => {
          void engine.setKnobPosition(instanceId, jack, position).then(refresh);
        }}
        onKnobConfig={(jack, config: KnobConfig) => {
          void engine.setKnobConfig(instanceId, jack, config).then(refresh);
        }}
        onAttenOffset={(jack, atten, offset) => {
          void engine.setAttenOffset(instanceId, jack, atten, offset).then(refresh);
        }}
        onKnobReset={(jack) => {
          void engine.resetKnob(instanceId, jack).then(refresh);
        }}
      />
    </ErrorBoundary>
  );
});

/** Custom UIs address inputs and params uniformly through the handle;
 *  input ids resolve to their knob (mapped through the knob config). */
function makeHandle(
  node: NodeSnapshot,
  refresh: () => Promise<void>,
  liveTelemetry: () => Record<string, JackTelemetry> | undefined,
): ModuleHandle {
  const inputKnobConfig = (id: string): KnobConfig | null => {
    const input = node.manifest.inputs.find((i) => i.id === id);
    if (!input) return null;
    return (
      node.knobs[id]?.config ??
      input.knob ?? { style: 'continuous', min: 0, max: 10, curve: 'linear' }
    );
  };
  return {
    paramValue: (id) => {
      const cfg = inputKnobConfig(id);
      if (cfg) return mapPosition(cfg, node.knobs[id]?.position ?? 0);
      const live = node.params[id];
      if (typeof live === 'number') return live;
      const p = node.manifest.params.find((p) => p.id === id);
      return typeof p?.default === 'number' ? p.default : 0;
    },
    setParam: (id, v) => {
      const cfg = inputKnobConfig(id);
      if (cfg) {
        void engine.setKnobPosition(node.instance_id, id, positionForValue(cfg, v)).then(refresh);
      } else {
        void engine.setParam(node.instance_id, id, v).then(refresh);
      }
    },
    signalTap: (jackId) =>
      liveTelemetry()?.[jackId] ?? {
        instantaneous: 0,
        rms_100ms: 0,
        display: 0,
        volatility: 0,
        is_fast: false,
      },
    endEdit: () => void engine.endEdit(),
    size: { w: 360, h: 200 },
  };
}
