// The application-wide keyboard layer: `:` command mode, `?` help, and
// the registry pages hand their own commands to.
//
// WHY ONE LAYER. Every page already listens on `window`; left to
// themselves they would each grow a `:`-handler and fight over the
// letters. Instead this provider owns the two global keys, and a page
// contributes what `:` should offer WHILE IT IS THE OPEN TAB
// (`useCommandSource`). Nothing else in the app may consume a key while
// the layer is capturing.
//
// HOW PAGES STAND DOWN. The listener is a CAPTURE-phase one on `window`,
// and it stops propagation of everything it takes: that alone silences
// every bubble-phase window listener in the app (the rack shortcuts, the
// QWERTY module's gates, the Clip page). The two handlers that also
// listen in capture (GridView, ModulePicker) ask `useKeyboardCapturing()`
// instead — capture-phase listeners on the same target cannot be cut off
// by another one.
//
// TEXT ENTRY ALWAYS WINS: `:` and `?` are ignored on an editable target
// (see `keys.ts`), and while a modal owns the keyboard the whole layer is
// suspended by its host.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  candidates,
  commitKey,
  eraseKey,
  feedKey,
  newSession,
  type CommandEntry,
  type CommandSession,
  type CommandStep,
} from './commands';
import { directionFor, isBareKey, isEditableTarget, stepIndex } from './keys';
import {
  GLOBAL_SHORTCUTS,
  PAGE_LABELS,
  PAGE_SHORTCUTS,
  type PageId,
  type ShortcutGroup,
} from './shortcuts';

export interface KeyboardApi {
  /** The tab whose commands and help are live. */
  page: PageId;
  /** The command being typed, or null when `:` is not open. */
  session: CommandSession | null;
  helpOpen: boolean;
  /** True while the layer owns the keyboard — pages must not act. */
  capturing: boolean;
  /** Open command mode, optionally with keys already typed (`w` on the
   *  rack is exactly `:w`). */
  openCommand(prefix?: string): void;
  closeCommand(): void;
  setHelpOpen(open: boolean): void;
  /** Offer entries at the root of `:`. Returns the unregister. */
  registerSource(id: string, get: () => CommandEntry[], order: number): () => void;
}

const IDLE: KeyboardApi = {
  page: 'rack',
  session: null,
  helpOpen: false,
  capturing: false,
  openCommand: () => {},
  closeCommand: () => {},
  setHelpOpen: () => {},
  registerSource: () => () => {},
};

/** Defaults to an idle layer, so a panel rendered outside <App> (unit
 *  tests, the stress harness, the docs previews) behaves as if nothing
 *  were capturing. */
const KeyboardContext = createContext<KeyboardApi>(IDLE);

export function useKeyboard(): KeyboardApi {
  return useContext(KeyboardContext);
}

/** True while the command bar or the help overlay owns the keyboard.
 *  Every page-level key handler starts with this. */
export function useKeyboardCapturing(): boolean {
  return useContext(KeyboardContext).capturing;
}

/** Contribute entries to the root of `:` while this component is
 *  mounted. `get` is read at the moment `:` is pressed, so it always
 *  sees current state; `order` sorts the offers (globals first). */
export function useCommandSource(id: string, get: () => CommandEntry[], order = 50): void {
  useCommandSourceOn(useKeyboard(), id, get, order);
}

/** `useCommandSource` for the component that OWNS the layer (App holds
 *  the api itself, so it cannot read it back out of the context it is
 *  about to provide). */
export function useCommandSourceOn(
  api: KeyboardApi,
  id: string,
  get: () => CommandEntry[],
  order = 50,
): void {
  const { registerSource } = api;
  const latest = useRef(get);
  useEffect(() => {
    latest.current = get;
  });
  useEffect(() => registerSource(id, () => latest.current(), order), [id, order, registerSource]);
}

export interface ListKeysOptions {
  /** How many items are in the list. */
  length: number;
  /** Live while true — a page that is not the open tab passes false. */
  active?: boolean;
  /** The highlighted item, or null for "none yet". */
  index: number | null;
  onIndex(next: number | null): void;
  /** Enter on the highlighted item. */
  onActivate?(index: number): void;
  /** A key of the list's own; return true when it was taken. */
  onKey?(e: KeyboardEvent): boolean;
}

/** WHEREVER THERE IS A LIST, this walks it: j/k and the arrows step,
 *  `gg`/`G` go to the ends, Enter takes the highlighted item and Escape
 *  drops the highlight. h/l step it too — a list is one-dimensional, so
 *  both axes mean the same move, which is what makes the keys the same
 *  everywhere.
 *
 *  Stands down for text entry and while the `:` bar or `?` overlay owns
 *  the keyboard. */
export function useListKeys({
  length,
  active = true,
  index,
  onIndex,
  onActivate,
  onKey,
}: ListKeysOptions): void {
  const capturing = useKeyboardCapturing();
  const pendingG = useRef(false);
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (capturing || !isBareKey(e) || isEditableTarget(e.target)) return;
      if (onKey?.(e)) return;
      const wasG = pendingG.current;
      pendingG.current = false;
      if (e.key === 'g') {
        if (!wasG) {
          pendingG.current = true;
          return;
        }
        e.preventDefault();
        onIndex(length > 0 ? 0 : null);
        return;
      }
      if (e.key === 'G') {
        e.preventDefault();
        onIndex(length > 0 ? length - 1 : null);
        return;
      }
      if (e.key === 'Enter') {
        if (index === null || index >= length) return;
        e.preventDefault();
        onActivate?.(index);
        return;
      }
      if (e.key === 'Escape') {
        if (index !== null) onIndex(null);
        return;
      }
      const direction = directionFor(e.key);
      if (!direction) return;
      e.preventDefault();
      onIndex(stepIndex(index, direction === 'down' || direction === 'right' ? 1 : -1, length));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, capturing, index, length, onActivate, onIndex, onKey]);
}

export interface KeyboardLayerOptions {
  page: PageId;
  /** A modal owns the keyboard: the layer takes no keys at all. */
  suspended?: boolean;
}

/** The layer itself: the two global keys, command mode, and the source
 *  registry. Held by App and handed down through `KeyboardProvider`. */
export function useKeyboardLayer({ page, suspended = false }: KeyboardLayerOptions): KeyboardApi {
  const [session, setSession] = useState<CommandSession | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const sources = useRef(new Map<string, { get: () => CommandEntry[]; order: number }>());

  const registerSource = useCallback((id: string, get: () => CommandEntry[], order: number) => {
    sources.current.set(id, { get, order });
    return () => {
      sources.current.delete(id);
    };
  }, []);

  /** Everything on offer at the root, in registration order, with a key
   *  that is already spoken for dropped: the first source to claim a key
   *  keeps it (globals are registered first). */
  const rootEntries = useCallback((): CommandEntry[] => {
    const lists = [...sources.current.values()].sort((a, b) => a.order - b.order);
    const seen = new Set<string>();
    const out: CommandEntry[] = [];
    for (const source of lists) {
      for (const entry of source.get()) {
        if (seen.has(entry.keys)) continue;
        seen.add(entry.keys);
        out.push(entry);
      }
    }
    return out;
  }, []);

  const apply = useCallback((step: CommandStep) => {
    if (step.kind === 'session') setSession(step.session);
    else if (step.kind === 'run') {
      setSession(null);
      step.entry.run?.();
    } else setSession(null);
  }, []);

  const openCommand = useCallback(
    (prefix = '') => {
      setHelpOpen(false);
      let next = newSession(rootEntries());
      for (const key of prefix) {
        const step = feedKey(next, key);
        if (step.kind !== 'session') {
          apply(step);
          return;
        }
        next = step.session;
      }
      setSession(next);
    },
    [apply, rootEntries],
  );

  const closeCommand = useCallback(() => setSession(null), []);

  // A command belongs to the page it was opened on; changing tabs (or a
  // modal opening) closes it rather than leaving stale entries armed.
  // Adjusted DURING RENDER rather than in an effect: the bar must never
  // be painted once against the new page's entries.
  const [scope, setScope] = useState({ page, suspended });
  if (scope.page !== page || scope.suspended !== suspended) {
    setScope({ page, suspended });
    if (session) setSession(null);
    if (suspended && helpOpen) setHelpOpen(false);
  }

  useEffect(() => {
    const swallow = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onKey = (e: KeyboardEvent) => {
      if (helpOpen) {
        if (e.key === 'Escape' || e.key === '?' || e.key === 'q') {
          swallow(e);
          setHelpOpen(false);
        } else if (isBareKey(e) && e.key.length === 1) {
          // The overlay is modal: a stray letter must not reach the page
          // behind it.
          swallow(e);
        }
        return;
      }
      if (session) {
        if (e.key === 'Escape') {
          swallow(e);
          setSession(null);
        } else if (e.key === 'Enter') {
          swallow(e);
          apply(commitKey(session));
        } else if (e.key === 'Backspace') {
          swallow(e);
          apply(eraseKey(session));
        } else if (e.key.length === 1 && isBareKey(e)) {
          swallow(e);
          apply(feedKey(session, e.key));
        }
        return;
      }
      if (suspended || !isBareKey(e) || isEditableTarget(e.target)) return;
      if (e.key === ':') {
        swallow(e);
        openCommand();
      } else if (e.key === '?') {
        swallow(e);
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [apply, helpOpen, openCommand, session, suspended]);

  return useMemo<KeyboardApi>(
    () => ({
      page,
      session,
      helpOpen,
      capturing: session !== null || helpOpen,
      openCommand,
      closeCommand,
      setHelpOpen,
      registerSource,
    }),
    [closeCommand, helpOpen, openCommand, page, registerSource, session],
  );
}

/** Puts the layer in context and draws its two surfaces: the command bar
 *  while `:` is being typed, and the help overlay. */
export function KeyboardProvider({ api, children }: { api: KeyboardApi; children: ReactNode }) {
  return (
    <KeyboardContext.Provider value={api}>
      {children}
      {api.session && <CommandBar session={api.session} />}
      {api.helpOpen && <HelpOverlay page={api.page} onClose={() => api.setHelpOpen(false)} />}
    </KeyboardContext.Provider>
  );
}

/** The keys still on offer, grouped for the bar. */
function groupHints(entries: CommandEntry[]): [string, CommandEntry[]][] {
  const groups = new Map<string, CommandEntry[]>();
  for (const entry of entries) {
    const key = entry.group ?? 'Commands';
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups.entries()];
}

/** What `:` puts on screen: what has been typed, and every key that
 *  would do something next. */
export function CommandBar({ session }: { session: CommandSession }) {
  const hints = candidates(session);
  return (
    <div className="cmd-bar" data-testid="command-bar" role="status" aria-live="polite">
      <div className="cmd-line">
        <span className="cmd-typed mono" data-testid="command-typed">
          :{session.typed}
          {session.buffer}
        </span>
        {session.trail.length > 0 && (
          <span className="cmd-trail" data-testid="command-trail">
            {session.trail.join(' › ')}
          </span>
        )}
        {session.error && (
          <span className="cmd-error" data-testid="command-error">
            {session.error}
          </span>
        )}
      </div>
      <div className="cmd-hints">
        {groupHints(hints).map(([title, entries]) => (
          <div className="cmd-hint-group" key={title}>
            <span className="cmd-hint-title">{title}</span>
            {entries.map((entry) => (
              <span
                className="cmd-hint"
                data-testid={`command-hint-${entry.keys}`}
                key={entry.keys}
              >
                <kbd className="cmd-key">{entry.keys}</kbd>
                <span className="cmd-hint-label">{entry.label}</span>
              </span>
            ))}
          </div>
        ))}
        {hints.length === 0 && <span className="cmd-hint-title">nothing to press</span>}
      </div>
    </div>
  );
}

function ShortcutList({ groups, testId }: { groups: ShortcutGroup[]; testId: string }) {
  return (
    <div className="key-help-cols" data-testid={testId}>
      {groups.map((group) => (
        <section className="key-help-group" key={group.title}>
          <h4>{group.title}</h4>
          <dl>
            {group.entries.map((entry) => (
              <div className="key-help-row" key={entry.keys}>
                <dt>
                  <kbd className="cmd-key">{entry.keys}</kbd>
                </dt>
                <dd>{entry.label}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** `?`: the global keys, then the open tab's own. */
export function HelpOverlay({ page, onClose }: { page: PageId; onClose: () => void }) {
  return (
    <div className="key-help-backdrop" data-testid="key-help" onMouseDown={onClose}>
      <div
        className="key-help"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="key-help-head">
          <h3>Keyboard shortcuts</h3>
          <button className="key-help-close" data-testid="key-help-close" onClick={onClose}>
            Close
          </button>
        </header>
        <h4 className="key-help-scope">Everywhere</h4>
        <ShortcutList groups={GLOBAL_SHORTCUTS} testId="key-help-global" />
        <h4 className="key-help-scope" data-testid="key-help-page-title">
          {PAGE_LABELS[page]}
        </h4>
        <ShortcutList groups={PAGE_SHORTCUTS[page]} testId="key-help-page" />
      </div>
    </div>
  );
}
