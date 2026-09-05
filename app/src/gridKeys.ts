// The Grid page's vim grammar, as a pure state machine so the motions
// can be tested without a DOM.
//
// The arrangement reads like a buffer: a ROW is a line, a BEAT is a
// character and a BAR is a word, which is what makes `3w`, `d$`, `yy`
// and `8l` mean the obvious things. `GridView` owns the caret and the
// document; this file only says what a keystroke asks for.
//
// Counts multiply the way vim's do (`2d3w` is six bars), an operator
// waits for its motion, and anything this file does not recognise is
// handed back unhandled so the page's older bindings (space, cmd+S, …)
// still see it.

import type { ColumnRange } from './grid';

export interface GridCaret {
  /** Row INDEX into the flat row list, not a row id. */
  row: number;
  /** Beat column. */
  col: number;
}

export interface GridBounds {
  rows: number;
  columns: number;
  barBeats: number;
}

export type GridMotion =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'word'
  | 'back'
  | 'end'
  | 'home'
  | 'lineEnd'
  | 'firstRow'
  | 'lastRow';

/** Motions that move between rows: an operator over one of them takes
 *  whole rows, the way vim's linewise motions take whole lines. */
const LINEWISE: ReadonlySet<GridMotion> = new Set<GridMotion>([
  'up',
  'down',
  'firstRow',
  'lastRow',
]);

export interface GridKeyState {
  /** Digits typed for the motion. */
  count: string;
  /** Digits typed before the operator. */
  opCount: string;
  operator: 'y' | 'd' | null;
  /** A `g` waiting for its second `g`. */
  pendingG: boolean;
  /** Visual mode: moving extends the marked rectangle. */
  visual: boolean;
}

export const IDLE_GRID_KEYS: GridKeyState = {
  count: '',
  opCount: '',
  operator: null,
  pendingG: false,
  visual: false,
};

export type GridKeyAction =
  /** Put the caret here (and extend the rectangle, in visual mode). */
  | { kind: 'move'; to: GridCaret }
  /** Yank or delete a rectangle of the arrangement. */
  | { kind: 'operate'; operator: 'y' | 'd'; rows: [number, number]; columns: ColumnRange }
  /** Yank or delete whatever is already marked. */
  | { kind: 'operateSelection'; operator: 'y' | 'd' }
  | { kind: 'paste'; at: number }
  | { kind: 'visual'; on: boolean }
  /** Escape: drop the pending count/operator and any rectangle. */
  | { kind: 'reset' };

export interface GridKeyResult {
  state: GridKeyState;
  action: GridKeyAction | null;
  /** False when the key means nothing here — the page's other bindings
   *  get their turn. */
  handled: boolean;
}

const clamp = (v: number, hi: number) => Math.min(hi, Math.max(0, v));

/** Where a motion lands, from `caret`, repeated `count` times. */
export function moveCaret(
  caret: GridCaret,
  motion: GridMotion,
  count: number,
  bounds: GridBounds,
): GridCaret {
  const bar = Math.max(1, bounds.barBeats);
  const lastCol = Math.max(0, bounds.columns - 1);
  const lastRow = Math.max(0, bounds.rows - 1);
  switch (motion) {
    case 'left':
      return { ...caret, col: clamp(caret.col - count, lastCol) };
    case 'right':
      return { ...caret, col: clamp(caret.col + count, lastCol) };
    case 'up':
      return { ...caret, row: clamp(caret.row - count, lastRow) };
    case 'down':
      return { ...caret, row: clamp(caret.row + count, lastRow) };
    case 'word':
      return { ...caret, col: clamp((Math.floor(caret.col / bar) + count) * bar, lastCol) };
    case 'back': {
      // Mid-bar, the first `b` goes to the bar's own first beat — vim's
      // rule for a word.
      const base = Math.floor(caret.col / bar) * bar;
      const steps = caret.col > base ? count - 1 : count;
      return { ...caret, col: clamp(base - steps * bar, lastCol) };
    }
    case 'end': {
      const here = Math.floor(caret.col / bar) * bar + bar - 1;
      const extra = caret.col >= here ? count : count - 1;
      return { ...caret, col: clamp(here + extra * bar, lastCol) };
    }
    case 'home':
      return { ...caret, col: 0 };
    case 'lineEnd':
      return { ...caret, col: lastCol };
    case 'firstRow':
      return { ...caret, row: clamp(count - 1, lastRow) };
    case 'lastRow':
      return { ...caret, row: count > 1 ? clamp(count - 1, lastRow) : lastRow };
  }
}

/** The motion a key asks for, or null. Arrow keys and hjkl are the same
 *  motion by construction — that is the whole point of the pair. */
export function motionFor(key: string, count: string): GridMotion | null {
  switch (key) {
    case 'h':
    case 'ArrowLeft':
      return 'left';
    case 'l':
    case 'ArrowRight':
      return 'right';
    case 'k':
    case 'ArrowUp':
      return 'up';
    case 'j':
    case 'ArrowDown':
      return 'down';
    case 'w':
      return 'word';
    case 'b':
      return 'back';
    case 'e':
      return 'end';
    case '$':
      return 'lineEnd';
    case 'G':
      return 'lastRow';
    // `0` is the motion only when it is not a count's digit.
    case '0':
      return count === '' ? 'home' : null;
    default:
      return null;
  }
}

const digits = (text: string): number => {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

/** The rectangle an operator + motion covers. Column motions take the
 *  beats between here and there (the far end exclusive, like vim);
 *  row motions take whole rows. */
function spanFor(
  caret: GridCaret,
  motion: GridMotion,
  to: GridCaret,
  bounds: GridBounds,
): { rows: [number, number]; columns: ColumnRange } {
  if (LINEWISE.has(motion)) {
    const rows: [number, number] = [Math.min(caret.row, to.row), Math.max(caret.row, to.row)];
    return { rows, columns: { start: 0, end: Math.max(1, bounds.columns) } };
  }
  const start = Math.min(caret.col, to.col);
  const end = Math.max(caret.col, to.col);
  return {
    rows: [caret.row, caret.row],
    // A motion that did not move (`d0` at beat 0) still takes the beat
    // under the caret, so an operator is never a no-op.
    columns: { start, end: Math.max(end, start + 1) },
  };
}

/** Feed one key. `hasSelection` is true when a rectangle is already
 *  marked (by the mouse or by visual mode): `y`/`d` then act on it. */
export function stepGridKeys(
  state: GridKeyState,
  caret: GridCaret,
  key: string,
  bounds: GridBounds,
  hasSelection: boolean,
): GridKeyResult {
  const idle = { ...IDLE_GRID_KEYS, visual: state.visual };
  const stop = (action: GridKeyAction | null, visual = state.visual): GridKeyResult => ({
    state: { ...IDLE_GRID_KEYS, visual },
    action,
    handled: true,
  });

  // Escape drops a half-typed command and any rectangle — and is handed
  // BACK anyway, because the page has its own Escape (closing menus) and
  // the two should both happen.
  if (key === 'Escape') {
    return { state: IDLE_GRID_KEYS, action: { kind: 'reset' }, handled: false };
  }

  // A `g` only ever waits for a second one here.
  if (state.pendingG) {
    if (key === 'g') {
      const count = digits(state.count);
      const to = moveCaret(caret, 'firstRow', count, bounds);
      if (state.operator) {
        return stop({
          kind: 'operate',
          operator: state.operator,
          ...spanFor(caret, 'firstRow', to, bounds),
        });
      }
      return stop({ kind: 'move', to });
    }
    return { state: { ...state, pendingG: false }, action: null, handled: false };
  }

  if (/^[0-9]$/.test(key) && !(key === '0' && state.count === '')) {
    return { state: { ...state, count: state.count + key }, action: null, handled: true };
  }

  const motion = motionFor(key, state.count);
  if (motion) {
    const count = digits(state.count) * (state.operator ? digits(state.opCount) : 1);
    const to = moveCaret(caret, motion, count, bounds);
    if (state.operator) {
      return stop({
        kind: 'operate',
        operator: state.operator,
        ...spanFor(caret, motion, to, bounds),
      });
    }
    return stop({ kind: 'move', to });
  }

  if (key === 'g') {
    return { state: { ...state, pendingG: true }, action: null, handled: true };
  }

  if (key === 'y' || key === 'd') {
    if (state.operator === key) {
      // `dd` / `yy`: this row and the count−1 below it.
      const count = digits(state.count) * digits(state.opCount);
      const last = Math.min(Math.max(0, bounds.rows - 1), caret.row + count - 1);
      return stop({
        kind: 'operate',
        operator: key,
        rows: [caret.row, last],
        columns: { start: 0, end: Math.max(1, bounds.columns) },
      });
    }
    if (!state.operator && (state.visual || hasSelection)) {
      return stop({ kind: 'operateSelection', operator: key }, false);
    }
    return {
      state: { ...idle, operator: key, opCount: state.count },
      action: null,
      handled: true,
    };
  }

  if (key === 'x') {
    const count = digits(state.count);
    if (state.visual || hasSelection)
      return stop({ kind: 'operateSelection', operator: 'd' }, false);
    return stop({
      kind: 'operate',
      operator: 'd',
      rows: [caret.row, caret.row],
      columns: { start: caret.col, end: Math.min(bounds.columns, caret.col + count) },
    });
  }

  if (key === 'p') {
    return stop({ kind: 'paste', at: caret.col });
  }

  if (key === 'v') {
    return stop({ kind: 'visual', on: !state.visual }, !state.visual);
  }

  // Not ours: hand it back with any half-typed command dropped, so a
  // stray key cannot leave a count armed.
  return { state: idle, action: null, handled: false };
}
