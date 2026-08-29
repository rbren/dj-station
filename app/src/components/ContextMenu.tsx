// App-styled right-click menu. The browser/Tauri default context menu is
// suppressed globally (see App.tsx); this component is what appears instead.
// Closes on outside mousedown, Escape, or after an item is selected.
//
// An item may carry `items` instead of an action: it then opens a submenu
// beside it (on hover or click) — how a module's built-in presets are
// offered. Submenus are deliberately one level deep.

import { useEffect, useRef, useState } from 'react';

export interface ContextMenuItem {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** Short note rendered next to the label (e.g. "not implemented"). */
  hint?: string;
  testId?: string;
  /** Submenu entries. An item that has them opens rather than acts. */
  items?: ContextMenuItem[];
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose(): void;
}

const testIdOf = (item: ContextMenuItem) =>
  item.testId ?? `context-menu-${item.label.toLowerCase().replace(/\s+/g, '-')}`;

/** A plain action row. */
function ActionItem({
  item,
  onClose,
  onMouseEnter,
}: {
  item: ContextMenuItem;
  onClose(): void;
  onMouseEnter?(): void;
}) {
  return (
    <button
      role="menuitem"
      className="context-menu-item"
      data-testid={testIdOf(item)}
      disabled={item.disabled}
      onMouseEnter={onMouseEnter}
      onClick={() => {
        if (item.disabled) return;
        item.onSelect?.();
        onClose();
      }}
    >
      {item.label}
      {item.hint && <span className="context-menu-hint">{item.hint}</span>}
    </button>
  );
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [openSub, setOpenSub] = useState<string | null>(null);

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
      {items.map((item) =>
        item.items ? (
          <div
            key={item.label}
            className="context-menu-sub"
            onMouseEnter={() => setOpenSub(item.label)}
          >
            <button
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={openSub === item.label}
              className="context-menu-item"
              data-testid={testIdOf(item)}
              disabled={item.disabled}
              onClick={() => !item.disabled && setOpenSub(item.label)}
            >
              {item.label}
              <span className="context-menu-arrow" aria-hidden="true">
                ›
              </span>
            </button>
            {openSub === item.label && (
              <div
                className="context-menu context-menu-flyout"
                role="menu"
                data-testid={`${testIdOf(item)}-menu`}
              >
                {item.items.map((child) => (
                  <ActionItem key={child.label} item={child} onClose={onClose} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <ActionItem
            key={item.label}
            item={item}
            onClose={onClose}
            onMouseEnter={() => setOpenSub(null)}
          />
        ),
      )}
    </div>
  );
}
