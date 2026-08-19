// Step sequencer playhead strip: one lamp per step above the 16-column
// knob grid, with the currently-playing step lit hot (bright fill + glow)
// so it reads at a glance from across the room. The strip renders as a
// CSS grid sharing the panel's --cell-w/--cell-gap tokens with the
// cv/gate/ratchet step grid below (see .stepseq-ui in styles.css and the
// com.dj.step_seq layout in panelLayouts.ts), so lamp N sits directly
// above step column N. The step index comes from the module's `step`
// output via the batched telemetry tap (out:step); -1 (armed, no clock
// yet) shows no playhead. Discrete indices must read the tap's
// `instantaneous` field, never `display`: display is 100 ms low-pass
// smoothed, so the 15->0 wrap sweeps through every intermediate value
// and briefly lights a phantom step.
//
// The lamp position is EXTRAPOLATED between polls (useStepFollowers +
// the direction-matched cycle spec): the 100 ms poll aliases against
// clock rates past a few Hz — see extensions/ui-lib/stepFollower.ts.
// Random direction (dir 3) is unpredictable, so it stays raw-sampled.

import { useRef } from "react";
import {
  forwardCycle,
  pingPongCycle,
  reverseCycle,
  type CycleSpec,
} from "../../ui-lib/stepFollower";
import { useStepFollowers } from "../../ui-lib/useStepFollower";

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
  signalTap?(jackId: string): { instantaneous: number };
}

const STEPS = 16;

function cycleFor(dir: number, length: number): CycleSpec | null {
  switch (dir) {
    case 1:
      return reverseCycle(length);
    case 2:
      return pingPongCycle(length);
    case 3:
      return null; // random: honest raw sampling only
    default:
      return forwardCycle(length);
  }
}

/** Move the lamp highlight to `step` (null = none) by direct DOM
 *  mutation — must mirror the `playing` markup rendered below. */
function applyPlayhead(root: HTMLDivElement, values: (number | null)[]) {
  const step = values[0];
  for (let s = 0; s < root.children.length; s++) {
    const lamp = root.children[s];
    const playing = step === s;
    lamp.classList.toggle("playing", playing);
    if (playing) lamp.setAttribute("data-playing", "true");
    else lamp.removeAttribute("data-playing");
  }
}

export default function StepSeqUI({ handle }: { handle: ModuleHandle }) {
  const length = Math.min(
    STEPS,
    Math.max(1, Math.round(handle.paramValue("length"))),
  );
  const dir = Math.min(3, Math.max(0, Math.round(handle.paramValue("dir"))));
  const raw = handle.signalTap?.("out:step")?.instantaneous ?? -1;
  const sampled = raw >= 0 ? Math.round(raw) % STEPS : null;

  const rootRef = useRef<HTMLDivElement>(null);
  const [current] = useStepFollowers(
    [{ cycle: cycleFor(dir, length), sampled }],
    rootRef,
    applyPlayhead,
  );

  return (
    <div className="stepseq-ui" data-testid="stepseq-ui" ref={rootRef}>
      {Array.from({ length: STEPS }, (_, s) => {
        const beyond = s >= length;
        const playing = current === s;
        return (
          <span
            key={s}
            data-testid={`stepseq-lamp-${s + 1}`}
            data-playing={playing || undefined}
            className={`stepseq-lamp${s % 4 === 0 ? " beat" : ""}${
              beyond ? " beyond" : ""
            }${playing ? " playing" : ""}`}
          >
            {s + 1}
          </span>
        );
      })}
    </div>
  );
}
