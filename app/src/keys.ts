// Keyboard primitives shared by every page — the bottom layer of the
// vim-flavoured command layer (`keyboard.tsx` is the React half).
//
// Two rules hold everywhere and are enforced here rather than page by
// page:
//   1. A key never fires a shortcut while text is being entered
//      (`isEditableTarget`); the ONE exception is a camera/zoom key,
//      which App handles itself and documents there.
//   2. h/j/k/l and the arrow keys ALWAYS mean the same thing
//      (`directionFor`), so a list, a rack and the grid are walked with
//      the same fingers.

/** Which way a navigation key points. */
export type Direction = 'up' | 'down' | 'left' | 'right';

/** True when a shortcut keydown should be left to a form control.
 *
 *  Anything that takes typed text counts: the form controls themselves,
 *  contenteditable regions (including a press that landed on a child of
 *  one), the ARIA text roles a custom widget announces itself with, and
 *  an explicit `data-keys="text"` opt-out for anything else that wants
 *  the keyboard to itself. */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return true;
  if (t.isContentEditable) return true;
  const role = t.getAttribute('role');
  if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
  return t.closest('[contenteditable="true"], [data-keys="text"]') !== null;
}

/** True for a bare keypress — no cmd/ctrl/alt. Shift is allowed, since
 *  shifted characters (`:`, `?`, `$`) are how half the layer is typed. */
export function isBareKey(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** The direction a key points, arrows and hjkl alike, or null. Shifted
 *  H/J/K/L count too, so an extend-the-selection binding can use them. */
export function directionFor(key: string): Direction | null {
  switch (key) {
    case 'ArrowUp':
    case 'k':
    case 'K':
      return 'up';
    case 'ArrowDown':
    case 'j':
    case 'J':
      return 'down';
    case 'ArrowLeft':
    case 'h':
    case 'H':
      return 'left';
    case 'ArrowRight':
    case 'l':
    case 'L':
      return 'right';
    default:
      return null;
  }
}

/** Step an index through a list of `length` items, clamped at both ends.
 *  `null` (nothing chosen yet) enters the list at its first or last item
 *  depending on which way the key pointed. */
export function stepIndex(
  index: number | null,
  delta: number,
  length: number,
  wrap = false,
): number | null {
  if (length <= 0) return null;
  if (index === null) return delta >= 0 ? 0 : length - 1;
  const next = index + delta;
  if (wrap) return ((next % length) + length) % length;
  return Math.min(length - 1, Math.max(0, next));
}

/** How far a direction moves a vertical list (a list is walked with
 *  up/down; left/right is left to the page). */
export function listDelta(direction: Direction): number {
  return direction === 'down' ? 1 : direction === 'up' ? -1 : 0;
}
