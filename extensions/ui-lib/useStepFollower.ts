// React binding for StepFollower: sampled playhead(s) in, alias-free
// playhead(s) out.
//
// The hook returns the values the component should RENDER from (the
// prediction at render time — which collapses to the raw sample until
// the follower has measured a stable clock, so poll-driven jsdom tests
// see exactly the sampled value), and additionally runs a rAF loop that
// repaints BETWEEN telemetry polls when the predicted step changes —
// via the caller's DOM patcher, never a React state update. That
// preserves the telemetry rendering discipline (a rAF tick must not
// re-render a panel, see app/tests/RenderCounts.test.tsx).
//
// Usage (see StepSeqUI for the template):
//
//   const shown = useStepFollowers(
//     [{ cycle: forwardCycle(length), sampled: raw >= 0 ? raw : null }],
//     rootRef,
//     applyPlayhead,
//   )[0];
//
// `apply(root, values)` mutates classes/attributes under `root` to move
// the highlight; it runs once per predicted-step change, not per frame,
// and must produce exactly the DOM the component renders for the same
// values — so a React re-render never fights the rAF loop. Entry count
// and order must be stable for a given component (they are: one per
// fixed playhead of the module type). Pass `cycle: null` to disable
// extrapolation for an entry (e.g. step_seq's random direction) — the
// raw sample passes through untouched.

import { useEffect, useRef } from "react";
import { StepFollower, type CycleSpec } from "./stepFollower";

export interface FollowerEntry {
  cycle: CycleSpec | null;
  /** Raw sampled position; null = not running / unknown. */
  sampled: number | null;
}

export function useStepFollowers<E extends HTMLElement>(
  entries: FollowerEntry[],
  rootRef: { current: E | null },
  apply: (root: E, values: (number | null)[]) => void,
): (number | null)[] {
  const followers = useRef<(StepFollower | null)[]>([]);
  const latest = useRef<FollowerEntry[]>(entries);
  const painted = useRef<(number | null)[]>([]);
  const applyRef = useRef(apply);

  latest.current = entries;
  applyRef.current = apply;

  // Renders are driven by the telemetry poll, so each render is a fresh
  // observation; predict() collapses to the raw sample until a stable
  // clock has been measured (idempotent for a repeated render with the
  // same sample, so StrictMode double-renders are harmless).
  const now = performance.now();
  const shown = entries.map((entry, i) => {
    if (!entry.cycle) {
      followers.current[i] = null;
      return entry.sampled;
    }
    let f = followers.current[i];
    if (!f) {
      f = new StepFollower(entry.cycle);
      followers.current[i] = f;
    } else {
      f.setCycle(entry.cycle);
    }
    f.observe(entry.sampled, now);
    return f.predict(now);
  });
  painted.current = shown;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const root = rootRef.current;
      if (!root) return;
      const t = performance.now();
      const values = latest.current.map((entry, i) => {
        const f = followers.current[i];
        return f ? f.predict(t) : entry.sampled;
      });
      const prev = painted.current;
      if (
        values.length === prev.length &&
        values.every((v, i) => v === prev[i])
      ) {
        return;
      }
      painted.current = values;
      applyRef.current(root, values);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Refs only — the loop reads everything through refs updated at render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return shown;
}
