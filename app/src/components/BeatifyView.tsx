// Beatify tab: pick a library track, prove its grid in the import modal,
// then live in the track view.
//
// MOD-A31: an already-beatified track skips the modal entirely and opens
// straight into the track view; the modal is reachable from there via
// "Re-beatify", which warns that re-saving invalidates anything already
// cut from the old grid.
//
// `beat_this` is optional (PyTorch): when it is missing the tab still
// works on the built-in DSP tracker and says so, with the install hint —
// the same contract as the YouTube provider without `yt-dlp`.

import { useCallback, useEffect, useState } from 'react';
import type { BeatifyClientApi, BeatifyTrack, TrackerStatus } from '../beatify';
import type { BeatifyClipClientApi } from '../beatifyClip';
import type { LibraryClientApi, Track } from '../library';
import { BeatifyClipBuilder } from './BeatifyClipBuilder';
import { BeatifyModal } from './BeatifyModal';

const BUCKETS = 1400;

export interface BeatifyViewProps {
  client: BeatifyClientApi;
  library: LibraryClientApi;
  /** The clip builder's own commands (sources, assembly, saved clips). */
  clips: BeatifyClipClientApi;
}

export function BeatifyView({ client, library, clips }: BeatifyViewProps) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [pick, setPick] = useState<number | null>(null);
  const [tracker, setTracker] = useState<TrackerStatus | null>(null);
  const [beatified, setBeatified] = useState<BeatifyTrack | null>(null);
  const [modal, setModal] = useState<{ trackId: number; title: string } | null>(null);
  const [warn, setWarn] = useState<{ trackId: number; title: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const list = await library.tracks();
      if (list) {
        setTracks(list);
        setPick((cur) => cur ?? list[0]?.id ?? null);
      }
      setTracker(await client.trackerStatus());
    })();
  }, [client, library]);

  const open = useCallback(
    async (trackId: number) => {
      const track = tracks.find((t) => t.id === trackId);
      setBusy(true);
      setStatus(null);
      const saved = await client.load(trackId, BUCKETS);
      setBusy(false);
      if (saved) {
        // No announcement: the track appearing with its grid on it says
        // everything the message did.
        setBeatified(saved);
        setModal(null);
        return;
      }
      setBeatified(null);
      setModal({ trackId, title: track?.title ?? `track ${trackId}` });
    },
    [client, tracks],
  );

  const committed = useCallback((track: BeatifyTrack) => {
    setBeatified(track);
    setModal(null);
    setStatus(
      `Beatified "${track.title}" — ${track.record.grid.beats} beats at ${track.record.grid.bpm.toFixed(2)} BPM`,
    );
  }, []);

  return (
    <section className="beatify-view" data-testid="beatify-view">
      <div className="beatify-bar">
        <label>
          <span>Track</span>
          <select
            data-testid="beatify-track-select"
            value={pick ?? ''}
            onChange={(e) => setPick(Number(e.target.value))}
          >
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title} — {t.artist}
              </option>
            ))}
          </select>
        </label>
        <button
          data-testid="beatify-open"
          disabled={pick === null || busy}
          onClick={() => pick !== null && void open(pick)}
        >
          Open
        </button>
        {tracker && (
          <span
            className={tracker.beatThis ? 'beatify-tracker' : 'beatify-tracker fallback'}
            data-testid="beatify-tracker-status"
            title={tracker.beatThis ? tracker.python : tracker.detail}
          >
            {tracker.beatThis
              ? `tracker ${tracker.tracker} · ${tracker.device}`
              : `beat_this not installed — using the built-in DSP tracker. ${tracker.installHint}`}
          </span>
        )}
      </div>
      {status && <p className="beatify-status">{status}</p>}

      {beatified && (
        <BeatifyClipBuilder
          key={`${beatified.trackId}:${beatified.record.warped}`}
          track={beatified}
          clips={clips}
          onRebeatify={() => setWarn({ trackId: beatified.trackId, title: beatified.title })}
        />
      )}

      {!beatified && !modal && (
        <p className="beatify-empty">
          Pick a track and open it. Beatify detects its beats, fits a grid and renders it at
          constant tempo — beats only: no bars, no meter, no time signature.
        </p>
      )}

      {warn && (
        <div className="beatify-modal-backdrop" data-testid="beatify-rebeatify-warning">
          <div className="beatify-warn">
            <p>
              Re-beatifying re-renders the track. Anything already cut from the old grid — including
              its boundaries — stops matching.
            </p>
            <button data-testid="beatify-rebeatify-cancel" onClick={() => setWarn(null)}>
              Cancel
            </button>
            <button
              data-testid="beatify-rebeatify-confirm"
              onClick={() => {
                setModal(warn);
                setBeatified(null);
                setWarn(null);
              }}
            >
              Re-beatify
            </button>
          </div>
        </div>
      )}

      {modal && (
        <BeatifyModal
          client={client}
          trackId={modal.trackId}
          title={modal.title}
          onCommitted={committed}
          onCancel={() => setModal(null)}
        />
      )}
    </section>
  );
}
