// In-app module documentation modal, opened from the module context menu.
// The jack/knob/param tables come straight from the module's live manifest
// (so they never drift from the engine); moduleDocs.ts supplies the prose.

import type { JackDecl, KnobConfig, Manifest, OutputDecl, ParamDecl } from '../types';
import { getModuleDoc, jackDoc, SIGNAL_CONVENTIONS, type ModuleDoc } from '../moduleDocs';

export interface DocsPanelProps {
  typeId: string;
  manifest: Manifest;
  onClose(): void;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000));

/** Human description of an input's control: knob style + range, or the
 *  default wire-only signal range. */
function controlLabel(knob: KnobConfig | null | undefined): string {
  if (!knob) return 'signal (-10..+10 V)';
  const range = `${fmt(knob.min)}..${fmt(knob.max)}`;
  switch (knob.style) {
    case 'button':
      return `button (${range})`;
    case 'switch':
      return `switch (${range})`;
    case 'stepped':
      return `stepped knob (${range}${knob.steps ? `, ${knob.steps} steps` : ''})`;
    default:
      return `knob (${range})`;
  }
}

/** Collapse numbered jack families (cv1..cv16 -> one "cv1 .. cv16" row) so
 *  large manifests stay readable. A family is only collapsed when its docs
 *  come from a shared `#` entry (or it has no docs at all) — jacks with
 *  their own exact doc entry (clock's div2/div4/...) keep their own row.
 *  Declaration order is preserved. */
interface JackRow {
  id: string;
  name: string;
  control: string;
  doc?: string;
}

function collapseRows(rows: JackRow[], docMap: Record<string, string> | undefined): JackRow[] {
  const groups = new Map<string, JackRow[]>();
  for (const row of rows) {
    const base = row.id.replace(/\d+/g, '#');
    if (base === row.id || docMap?.[row.id] !== undefined) continue;
    const g = groups.get(base);
    if (g) g.push(row);
    else groups.set(base, [row]);
  }
  const out: JackRow[] = [];
  const emitted = new Set<string>();
  for (const row of rows) {
    const base = row.id.replace(/\d+/g, '#');
    const g = groups.get(base);
    if (!g || g.length < 2 || !g.includes(row)) {
      out.push(row);
      continue;
    }
    if (emitted.has(base)) continue;
    emitted.add(base);
    const last = g[g.length - 1];
    out.push({
      ...row,
      id: `${row.id} .. ${last.id}`,
      name: `${row.name} .. ${last.name}`,
    });
  }
  return out;
}

function inputRows(inputs: JackDecl[], doc?: ModuleDoc): JackRow[] {
  return collapseRows(
    inputs.map((i) => ({
      id: i.id,
      name: i.name,
      control: controlLabel(i.knob),
      doc: jackDoc(doc?.inputs, i.id),
    })),
    doc?.inputs,
  );
}

function outputRows(outputs: OutputDecl[], doc?: ModuleDoc): JackRow[] {
  return collapseRows(
    outputs.map((o) => ({
      id: o.id,
      name: o.name,
      control: 'signal (-10..+10 V)',
      doc: jackDoc(doc?.outputs, o.id),
    })),
    doc?.outputs,
  );
}

function paramRows(params: ParamDecl[], doc?: ModuleDoc): JackRow[] {
  return params.map((p) => ({
    id: p.id,
    name: p.name,
    control:
      p.min !== undefined && p.max !== undefined
        ? `${p.type ?? 'param'} (${fmt(p.min)}..${fmt(p.max)})`
        : (p.type ?? 'param'),
    doc: jackDoc(doc?.params, p.id),
  }));
}

function JackTable({ title, rows }: { title: string; rows: JackRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="docs-section">
      <h4>{title}</h4>
      <table className="docs-jacks">
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-testid={`docs-row-${row.id}`}>
              <td className="docs-jack-name">
                {row.name} <code>{row.id}</code>
              </td>
              <td className="docs-jack-control">{row.control}</td>
              <td className="docs-jack-doc">{row.doc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function DocsPanel({ typeId, manifest, onClose }: DocsPanelProps) {
  const doc = getModuleDoc(typeId, manifest.abi);
  return (
    <div className="docs-backdrop" data-testid="docs-panel" onClick={onClose}>
      <div className="docs-panel" onClick={(e) => e.stopPropagation()}>
        <header className="docs-header">
          <h3>
            {manifest.name} <code className="docs-type-id">{typeId}</code>
          </h3>
          {manifest.category && <span className="docs-category">{manifest.category}</span>}
          <button className="docs-close" data-testid="docs-close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="docs-body">
          <p className="docs-summary" data-testid="docs-summary">
            {doc?.summary ?? 'No documentation for this module type yet.'}
          </p>
          <p className="docs-conventions">{SIGNAL_CONVENTIONS}</p>
          <JackTable title="Inputs" rows={inputRows(manifest.inputs, doc)} />
          <JackTable title="Outputs" rows={outputRows(manifest.outputs, doc)} />
          <JackTable title="Params" rows={paramRows(manifest.params, doc)} />
          {doc?.examples && doc.examples.length > 0 && (
            <section className="docs-section">
              <h4>Typical patches</h4>
              <ul className="docs-examples" data-testid="docs-examples">
                {doc.examples.map((ex) => (
                  <li key={ex}>{ex}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
