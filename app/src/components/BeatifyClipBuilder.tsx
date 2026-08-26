// The clip builder: sources on the left, the one you are listening to
// across the top, the clip you are building underneath.
//
// This component owns the four things that have to agree:
//
//   1. WHICH SOURCE is open. A seed (whole, or with some of its stems
//      switched off) or a saved clip — all the same kind of thing,
//      because every one of them sits on the PROJECT's grid — opened into
//      the pane above, which is the ordinary track view made shorter.
//   0. WHICH STEMS are on, per seed. Switching one off does not make a
//      new kind of source: it changes what the seed's source id says, so
//      a run dragged from it remembers it was the drums.
//   2. THE DRAFT. Beats selected in the source are dragged down into the
//      grid; the model in `beatifyClip.ts` decides what a drop does.
//   3. WHAT IS SOUNDING. Exactly one of the two panes, ever: starting one
//      pauses the other, and both panes say which it is. The source has
//      its own transport (inside the track view); the clip's lives here,
//      rendering the draft as it stands rather than as it was saved.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { beatCount, type BeatifyProject, type BeatifySeed } from '../beatify';
import {
  addRow,
  cellRange,
  clipSeconds,
  copyRange,
  drawnColumns,
  emptyDraft,
  fragmentIsEmpty,
  freshClipName,
  fromWire,
  isEmpty,
  isSaved,
  isWholeSeed,
  movePlacement,
  pasteFragment,
  parseSourceId,
  placeRun,
  removeLastRow,
  removePlacement,
  seedMix,
  seedOfSourceId,
  seedSourceId,
  sourceIdOf,
  stemsOfSourceId,
  setColumns,
  toWire,
  usedColumns,
  type BeatifyClipClientApi,
  type BeatRun,
  type CellRange,
  type ClipDraft,
  type ClipFragment,
  type ClipSourceAudio,
  type ClipSources,
  type SavedClip,
  type SourceId,
} from '../beatifyClip';
import { ClipTransport, type TransportHost } from '../clipTransport';
import { isEditableTarget } from '../fileShortcuts';
import { BeatifyClipEditor } from './BeatifyClipEditor';
import { BeatifyClipList, type ClipListClip, type ClipListSeed } from './BeatifyClipList';
import { BeatifyTrackView, type BeatifyTrackViewHandle } from './BeatifyTrackView';

const BUCKETS = 1400;

/** What a seed IS, as far as anything fetched from it goes: change any of
 *  this and the render behind it is different audio. Re-tempo a project
 *  and every seed's changes at once. */
function seedRevision(seed: BeatifySeed): string {
  const g = seed.record.grid;
  return `${seed.id}@${g.bpm}/${g.beats}/${seed.durationSecs}/${seed.record.warp.strength}`;
}

/** What the editor draws before a project has a tempo of its own. */
const EMPTY_GRID = { bpm: 120, period: 0.5, phase: 0.5, beats: 0 };
/** The source pane is shorter here than it is on its own: the clip
 *  editor has to fit under it. */
const SOURCE_WAVE_H = 110;
const WINDOW_SECS = 120;

export interface BeatifyClipBuilderProps {
  project: BeatifyProject;
  clips: BeatifyClipClientApi;
  /** Something else owns the keyboard and the speakers — the import
   *  modal. Everything here goes quiet, takes no keys and cannot be
   *  reached with the pointer until it is gone. */
  suspended?: boolean;
  /** Import another track into this project. */
  onImport(): void;
  /** Drop a seed from the project. */
  onRemoveSeed(seedId: string): void;
}

interface Drag {
  run: BeatRun;
  /** Set when an existing block is being moved rather than a new run
   *  dragged in, so the drop moves it instead of adding a copy. */
  moving: string | null;
}

export function BeatifyClipBuilder({
  project,
  clips,
  suspended = false,
  onImport,
  onRemoveSeed,
}: BeatifyClipBuilderProps) {
  // Clips belong to the PROJECT, and so does the grid: every seed was
  // rendered onto it, which is what lets runs from two different tracks
  // sit in one clip.
  const projectId = project.id;
  const firstSeed = project.seeds[0] ?? null;
  // A project with nothing in it still draws a grid to put things on.
  const grid = firstSeed?.record.grid ?? EMPTY_GRID;

  // The project as the BACKEND would answer about it. A tempo change or a
  // re-beatify moves this, and the sources and the open render are
  // fetched again — the page itself is not rebuilt, because the clip
  // half-built on the grid is still the clip.
  const revision = useMemo(() => project.seeds.map(seedRevision).join(','), [project.seeds]);

  const [sources, setSources] = useState<ClipSources | null>(null);
  const [saved, setSaved] = useState<SavedClip[]>([]);
  // WHICH ENTRY the user last clicked — a seed or a clip. What a seed is
  // PLAYING is not in here: that is `stemsOff`, and `picked` puts the two
  // together. It is a WISH, not the truth: a seed can be deleted out from
  // under it, and a project is minted empty, so what is open is very
  // often something nobody ever clicked.
  const [wanted, setPicked] = useState<SourceId>(() =>
    firstSeed ? seedSourceId(firstSeed.id) : '',
  );
  /** Which stems are switched OFF, per seed. Off rather than on, so a
   *  seed nobody has touched is its whole mix without having to know
   *  what its stems are called; absent rather than empty, so "nobody has
   *  touched this" is a different answer from "all of it is on"
   *  (`seedMix`). */
  const [stemsOff, setStemsOff] = useState<Record<string, string[]>>({});
  const [open, setOpen] = useState<ClipSourceAudio | null>(null);
  const [draft, setDraft] = useState<ClipDraft>(() => emptyDraft());
  const [selBeats, setSelBeats] = useState<{ startBeat: number; endBeat: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropAt, setDropAt] = useState<{ row: number; col: number; beats: number } | null>(null);
  const [sel, setSel] = useState<CellRange | null>(null);
  const [sweep, setSweep] = useState<{ row: number; col: number } | null>(null);
  const [clipboard, setClipboard] = useState<ClipFragment | null>(null);
  const [clipPlaying, setClipPlaying] = useState(false);
  const [sounding, setLive] = useState<'source' | 'clip' | null>(null);
  const [clipHead, setClipHead] = useState(0);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  /** What a seed can be taken apart into, in the order the list shows. */
  const partsOf = useCallback(
    (seedId: string): string[] =>
      sources?.sources.find((s) => s.seedId === seedId)?.stems.map((s) => s.name) ?? [],
    [sources],
  );
  /** THE SOURCE THE PANE IS ON, derived rather than stored: which entry
   *  is open, plus — for a seed — which of its parts are switched on.
   *  Deriving it is the whole point. A stem switch changes `stemsOff` and
   *  nothing else, so it reaches the pane even for the seed nobody
   *  clicked (every seed of a freshly imported project), and a run
   *  dragged out of the pane cannot name a mix the pane was not playing. */
  const picked = useMemo<SourceId>(() => {
    if (wanted.startsWith('clip:')) return wanted;
    const asked = seedOfSourceId(wanted);
    const seedId = project.seeds.some((s) => s.id === asked) ? asked : (firstSeed?.id ?? '');
    return seedId ? seedMix(seedId, partsOf(seedId), stemsOff[seedId]) : '';
  }, [firstSeed, partsOf, project.seeds, stemsOff, wanted]);

  const sourceRef = useRef<BeatifyTrackViewHandle | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transportRef = useRef<ClipTransport | null>(null);

  // --- what can be cut up -----------------------------------------------
  useEffect(() => {
    void (async () => {
      const list = await clips.sources(projectId);
      if (!list) return;
      setSources(list);
      setSaved(list.clips);
    })();
  }, [clips, projectId, revision]);

  useEffect(() => {
    // An empty project has nothing to open, which is not an error.
    if (!picked) return;
    let live = true;
    void (async () => {
      const opened = await clips.open(projectId, parseSourceId(picked), BUCKETS);
      if (live && opened) setOpen(opened);
    })();
    return () => {
      live = false;
    };
  }, [clips, picked, projectId, revision]);

  // --- the clip's own transport -----------------------------------------
  //
  // Its `render` reads the LIVE draft, so what plays is what is on screen.
  // The clip is as long as it was SET to be, trailing silence included:
  // a sixteen-beat clip with four beats of drums in it loops every
  // sixteen beats, which is the loop the user asked for.
  const clipSecs = clipSeconds(drawnColumns(draft), grid.period);
  const live = useRef({ draft, projectId, clips, clipSecs });
  useLayoutEffect(() => {
    live.current = { draft, projectId, clips, clipSecs };
  });

  useEffect(() => {
    const host: TransportHost = {
      duration: () => live.current.clipSecs,
      element: () => audioRef.current,
      render: (start, secs) =>
        live.current.clips.preview(live.current.projectId, live.current.draft, start, secs),
      onStatus: (s) => {
        setClipPlaying(s.playing);
        setClipHead(s.playhead);
      },
    };
    const transport = new ClipTransport(host, { windowSecs: WINDOW_SECS });
    transportRef.current = transport;
    return () => {
      transportRef.current = null;
      transport.dispose();
    };
  }, []);

  // ONE thing sounds at a time. The clip yields to the source here; the
  // source is stopped from `playClip` below.
  const onSourcePlaying = useCallback((playing: boolean) => {
    if (playing) transportRef.current?.pause();
    setLive((cur) => (playing ? 'source' : cur === 'source' ? null : cur));
  }, []);

  const playClip = useCallback(() => {
    const transport = transportRef.current;
    if (!transport) return;
    if (transport.playing) {
      transport.pause();
      setLive(null);
      return;
    }
    if (isEmpty(live.current.draft)) {
      setNote('Nothing in the clip yet — drag some beats in first');
      return;
    }
    sourceRef.current?.pause();
    setNote(null);
    setLive('clip');
    // Clips loop by default: that is what a clip is for.
    transport.play(transport.playhead, { start: 0, end: live.current.clipSecs });
  }, []);

  const stopClip = useCallback(() => {
    transportRef.current?.stop(0);
    setLive((cur) => (cur === 'clip' ? null : cur));
  }, []);

  // An edit while the clip is playing has to be heard. Same split as the
  // Clip page: a change to the clip's LENGTH means every output time now
  // means something else (invalidate), anything else is a re-render of
  // the window in flight, keeping its phase (refreshTone).
  const lengthRef = useRef(clipSecs);
  useEffect(() => {
    const transport = transportRef.current;
    if (!transport?.playing) {
      lengthRef.current = clipSecs;
      return;
    }
    if (Math.abs(lengthRef.current - clipSecs) > 1e-6) transport.invalidate();
    else transport.refreshTone();
    lengthRef.current = clipSecs;
  }, [clipSecs, draft]);

  // --- dragging beats down ----------------------------------------------
  //
  // The selection can be off the grid at both ends (⌘, TV-14a), so what
  // is selected is a length in beats and a fraction: 6.25 beats from
  // beat 3.75. The CLIP is a grid of whole beats and stays one, so a run
  // occupies the nearest whole number of columns and carries the
  // fraction in where it READS FROM — the offset is what the free drag
  // was for, and the downbeat is what the grid is for.
  const beatsSelected = selBeats ? selBeats.endBeat - selBeats.startBeat : 0;
  const columnsSelected = Math.max(1, Math.round(beatsSelected));

  /** Lift the selected beats off the source; the drop decides where they
   *  land. Reached two ways — the handle in the transport row, and
   *  dragging the selection down out of the waveform itself. */
  const liftSelection = useCallback(() => {
    if (!selBeats || beatsSelected <= 0) return;
    setDrag({
      run: { source: picked, sourceBeat: selBeats.startBeat, beats: columnsSelected },
      moving: null,
    });
  }, [beatsSelected, columnsSelected, picked, selBeats]);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      liftSelection();
    },
    [liftSelection],
  );

  const grabBlock = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const p = draft.placements.find((x) => x.id === id);
      if (!p) return;
      e.preventDefault();
      setDrag({
        run: { source: p.source, sourceBeat: p.sourceBeat, beats: p.beats },
        moving: id,
      });
    },
    [draft.placements],
  );

  // A drag that ends anywhere but a cell is simply dropped.
  useEffect(() => {
    if (!drag) return;
    const up = () => {
      setDrag(null);
      setDropAt(null);
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [drag]);

  /** Pressing a cell with nothing in hand starts a sweep: the chunk it
   *  ends on is what copy and paste work with. */
  const pressCell = useCallback(
    (row: number, col: number) => {
      if (drag) return;
      setSweep({ row, col });
      setSel(cellRange({ row, col }, { row, col }));
    },
    [drag],
  );

  const hoverCell = useCallback(
    (row: number, col: number) => {
      if (drag) {
        setDropAt({ row, col, beats: drag.run.beats });
        return;
      }
      if (sweep) setSel(cellRange(sweep, { row, col }));
    },
    [drag, sweep],
  );

  useEffect(() => {
    if (!sweep) return;
    const up = () => setSweep(null);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [sweep]);

  const dropCell = useCallback(
    (row: number, col: number) => {
      if (!drag) return;
      setDraft((cur) =>
        drag.moving ? movePlacement(cur, drag.moving, row, col) : placeRun(cur, drag.run, row, col),
      );
      setDrag(null);
      setDropAt(null);
      setNote(null);
    },
    [drag],
  );

  // --- copy and paste ----------------------------------------------------
  //
  // The selection is a rectangle of the grid, and the clipboard holds
  // what was inside it, trimmed at the edges and with its positions made
  // relative. A paste lands at the selection's corner, so "select here,
  // paste" reads the way it looks.
  const copy = useCallback(() => {
    if (!sel) return;
    const fragment = copyRange(draft, sel);
    if (fragmentIsEmpty(fragment)) {
      setNote('Nothing in that selection to copy');
      return;
    }
    setClipboard(fragment);
    setNote(
      `Copied ${fragment.placements.length} run${fragment.placements.length === 1 ? '' : 's'}`,
    );
  }, [draft, sel]);

  const paste = useCallback(() => {
    if (!clipboard) return;
    const at = sel ?? { row0: 0, row1: 0, col0: 0, col1: 1 };
    setDraft((cur) => pasteFragment(cur, clipboard, at.row0, at.col0));
    setNote(null);
  }, [clipboard, sel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (suspended || isEditableTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'c') {
        e.preventDefault();
        copy();
      } else if (mod && key === 'v') {
        e.preventDefault();
        paste();
      } else if (!mod && e.key === 'Escape') {
        setSel(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [copy, paste, suspended]);

  // Going quiet is not a pause the user asked for, so it takes the
  // playhead nowhere: the modal simply must be the only thing sounding.
  useEffect(() => {
    if (!suspended) return;
    sourceRef.current?.pause();
    transportRef.current?.pause();
  }, [suspended]);

  // --- saving ------------------------------------------------------------

  /** Clear the desk: a new, empty clip, and silence. `filed` is the shelf
   *  the fresh clip must not collide with by name — passed in rather than
   *  read off `saved`, because a save clears the desk with a list the
   *  state has not caught up to yet. */
  const clearDesk = useCallback((filed: SavedClip[]) => {
    transportRef.current?.stop(0);
    setLive((cur) => (cur === 'clip' ? null : cur));
    setDraft(emptyDraft(freshClipName(filed.map((c) => c.name))));
    setSel(null);
    setNote(null);
  }, []);

  const save = useCallback(async () => {
    if (isEmpty(draft)) {
      setNote('Nothing to save yet');
      return;
    }
    setSaving(true);
    const wire = toWire(draft);
    const filed = await clips.save(projectId, {
      id: draft.id,
      name: draft.name,
      rows: wire.rows,
      columns: Math.max(wire.columns, usedColumns(draft)),
      placements: wire.placements,
    });
    setSaving(false);
    if (!filed) return;
    setSaved(filed.clips);
    // SAVING IS FILING: the clip is on the shelf now, and the desk is
    // clear for the next one, which is how a set gets built. The one that
    // was just filed is not "still open" — it is a row in the list, and
    // the ✎ brings it back to be edited or deleted.
    clearDesk(filed.clips);
    // No congratulation — the row in the list under that name is the
    // receipt. This says where the material WENT, because a grid that
    // empties itself is otherwise a fright.
    setNote(`"${draft.name}" is saved — the desk is clear for the next clip`);
  }, [clearDesk, clips, draft, projectId]);

  /** Delete the clip this draft came from. The material stays on screen,
   *  now unsaved: deleting a file is not the same as clearing the desk. */
  const deleteClip = useCallback(async () => {
    if (!isSaved(draft)) return;
    setSaving(true);
    const list = await clips.remove(projectId, draft.id);
    setSaving(false);
    if (!list) return;
    setSaved(list);
    setDraft((cur) => ({ ...cur, id: '' }));
    if (picked === `clip:${draft.id}`) {
      setPicked(project.seeds[0] ? seedSourceId(project.seeds[0].id) : '');
    }
    // Not a congratulation: the file is gone but the material is still on
    // the grid, and only this says so.
    setNote(`"${draft.name}" is deleted — what is on the grid is now unsaved`);
  }, [clips, draft, picked, project.seeds, projectId]);

  /** "+ new clip": the same clearing a save does, asked for by hand. */
  const newClip = useCallback(() => clearDesk(saved), [clearDesk, saved]);

  // --- what the list shows ------------------------------------------------
  //
  // A seed's entry carries its own switches, and the id it opens is the
  // seed PLUS whatever is switched on: that is the only place the stem
  // selection lives, so a run dragged out of the pane cannot disagree
  // with what the pane was playing.
  const seedEntries = useMemo<ClipListSeed[]>(
    () =>
      (sources?.sources ?? []).map((info) => {
        const off = stemsOff[info.seedId];
        return {
          seedId: info.seedId,
          // The same law the pane reads: untouched switches are the
          // render, touched ones are the parts (`seedMix`).
          id: seedMix(
            info.seedId,
            info.stems.map((s) => s.name),
            off,
          ),
          label: info.label,
          beats: info.beats,
          sourceBpm: info.sourceBpm,
          speed: info.speed,
          available: info.available,
          stems: info.stems.map((stem) => ({
            name: stem.name,
            on: !(off ?? []).includes(stem.name),
            available: stem.available,
            hint: stem.hint,
          })),
        };
      }),
    [sources, stemsOff],
  );

  const clipEntries = useMemo<ClipListClip[]>(
    () => saved.map((clip) => ({ id: `clip:${clip.id}`, label: clip.name })),
    [saved],
  );

  /** Flip one of a seed's parts. Muting the last one is silence, so the
   *  last one on stays on — the Clip page's rule, for the same reason.
   *
   *  This writes the switches and NOTHING else: what the pane is playing
   *  is read back off them (`picked`), and which seed is open is the
   *  user's, so flipping a switch on one seed cannot steal the pane from
   *  another. */
  const toggleStem = useCallback(
    (seedId: string, name: string) => {
      const parts = partsOf(seedId);
      if (parts.length === 0) return;
      const off = stemsOff[seedId] ?? [];
      const next = off.includes(name) ? off.filter((s) => s !== name) : [...off, name];
      if (next.length >= parts.length) {
        setNote('Leave at least one stem on — muting them all is silence');
        return;
      }
      setStemsOff({ ...stemsOff, [seedId]: next });
      setNote(null);
    },
    [partsOf, stemsOff],
  );

  const order = useMemo(
    () => [...seedEntries.map((e) => e.id), ...clipEntries.map((e) => e.id)],
    [clipEntries, seedEntries],
  );
  const labelOf = useCallback(
    (id: SourceId) => {
      const seedId = seedOfSourceId(id);
      if (seedId) {
        const seed = seedEntries.find((e) => e.seedId === seedId);
        if (!seed) return id;
        // Every part on is the whole of it, whether it is being played as
        // the render or as its parts summed back up: that is the seed,
        // and it is called by its name.
        const parts = seed.stems.map((stem) => stem.name);
        if (isWholeSeed(id, parts)) return seed.label;
        return `${seed.label} · ${stemsOfSourceId(id).join(' + ')}`;
      }
      return clipEntries.find((e) => e.id === id)?.label ?? id;
    },
    [clipEntries, seedEntries],
  );

  /** The seed the source pane is showing — what the track view draws its
   *  grid, its verdict and its confidence band from. */
  const openSeed = useMemo(() => {
    const seedId = seedOfSourceId(picked);
    return project.seeds.find((s) => s.id === seedId) ?? firstSeed;
  }, [firstSeed, picked, project.seeds]);

  /** Load a saved clip into the EDITOR. The source pane is left where it
   *  was: editing a clip and cutting beats from one are different jobs,
   *  and doing both at once was never what the click meant. */
  const editSaved = useCallback(
    (id: SourceId) => {
      const spec = parseSourceId(id);
      if (spec.kind !== 'clip') return;
      const clip = saved.find((c) => c.id === spec.id);
      if (!clip) return;
      setDraft(fromWire(clip));
      setSel(null);
      setNote(`Editing "${clip.name}"`);
    },
    [saved],
  );

  const sourceView = open
    ? { id: picked, label: open.label, durationSecs: open.durationSecs, peaks: open.peaks }
    : null;

  // The mix that is ASKED for is not always the one that has landed: the
  // first time a seed is taken apart, its parts are separated onto the
  // grid, which is seconds of work. The switches say so — a switch that
  // sits there looking done while nothing has changed yet is the same
  // thing as a switch that does nothing.
  const settling = !open || sourceIdOf(open.source) !== picked;

  // What the pane is MOUNTED against: the material, not the mix. A stem
  // switched off is the same seed on the same grid, so the view sits
  // through it (zoom, selection, playhead and all, see `sourceView.id`);
  // a different seed, a clip, or the same seed re-rendered at another
  // tempo is a different timeline, and starts fresh — seconds do not
  // mean what they meant.
  const openKey = `${seedOfSourceId(picked) || picked}@${openSeed ? seedRevision(openSeed) : ''}`;

  return (
    // The list runs down the left of BOTH panes, so the source and the
    // clip share one column: the grid below lines up, beat for beat,
    // with the waveform above it.
    <section className="beatify-builder" data-testid="beatify-builder" inert={suspended}>
      <BeatifyClipList
        seeds={seedEntries}
        clips={clipEntries}
        selected={picked}
        onSelect={setPicked}
        onToggleStem={toggleStem}
        settling={settling ? seedOfSourceId(picked) : ''}
        onEdit={editSaved}
        onRemoveSeed={onRemoveSeed}
        onNew={newClip}
        onImport={onImport}
      />
      <div className="beatify-builder-main">
        <div className="beatify-builder-source">
          {openSeed ? (
            <BeatifyTrackView
              key={openKey}
              handle={sourceRef}
              track={openSeed}
              source={sourceView}
              waveHeight={SOURCE_WAVE_H}
              loadAudio={(_id, startSecs, secs) =>
                clips.audio(projectId, parseSourceId(picked), startSecs, secs)
              }
              suspended={suspended}
              onSelectionBeats={setSelBeats}
              onPlayingChange={onSourcePlaying}
              onPullOut={liftSelection}
              transportExtra={
                <button
                  className="beatify-drag-beats"
                  data-testid="beatify-drag-beats"
                  disabled={beatsSelected <= 0}
                  title="Drag these beats into the clip below — or drag them straight down out of the waveform"
                  onMouseDown={startDrag}
                >
                  ⠿ {beatCount(beatsSelected)} beat{beatsSelected === 1 ? '' : 's'}
                </button>
              }
            />
          ) : (
            <p className="beatify-empty" data-testid="beatify-builder-empty">
              This project has no material yet. Import a track — the first one sets the tempo, and
              everything after it is conformed to that tempo, so beats from any of them line up.
            </p>
          )}
        </div>

        <BeatifyClipEditor
          draft={draft}
          sourceOrder={order}
          labelOf={labelOf}
          period={grid.period}
          playing={clipPlaying}
          playhead={clipHead}
          live={sounding}
          dropAt={dropAt}
          selection={sel}
          onHoverCell={hoverCell}
          onDropCell={dropCell}
          onPressCell={pressCell}
          onGrabPlacement={grabBlock}
          onRemovePlacement={(id) => setDraft((cur) => removePlacement(cur, id))}
          onTogglePlay={playClip}
          onStop={stopClip}
          onAddRow={() => setDraft(addRow)}
          onRemoveRow={() => setDraft(removeLastRow)}
          onRename={(name) => setDraft((cur) => ({ ...cur, name }))}
          onSetLength={(beats) => setDraft((cur) => setColumns(cur, beats))}
          onSave={() => void save()}
          onDelete={() => void deleteClip()}
          saving={saving}
          status={
            note && (
              <span className="beatify-clip-note" data-testid="beatify-clip-note">
                {note}
              </span>
            )
          }
        />
      </div>
      <audio ref={audioRef} data-testid="beatify-clip-audio" />
    </section>
  );
}
