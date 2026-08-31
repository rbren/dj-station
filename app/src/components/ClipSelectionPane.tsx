// The Clip page's SELECTION pane: what the edit sounds like right now.
//
// The source track above it is the reference — its waveform is the
// material as it was cut, and tone never redraws it. This pane is the
// other half: the selected span with the level automation and the
// chosen stems ON it, looping, and updating under the hand rather than
// after it (see clipLive.ts for the graph that plays it).
//
// It draws and gestures only: the span, the peaks and the playhead are
// props, seeking is a callback, and the level lane is passed in whole by
// the page that owns the automation (its geometry has to agree with this
// pane's x-mapping, which is why the lane travels with it).

import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { peaksPath, WAVEFORM_VIEW_W as W } from './WaveformView';

/** One BLEED region: the material just outside the span, and how much of
 *  it there is. Drawn BESIDE the loop, never over it — the overlaying is
 *  what playback does, and a picture of the sum would hide which piece
 *  a level move is about to change. */
export interface ClipSelectionBleed {
  secs: number;
  peaks: number[];
}

export interface ClipSelectionPaneProps {
  /** The selected span, in OUTPUT-timeline seconds. */
  span: { start: number; end: number };
  /** Peak per bucket over the span, tone included. */
  peaks: number[];
  /** The span's bookends, if it has any: the audio BEFORE it (left) and
   *  AFTER it (right), which play over the loop's seam. They extend the
   *  waveform either side of the loop, so the x-axis of this pane — and
   *  of the level lane under it — covers all three pieces. */
  bleed?: { left: ClipSelectionBleed; right: ClipSelectionBleed };
  /** The grid's beats inside the drawn window, in output-timeline
   *  seconds, and which of them are ONES: the span is chosen in beats, so
   *  it is read in beats too. */
  beats?: number[];
  ones?: number[];
  waveHeight: number;
  playing: boolean;
  /** Playhead, in output-timeline seconds (drawn only inside the span). */
  playhead: number;
  /** Material is being fetched (a stem swap, a timeline edit). The audio
   *  in hand keeps playing until it lands. */
  loading: boolean;
  onTogglePlay(): void;
  /** Seek, in output-timeline seconds. */
  onSeek(secs: number): void;
  timecode(secs: number): string;
  /** The level automation lane, drawn under the waveform. */
  levelLane?: ReactNode;
  /** BOOKENDS: controls that belong to the span's edges rather than to
   *  the page — the bleed either side of the loop (see ClipView). They
   *  are drawn flanking the waveform, so what they measure is where they
   *  sit. */
  bookends?: { left: ReactNode; right: ReactNode };
  /** What the span IS — beats, length, ends, tempo — written where the
   *  pane is titled, since that is the one description of it. */
  title: ReactNode;
  /** Controls that belong to the span rather than to the page (clearing
   *  its automation), drawn in the title row. */
  actions?: ReactNode;
}

export function ClipSelectionPane({
  span,
  peaks,
  bleed,
  beats,
  ones,
  waveHeight: H,
  playing,
  playhead,
  loading,
  onTogglePlay,
  onSeek,
  timecode,
  levelLane,
  bookends,
  title,
  actions,
}: ClipSelectionPaneProps) {
  const len = Math.max(0, span.end - span.start);
  // The drawn window is the LOOP PLUS ITS BOOKENDS. All three pieces are
  // stretches of one timeline, laid out end to end in the order they were
  // cut from it, so x means the same thing for the waveform, the level
  // lane and the times the lane writes.
  const leftSecs = bleed?.left.secs ?? 0;
  const rightSecs = bleed?.right.secs ?? 0;
  const from = span.start - leftSecs;
  const total = leftSecs + len + rightSecs;
  const xOf = (secs: number) => (total > 0 ? ((secs - from) / total) * W : 0);
  const loopX0 = xOf(span.start);
  const loopX1 = xOf(span.end);
  const inside = playhead >= span.start - 1e-6 && playhead <= span.end + 1e-6;

  /** A piece drawn into its own stretch of the x-axis: `peaksPath` fills
   *  the whole viewBox, so each region is scaled into the width it owns
   *  rather than redrawn against a different span. */
  const region = (name: string, regionPeaks: number[], x0: number, x1: number) =>
    x1 - x0 > 0.01 ? (
      <g
        data-testid={`clip-sel-${name}`}
        transform={`translate(${x0} 0) scale(${(x1 - x0) / W} 1)`}
      >
        <path
          className={`waveform-peaks clip-sel-peaks clip-sel-peaks-${name}`}
          d={peaksPath(regionPeaks, 0, 1, H)}
        />
      </g>
    ) : null;

  const seekAt = (e: ReactMouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || total <= 0 || len <= 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    // Only the loop has a playhead: a click on a bookend asks for the
    // nearest edge of the loop it leans on.
    const at = from + Math.min(1, Math.max(0, frac)) * total;
    onSeek(Math.min(span.end, Math.max(span.start, at)));
  };

  return (
    <section className="clip-sel-pane" data-testid="clip-selection-pane">
      <div className="clip-transport clip-sel-transport" data-testid="clip-sel-transport">
        <button
          data-testid="clip-sel-play"
          title={playing ? 'Pause the selection (space)' : 'Play the selection (space)'}
          onClick={onTogglePlay}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="clip-playhead-readout" data-testid="clip-sel-playhead-readout">
          {timecode(Math.max(0, (inside ? playhead : span.start) - span.start))}
        </span>
        <span className="clip-sel-title" data-testid="clip-sel-title">
          {title}
        </span>
        {loading && (
          <span className="clip-sel-loading" data-testid="clip-sel-loading">
            loading…
          </span>
        )}
        {actions}
      </div>

      {/* A GRID, not two rows: the waveform and the level lane under it
          share one x-axis, so they have to share one column. The
          bookends take a column each either side, and the lane starts
          where the peaks do however wide a bleed control turns out to
          be — a breakpoint lands on the peak it was aimed at. */}
      <div className="clip-timeline clip-sel-timeline clip-sel-grid">
        {bookends?.left}
        <svg
          data-testid="clip-sel-waveform"
          className="clip-waveform clip-sel-waveform"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          onMouseDown={seekAt}
        >
          {bleed && region('bleed-left', bleed.left.peaks, 0, loopX0)}
          {region('loop', peaks, loopX0, loopX1)}
          {bleed && region('bleed-right', bleed.right.peaks, loopX1, W)}
          {/* The beat grid, drawn on the result as it is on the source
              track above: a span chosen in beats is checked in beats. */}
          {beats?.map((t, i) => (
            <line
              key={`beat${i}`}
              data-testid="clip-sel-beat-line"
              className="clip-beat-line"
              x1={xOf(t)}
              x2={xOf(t)}
              y1={0}
              y2={H}
            />
          ))}
          {ones?.map((t, i) => (
            <line
              key={`one${i}`}
              data-testid="clip-sel-one-line"
              className="clip-one-line"
              x1={xOf(t)}
              x2={xOf(t)}
              y1={0}
              y2={H}
            >
              <title>the one</title>
            </line>
          ))}
          {/* Where the loop ends and its bleed begins: the seams the
              bookends are there to smooth. */}
          {[loopX0, loopX1].map((x, i) =>
            x > 0.01 && x < W - 0.01 ? (
              <line
                key={i}
                className="clip-sel-seam"
                data-testid={`clip-sel-seam-${i === 0 ? 'left' : 'right'}`}
                x1={x}
                x2={x}
                y1={0}
                y2={H}
              />
            ) : null,
          )}
          {inside && (
            <line
              data-testid="clip-sel-playhead"
              className="clip-playhead"
              x1={xOf(playhead)}
              x2={xOf(playhead)}
              y1={0}
              y2={H}
            />
          )}
        </svg>
        {bookends?.right}
        {levelLane}
      </div>
    </section>
  );
}
