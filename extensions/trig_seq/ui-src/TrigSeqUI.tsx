// Custom UI for the Trigger Sequencer: an 8-track x 16-step button grid
// over the pat1..pat8 bitmask jacks (bit 0 = step 1, per the module docs,
// which invite exactly this presentation). Clicking a cell toggles that
// step's bit; the len1..len8 jacks dim the steps beyond each track's
// length. Values flow through the host handle, so panel knobs, wires and
// patch load all stay in sync with the grid.

import { useEffect, useState } from "react";

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
  setParam(id: string, v: number): void;
  endEdit?(): void;
}

const TRACKS = 8;
const STEPS = 16;

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

export default function TrigSeqUI({ handle }: { handle: ModuleHandle }) {
  const [patterns, setPatterns] = useState<number[]>(() =>
    readPatterns(handle),
  );
  const [lengths, setLengths] = useState<number[]>(() => readLengths(handle));

  // Sync from the engine (panel knobs, wires, patch load).
  useEffect(() => {
    const p = readPatterns(handle);
    const l = readLengths(handle);
    setPatterns((prev) => (same(prev, p) ? prev : p));
    setLengths((prev) => (same(prev, l) ? prev : l));
  }, [handle]);

  const toggle = (track: number, step: number) => {
    setPatterns((prev) => {
      const next = [...prev];
      next[track] = prev[track] ^ (1 << step);
      handle.setParam(`pat${track + 1}`, next[track]);
      return next;
    });
    handle.endEdit?.();
  };

  return (
    <div className="trigseq-ui" data-testid="trigseq-ui">
      {patterns.map((pattern, t) => (
        <div className="trigseq-track" key={t}>
          <span className="trigseq-track-label">{t + 1}</span>
          {Array.from({ length: STEPS }, (_, s) => {
            const on = (pattern & (1 << s)) !== 0;
            const beyond = s >= lengths[t];
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                data-testid={`trigseq-cell-${t + 1}-${s + 1}`}
                title={`track ${t + 1} step ${s + 1}`}
                className={`trigseq-cell${on ? " on" : ""}${beyond ? " beyond" : ""}${
                  s % 4 === 0 ? " beat" : ""
                }`}
                onClick={() => toggle(t, s)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
