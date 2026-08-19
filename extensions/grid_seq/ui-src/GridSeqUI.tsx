// Custom UI for the Grid Sequencer: an 8-row x 16-column button grid over
// the row1..row8 bitmask jacks (bit 0 = column 1, per the module docs).
// Clicking a cell toggles that column's bit; the playhead column comes
// from the `pos` output via the batched telemetry tap. Values flow through
// the host handle, so panel knobs, wires and patch load all stay in sync
// with the grid — a wire modulating a row jack shows live in the cells.
//
// The playhead column is EXTRAPOLATED between polls (useStepFollowers on
// the monotonic `pos` counter): the 100 ms poll aliases against clock
// rates past a few Hz — see extensions/ui-lib/stepFollower.ts.

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

const ROWS = 8;
const COLS = 16;
/** `pos` wrap point, mirroring the DSP (lcm(1..16), f32-exact). */
const POS_WRAP = 720_720;

/** Move the column highlight by direct DOM mutation — must mirror the
 *  `playing` markup below (root > .trigseq-track > [label, 16 cells]). */
function applyPlayhead(root: HTMLDivElement, values: (number | null)[]) {
  const pos = values[0];
  const col = pos === null ? null : pos % COLS;
  for (let r = 0; r < root.children.length; r++) {
    const cells = root.children[r].children;
    for (let c = 1; c < cells.length; c++) {
      const cell = cells[c];
      const playing = col === c - 1;
      cell.classList.toggle("playing", playing);
      if (playing) cell.setAttribute("data-playing", "true");
      else cell.removeAttribute("data-playing");
    }
  }
}

// Row pitches in scale mode (C major over one octave, row 1 = C4).
const SCALE_NOTES = ["C", "D", "E", "F", "G", "A", "B", "C"];

const readRows = (handle: ModuleHandle): number[] =>
  Array.from(
    { length: ROWS },
    (_, r) => Math.round(handle.paramValue(`row${r + 1}`)) & 0xffff,
  );

const same = (a: number[], b: number[]) => a.every((v, i) => v === b[i]);

export default function GridSeqUI({ handle }: { handle: ModuleHandle }) {
  const [rows, setRows] = useState<number[]>(() => readRows(handle));

  // Sync from the engine (panel knobs, wires, patch load) on every render,
  // so telemetry ticks pull in wire-driven pattern changes.
  useEffect(() => {
    const next = readRows(handle);
    setRows((prev) => (same(prev, next) ? prev : next));
  });

  const scaleMode = Math.round(handle.paramValue("mode")) >= 1;

  const toggle = (row: number, col: number) => {
    setRows((prev) => {
      const next = [...prev];
      next[row] = prev[row] ^ (1 << col);
      handle.setParam(`row${row + 1}`, next[row]);
      return next;
    });
    handle.endEdit?.();
  };

  // Live playhead column from the `pos` output (-1 = armed, no clock yet).
  // `instantaneous`, not `display`: the smoothed display sweeps through
  // phantom columns on the wrap back to column 1.
  const raw = handle.signalTap?.("out:pos")?.instantaneous ?? -1;
  const sampled = raw >= 0 ? Math.round(raw) % POS_WRAP : null;

  const rootRef = useRef<HTMLDivElement>(null);
  const [pos] = useStepFollowers(
    [{ cycle: counterCycle(POS_WRAP), sampled }],
    rootRef,
    applyPlayhead,
  );
  const current = pos === null ? null : pos % COLS;

  return (
    <div
      className="trigseq-ui gridseq-ui"
      data-testid="gridseq-ui"
      ref={rootRef}
    >
      {rows.map((pattern, r) => (
        <div className="trigseq-track" key={r}>
          <span className="trigseq-track-label">
            {scaleMode ? SCALE_NOTES[r] : r + 1}
          </span>
          {Array.from({ length: COLS }, (_, c) => {
            const on = (pattern & (1 << c)) !== 0;
            const playing = current === c;
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                data-testid={`gridseq-cell-${r + 1}-${c + 1}`}
                data-playing={playing || undefined}
                title={`row ${r + 1} column ${c + 1}`}
                className={`trigseq-cell${on ? " on" : ""}${
                  c % 4 === 0 ? " beat" : ""
                }${playing ? " playing" : ""}`}
                onClick={() => toggle(r, c)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
