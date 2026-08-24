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
  clipSeconds,
  emptyDraft,
  fromWire,
  isEmpty,
  movePlacement,
  parseSourceId,
  placeRun,
  removePlacement,
  sourceIdOf,
  toWire,
  usedColumns,
  type BeatifyClipClientApi,
  type BeatRun,
  type ClipDraft,
  type ClipSourceAudio,
  type ClipSources,
  type SavedClip,
  type SourceId,
} from '../beatifyClip';
import { ClipTransport, type TransportHost } from '../clipTransport';
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
  const clipSecs = clipSeconds(usedColumns(draft), grid.period);
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

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || !selBeats || beatsSelected <= 0) return;
      e.preventDefault();
      setDrag({
        run: { source: picked, sourceBeat: selBeats.startBeat, beats: beatsSelected },
        moving: null,
      });
    },
    [beatsSelected, picked, selBeats],
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

  const hoverCell = useCallback(
    (row: number, col: number) => {
      if (!drag) return;
      setDropAt({ row, col, beats: drag.run.beats });
    },
    [drag],
  );

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

  // --- saving ------------------------------------------------------------
  const save = useCallback(async () => {
    if (isEmpty(draft)) {
      setNote('Nothing to save yet');
      return;
    }
    setSaving(true);
    const wire = toWire(draft);
    const list = await clips.save(trackId, {
      id: draft.name === '' ? '' : (savedIdOf(saved, draft.name) ?? ''),
      name: draft.name,
      rows: wire.rows,
      columns: Math.max(wire.columns, usedColumns(draft)),
      placements: wire.placements,
    });
    setSaving(false);
    if (!list) return;
    setSaved(list);
    setNote(`Saved "${draft.name}"`);
  }, [clips, draft, saved, trackId]);

  const remove = useCallback(
    async (id: SourceId) => {
      const spec = parseSourceId(id);
      if (spec.kind !== 'clip') return;
      const list = await clips.remove(trackId, spec.id);
      if (!list) return;
      setSaved(list);
      if (picked === id) setPicked(SEED_SOURCE);
    },
    [clips, picked, trackId],
  );

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

  const openSaved = useCallback(
    (id: SourceId) => {
      const spec = parseSourceId(id);
      if (spec.kind === 'clip') {
        const clip = saved.find((c) => c.id === spec.id);
        if (clip) setDraft(fromWire(clip));
      }
      setPicked(id);
    },
    [saved],
  );

  const sourceView = open
    ? { label: open.label, durationSecs: open.durationSecs, peaks: open.peaks }
    : null;

  return (
    <section className="beatify-builder" data-testid="beatify-builder">
      <div className="beatify-builder-top">
        <BeatifyClipList
          entries={entries}
          selected={picked}
          onSelect={openSaved}
          onDelete={(id) => void remove(id)}
        />
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
            transportExtra={
              <button
                className="beatify-drag-beats"
                data-testid="beatify-drag-beats"
                disabled={beatsSelected <= 0}
                title="Drag the selected beats into the clip editor"
                onMouseDown={startDrag}
              >
                ⠿ {beatsSelected} beat{beatsSelected === 1 ? '' : 's'}
              </button>
            }
          />
        </div>
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
        onHoverCell={hoverCell}
        onDropCell={dropCell}
        onGrabPlacement={grabBlock}
        onRemovePlacement={(id) => setDraft((cur) => removePlacement(cur, id))}
        onTogglePlay={playClip}
        onStop={stopClip}
        onAddRow={() => setDraft((cur) => ({ ...cur, rows: cur.rows + 1 }))}
        onRemoveRow={() =>
          setDraft((cur) =>
            cur.rows <= 1
              ? cur
              : {
                  ...cur,
                  rows: cur.rows - 1,
                  placements: cur.placements.filter((p) => p.row !== cur.rows - 1),
                },
          )
        }
        onRename={(name) => setDraft((cur) => ({ ...cur, name }))}
        onSave={() => void save()}
        saving={saving}
        status={
          note && (
            <span className="beatify-clip-note" data-testid="beatify-clip-note">
              {note}
            </span>
          )
        }
      />
      <audio ref={audioRef} data-testid="beatify-clip-audio" />
    </section>
  );
}

/** Saving under a name that is already taken overwrites that clip rather
 *  than filing a second one with the same name. */
function savedIdOf(saved: readonly SavedClip[], name: string): string | null {
  return saved.find((c) => c.name === name)?.id ?? null;
}
