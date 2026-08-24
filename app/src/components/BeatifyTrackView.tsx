// Beatify track view (PRD §4): the warped track, gridded, playable.
//
// The playback surface is the shared AudioTimeline (the Clip page's
// editor timeline): same sweep/resize/slide selection, same wheel zoom
// around the cursor, same transport row. What Beatify adds through its
// hooks:
//
//   - QUANTIZED gestures (TV-6/TV-14): every raw time passes through
//     `snap` — clicks seek to the nearest beat (⌘ frees them), swept
//     selections snap OUTWARD to whole beats, slid selections move by
//     whole beats. The audio is constant-tempo, so every beat is
//     `phase + n × period` (TV-1) and a snapped seek is phase-correct
//     by construction (TV-7).
//   - the beat grid as ruler ticks (teal, MOD-1): line spacing follows
//     the zoom (TV-2, gridLod), emphasized every `group` beats, with
//     beat numbers as the ruler labels.
//   - the per-beat confidence band at the closest zooms (TV-5, amber).
//
// Audio belongs to ONE ClipTransport (src/clipTransport.ts), exactly as
// on the Clip page: windows are fetched from the saved warped render,
// loops follow the selection live, and the view only renders the status
// it is handed back.

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import {
  beatAt,
  beatTime,
  clampBeat,
  gridLines,
  gridLod,
  qualityLevel,
  selectionLabel,
  snapSelection,
  snapTime,
  timecode,
  verdictLabel,
  type BeatifyTrack,
  type Grid,
} from '../beatify';
import type { TimeTick } from '../clip';
import { ClipTransport, type TransportHost } from '../clipTransport';
import { AudioTimeline, viewSpan, zoomView, type Range } from './AudioTimeline';

const WAVE_H = 180;
/** Playback windows are fetched in chunks; the backend caps them too. */
export const WINDOW_SECS = 120;
/** Playhead refresh while a Web Audio loop runs. */
const LOOP_TICK_MS = 50;
/** Height of the confidence band, viewBox units (TV-5). */
const DENSITY_H = 20;

/** What the clip builder shows in this pane instead of the seed render:
 *  a stem, or a clip built earlier. Everything else — the grid, the
 *  snapping, the ruler — is the track's, because they share its grid. */
export interface TrackViewSource {
  label: string;
  durationSecs: number;
  peaks: number[];
}

/** Lets the owner stop this pane sounding, which is how "only one of
 *  source and clip plays at a time" is enforced. */
export interface BeatifyTrackViewHandle {
  pause(): void;
}

export interface BeatifyTrackViewProps {
  track: BeatifyTrack;
  /** Fetches `secs` of the warped render from `startSecs`. */
  loadAudio(trackId: number, startSecs: number, secs: number): Promise<ArrayBuffer | null>;
  onRebeatify(): void;
  source?: TrackViewSource | null;
  /** Shorter waveform when the pane shares the page with the editor. */
  waveHeight?: number;
  /** The selection in whole beats, whenever it changes — what a drag into
   *  the clip editor carries. */
  onSelectionBeats?(sel: { startBeat: number; endBeat: number } | null): void;
  /** Extra transport controls (the clip builder's drag handle). */
  transportExtra?: ReactNode;
  onPlayingChange?(playing: boolean): void;
  /** Dragging the selected beats down out of the waveform, where the
   *  page below has somewhere to put them. */
  onPullOut?(): void;
  handle?: Ref<BeatifyTrackViewHandle>;
}

/** Beat-quantizing gesture hooks for AudioTimeline (TV-6/TV-9/TV-14). */
export function beatSnap(grid: Grid) {
  return {
    seek: (secs: number, free: boolean) => (free ? secs : snapTime(grid, secs)),
    range: (r: Range): Range => {
      const s = snapSelection(grid, r.start, r.end);
      return { start: beatTime(grid, s.startBeat), end: beatTime(grid, s.endBeat) };
    },
    slide: (r: Range): Range => {
      const start = snapTime(grid, r.start);
      return { start, end: start + (r.end - r.start) };
    },
  };
}

export function BeatifyTrackView({
  track,
  loadAudio,
  onRebeatify,
  source = null,
  waveHeight = WAVE_H,
  onSelectionBeats,
  transportExtra,
  onPlayingChange,
  onPullOut,
  handle,
}: BeatifyTrackViewProps) {
  const grid = track.record.grid;
  const duration = source ? source.durationSecs : track.durationSecs;
  const peaks = source ? source.peaks : track.peaks;
  const [group, setGroup] = useState(track.record.ruler.group || 4);
  const [vp, setVp] = useState<Range | null>(null);
  const [selection, setSelection] = useState<Range | null>(null);
  const [loop, setLoop] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);

  const sel = selection && selection.end - selection.start > 1e-4 ? selection : null;

  // --- playback: one ClipTransport owns everything that sounds ----------
  //
  // The parent keys this component by track+render, so a re-beatify
  // remounts it: the transport, viewport and selection all start fresh
  // against the new audio.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transportRef = useRef<ClipTransport | null>(null);
  const live = useRef({ track, loadAudio, duration, onPlayingChange });
  useLayoutEffect(() => {
    live.current = { track, loadAudio, duration, onPlayingChange };
  });

  useImperativeHandle(handle, () => ({ pause: () => transportRef.current?.pause() }), []);

  useEffect(() => {
    const host: TransportHost = {
      duration: () => live.current.duration,
      element: () => audioRef.current,
      render: (start, len) => live.current.loadAudio(live.current.track.trackId, start, len),
      // The view NEVER scrolls itself: where the track is zoomed and
      // scrolled to is the user's, and yanking it around under a playing
      // playhead makes the waveform impossible to work against (TV-13
      // asked for follow; using it said otherwise).
      onStatus: (s) => {
        setPlaying(s.playing);
        setPlayhead(s.playhead);
        live.current.onPlayingChange?.(s.playing);
      },
    };
    const transport = new ClipTransport(host, { windowSecs: WINDOW_SECS, tickMs: LOOP_TICK_MS });
    transportRef.current = transport;
    return () => {
      transportRef.current = null;
      transport.dispose();
    };
  }, []);

  // What Loop loops: the selection if there is one, otherwise everything
  // (TV-23: the bounds follow the selection live).
  const loopRange = useMemo(
    () => (!loop ? null : (sel ?? (duration > 0 ? { start: 0, end: duration } : null))),
    [loop, sel, duration],
  );
  useEffect(() => {
    transportRef.current?.setLoop(loopRange);
  }, [loopRange]);

  const togglePlay = useCallback(() => {
    const transport = transportRef.current;
    if (!transport) return;
    if (transport.playing) transport.pause();
    else transport.play(transport.playhead, loopRange);
  }, [loopRange]);

  const stop = useCallback(() => {
    transportRef.current?.stop(sel ? sel.start : 0);
  }, [sel]);

  const seek = useCallback((secs: number) => {
    transportRef.current?.seek(Math.max(0, secs));
    setPlayhead(Math.max(0, secs));
  }, []);

  const stepBeats = useCallback(
    (delta: number) => {
      const transport = transportRef.current;
      const at = transport?.playhead ?? 0;
      seek(beatTime(grid, clampBeat(grid, beatAt(grid, at) + delta)));
    },
    [grid, seek],
  );

  const snap = useMemo(() => beatSnap(grid), [grid]);

  // The builder needs the selection in BEATS, not seconds: that is what a
  // drag into the clip editor carries.
  useEffect(() => {
    onSelectionBeats?.(sel ? snapSelection(grid, sel.start, sel.end) : null);
  }, [grid, onSelectionBeats, sel]);

  /** TV-18: double-click selects the group under the cursor. */
  const onDoubleClickAt = useCallback(
    (secs: number) => {
      const startBeat = clampBeat(grid, Math.floor(beatAt(grid, secs) / group) * group);
      const endBeat = clampBeat(grid, startBeat + group);
      setSelection({ start: beatTime(grid, startBeat), end: beatTime(grid, endBeat) });
    },
    [grid, group],
  );

  // --- the beat grid as ticks (TV-1/TV-2) --------------------------------
  const { start: vpStart, end: vpEnd, len: vpLen } = viewSpan(vp, duration);
  const lod = gridLod(vpLen / Math.max(1e-6, grid.period), group);
  const ticks = useMemo<TimeTick[]>(() => {
    const fromBeat = Math.floor((vpStart - grid.phase) / Math.max(1e-6, grid.period));
    const toBeat = Math.ceil((vpEnd - grid.phase) / Math.max(1e-6, grid.period));
    const emphasized = new Set(gridLines(grid, fromBeat, toBeat, lod.emphasis));
    return gridLines(grid, fromBeat, toBeat, lod.step).map((t) => ({
      secs: t,
      major: emphasized.has(t),
      label: String(beatAt(grid, t)),
    }));
  }, [grid, lod.emphasis, lod.step, vpEnd, vpStart]);

  // --- keyboard (§4.7) ---------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
      const step = e.shiftKey ? group : 1;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          stepBeats(-step);
          break;
        case 'ArrowRight':
          e.preventDefault();
          stepBeats(step);
          break;
        case 'l':
        case 'L':
          setLoop((v) => !v);
          break;
        case '+':
        case '=':
          setVp((cur) => zoomView(cur, duration, playhead, 0.5));
          break;
        case '-':
          setVp((cur) => zoomView(cur, duration, playhead, 2));
          break;
        case 'f':
        case 'F':
          setVp(null);
          break;
        case 's':
        case 'S':
          if (sel) setVp({ start: sel.start, end: sel.end });
          break;
        case 'Escape':
          setSelection(null);
          break;
        case 'Home':
          seek(beatTime(grid, 0));
          break;
        case 'End':
          seek(beatTime(grid, grid.beats - 1));
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [duration, grid, group, playhead, seek, sel, stepBeats, togglePlay]);

  const quality = track.record.quality;
  const level = qualityLevel(quality);
  const confidence = track.record.analysis.confidence;
  const selBeats = sel ? snapSelection(grid, sel.start, sel.end) : null;

  return (
    <section className="beatify-track" data-testid="beatify-track-view">
      <header className="beatify-track-head">
        <h2 data-testid="beatify-track-title">{source ? source.label : track.title}</h2>
        <span className="beatify-line">
          {grid.bpm.toFixed(2)} BPM · {grid.beats} beats · {timecode(duration)}
        </span>
        {/* OUT-3: the provenance travels with the track. */}
        <span className={`beatify-verdict ${level}`} data-testid="beatify-track-quality">
          ● {verdictLabel(track.record.analysis.agreement)} · flam {quality.worstFlamMs.toFixed(1)}{' '}
          ms · stretch {quality.peakStretchPct.toFixed(2)} %
        </span>
        <button data-testid="beatify-rebeatify" onClick={onRebeatify}>
          Re-beatify…
        </button>
      </header>

      <AudioTimeline
        idPrefix="beatify-track"
        duration={duration}
        peaks={peaks}
        waveHeight={waveHeight}
        vp={vp}
        onVpChange={setVp}
        selection={selection}
        onSelectionChange={setSelection}
        playing={playing}
        playhead={playhead}
        loop={loop}
        onTogglePlay={togglePlay}
        onStop={stop}
        onToggleLoop={() => setLoop((v) => !v)}
        onSeek={seek}
        snap={snap}
        ticks={ticks}
        tickGrid="all"
        onDoubleClickAt={onDoubleClickAt}
        onPullOut={onPullOut}
        timecode={timecode}
        loopTitle={sel ? 'Loop the selection (l)' : 'Loop the whole track (l)'}
        transportExtra={
          <>
            <label className="beatify-group">
              group
              <input
                type="number"
                min={1}
                max={16}
                data-testid="beatify-track-group"
                value={group}
                onChange={(e) => setGroup(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            {transportExtra}
          </>
        }
        readoutExtra={` · beat ${clampBeat(grid, beatAt(grid, playhead))}${
          selBeats ? ` · ${selectionLabel(selBeats.endBeat - selBeats.startBeat, group)}` : ''
        }`}
        renderOver={(xOf) =>
          // TV-5: the density band only exists at the closest zooms.
          lod.density
            ? confidence.map((c, i) => {
                const t = beatTime(grid, i);
                if (t < vpStart || t > vpEnd) return null;
                return (
                  <rect
                    key={`c-${i}`}
                    className="beatify-density"
                    x={xOf(t) - 2}
                    y={waveHeight - c * DENSITY_H}
                    width={4}
                    height={c * DENSITY_H}
                  />
                );
              })
            : null
        }
      />
      <audio ref={audioRef} data-testid="beatify-track-audio" />
    </section>
  );
}
