// The keyboard layer's pure halves: the key primitives every page shares
// (keys.ts), the `:` command tree and its letter generation (commands.ts),
// the Grid page's vim grammar (gridKeys.ts) and the rack's module/jack
// letters with the `:w` wire sentence built out of them (rackKeys.ts).

import { describe, expect, it, vi } from 'vitest';
import {
  aliasesFor,
  assignAliases,
  commitKey,
  eraseKey,
  feedKey,
  newSession,
  type CommandEntry,
  type CommandSession,
} from '../src/commands';
import { directionFor, isBareKey, isEditableTarget, stepIndex } from '../src/keys';
import { IDLE_GRID_KEYS, moveCaret, stepGridKeys, type GridKeyState } from '../src/gridKeys';
import {
  jackAliases,
  moduleAliases,
  rackCommandEntries,
  rackOrder,
  type JackRef,
} from '../src/rackKeys';
import type { NodeSnapshot } from '../src/engine';
import type { Manifest } from '../src/types';

describe('key primitives', () => {
  it('hjkl and the arrows are the same four directions', () => {
    expect(directionFor('h')).toBe('left');
    expect(directionFor('ArrowLeft')).toBe('left');
    expect(directionFor('j')).toBe('down');
    expect(directionFor('ArrowDown')).toBe('down');
    expect(directionFor('k')).toBe('up');
    expect(directionFor('ArrowUp')).toBe('up');
    expect(directionFor('l')).toBe('right');
    expect(directionFor('ArrowRight')).toBe('right');
    expect(directionFor('q')).toBeNull();
  });

  it('steps an index and enters an empty selection from the right end', () => {
    expect(stepIndex(null, 1, 4)).toBe(0);
    expect(stepIndex(null, -1, 4)).toBe(3);
    expect(stepIndex(3, 1, 4)).toBe(3);
    expect(stepIndex(0, -1, 4)).toBe(0);
    expect(stepIndex(3, 1, 4, true)).toBe(0);
    expect(stepIndex(0, 1, 0)).toBeNull();
  });

  it('leaves every kind of text entry alone', () => {
    const input = document.createElement('input');
    const div = document.createElement('div');
    const box = document.createElement('div');
    box.setAttribute('role', 'textbox');
    const optOut = document.createElement('div');
    optOut.setAttribute('data-keys', 'text');
    const inside = document.createElement('span');
    optOut.appendChild(inside);
    document.body.append(input, div, box, optOut);
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(box)).toBe(true);
    expect(isEditableTarget(inside)).toBe(true);
    expect(isEditableTarget(div)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    document.body.replaceChildren();
  });

  it('a bare key allows shift but no cmd/ctrl/alt', () => {
    expect(isBareKey({ metaKey: false, ctrlKey: false, altKey: false })).toBe(true);
    expect(isBareKey({ metaKey: true, ctrlKey: false, altKey: false })).toBe(false);
    expect(isBareKey({ metaKey: false, ctrlKey: true, altKey: false })).toBe(false);
    expect(isBareKey({ metaKey: false, ctrlKey: false, altKey: true })).toBe(false);
  });
});

describe('letters for a list of names', () => {
  it('uses the initial, and numbers the clashes apart', () => {
    expect(aliasesFor(['Oscillator', 'Scope', 'ADSR'])).toEqual(['o', 's', 'a']);
    expect(aliasesFor(['ADSR', 'ADSR', 'Scope'])).toEqual(['a1', 'a2', 's']);
  });

  it('pads the numbers so no letter is a prefix of another', () => {
    const names = Array.from({ length: 12 }, () => 'ADSR');
    const aliases = aliasesFor(names);
    expect(aliases[0]).toBe('a01');
    expect(aliases[11]).toBe('a12');
    expect(new Set(aliases).size).toBe(12);
  });

  it('falls back to a digit, then to x, for a name with no letters', () => {
    expect(aliasesFor(['808', '###'])).toEqual(['8', 'x']);
  });

  it('keeps a DECLARED letter and moves a derived clash out of its way', () => {
    expect(
      assignAliases([{ name: 'Gate', alias: 'g' }, { name: 'Gain' }, { name: 'Pitch' }]),
    ).toEqual(['g', 'g1', 'p']);
  });
});

describe('the : command tree', () => {
  const ran: string[] = [];
  const entries = (): CommandEntry[] => [
    { keys: 'r', label: 'Rack', run: () => ran.push('rack') },
    { keys: 'g', label: 'Grid', run: () => ran.push('grid') },
    { keys: '1', label: 'row 1', run: () => ran.push('row1') },
    { keys: '12', label: 'row 12', run: () => ran.push('row12') },
  ];

  it('fires a key that can only mean one thing', () => {
    const step = feedKey(newSession(entries()), 'g');
    expect(step.kind).toBe('run');
    if (step.kind === 'run') expect(step.entry.label).toBe('Grid');
  });

  it('waits when a key is also the start of a longer one, then Enter commits', () => {
    const typing = feedKey(newSession(entries()), '1');
    expect(typing.kind).toBe('session');
    if (typing.kind !== 'session') return;
    expect(typing.session.buffer).toBe('1');
    const committed = commitKey(typing.session);
    expect(committed.kind).toBe('run');
    if (committed.kind === 'run') expect(committed.entry.label).toBe('row 1');
    // …or the next digit resolves it instead.
    const longer = feedKey(typing.session, '2');
    expect(longer.kind).toBe('run');
    if (longer.kind === 'run') expect(longer.entry.label).toBe('row 12');
  });

  it('refuses a key nothing answers to, and keeps the session open', () => {
    const step = feedKey(newSession(entries()), 'q');
    expect(step.kind).toBe('session');
    if (step.kind !== 'session') return;
    expect(step.session.error).toContain('q');
    expect(step.session.buffer).toBe('');
  });

  it('backspace rubs out a key, and closes the session when there is none', () => {
    const typed = feedKey(newSession(entries()), '1');
    if (typed.kind !== 'session') throw new Error('expected a session');
    const rubbed = eraseKey(typed.session);
    expect(rubbed.kind).toBe('session');
    if (rubbed.kind === 'session') expect(rubbed.session.buffer).toBe('');
    expect(eraseKey(newSession(entries())).kind).toBe('close');
  });
});

// ---------------------------------------------------------------------------
// The Grid page's grammar
// ---------------------------------------------------------------------------

const BOUNDS = { rows: 4, columns: 32, barBeats: 4 };

/** Type a whole command at the state machine and hand back what the last
 *  key asked for. */
function type(keys: string[], caret = { row: 0, col: 0 }, hasSelection = false) {
  let state: GridKeyState = IDLE_GRID_KEYS;
  let last = null as ReturnType<typeof stepGridKeys>['action'];
  for (const key of keys) {
    const result = stepGridKeys(state, caret, key, BOUNDS, hasSelection);
    state = result.state;
    last = result.action;
    if (result.action?.kind === 'move') caret = result.action.to;
  }
  return { state, action: last, caret };
}

describe('grid motions', () => {
  it('moves a beat at a time, arrows and hjkl alike', () => {
    expect(type(['l']).caret).toEqual({ row: 0, col: 1 });
    expect(type(['ArrowRight']).caret).toEqual({ row: 0, col: 1 });
    expect(type(['l', 'l', 'h']).caret).toEqual({ row: 0, col: 1 });
    expect(type(['j', 'j']).caret).toEqual({ row: 2, col: 0 });
    expect(type(['ArrowDown', 'k']).caret).toEqual({ row: 0, col: 0 });
  });

  it('clamps at the edges instead of wrapping', () => {
    expect(type(['h']).caret).toEqual({ row: 0, col: 0 });
    expect(type(['k']).caret).toEqual({ row: 0, col: 0 });
    expect(type(['G', 'j']).caret.row).toBe(3);
  });

  it('a count repeats the motion', () => {
    expect(type(['8', 'l']).caret.col).toBe(8);
    expect(type(['1', '2', 'l']).caret.col).toBe(12);
    expect(type(['3', 'j']).caret.row).toBe(3);
  });

  it('treats a bar as a word for w, b and e', () => {
    expect(moveCaret({ row: 0, col: 0 }, 'word', 1, BOUNDS).col).toBe(4);
    expect(moveCaret({ row: 0, col: 5 }, 'word', 1, BOUNDS).col).toBe(8);
    expect(type(['3', 'w']).caret.col).toBe(12);
    // b from mid-bar goes to this bar's downbeat first, vim's rule.
    expect(moveCaret({ row: 0, col: 6 }, 'back', 1, BOUNDS).col).toBe(4);
    expect(moveCaret({ row: 0, col: 4 }, 'back', 1, BOUNDS).col).toBe(0);
    expect(moveCaret({ row: 0, col: 1 }, 'end', 1, BOUNDS).col).toBe(3);
    expect(moveCaret({ row: 0, col: 3 }, 'end', 1, BOUNDS).col).toBe(7);
  });

  it('0 and $ are the ends of the line, gg and G the ends of the page', () => {
    expect(type(['8', 'l', '0']).caret.col).toBe(0);
    expect(type(['$']).caret.col).toBe(31);
    expect(type(['G']).caret.row).toBe(3);
    expect(type(['G', 'g', 'g']).caret.row).toBe(0);
    expect(type(['3', 'g', 'g']).caret.row).toBe(2);
  });

  it('0 is a count digit once a count has started', () => {
    expect(type(['1', '0', 'l']).caret.col).toBe(10);
  });
});

describe('grid operators', () => {
  it('d with a motion takes the beats between here and there', () => {
    const { action } = type(['d', 'w']);
    expect(action).toEqual({
      kind: 'operate',
      operator: 'd',
      rows: [0, 0],
      columns: { start: 0, end: 4 },
    });
  });

  it('counts multiply on both sides of the operator', () => {
    const { action } = type(['2', 'd', '3', 'w']);
    expect(action?.kind).toBe('operate');
    if (action?.kind !== 'operate') return;
    expect(action.columns).toEqual({ start: 0, end: 24 });
  });

  it('dd and yy take whole rows, with a count', () => {
    const dd = type(['d', 'd']).action;
    expect(dd).toEqual({
      kind: 'operate',
      operator: 'd',
      rows: [0, 0],
      columns: { start: 0, end: 32 },
    });
    const yy = type(['2', 'y', 'y']).action;
    expect(yy?.kind).toBe('operate');
    if (yy?.kind !== 'operate') return;
    expect(yy.rows).toEqual([0, 1]);
    expect(yy.operator).toBe('y');
  });

  it('a row motion under an operator takes whole rows', () => {
    const { action } = type(['d', 'j']);
    expect(action?.kind).toBe('operate');
    if (action?.kind !== 'operate') return;
    expect(action.rows).toEqual([0, 1]);
    expect(action.columns).toEqual({ start: 0, end: 32 });
  });

  it('x deletes the beat under the caret, with a count', () => {
    const { action } = type(['3', 'x'], { row: 1, col: 5 });
    expect(action).toEqual({
      kind: 'operate',
      operator: 'd',
      rows: [1, 1],
      columns: { start: 5, end: 8 },
    });
  });

  it('p pastes at the caret', () => {
    expect(type(['p'], { row: 2, col: 7 }).action).toEqual({ kind: 'paste', at: 7 });
  });

  it('y and d act on a rectangle that is already marked', () => {
    expect(type(['y'], { row: 0, col: 0 }, true).action).toEqual({
      kind: 'operateSelection',
      operator: 'y',
    });
    expect(type(['x'], { row: 0, col: 0 }, true).action).toEqual({
      kind: 'operateSelection',
      operator: 'd',
    });
  });

  it('v turns visual mode on and off', () => {
    const on = stepGridKeys(IDLE_GRID_KEYS, { row: 0, col: 0 }, 'v', BOUNDS, false);
    expect(on.action).toEqual({ kind: 'visual', on: true });
    expect(on.state.visual).toBe(true);
    const off = stepGridKeys(on.state, { row: 0, col: 0 }, 'v', BOUNDS, false);
    expect(off.action).toEqual({ kind: 'visual', on: false });
    expect(off.state.visual).toBe(false);
  });

  it('Escape resets, and is still handed back to the page', () => {
    const counted = stepGridKeys(IDLE_GRID_KEYS, { row: 0, col: 0 }, '3', BOUNDS, false);
    expect(counted.state.count).toBe('3');
    const escaped = stepGridKeys(counted.state, { row: 0, col: 0 }, 'Escape', BOUNDS, false);
    expect(escaped.action).toEqual({ kind: 'reset' });
    expect(escaped.handled).toBe(false);
    expect(escaped.state).toEqual(IDLE_GRID_KEYS);
  });

  it('hands back a key it does not know, dropping a half-typed count', () => {
    const counted = stepGridKeys(IDLE_GRID_KEYS, { row: 0, col: 0 }, '3', BOUNDS, false);
    const stray = stepGridKeys(counted.state, { row: 0, col: 0 }, 'q', BOUNDS, false);
    expect(stray.handled).toBe(false);
    expect(stray.state.count).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The rack's letters
// ---------------------------------------------------------------------------

function manifest(id: string, name: string, ins: string[], outs: string[]): Manifest {
  return {
    id,
    name,
    version: '0.1.0',
    abi: 'wasm-1',
    inputs: ins.map((n) => ({ id: n.toLowerCase(), name: n })),
    outputs: outs.map((n) => ({ id: n.toLowerCase(), name: n })),
    params: [],
  };
}

function node(instance: string, m: Manifest, display?: string): NodeSnapshot {
  return {
    instance_id: instance,
    type_id: m.id,
    manifest: m,
    knobs: {},
    params: {},
    wired_inputs: [],
    midi_mappings: [],
    display_name: display,
  } as unknown as NodeSnapshot;
}

const ADSR = manifest('com.dj.adsr', 'ADSR', ['Gate', 'Retrig'], ['Out']);
const SCOPE = manifest('com.dj.scope', 'Scope', ['In'], []);
const OSC = manifest('com.dj.osc', 'Oscillator', ['Pitch'], ['Out', 'Sub']);

describe('rack letters', () => {
  const nodes = [
    node('adsr1', ADSR),
    node('adsr2', ADSR),
    node('scope1', SCOPE),
    node('osc1', OSC),
  ];

  it('letters a module by the name on its panel', () => {
    expect(moduleAliases(nodes)).toEqual({
      adsr1: 'a1',
      adsr2: 'a2',
      scope1: 's',
      osc1: 'o',
    });
  });

  it('uses a renamed panel’s own name', () => {
    expect(moduleAliases([node('osc1', OSC, 'Bass')])).toEqual({ osc1: 'b' });
  });

  it('letters inputs and outputs in separate namespaces', () => {
    expect(jackAliases(ADSR, 'input').map((j) => j.alias)).toEqual(['g', 'r']);
    expect(jackAliases(ADSR, 'output').map((j) => j.alias)).toEqual(['o']);
    // Two outputs both starting with the module's own letter still differ.
    expect(jackAliases(OSC, 'output').map((j) => j.alias)).toEqual(['o', 's']);
  });

  it('honours a jack that declares its letter', () => {
    const declared: Manifest = {
      ...ADSR,
      inputs: [
        { id: 'gate', name: 'Gate', alias: 'x' },
        { id: 'g2', name: 'Glide' },
      ],
    };
    expect(jackAliases(declared, 'input').map((j) => j.alias)).toEqual(['x', 'g']);
  });

  it('walks the rack in reading order', () => {
    const positions = {
      adsr1: { x: 300, y: 0 },
      adsr2: { x: 0, y: 0 },
      scope1: { x: 100, y: 400 },
      osc1: { x: 0, y: 400 },
    };
    expect(rackOrder(nodes, positions)).toEqual(['adsr2', 'adsr1', 'osc1', 'scope1']);
  });
});

describe(':w wires a module to a module', () => {
  const nodes = [node('adsr1', ADSR), node('adsr2', ADSR), node('scope1', SCOPE)];

  function walk(keys: string, entries: CommandEntry[]) {
    let session: CommandSession | null = newSession(entries);
    for (const key of keys) {
      const step = feedKey(session!, key);
      if (step.kind === 'run') {
        step.entry.run?.();
        session = null;
        continue;
      }
      if (step.kind === 'close') return null;
      session = step.session;
    }
    return session;
  }

  it('types :wa1osi as one sentence', () => {
    const connect = vi.fn();
    const prompt = vi.fn();
    const entries = rackCommandEntries({
      nodes,
      aliases: moduleAliases(nodes),
      connect,
      select: () => {},
      prompt,
    });
    walk('wa1osi', entries);
    expect(connect).toHaveBeenCalledTimes(1);
    const [from, to] = connect.mock.calls[0] as [JackRef, JackRef];
    expect(from).toEqual({ instance: 'adsr1', jack: 'out' });
    expect(to).toEqual({ instance: 'scope1', jack: 'in' });
    // The panel was asked to show its jack letters on the way through.
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ instance: 'adsr1', kind: 'output', jacks: { out: 'o' } }),
    );
    expect(prompt).toHaveBeenLastCalledWith(null);
  });

  it('offers only modules that have a jack of the kind being asked for', () => {
    const entries = rackCommandEntries({
      nodes,
      aliases: moduleAliases(nodes),
      connect: () => {},
      select: () => {},
      prompt: () => {},
    });
    const wire = entries.find((e) => e.keys === 'w');
    const sources = wire?.next?.() ?? [];
    // The Scope has no outputs, so it cannot be a wire's source.
    expect(sources.map((e) => e.keys).sort()).toEqual(['a1', 'a2']);
  });

  it('selects a module by its letter, and keeps the layer’s own keys', () => {
    const select = vi.fn();
    const entries = rackCommandEntries({
      nodes: [node('scope1', SCOPE), node('wave1', manifest('com.dj.wave', 'Wave', ['In'], []))],
      aliases: { scope1: 's', wave1: 'w' },
      connect: () => {},
      select,
      prompt: () => {},
    });
    const keys = entries.map((e) => e.keys);
    // `w` at the root is the wire command, not the Wave module…
    expect(keys.filter((k) => k === 'w')).toHaveLength(1);
    expect(entries.find((e) => e.keys === 'w')?.label).toBe('wire from…');
    // …which is still reachable through the full module list.
    const list = entries.find((e) => e.keys === 'm')?.next?.() ?? [];
    expect(list.map((e) => e.keys).sort()).toEqual(['s', 'w']);
    list.find((e) => e.keys === 'w')?.run?.();
    expect(select).toHaveBeenCalledWith('wave1');
  });
});
