// One rack slot: subscribes to its own node snapshot, position and
// selection from the rack store, so a knob drag or structural edit
// re-renders only the panels whose slice actually changed — not the whole
// rack. Telemetry stays OUT of this component: jacks and custom UIs
// subscribe to their own readings (LiveJack / CustomUIHost). Wrapped in
// React.memo with stable callback props from App.

import { memo, useContext, useMemo } from 'react';
import { engine, type NodeSnapshot } from '../engine';
import { defaultPosition, panelStyle } from '../rackLayout';
import { RackStoreContext, useRackSelector } from '../rackStore';
import type { JackTelemetry, KnobConfig, ModuleHandle } from '../types';
import { ChoreoPanel } from './ChoreoPanel';
import { CUSTOM_UIS } from './customUIs';
import { ErrorBoundary } from './ErrorBoundary';
import { MidiPanel } from './MidiPanel';
import { ModulePanel } from './ModulePanel';
import { QwertyPanel } from './QwertyPanel';
import { mapPosition, positionForValue } from './Knob';

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
  /** Rename: normalized backend id may differ from the typed name; App
   *  remaps positions/selection to the returned id. */
  renameModule(instance: string, name: string): Promise<void>;
  /** Open the documentation panel for this module (? in the title bar). */
  openDocs?(instance: string): void;
  /** Click-to-select: `additive` toggles membership (shift/cmd/ctrl-click),
   *  otherwise the selection is replaced by this one module. */
  selectModule(instance: string, additive: boolean): void;
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
  const { instanceId, index, refresh, moveModule, removeModule, selectModule, onJackClick } = props;
  const store = useContext(RackStoreContext);
  if (!store) throw new Error('RackModule outside RackStoreContext');
  const node = useRackSelector((s) => s.nodes.find((n) => n.instance_id === instanceId));
  const position = useRackSelector((s) => s.positions[instanceId]);
  const selected = useRackSelector((s) => s.selected.includes(instanceId));
  const pending = useRackSelector((s) => s.pending);
  // Whole record (stable identity, changes only on an explicit user pick);
  // narrowed to this instance's jacks below.
  const allInputColors = useRackSelector((s) => s.inputColors);
  const allInputLabels = useRackSelector((s) => s.inputLabels);
  // Deliberately NOT subscribed to telemetry: jack glows subscribe per jack
  // (LiveJack) and custom UIs per instance (CustomUIHost), so a telemetry
  // tick never re-renders whole panels — the difference between 22 fps and
  // 60 fps on a two-dozen-module rack (see src/stress/).

  // Handle identity follows the node snapshot, not the telemetry tick:
  // signalTap reads the live slice from the store on demand.
  const handle = useMemo<ModuleHandle | null>(() => {
    if (!node) return null;
    return makeHandle(node, refresh, () => store.getState().telemetry[instanceId]);
  }, [node, refresh, store, instanceId]);

  const inputColors = useMemo(() => {
    const prefix = `${instanceId}:`;
    const out: Record<string, number> = {};
    for (const [key, color] of Object.entries(allInputColors)) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = color;
    }
    return out;
  }, [allInputColors, instanceId]);

  const inputLabels = useMemo(() => {
    const prefix = `${instanceId}:`;
    const out: Record<string, string> = {};
    for (const [key, label] of Object.entries(allInputLabels)) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = label;
    }
    return out;
  }, [allInputLabels, instanceId]);

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
        displayName={node.display_name}
        manifest={node.manifest}
        knobs={node.knobs}
        wired={Object.fromEntries(node.wired_inputs.map((j) => [j, true]))}
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
          ) : node.type_id === 'builtin.qwerty' ? (
            <QwertyPanel
              instance={instanceId}
              onKey={(key, down) => void engine.qwertyKey(instanceId, key, down)}
            />
          ) : node.type_id === 'builtin.choreo' ? (
            <ChoreoPanel
              instance={instanceId}
              api={{
                status: (i) => engine.choreoStatus(i),
                setBeats: (i, b) => engine.choreoSetBeats(i, b),
                addTrack: (i, n, k) => engine.choreoAddTrack(i, n, k),
                removeTrack: (i, t) => engine.choreoRemoveTrack(i, t),
                renameTrack: (i, t, n) => engine.choreoRenameTrack(i, t, n),
                moveTrack: (i, f, t) => engine.choreoMoveTrack(i, f, t),
                setBool: (i, t, b, on) => engine.choreoSetBool(i, t, b, on),
                setValues: (i, t, s, v) => engine.choreoSetValues(i, t, s, v),
                setNote: (i, t, b, n) => engine.choreoSetNote(i, t, b, n),
                setNoteSettings: (i, t, o, s, b) => engine.choreoSetNoteSettings(i, t, o, s, b),
                endEdit: () => engine.endEdit(),
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
        onRename={(name) => void props.renameModule(instanceId, name)}
        onDocs={props.openDocs && (() => props.openDocs?.(instanceId))}
        onContextMenu={(e) => props.onContextMenu?.(instanceId, e)}
        onEditEnd={() => void engine.endEdit()}
        selected={selected}
        onSelect={(additive) => selectModule(instanceId, additive)}
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
        onWireStyle={(jack, style) => {
          void engine.setKnobWireStyle(instanceId, jack, style).then(refresh);
        }}
        onKnobReset={(jack) => {
          void engine.resetKnob(instanceId, jack).then(refresh);
        }}
        inputColors={inputColors}
        onInputColor={(jack, color) => store.setInputColor(instanceId, jack, color)}
        inputLabels={inputLabels}
        onInputLabel={(jack, label) => store.setInputLabel(instanceId, jack, label)}
      />
    </ErrorBoundary>
  );
});

/** Custom UIs address inputs and params uniformly through the handle;
 *  input ids resolve to their knob (mapped through the knob config). A
 *  WIRED input reads its live post-blend telemetry instead of the knob
 *  baseline, so every visual (EQ curve, ADSR envelope, LFO preview...)
 *  follows the modulation the wire applies, just like the DSP does. */
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
  const wired = new Set(node.wired_inputs);
  return {
    paramValue: (id) => {
      const cfg = inputKnobConfig(id);
      if (cfg) {
        if (wired.has(id)) {
          const t = liveTelemetry()?.[id];
          if (t) return t.display;
        }
        return mapPosition(cfg, node.knobs[id]?.position ?? 0);
      }
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
