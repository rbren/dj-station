// dj-station M0 shell: loads the demo patch into the engine (when running
// under Tauri), renders manifest-driven panels with live jack telemetry,
// a module library sidebar for adding modules, and click-to-wire jacks
// with an SVG cable overlay.

import { useCallback, useEffect, useMemo, useState } from 'react';
import AdsrUI from '../../extensions/adsr/ui-src/AdsrUI';
import { engine, type NodeSnapshot, type WireSnapshot } from './engine';
import { library } from './library';
import { LibraryView } from './components/LibraryView';
import { ModuleLibrary, nextInstanceId } from './components/ModuleLibrary';
import { ModulePanel, type JackRef } from './components/ModulePanel';
import { WireOverlay } from './components/WireOverlay';
import type { JackTelemetry, KnobConfig, Manifest, ModuleHandle } from './types';

export default function App() {
  const [nodes, setNodes] = useState<NodeSnapshot[]>([]);
  const [wires, setWires] = useState<WireSnapshot[]>([]);
  const [moduleLib, setModuleLib] = useState<Manifest[]>([]);
  const [telemetry, setTelemetry] = useState<Record<string, Record<string, JackTelemetry>>>({});
  const [connected, setConnected] = useState<boolean | null>(null);
  const [view, setView] = useState<'rack' | 'library'>('rack');
  const [pending, setPending] = useState<JackRef | null>(null);
  // Callback ref (state, not useRef) so the overlay re-renders once the
  // rack element mounts.
  const [rackEl, setRackEl] = useState<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    const snapshot = await engine.nodes();
    setConnected(snapshot !== null);
    if (snapshot) setNodes(snapshot);
    const wireList = await engine.wires();
    if (wireList) setWires(wireList);
  }, []);

  useEffect(() => {
    (async () => {
      await engine.loadDemoPatch();
      await engine.start();
      const modules = await engine.listModules();
      if (modules) setModuleLib(modules);
      await refresh();
    })();
  }, [refresh]);

  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(async () => {
      const next: Record<string, Record<string, JackTelemetry>> = {};
      for (const node of nodes) {
        next[node.instance_id] = {};
        for (const input of node.manifest.inputs) {
          const t = await engine.tap(node.instance_id, input.id);
          if (t) next[node.instance_id][input.id] = t;
        }
      }
      setTelemetry(next);
    }, 100);
    return () => clearInterval(timer);
  }, [connected, nodes]);

  const addModule = useCallback(
    async (typeId: string) => {
      const taken = new Set(nodes.map((n) => n.instance_id));
      await engine.addModule(nextInstanceId(typeId, taken), typeId);
      await refresh();
    },
    [nodes, refresh],
  );

  const onJackClick = useCallback(
    async (instance: string, kind: 'input' | 'output', jack: string) => {
      if (kind === 'output') {
        setPending((p) =>
          p?.instance === instance && p?.jack === jack ? null : { instance, jack },
        );
        return;
      }
      if (pending) {
        await engine.connectWire(pending, { instance, jack });
        setPending(null);
        await refresh();
        return;
      }
      const existing = wires.find((w) => w.to_instance === instance && w.to_jack === jack);
      if (existing) {
        await engine.disconnectWire(
          { instance: existing.from_instance, jack: existing.from_jack },
          { instance, jack },
        );
        await refresh();
      }
    },
    [pending, wires, refresh],
  );

  const makeHandle = useCallback(
    (node: NodeSnapshot): ModuleHandle => ({
      paramValue: (id) => {
        const live = node.params[id];
        if (typeof live === 'number') return live;
        const p = node.manifest.params.find((p) => p.id === id);
        return typeof p?.default === 'number' ? p.default : 0;
      },
      setParam: (id, v) => {
        void engine.setParam(node.instance_id, id, v).then(refresh);
      },
      signalTap: (jackId) =>
        telemetry[node.instance_id]?.[jackId] ?? {
          instantaneous: 0,
          rms_100ms: 0,
          display: 0,
          is_fast: false,
        },
      size: { w: 360, h: 200 },
    }),
    [telemetry, refresh],
  );

  const handles = useMemo(
    () => new Map(nodes.map((n) => [n.instance_id, makeHandle(n)])),
    [nodes, makeHandle],
  );

  return (
    <main className="app">
      <header className="app-header">
        <h1>dj-station</h1>
        <nav className="app-tabs">
          <button
            className={view === 'rack' ? 'tab active' : 'tab'}
            onClick={() => setView('rack')}
            data-testid="tab-rack"
          >
            Rack
          </button>
          <button
            className={view === 'library' ? 'tab active' : 'tab'}
            onClick={() => setView('library')}
            data-testid="tab-library"
          >
            Library
          </button>
        </nav>
        <span className="engine-status" data-testid="engine-status">
          {connected === null ? 'connecting…' : connected ? 'engine connected' : 'no engine (dev)'}
        </span>
        {pending && (
          <span className="wiring-hint" data-testid="wiring-hint">
            wiring from {pending.instance}:{pending.jack} — click an input jack
          </span>
        )}
      </header>
      {view === 'library' && <LibraryView client={library} />}
      <div className="app-body" style={view === 'rack' ? undefined : { display: 'none' }}>
        <ModuleLibrary modules={moduleLib} onAdd={(typeId) => void addModule(typeId)} />
        <div className="rack-area" ref={setRackEl}>
          <div className="rack">
            {nodes.map((node) => (
              <ModulePanel
                key={node.instance_id}
                instanceId={node.instance_id}
                manifest={node.manifest}
                knobs={node.knobs}
                wired={Object.fromEntries(node.wired_inputs.map((j) => [j, true]))}
                telemetry={telemetry[node.instance_id]}
                handle={handles.get(node.instance_id)!}
                customUI={node.type_id === 'com.dj.adsr' ? AdsrUI : undefined}
                pendingSource={pending}
                onJackClick={(kind, jack) => void onJackClick(node.instance_id, kind, jack)}
                onKnobPosition={(jack, position) => {
                  void engine.setKnobPosition(node.instance_id, jack, position).then(refresh);
                }}
                onKnobConfig={(jack, config: KnobConfig) => {
                  void engine.setKnobConfig(node.instance_id, jack, config).then(refresh);
                }}
                onAttenOffset={(jack, atten, offset) => {
                  void engine.setAttenOffset(node.instance_id, jack, atten, offset).then(refresh);
                }}
                onParam={(param, value) => {
                  void engine.setParam(node.instance_id, param, value).then(refresh);
                }}
              />
            ))}
            {nodes.length === 0 && (
              <p className="rack-empty">
                No engine connection — run via <code>./run.sh</code> (Tauri) to see the live rack.
              </p>
            )}
          </div>
          <WireOverlay wires={wires} container={rackEl} />
        </div>
      </div>
    </main>
  );
}
