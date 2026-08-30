// Library view (M1, PRD §9): local library + per-store search tabs.
// Each enabled provider gets its own tab with store-specific filters;
// results are tagged by source and license. Download providers pull
// straight into the library (in the background — see the job poll below),
// DeepLink providers open the store page.

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, logError } from '../errors';
import { fixed } from '../format';
import type {
  AnalysisQueue,
  DownloadJob,
  LibraryClientApi,
  ProviderInfo,
  Track,
  TrackResult,
} from '../library';

const ANALYSIS_POLL_MS = 2000;
// Downloads are backend threads (yt-dlp can run for minutes); poll their
// progress only while something is in flight.
const DOWNLOAD_POLL_MS = 500;
// The Downloads panel is a status line, not a history: at most this many
// finished outcomes, newest first. In-flight jobs (queued included — a
// running job's stage says which) always show, over and above the cap.
const RECENT_DOWNLOADS_SHOWN = 3;

// Newest first, every in-flight job, and only the most recent finished few.
function visibleJobs(jobs: DownloadJob[]): DownloadJob[] {
  const shown: DownloadJob[] = [];
  let finished = 0;
  for (const job of [...jobs].reverse()) {
    if (job.state !== 'running' && finished++ >= RECENT_DOWNLOADS_SHOWN) continue;
    shown.push(job);
  }
  return shown;
}

function formatDuration(secs: number | null): string {
  if (secs == null || !Number.isFinite(secs)) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Button label for a running job: percentage when the backend knows the
// transfer size, the stage otherwise (yt-dlp reports both).
function downloadLabel(job: DownloadJob): string {
  if (job.fraction != null) return `${Math.round(job.fraction * 100)}%`;
  return `${job.stage}…`;
}

// One row of the Downloads panel: a running job shows its progress (bar +
// percentage when the size is known, the stage otherwise); a finished one
// shows its outcome.
function DownloadRow({ job }: { job: DownloadJob }) {
  return (
    <li className={`download-job download-job-${job.state}`} data-testid="download-job">
      <span className="download-job-title">{job.title}</span>
      <SourceTag source={job.provider} />
      {job.state === 'running' ? (
        <span className="download-job-progress" data-testid="download-job-progress">
          <span className="download-bar">
            <span
              className="download-bar-fill"
              style={{ width: `${Math.round((job.fraction ?? 0) * 100)}%` }}
            />
          </span>
          {downloadLabel(job)}
        </span>
      ) : (
        <span
          className={`tag tag-download tag-download-${job.state}`}
          data-testid="download-job-state"
          data-tip={job.error ?? undefined}
        >
          {job.state === 'done' ? 'in library' : 'failed'}
        </span>
      )}
    </li>
  );
}

// A row's title or artist: the text as written until it is clicked, an
// input while it is being changed. Enter or leaving the field commits it,
// Escape puts back what was there — the same grammar as renaming a file.
function EditableName({
  value,
  field,
  placeholder,
  onCommit,
}: {
  value: string;
  field: 'title' | 'artist';
  placeholder: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  if (draft === null) {
    return (
      <button
        className="track-name"
        data-testid={`track-${field}`}
        data-tip={`click to rename this ${field}`}
        onClick={() => setDraft(value)}
      >
        {value || <span className="track-name-blank">{placeholder}</span>}
      </button>
    );
  }
  const commit = () => {
    setDraft(null);
    onCommit(draft);
  };
  return (
    <input
      className="track-name-input"
      data-testid={`track-${field}-input`}
      aria-label={field}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
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
  /** Open a track in the Clip editor. Absent means no Edit column. */
  onEdit?: (track: Track) => void;
}

export function LibraryView({ client, onEdit }: LibraryViewProps) {
  const [query, setQuery] = useState('');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  // Active tab: 'local' or a provider id.
  const [tab, setTab] = useState('local');
  // Filter selections per provider, keyed "providerId:filterId".
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [tracks, setTracks] = useState<Track[]>([]);
  const [results, setResults] = useState<TrackResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [watching, setWatching] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [queue, setQueue] = useState<AnalysisQueue | null>(null);
  // The track a Delete button is asking about. Deleting is destructive
  // and unattended (there is no library undo), so it is always confirmed.
  const [pendingDelete, setPendingDelete] = useState<Track | null>(null);

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

  // Background analysis progress: poll the queue; refresh track rows
  // whenever work is in flight so BPM/key appear as they land.
  useEffect(() => {
    let active = false;
    const tick = async () => {
      const q = await client.analysisStatus();
      if (q) {
        setQueue(q);
        const wasActive = active;
        active = q.current !== null || q.queued.length > 0;
        if (active || wasActive) await refreshTracks('');
      }
    };
    const initial = setTimeout(() => void tick(), 0);
    const timer = setInterval(() => void tick(), ANALYSIS_POLL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [client, refreshTracks]);

  const analyze = useCallback(
    async (t: Track) => {
      await client.analyzeTrack(t.id);
      setStatus(`Queued analysis for "${t.title}"`);
      await refreshTracks('');
    },
    [client, refreshTracks],
  );

  // Rename one field of a track. The list is not re-read: the backend
  // returns the row as it now stands, and re-running the query would
  // reorder (or drop) the row the user is still looking at.
  const rename = useCallback(
    async (t: Track, next: Partial<Pick<Track, 'title' | 'artist'>>) => {
      const title = (next.title ?? t.title).trim();
      const artist = (next.artist ?? t.artist).trim();
      if (!title) {
        setStatus(`A track needs a title — “${t.title}” kept its own`);
        return;
      }
      if (title === t.title && artist === t.artist) return;
      const updated = await client.setTrackNames(t.id, title, artist);
      if (!updated) return;
      setTracks((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
    },
    [client],
  );

  // Delete the confirmed track and re-read the list the user is looking
  // at (a search stays a search). What became of the audio file is the
  // backend's call, so the status line reports what it did.
  const remove = useCallback(
    async (t: Track) => {
      setPendingDelete(null);
      const deleted = await client.deleteTrack(t.id);
      if (!deleted) return;
      setStatus(
        deleted.file_removed
          ? `Deleted “${t.title}” and its audio file`
          : `Deleted “${t.title}” — its file stays where it is`,
      );
      await refreshTracks(query);
    },
    [client, query, refreshTracks],
  );

  const pending = queue ? queue.queued.length + (queue.current !== null ? 1 : 0) : 0;
  const analyzed = queue?.counts['done'] ?? 0;
  const failed = queue?.counts['failed'] ?? 0;
  const total = queue ? Object.values(queue.counts).reduce((a, b) => a + b, 0) : 0;

  const active = providers.find((p) => p.id === tab) ?? null;

  const runSearch = useCallback(async () => {
    setStatus(null);
    setError(null);
    // Provider searches can take seconds (yt-dlp is a subprocess); the
    // loading state covers every tab so a slow local query shows it too.
    setSearching(true);
    try {
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
        logError(`search ${active.id}`, e);
        setError(`${active.name}: ${errorMessage(e)}`);
        setResults([]);
      }
    } finally {
      setSearching(false);
    }
  }, [active, client, filters, query, refreshTracks]);

  // Download jobs live in the backend; a poll reports progress and
  // announces each failure exactly once. Successes need no banner — the
  // Recent downloads panel already shows them.
  const announced = useRef<Set<number>>(new Set());
  const pollJobs = useCallback(async (): Promise<boolean> => {
    const list = await client.downloadJobs();
    if (!list) return false;
    setJobs(list);
    let finished = false;
    for (const job of list) {
      if (job.state === 'running' || announced.current.has(job.id)) continue;
      announced.current.add(job.id);
      finished = true;
      if (job.state === 'failed') {
        setStatus(null);
        const detail = `${job.title}: ${job.error ?? 'download failed'}`;
        logError(`download ${job.provider}`, detail);
        setError(detail);
      }
    }
    if (finished) await refreshTracks('');
    return list.some((j) => j.state === 'running');
  }, [client, refreshTracks]);

  // Seed the Downloads panel on mount: jobs live in the backend and
  // survive view switches, so the queue and recent outcomes reappear.
  // Jobs already finished are pre-announced — their status/error banners
  // were shown when they landed (or belong to a previous session).
  useEffect(() => {
    void (async () => {
      const list = await client.downloadJobs();
      if (!list) return;
      for (const job of list) {
        if (job.state !== 'running') announced.current.add(job.id);
      }
      setJobs(list);
      if (list.some((j) => j.state === 'running')) setWatching(true);
    })();
  }, [client]);

  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        const running = await pollJobs();
        if (!running && !cancelled) setWatching(false);
      })();
    }, DOWNLOAD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [watching, pollJobs]);

  const download = useCallback(
    async (r: TrackResult) => {
      setError(null);
      await client.startDownload(r);
      setWatching(await pollJobs());
    },
    [client, pollJobs],
  );

  const jobFor = useCallback(
    (r: TrackResult) =>
      jobs.find((j) => j.provider === r.provider && j.result_id === r.id && j.state === 'running'),
    [jobs],
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
        <button type="submit" disabled={searching} data-testid="library-search-button">
          {searching ? 'Searching…' : 'Search'}
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

      {searching && (
        <p className="search-loading" data-testid="search-loading">
          <span className="search-spinner" aria-hidden="true" />
          Searching {active ? active.name : 'local library'}…
        </p>
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

      {jobs.length > 0 && (
        <div className="download-queue" data-testid="download-queue">
          <h2>Recent downloads</h2>
          <ul>
            {visibleJobs(jobs).map((job) => (
              <DownloadRow key={job.id} job={job} />
            ))}
          </ul>
        </div>
      )}

      {active && results.length === 0 && !searching && (
        <p className="library-empty" data-testid="store-empty">
          Nothing from {active.name} on screen — search above, and results land here with a Download
          button.
        </p>
      )}

      {active && results.length > 0 && (
        <div className="provider-results">
          <h2>{active.name} results</h2>
          <ul>
            {results.map((r) => {
              const job = jobFor(r);
              return (
                <li key={`${r.provider}:${r.id}`} data-testid="provider-result">
                  {r.artwork_url && (
                    <img
                      className="result-art"
                      src={r.artwork_url}
                      alt=""
                      loading="lazy"
                      data-testid="result-art"
                    />
                  )}
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
                      {r.provider === 'youtube' ? 'watch' : 'preview'}
                    </a>
                  )}
                  {r.acquire_kind === 'download' ? (
                    <button
                      onClick={() => void download(r)}
                      disabled={job !== undefined}
                      data-testid="download-button"
                    >
                      {job ? downloadLabel(job) : 'Download'}
                    </button>
                  ) : (
                    <button onClick={() => void openStore(r)} data-testid="open-store-button">
                      Open Store
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {tab === 'local' && (
        <div className="library-tracks">
          <h2>Library</h2>
          {pending > 0 && (
            <p className="analysis-progress" data-testid="analysis-progress">
              Analyzing {pending} track{pending === 1 ? '' : 's'}… ({analyzed}/{total} done
              {failed > 0 ? `, ${failed} failed` : ''})
            </p>
          )}
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
                  <th>BPM</th>
                  <th>Key</th>
                  <th>Source</th>
                  <th>License</th>
                  <th>Analysis</th>
                  {onEdit && <th />}
                  <th />
                </tr>
              </thead>
              <tbody>
                {tracks.map((t) => (
                  <tr key={t.id} data-testid="library-track">
                    <td>
                      <EditableName
                        value={t.title}
                        field="title"
                        placeholder="untitled"
                        onCommit={(title) => void rename(t, { title })}
                      />
                    </td>
                    <td>
                      <EditableName
                        value={t.artist}
                        field="artist"
                        placeholder="unknown artist"
                        onCommit={(artist) => void rename(t, { artist })}
                      />
                    </td>
                    <td>{formatDuration(t.duration_secs)}</td>
                    <td data-testid="track-bpm">{fixed(t.bpm, 1)}</td>
                    <td data-testid="track-key">{t.musical_key ?? '—'}</td>
                    <td>
                      <SourceTag source={t.source} />
                    </td>
                    <td>
                      <LicenseTag kind={t.license.kind} />
                    </td>
                    <td>
                      <span
                        className={`tag tag-analysis tag-analysis-${t.analysis_status}`}
                        data-testid="analysis-status"
                      >
                        {t.analysis_status}
                      </span>
                      {(t.analysis_status === 'done' || t.analysis_status === 'failed') && (
                        <button
                          className="analyze-button"
                          data-testid="analyze-button"
                          data-tip="re-run analysis (cached stems are reused)"
                          onClick={() => void analyze(t)}
                        >
                          ↻
                        </button>
                      )}
                    </td>
                    {onEdit && (
                      <td>
                        <button
                          data-testid="library-edit"
                          data-tip="edit a copy in the Clip page"
                          onClick={() => onEdit(t)}
                        >
                          Edit
                        </button>
                      </td>
                    )}
                    <td>
                      <button
                        className="is-danger"
                        data-testid="library-delete"
                        data-tip="remove this track from the library"
                        onClick={() => setPendingDelete(t)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <p className="library-fair-use" data-testid="library-fair-use">
        If you’re mixing someone else’s music, mix it good. Use short samples and recontextualize,
        or make sure it’s public domain.
      </p>

      {pendingDelete && (
        <div
          className="file-dialog-backdrop"
          data-testid="library-delete-dialog"
          onClick={() => setPendingDelete(null)}
        >
          <div className="file-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete “{pendingDelete.title}”?</h3>
            <p className="file-dialog-empty">
              Its analysis, cue points, saved loops and separated stems go with it, and nothing here
              can be undone. A file this app downloaded or rendered is deleted too; a file of your
              own stays where it is — but the library will not pick it up again by itself.
            </p>
            <button
              className="is-danger"
              data-testid="library-delete-confirm"
              onClick={() => void remove(pendingDelete)}
            >
              Delete Track
            </button>
            <button
              className="file-dialog-cancel"
              data-testid="library-delete-cancel"
              onClick={() => setPendingDelete(null)}
            >
              Keep It
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
