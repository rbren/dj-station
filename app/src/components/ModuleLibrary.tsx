// Left-hand module library: every module type the engine can instantiate
// (built-ins + discovered extensions); clicking one drops it into the rack.

import type { Manifest } from '../types';

export function ModuleLibrary({
  modules,
  onAdd,
}: {
  modules: Manifest[];
  onAdd(typeId: string): void;
}) {
  return (
    <aside className="module-library" data-testid="module-library">
      <h2>Modules</h2>
      {modules.map((m) => (
        <button
          key={m.id}
          className="library-entry"
          data-testid={`library-add-${m.id}`}
          title={`${m.id} v${m.version}`}
          onClick={() => onAdd(m.id)}
        >
          <span className="library-name">{m.name}</span>
          <span className="library-io">
            {m.inputs.length} in · {m.outputs.length} out
          </span>
        </button>
      ))}
      {modules.length === 0 && <p className="library-empty">no modules found</p>}
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
