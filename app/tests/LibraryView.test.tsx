// Library view (M1): per-store search tabs. Each provider tab searches that
// store only, with store-specific filters; results carry source/license
// tags; download and deep-link actions call through the client (Tauri IPC
// in the app; a mock here).

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LibraryView } from '../src/components/LibraryView';
import type { LibraryClientApi, ProviderInfo, Track, TrackResult } from '../src/library';

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
  preview_url: 'https://audio-ssl.itunes.apple.com/preview.m4a',
  artwork_url: null,
  license: { kind: 'commercial', name: 'Commercial', url: '', attribution: '' },
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
  preview_url: 'https://freesound.org/previews/123456-hq.mp3',
  artwork_url: null,
  license: { kind: 'cc-by', name: 'CC BY 4.0', url: '', attribution: '' },
  download_url: 'https://freesound.org/previews/123456-hq.mp3',
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

const RESULT_BY_PROVIDER: Record<string, TrackResult[]> = {
  itunes: [ITUNES_RESULT],
  freesound: [FREESOUND_RESULT],
  internet_archive: [IA_RESULT],
};

const PROVIDERS: ProviderInfo[] = [
  {
    id: 'itunes',
    name: 'iTunes Store',
    acquire_kind: 'deep_link',
    filters: [
      {
        id: 'country',
        label: 'Storefront',
        options: [
          { value: '', label: 'United States' },
          { value: 'gb', label: 'United Kingdom' },
        ],
      },
      {
        id: 'explicit',
        label: 'Explicit content',
        options: [
          { value: '', label: 'Include' },
          { value: 'No', label: 'Exclude' },
        ],
      },
    ],
  },
  {
    id: 'freesound',
    name: 'Freesound',
    acquire_kind: 'download',
    filters: [
      {
        id: 'license',
        label: 'License',
        options: [
          { value: '', label: 'Any CC license' },
          { value: 'Creative Commons 0', label: 'CC0 (public domain)' },
        ],
      },
    ],
  },
  {
    id: 'internet_archive',
    name: 'Internet Archive',
    acquire_kind: 'download',
    filters: [
      {
        id: 'collection',
        label: 'Collection',
        options: [
          { value: '', label: 'Any collection' },
          { value: 'etree', label: 'Live Music Archive' },
        ],
      },
    ],
  },
];

function mockClient(overrides: Partial<LibraryClientApi> = {}): LibraryClientApi {
  return {
    tracks: vi.fn().mockResolvedValue([LOCAL_TRACK]),
    search: vi.fn().mockResolvedValue([LOCAL_TRACK]),
    providers: vi.fn().mockResolvedValue(PROVIDERS),
    searchProvider: vi
      .fn()
      .mockImplementation((provider: string) =>
        Promise.resolve(RESULT_BY_PROVIDER[provider] ?? []),
      ),
    importTrack: vi.fn().mockResolvedValue(LOCAL_TRACK),
    downloadTrack: vi.fn().mockResolvedValue({
      ...LOCAL_TRACK,
      id: 2,
      title: 'amen break 174bpm',
      source: 'freesound',
      license: FREESOUND_RESULT.license,
    }),
    openStorePage: vi.fn().mockResolvedValue(ITUNES_RESULT.deep_link_url),
    openExternal: vi.fn().mockResolvedValue(undefined),
    playbackLoad: vi.fn().mockResolvedValue(undefined),
    analysisStatus: vi.fn().mockResolvedValue({ current: null, queued: [], counts: {} }),
    analyzeTrack: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function openTab(provider: string) {
  await waitFor(() => expect(screen.getByTestId(`store-tab-${provider}`)).toBeTruthy());
  fireEvent.click(screen.getByTestId(`store-tab-${provider}`));
}

async function searchStore(provider: string, text: string) {
  await openTab(provider);
  fireEvent.change(screen.getByTestId('library-search-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('library-search-button'));
  await waitFor(() => expect(screen.queryAllByTestId('provider-result').length).toBeGreaterThan(0));
}

describe('LibraryView', () => {
  it('lists local library tracks on mount with source and license tags', async () => {
    const client = mockClient();
    render(<LibraryView client={client} />);
    await waitFor(() => expect(screen.getAllByTestId('library-track')).toHaveLength(1));
    const row = screen.getByTestId('library-track');
    expect(row.textContent).toContain('Basement Loop');
    expect(row.querySelector('[data-testid="source-tag"]')?.textContent).toBe('watch');
    expect(row.querySelector('[data-testid="license-tag"]')?.textContent).toBe('unknown');
  });

  it('renders one tab per enabled provider plus Local', async () => {
    render(<LibraryView client={mockClient()} />);
    await waitFor(() => expect(screen.getByTestId('store-tab-internet_archive')).toBeTruthy());
    const tabs = screen.getByTestId('store-tabs');
    expect(tabs.textContent).toContain('Local');
    expect(tabs.textContent).toContain('iTunes Store');
    expect(tabs.textContent).toContain('Freesound');
    expect(tabs.textContent).toContain('Internet Archive');
  });

  it('searches one store at a time from its tab', async () => {
    const client = mockClient();
    render(<LibraryView client={client} />);
    await searchStore('itunes', 'daft punk');
    expect(client.searchProvider).toHaveBeenCalledTimes(1);
    expect(client.searchProvider).toHaveBeenCalledWith('itunes', 'daft punk', {});
    const results = screen.getAllByTestId('provider-result');
    expect(results).toHaveLength(1);
    expect(results[0].querySelector('[data-testid="source-tag"]')?.textContent).toBe('itunes');
    expect(results[0].querySelector('[data-testid="license-tag"]')?.textContent).toBe('commercial');
  });

  it('renders store-specific filters and passes selections to the search', async () => {
    const client = mockClient();
    render(<LibraryView client={client} />);
    await openTab('itunes');
    // iTunes tab exposes its own filters.
    expect(screen.getByTestId('store-filters').textContent).toContain('Storefront');
    fireEvent.change(screen.getByTestId('filter-country'), { target: { value: 'gb' } });
    fireEvent.change(screen.getByTestId('filter-explicit'), { target: { value: 'No' } });
    fireEvent.change(screen.getByTestId('library-search-input'), {
      target: { value: 'daft punk' },
    });
    fireEvent.click(screen.getByTestId('library-search-button'));
    await waitFor(() =>
      expect(client.searchProvider).toHaveBeenCalledWith('itunes', 'daft punk', {
        country: 'gb',
        explicit: 'No',
      }),
    );

    // Filters are per store: Internet Archive shows its own set.
    await openTab('internet_archive');
    expect(screen.getByTestId('store-filters').textContent).toContain('Collection');
    expect(screen.queryByTestId('filter-country')).toBeNull();
  });

  it('shows the provider error when a store search fails', async () => {
    const client = mockClient({
      searchProvider: vi.fn().mockRejectedValue('HTTP 500'),
    });
    render(<LibraryView client={client} />);
    await openTab('freesound');
    fireEvent.click(screen.getByTestId('library-search-button'));
    await waitFor(() =>
      expect(screen.getByTestId('provider-error').textContent).toContain('Freesound'),
    );
    expect(screen.queryAllByTestId('provider-result')).toHaveLength(0);
  });

  it('Internet Archive results get a Download action even though their download URL resolves later', async () => {
    const client = mockClient();
    render(<LibraryView client={client} />);
    await searchStore('internet_archive', 'grateful dead');
    const row = screen.getByTestId('provider-result');
    // Regression: IA has download_url = null + a deep_link_url; it must
    // still be a Download (an "Open Store" action would fail for IA).
    expect(row.querySelector('[data-testid="download-button"]')).toBeTruthy();
    expect(row.querySelector('[data-testid="open-store-button"]')).toBeNull();
    fireEvent.click(row.querySelector('[data-testid="download-button"]')!);
    await waitFor(() =>
      expect(client.downloadTrack).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'internet_archive', id: 'gd1977-05-08' }),
      ),
    );
  });

  it('preview links open in the system browser, not the webview', async () => {
    const client = mockClient();
    render(<LibraryView client={client} />);
    await searchStore('itunes', 'daft punk');
    const preview = screen.getByTestId('preview-link');
    // In-page navigation must be prevented (would take over the app UI)…
    const navigated = fireEvent.click(preview);
    expect(navigated).toBe(false); // false = preventDefault() was called
    // …and the URL is dispatched to the system's default browser instead.
    expect(client.openExternal).toHaveBeenCalledWith(ITUNES_RESULT.preview_url);
  });

  it('Download pulls the result into the library and refreshes the list', async () => {
    const client = mockClient();
    render(<LibraryView client={client} />);
    await searchStore('freesound', 'amen');
    fireEvent.click(screen.getByTestId('download-button'));
    await waitFor(() =>
      expect(client.downloadTrack).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'freesound', id: '123456' }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('library-status').textContent).toContain('amen break 174bpm'),
    );
    // Local list re-queried after the download.
    expect(client.tracks).toHaveBeenCalledTimes(2);
  });

  it('iTunes results expose Open Store (deep link), not Download', async () => {
    const client = mockClient();
    render(<LibraryView client={client} />);
    await searchStore('itunes', 'daft punk');
    const openStore = screen.getAllByTestId('open-store-button');
    expect(openStore).toHaveLength(1);
    expect(screen.queryByTestId('download-button')).toBeNull();
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

  it('shows BPM, key, and analysis status per track once analysis lands', async () => {
    const analyzed: Track = {
      ...LOCAL_TRACK,
      analysis_status: 'done',
      bpm: 128.3,
      musical_key: 'Am',
    };
    const client = mockClient({ tracks: vi.fn().mockResolvedValue([analyzed]) });
    render(<LibraryView client={client} />);
    await waitFor(() => expect(screen.getByTestId('track-bpm').textContent).toBe('128.3'));
    expect(screen.getByTestId('track-key').textContent).toBe('Am');
    expect(screen.getByTestId('analysis-status').textContent).toBe('done');
  });

  it('re-run button queues analysis for an analyzed track', async () => {
    const analyzed: Track = { ...LOCAL_TRACK, analysis_status: 'done', bpm: 120, musical_key: 'C' };
    const client = mockClient({ tracks: vi.fn().mockResolvedValue([analyzed]) });
    render(<LibraryView client={client} />);
    const btn = await screen.findByTestId('analyze-button');
    fireEvent.click(btn);
    await waitFor(() => expect(client.analyzeTrack).toHaveBeenCalledWith(LOCAL_TRACK.id));
    await waitFor(() =>
      expect(screen.getByTestId('library-status').textContent).toContain('Queued analysis'),
    );
  });

  it('shows batch queue progress while the worker is busy and hides it when idle', async () => {
    const client = mockClient({
      analysisStatus: vi.fn().mockResolvedValue({
        current: 1,
        queued: [2, 3],
        counts: { done: 5, queued: 2, analyzing: 1 },
      }),
    });
    render(<LibraryView client={client} />);
    await waitFor(() =>
      expect(screen.getByTestId('analysis-progress').textContent).toContain('Analyzing 3 tracks'),
    );
    expect(screen.getByTestId('analysis-progress').textContent).toContain('(5/8 done');

    // No pending work -> no banner.
    const idle = mockClient();
    render(<LibraryView client={idle} />);
    await waitFor(() => expect(idle.analysisStatus).toHaveBeenCalled());
    expect(screen.queryAllByTestId('analysis-progress')).toHaveLength(1); // only the busy one
  });
});
