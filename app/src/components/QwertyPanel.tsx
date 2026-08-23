// Panel body for the built-in QWERTY module: while it's mounted, window
// key listeners forward alphanumeric + space key transitions to the
// engine (keydown = gate high until keyup). The jacks themselves render
// through the module's output-group layout (keyboard rows); this
// component only owns the listeners.

import { useEffect, useRef } from 'react';
import { useRackKeysActive } from '../keyScope';

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
  // The parent passes a fresh onKey closure every render (and telemetry
  // re-renders constantly); route through a ref so the listener effect
  // mounts once — re-running its cleanup would release held gates.
  const onKeyRef = useRef(onKey);
  useEffect(() => {
    onKeyRef.current = onKey;
  }, [onKey]);

  // Keys currently held, so OS key-repeat doesn't retrigger gates and a
  // keyup always releases what its keydown pressed. A ref (not effect
  // state) so the deactivation effect below can release them.
  const held = useRef(new Set<string>());

  // The rack page going inactive must release held gates NOW — the keyup
  // will land on another page where we no longer listen.
  const active = useRackKeysActive();
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      for (const key of held.current) onKeyRef.current(key, false);
      held.current.clear();
    }
  }, [active]);

  useEffect(() => {
    const heldKeys = held.current;
    const down = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (
        !activeRef.current ||
        e.repeat ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        isTyping(e.target) ||
        !KEY_RE.test(key) ||
        heldKeys.has(key)
      ) {
        return;
      }
      // Space would otherwise scroll the rack / click a focused button.
      e.preventDefault();
      heldKeys.add(key);
      onKeyRef.current(key, true);
    };
    const up = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (!heldKeys.delete(key)) return;
      onKeyRef.current(key, false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      // Release anything still held so gates don't stick high.
      for (const key of heldKeys) onKeyRef.current(key, false);
      heldKeys.clear();
    };
  }, []);

  return <div className="qwerty-panel" data-testid={`qwerty-panel-${instance}`} />;
}
