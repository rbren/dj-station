// Undo/redo for the Grid page.
//
// The grid's state is one small immutable value, so history is the honest
// thing: a stack of past states, the present, and a stack of futures. No
// edit needs to know how to invert itself, and an operation added later
// (beat surgery, say) is undoable the moment it goes through `record`.
//
// A GESTURE IS ONE STEP. A level-point drag or a loop drag streams a new
// state every mouse-move, and thirty of those are one thing the user did,
// not thirty. An edit therefore carries a KEY: consecutive edits with the
// same key replace the present instead of pushing another past, and the
// gesture's end (`endGesture`, called on mouse-up or blur) closes the
// window so the next one is its own step.

import type { GridState } from './grid';

export interface GridHistory {
  past: GridState[];
  present: GridState;
  future: GridState[];
  /** The gesture the last edit belonged to, or null between gestures. */
  key: string | null;
}

/** How far back undo reaches. Grid states are small (rows of numbers), so
 *  this is generous; it exists to bound memory, not to ration undo. */
export const GRID_HISTORY_DEPTH = 200;

export function initHistory(present: GridState): GridHistory {
  return { past: [], present, future: [], key: null };
}

/** Take an edit. An edit that changed nothing is not a step; one that
 *  continues the gesture named by `key` replaces the present rather than
 *  stacking on it. Either way the redo stack is spent. */
export function record(h: GridHistory, next: GridState, key: string | null = null): GridHistory {
  if (next === h.present) return h;
  if (key !== null && key === h.key) {
    return { ...h, present: next, future: [] };
  }
  return {
    past: [...h.past, h.present].slice(-GRID_HISTORY_DEPTH),
    present: next,
    future: [],
    key,
  };
}

/** The drag is over: the next edit starts a new step even if it names the
 *  same gesture. */
export function endGesture(h: GridHistory): GridHistory {
  return h.key === null ? h : { ...h, key: null };
}

export function canUndo(h: GridHistory): boolean {
  return h.past.length > 0;
}

export function canRedo(h: GridHistory): boolean {
  return h.future.length > 0;
}

export function undo(h: GridHistory): GridHistory {
  if (h.past.length === 0) return h;
  return {
    past: h.past.slice(0, -1),
    present: h.past[h.past.length - 1],
    future: [...h.future, h.present],
    key: null,
  };
}

export function redo(h: GridHistory): GridHistory {
  if (h.future.length === 0) return h;
  return {
    past: [...h.past, h.present].slice(-GRID_HISTORY_DEPTH),
    present: h.future[h.future.length - 1],
    future: h.future.slice(0, -1),
    key: null,
  };
}
