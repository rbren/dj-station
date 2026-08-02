// dj-station M0 shell: loads the demo patch into the engine (when running
// under Tauri) and renders manifest-driven panels with live jack telemetry.

import { useCallback, useEffect, useMemo, useState } from 'react';
import AdsrUI from '../../extensions/adsr/ui-src/AdsrUI';
import { engine, type NodeSnapshot } from './engine';
import { ModulePanel } from './components/ModulePanel';
import type { JackTelemetry, KnobConfig, ModuleHandle } from './types';

export default function App() {
  const [nodes, setNodes] = useState<NodeSnapshot[]>([]);
  const [telemetry, setTelemetry] = useState<Record<string, Record<string, JackTelemetry>>>({});
  const [connected, setConnected] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    const snapshot = await engine.nodes();
    setConnected(snapshot !== null);
    if (snapshot) setNodes(snapshot);
  }, []);

  useEffect(() => {
    (async () => {
      await engine.loadDemoPatch();
      await engine.start();
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

  const makeHandle = useCallback(
    (node: NodeSnapshot): ModuleHandle => ({
      paramValue: (id) => {
        const p = node.manifest.params.find((p) => p.id === id);
        return typeof p?.default === 'number' ? p.default : 0;
      },
      setParam: (id, v) => void engine.setParam(node.instance_id, id, v),
      signalTap: (jackId) =>
        telemetry[node.instance_id]?.[jackId] ?? {
          instantaneous: 0,
          rms_100ms: 0,
          display: 0,
          is_fast: false,
        },
      size: { w: 360, h: 200 },
    }),
    [telemetry],
  );

  const handles = useMemo(
    () => new Map(nodes.map((n) => [n.instance_id, makeHandle(n)])),
    [nodes, makeHandle],
  );

  return (
    <main className="app">
      <header className="app-header">
        <h1>dj-station</h1>
        <span className="engine-status" data-testid="engine-status">
          {connected === null ? 'connecting…' : connected ? 'engine connected' : 'no engine (dev)'}
        </span>
      </header>
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
            onKnobPosition={(jack, position) => {
              void engine.setKnobPosition(node.instance_id, jack, position).then(refresh);
            }}
            onKnobConfig={(jack, config: KnobConfig) => {
              void engine.setKnobConfig(node.instance_id, jack, config).then(refresh);
            }}
            onAttenOffset={(jack, atten, offset) => {
              void engine.setAttenOffset(node.instance_id, jack, atten, offset).then(refresh);
            }}
          />
        ))}
        {nodes.length === 0 && (
          <p className="rack-empty">
            No engine connection — run via <code>./run.sh</code> (Tauri) to see the live rack.
          </p>
        )}
      </div>
    </main>
  );
}
