// Choosing what a new Grid row plays: A WHOLE TRACK, or one clip inside
// it.
//
// The list is TRACKS — the thing a user is looking for is a song, not a
// clip id — and each is both a button and a disclosure: clicking the row
// takes the whole track (every clip cut from it, each landing as its own
// row of the same group), while the chevron expands it to the clips so
// one can be taken on its own. That is the ONE list, so a track with a
// single clip costs one click either way.
//
// Clips that record no source still have to be reachable, so they are
// gathered under one heading like everywhere else in the app
// (`songsByBpm`'s "no source recorded") rather than left out.

import { useMemo, useState } from 'react';
import { clipArtistNames, type BeatClipEntry } from '../beatClip';
import { fixed } from '../format';

export interface GridPickerTrack {
  key: string;
  title: string;
  artist: string | null;
  clips: BeatClipEntry[];
}

/** The clips grouped by the track they were cut from, by title. A clip
 *  cut from two tracks belongs to both — it is one clip either way. */
export function pickerTracks(clips: readonly BeatClipEntry[]): GridPickerTrack[] {
  const groups = new Map<string, GridPickerTrack>();
  for (const clip of clips) {
    const sources = clip.sources.length ? clip.sources : [null];
    for (const source of sources) {
      const key = source?.trackHash ?? '';
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          title: source ? (source.title ?? 'source not in the library') : 'no source recorded',
          artist: source?.artist ?? null,
          clips: [],
        };
        groups.set(key, group);
      }
      if (!group.clips.includes(clip)) group.clips.push(clip);
    }
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
}

export interface GridClipPickerProps {
  clips: BeatClipEntry[];
  /** One or more clips chosen: a whole track hands over all of its. */
  onPick(clips: BeatClipEntry[]): void;
  onClose(): void;
}

export function GridClipPicker({ clips, onPick, onClose }: GridClipPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const tracks = useMemo(() => pickerTracks(clips), [clips]);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return tracks;
    return tracks.filter((t) => {
      const hay =
        `${t.title} ${t.artist ?? ''} ${t.clips.map((c) => c.name).join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [tracks, query]);

  return (
    <div
      className="file-dialog-backdrop"
      data-testid="grid-picker"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="file-dialog grid-picker" role="dialog" aria-label="Add a beat clip">
        <h3>Add a beat clip</h3>
        <input
          className="grid-picker-search"
          data-testid="grid-picker-search"
          type="search"
          placeholder="Search tracks and clips"
          aria-label="Search tracks and clips"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="grid-picker-list">
          {shown.length === 0 && (
            <p className="file-dialog-empty" data-testid="grid-picker-empty">
              No beat clips yet — cut one on the Clip page.
            </p>
          )}
          {shown.map((track) => (
            <div className="grid-picker-track" key={track.key}>
              <div className="grid-picker-track-row">
                <button
                  className="grid-picker-expand"
                  data-testid={`grid-picker-expand-${track.key}`}
                  aria-expanded={open === track.key}
                  aria-label={`Show the clips cut from ${track.title}`}
                  onClick={() => setOpen(open === track.key ? null : track.key)}
                >
                  {open === track.key ? '▾' : '▸'}
                </button>
                <button
                  className="grid-picker-track-pick"
                  data-testid={`grid-picker-track-${track.key}`}
                  title="Add every clip cut from this track"
                  onClick={() => onPick(track.clips)}
                >
                  <span className="grid-picker-title">{track.title}</span>
                  {track.artist && <span className="grid-picker-artist">{track.artist}</span>}
                  <span className="grid-picker-count mono">
                    {track.clips.length} clip{track.clips.length === 1 ? '' : 's'}
                  </span>
                </button>
              </div>
              {open === track.key && (
                <div className="grid-picker-clips" data-testid={`grid-picker-clips-${track.key}`}>
                  {track.clips.map((clip) => (
                    <button
                      className="grid-picker-clip"
                      data-testid={`grid-picker-clip-${clip.clipId}`}
                      key={clip.clipId}
                      onClick={() => onPick([clip])}
                    >
                      <span className="grid-picker-clip-name">{clip.name}</span>
                      <span className="grid-picker-clip-meta mono">
                        {clip.beats} beats · {fixed(clip.bpm, 1)} bpm
                      </span>
                      {clipArtistNames(clip).length > 0 && (
                        <span className="grid-picker-artist">
                          {clipArtistNames(clip).join(', ')}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <button className="file-dialog-cancel" data-testid="grid-picker-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
