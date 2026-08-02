// Library / acquisition bridge over Tauri IPC (M1). Mirrors
// crates/dj-library types; falls back to nulls outside Tauri so the UI
// stays testable headless (tests inject a mock client).

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

export interface TrackResult {
  provider: string;
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

export interface SearchOutcome {
  results: TrackResult[];
  errors: [string, string][];
}

/** What LibraryView needs; the Tauri-backed client below implements it and
 *  tests substitute a mock. */
export interface LibraryClientApi {
  tracks(): Promise<Track[] | null>;
  search(text: string): Promise<Track[] | null>;
  providerSearch(text: string): Promise<SearchOutcome | null>;
  importTrack(path: string): Promise<Track | null>;
  downloadTrack(result: TrackResult): Promise<Track | null>;
  openStorePage(result: TrackResult): Promise<string | null>;
  playbackLoad(instance: string, trackId: number): Promise<void | null>;
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

async function tauriInvoke(): Promise<Invoke | null> {
  if (!('__TAURI_INTERNALS__' in window)) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke as Invoke;
}

export class LibraryClient implements LibraryClientApi {
  private invoke: Invoke | null = null;
  private ready: Promise<void>;

  constructor() {
    this.ready = tauriInvoke().then((inv) => {
      this.invoke = inv;
    });
  }

  private async call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
    await this.ready;
    if (!this.invoke) return null;
    return (await this.invoke(cmd, args)) as T;
  }

  tracks() {
    return this.call<Track[]>('library_tracks');
  }
  search(text: string) {
    return this.call<Track[]>('library_search', { text });
  }
  providerSearch(text: string) {
    return this.call<SearchOutcome>('provider_search', { text });
  }
  importTrack(path: string) {
    return this.call<Track>('import_track', { path });
  }
  downloadTrack(result: TrackResult) {
    return this.call<Track>('download_track', { result });
  }
  openStorePage(result: TrackResult) {
    return this.call<string>('open_store_page', { result });
  }
  playbackLoad(instance: string, trackId: number) {
    return this.call<void>('playback_load', { instance, trackId });
  }
}

export const library = new LibraryClient();
