// What `?` shows: the keyboard map, written down once so the help and
// the bindings cannot drift apart in two directions at a time. Global
// keys are listed on every page; the page's own list is whatever tab is
// open.

export type PageId = 'rack' | 'decks' | 'grid' | 'clip' | 'library';

/** The `:` key that jumps to each page — also the letters the command
 *  bar offers at its root, and the ones a page's own aliases must not
 *  take (see `rackKeys.ts`). */
export const PAGE_KEYS: Record<PageId, string> = {
  rack: 'r',
  decks: 'd',
  grid: 'g',
  clip: 'c',
  library: 'l',
};

export const PAGE_LABELS: Record<PageId, string> = {
  rack: 'Rack',
  decks: 'Decks',
  grid: 'Grid',
  clip: 'Clip',
  library: 'Library',
};

export interface ShortcutEntry {
  keys: string;
  label: string;
}

export interface ShortcutGroup {
  title: string;
  entries: ShortcutEntry[];
}

export const GLOBAL_SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'Getting around',
    entries: [
      { keys: ':', label: 'command mode — the keys you can press light up' },
      { keys: ':r :d :g :c :l', label: 'jump to Rack, Decks, Grid, Clip, Library' },
      { keys: 'h j k l', label: 'left / down / up / right — the same as the arrow keys' },
      { keys: '↑ ↓ ← →', label: 'move through any list or grid' },
      { keys: 'Enter', label: 'choose what is highlighted' },
      { keys: 'Esc', label: 'cancel: close a command, a menu or a selection' },
      { keys: '?', label: 'this list' },
    ],
  },
  {
    title: 'Patch',
    entries: [
      { keys: 'cmd/ctrl+S', label: 'save' },
      { keys: 'cmd/ctrl+O', label: 'open' },
      { keys: 'cmd/ctrl+N', label: 'new' },
    ],
  },
];

export const PAGE_SHORTCUTS: Record<PageId, ShortcutGroup[]> = {
  rack: [
    {
      title: 'Modules',
      entries: [
        { keys: 'j k / ↓ ↑', label: 'step through the modules; h l too' },
        { keys: ': then a letter', label: 'select a module by the letter on its panel' },
        { keys: ':m', label: 'the full module list, when a letter is spoken for' },
        { keys: 'm', label: 'open the module picker' },
        { keys: 'cmd/ctrl+A', label: 'select every module' },
        { keys: 'cmd/ctrl+C · V', label: 'copy · paste the selection' },
        { keys: 'Backspace', label: 'delete the selection' },
      ],
    },
    {
      title: 'Wires',
      entries: [
        { keys: 'w', label: 'start a wire (same as :w)' },
        { keys: ':w a1 o s i', label: 'module a1’s output o → module s’s input i' },
        { keys: 'Esc', label: 'drop the wire being run' },
      ],
    },
    {
      title: 'Canvas',
      entries: [
        { keys: 'cmd/ctrl+Z · shift+Z', label: 'undo · redo' },
        { keys: 'cmd/ctrl +  −  0', label: 'zoom in, out, reset' },
      ],
    },
    {
      title: 'Note',
      entries: [
        {
          keys: 'QWERTY module',
          label: 'plain letters play notes while one is racked — use : for commands',
        },
      ],
    },
  ],
  decks: [
    {
      title: 'Decks',
      entries: [
        { keys: 'h l / ← →', label: 'step across the decks; j k too' },
        { keys: ':1 … :8', label: 'jump straight to a deck' },
        { keys: 'Enter', label: 'load a clip into the deck' },
        { keys: 'Esc', label: 'drop the deck selection' },
      ],
    },
    {
      title: 'Rack',
      entries: [{ keys: 'w · cmd/ctrl+Z', label: 'the rack keys work here too' }],
    },
  ],
  grid: [
    {
      title: 'Moving',
      entries: [
        { keys: 'h l / ← →', label: 'a beat at a time' },
        { keys: 'j k / ↑ ↓', label: 'a track at a time' },
        { keys: 'w b', label: 'a bar at a time — a bar is a word' },
        { keys: 'e', label: 'the last beat of this bar' },
        { keys: '0 $', label: 'the first / last beat' },
        { keys: 'gg G', label: 'the first / last track' },
        { keys: '8l  3w', label: 'a count repeats the move' },
        { keys: ':5', label: 'jump to the 5th track — : reveals the numbers' },
        { keys: 'cmd+← →', label: 'a bar; ctrl+← → the ends' },
      ],
    },
    {
      title: 'Editing',
      entries: [
        { keys: 'v', label: 'mark a rectangle, then move' },
        { keys: 'y d', label: 'yank / delete what is marked, or y·d + a move' },
        { keys: 'yy dd', label: 'the whole track' },
        { keys: 'x', label: 'delete the beat under the caret' },
        { keys: 'p', label: 'paste at the caret' },
        { keys: 'Enter', label: 'fill the marked rectangle with its clips' },
        { keys: 'Backspace', label: 'clear the marked rectangle' },
      ],
    },
    {
      title: 'Transport & file',
      entries: [
        { keys: 'Space', label: 'play / pause' },
        { keys: 'cmd/ctrl+Z · shift+Z', label: 'undo · redo' },
        { keys: 'cmd/ctrl+S · O · N', label: 'save · open · new grid' },
      ],
    },
  ],
  clip: [
    {
      title: 'Transport',
      entries: [
        { keys: 'Space', label: 'play / pause' },
        { keys: 'h l / ← →', label: 'the playhead, a beat at a time' },
        { keys: 'right shift', label: 'tap a beat while it plays' },
        { keys: 'left shift', label: 'tap a downbeat while it plays' },
      ],
    },
    {
      title: 'Stems',
      entries: [
        { keys: 'j k / ↑ ↓', label: 'step through the stems' },
        { keys: 'Enter', label: 'drop / bring back the stem' },
        { keys: ': then a letter', label: 'a stem by its initial' },
      ],
    },
    {
      title: 'Editing',
      entries: [
        { keys: 'cmd/ctrl+Z · shift+Z', label: 'undo · redo' },
        { keys: 'Esc', label: 'drop the selection' },
      ],
    },
  ],
  library: [
    {
      title: 'The list',
      entries: [
        { keys: 'j k / ↑ ↓', label: 'step through the rows' },
        { keys: 'gg G', label: 'the first / last row' },
        { keys: 'Enter', label: 'open the row in the Clip editor' },
        { keys: '/', label: 'the search box' },
        { keys: 'Esc', label: 'drop the row selection' },
      ],
    },
    {
      title: 'Tabs',
      entries: [{ keys: ':s :b', label: 'the Sources and Beat Clips tabs' }],
    },
  ],
};
