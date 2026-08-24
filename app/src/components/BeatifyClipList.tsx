// The clip builder's left-hand column: everything this project can be cut
// up into.
//
// A project is a tempo with tracks beatified onto it, so this is a list of
// SEEDS — each one a whole track on the shared grid — followed by the
// clips built so far. Seeds and clips are the same kind of thing here: a
// source you can open in the pane above and take beats from.
//
// STEMS BELONG TO THEIR SEED. They are not entries of their own: each seed
// carries a row of toggles, exactly like the Clip page's, and switching
// one off opens that seed with the rest of it playing. All four on IS the
// whole mix — the render itself, not four files summed back together —
// which is why "all on" is the resting state rather than a special case.
// Stems that have not been separated yet are shown but not selectable,
// with the reason and the fix, as everywhere else in this app.
//
// CLICKING AN ENTRY ONLY CHANGES THE SOURCE. Opening a saved clip to take
// beats from is not the same act as opening it to edit — that is what the
// pencil is for. Nothing here touches the editor except the pencil and
// "+ new clip".

import { speedLabel } from '../beatify';
import type { SourceId } from '../beatifyClip';

export interface ClipListStem {
  name: string;
  on: boolean;
  available: boolean;
  hint: string | null;
}

/** One seed, and the state of its switches. */
export interface ClipListSeed {
  seedId: string;
  /** The id to open: this seed with its current stem selection. */
  id: SourceId;
  label: string;
  beats: number;
  /** The tempo it was played at, before the project conformed it. */
  sourceBpm: number;
  speed: number;
  available: boolean;
  stems: ClipListStem[];
}

export interface ClipListClip {
  id: SourceId;
  label: string;
}

export interface BeatifyClipListProps {
  seeds: readonly ClipListSeed[];
  clips: readonly ClipListClip[];
  selected: SourceId;
  /** Open this as the SOURCE. The editor below is left alone. */
  onSelect(id: SourceId): void;
  /** Flip one of a seed's parts on or off. */
  onToggleStem(seedId: string, name: string): void;
  /** Load this saved clip into the editor, source untouched. */
  onEdit(id: SourceId): void;
  /** Drop a seed from the project, render and all. */
  onRemoveSeed(seedId: string): void;
  /** Start a new, empty clip in the editor. */
  onNew(): void;
  /** Import another track into this project. */
  onImport(): void;
}

export function BeatifyClipList({
  seeds,
  clips,
  selected,
  onSelect,
  onToggleStem,
  onEdit,
  onRemoveSeed,
  onNew,
  onImport,
}: BeatifyClipListProps) {
  return (
    <aside className="beatify-clip-list" data-testid="beatify-clip-list">
      <h3>Seeds</h3>
      <button className="beatify-clip-new" data-testid="beatify-import-seed" onClick={onImport}>
        + import track
      </button>
      <ul className="beatify-seed-list">
        {seeds.length === 0 && (
          <li className="beatify-seed-empty" data-testid="beatify-no-seeds">
            Nothing in this project yet. Import a track: the first one sets the tempo, and every one
            after it is conformed to that tempo so their beats line up.
          </li>
        )}
        {seeds.map((seed) => (
          <li
            className="beatify-seed"
            key={seed.seedId}
            data-testid={`beatify-seed-${seed.seedId}`}
          >
            <button
              data-testid={`beatify-clip-source-${seed.seedId}`}
              className={seed.id === selected ? 'selected' : undefined}
              disabled={!seed.available}
              title={`Open ${seed.label}`}
              onClick={() => onSelect(seed.id)}
            >
              <span className="beatify-clip-source-label">{seed.label}</span>
              <span className="beatify-clip-source-kind">
                {seed.beats} beats · {speedLabel(seed.speed)}
              </span>
            </button>
            <button
              className="beatify-clip-source-edit"
              data-testid={`beatify-seed-delete-${seed.seedId}`}
              title={`Remove ${seed.label} from this project`}
              onClick={() => onRemoveSeed(seed.seedId)}
            >
              ×
            </button>
            <div
              className="beatify-seed-stems"
              data-testid={`beatify-seed-stems-${seed.seedId}`}
              role="group"
              aria-label={`${seed.label} stems`}
            >
              {seed.stems.map((stem) => (
                <button
                  key={stem.name}
                  className={stem.on ? 'beatify-stem-on' : 'beatify-stem-off'}
                  data-testid={`beatify-stem-${seed.seedId}-${stem.name}`}
                  aria-pressed={stem.on}
                  disabled={!stem.available}
                  title={
                    stem.available
                      ? `${stem.on ? 'Drop' : 'Bring back'} the ${stem.name} of ${seed.label}`
                      : (stem.hint ?? 'Stems are not ready yet')
                  }
                  onClick={() => onToggleStem(seed.seedId, stem.name)}
                >
                  {stem.name}
                </button>
              ))}
            </div>
            {seed.stems.some((s) => !s.available) && (
              <span className="beatify-clip-source-hint">
                {seed.stems.find((s) => !s.available)?.hint}
              </span>
            )}
          </li>
        ))}
      </ul>

      <h3>Clips</h3>
      <button className="beatify-clip-new" data-testid="beatify-clip-new" onClick={onNew}>
        + new clip
      </button>
      <ul>
        {clips.map((clip) => (
          <li key={clip.id}>
            <button
              data-testid={`beatify-clip-source-${clip.id}`}
              className={clip.id === selected ? 'selected' : undefined}
              title={`Open ${clip.label}`}
              onClick={() => onSelect(clip.id)}
            >
              <span className="beatify-clip-source-label">{clip.label}</span>
              <span className="beatify-clip-source-kind">clip</span>
            </button>
            <button
              className="beatify-clip-source-edit"
              data-testid={`beatify-clip-edit-${clip.id}`}
              title={`Edit ${clip.label} in the clip editor`}
              onClick={() => onEdit(clip.id)}
            >
              ✎
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
