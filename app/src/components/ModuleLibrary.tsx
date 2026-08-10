// Left-hand module library: every module type the engine can instantiate
// (built-ins + discovered extensions), grouped into collapsible categories
// with a search box. Drag an entry onto the rack (or click it) to drop it in.

import { useMemo, useState } from 'react';
import type { Manifest } from '../types';

/** dataTransfer type used when dragging a module out of the library. */
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

function LibraryEntry({ m, onAdd }: { m: Manifest; onAdd(typeId: string): void }) {
  return (
    <button
      className="library-entry"
      data-testid={`library-add-${m.id}`}
      data-tip={`${m.id} v${m.version}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(MODULE_DRAG_TYPE, m.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => onAdd(m.id)}
    >
      <span className="library-name">{m.name}</span>
      <span className="library-io">
        {m.inputs.length} in · {m.outputs.length} out
      </span>
    </button>
  );
}

export function ModuleLibrary({
  modules,
  onAdd,
}: {
  modules: Manifest[];
  onAdd(typeId: string): void;
}) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => groupByCategory(filterModules(modules, query)), [modules, query]);
  const searching = query.trim().length > 0;

  return (
    <aside className="module-library" data-testid="module-library">
      <h2>Modules</h2>
      <input
        className="library-search"
        data-testid="library-search"
        type="search"
        placeholder="Search modules…"
        aria-label="Search modules"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {groups.map(([category, entries]) => {
        // While searching, every matching group stays expanded so results
        // are never hidden behind a collapsed heading.
        const isOpen = searching || !collapsed[category];
        return (
          <section key={category} className="library-category">
            <button
              className="library-category-toggle"
              data-testid={`library-category-${category}`}
              aria-expanded={isOpen}
              onClick={() => setCollapsed((c) => ({ ...c, [category]: !c[category] }))}
            >
              <span className="library-category-caret">{isOpen ? '▾' : '▸'}</span>
              {category}
              <span className="library-category-count">{entries.length}</span>
            </button>
            {isOpen && entries.map((m) => <LibraryEntry key={m.id} m={m} onAdd={onAdd} />)}
          </section>
        );
      })}
      {modules.length === 0 && <p className="library-empty">no modules found</p>}
      {modules.length > 0 && groups.length === 0 && (
        <p className="library-empty" data-testid="library-no-results">
          no modules match “{query}”
        </p>
      )}
    </aside>
  );
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
