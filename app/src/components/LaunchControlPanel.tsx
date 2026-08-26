// Panel body for the built-in Launch Control XL module: an indicator
// light for the physical surface and the Active button that decides which
// module the surface drives. The controls themselves are output jacks
// (eight columns, laid out by panelLayouts) — this component owns only
// the device status poll and the ownership toggle.
//
// Ownership is EXCLUSIVE (one surface, one listening module), so the
// button is a plain toggle whose "off" state also reports which other
// module currently holds the controller.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LaunchControlStatus } from '../engine';

/** IPC surface the panel needs; RackModule adapts EngineClient onto this. */
export interface LaunchControlApi {
  status(instance: string): Promise<LaunchControlStatus | null>;
  setActive(instance: string, active: boolean): Promise<unknown>;
}

export interface LaunchControlPanelProps {
  instance: string;
  api: LaunchControlApi;
  /** Status poll interval in ms (tests dial it down). */
  pollMs?: number;
}

export function LaunchControlPanel({ instance, api, pollMs = 500 }: LaunchControlPanelProps) {
  const [status, setStatus] = useState<LaunchControlStatus | null>(null);
  // Guards in-flight polls that resolve after the panel unmounts (module
  // removed): the interval is cleared, but a pending IPC round trip must
  // not land a setState on the dead panel.
  const disposedRef = useRef(false);
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    const s = await api.status(instance);
    // A null status is an expected race (the module was just removed, or
    // an undo rebuilt the engine); keep the last snapshot.
    if (s && !disposedRef.current) setStatus(s);
  }, [api, instance]);

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), pollMs);
    return () => {
      clearTimeout(initial);
      clearInterval(t);
    };
  }, [refresh, pollMs]);

  const connected = status?.connected ?? false;
  const active = status?.active ?? false;
  const owner = status?.active_instance ?? null;
  const takenByOther = !active && owner !== null;

  const toggle = () => {
    void api.setActive(instance, !active).then(() => refresh());
  };

  return (
    <div className="launchcontrol-panel" data-testid={`launchcontrol-panel-${instance}`}>
      <span
        className={`launchcontrol-led${connected ? ' launchcontrol-led-on' : ''}`}
        data-testid={`launchcontrol-led-${instance}`}
        data-connected={connected ? 'yes' : 'no'}
        data-tip={
          connected
            ? 'Launch Control XL detected on a MIDI port'
            : 'No Launch Control XL found — plug it in; the module keeps its last values'
        }
      />
      <span className="launchcontrol-status" data-testid={`launchcontrol-status-${instance}`}>
        {connected ? 'controller connected' : 'no controller'}
      </span>
      <button
        type="button"
        className={`launchcontrol-active${active ? ' launchcontrol-active-on' : ''}`}
        data-testid={`launchcontrol-active-${instance}`}
        aria-pressed={active}
        data-tip="Only one module hears the controller at a time — click to take it"
        onClick={toggle}
      >
        {active ? 'Active' : 'Inactive'}
      </button>
      {takenByOther && (
        <span className="launchcontrol-owner" data-testid={`launchcontrol-owner-${instance}`}>
          held by {owner}
        </span>
      )}
    </div>
  );
}
