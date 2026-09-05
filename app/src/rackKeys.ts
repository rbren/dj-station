// The rack's half of the command layer: the letter every module answers
// to, the letters its jacks answer to, and the `:w` wire sentence built
// out of both.
//
// A module's letter is the first letter of the name ON ITS PANEL, with a
// number when several modules share it (`a1`, `a2` — see `aliasesFor`),
// which is why the chip in the title bar is the documentation. Jacks are
// lettered the same way, inputs and outputs in separate namespaces, so
// an Oscillator's `out` is `o` whatever its inputs are called; a manifest
// may also declare a jack's letter outright.
//
// `:w a1 o s i` reads "wire ADSR 1's out to the Scope's in" and is the
// whole reason the command tree has levels at all.

import { createContext, useContext } from 'react';
import { assignAliases, type CommandEntry } from './commands';
import type { NodeSnapshot } from './engine';
import type { Positions } from './rackStore';
import type { Manifest } from './types';
import { PAGE_KEYS } from './shortcuts';

/** Root keys the layer itself owns: a module whose letter would collide
 *  is reached through `:m` instead. */
export const ROOT_RESERVED: ReadonlySet<string> = new Set([...Object.values(PAGE_KEYS), 'w', 'm']);

export interface JackRef {
  instance: string;
  jack: string;
}

/** What a module is called on screen — the name its letter comes from. */
export function moduleLabel(node: NodeSnapshot): string {
  const name = node.display_name?.trim();
  if (name) return name;
  const id = node.instance_id;
  return id.slice(id.lastIndexOf('/') + 1);
}

/** instance id → its letter, over the modules as given. */
export function moduleAliases(nodes: readonly NodeSnapshot[]): Record<string, string> {
  const aliases = assignAliases(nodes.map((n) => ({ name: moduleLabel(n) })));
  const out: Record<string, string> = {};
  nodes.forEach((node, i) => {
    out[node.instance_id] = aliases[i];
  });
  return out;
}

export interface JackAlias {
  id: string;
  name: string;
  alias: string;
}

/** A module's input or output jacks with their letters. */
export function jackAliases(manifest: Manifest, kind: 'input' | 'output'): JackAlias[] {
  const decls = kind === 'input' ? manifest.inputs : manifest.outputs;
  const aliases = assignAliases(decls.map((d) => ({ name: d.name || d.id, alias: d.alias })));
  return decls.map((decl, i) => ({
    id: decl.id,
    name: decl.name || decl.id,
    alias: aliases[i],
  }));
}

/** The order the keyboard walks the rack in: reading order, banded by
 *  row so two panels side by side are neighbours. Modules the layout
 *  knows nothing about sort last, by id, so the walk is still stable. */
export function rackOrder(nodes: readonly NodeSnapshot[], positions: Positions): string[] {
  const at = (id: string) => positions[id] ?? { x: Number.MAX_SAFE_INTEGER, y: 0 };
  return [...nodes]
    .map((n) => n.instance_id)
    .sort((a, b) => {
      const pa = at(a);
      const pb = at(b);
      const band = Math.round(pa.y / 120) - Math.round(pb.y / 120);
      if (band !== 0) return band;
      if (pa.x !== pb.x) return pa.x - pb.x;
      return a.localeCompare(b);
    });
}

/** The module a half-typed `:w` is asking a jack of, with the letter for
 *  each of its jacks — resolved once here so every Jack can simply look
 *  its own id up. */
export interface JackPrompt {
  instance: string;
  kind: 'input' | 'output';
  /** jack id → its letter. */
  jacks: Record<string, string>;
}

/** What the rack's UI needs to draw its letters: the module map, and the
 *  jacks being asked for right now. */
export interface RackKeyHints {
  aliases: Record<string, string>;
  jackPrompt: JackPrompt | null;
}

/** The prompt for one module's inputs or outputs. */
export function jackPromptFor(node: NodeSnapshot, kind: 'input' | 'output'): JackPrompt {
  const jacks: Record<string, string> = {};
  for (const jack of jackAliases(node.manifest, kind)) jacks[jack.id] = jack.alias;
  return { instance: node.instance_id, kind, jacks };
}

const NO_HINTS: RackKeyHints = { aliases: {}, jackPrompt: null };

export const RackHintsContext = createContext<RackKeyHints>(NO_HINTS);

export function useRackHints(): RackKeyHints {
  return useContext(RackHintsContext);
}

export interface RackCommandDeps {
  nodes: readonly NodeSnapshot[];
  aliases: Record<string, string>;
  /** Make the wire. */
  connect(from: JackRef, to: JackRef): void;
  /** Put the keyboard selection on a module. */
  select(instance: string): void;
  /** Say whose jack letters the user is being asked for (null = done). */
  prompt(target: JackPrompt | null): void;
}

function withJacks(nodes: readonly NodeSnapshot[], kind: 'input' | 'output'): NodeSnapshot[] {
  return nodes.filter((n) =>
    kind === 'input' ? n.manifest.inputs.length > 0 : n.manifest.outputs.length > 0,
  );
}

/** The `:` entries the Rack (and the Decks, which is chrome around the
 *  same canvas) offers. */
export function rackCommandEntries(deps: RackCommandDeps): CommandEntry[] {
  const { nodes, aliases, connect, select, prompt } = deps;

  const inputJacks = (from: JackRef, target: NodeSnapshot): CommandEntry[] =>
    jackAliases(target.manifest, 'input').map((jack) => ({
      keys: jack.alias,
      label: `${moduleLabel(target)} · ${jack.name}`,
      group: 'Inputs',
      run: () => {
        prompt(null);
        connect(from, { instance: target.instance_id, jack: jack.id });
      },
    }));

  const toModules = (from: JackRef): CommandEntry[] =>
    withJacks(nodes, 'input').map((node) => ({
      keys: aliases[node.instance_id],
      label: moduleLabel(node),
      group: 'To module',
      next: () => {
        prompt(jackPromptFor(node, 'input'));
        return inputJacks(from, node);
      },
    }));

  const outputJacks = (source: NodeSnapshot): CommandEntry[] =>
    jackAliases(source.manifest, 'output').map((jack) => ({
      keys: jack.alias,
      label: `${moduleLabel(source)} · ${jack.name}`,
      group: 'Outputs',
      next: () => {
        prompt(null);
        return toModules({ instance: source.instance_id, jack: jack.id });
      },
    }));

  const fromModules = (): CommandEntry[] =>
    withJacks(nodes, 'output').map((node) => ({
      keys: aliases[node.instance_id],
      label: moduleLabel(node),
      group: 'From module',
      next: () => {
        prompt(jackPromptFor(node, 'output'));
        return outputJacks(node);
      },
    }));

  const selectEntries = (group: string): CommandEntry[] =>
    nodes.map((node) => ({
      keys: aliases[node.instance_id],
      label: moduleLabel(node),
      group,
      run: () => select(node.instance_id),
    }));

  return [
    { keys: 'w', label: 'wire from…', group: 'Rack', next: fromModules },
    { keys: 'm', label: 'module…', group: 'Rack', next: () => selectEntries('Modules') },
    // A module whose letter is one of the layer's own is still reachable
    // through `:m`; the rest answer to their letter directly.
    ...selectEntries('Modules').filter((entry) => !ROOT_RESERVED.has(entry.keys[0])),
  ];
}
