// Quantizer scale keyboard: one octave of piano keys showing which of the
// 12 pitch classes are active in the selected scale + root. Scale 0 is the
// CUSTOM scale — clicking keys toggles pitch classes in the `custom` mask
// input (12-bit, bit = semitone degree relative to the root, mirroring the
// DSP). Clicking a key while a preset scale is selected seeds the custom
// mask from that preset's notes (with the clicked toggle applied) and
// switches the scale knob to custom, so presets act as starting points.
// Both `scale` and `custom` are ordinary knob-backed inputs, so the custom
// scale persists per-patch through the normal knob save/load round-trip.

import { useEffect, useState } from "react";

// Structural copy of the host's ModuleHandle (extensions compile standalone).
interface ModuleHandle {
  paramValue(id: string): number;
  setParam(id: string, v: number): void;
  endEdit?(): void;
}

/** Preset scale degrees, mirroring the DSP's SCALES table (index 0 is the
 *  custom scale; its entry is the all-on default). */
const SCALES: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], // custom (default mask)
  [0, 2, 4, 5, 7, 9, 11], // major
  [0, 2, 3, 5, 7, 8, 10], // natural minor
  [0, 2, 3, 5, 7, 8, 11], // harmonic minor
  [0, 2, 4, 7, 9], // pentatonic major
  [0, 3, 5, 7, 10], // pentatonic minor
  [0, 3, 5, 6, 7, 10], // blues
  [0, 2, 3, 5, 7, 9, 10], // dorian
  [0, 2, 4, 5, 7, 9, 10], // mixolydian
  [0, 2, 4, 6, 8, 10], // whole tone
];

const SCALE_NAMES = [
  "custom",
  "major",
  "minor",
  "harm minor",
  "penta maj",
  "penta min",
  "blues",
  "dorian",
  "mixolydian",
  "whole tone",
];

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

const BLACK = new Set([1, 3, 6, 8, 10]);

const maskFor = (degrees: number[]): number =>
  degrees.reduce((m, d) => m | (1 << d), 0);

interface State {
  scale: number;
  root: number;
  mask: number;
}

const readState = (handle: ModuleHandle): State => {
  const scale = Math.min(
    9,
    Math.max(0, Math.round(handle.paramValue("scale"))),
  );
  return {
    scale,
    root: Math.min(11, Math.max(0, Math.round(handle.paramValue("root")))),
    mask: Math.min(4095, Math.max(0, Math.round(handle.paramValue("custom")))),
  };
};

export default function QuantizerUI({ handle }: { handle: ModuleHandle }) {
  const [state, setState] = useState<State>(() => readState(handle));

  // Sync from the engine (panel knobs, wires, patch load).
  useEffect(() => {
    const next = readState(handle);
    setState((prev) =>
      prev.scale === next.scale &&
      prev.root === next.root &&
      prev.mask === next.mask
        ? prev
        : next,
    );
  }, [handle]);

  const { scale, root, mask } = state;
  // Active mask relative to the root: presets from the table, custom from
  // the `custom` input.
  const activeMask = scale === 0 ? mask : maskFor(SCALES[scale]);

  const toggle = (pc: number) => {
    const degree = (pc - root + 12) % 12;
    const next = activeMask ^ (1 << degree);
    if (scale !== 0) {
      // Editing a preset forks it into the custom scale.
      handle.setParam("scale", 0);
    }
    handle.setParam("custom", next);
    setState({ scale: 0, root, mask: next });
    handle.endEdit?.();
  };

  return (
    <div className="quantizer-ui" data-testid="quantizer-ui">
      <div className="quantizer-keys">
        {NOTE_NAMES.map((name, pc) => {
          const degree = (pc - root + 12) % 12;
          const active = (activeMask & (1 << degree)) !== 0;
          const isRoot = pc === root;
          return (
            <button
              key={pc}
              type="button"
              aria-pressed={active}
              data-testid={`quantizer-key-${pc}`}
              title={`${name}${isRoot ? " (root)" : ""}`}
              className={`quantizer-key ${BLACK.has(pc) ? "black" : "white"}${
                active ? " active" : ""
              }${isRoot ? " root" : ""}`}
              onClick={() => toggle(pc)}
            >
              <span className="quantizer-key-label">{name}</span>
            </button>
          );
        })}
      </div>
      <div className="quantizer-scale-name" data-testid="quantizer-scale-name">
        {NOTE_NAMES[root]} {SCALE_NAMES[scale]}
      </div>
    </div>
  );
}
