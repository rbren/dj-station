// Library view (M1): search fans out to local library + providers, results
// carry source/license tags, download and deep-link actions call through
// the client (which is Tauri IPC in the app; a mock here).

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LibraryView } from '../src/components/LibraryView';
import type { LibraryClientApi, SearchOutcome, Track, TrackResult } from '../src/library';

const LOCAL_TRACK: Track = {
  id: 1,
  title: 'Basement Loop',
  artist: 'Me',
  album: '',
  file_path: '/data/loops/basement.wav',
  content_hash: 'abc',
  format: 'wav',
  duration_secs: 12.5,
  sample_rate: 48000,
  channels: 2,
  source: 'watch',
  source_ref: '',
  license: { kind: 'unknown', name: '', url: '', attribution: '' },
  analysis_status: 'queued',
  bpm: null,
  musical_key: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const ITUNES_RESULT: TrackResult = {
  provider: 'itunes',
  acquire_kind: 'deep_link',
  id: '1440764401',
  title: 'Harder, Better, Faster, Stronger',
  artist: 'Daft Punk',
  album: 'Discovery',
  duration_secs: 224.7,
  preview_url: 'https://audio.example/preview.m4a',
  artwork_url: null,
  license: { kind: 'commercial', name: 'All rights reserved', url: '', attribution: '' },
  download_url: null,
  deep_link_url: 'https://music.apple.com/us/album/x?i=1440764401',
};

const FREESOUND_RESULT: TrackResult = {
  provider: 'freesound',
  acquire_kind: 'download',
  id: '123456',
  title: 'amen break 174bpm',
  artist: 'breaks4days',
  album: '',
  duration_secs: 1.4,
  preview_url: 'https://cdn.example/preview.mp3',
  artwork_url: null,
  license: {
    kind: 'cc-by',
    name: 'CC BY',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: '"amen break" by breaks4days',
  },
  download_url: 'https://cdn.example/hq.mp3',
  deep_link_url: null,
};

// Internet Archive is a Download provider whose concrete file URL is only
// resolved at acquire time — download_url is null in search results.
const IA_RESULT: TrackResult = {
  provider: 'internet_archive',
  acquire_kind: 'download',
  id: 'gd1977-05-08',
  title: 'Grateful Dead Live at Barton Hall',
  artist: 'Grateful Dead',
  album: '',
  duration_secs: null,
  preview_url: 'https://archive.org/details/gd1977-05-08',
  artwork_url: null,
  license: { kind: 'cc0', name: 'CC0', url: '', attribution: '' },
  download_url: null,
  deep_link_url: 'https://archive.org/details/gd1977-05-08',
};

function mockClient(overrides: Partial<LibraryClientApi> = {}): LibraryClientApi {
  const outcome: SearchOutcome = {
    results: [ITUNES_RESULT, FREESOUND_RESULT, IA_RESULT],
    errors: [['jamendo', 'HTTP 500']],
  };
  return {
    tracks: vi.fn().mockResolvedValue([LOCAL_TRACK]),
    search: vi.fn().mockResolvedValue([LOCAL_TRACK]),
    providerSearch: vi.fn().mockResolvedValue(outcome),
    importTrack: vi.fn().mockResolvedValue(LOCAL_TRACK),
    downloadTrack: vi.fn().mockResolvedValue({
      ...LOCAL_TRACK,
      id: 2,
      title: FREESOUND_RESULT.title,
      source: 'freesound',
      license: FREESOUND_RESULT.license,
    }),
    openStorePage: vi.fn().mockResolvedValue(ITUNES_RESULT.deep_link_url),
    openExternal: vi.fn().mockResolvedValue(undefined),
    playbackLoad: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function searchFor(text: string) {
  fireEvent.change(screen.getByTestId('library-search-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('library-search-button'));
  await waitFor(() => expect(screen.queryAllByTestId('provider-result')).toHaveLength(3));
}

describe('LibraryView', () => {
  it('lists local library tracks on mount with source and license tags', async () => {
    const client = mockClient();
    render(<LibraryView client={client} />);
    await waitFor(() => expect(screen.getAllByTestId('library-track')).toHaveLength(1));
    expect(client.tracks).toHaveBeenCalled();
    expect(screen.getByText('Basement Loop')).toBeTruthy();
    const row = screen.getByTestId('library-track');
    expect(row.querySelector('[data-testid="source-tag"]')?.textContent).toBe('watch');
    expect(row.querySelector('[data-testid="license-tag"]')?.textContent).toBe('unknown');
  });

  it('search fans out to local library and providers', async () => {
    const client = mockClient();
    render(<LibraryView client={client} />);
    await searchFor('daft punk');
    expect(client.search).toHaveBeenCalledWith('daft punk');
    expect(client.providerSearch).toHaveBeenCalledWith('daft punk');
  });

  it('provider results carry source and license tags and preview links', async () => {
    render(<LibraryView client={mockClient()} />);
    await searchFor('daft punk');
    const results = screen.getAllByTestId('provider-result');
    const sources = results.map((r) => r.querySelector('[data-testid="source-tag"]')?.textContent);
    expect(sources).toEqual(['itunes', 'freesound', 'internet_archive']);
    const licenses = results.map(
      (r) => r.querySelector('[data-testid="license-tag"]')?.textContent,
    );
    expect(licenses).toEqual(['commercial', 'cc-by', 'cc0']);
    const previews = screen.getAllByTestId('preview-link');
    expect(previews.map((a) => a.getAttribute('href'))).toEqual([
      ITUNES_RESULT.preview_url,
      FREESOUND_RESULT.preview_url,
      IA_RESULT.preview_url,
    ]);
  });

  it('Internet Archive results get a Download action even though their download URL resolves later', async () => {
    const client = mockClient();
    render(<LibraryView client={client} />);
    await searchFor('grateful dead');
    const iaRow = screen
      .getAllByTestId('provider-result')
      .find(
        (r) => r.querySelector('[data-testid="source-tag"]')?.textContent === 'internet_archive',
      )!;
    // Regression: IA has download_url = null + a deep_link_url; it must
    // still be a Download (an "Open Store" action would fail for IA).
    expect(iaRow.querySelector('[data-testid="download-button"]')).toBeTruthy();
    expect(iaRow.querySelector('[data-testid="open-store-button"]')).toBeNull();
    fireEvent.click(iaRow.querySelector('[data-testid="download-button"]')!);
    await waitFor(() =>
      expect(client.downloadTrack).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'internet_archive', id: 'gd1977-05-08' }),
      ),
    );
  });

  it('preview links open in the system browser, not the webview', async () => {
    const client = mockClient();
    render(<LibraryView client={client} />);
    await searchFor('daft punk');
    const [itunesPreview] = screen.getAllByTestId('preview-link');
    // In-page navigation must be prevented (would take over the app UI)…
    const navigated = fireEvent.click(itunesPreview);
    expect(navigated).toBe(false); // false = preventDefault() was called
    // …and the URL is dispatched to the system's default browser instead.
    expect(client.openExternal).toHaveBeenCalledWith(ITUNES_RESULT.preview_url);
  });

  it('failed providers are reported without breaking the result list', async () => {
    render(<LibraryView client={mockClient()} />);
    await searchFor('anything');
    expect(screen.getByTestId('provider-errors').textContent).toContain('jamendo');
  });

  it('Download pulls the result into the library and refreshes the list', async () => {
    const client = mockClient();
    render(<LibraryView client={client} />);
    await searchFor('amen');
    // Freesound and Internet Archive are direct downloads (itunes is not).
    const buttons = screen.getAllByTestId('download-button');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    await waitFor(() =>
      expect(client.downloadTrack).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'freesound', id: '123456' }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('library-status').textContent).toContain('amen break 174bpm'),
    );
    // Local list re-queried after the download.
    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it('iTunes results expose Open Store (deep link), not Download', async () => {
    const client = mockClient();
    render(<LibraryView client={client} />);
    await searchFor('daft punk');
    const openStore = screen.getAllByTestId('open-store-button');
    expect(openStore).toHaveLength(1);
    fireEvent.click(openStore[0]);
    await waitFor(() =>
      expect(client.openStorePage).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'itunes', id: '1440764401' }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('library-status').textContent).toContain(
        'https://music.apple.com/us/album/x?i=1440764401',
      ),
    );
  });
});
