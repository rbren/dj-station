// Bridge from the camera panel's tracker to `builtin.hands` engine
// modules: every tracked frame is serialized to the fixed
// `HandsDetection` shape and sent over one Tauri IPC command
// (`hands_feed`) per Hands instance in the rack.
//
// Discovery is periodic (`engine_nodes`, filtered by type) so adding or
// removing a Hands module while tracking runs just works. Outside Tauri
// (vite dev / vitest) there is no `invoke`; the feeder becomes a no-op
// unless a test injects one.
//
// Frames where the tracker ran but saw nothing still send
// `{left: null, right: null}` — that is a MEASUREMENT ("no hands"), and
// it is what drops the module's seen-gates. Genuinely dropped frames
// (inference failed) send nothing, and the engine holds everything.

import type { HandFrame } from "./handTracking";

export type Invoke = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const HANDS_TYPE = "builtin.hands";
const DISCOVER_MS = 3000;

/** Wire format of dj_engine::hands::HandsDetection. */
export interface HandsDetectionWire {
  left: number[][] | null;
  right: number[][] | null;
}

export function toDetectionWire(frame: HandFrame): HandsDetectionWire {
  const det: HandsDetectionWire = { left: null, right: null };
  for (const hand of frame.hands) {
    const pts = hand.points.map((p) => [p.x, p.y, p.z]);
    if (pts.length !== 21) continue; // partial result: not a valid hand
    det[hand.hand] = pts;
  }
  return det;
}

async function tauriInvoke(): Promise<Invoke | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke as Invoke;
}

export interface HandsFeeder {
  /** Ship one tracked frame to every Hands module in the rack. */
  feed(frame: HandFrame): void;
  /** Stop discovery; subsequent feeds are dropped. */
  close(): void;
}

/**
 * Create a feeder. `invokeOverride` is for tests; production resolves
 * the real Tauri invoke (or a permanent no-op outside Tauri).
 */
export function createHandsFeeder(invokeOverride?: Invoke): HandsFeeder {
  let invoke: Invoke | null = invokeOverride ?? null;
  let instances: string[] = [];
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const discover = async () => {
    if (!invoke || closed) return;
    try {
      const nodes = (await invoke("engine_nodes")) as
        { instance_id: string; type_id: string }[] | null;
      if (!closed && Array.isArray(nodes)) {
        instances = nodes
          .filter((n) => n.type_id === HANDS_TYPE)
          .map((n) => n.instance_id);
      }
    } catch {
      // Transient (e.g. mid-edit); keep the last instance list.
    }
  };

  const init = async () => {
    if (!invoke) invoke = await tauriInvoke();
    if (!invoke || closed) return;
    await discover();
    timer = setInterval(() => void discover(), DISCOVER_MS);
  };
  void init();

  return {
    feed(frame: HandFrame) {
      if (!invoke || closed || instances.length === 0) return;
      const detection = toDetectionWire(frame);
      for (const instance of instances) {
        // Errors surface as a rejected promise per call; a dropped frame
        // is fine (the engine holds last values), so ignore them here
        // rather than flooding the error banner at camera rate.
        void invoke("hands_feed", { instance, detection }).catch(() => {});
      }
    },
    close() {
      closed = true;
      if (timer !== null) clearInterval(timer);
    },
  };
}
