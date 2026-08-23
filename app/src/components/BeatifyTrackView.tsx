// Beatify track view (PRD §4): the warped track, gridded, playable.
//
// The audio is constant-tempo, so every grid line is `phase + n × period`
// (TV-1) and seeking to a beat is phase-correct by construction (TV-7).
// Beats are the atomic unit: clicks snap to the nearest beat (TV-6),
// selections snap outward to whole beats (TV-14).
//
// Continuity (TV-24): UI state never tears the audio element down. Zoom,
// selection, loop and follow-mode changes only mutate scheduling
// parameters — looping is enforced by rewinding the SAME element, never by
// reloading it, and the playhead is read from the element's own clock on
// requestAnimationFrame (never setInterval).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  beatAt,
  beatTime,
  clampBeat,
  gridLines,
  gridLod,
  loopWrapBeat,
  qualityLevel,
  selectionLabel,
  timecode,
  verdictLabel,
  ZOOM_BEATS,
  type BeatifyTrack,
} from '../beatify';
import { peaksPath, WAVEFORM_VIEW_W as W } from './WaveformView';

const WAVE_H = 180;
/** Playback windows are fetched in chunks; the backend caps them too. */
export const WINDOW_SECS = 120;

export interface BeatifyTrackViewProps {
  track: BeatifyTrack;
  /** Fetches `secs` of the warped render from `startSecs`. */
  loadAudio(trackId: number, startSecs: number, secs: number): Promise<ArrayBuffer | null>;
  onRebeatify(): void;
}

interface Selection {
  startBeat: number;
  endBeat: number;
}

export function BeatifyTrackView({ track, loadAudio, onRebeatify }: BeatifyTrackViewProps) {
  const grid = track.record.grid;
  const [group, setGroup] = useState(track.record.ruler.group || 4);
  const [zoom, setZoom] = useState(0);
  const [centerBeat, setCenterBeat] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loop, setLoop] = useState(false);
  const [follow, setFollow] = useState(true);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Latest playhead, readable from callbacks without re-binding them
   *  (written by the rAF loop and by seeks, never during render). */
  const playheadRef = useRef(0);
  const objectUrl = useRef<string | null>(null);
  /** Output-time offset of the loaded audio window. */
  const windowStart = useRef(0);
  const loopRef = useRef<{ from: number; to: number } | null>(null);

  const visibleBeats = ZOOM_BEATS[zoom] ?? grid.beats;
  const span = Math.min(grid.beats, Math.max(1, visibleBeats));
  // TV-13: following is a derived view centre, not stored state — a manual
  // scroll (which sets `centerBeat`) simply stops being overridden.
  const center = follow && playing ? beatAt(grid, playhead) : centerBeat;
  const firstBeat = Math.max(0, Math.min(grid.beats - span, Math.round(center - span / 2)));
  const lastBeat = Math.min(grid.beats - 1, firstBeat + span);
  const lod = gridLod(span, group);

  const fromSecs = beatTime(grid, firstBeat);
  const toSecs = beatTime(grid, lastBeat);
  const xOf = useCallback(
    (secs: number) => ((secs - fromSecs) / Math.max(1e-6, toSecs - fromSecs)) * W,
    [fromSecs, toSecs],
  );

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  /** Load the window containing `secs` and (optionally) start playing. */
  const loadWindow = useCallback(
    async (secs: number, autoplay: boolean) => {
      const start = Math.max(0, Math.floor(secs / WINDOW_SECS) * WINDOW_SECS);
      const bytes = await loadAudio(track.trackId, start, WINDOW_SECS);
      if (!bytes) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = url;
      const el = audioRef.current;
      if (!el) return;
      windowStart.current = start;
      el.src = url;
      el.currentTime = Math.max(0, secs - start);
      if (autoplay) {
        try {
          await el.play();
          setPlaying(true);
        } catch {
          // jsdom / no output device: the element still holds the audio.
        }
      }
    },
    [loadAudio, track.trackId],
  );

  // Playhead from the element's own clock, on rAF (TV-24).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el) {
        const at = windowStart.current + el.currentTime;
        playheadRef.current = at;
        setPlayhead(at);
        const bounds = loopRef.current;
        if (bounds && at >= bounds.to) {
          // Loop bounds are enforced by rewinding the SAME source; the
          // element is never rebuilt, so there is no click and no gap.
          el.currentTime = Math.max(0, bounds.from - windowStart.current);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // TV-23: loop bounds follow the selection live.
  useEffect(() => {
    if (!loop) {
      loopRef.current = null;
      return undefined;
    }
    const from = selection ? beatTime(grid, selection.startBeat) : beatTime(grid, 0);
    const to = selection
      ? beatTime(grid, selection.endBeat)
      : beatTime(grid, Math.max(1, grid.beats - 1));
    // TV-25: if the playhead is outside the new loop, keep playing and
    // wrap at the next GROUP boundary rather than jumping now.
    const at = playheadRef.current;
    if (at >= from && at <= to) {
      loopRef.current = { from, to };
      return undefined;
    }
    // Outside the new loop: keep playing and wrap at the next GROUP
    // boundary, then let the real bounds take over.
    const wrapBeat = loopWrapBeat(beatAt(grid, at), group);
    loopRef.current = { from, to: Math.max(from, beatTime(grid, wrapBeat)) };
    const settle = setTimeout(() => {
      loopRef.current = { from, to };
    }, 1000);
    return () => clearTimeout(settle);
  }, [grid, group, loop, selection]);

  const seek = useCallback(
    (secs: number) => {
      const el = audioRef.current;
      const target = Math.max(0, secs);
      playheadRef.current = target;
      if (!el || !el.src) {
        void loadWindow(target, false);
        setPlayhead(target);
        return;
      }
      const local = target - windowStart.current;
      if (local < 0 || local > WINDOW_SECS) {
        void loadWindow(target, !el.paused);
      } else {
        // TV-8: seeking during playback does not stop playback.
        el.currentTime = local;
      }
      setPlayhead(target);
    },
    [loadWindow],
  );

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (!el.src) {
      void loadWindow(playheadRef.current, true);
      return;
    }
    if (el.paused) {
      void el
        .play()
        .then(() => setPlaying(true))
        .catch(() => setPlaying(false));
    } else {
      el.pause();
      setPlaying(false);
    }
  }, [loadWindow]);

  const stepBeats = useCallback(
    (delta: number) => {
      const n = clampBeat(grid, beatAt(grid, playheadRef.current) + delta);
      seek(beatTime(grid, n));
    },
    [grid, seek],
  );

  const changeZoom = useCallback(
    (delta: number) => {
      setZoom((z) => Math.min(ZOOM_BEATS.length - 1, Math.max(0, z + delta)));
      setCenterBeat(beatAt(grid, playheadRef.current));
    },
    [grid],
  );

  // --- pointer -----------------------------------------------------------
  const dragFrom = useRef<number | null>(null);
  const timeAt = useCallback(
    (clientX: number, rect: DOMRect) => {
      if (rect.width <= 0) return fromSecs;
      const frac = (clientX - rect.left) / rect.width;
      return fromSecs + frac * (toSecs - fromSecs);
    },
    [fromSecs, toSecs],
  );

  const onDown = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      dragFrom.current = timeAt(e.clientX, e.currentTarget.getBoundingClientRect());
    },
    [timeAt],
  );

  const onMove = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      if (dragFrom.current === null) return;
      const t = timeAt(e.clientX, e.currentTarget.getBoundingClientRect());
      const a = beatAt(grid, Math.min(dragFrom.current, t));
      const b = beatAt(grid, Math.max(dragFrom.current, t));
      if (b > a) setSelection({ startBeat: clampBeat(grid, a), endBeat: clampBeat(grid, b) });
    },
    [grid, timeAt],
  );

  const onUp = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      const start = dragFrom.current;
      dragFrom.current = null;
      if (start === null) return;
      const t = timeAt(e.clientX, e.currentTarget.getBoundingClientRect());
      if (Math.abs(t - start) >= grid.period / 4) return;
      const beat = clampBeat(grid, beatAt(grid, t));
      if (e.shiftKey) {
        // TV-16: shift-click extends the selection to the nearest beat.
        setSelection((sel) => {
          const anchor = sel ? sel.startBeat : beatAt(grid, playheadRef.current);
          const lo = Math.min(anchor, beat);
          const hi = Math.max(anchor, beat);
          return { startBeat: lo, endBeat: Math.max(hi, lo + 1) };
        });
        return;
      }
      // TV-6/TV-9: click seeks to the nearest beat; ⌘ frees the position.
      seek(e.metaKey ? t : beatTime(grid, beat));
    },
    [grid, seek, timeAt],
  );

  /** TV-18: double-click selects the group under the cursor. */
  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      const t = timeAt(e.clientX, e.currentTarget.getBoundingClientRect());
      const beat = beatAt(grid, t);
      const startBeat = clampBeat(grid, Math.floor(beat / group) * group);
      setSelection({ startBeat, endBeat: clampBeat(grid, startBeat + group) });
    },
    [grid, group, timeAt],
  );

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
          changeZoom(1);
          break;
        case '-':
          changeZoom(-1);
          break;
        case 'f':
        case 'F':
          setZoom(0);
          break;
        case 's':
        case 'S':
          if (selection) {
            setZoom(
              Math.max(
                1,
                ZOOM_BEATS.findIndex(
                  (z) => z !== null && z <= selection.endBeat - selection.startBeat,
                ),
              ),
            );
            setCenterBeat((selection.startBeat + selection.endBeat) / 2);
          }
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
  }, [changeZoom, grid, group, seek, selection, stepBeats, togglePlay]);

  const lines = useMemo(
    () => gridLines(grid, firstBeat, lastBeat, lod.step),
    [firstBeat, grid, lastBeat, lod.step],
  );
  const emphasis = useMemo(
    () => new Set(gridLines(grid, firstBeat, lastBeat, lod.emphasis)),
    [firstBeat, grid, lastBeat, lod.emphasis],
  );

  const quality = track.record.quality;
  const level = qualityLevel(quality);
  const confidence = track.record.analysis.confidence;
  const peakFrom = (fromSecs - beatTime(grid, 0)) / Math.max(1e-6, track.durationSecs);
  const peakTo = (toSecs - beatTime(grid, 0)) / Math.max(1e-6, track.durationSecs);

  return (
    <section className="beatify-track" data-testid="beatify-track-view">
      <header className="beatify-track-head">
        <h2>{track.title}</h2>
        <span className="beatify-line">
          {grid.bpm.toFixed(2)} BPM · {grid.beats} beats · {timecode(track.durationSecs)}
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

      <svg
        className="beatify-track-wave"
        data-testid="beatify-track-wave"
        viewBox={`0 0 ${W} ${WAVE_H}`}
        preserveAspectRatio="none"
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onDoubleClick={onDoubleClick}
      >
        <path className="beatify-peaks" d={peaksPath(track.peaks, peakFrom, peakTo, WAVE_H)} />
        {selection && (
          <rect
            className="beatify-selection"
            data-testid="beatify-selection"
            x={xOf(beatTime(grid, selection.startBeat))}
            y={0}
            width={Math.max(
              1,
              xOf(beatTime(grid, selection.endBeat)) - xOf(beatTime(grid, selection.startBeat)),
            )}
            height={WAVE_H}
          />
        )}
        {lines.map((t) => (
          <line
            key={t}
            className={emphasis.has(t) ? 'beatify-grid emph' : 'beatify-grid'}
            x1={xOf(t)}
            x2={xOf(t)}
            y1={0}
            y2={WAVE_H}
          />
        ))}
        {/* TV-5: the density band only exists at the closest zooms. */}
        {lod.density &&
          confidence.map((c, i) => {
            const t = beatTime(grid, i);
            if (t < fromSecs || t > toSecs) return null;
            return (
              <rect
                key={`c-${i}`}
                className="beatify-density"
                x={xOf(t) - 2}
                y={WAVE_H - c * 20}
                width={4}
                height={c * 20}
              />
            );
          })}
        <line
          className="beatify-playhead"
          data-testid="beatify-track-playhead"
          x1={xOf(playhead)}
          x2={xOf(playhead)}
          y1={0}
          y2={WAVE_H}
        />
      </svg>

      <div className="beatify-ruler" data-testid="beatify-ruler">
        {gridLines(grid, firstBeat, lastBeat, Math.max(lod.emphasis, 1)).map((t) => (
          <span key={t} style={{ left: `${(xOf(t) / W) * 100}%` }}>
            {beatAt(grid, t)}
          </span>
        ))}
      </div>

      <div className="beatify-transport">
        <button data-testid="beatify-track-play" onClick={togglePlay}>
          {playing ? '⏸' : '▶'}
        </button>
        <button
          data-testid="beatify-track-loop"
          className={loop ? 'active' : undefined}
          onClick={() => setLoop((v) => !v)}
        >
          Loop
        </button>
        <button
          data-testid="beatify-track-follow"
          className={follow ? 'active' : undefined}
          onClick={() => setFollow((v) => !v)}
        >
          Follow
        </button>
        <button data-testid="beatify-zoom-in" onClick={() => changeZoom(1)}>
          +
        </button>
        <button data-testid="beatify-zoom-out" onClick={() => changeZoom(-1)}>
          −
        </button>
        <label>
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
        <span className="beatify-line" data-testid="beatify-readout">
          beat {beatAt(grid, playhead)} · {timecode(playhead)} ·{' '}
          {selection
            ? selectionLabel(selection.endBeat - selection.startBeat, group)
            : `${span} beats visible`}
        </span>
      </div>
      <audio ref={audioRef} data-testid="beatify-track-audio" />
    </section>
  );
}
