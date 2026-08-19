// Custom UI for the Grid Sequencer: an 8-row x 16-column button grid over
// the row1..row8 bitmask jacks (bit 0 = column 1, per the module docs).
// Clicking a cell toggles that column's bit; shift+click cycles the cell's
// ratchet count 1 -> 2 -> 3 -> 4 -> 1 (stored in the rata/ratb bitplane
// jacks as count-1 in binary; counts above 1 show as a number on the
// cell). The playhead column comes from the `pos` output via the batched
// telemetry tap. Values flow through the host handle, so panel knobs,
// wires and patch load all stay in sync with the grid — a wire modulating
// a row jack shows live in the cells.
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

/** Per-row on/off pattern plus the two ratchet bitplanes (a cell's
 *  ratchet count is `1 + bitA + 2*bitB`, mirroring the DSP). */
interface Masks {
  rows: number[];
  rata: number[];
  ratb: number[];
}

const readMask = (handle: ModuleHandle, id: string) =>
  Math.round(handle.paramValue(id)) & 0xffff;

const readMasks = (handle: ModuleHandle): Masks => ({
  rows: Array.from({ length: ROWS }, (_, r) => readMask(handle, `row${r + 1}`)),
  rata: Array.from({ length: ROWS }, (_, r) =>
    readMask(handle, `rata${r + 1}`),
  ),
  ratb: Array.from({ length: ROWS }, (_, r) =>
    readMask(handle, `ratb${r + 1}`),
  ),
});

const same = (a: Masks, b: Masks) =>
  a.rows.every((v, i) => v === b.rows[i]) &&
  a.rata.every((v, i) => v === b.rata[i]) &&
  a.ratb.every((v, i) => v === b.ratb[i]);

/** Ratchet count (1..4) of an ON cell. */
const ratchetCount = (m: Masks, row: number, col: number): number =>
  1 + ((m.rata[row] >> col) & 1) + 2 * ((m.ratb[row] >> col) & 1);

export default function GridSeqUI({ handle }: { handle: ModuleHandle }) {
  const [masks, setMasks] = useState<Masks>(() => readMasks(handle));

  // Sync from the engine (panel knobs, wires, patch load) on every render,
  // so telemetry ticks pull in wire-driven pattern changes.
  useEffect(() => {
    const next = readMasks(handle);
    setMasks((prev) => (same(prev, next) ? prev : next));
  });

  const scaleMode = Math.round(handle.paramValue("mode")) >= 1;

  // Click toggles the cell (ratchets cleared so it comes back plain);
  // shift+click adds a ratchet, cycling 1 -> 2 -> 3 -> 4 -> 1 (turning an
  // off cell on first).
  const toggle = (row: number, col: number, shift: boolean) => {
    setMasks((prev) => {
      const bit = 1 << col;
      const rows = [...prev.rows];
      const rata = [...prev.rata];
      const ratb = [...prev.ratb];
      if (shift) {
        const count = prev.rows[row] & bit ? ratchetCount(prev, row, col) : 0;
        const next = count >= 4 ? 1 : count + 1;
        rows[row] |= bit;
        rata[row] = (rata[row] & ~bit) | ((next - 1) & 1 ? bit : 0);
        ratb[row] = (ratb[row] & ~bit) | ((next - 1) & 2 ? bit : 0);
      } else {
        rows[row] ^= bit;
        rata[row] &= ~bit;
        ratb[row] &= ~bit;
      }
      if (rows[row] !== prev.rows[row])
        handle.setParam(`row${row + 1}`, rows[row]);
      if (rata[row] !== prev.rata[row])
        handle.setParam(`rata${row + 1}`, rata[row]);
      if (ratb[row] !== prev.ratb[row])
        handle.setParam(`ratb${row + 1}`, ratb[row]);
      return { rows, rata, ratb };
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
      {masks.rows.map((pattern, r) => (
        <div className="trigseq-track" key={r}>
          <span className="trigseq-track-label">
            {scaleMode ? SCALE_NOTES[r] : r + 1}
          </span>
          {Array.from({ length: COLS }, (_, c) => {
            const on = (pattern & (1 << c)) !== 0;
            const ratchets = on ? ratchetCount(masks, r, c) : 0;
            const playing = current === c;
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                data-testid={`gridseq-cell-${r + 1}-${c + 1}`}
                data-playing={playing || undefined}
                title={`row ${r + 1} column ${c + 1}${
                  ratchets > 1 ? ` (ratchet x${ratchets})` : ""
                } — shift+click: ratchet`}
                className={`trigseq-cell${on ? " on" : ""}${
                  c % 4 === 0 ? " beat" : ""
                }${playing ? " playing" : ""}`}
                onClick={(e) => toggle(r, c, e.shiftKey)}
              >
                {ratchets > 1 ? ratchets : ""}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
