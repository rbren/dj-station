// The application keyboard layer against a mocked engine: `:` command
// mode and its hints, the page jumps, the rack's module letters and the
// `:w` wire sentence, `?` help, the shared list keys, and the rule that
// none of it fires while text is being typed.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../src/types';

const ADSR: Manifest = {
  id: 'com.dj.adsr',
  name: 'ADSR',
  version: '0.1.0',
  abi: 'wasm-1',
  inputs: [{ id: 'gate', name: 'Gate' }],
  outputs: [{ id: 'out', name: 'Out' }],
  params: [],
};

const SCOPE: Manifest = {
  id: 'com.dj.scope',
  name: 'Scope',
  version: '0.1.0',
  abi: 'wasm-1',
  inputs: [{ id: 'in', name: 'In' }],
  outputs: [],
  params: [],
};

const state = { nodes: [] as unknown[], wires: [] as unknown[] };

const fakeEngine = {
  loadDemoPatch: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  listModules: vi.fn(async () => [ADSR, SCOPE]),
  nodes: vi.fn(async () => state.nodes),
  wires: vi.fn(async () => state.wires),
  tap: vi.fn(async () => null),
  tapAll: vi.fn(async () => ({})),
  macroGroups: vi.fn(async () => []),
  macroLayout: vi.fn(async () => ({})),
  connectWire: vi.fn(async () => {}),
  currentPatch: vi.fn(async () => null),
  listPatches: vi.fn(async () => []),
  syncPositions: vi.fn(async () => {}),
};

vi.mock('../src/engine', () => ({
  engine: new Proxy(
    {},
    { get: (_t, prop) => fakeEngine[prop as keyof typeof fakeEngine] ?? vi.fn(async () => null) },
  ),
  onMenuAction: () => () => {},
}));

import App from '../src/App';
import { KeyboardProvider, useKeyboardLayer, useListKeys } from '../src/keyboard';

function node(instance: string, manifest: Manifest, position?: { x: number; y: number }) {
  return {
    instance_id: instance,
    type_id: manifest.id,
    manifest,
    knobs: {},
    params: {},
    wired_inputs: [],
    midi_mappings: [],
    position,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  state.nodes = [node('adsr1', ADSR), node('adsr2', ADSR), node('scope1', SCOPE)];
  state.wires = [];
});

async function renderApp() {
  render(<App />);
  await waitFor(() => expect(screen.getByTestId('module-adsr1')).toBeTruthy());
}

/** Type a whole `:` command, one key at a time, at the window. */
function type(keys: string) {
  for (const key of keys) fireEvent.keyDown(window, { key });
}

describe('command mode', () => {
  it(': opens a bar that shows what can be pressed', async () => {
    await renderApp();
    expect(screen.queryByTestId('command-bar')).toBeNull();
    type(':');
    await waitFor(() => expect(screen.getByTestId('command-bar')).toBeTruthy());
    // The pages are always on offer…
    expect(screen.getByTestId('command-hint-g').textContent).toContain('Grid');
    expect(screen.getByTestId('command-hint-c').textContent).toContain('Clip');
    // …and so is the rack's wire command and its module letters.
    expect(screen.getByTestId('command-hint-w').textContent).toContain('wire');
    expect(screen.getByTestId('command-hint-a1')).toBeTruthy();
  });

  it(':g, :l and :r jump between the tabs', async () => {
    await renderApp();
    type(':g');
    await waitFor(() => expect(screen.getByTestId('tab-grid').className).toContain('active'));
    expect(screen.queryByTestId('command-bar')).toBeNull();
    type(':l');
    await waitFor(() => expect(screen.getByTestId('tab-library').className).toContain('active'));
    type(':r');
    await waitFor(() => expect(screen.getByTestId('tab-rack').className).toContain('active'));
  });

  it('Escape closes the bar and Backspace rubs a key out', async () => {
    await renderApp();
    type(':a');
    await waitFor(() => expect(screen.getByTestId('command-typed').textContent).toBe(':a'));
    fireEvent.keyDown(window, { key: 'Backspace' });
    await waitFor(() => expect(screen.getByTestId('command-typed').textContent).toBe(':'));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('command-bar')).toBeNull());
  });

  it('says so when a key means nothing', async () => {
    await renderApp();
    type(':');
    fireEvent.keyDown(window, { key: 'q' });
    await waitFor(() => expect(screen.getByTestId('command-error').textContent).toContain('q'));
    expect(screen.getByTestId('command-bar')).toBeTruthy();
  });

  it('stands down while text is being typed', async () => {
    await renderApp();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: ':' });
    fireEvent.keyDown(input, { key: '?' });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId('command-bar')).toBeNull();
    expect(screen.queryByTestId('key-help')).toBeNull();
    input.remove();
  });
});

describe('the rack’s letters', () => {
  it('prints each module’s letter on its panel', async () => {
    await renderApp();
    expect(screen.getByTestId('module-alias-adsr1').textContent).toBe('a1');
    expect(screen.getByTestId('module-alias-adsr2').textContent).toBe('a2');
    expect(screen.getByTestId('module-alias-scope1').textContent).toBe('s');
  });

  it('selects a module by its letter', async () => {
    await renderApp();
    type(':s');
    await waitFor(() => expect(screen.getByTestId('module-scope1').dataset.selected).toBe('true'));
  });

  it(':wa1osi wires the first ADSR’s out to the scope’s in', async () => {
    await renderApp();
    type(':w');
    // The modules that can be a source are offered by their letters.
    await waitFor(() => expect(screen.getByTestId('command-hint-a1')).toBeTruthy());
    type('a1');
    // Its output jacks are lettered ON THE PANEL while they are asked for.
    await waitFor(() => expect(screen.getByTestId('jack-key-output-out').textContent).toBe('o'));
    type('o');
    await waitFor(() => expect(screen.getByTestId('command-hint-s')).toBeTruthy());
    type('s');
    await waitFor(() => expect(screen.getByTestId('jack-key-input-in').textContent).toBe('i'));
    type('i');
    await waitFor(() =>
      expect(fakeEngine.connectWire).toHaveBeenCalledWith(
        { instance: 'adsr1', jack: 'out' },
        { instance: 'scope1', jack: 'in' },
      ),
    );
    // The command is done: no bar, and no letters left on the jacks.
    expect(screen.queryByTestId('command-bar')).toBeNull();
    expect(screen.queryByTestId('jack-key-input-in')).toBeNull();
  });

  it('w on its own is the same as :w', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'w' });
    await waitFor(() => expect(screen.getByTestId('command-typed').textContent).toBe(':w'));
    expect(screen.getByTestId('command-hint-a1')).toBeTruthy();
  });

  it('hjkl and the arrows walk the selection through the panels', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'j' });
    await waitFor(() => expect(screen.getByTestId('module-adsr1').dataset.selected).toBe('true'));
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByTestId('module-adsr2').dataset.selected).toBe('true'));
    fireEvent.keyDown(window, { key: 'k' });
    await waitFor(() => expect(screen.getByTestId('module-adsr1').dataset.selected).toBe('true'));
  });
});

describe('the help overlay', () => {
  it('? lists the global keys and the open tab’s own', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: '?' });
    await waitFor(() => expect(screen.getByTestId('key-help')).toBeTruthy());
    expect(screen.getByTestId('key-help-global').textContent).toContain('command mode');
    expect(screen.getByTestId('key-help-page-title').textContent).toBe('Rack');
    expect(screen.getByTestId('key-help-page').textContent).toContain('wire');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('key-help')).toBeNull());
  });

  it('follows the tab that is open', async () => {
    await renderApp();
    type(':g');
    await waitFor(() => expect(screen.getByTestId('tab-grid').className).toContain('active'));
    fireEvent.keyDown(window, { key: '?' });
    await waitFor(() => expect(screen.getByTestId('key-help-page-title').textContent).toBe('Grid'));
    expect(screen.getByTestId('key-help-page').textContent).toContain('a bar at a time');
  });

  it('the header button opens it too', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('key-help-btn'));
    await waitFor(() => expect(screen.getByTestId('key-help')).toBeTruthy());
    fireEvent.click(screen.getByTestId('key-help-close'));
    await waitFor(() => expect(screen.queryByTestId('key-help')).toBeNull());
  });
});

describe('the shared list keys', () => {
  function List({ items }: { items: string[] }) {
    const api = useKeyboardLayer({ page: 'library' });
    return (
      <KeyboardProvider api={api}>
        <Rows items={items} />
      </KeyboardProvider>
    );
  }

  function Rows({ items }: { items: string[] }) {
    const [index, setIndex] = useState<number | null>(null);
    const [opened, setOpened] = useState<string | null>(null);
    useListKeys({
      length: items.length,
      index,
      onIndex: setIndex,
      onActivate: (i) => setOpened(items[i]),
    });
    return (
      <ul>
        {items.map((item, i) => (
          <li key={item} data-testid={`row-${item}`} data-cursor={i === index ? 'true' : 'false'}>
            {item}
          </li>
        ))}
        <span data-testid="opened">{opened ?? ''}</span>
      </ul>
    );
  }

  const cursor = () =>
    screen.getByRole('list').querySelector('[data-cursor="true"]')?.textContent ?? null;

  it('j/k and the arrows step, gg and G go to the ends, Enter takes the row', () => {
    render(<List items={['one', 'two', 'three']} />);
    expect(cursor()).toBeNull();
    fireEvent.keyDown(window, { key: 'j' });
    expect(cursor()).toBe('one');
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(cursor()).toBe('two');
    fireEvent.keyDown(window, { key: 'k' });
    expect(cursor()).toBe('one');
    // A list is one-dimensional: l and h step it as well.
    fireEvent.keyDown(window, { key: 'l' });
    expect(cursor()).toBe('two');
    fireEvent.keyDown(window, { key: 'G' });
    expect(cursor()).toBe('three');
    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 'g' });
    expect(cursor()).toBe('one');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByTestId('opened').textContent).toBe('one');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(cursor()).toBeNull();
  });

  it('stops at the ends, and stands down for text entry and for :', () => {
    render(<List items={['one', 'two']} />);
    fireEvent.keyDown(window, { key: 'k' });
    expect(cursor()).toBe('two');
    fireEvent.keyDown(window, { key: 'j' });
    expect(cursor()).toBe('two');
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'k' });
    expect(cursor()).toBe('two');
    // While `:` is open the list must not move under the command.
    fireEvent.keyDown(window, { key: ':' });
    fireEvent.keyDown(window, { key: 'k' });
    expect(cursor()).toBe('two');
    input.remove();
  });
});
