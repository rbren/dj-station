// Library / acquisition bridge over Tauri IPC (M1). Mirrors
// crates/dj-library types; falls back to nulls outside Tauri so the UI
// stays testable headless (tests inject a mock client).

import { IpcClient } from './ipc';

export interface LicenseInfo {
  kind: string;
  name: string;
  url: string;
  attribution: string;
}

export interface Track {
  id: number;
  title: string;
  artist: string;
  album: string;
  file_path: string;
  content_hash: string;
  format: string;
  duration_secs: number | null;
  sample_rate: number | null;
  channels: number | null;
  source: string;
  source_ref: string;
  license: LicenseInfo;
  analysis_status: string;
  bpm: number | null;
  musical_key: string | null;
  created_at: string;
  updated_at: string;
}

/** What a delete took with it: the row that is gone, and whether its
 *  audio file went too (only files the app downloaded or rendered do). */
export interface DeletedTrack {
  track: Track;
  file_removed: boolean;
}

export interface TrackResult {
  provider: string;
  /** How this result is acquired. Explicit because a Download provider's
   *  URL may only be resolved at acquire time (e.g. Internet Archive). */
  acquire_kind: 'download' | 'deep_link';
  id: string;
  title: string;
  artist: string;
  album: string;
  duration_secs: number | null;
  preview_url: string | null;
  artwork_url: string | null;
  license: LicenseInfo;
  download_url: string | null;
  deep_link_url: string | null;
}

export interface FilterOption {
  value: string;
  label: string;
}

/** A select-style filter a provider supports (first option = default). */
export interface FilterSpec {
  id: string;
  label: string;
  options: FilterOption[];
}

export interface ProviderInfo {
  id: string;
  name: string;
  acquire_kind: 'download' | 'deep_link';
  filters: FilterSpec[];
}

/** A provider download running in the background (or recently finished). */
export interface DownloadJob {
  id: number;
  provider: string;
  /** Provider-side result id — matches a job to its result row. */
  result_id: string;
  title: string;
  state: 'running' | 'done' | 'failed';
  /** Completed fraction (0..1) when the transfer size is known. */
  fraction: number | null;
  stage: string;
  error: string | null;
  track_id: number | null;
}

/** Analysis queue snapshot (M3): background worker progress. */
export interface AnalysisQueue {
  /** Track id currently being analyzed, if any. */
  current: number | null;
  /** Track ids still waiting, in queue order. */
  queued: number[];
  /** Track counts by analysis status (queued/analyzing/done/failed). */
  counts: Record<string, number>;
}

/** What LibraryView needs; the Tauri-backed client below implements it and
 *  tests substitute a mock. */
export interface LibraryClientApi {
  tracks(): Promise<Track[] | null>;
  search(text: string): Promise<Track[] | null>;
  /** Enabled providers with their per-store filter specs. */
  providers(): Promise<ProviderInfo[] | null>;
  /** Search one store with that store's filter selections. */
  searchProvider(
    provider: string,
    text: string,
    filters: Record<string, string>,
  ): Promise<TrackResult[] | null>;
  importTrack(path: string): Promise<Track | null>;
  /** Rename a track. Returns the row as it now stands (the backend trims
   *  both fields and refuses a blank title). */
  setTrackNames(trackId: number, title: string, artist: string): Promise<Track | null>;
  /** Delete a track: its row and DJ metadata, its cached stems, and the
   *  audio file when the app owns it (a download or a rendered clip). */
  deleteTrack(trackId: number): Promise<DeletedTrack | null>;
  /** Import a rekordbox XML export (M4): tracks/beatgrids/cues/loops. */
  importRekordbox(path: string): Promise<{ imported: number; duplicates: number } | null>;
  /** Queue a download; the transfer runs on a backend thread. Returns the
   *  job id whose progress `downloadJobs` reports. */
  startDownload(result: TrackResult): Promise<number | null>;
  /** Running/recent download jobs (polled while a download is in flight). */
  downloadJobs(): Promise<DownloadJob[] | null>;
  openStorePage(result: TrackResult): Promise<string | null>;
  /** Open a web URL in the system's default browser (never the webview). */
  openExternal(url: string): Promise<void | null>;
  playbackLoad(instance: string, trackId: number): Promise<void | null>;
  /** Background analysis queue snapshot (M3). */
  analysisStatus(): Promise<AnalysisQueue | null>;
  /** Queue (or re-run) analysis for a track. */
  analyzeTrack(trackId: number): Promise<void | null>;
}

export class LibraryClient extends IpcClient implements LibraryClientApi {
  tracks() {
    return this.call<Track[]>('library_tracks');
  }
  search(text: string) {
    return this.call<Track[]>('library_search', { text });
  }
  providers() {
    return this.call<ProviderInfo[]>('providers');
  }
  searchProvider(provider: string, text: string, filters: Record<string, string>) {
    return this.call<TrackResult[]>('search_provider', { provider, text, filters });
  }
  importTrack(path: string) {
    return this.call<Track>('import_track', { path });
  }
  setTrackNames(trackId: number, title: string, artist: string) {
    return this.call<Track>('set_track_names', { trackId, title, artist });
  }
  deleteTrack(trackId: number) {
    return this.call<DeletedTrack>('delete_track', { trackId });
  }
  importRekordbox(path: string) {
    return this.call<{ imported: number; duplicates: number }>('import_rekordbox', { path });
  }
  startDownload(result: TrackResult) {
    return this.call<number>('start_download', { result });
  }
  downloadJobs() {
    return this.call<DownloadJob[]>('download_jobs');
  }
  openStorePage(result: TrackResult) {
    return this.call<string>('open_store_page', { result });
  }
  async openExternal(url: string) {
    await this.ready;
    if (!this.invoke) {
      // Plain-browser dev mode: a new tab is the "default browser" here.
      window.open(url, '_blank', 'noopener,noreferrer');
      return null;
    }
    return this.call<void>('open_external', { url });
  }
  playbackLoad(instance: string, trackId: number) {
    return this.call<void>('playback_load', { instance, trackId });
  }
  analysisStatus() {
    return this.call<AnalysisQueue>('analysis_status');
  }
  analyzeTrack(trackId: number) {
    return this.call<void>('analyze_track', { trackId });
  }
}

export const library = new LibraryClient();
