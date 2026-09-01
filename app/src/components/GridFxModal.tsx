// A Grid track's effects rack, in a modal over the arrangement.
//
// The rack IS the rack: the panels are the app's own `ModulePanel`s,
// drawn from the engine's manifests, the cables are drawn by the same
// `WireOverlay` the Rack page uses, and patching follows the same
// grammar (click an output, click an input; shift+click unplugs; a click
// on a wired input picks the cable up). What is different is only where
// the state lives — in the grid document, on the row, as `TrackFx`
// (`gridFx.ts`) — because a Grid track's rack belongs to THIS track in
// THIS grid, not to the patch.
//
// The panels are therefore INERT: they render against the picker's
// preview handle (knob values resolved from the rack's own state, taps
// reading silence) rather than against a live node, since the Grid plays
// its clips in the webview and there is no engine graph behind these
// modules to poll. Knob CONFIG and CV spread are deliberately not
// persisted here for the same reason — a track rack stores the values
// its knobs are turned to, nothing else.
//
// The CHROME above the rack is the track itself: the grid's clock, the
// track's audio out (L/R — mono is just L) and the way back in, plus the
// three controls that need no DSP to mean something — Level (the row's
// baseline gain, which its level automation is read against), Pan, and
// Wetness.

import { useEffect, useMemo, useState } from 'react';
import { engine } from '../engine';
import { fixed } from '../format';
import {
  addFxModule,
  clampFxLevel,
  clampFxPan,
  clampFxWet,
  fxJackClick,
  fxJackWired,
  fxValue,
  FX_CHROME,
  FX_CHROME_INPUTS,
  FX_CHROME_OUTPUTS,
  FX_LEVEL_MAX,
  moveFxModule,
  removeFxModule,
  setFxValue,
  type FxModule,
  type FxPending,
  type TrackFx,
} from '../gridFx';
import type { KnobConfig, Manifest, ModuleHandle } from '../types';
import { previewUI } from './customUIs';
import { Jack } from './Jack';
import { Knob, mapPosition, positionForValue } from './Knob';
import { ModulePanel } from './ModulePanel';
import { ModulePicker, previewHandle, previewKnobs } from './ModulePicker';
import { WireOverlay } from './WireOverlay';

const LEVEL_KNOB: KnobConfig = { style: 'continuous', min: 0, max: FX_LEVEL_MAX, curve: 'linear' };
const PAN_KNOB: KnobConfig = { style: 'continuous', min: -1, max: 1, curve: 'linear' };
const WET_KNOB: KnobConfig = { style: 'continuous', min: 0, max: 1, curve: 'linear' };

/** Where a module dropped from the picker lands: below the rack's own
 *  panels, on the coarse placement grid. */
const DROP_X = 0;
const DROP_STEP = 288;

export interface GridFxModalProps {
  /** What the rack belongs to, said in the title. */
  title: string;
  fx: TrackFx;
  /** The grid's tempo, which is what the chrome's clock jack runs at. */
  bpm: number;
  /** Module manifests; omitted, they are read from the engine (absent
   *  outside Tauri, where the rack simply has no panels to draw). */
  modules?: Manifest[];
  /** `gesture` names a continuous edit (a knob drag) so the Grid page can
   *  coalesce it into one undo step. */
  onChange(next: TrackFx, gesture?: string): void;
  /** End of such a gesture. */
  onEditEnd?(): void;
  onClose(): void;
}

export function GridFxModal({
  title,
  fx,
  bpm,
  modules,
  onChange,
  onEditEnd,
  onClose,
}: GridFxModalProps) {
  const [pending, setPending] = useState<FxPending | null>(null);
  const [picking, setPicking] = useState(false);
  const [fetched, setFetched] = useState<Manifest[]>([]);
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (modules) return;
    let live = true;
    void engine.listModules().then((list) => {
      if (live && list) setFetched(list);
    });
    return () => {
      live = false;
    };
  }, [modules]);

  const manifests = modules ?? fetched;
  const byType = useMemo(() => new Map(manifests.map((m) => [m.id, m] as const)), [manifests]);

  // Escape drops an armed cable first, then closes: the modal is not
  // what a half-made wire wants taken away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pending) setPending(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, onClose]);

  const jackClick = (instance: string, kind: 'input' | 'output', jack: string, shift = false) => {
    const next = fxJackClick(fx, pending, { instance, jack, kind, shift });
    setPending(next.pending);
    if (next.fx !== fx) onChange(next.fx);
  };

  const armed = (instance: string, jack: string, kind: 'input' | 'output') =>
    pending?.instance === instance && pending.jack === jack && pending.kind === kind;

  const chromeJack = (id: string, name: string, kind: 'input' | 'output') => (
    <Jack
      key={id}
      instance={FX_CHROME}
      id={id}
      kind={kind}
      label={name}
      wired={fxJackWired(fx, FX_CHROME, id)}
      selected={armed(FX_CHROME, id, kind)}
      onClick={(shift) => jackClick(FX_CHROME, kind, id, shift)}
    />
  );

  const chromeKnob = (
    label: string,
    key: 'level' | 'pan' | 'wet',
    config: KnobConfig,
    unit: string,
    clamp: (v: number) => number,
  ) => (
    // The Knob is the dial alone (a module panel's InputCell is what
    // usually names it), so the chrome writes the label itself.
    <div className="grid-fx-knob" key={key}>
      <Knob
        label={label}
        config={config}
        display={{ unit }}
        position={positionForValue(config, fx[key])}
        onPosition={(position) =>
          onChange({ ...fx, [key]: clamp(mapPosition(config, position)) }, `fx-${key}`)
        }
        onRelease={onEditEnd}
      />
      <span className="grid-fx-knob-label">{label}</span>
    </div>
  );

  return (
    <div
      className="file-dialog-backdrop"
      data-testid="grid-fx-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Not `.file-dialog`: that recipe styles every button beneath it,
          and the panels in here bring their own. */}
      <div className="grid-fx" role="dialog" aria-label={`Effects for ${title}`}>
        <div className="grid-fx-head">
          <h3>Effects — {title}</h3>
          <button
            className="grid-fx-btn"
            data-testid="grid-fx-add"
            onClick={() => setPicking(true)}
          >
            + Module
          </button>
          <button className="grid-fx-btn" data-testid="grid-fx-close" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="grid-fx-body" ref={setBodyEl}>
          <div className="grid-fx-chrome">
            <div className="grid-fx-port">
              <span className="grid-fx-legend">Track → rack</span>
              <div className="grid-fx-jacks">
                {FX_CHROME_OUTPUTS.map((j) => chromeJack(j.id, j.name, 'output'))}
              </div>
              <span className="grid-fx-clock mono" data-testid="grid-fx-clock">
                {fixed(bpm, 0)} bpm
              </span>
            </div>
            <div className="grid-fx-port">
              <span className="grid-fx-legend">Rack → track</span>
              <div className="grid-fx-jacks">
                {FX_CHROME_INPUTS.map((j) => chromeJack(j.id, j.name, 'input'))}
              </div>
            </div>
            <div className="grid-fx-knobs">
              {chromeKnob('Level', 'level', LEVEL_KNOB, 'x', clampFxLevel)}
              {chromeKnob('Pan', 'pan', PAN_KNOB, '', clampFxPan)}
              {chromeKnob('Wet', 'wet', WET_KNOB, '', clampFxWet)}
            </div>
          </div>

          <div className="grid-fx-rack" data-testid="grid-fx-rack">
            {fx.modules.map((m) => {
              const manifest = byType.get(m.type);
              if (!manifest) {
                // No manifest (the engine is not there, or the module has
                // been uninstalled): the rack still HOLDS it — say so,
                // rather than quietly dropping what the user patched.
                return (
                  <div
                    className="grid-fx-missing"
                    key={m.id}
                    data-testid={`grid-fx-missing-${m.id}`}
                  >
                    {m.id} · {m.type}
                  </div>
                );
              }
              return (
                <FxPanel
                  key={m.id}
                  module={m}
                  manifest={manifest}
                  fx={fx}
                  pending={pending}
                  onChange={onChange}
                  onEditEnd={onEditEnd}
                  onJackClick={(kind, jack, shift) => jackClick(m.id, kind, jack, shift)}
                />
              );
            })}
          </div>

          <WireOverlay
            wires={fx.wires}
            container={bodyEl}
            pending={pending ? { ...pending, color: 0 } : null}
            layoutKey={fx.modules.map((m) => `${m.id}@${m.x},${m.y}`).join('|')}
          />
        </div>
      </div>

      {picking && (
        <ModulePicker
          modules={manifests}
          onAdd={(typeId) => {
            const y = fx.modules.length * DROP_STEP;
            onChange(addFxModule(fx, typeId, DROP_X, y));
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

/** One module of the rack, drawn as the app's own panel. */
function FxPanel({
  module: m,
  manifest,
  fx,
  pending,
  onChange,
  onEditEnd,
  onJackClick,
}: {
  module: FxModule;
  manifest: Manifest;
  fx: TrackFx;
  pending: FxPending | null;
  onChange(next: TrackFx, gesture?: string): void;
  onEditEnd?(): void;
  onJackClick(kind: 'input' | 'output', jack: string, shift?: boolean): void;
}) {
  const knobs = useMemo(() => {
    const base = previewKnobs(manifest);
    for (const [jack, value] of Object.entries(m.values)) {
      const config = base[jack]?.config ?? manifest.inputs.find((i) => i.id === jack)?.knob;
      if (!config) continue;
      base[jack] = { position: positionForValue(config, value), atten: 0, offset: 0, config };
    }
    return base;
  }, [manifest, m.values]);

  const handle: ModuleHandle = useMemo(() => {
    const base = previewHandle(manifest);
    return { ...base, paramValue: (id) => fxValue(m, id, base.paramValue(id)) };
  }, [manifest, m]);

  const wired = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const input of manifest.inputs) out[input.id] = fxJackWired(fx, m.id, input.id);
    return out;
  }, [manifest, fx, m.id]);

  const noop = () => {};

  return (
    <ModulePanel
      instanceId={m.id}
      manifest={manifest}
      knobs={knobs}
      wired={wired}
      handle={handle}
      customUI={previewUI(manifest.id)}
      position={{ x: m.x, y: m.y }}
      onMove={(x, y) => onChange(moveFxModule(fx, m.id, x, y), `fx-move-${m.id}`)}
      onMoveEnd={onEditEnd}
      onRemove={() => onChange(removeFxModule(fx, m.id))}
      onJackClick={onJackClick}
      onKnobPosition={(jack, position) => {
        const config = knobs[jack]?.config ?? manifest.inputs.find((i) => i.id === jack)?.knob;
        if (!config) return;
        const decl = manifest.inputs.find((i) => i.id === jack);
        onChange(
          setFxValue(fx, m.id, jack, mapPosition(config, position), decl?.default),
          `fx-knob-${m.id}-${jack}`,
        );
      }}
      onKnobConfig={noop}
      onAttenOffset={noop}
      onEditEnd={onEditEnd}
      pendingSource={
        pending?.instance === m.id
          ? { instance: pending.instance, jack: pending.jack, kind: pending.kind, color: 0 }
          : null
      }
    />
  );
}
