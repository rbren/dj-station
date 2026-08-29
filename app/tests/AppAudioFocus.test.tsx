// One page sounds at a time: switching tabs tells the engine which page
// it is playing for, so the rack does not keep playing into a room the
// user has walked out of (and the decks do not either).

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setAudioFocus = vi.fn(async () => null);

// Everything the rack asks for on mount answers empty; only the focus
// calls matter here.
const fakeEngine = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === 'then') return undefined;
      if (prop === 'setAudioFocus') return setAudioFocus;
      return vi.fn(async () => {
        if (prop === 'nodes' || prop === 'wires' || prop === 'listPatches') return [];
        if (prop === 'listModules' || prop === 'macroGroups') return [];
        if (prop === 'macroLayout' || prop === 'tapAll') return {};
        return null;
      });
    },
  },
);

vi.mock('../src/engine', () => ({
  engine: new Proxy({}, { get: (_t, prop) => Reflect.get(fakeEngine, prop) }),
  onMenuAction: () => () => {},
}));

import App from '../src/App';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

const focusCalls = () => setAudioFocus.mock.calls.map((c) => (c as unknown as string[])[0]);

describe('what you are looking at is what you hear', () => {
  it('hands the engine the page it opens on', async () => {
    render(<App />);
    await waitFor(() => expect(focusCalls()).toEqual(['rack']));
  });

  it('follows the user from tab to tab', async () => {
    render(<App />);
    await waitFor(() => expect(focusCalls().length).toBe(1));

    fireEvent.click(screen.getByTestId('tab-decks'));
    await waitFor(() => expect(focusCalls().at(-1)).toBe('decks'));

    // A page that makes its own sound (or none) leaves the engine quiet
    // rather than letting the last one play on underneath it.
    fireEvent.click(screen.getByTestId('tab-library'));
    await waitFor(() => expect(focusCalls().at(-1)).toBe('silent'));

    fireEvent.click(screen.getByTestId('tab-rack'));
    await waitFor(() => expect(focusCalls().at(-1)).toBe('rack'));
  });
});
