// The clip builder: sources on the left, the one you are listening to
// across the top, the clip you are building underneath.
//
// This component owns the three things that have to agree:
//
//   1. WHICH SOURCE is open. Seed, stem or saved clip — all the same kind
//      of thing, because they share the track's grid — opened into the
//      pane above, which is the ordinary track view made shorter.
//   2. THE DRAFT. Beats selected in the source are dragged down into the
//      grid; the model in `beatifyClip.ts` decides what a drop does.
//   3. WHAT IS SOUNDING. Exactly one of the two panes, ever: starting one
//      pauses the other, and both panes say which it is. The source has
//      its own transport (inside the track view); the clip's lives here,
//      rendering the draft as it stands rather than as it was saved.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BeatifyTrack } from '../beatify';
import {
  SEED_SOURCE,
  addRow,
  cellRange,
  clipSeconds,
  copyRange,
  drawnColumns,
  emptyDraft,
  fragmentIsEmpty,
  fromWire,
  isEmpty,
  isSaved,
  movePlacement,
  pasteFragment,
  parseSourceId,
  placeRun,
  removeLastRow,
  removePlacement,
  setColumns,
  sourceIdOf,
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
import { BeatifyClipList, type ClipListEntry } from './BeatifyClipList';
import { BeatifyTrackView, type BeatifyTrackViewHandle } from './BeatifyTrackView';

const BUCKETS = 1400;
/** The source pane is shorter here than it is on its own: the clip
 *  editor has to fit under it. */
const SOURCE_WAVE_H = 110;
const WINDOW_SECS = 120;

export interface BeatifyClipBuilderProps {
  track: BeatifyTrack;
  clips: BeatifyClipClientApi;
  onRebeatify(): void;
}

interface Drag {
  run: BeatRun;
  /** Set when an existing block is being moved rather than a new run
   *  dragged in, so the drop moves it instead of adding a copy. */
  moving: string | null;
}

export function BeatifyClipBuilder({ track, clips, onRebeatify }: BeatifyClipBuilderProps) {
  const grid = track.record.grid;
  const trackId = track.trackId;

  const [sources, setSources] = useState<ClipSources | null>(null);
  const [saved, setSaved] = useState<SavedClip[]>([]);
  const [picked, setPicked] = useState<SourceId>(SEED_SOURCE);
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

  const sourceRef = useRef<BeatifyTrackViewHandle | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transportRef = useRef<ClipTransport | null>(null);

  // --- what can be cut up -----------------------------------------------
  useEffect(() => {
    void (async () => {
      const list = await clips.sources(trackId);
      if (!list) return;
      setSources(list);
      setSaved(list.clips);
    })();
  }, [clips, trackId]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const spec = parseSourceId(picked);
      const opened = await clips.open(trackId, spec, BUCKETS);
      if (live && opened) setOpen(opened);
    })();
    return () => {
      live = false;
    };
  }, [clips, picked, trackId]);

  // --- the clip's own transport -----------------------------------------
  //
  // Its `render` reads the LIVE draft, so what plays is what is on screen.
  // The clip is as long as it was SET to be, trailing silence included:
  // a sixteen-beat clip with four beats of drums in it loops every
  // sixteen beats, which is the loop the user asked for.
  const clipSecs = clipSeconds(drawnColumns(draft), grid.period);
  const live = useRef({ draft, trackId, clips, clipSecs });
  useLayoutEffect(() => {
    live.current = { draft, trackId, clips, clipSecs };
  });

  useEffect(() => {
    const host: TransportHost = {
      duration: () => live.current.clipSecs,
      element: () => audioRef.current,
      render: (start, secs) =>
        live.current.clips.preview(live.current.trackId, live.current.draft, start, secs),
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
  const beatsSelected = selBeats ? selBeats.endBeat - selBeats.startBeat : 0;

  /** Lift the selected beats off the source; the drop decides where they
   *  land. Reached two ways — the handle in the transport row, and
   *  dragging the selection down out of the waveform itself. */
  const liftSelection = useCallback(() => {
    if (!selBeats || beatsSelected <= 0) return;
    setDrag({
      run: { source: picked, sourceBeat: selBeats.startBeat, beats: beatsSelected },
      moving: null,
    });
  }, [beatsSelected, picked, selBeats]);

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
      if (isEditableTarget(e.target)) return;
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
  }, [copy, paste]);

  // --- saving ------------------------------------------------------------
  const save = useCallback(async () => {
    if (isEmpty(draft)) {
      setNote('Nothing to save yet');
      return;
    }
    setSaving(true);
    const wire = toWire(draft);
    const filed = await clips.save(trackId, {
      id: draft.id,
      name: draft.name,
      rows: wire.rows,
      columns: Math.max(wire.columns, usedColumns(draft)),
      placements: wire.placements,
    });
    setSaving(false);
    if (!filed) return;
    setSaved(filed.clips);
    // A first save is filed under an id the backend picks; the draft has
    // to learn it, or the next save would file a second copy and Delete
    // would have nothing to delete.
    setDraft((cur) => ({ ...cur, id: filed.id }));
    setNote(`Saved "${draft.name}"`);
  }, [clips, draft, trackId]);

  /** Delete the clip this draft came from. The material stays on screen,
   *  now unsaved: deleting a file is not the same as clearing the desk. */
  const deleteClip = useCallback(async () => {
    if (!isSaved(draft)) return;
    setSaving(true);
    const list = await clips.remove(trackId, draft.id);
    setSaving(false);
    if (!list) return;
    setSaved(list);
    setDraft((cur) => ({ ...cur, id: '' }));
    if (picked === `clip:${draft.id}`) setPicked(SEED_SOURCE);
    setNote(`Deleted "${draft.name}" — what is on the grid is now unsaved`);
  }, [clips, draft, picked, trackId]);

  /** Clear the desk: a new, empty clip, and silence. */
  const newClip = useCallback(() => {
    transportRef.current?.stop(0);
    setLive((cur) => (cur === 'clip' ? null : cur));
    setDraft(emptyDraft());
    setSel(null);
    setNote(null);
  }, []);

  // --- what the list shows ------------------------------------------------
  const entries = useMemo<ClipListEntry[]>(() => {
    const fromBackend: ClipListEntry[] = (sources?.sources ?? []).map((info) => ({
      id: sourceIdOf(info.source),
      label: info.label,
      kind: info.source.kind === 'stem' ? 'stem' : '',
      available: info.available,
      hint: info.hint,
    }));
    return [
      ...fromBackend,
      ...saved.map((clip) => ({
        id: `clip:${clip.id}`,
        label: clip.name,
        kind: 'clip',
        available: true,
        hint: null,
      })),
    ];
  }, [saved, sources]);

  const order = useMemo(() => entries.map((e) => e.id), [entries]);
  const labelOf = useCallback(
    (id: SourceId) => entries.find((e) => e.id === id)?.label ?? id,
    [entries],
  );

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
    ? { label: open.label, durationSecs: open.durationSecs, peaks: open.peaks }
    : null;

  return (
    // The list runs down the left of BOTH panes, so the source and the
    // clip share one column: the grid below lines up, beat for beat,
    // with the waveform above it.
    <section className="beatify-builder" data-testid="beatify-builder">
      <BeatifyClipList
        entries={entries}
        selected={picked}
        onSelect={setPicked}
        onEdit={editSaved}
        onNew={newClip}
      />
      <div className="beatify-builder-main">
        <div className="beatify-builder-source">
          <BeatifyTrackView
            key={picked}
            handle={sourceRef}
            track={track}
            source={sourceView}
            waveHeight={SOURCE_WAVE_H}
            loadAudio={(_id, startSecs, secs) =>
              clips.audio(trackId, parseSourceId(picked), startSecs, secs)
            }
            onRebeatify={onRebeatify}
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
                ⠿ {beatsSelected} beat{beatsSelected === 1 ? '' : 's'}
              </button>
            }
          />
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
