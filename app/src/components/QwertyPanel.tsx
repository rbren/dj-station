// Panel body for the built-in QWERTY module: while it's mounted, window
// key listeners forward alphanumeric + space key transitions to the
// engine (keydown = gate high, keyup = gate low). The jacks themselves
// render through the module's output-group layout (keyboard rows);
// this component only owns the listeners and a capture toggle.

import { useEffect, useRef, useState } from 'react';

/** Keys the module maps (mirrors the engine's jack table). */
const KEY_RE = /^[a-z0-9 ]$/;

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export interface QwertyPanelProps {
  instance: string;
  /** Forward one key transition (lowercased `event.key`). */
  onKey(key: string, down: boolean): void;
}

export function QwertyPanel({ instance, onKey }: QwertyPanelProps) {
  const [enabled, setEnabled] = useState(true);
  // Keys currently held, so OS key-repeat doesn't retrigger gates and a
  // keyup always releases what its keydown pressed.
  const held = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;
    const down = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (
        e.repeat ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        isTyping(e.target) ||
        !KEY_RE.test(key) ||
        held.current.has(key)
      ) {
        return;
      }
      held.current.add(key);
      onKey(key, true);
    };
    const up = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (!held.current.delete(key)) return;
      onKey(key, false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      // Release anything still held so gates don't stick high.
      for (const key of held.current) onKey(key, false);
      held.current.clear();
    };
  }, [enabled, onKey]);

  return (
    <div className="qwerty-panel" data-testid={`qwerty-panel-${instance}`}>
      <label className="qwerty-capture">
        <input
          type="checkbox"
          checked={enabled}
          data-testid={`qwerty-capture-${instance}`}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        capture keys
      </label>
      <span className="qwerty-hint">hold a key = 10 V gate on its jack</span>
    </div>
  );
}
