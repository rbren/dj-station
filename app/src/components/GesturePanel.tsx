// Custom panel body for the built-in Gesture Control module (M5, PRD §7.3):
// a video-feed area with a live detection overlay (wheel zones or labeled
// hand landmarks rendered as SVG from detection data — no real camera is
// needed, so the same overlay works headless over the mock fixture feed and
// will sit on top of the AVFoundation camera frames on macOS later), a mode
// selector, a learn-mapping flow, and the mapping list. Every mapping is an
// output jack on the module, wireable into anything.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GestureStatus } from '../engine';

/** IPC surface the panel needs; App adapts EngineClient onto this. */
export interface GestureApi {
  status(instance: string): Promise<GestureStatus | null>;
  setMode(instance: string, mode: string): Promise<unknown>;
  addMapping(
    instance: string,
    name: string,
    mode: string,
    config: Record<string, unknown>,
  ): Promise<unknown>;
  removeMapping(instance: string, name: string): Promise<unknown>;
  learnBegin(instance: string): Promise<unknown>;
  learnPoll(instance: string, name: string): Promise<boolean | null>;
  feedStart(instance: string, source: string): Promise<unknown>;
  feedStop(instance: string): Promise<unknown>;
}

export interface GesturePanelProps {
  instance: string;
  api: GestureApi;
  /** Called after any config edit so the rack refreshes jacks. */
  onChanged(): void;
  /** Overlay poll interval in ms (tests dial it down). */
  pollMs?: number;
}

/** Fixture sources for the mock feed (macOS camera slots in later). */
const FEED_SOURCES = ['demo', 'pinch', 'wheel_tour'];

const VIEW_W = 320;
const VIEW_H = 240;

/** Landmark tips get labels; other points are plain dots. */
const LABELED = new Map<number, string>([
  [0, 'wrist'],
  [4, 'thumb.tip'],
  [8, 'index.tip'],
  [12, 'middle.tip'],
  [16, 'ring.tip'],
  [20, 'pinky.tip'],
]);

function describeConfig(mode: string, config: Record<string, unknown>): string {
  if (mode === 'wheel') return `wheel ${config.wheel} zone ${config.zone}`;
  if (mode === 'landmark') {
    if (config.type === 'presence') return `presence ${config.point}`;
    if (config.type === 'distance') return `dist ${config.a} \u2194 ${config.b}`;
  }
  return mode;
}

function zoneWedgePath(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  zone: number,
): string {
  // Zones 1..8 are radial sections; angles follow WheelLayout::zone_of
  // (zone k spans [(k-1), k) * 45deg from the +x axis).
  const a0 = ((zone - 1) * Math.PI) / 4;
  const a1 = (zone * Math.PI) / 4;
  const p = (r: number, a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
  return [
    `M ${p(rInner, a0)}`,
    `L ${p(rOuter, a0)}`,
    `A ${rOuter} ${rOuter} 0 0 1 ${p(rOuter, a1)}`,
    `L ${p(rInner, a1)}`,
    `A ${rInner} ${rInner} 0 0 0 ${p(rInner, a0)}`,
    'Z',
  ].join(' ');
}

export function GesturePanel({ instance, api, onChanged, pollMs = 100 }: GesturePanelProps) {
  const [status, setStatus] = useState<GestureStatus | null>(null);
  const [source, setSource] = useState('demo');
  const [learnName, setLearnName] = useState('');
  const [learning, setLearning] = useState(false);
  const learningRef = useRef(false);

  const refresh = useCallback(async () => {
    const s = await api.status(instance);
    if (s) setStatus(s);
  }, [api, instance]);

  // Overlay poll: detection data + values arrive with the status. First
  // poll on a timeout (keeps setState out of the effect body per
  // react-hooks/set-state-in-effect), then interval.
  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), pollMs);
    return () => {
      clearTimeout(initial);
      clearInterval(t);
    };
  }, [refresh, pollMs]);

  // Learn poll: while armed, ask whether the mode captured a mapping.
  useEffect(() => {
    learningRef.current = learning;
    if (!learning) return;
    const name = learnName;
    const t = setInterval(() => {
      void api.learnPoll(instance, name).then((captured) => {
        if (captured && learningRef.current) {
          setLearning(false);
          setLearnName('');
          onChanged();
          void refresh();
        }
      });
    }, pollMs);
    return () => clearInterval(t);
  }, [learning, learnName, api, instance, onChanged, refresh, pollMs]);

  const beginLearn = () => {
    if (!learnName.trim()) return;
    void api.learnBegin(instance).then(() => setLearning(true));
  };

  const mappedZones = new Set(
    (status?.mappings ?? [])
      .filter((m) => m.mode === 'wheel')
      .map((m) => `${m.config.wheel}:${m.config.zone}`),
  );
  const activeZones = new Set((status?.active_zones ?? []).map(([w, z]) => `${w}:${z}`));

  return (
    <div className="gesture-panel" data-testid={`gesture-panel-${instance}`}>
      <div className="gesture-feed" data-testid="gesture-feed">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="gesture-overlay"
          data-testid="gesture-overlay"
        >
          {/* Placeholder video area; a camera frame goes underneath on macOS. */}
          <rect x={0} y={0} width={VIEW_W} height={VIEW_H} className="gesture-video-placeholder" />
          {status?.mode === 'wheel' &&
            status.wheels.wheels.map((w, wi) => {
              const cx = w.cx * VIEW_W;
              const cy = w.cy * VIEW_H;
              const r = w.radius * VIEW_W;
              const rc = w.center_radius * VIEW_W;
              return (
                <g key={wi} data-testid={`gesture-wheel-${wi}`}>
                  {Array.from({ length: 8 }, (_, k) => k + 1).map((zone) => (
                    <path
                      key={zone}
                      d={zoneWedgePath(cx, cy, rc, r, zone)}
                      data-testid={`gesture-zone-${wi}-${zone}`}
                      className={[
                        'gesture-zone',
                        activeZones.has(`${wi}:${zone}`) ? 'gesture-zone-active' : '',
                        mappedZones.has(`${wi}:${zone}`) ? 'gesture-zone-mapped' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    />
                  ))}
                  <circle
                    cx={cx}
                    cy={cy}
                    r={rc}
                    data-testid={`gesture-zone-${wi}-0`}
                    className={[
                      'gesture-zone',
                      activeZones.has(`${wi}:0`) ? 'gesture-zone-active' : '',
                      mappedZones.has(`${wi}:0`) ? 'gesture-zone-mapped' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  />
                </g>
              );
            })}
          {status?.detection?.hands.map((hand) => (
            <g key={hand.handedness} data-testid={`gesture-hand-${hand.handedness}`}>
              {hand.points.map((p, i) => (
                <g key={i}>
                  <circle cx={p.x * VIEW_W} cy={p.y * VIEW_H} r={2.5} className="gesture-point" />
                  {status.mode !== 'wheel' && LABELED.has(i) && (
                    <text
                      x={p.x * VIEW_W + 4}
                      y={p.y * VIEW_H - 3}
                      className="gesture-point-label"
                      data-testid={`gesture-label-${hand.handedness === 'Left' ? 'L' : 'R'}.${LABELED.get(i)}`}
                    >
                      {hand.handedness === 'Left' ? 'L' : 'R'}.{LABELED.get(i)}
                    </text>
                  )}
                </g>
              ))}
            </g>
          ))}
        </svg>
        <span className="gesture-camera-badge" data-testid="gesture-camera-badge">
          {status?.camera === 'mock'
            ? status?.feed
              ? `mock feed: ${status.feed}`
              : 'no camera — mock feed available'
            : `camera: ${status?.camera ?? '…'}`}
        </span>
      </div>

      <div className="gesture-controls">
        <label>
          mode{' '}
          <select
            data-testid="gesture-mode"
            value={status?.mode ?? 'wheel'}
            onChange={(e) => void api.setMode(instance, e.target.value).then(refresh)}
          >
            {(status?.modes ?? ['wheel', 'landmark']).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <select
          data-testid="gesture-feed-source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          {FEED_SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {status?.feed ? (
          <button
            type="button"
            data-testid="gesture-feed-stop"
            onClick={() => void api.feedStop(instance).then(refresh)}
          >
            stop feed
          </button>
        ) : (
          <button
            type="button"
            data-testid="gesture-feed-start"
            onClick={() => void api.feedStart(instance, source).then(refresh)}
          >
            start feed
          </button>
        )}
      </div>

      <div className="gesture-learn">
        <input
          type="text"
          placeholder="new mapping name"
          data-testid="gesture-learn-name"
          value={learnName}
          onChange={(e) => setLearnName(e.target.value)}
        />
        <button
          type="button"
          data-testid="gesture-learn"
          disabled={!learnName.trim() && !learning}
          onClick={() => (learning ? setLearning(false) : beginLearn())}
        >
          {learning ? 'cancel learn' : 'learn'}
        </button>
        {learning && (
          <span className="gesture-learn-hint" data-testid="gesture-learn-hint">
            show the gesture to map…
          </span>
        )}
      </div>

      <div className="gesture-mappings">
        {(status?.mappings ?? []).length === 0 && (
          <p className="gesture-empty">No mappings — learn one to create an output jack.</p>
        )}
        {(status?.mappings ?? []).map((m) => (
          <div className="gesture-mapping" key={m.name} data-testid={`gesture-mapping-${m.name}`}>
            <span className="gesture-mapping-name">{m.name}</span>
            <span className="gesture-mapping-src">{describeConfig(m.mode, m.config)}</span>
            <span className="gesture-mapping-value">
              <span
                className="gesture-mapping-value-fill"
                data-testid={`gesture-value-${m.name}`}
                style={{ width: `${Math.min(100, Math.max(0, (m.value / 10) * 100))}%` }}
              />
            </span>
            <button
              type="button"
              className="gesture-remove"
              data-testid={`gesture-remove-${m.name}`}
              title="Remove mapping (and its wires)"
              onClick={() => void api.removeMapping(instance, m.name).then(() => onChanged())}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
