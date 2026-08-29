// The output picker belongs to the CHROME, not to a page: it is in the
// header above the rack, and it is still there when the user walks to
// another tab — because the device it points at is the machine's, and
// because a device that has just vanished must be replaceable from
// wherever you happen to be standing.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioOutputSettings } from '../src/audioOutputs';

const state: { outputs: AudioOutputSettings } = {
  outputs: {
    devices: ['Speakers', 'Headphones'],
    live: 'Speakers',
    monitor: null,
    playing_live: 'Speakers',
    playing_monitor: null,
    note: null,
  },
};
const calls: [string | null, string | null][] = [];

vi.mock('../src/audioOutputs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audioOutputs')>();
  return {
    ...actual,
    audioOutputs: {
      get: async () => state.outputs,
      set: async (live: string | null, monitor: string | null) => {
        calls.push([live, monitor]);
        return null;
      },
    },
  };
});

vi.mock('../src/engine', () => ({
  engine: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        return vi.fn(async () => {
          if (prop === 'nodes' || prop === 'wires' || prop === 'listPatches') return [];
          if (prop === 'listModules' || prop === 'macroGroups') return [];
          if (prop === 'macroLayout' || prop === 'tapAll') return {};
          return null;
        });
      },
    },
  ),
  onMenuAction: () => () => {},
}));

import App from '../src/App';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  calls.length = 0;
});

describe('picking the hardware from the top chrome', () => {
  it('sits in the header on the rack, and follows the user to every other tab', async () => {
    render(<App />);

    const picker = await screen.findByTestId('audio-outputs');
    expect(picker.closest('.app-header')).not.toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId<HTMLSelectElement>('audio-output-live').value).toBe('Speakers'),
    );

    for (const tab of ['tab-decks', 'tab-library', 'tab-rack']) {
      fireEvent.click(screen.getByTestId(tab));
      expect(screen.getAllByTestId('audio-outputs')).toHaveLength(1);
    }
  });

  it('points a bus at another device without leaving the page', async () => {
    render(<App />);
    await screen.findByTestId('audio-outputs');

    fireEvent.change(screen.getByTestId('audio-output-monitor'), {
      target: { value: 'Headphones' },
    });
    await waitFor(() => expect(calls.at(-1)).toEqual(['Speakers', 'Headphones']));
  });
});
