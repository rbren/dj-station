// Cmd+M module picker: a modal gallery of every module type the engine can
// instantiate (built-ins + discovered extensions), each shown as its actual
// panel rendered zoomed out. Click an entry to drop it at the center of the
// current view, or drag it onto the canvas (the modal hides itself during
// the drag so the rack underneath can take the drop). Includes a category
// filter and a search box.

import { useEffect, useMemo, useState } from 'react';
import type { KnobState, Manifest, ModuleHandle } from '../types';
import { positionForValue } from './Knob';
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

/** Inert handle for preview panels: params read their manifest defaults,
 *  taps read silence, nothing writes to the engine. */
function previewHandle(m: Manifest): ModuleHandle {
  return {
    paramValue: (id) => {
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

function PickerEntry({ m, onAdd, onDragging }: PickerEntryProps) {
  return (
    <div
      className="picker-entry"
      data-testid={`library-add-${m.id}`}
      data-tip={`${m.id} v${m.version}`}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(MODULE_DRAG_TYPE, m.id);
        e.dataTransfer.effectAllowed = 'copy';
        onDragging(true);
      }}
      onDragEnd={() => onDragging(false)}
      onClick={() => onAdd(m.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onAdd(m.id);
      }}
    >
      <div className="picker-preview">
        <div className="picker-preview-panel" style={{ transform: `scale(${PICKER_SCALE})` }}>
          {/* Custom UIs are deliberately NOT rendered in previews: several
              poll the live engine or grab hardware (camera). The base panel
              (jacks, knobs, layout) is the recognizable silhouette. */}
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
}

export function ModulePicker({
  modules,
  onAdd,
  onClose,
}: {
  modules: Manifest[];
  onAdd(typeId: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const allGroups = useMemo(() => groupByCategory(modules), [modules]);
  const categories = allGroups.map(([c]) => c);
  const shown = useMemo(() => {
    const matched = filterModules(modules, query);
    return groupByCategory(category ? matched.filter((m) => categoryOf(m) === category) : matched);
  }, [modules, query, category]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // Capture phase so the app's global Escape handler (clear selection /
    // pending wire) doesn't also fire while the picker is up.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

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
                  <PickerEntry key={m.id} m={m} onAdd={onAdd} onDragging={setDragging} />
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
      </div>
    </div>
  );
}
