// Rack-scoped keyboard handling must go quiet when another page (library,
// clip, …) is showing: the rack stays MOUNTED on other pages (display:
// none preserves panel state), so its window key listeners — QWERTY
// gates, MIDI key bindings, the rack shortcut set — would otherwise keep
// firing while the user types into a search box. App provides
// `view === 'rack'`; consumers must also RELEASE anything held (gates,
// notes) when the value flips false, or a key held across a tab switch
// sticks high forever (its keyup is never seen). Global Save/Open/New
// (fileShortcuts.ts) and per-modal handlers (ContextMenu, ModulePicker,
// KnobConfigMenu) are deliberately NOT gated by this.

import { createContext, useContext } from 'react';

/** True while the rack page is active. Defaults true so panels rendered
 *  outside App (unit tests, the stress harness) stay live. */
export const RackKeysContext = createContext(true);

export function useRackKeysActive(): boolean {
  return useContext(RackKeysContext);
}
