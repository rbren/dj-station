// The `:` command layer's grammar, with no React in it.
//
// A command is a WALK DOWN A TREE of single-token entries: `:` opens the
// root, every key narrows the candidates, and an entry either runs
// (`run`) or opens another level (`next`). That is what makes
// `:wa1osi` — wire, module a1, its output o, module s, its input i — one
// typed sentence rather than five bespoke handlers.
//
// Matching rule: a key that leaves no candidate is refused (the session
// stays open, with a complaint); an exact match that is nobody's prefix
// fires at once; an exact match that IS a prefix (`1` with `12` also on
// offer, on a grid with twelve rows) waits for Enter or for the next
// digit. Alias generation below keeps that case rare by padding numbers.

/** One key(s) → action step of a command. */
export interface CommandEntry {
  /** The keys that choose this entry, e.g. `r`, `a1`, `03`. */
  keys: string;
  /** What the hint line calls it. */
  label: string;
  /** Hint grouping ("Pages", "Modules", …). */
  group?: string;
  /** Run it — a leaf. Ignored when `next` is present. */
  run?: () => void;
  /** Open another level, computed when this entry is chosen. */
  next?: () => CommandEntry[];
}

/** A command being typed. */
export interface CommandSession {
  /** What the next key is matched against. */
  entries: CommandEntry[];
  /** Keys typed at this level and not yet resolved. */
  buffer: string;
  /** The labels of the levels already chosen, for the command bar. */
  trail: string[];
  /** Everything typed so far, for the command bar's `:…` echo. */
  typed: string;
  /** Why the last key did nothing, if it did nothing. */
  error: string | null;
}

export type CommandStep =
  /** Still typing: keep showing the (updated) session. */
  | { kind: 'session'; session: CommandSession }
  /** A leaf fired: the caller runs it and closes the session. */
  | { kind: 'run'; entry: CommandEntry }
  /** Nothing left to type into: close the session. */
  | { kind: 'close' };

export function newSession(entries: CommandEntry[]): CommandSession {
  return { entries, buffer: '', trail: [], typed: '', error: null };
}

/** The entries still reachable from what has been typed at this level. */
export function candidates(session: CommandSession): CommandEntry[] {
  if (!session.buffer) return session.entries;
  return session.entries.filter((e) => e.keys.startsWith(session.buffer));
}

/** Choose an entry: descend into it, or hand it back to be run. */
function choose(session: CommandSession, entry: CommandEntry): CommandStep {
  if (entry.next) {
    return {
      kind: 'session',
      session: {
        entries: entry.next(),
        buffer: '',
        trail: [...session.trail, entry.label],
        typed: session.typed + entry.keys,
        error: null,
      },
    };
  }
  return { kind: 'run', entry };
}

/** Feed one printable key. */
export function feedKey(session: CommandSession, key: string): CommandStep {
  const buffer = session.buffer + key;
  const matches = session.entries.filter((e) => e.keys.startsWith(buffer));
  if (matches.length === 0) {
    return {
      kind: 'session',
      session: { ...session, buffer: '', error: `no command “${buffer}”` },
    };
  }
  const exact = matches.find((e) => e.keys === buffer);
  if (exact && matches.length === 1) return choose(session, exact);
  return { kind: 'session', session: { ...session, buffer, error: null } };
}

/** Enter: take the exact match, which is how an ambiguous prefix (`1`
 *  where `12` also exists) is committed. */
export function commitKey(session: CommandSession): CommandStep {
  const exact = session.entries.find((e) => e.keys === session.buffer);
  if (!exact) {
    return { kind: 'session', session: { ...session, error: 'nothing to run' } };
  }
  return choose(session, exact);
}

/** Backspace: rub out the last key, or close the session when there is
 *  nothing left at this level (levels already chosen are not walked back
 *  into — `next()` may have had side effects). */
export function eraseKey(session: CommandSession): CommandStep {
  if (!session.buffer) return { kind: 'close' };
  return {
    kind: 'session',
    session: { ...session, buffer: session.buffer.slice(0, -1), error: null },
  };
}

/** The first letter a name is aliased by: its first ASCII letter, or its
 *  first digit, or `x` for a name made of neither. */
function initial(name: string): string {
  const letter = /[a-z]/i.exec(name);
  if (letter) return letter[0].toLowerCase();
  const digit = /[0-9]/.exec(name);
  return digit ? digit[0] : 'x';
}

/** Aliases for a list of names: the first letter, plus a number when
 *  several names share it (`a1`, `a2`), zero-padded so that no alias is
 *  ever a prefix of another (`a01` … `a12`). Order is the input's, so an
 *  alias is stable for as long as the list is.
 *
 *  Used for rack modules AND for a module's jacks — the same rule the
 *  user is told once. */
export function aliasesFor(names: readonly string[]): string[] {
  const groups = new Map<string, number[]>();
  names.forEach((name, i) => {
    const letter = initial(name);
    const bucket = groups.get(letter);
    if (bucket) bucket.push(i);
    else groups.set(letter, [i]);
  });
  const out = new Array<string>(names.length).fill('');
  for (const [letter, members] of groups) {
    if (members.length === 1) {
      out[members[0]] = letter;
      continue;
    }
    const width = String(members.length).length;
    members.forEach((index, n) => {
      out[index] = letter + String(n + 1).padStart(width, '0');
    });
  }
  return out;
}

/** Aliases for things that may DECLARE their own letter (a manifest's
 *  jacks): a declared letter is kept as it is, everything else is
 *  lettered by name, and a derived letter that would land on a declared
 *  one is numbered out of the way. */
export function assignAliases(items: readonly { name: string; alias?: string | null }[]): string[] {
  // The names that need a letter are lettered AMONG THEMSELVES: a name a
  // declaration took out of the running must not number the rest
  // (declaring `x` for one of two Gs leaves the other a plain `g`).
  const auto = items.filter((i) => !i.alias);
  const derived = aliasesFor(auto.map((i) => i.name));
  const taken = new Set(items.map((i) => i.alias).filter((a): a is string => !!a));
  let next = 0;
  return items.map((item) => {
    if (item.alias) return item.alias;
    const base = derived[next];
    next += 1;
    let alias = base;
    for (let n = 1; taken.has(alias); n += 1) alias = `${base}${n}`;
    taken.add(alias);
    return alias;
  });
}
