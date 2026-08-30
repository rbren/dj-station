// Editing a library track: the Library page's Edit button switches to the
// Clip page with that track already open, so the two pages are one flow
// rather than "find it again in the clip picker".

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../src/library';

const TRACK: Track = {
  id: 4,
  title: 'Basement Loop',
  artist: 'Me',
  album: '',
  file_path: '/music/basement.wav',
  content_hash: 'abc',
  format: 'wav',
  duration_secs: 10,
  sample_rate: 48000,
  channels: 2,
  source: 'watch',
  source_ref: '',
  license: { kind: 'unknown', name: '', url: '', attribution: '' },
  analysis_status: 'done',
  bpm: 120,
  musical_key: 'Am',
  created_at: '',
  updated_at: '',
};

const fakeEngine = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === 'then') return undefined;
      return vi.fn(async () => {
        // Everything the rack asks for on mount is empty or absent.
        if (prop === 'nodes' || prop === 'wires' || prop === 'listPatches') return [];
        if (prop === 'listModules') return [];
        if (prop === 'macroGroups') return [];
        if (prop === 'macroLayout' || prop === 'tapAll') return {};
        return null;
      });
    },
  },
);

const libraryMock = {
  tracks: vi.fn(async () => [TRACK]),
  providers: vi.fn(async () => []),
  searchProvider: vi.fn(async () => []),
  importResult: vi.fn(async () => TRACK),
  downloadJobs: vi.fn(async () => []),
  analyze: vi.fn(async () => TRACK),
  watchFolders: vi.fn(async () => []),
  addWatchFolder: vi.fn(async () => []),
  removeWatchFolder: vi.fn(async () => []),
  rescan: vi.fn(async () => [TRACK]),
};

/** Stand-in for any client method this test does not care about. */
const nothing = async () => null;

const clipMock = {
  loadSource: vi.fn(async (trackId: number, stems: string[]) => ({
    track_id: trackId,
    stems,
    title: TRACK.title,
    artist: TRACK.artist,
    duration_secs: 10,
    sample_rate: 48000,
    channels: 2,
    peaks: [0.5, 0.5, 0.5, 0.5],
  })),
  renderPreview: vi.fn(async () => ({
    duration_secs: 10,
    sample_rate: 48000,
    channels: 2,
    peaks: [0.5, 0.5, 0.5, 0.5],
  })),
  previewAudio: vi.fn(async () => new ArrayBuffer(44)),
  detectBeats: vi.fn(async () => ({ bpm: 120, beats: 20, tracker: 'dsp' })),
  saveBeatClip: vi.fn(async () => null),
  stemStatus: vi.fn(async (trackId: number) => ({
    track_id: trackId,
    backend: 'htdemucs_ft',
    state: 'ready',
    stage: null,
    detail: null,
    pending: 0,
  })),
};

// The factories run before this file's consts are initialised (imports
// hoist), so each one hands back a Proxy that looks the mock up lazily.
// Anything not mocked answers "nothing" rather than throwing: this test
// is about one hand-off, not about the whole library page.
vi.mock('../src/engine', () => ({
  engine: new Proxy({}, { get: (_t, prop) => Reflect.get(fakeEngine, prop) }),
  onMenuAction: () => () => {},
}));

vi.mock('../src/library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/library')>()),
  library: new Proxy({}, { get: (_t, prop) => Reflect.get(libraryMock, prop) ?? nothing }),
}));

vi.mock('../src/clip', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/clip')>()),
  clipClient: new Proxy({}, { get: (_t, prop) => Reflect.get(clipMock, prop) ?? nothing }),
}));

import App from '../src/App';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('editing a library track', () => {
  it('opens the clip page on the track the library row asked for', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('tab-library'));
    await waitFor(() => expect(screen.getByTestId('library-edit')).toBeTruthy());

    fireEvent.click(screen.getByTestId('library-edit'));
    // The Clip tab is showing...
    await waitFor(() => expect(screen.getByTestId('tab-clip').className).toContain('active'));
    // ...editing that track, with no second trip through the clip picker.
    await waitFor(() =>
      expect(clipMock.loadSource).toHaveBeenCalledWith(4, [], expect.any(Number)),
    );
    await waitFor(() => expect(screen.getByTestId('clip-waveform')).toBeTruthy());
  });
});
