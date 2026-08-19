// Custom UI for the Trigger Sequencer: an 8-track x 16-step button grid
// over the pat1..pat8 bitmask jacks (bit 0 = step 1, per the module docs,
// which invite exactly this presentation). Clicking a cell toggles that
// step's bit; the len1..len8 jacks dim the steps beyond each track's
// length. Values flow through the host handle, so panel knobs, wires and
// patch load all stay in sync with the grid.
//
// The playheads are EXTRAPOLATED between polls (useStepFollowers on the
// monotonic `pos` counter; each track derives `pos mod len`): the 100 ms
// poll aliases against clock rates past a few Hz — see
// extensions/ui-lib/stepFollower.ts.

import { useEffect, useRef, useState } from "react";
import { counterCycle } from "../../ui-lib/stepFollower";
import { useStepFollowers } from "../../ui-lib/useStepFollower";

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
  setParam(id: string, v: number): void;
  signalTap?(jackId: string): { instantaneous: number };
  endEdit?(): void;
}

const TRACKS = 8;
const STEPS = 16;
/** `pos` wrap point, mirroring the DSP (lcm(1..16), f32-exact). */
const POS_WRAP = 720_720;

const readPatterns = (handle: ModuleHandle): number[] =>
  Array.from(
    { length: TRACKS },
    (_, t) => Math.round(handle.paramValue(`pat${t + 1}`)) & 0xffff,
  );

const readLengths = (handle: ModuleHandle): number[] =>
  Array.from({ length: TRACKS }, (_, t) =>
    Math.min(STEPS, Math.max(1, Math.round(handle.paramValue(`len${t + 1}`)))),
  );

const same = (a: number[], b: number[]) => a.every((v, i) => v === b[i]);

/** Per-track playing step from a (possibly extrapolated) `pos` counter. */
const stepsOf = (pos: number | null, lengths: number[]): (number | null)[] =>
  lengths.map((len) => (pos === null ? null : pos % len));

export default function TrigSeqUI({ handle }: { handle: ModuleHandle }) {
  const [patterns, setPatterns] = useState<number[]>(() =>
    readPatterns(handle),
  );
  const [lengths, setLengths] = useState<number[]>(() => readLengths(handle));
  const lengthsRef = useRef(lengths);
  lengthsRef.current = lengths;

  // Sync from the engine (panel knobs, wires, patch load). No dep array:
  // wired inputs read live telemetry through the handle, and telemetry
  // ticks re-render without changing the handle's identity.
  useEffect(() => {
    const p = readPatterns(handle);
    const l = readLengths(handle);
    setPatterns((prev) => (same(prev, p) ? prev : p));
    setLengths((prev) => (same(prev, l) ? prev : l));
  });

  const toggle = (track: number, step: number) => {
    setPatterns((prev) => {
      const next = [...prev];
      next[track] = prev[track] ^ (1 << step);
      handle.setParam(`pat${track + 1}`, next[track]);
      return next;
    });
    handle.endEdit?.();
  };

  // `instantaneous`, not `display`: the smoothed display sweeps through
  // phantom steps on the wrap back to step 1.
  const raw = handle.signalTap?.("out:pos")?.instantaneous ?? -1;
  const sampled = raw >= 0 ? Math.round(raw) % POS_WRAP : null;

  const rootRef = useRef<HTMLDivElement>(null);
  const [pos] = useStepFollowers(
    [{ cycle: counterCycle(POS_WRAP), sampled }],
    rootRef,
    (root, values) => {
      const steps = stepsOf(values[0], lengthsRef.current);
      // Cell markup below: root > .trigseq-track > [label, 16 buttons].
      for (let t = 0; t < root.children.length; t++) {
        const cells = root.children[t].children;
        for (let s = 1; s < cells.length; s++) {
          const cell = cells[s];
          const playing =
            steps[t] === s - 1 && !cell.classList.contains("beyond");
          cell.classList.toggle("playing", playing);
          if (playing) cell.setAttribute("data-playing", "true");
          else cell.removeAttribute("data-playing");
        }
      }
    },
  );
  const current = stepsOf(pos, lengths);

  return (
    <div className="trigseq-ui" data-testid="trigseq-ui" ref={rootRef}>
      {patterns.map((pattern, t) => (
        <div className="trigseq-track" key={t}>
          <span className="trigseq-track-label">{t + 1}</span>
          {Array.from({ length: STEPS }, (_, s) => {
            const on = (pattern & (1 << s)) !== 0;
            const beyond = s >= lengths[t];
            const playing = current[t] === s && !beyond;
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                data-testid={`trigseq-cell-${t + 1}-${s + 1}`}
                data-playing={playing || undefined}
                title={`track ${t + 1} step ${s + 1}`}
                className={`trigseq-cell${on ? " on" : ""}${beyond ? " beyond" : ""}${
                  s % 4 === 0 ? " beat" : ""
                }${playing ? " playing" : ""}`}
                onClick={() => toggle(t, s)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
