// Sequential switch step lamps: one lamp per step with the currently
// routed step lit hot. The step is decoded from the module's existing
// `step_cv` output ((step + 0.5) / steps * 10 V) via the batched
// telemetry tap — no new engine outputs needed.
//
// The lamp is EXTRAPOLATED between polls (useStepFollowers): the 100 ms
// poll aliases against clock rates past a few Hz — see
// extensions/ui-lib/stepFollower.ts. When the switch is cv-addressed
// (irregular jumps) the follower's regularity check keeps it honest and
// the lamp falls back to the raw sample automatically.

import { useRef } from "react";
import { forwardCycle } from "../../ui-lib/stepFollower";
import { useStepFollowers } from "../../ui-lib/useStepFollower";

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
  signalTap?(jackId: string): { instantaneous: number };
}

const MAX_STEPS = 8;

/** Move the lamp highlight by direct DOM mutation — must mirror the
 *  `playing` markup rendered below (beyond lamps never light). */
function applyPlayhead(root: HTMLDivElement, values: (number | null)[]) {
  const step = values[0];
  for (let s = 0; s < root.children.length; s++) {
    const lamp = root.children[s];
    const playing = step === s && !lamp.classList.contains("beyond");
    lamp.classList.toggle("playing", playing);
    if (playing) lamp.setAttribute("data-playing", "true");
    else lamp.removeAttribute("data-playing");
  }
}

export default function SeqSwitchUI({ handle }: { handle: ModuleHandle }) {
  const steps = Math.min(
    MAX_STEPS,
    Math.max(2, Math.round(handle.paramValue("steps"))),
  );
  // `instantaneous`, not `display`: the smoothed display sweeps through
  // phantom steps on the wrap back to step 1.
  const cv = handle.signalTap?.("out:step_cv")?.instantaneous ?? 0;
  const sampled = Math.min(
    steps - 1,
    Math.max(0, Math.floor((cv / 10) * steps)),
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const [current] = useStepFollowers(
    [{ cycle: forwardCycle(steps), sampled }],
    rootRef,
    applyPlayhead,
  );

  return (
    <div className="stepseq-ui" data-testid="seqswitch-ui" ref={rootRef}>
      {Array.from({ length: MAX_STEPS }, (_, s) => {
        const beyond = s >= steps;
        const playing = s === current && !beyond;
        return (
          <span
            key={s}
            data-testid={`seqswitch-lamp-${s + 1}`}
            data-playing={playing || undefined}
            className={`stepseq-lamp${beyond ? " beyond" : ""}${
              playing ? " playing" : ""
            }`}
          >
            {s + 1}
          </span>
        );
      })}
    </div>
  );
}
