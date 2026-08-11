// App-styled right-click menu. The browser/Tauri default context menu is
// suppressed globally (see App.tsx); this component is what appears instead.
// Closes on outside mousedown, Escape, or after an item is selected.

import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** Short note rendered next to the label (e.g. "not implemented"). */
  hint?: string;
  testId?: string;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose(): void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Keep the menu on screen when opened near the right/bottom edge.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth)
      el.style.left = `${Math.max(0, window.innerWidth - r.width)}px`;
    if (r.bottom > window.innerHeight) {
      el.style.top = `${Math.max(0, window.innerHeight - r.height)}px`;
    }
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      data-testid="context-menu"
      style={{ left: x, top: y }}
      // A right-click on the menu itself must not re-open another menu
      // underneath it.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className="context-menu-item"
          data-testid={
            item.testId ?? `context-menu-${item.label.toLowerCase().replace(/\s+/g, '-')}`
          }
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect?.();
            onClose();
          }}
        >
          {item.label}
          {item.hint && <span className="context-menu-hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}
