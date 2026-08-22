// File-menu keyboard shortcuts: cmd/ctrl+S (Save Patch), cmd/ctrl+O
// (Open Patch…) and cmd/ctrl+N (New Patch). The actions are the exact
// callbacks the native File menu triggers in App.tsx, so New/Open inherit
// the unsaved-changes prompt flow. Shortcuts never fire while a form
// control has focus or while a modal dialog owns the keyboard.

import { useEffect } from 'react';

/** True when a shortcut keydown should be left to a form control. */
export function isEditableTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'SELECT' ||
      t.tagName === 'TEXTAREA' ||
      t.isContentEditable)
  );
}

export interface FileShortcuts {
  /** cmd/ctrl+S: save under the current name. */
  save: () => unknown;
  /** cmd/ctrl+O: open the Open Patch… dialog. */
  open: () => unknown;
  /** cmd/ctrl+N: New Patch, behind the unsaved-changes guard. */
  create: () => unknown;
  /** A modal dialog owns the keyboard: shortcuts stay quiet. */
  modalOpen: boolean;
}

export function useFileShortcuts({ save, open, create, modalOpen }: FileShortcuts): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // cmd on macOS, ctrl elsewhere (like every other app shortcut, either
      // modifier is accepted); bare modifier only, so cmd+shift+S stays free.
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== 's' && key !== 'o' && key !== 'n') return;
      if (modalOpen || isEditableTarget(e.target)) return;
      e.preventDefault();
      if (key === 's') void save();
      else if (key === 'o') void open();
      else void create();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, open, create, modalOpen]);
}
