// Library view (M1, PRD §9): local library list + unified provider search.
// Results are tagged by source and license; Download providers pull straight
// into the library, DeepLink providers open the store page.

import { useCallback, useEffect, useState } from 'react';
import type { LibraryClientApi, Track, TrackResult } from '../library';

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
  const [tracks, setTracks] = useState<Track[]>([]);
  const [results, setResults] = useState<TrackResult[]>([]);
  const [errors, setErrors] = useState<[string, string][]>([]);
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
      await refreshTracks('');
    })();
  }, [refreshTracks]);

  const runSearch = useCallback(async () => {
    setStatus(null);
    // Fan out: local library + all enabled providers in parallel.
    const [, remote] = await Promise.all([refreshTracks(query), client.providerSearch(query)]);
    if (remote) {
      setResults(remote.results);
      setErrors(remote.errors);
    }
  }, [client, query, refreshTracks]);

  const download = useCallback(
    async (r: TrackResult) => {
      setBusy(`${r.provider}:${r.id}`);
      try {
        const track = await client.downloadTrack(r);
        if (track) setStatus(`Downloaded "${track.title}" into the library`);
        await refreshTracks(query);
      } finally {
        setBusy(null);
      }
    },
    [client, query, refreshTracks],
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
      <form
        className="library-search"
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch();
        }}
      >
        <input
          type="search"
          placeholder="Search library + providers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="library-search-input"
        />
        <button type="submit" data-testid="library-search-button">
          Search
        </button>
      </form>

      {status && (
        <p className="library-status" data-testid="library-status">
          {status}
        </p>
      )}
      {errors.length > 0 && (
        <ul className="library-errors" data-testid="provider-errors">
          {errors.map(([provider, message]) => (
            <li key={provider}>
              {provider}: {message}
            </li>
          ))}
        </ul>
      )}

      {results.length > 0 && (
        <div className="provider-results">
          <h2>Search results</h2>
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

      <div className="library-tracks">
        <h2>Library</h2>
        {tracks.length === 0 ? (
          <p className="library-empty" data-testid="library-empty">
            No tracks yet — search above, or drop files into a watch folder.
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
    </section>
  );
}
