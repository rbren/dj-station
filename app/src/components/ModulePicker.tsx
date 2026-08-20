// Cmd+M module picker: a modal gallery of every module type the engine can
// instantiate (built-ins + discovered extensions), each shown as its actual
// panel rendered zoomed out. Click an entry to drop it at the center of the
// current view, or drag it onto the canvas (the modal hides itself during
// the drag so the rack underneath can take the drop). Includes a category
// filter and a search box.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { engine, type MacroPreviewNode } from '../engine';
import type { KnobState, Manifest, ModuleHandle } from '../types';
import { ContextMenu } from './ContextMenu';
import { previewUI } from './customUIs';
import { ErrorBoundary } from './ErrorBoundary';
import { mapPosition, positionForValue } from './Knob';
import { ModulePanel } from './ModulePanel';

/** dataTransfer type used when dragging a module out of the picker. */
export const MODULE_DRAG_TYPE = 'application/dj-module';

/** Display order for the engine's canonical categories; anything else
 *  (including user-defined categories) sorts after these, alphabetically. */
export const CATEGORY_ORDER = [
  'Sources',
  'Shaping',
  'Modulation',
  'Utilities',
  'Clock & Sequencing',
  'Effects',
  'Analysis & I/O',
  'DJ',
  'Macros',
];

const UNCATEGORIZED = 'Other';

function categoryOf(m: Manifest): string {
  // Macros (PRD §6) always group together regardless of their synthesized
  // manifest category.
  if (m.abi === 'macro-1') return 'Macros';
  return m.category ?? UNCATEGORIZED;
}

/** Modules whose name, id or category matches every whitespace-separated
 *  term of `query` (case-insensitive). An empty query matches everything. */
export function filterModules(modules: Manifest[], query: string): Manifest[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return modules;
  return modules.filter((m) => {
    const haystack = `${m.name} ${m.id} ${categoryOf(m)}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

/** Group modules by category, ordered by CATEGORY_ORDER then alphabetically. */
export function groupByCategory(modules: Manifest[]): [string, Manifest[]][] {
  const groups = new Map<string, Manifest[]>();
  for (const m of modules) {
    const cat = categoryOf(m);
    const list = groups.get(cat);
    if (list) list.push(m);
    else groups.set(cat, [m]);
  }
  const rank = (c: string) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i < 0 ? CATEGORY_ORDER.length : i;
  };
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Generate a fresh instance id like "osc2" from a type id and taken ids. */
export function nextInstanceId(typeId: string, taken: Set<string>): string {
  const base = typeId.split('.').pop() ?? 'mod';
  const short = base.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'mod';
  for (let n = 1; ; n++) {
    const candidate = `${short}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const noop = () => {};

/** Inert handle for preview panels: knob-backed inputs and params read
 *  their manifest defaults (custom UIs resolve both through paramValue,
 *  like the live handle in RackModule), taps read silence, nothing
 *  writes to the engine. */
function previewHandle(m: Manifest): ModuleHandle {
  return {
    paramValue: (id) => {
      const input = m.inputs.find((i) => i.id === id);
      if (input?.knob) return input.default ?? mapPosition(input.knob, 0);
      const d = m.params.find((p) => p.id === id)?.default;
      return typeof d === 'boolean' ? (d ? 1 : 0) : (d ?? 0);
    },
    setParam: noop,
    signalTap: () => ({
      instantaneous: 0,
      rms_100ms: 0,
      display: 0,
      volatility: 0,
      is_fast: false,
    }),
    size: { w: 0, h: 0 },
  };
}

/** Knob states at each input's manifest default, so previews show panels
 *  the way they instantiate (not every knob slammed to its minimum). */
function previewKnobs(m: Manifest): Record<string, KnobState> {
  const knobs: Record<string, KnobState> = {};
  for (const input of m.inputs) {
    if (!input.knob) continue;
    knobs[input.id] = {
      position: positionForValue(input.knob, input.default ?? input.knob.min),
      atten: 0,
      offset: 0,
      config: input.knob,
    };
  }
  return knobs;
}

/** How far previews are zoomed out. */
export const PICKER_SCALE = 0.55;

/** Preview handle for a macro's internal node: knob-backed inputs read
 *  the definition-saved knob state when there is one, otherwise the
 *  manifest default (same resolution a fresh instantiation applies). */
function macroNodeHandle(n: MacroPreviewNode): ModuleHandle {
  const base = previewHandle(n.manifest);
  return {
    ...base,
    paramValue: (id) => {
      const input = n.manifest.inputs.find((i) => i.id === id);
      const saved = n.knobs[id];
      if (input?.knob && saved) return mapPosition(saved.config ?? input.knob, saved.position);
      return base.paramValue(id);
    },
  };
}

/** Fallback tiling for definitions saved before positions were recorded. */
function tilePosition(index: number): { x: number; y: number } {
  return { x: (index % 2) * 240, y: Math.floor(index / 2) * 260 };
}

/** Composite preview of a macro: the panels a fresh instance expands to,
 *  arranged by the definition's saved layout and scaled to fit the preview
 *  window (a mini screenshot of the group, rendered live). Falls back to
 *  the synthesized interface panel while loading or when the engine is
 *  unavailable (headless tests). */
function MacroPreview({ m }: { m: Manifest }) {
  const [nodes, setNodes] = useState<MacroPreviewNode[] | null>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(PICKER_SCALE);

  useEffect(() => {
    let live = true;
    void engine.macroPreview(m.id).then((n) => {
      if (live && n && n.length > 0) setNodes(n);
    });
    return () => {
      live = false;
    };
  }, [m.id]);

  // Scale-to-fit: measure the placed panels' bounding box (transform does
  // not affect offset geometry, so this never feeds back) and shrink the
  // group to the preview window; never zoom past the single-module scale.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    const avail = inner?.parentElement;
    if (!inner || !avail || !nodes) return;
    let w = 0;
    let h = 0;
    for (const child of inner.children) {
      const el = child as HTMLElement;
      w = Math.max(w, el.offsetLeft + el.offsetWidth);
      h = Math.max(h, el.offsetTop + el.offsetHeight);
    }
    if (w > 0 && h > 0) {
      const pad = 16; // .picker-preview padding, both sides
      setScale(
        Math.min(PICKER_SCALE, (avail.clientWidth - pad) / w, (avail.clientHeight - pad) / h),
      );
    }
  }, [nodes]);

  if (!nodes) {
    return (
      <div className="picker-preview-panel" style={{ transform: `scale(${PICKER_SCALE})` }}>
        <ModulePanel
          instanceId={`preview-${m.id}`}
          manifest={m}
          knobs={previewKnobs(m)}
          wired={{}}
          handle={previewHandle(m)}
          onKnobPosition={noop}
          onKnobConfig={noop}
          onAttenOffset={noop}
        />
      </div>
    );
  }
  return (
    <div
      className="picker-preview-panel picker-preview-macro"
      data-testid={`macro-preview-${m.id}`}
      ref={innerRef}
      style={{ transform: `scale(${scale})` }}
    >
      {nodes.map((n, i) => {
        const pos = n.position ? { x: n.position[0], y: n.position[1] } : tilePosition(i);
        return (
          <ModulePanel
            key={n.id}
            instanceId={`preview-${m.id}/${n.id}`}
            manifest={n.manifest}
            knobs={{ ...previewKnobs(n.manifest), ...n.knobs }}
            wired={{}}
            handle={macroNodeHandle(n)}
            customUI={previewUI(n.ext)}
            position={pos}
            onKnobPosition={noop}
            onKnobConfig={noop}
            onAttenOffset={noop}
          />
        );
      })}
    </div>
  );
}

function PickerEntry({ m, onAdd, onDragging, onMacroMenu }: PickerEntryProps) {
  // WebKit (the Tauri webview) follows `contextmenu` with a `click` on the
  // same target — Chrome/Firefox fire `auxclick` instead — so without a
  // guard a right-click falls through to the add-on-click handler and the
  // macro lands in the rack instead of showing its manage menu. The
  // contextmenu handler marks the gesture and the paired click is
  // swallowed; a genuine left click starts with a fresh button-0 mousedown,
  // which clears the mark first.
  const menuGesture = useRef(false);
  return (
    <div
      className="picker-entry"
      data-testid={`library-add-${m.id}`}
      data-tip={m.id}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(MODULE_DRAG_TYPE, m.id);
        e.dataTransfer.effectAllowed = 'copy';
        onDragging(true);
      }}
      onDragEnd={() => onDragging(false)}
      onMouseDown={(e) => {
        if (e.button === 0) menuGesture.current = false;
      }}
      onClick={(e) => {
        if (menuGesture.current || e.button !== 0) {
          menuGesture.current = false;
          return;
        }
        onAdd(m.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        menuGesture.current = true;
        if (m.abi === 'macro-1') onMacroMenu?.(m, e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onAdd(m.id);
      }}
    >
      <div className="picker-preview">
        {/* The custom UI (when preview-safe — see customUIs.ts) is the
            module's most recognizable face, so previews render it against
            the inert handle; macros render the whole group of panels their
            definition expands to. A preview crash degrades to just the
            caption, never takes the gallery down. */}
        <ErrorBoundary context={`preview ${m.id}`} fallback={() => null}>
          {m.abi === 'macro-1' ? (
            <MacroPreview m={m} />
          ) : (
            <div className="picker-preview-panel" style={{ transform: `scale(${PICKER_SCALE})` }}>
              <ModulePanel
                instanceId={`preview-${m.id}`}
                displayName={m.name}
                manifest={m}
                knobs={previewKnobs(m)}
                wired={{}}
                handle={previewHandle(m)}
                customUI={previewUI(m.id)}
                onKnobPosition={noop}
                onKnobConfig={noop}
                onAttenOffset={noop}
              />
            </div>
          )}
        </ErrorBoundary>
      </div>
      <div className="picker-entry-caption">
        <span className="picker-entry-name">{m.name}</span>
        <span className="picker-entry-io">
          {m.inputs.length} in · {m.outputs.length} out
        </span>
      </div>
    </div>
  );
}

interface PickerEntryProps {
  m: Manifest;
  onAdd(typeId: string): void;
  /** Entry drag started/ended — the modal hides itself while true so the
   *  canvas underneath can receive the drop. */
  onDragging(dragging: boolean): void;
  /** Right-click on a macro entry (undefined for non-macros / when the
   *  host wires no macro management). */
  onMacroMenu?(m: Manifest, x: number, y: number): void;
}

export function ModulePicker({
  modules,
  onAdd,
  onClose,
  onRenameMacro,
  onDeleteMacro,
}: {
  modules: Manifest[];
  onAdd(typeId: string): void;
  onClose(): void;
  onRenameMacro?(macroId: string, name: string): Promise<void> | void;
  onDeleteMacro?(macroId: string): Promise<void> | void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Right-clicked macro entry: menu position + which dialog is up.
  const [macroMenu, setMacroMenu] = useState<null | { m: Manifest; x: number; y: number }>(null);
  const [renaming, setRenaming] = useState<null | { m: Manifest; name: string }>(null);
  const [deleting, setDeleting] = useState<Manifest | null>(null);
  const manageMacros = Boolean(onRenameMacro || onDeleteMacro);

  const allGroups = useMemo(() => groupByCategory(modules), [modules]);
  const categories = allGroups.map(([c]) => c);
  const shown = useMemo(() => {
    const matched = filterModules(modules, query);
    return groupByCategory(category ? matched.filter((m) => categoryOf(m) === category) : matched);
  }, [modules, query, category]);

  const dialogUp = macroMenu !== null || renaming !== null || deleting !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        // Peel one layer at a time: menu/dialog first, then the picker.
        if (dialogUp) {
          setMacroMenu(null);
          setRenaming(null);
          setDeleting(null);
        } else {
          onClose();
        }
      }
    };
    // Capture phase so the app's global Escape handler (clear selection /
    // pending wire) doesn't also fire while the picker is up.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, dialogUp]);

  return (
    <div
      className={`module-picker-backdrop${dragging ? ' module-picker-dragging' : ''}`}
      data-testid="module-picker"
      onClick={onClose}
    >
      <div className="module-picker" onClick={(e) => e.stopPropagation()}>
        <header className="module-picker-header">
          <h2>Add Module</h2>
          <input
            className="library-search"
            data-testid="library-search"
            type="search"
            placeholder="Search modules…"
            aria-label="Search modules"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="module-picker-close"
            data-testid="module-picker-close"
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        <div className="picker-categories">
          <button
            className={`picker-category${category === null ? ' active' : ''}`}
            data-testid="picker-category-all"
            onClick={() => setCategory(null)}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c}
              className={`picker-category${category === c ? ' active' : ''}`}
              data-testid={`picker-category-${c}`}
              onClick={() => setCategory((prev) => (prev === c ? null : c))}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="picker-body">
          {shown.map(([cat, entries]) => (
            <section key={cat} className="picker-group">
              <h3 className="picker-group-title">{cat}</h3>
              <div className="picker-grid">
                {entries.map((m) => (
                  <PickerEntry
                    key={m.id}
                    m={m}
                    onAdd={onAdd}
                    onDragging={setDragging}
                    onMacroMenu={
                      manageMacros ? (mm, x, y) => setMacroMenu({ m: mm, x, y }) : undefined
                    }
                  />
                ))}
              </div>
            </section>
          ))}
          {modules.length === 0 && <p className="library-empty">no modules found</p>}
          {modules.length > 0 && shown.length === 0 && (
            <p className="library-empty" data-testid="library-no-results">
              no modules match “{query}”
            </p>
          )}
        </div>
        {macroMenu && (
          <ContextMenu
            x={macroMenu.x}
            y={macroMenu.y}
            onClose={() => setMacroMenu(null)}
            items={[
              {
                label: 'Rename Macro…',
                testId: 'picker-macro-rename',
                disabled: !onRenameMacro,
                onSelect: () => setRenaming({ m: macroMenu.m, name: macroMenu.m.name }),
              },
              {
                label: 'Delete Macro…',
                testId: 'picker-macro-delete',
                disabled: !onDeleteMacro,
                onSelect: () => setDeleting(macroMenu.m),
              },
            ]}
          />
        )}
        {renaming && (
          <div
            className="file-dialog-backdrop"
            data-testid="macro-rename-dialog"
            onClick={() => setRenaming(null)}
          >
            <form
              className="file-dialog"
              onClick={(e) => e.stopPropagation()}
              onSubmit={(e) => {
                e.preventDefault();
                const { m, name } = renaming;
                if (!name.trim()) return;
                setRenaming(null);
                void onRenameMacro?.(m.id, name.trim());
              }}
            >
              <h3>Rename Macro</h3>
              <input
                autoFocus
                data-testid="macro-rename-input"
                value={renaming.name}
                onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
              />
              <button type="submit" data-testid="macro-rename-confirm">
                Rename
              </button>
              <button
                type="button"
                className="file-dialog-cancel"
                onClick={() => setRenaming(null)}
              >
                Cancel
              </button>
            </form>
          </div>
        )}
        {deleting && (
          <div
            className="file-dialog-backdrop"
            data-testid="macro-delete-dialog"
            onClick={() => setDeleting(null)}
          >
            <div className="file-dialog" onClick={(e) => e.stopPropagation()}>
              <h3>Delete Macro?</h3>
              <p className="file-dialog-empty">
                Permanently delete “{deleting.name}” from your library? Patches that already use it
                keep their own copy; racks with live instances block deletion.
              </p>
              <button
                data-testid="macro-delete-confirm"
                onClick={() => {
                  const m = deleting;
                  setDeleting(null);
                  void onDeleteMacro?.(m.id);
                }}
              >
                Delete
              </button>
              <button className="file-dialog-cancel" onClick={() => setDeleting(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
