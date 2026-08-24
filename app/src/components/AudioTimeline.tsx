// The shared audition timeline: waveform + ruler + selection + transport.
//
// Extracted from the Clip page so every page that plays a stretch of
// audio (Clip, Beatify's import modal, Beatify's track view) gets the
// same gestures instead of three hand-rolled copies:
//
//   - sweep to select; grab an edge to resize; drag inside to slide;
//     shift-click extends the nearest edge; click seeks
//   - wheel zooms around the cursor, shift/horizontal wheel pans,
//     +/−/Fit buttons zoom around the selection or playhead
//   - the ruler is HTML (SVG text would stretch with the viewBox) and its
//     ticks are pluggable: seconds by default, beats on Beatify
//
// The component draws and gestures; it OWNS no audio and no domain state.
// Selection and viewport are controlled props, playback is a playhead and
// three callbacks — the parent keeps its ClipTransport (or whatever else)
// and its editing semantics. Domain drawings (drift bands, grid lines,
// region joins…) come in through `renderUnder`/`renderOver`, which receive
// the current x-mapping so annotations move with every zoom and scroll.
//
// Quantized selections: a parent may pass `snap` — every gesture routes
// its raw times through it, so on Beatify a sweep lands on whole beats
// and a click seeks to the nearest beat while the DRAWN geometry always
// reflects the snapped result the parent stored.
//
// Test ids and CSS classes are `${idPrefix}-…`, so the Clip page keeps
// its established `clip-*` contract byte for byte.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { resizeSelection, rulerTicks, selectionEdgeAt, type TimeTick } from '../clip';
import { fixed } from '../format';
import { peaksPath, WAVEFORM_VIEW_W as W } from './WaveformView';

export interface Range {
  start: number;
  end: number;
}

/** Narrowest zoom window, seconds. */
export const MIN_VIEW_SECS = 0.05;
/** Grab radius for the selection's edge handles, in waveform pixels. */
export const HANDLE_PX = 7;
/** Pointer travel that turns a press into a sweep. Below it the gesture
 *  is a click, however shaky the hand. */
const DRAG_PX = 3;
/** Downward travel that turns a press on the selection into a pull-out.
 *  Further than DRAG_PX: taking material out of a track is deliberate. */
const PULL_PX = 10;
/** Below this a selection is a click, not a range. */
const SELECTION_EPS = 1e-4;

/** The visible window: `vp` clamped against the current duration. */
export function viewSpan(
  vp: Range | null,
  duration: number,
): { start: number; end: number; len: number } {
  const len = Math.min(vp ? vp.end - vp.start : duration, duration);
  const start = vp ? Math.max(0, Math.min(vp.start, duration - len)) : 0;
  return { start, end: start + len, len };
}

/** Zoom the window by `factor` keeping `center` under the cursor; a span
 *  at (or past) the whole duration means "no zoom" (null). */
export function zoomView(
  vp: Range | null,
  duration: number,
  center: number,
  factor: number,
): Range | null {
  if (duration <= 0) return vp;
  const { start: vpStart, len: vpLen } = viewSpan(vp, duration);
  const span = Math.max(MIN_VIEW_SECS, Math.min(duration, vpLen * factor));
  if (span >= duration) return null;
  const frac = vpLen > 0 ? (center - vpStart) / vpLen : 0.5;
  const start = Math.max(0, Math.min(center - frac * span, duration - span));
  return { start, end: start + span };
}

/** Hooks for quantized timelines. Raw gesture times pass through here;
 *  what the parent stores (and the component draws) is the snapped
 *  result. All optional — the Clip page passes none. */
export interface TimelineSnap {
  /** Snap a click/seek time. `free` is true when ⌘/ctrl frees the click
   *  from the grid. */
  seek?(secs: number, free: boolean): number;
  /** Snap a swept/resized selection (Beatify: outward to whole beats). */
  range?(r: Range): Range;
  /** Snap a slid selection (Beatify: keep length, move by whole beats). */
  slide?(r: Range): Range;
}

/** A drag on the waveform. Sweeping a new selection and dragging one end
 *  of an existing one are the same gesture — both track the pointer
 *  against a fixed `anchor` (for a resize, the end you did NOT grab) —
 *  so they share a kind. Dragging from inside the selection slides the
 *  selection itself; `onSelectionSlid` tells the parent how far (and
 *  whether alt asked for the audio to follow), on release only.
 *
 *  A sweep NEVER moves the playhead: choosing what to loop is not a
 *  request to restart playback, and jumping the audio under a live drag
 *  is exactly the stutter this gesture used to cause. `swept` records
 *  whether the pointer actually moved, so a plain click — which is a seek
 *  — can still be told apart on release. */
type WaveDrag =
  | {
      kind: 'select';
      anchor: number;
      /** Where the press landed, in client pixels: what tells a click
       *  from a sweep, since a pixel of jitter is not a gesture. */
      anchorX: number;
      swept: boolean;
      fresh: boolean;
      free: boolean;
    }
  | { kind: 'move'; base: Range; anchor: number; delta: number; audio: boolean };

export interface AudioTimelineProps {
  /** Test-id / CSS class prefix; the Clip page passes `clip`. */
  idPrefix: string;
  duration: number;
  /** Peak per bucket, 0..=1, spanning the whole `duration`. */
  peaks: number[];
  waveHeight: number;
  /** Zoomed viewport; null = the whole clip. Controlled by the parent so
   *  siblings (Clip's level lane) can share the window. */
  vp: Range | null;
  onVpChange(vp: Range | null): void;
  /** Selection, raw: a zero-length one is kept (and treated as none) so a
   *  sweep can grow out of it. Only a sweep changes it — a click seeks
   *  and leaves it alone. */
  selection: Range | null;
  onSelectionChange(sel: Range | null): void;
  playing: boolean;
  playhead: number;
  loop: boolean;
  onTogglePlay(): void;
  onStop(): void;
  onToggleLoop(): void;
  onSeek(secs: number): void;
  snap?: TimelineSnap;
  /** Ruler marks; seconds (`rulerTicks`) when absent. */
  ticks?: TimeTick[];
  /** Which ticks get grid lines across the waveform: the labelled ones
   *  (`major`, the Clip default) or every tick (`all`, Beatify's beat
   *  grid, where labelled ticks render emphasized). */
  tickGrid?: 'major' | 'all';
  /** Slide-from-inside is an editing gesture; pages that only select
   *  (Beatify's modal) turn it off so inside-drags sweep instead. */
  allowSlide?: boolean;
  /** Pulling the selection DOWNWARD out of the timeline, if the page has
   *  somewhere for it to go (Beatify's clip editor does). Called once,
   *  mid-drag, after which the gesture belongs to the caller. */
  onPullOut?(): void;
  /** A slide ended: `delta` seconds from `base`; `audio` means alt asked
   *  for the material to move too (the Clip page re-splices). */
  onSelectionSlid?(base: Range, delta: number, audio: boolean): void;
  /** Double-click, in (snapped-free) seconds — Beatify selects the group. */
  onDoubleClickAt?(secs: number): void;
  /** Extra transport-row controls, after zoom (Clip: undo/redo). */
  transportExtra?: ReactNode;
  /** Extra readout text, after the standard readout. */
  readoutExtra?: ReactNode;
  /** Rendered inside the timeline pane between waveform and readout,
   *  sharing its width (Clip: the level automation lane). */
  belowWave?: ReactNode;
  /** SVG painted under / over the selection & playhead. */
  renderUnder?(xOf: (secs: number) => number): ReactNode;
  renderOver?(xOf: (secs: number) => number): ReactNode;
  /** Selection rect tooltip (Clip explains alt-drag). */
  selectionTitle?: string;
  playTitle?: { play: string; pause: string };
  loopTitle?: string;
  timecode(secs: number): string;
}

export function AudioTimeline({
  idPrefix: p,
  duration,
  peaks,
  waveHeight: H,
  vp,
  onVpChange,
  selection,
  onSelectionChange,
  playing,
  playhead,
  loop,
  onTogglePlay,
  onStop,
  onToggleLoop,
  onSeek,
  snap,
  ticks,
  tickGrid = 'major',
  allowSlide = true,
  onPullOut,
  onSelectionSlid,
  onDoubleClickAt,
  transportExtra,
  readoutExtra,
  belowWave,
  renderUnder,
  renderOver,
  selectionTitle,
  playTitle = { play: 'Play (space)', pause: 'Pause (space)' },
  loopTitle,
  timecode,
}: AudioTimelineProps) {
  const { start: vpStart, end: vpEnd, len: vpLen } = viewSpan(vp, duration);
  const sel = selection && selection.end - selection.start > SELECTION_EPS ? selection : null;

  const waveRef = useRef<SVGSVGElement | null>(null);
  const dragRect = useRef<DOMRect | null>(null);
  const dragRef = useRef<WaveDrag | null>(null);
  /** Where the press landed and whether it landed on the selection —
   *  what a downward pull needs to know. */
  const pressRef = useRef<{ x: number; y: number; onSel: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  const timeAt = useCallback(
    (clientX: number, rect: DOMRect | null) => {
      if (!rect || rect.width <= 0 || duration <= 0) return 0;
      const frac = (clientX - rect.left) / rect.width;
      return Math.min(duration, Math.max(0, vpStart + frac * vpLen));
    },
    [duration, vpStart, vpLen],
  );

  /** Seconds per HANDLE_PX at the current zoom — the edge grab radius. */
  const handleSecs = useCallback(
    (rect: DOMRect | null) =>
      rect && rect.width > 0 ? (HANDLE_PX / rect.width) * vpLen : (HANDLE_PX / W) * vpLen,
    [vpLen],
  );

  const snapRange = useCallback((r: Range): Range => (snap?.range ? snap.range(r) : r), [snap]);
  const snapSeek = useCallback(
    (t: number, free: boolean) => (snap?.seek ? snap.seek(t, free) : t),
    [snap],
  );

  const startDrag = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      if (duration <= 0 || e.button !== 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      dragRect.current = rect;
      const t = timeAt(e.clientX, rect);
      pressRef.current = {
        x: e.clientX,
        y: e.clientY,
        onSel: !!sel && t >= sel.start && t <= sel.end,
      };
      // Grabbing an end expands/shrinks the selection; that beats the
      // "slide the whole thing" case, whose zone contains both edges.
      // Shift-click resizes the NEAREST edge from anywhere.
      const edge = sel
        ? (selectionEdgeAt(sel, t, handleSecs(rect)) ??
          (e.shiftKey
            ? Math.abs(t - sel.start) <= Math.abs(t - sel.end)
              ? 'start'
              : 'end'
            : null))
        : null;
      if (sel && edge) {
        // Anchor the end you did not grab and sweep from there; the
        // playhead stays put (only a fresh sweep moves it).
        dragRef.current = {
          kind: 'select',
          anchor: edge === 'start' ? sel.end : sel.start,
          anchorX: e.clientX,
          swept: true,
          fresh: false,
          free: false,
        };
        onSelectionChange(snapRange(resizeSelection(sel, edge, t, duration)));
      } else if (allowSlide && sel && t >= sel.start && t <= sel.end) {
        // Inside the selection: slide WHICH PART is selected. Holding alt
        // slides the audio with it — an edit, so it must be asked for.
        dragRef.current = { kind: 'move', base: sel, anchor: t, delta: 0, audio: e.altKey };
      } else {
        // A PRESS IS NOT YET A GESTURE. This used to collapse the
        // selection to a point here, which meant every click-to-seek
        // threw away the selection (and the loop with it) before anyone
        // knew whether the pointer was going to move. Nothing happens to
        // the selection until the sweep below says so.
        dragRef.current = {
          kind: 'select',
          anchor: t,
          anchorX: e.clientX,
          swept: false,
          fresh: true,
          free: e.metaKey || e.ctrlKey,
        };
      }
      setDragging(true);
    },
    [allowSlide, duration, handleSecs, onSelectionChange, sel, snapRange, timeAt],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // A drag DOWN off the selection is not a timeline gesture at all:
      // it is the selection being carried somewhere else. Direction is
      // what tells it from a slide or a sweep, and the caller owns
      // everything after the handover.
      const press = pressRef.current;
      if (onPullOut && press?.onSel) {
        const down = e.clientY - press.y;
        if (down > PULL_PX && down > Math.abs(e.clientX - press.x)) {
          dragRef.current = null;
          pressRef.current = null;
          setDragging(false);
          onPullOut();
          return;
        }
      }
      const t = timeAt(e.clientX, dragRect.current);
      if (drag.kind === 'select') {
        if (Math.abs(e.clientX - drag.anchorX) > DRAG_PX) drag.swept = true;
        if (!drag.swept) return;
        onSelectionChange(
          snapRange({ start: Math.min(drag.anchor, t), end: Math.max(drag.anchor, t) }),
        );
      } else {
        const len = drag.base.end - drag.base.start;
        const delta = Math.min(
          duration - len - drag.base.start,
          Math.max(-drag.base.start, t - drag.anchor),
        );
        const slid = { start: drag.base.start + delta, end: drag.base.end + delta };
        const snapped = snap?.slide ? snap.slide(slid) : slid;
        drag.delta = snapped.start - drag.base.start;
        onSelectionChange(snapped);
      }
    };
    const up = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      if (drag?.kind === 'select') {
        // A press that never swept anywhere is a seek, and a seek leaves
        // the selection (and so the loop) alone.
        if (drag.fresh && !drag.swept) onSeek(snapSeek(drag.anchor, drag.free));
        return;
      }
      if (drag?.kind !== 'move') return;
      if (Math.abs(drag.delta) > 1e-3) {
        onSelectionSlid?.(drag.base, drag.delta, drag.audio);
      } else {
        // A plain click inside the selection just moves the playhead.
        onSeek(snapSeek(drag.anchor, false));
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [
    dragging,
    duration,
    onPullOut,
    onSeek,
    onSelectionChange,
    onSelectionSlid,
    snap,
    snapRange,
    snapSeek,
    timeAt,
  ]);

  // --- zoom ---------------------------------------------------------------
  const zoomAround = useCallback(
    (center: number, factor: number) => onVpChange(zoomView(vp, duration, center, factor)),
    [duration, onVpChange, vp],
  );

  const zoomIn = useCallback(() => {
    const center = sel ? (sel.start + sel.end) / 2 : playhead > 0 ? playhead : vpStart + vpLen / 2;
    zoomAround(center, 0.5);
  }, [playhead, sel, vpLen, vpStart, zoomAround]);
  const zoomOut = useCallback(
    () => zoomAround(vpStart + vpLen / 2, 2),
    [vpLen, vpStart, zoomAround],
  );

  // Wheel over the waveform: zoom around the cursor; shift/horizontal
  // scroll pans. Native non-passive listener so the page never scrolls.
  useEffect(() => {
    const el = waveRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        const d = (e.deltaX || e.deltaY) * (vpLen / W);
        const start = Math.max(0, Math.min(vpStart + d, duration - vpLen));
        if (vp) onVpChange({ start, end: start + vpLen });
      } else {
        zoomAround(timeAt(e.clientX, rect), 2 ** (e.deltaY / 300));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [duration, onVpChange, timeAt, vp, vpLen, vpStart, zoomAround]);

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      if (!onDoubleClickAt || duration <= 0) return;
      onDoubleClickAt(timeAt(e.clientX, e.currentTarget.getBoundingClientRect()));
    },
    [duration, onDoubleClickAt, timeAt],
  );

  // Ruler marks for whatever is on screen. Recomputed from the viewport
  // alone, so zooming and scrolling move them with the audio.
  const defaultTicks = useMemo(() => rulerTicks(vpStart, vpEnd), [vpStart, vpEnd]);
  const marks = ticks ?? defaultTicks;
  const xOf = (secs: number) => (vpLen > 0 ? ((secs - vpStart) / vpLen) * W : 0);
  const gridMarks = tickGrid === 'all' ? marks : marks.filter((t) => t.major);

  return (
    <>
      <div className={`clip-transport ${p}-transport`} data-testid={`${p}-transport`}>
        <button
          data-testid={`${p}-play`}
          title={playing ? playTitle.pause : playTitle.play}
          onClick={onTogglePlay}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button data-testid={`${p}-stop`} title="Stop" onClick={onStop}>
          ■
        </button>
        <button
          data-testid={`${p}-loop`}
          className={loop ? 'clip-toggle-on' : undefined}
          aria-pressed={loop}
          title={loopTitle ?? (sel ? 'Loop the selection' : 'Loop the whole clip')}
          onClick={onToggleLoop}
        >
          Loop
        </button>
        <span className="clip-playhead-readout" data-testid={`${p}-playhead-readout`}>
          {timecode(playhead)}
        </span>
        <span className="clip-zoom">
          <button data-testid={`${p}-zoom-in`} title="Zoom in" onClick={zoomIn}>
            +
          </button>
          <button
            data-testid={`${p}-zoom-out`}
            title="Zoom out"
            disabled={vp === null}
            onClick={zoomOut}
          >
            −
          </button>
          <button
            data-testid={`${p}-zoom-fit`}
            title="Fit whole clip"
            disabled={vp === null}
            onClick={() => onVpChange(null)}
          >
            Fit
          </button>
        </span>
        {transportExtra}
      </div>

      <div className="clip-timeline">
        {/* The ruler is HTML, not SVG: the waveform's viewBox is
            stretched to the pane width (preserveAspectRatio="none"),
            which would squash text with it. Percentages track the
            viewport, so the marks follow every zoom and scroll. */}
        <div className={`clip-ruler ${p}-ruler`} data-testid={`${p}-ruler`}>
          {marks.map((t) => (
            <span
              key={t.secs}
              className={t.major ? 'clip-tick clip-tick-major' : 'clip-tick'}
              style={{ left: `${((t.secs - vpStart) / Math.max(1e-9, vpLen)) * 100}%` }}
              data-testid={t.major ? `${p}-tick-${fixed(t.secs, 3)}` : undefined}
            >
              {t.major && <i className="clip-tick-label">{t.label}</i>}
            </span>
          ))}
        </div>
        <svg
          ref={waveRef}
          data-testid={`${p}-waveform`}
          className={`clip-waveform ${p}-waveform`}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          data-vp-start={fixed(vpStart, 3)}
          data-vp-end={fixed(vpEnd, 3)}
          onMouseDown={startDrag}
          onDoubleClick={onDoubleClickAt ? onDoubleClick : undefined}
        >
          {renderUnder?.(xOf)}
          <path
            className={`waveform-peaks ${p}-peaks`}
            d={duration > 0 ? peaksPath(peaks, vpStart / duration, vpEnd / duration, H) : ''}
          />
          {/* The ruler's labelled marks, carried across the audio so a
              time can be read off the waveform itself. */}
          {gridMarks.map((t) => (
            <line
              key={`grid${t.secs}`}
              className={t.major && tickGrid === 'all' ? `${p}-grid emph` : `${p}-grid`}
              x1={xOf(t.secs)}
              x2={xOf(t.secs)}
              y1={0}
              y2={H}
            />
          ))}
          {sel && (
            <>
              <rect
                data-testid={`${p}-selection`}
                className={`clip-selection ${p}-selection`}
                x={xOf(sel.start)}
                y={0}
                width={Math.max(1, xOf(sel.end) - xOf(sel.start))}
                height={H}
              >
                {selectionTitle && <title>{selectionTitle}</title>}
              </rect>
              {/* A hairline you aim at, over a wide invisible zone you
                  can actually hit. startDrag hit-tests the same radius,
                  so the zone only has to exist for the cursor to change
                  over it — which is the only hint that the edge is
                  draggable. */}
              {(['start', 'end'] as const).map((edge) => (
                <g key={edge}>
                  <rect
                    data-testid={`${p}-selection-handle-${edge}`}
                    className="clip-selection-handle"
                    x={xOf(edge === 'start' ? sel.start : sel.end) - HANDLE_PX / 2}
                    y={0}
                    width={HANDLE_PX}
                    height={H}
                  />
                  <line
                    data-testid={`${p}-selection-edge-${edge}`}
                    className="clip-selection-edge"
                    x1={xOf(edge === 'start' ? sel.start : sel.end)}
                    x2={xOf(edge === 'start' ? sel.start : sel.end)}
                    y1={0}
                    y2={H}
                  />
                </g>
              ))}
            </>
          )}
          {renderOver?.(xOf)}
          <line
            data-testid={`${p}-playhead`}
            className={`clip-playhead ${p}-playhead`}
            x1={xOf(playhead)}
            x2={xOf(playhead)}
            y1={0}
            y2={H}
          />
        </svg>
        {belowWave}
        <p className="clip-readout" data-testid={`${p}-readout`}>
          {timecode(duration)} total
          {sel ? ` · selection ${timecode(sel.start)}–${timecode(sel.end)}` : ' · no selection'}
          {vp ? ` · view ${timecode(vpStart)}–${timecode(vpEnd)}` : ''}
          {readoutExtra}
        </p>
      </div>
    </>
  );
}
