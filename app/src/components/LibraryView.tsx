// Library view (M1, PRD §9): local library + per-store search tabs.
// Each enabled provider gets its own tab with store-specific filters;
// results are tagged by source and license. Download providers pull
// straight into the library, DeepLink providers open the store page.

import { useCallback, useEffect, useState } from 'react';
import type { LibraryClientApi, ProviderInfo, Track, TrackResult } from '../library';

function formatDuration(secs: number | null): string {
  if (secs == null) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function LicenseTag({ kind }: { kind: string }) {
  return (
    <span className={`tag tag-license tag-license-${kind}`} data-testid="license-tag">
      {kind}
    </span>
  );
}

function SourceTag({ source }: { source: string }) {
  return (
    <span className="tag tag-source" data-testid="source-tag">
      {source}
    </span>
  );
}

export interface LibraryViewProps {
  client: LibraryClientApi;
}

export function LibraryView({ client }: LibraryViewProps) {
  const [query, setQuery] = useState('');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  // Active tab: 'local' or a provider id.
  const [tab, setTab] = useState('local');
  // Filter selections per provider, keyed "providerId:filterId".
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [tracks, setTracks] = useState<Track[]>([]);
  const [results, setResults] = useState<TrackResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const refreshTracks = useCallback(
    async (text: string) => {
      const local = text.trim() ? await client.search(text) : await client.tracks();
      if (local) setTracks(local);
    },
    [client],
  );

  useEffect(() => {
    (async () => {
      const [, available] = await Promise.all([refreshTracks(''), client.providers()]);
      if (available) setProviders(available);
    })();
  }, [client, refreshTracks]);

  const active = providers.find((p) => p.id === tab) ?? null;

  const runSearch = useCallback(async () => {
    setStatus(null);
    setError(null);
    if (!active) {
      await refreshTracks(query);
      return;
    }
    const selected: Record<string, string> = {};
    for (const f of active.filters) {
      const v = filters[`${active.id}:${f.id}`];
      if (v) selected[f.id] = v;
    }
    try {
      const remote = await client.searchProvider(active.id, query, selected);
      if (remote) setResults(remote);
    } catch (e) {
      setError(`${active.name}: ${String(e)}`);
      setResults([]);
    }
  }, [active, client, filters, query, refreshTracks]);

  const download = useCallback(
    async (r: TrackResult) => {
      setBusy(`${r.provider}:${r.id}`);
      try {
        const track = await client.downloadTrack(r);
        if (track) setStatus(`Downloaded "${track.title}" into the library`);
        await refreshTracks('');
      } finally {
        setBusy(null);
      }
    },
    [client, refreshTracks],
  );

  const openStore = useCallback(
    async (r: TrackResult) => {
      const url = await client.openStorePage(r);
      if (url) setStatus(`Opened store page: ${url}`);
    },
    [client],
  );

  return (
    <section className="library" data-testid="library-view">
      <nav className="store-tabs" data-testid="store-tabs">
        <button
          className={tab === 'local' ? 'store-tab active' : 'store-tab'}
          data-testid="store-tab-local"
          onClick={() => setTab('local')}
        >
          Local
        </button>
        {providers.map((p) => (
          <button
            key={p.id}
            className={tab === p.id ? 'store-tab active' : 'store-tab'}
            data-testid={`store-tab-${p.id}`}
            onClick={() => {
              setTab(p.id);
              setResults([]);
              setError(null);
            }}
          >
            {p.name}
          </button>
        ))}
      </nav>

      <form
        className="library-search"
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch();
        }}
      >
        <input
          type="search"
          placeholder={active ? `Search ${active.name}…` : 'Search local library…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="library-search-input"
        />
        <button type="submit" data-testid="library-search-button">
          Search
        </button>
      </form>

      {active && active.filters.length > 0 && (
        <div className="store-filters" data-testid="store-filters">
          {active.filters.map((f) => {
            const key = `${active.id}:${f.id}`;
            return (
              <label key={key} className="store-filter">
                <span>{f.label}</span>
                <select
                  value={filters[key] ?? ''}
                  data-testid={`filter-${f.id}`}
                  onChange={(e) => setFilters((prev) => ({ ...prev, [key]: e.target.value }))}
                >
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      )}

      {status && (
        <p className="library-status" data-testid="library-status">
          {status}
        </p>
      )}
      {error && (
        <p className="library-errors" data-testid="provider-error">
          {error}
        </p>
      )}

      {active && results.length > 0 && (
        <div className="provider-results">
          <h2>{active.name} results</h2>
          <ul>
            {results.map((r) => (
              <li key={`${r.provider}:${r.id}`} data-testid="provider-result">
                <span className="result-title">
                  {r.title} — {r.artist}
                </span>
                <SourceTag source={r.provider} />
                <LicenseTag kind={r.license.kind} />
                <span className="result-duration">{formatDuration(r.duration_secs)}</span>
                {r.preview_url && (
                  <a
                    href={r.preview_url}
                    data-testid="preview-link"
                    onClick={(e) => {
                      // Never navigate the app webview — open in the
                      // system's default browser instead.
                      e.preventDefault();
                      void client.openExternal(r.preview_url!);
                    }}
                  >
                    preview
                  </a>
                )}
                {r.acquire_kind === 'download' ? (
                  <button
                    onClick={() => void download(r)}
                    disabled={busy === `${r.provider}:${r.id}`}
                    data-testid="download-button"
                  >
                    {busy === `${r.provider}:${r.id}` ? 'Downloading…' : 'Download'}
                  </button>
                ) : (
                  <button onClick={() => void openStore(r)} data-testid="open-store-button">
                    Open Store
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === 'local' && (
        <div className="library-tracks">
          <h2>Library</h2>
          {tracks.length === 0 ? (
            <p className="library-empty" data-testid="library-empty">
              No tracks yet — search a store tab, or drop files into a watch folder.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Artist</th>
                  <th>Length</th>
                  <th>Source</th>
                  <th>License</th>
                  <th>Analysis</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((t) => (
                  <tr key={t.id} data-testid="library-track">
                    <td>{t.title}</td>
                    <td>{t.artist}</td>
                    <td>{formatDuration(t.duration_secs)}</td>
                    <td>
                      <SourceTag source={t.source} />
                    </td>
                    <td>
                      <LicenseTag kind={t.license.kind} />
                    </td>
                    <td>{t.analysis_status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
