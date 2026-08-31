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
//
// Above the waveform sits a strip of BEAT FLAGS: one triangle per beat
// of the grid, pointing down at the marker it belongs to, filled when
// that beat is a one. They are the only place a one can be changed with
// the mouse — everywhere else it takes a left-shift tap — so the strip
// is drawn only when the page hands over `onToggleOne`.

import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { peaksPath, WAVEFORM_VIEW_W as W } from './WaveformView';

/** Headroom above the waveform, in the pane's own y units: the strip the
 *  beat flags live in. The waveform still starts at y=0, so nothing that
 *  is drawn ON the audio had to move to make room for them. */
const HEAD = 16;
/** How far each beat marker reaches up out of the waveform, and the
 *  triangle that hangs off its top — the flag is the marker's own head,
 *  which is what makes clicking it obviously about that beat. */
const TICK = 7;
const FLAG_W = 5;

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
  /** Mark or unmark the beat nearest a time as a ONE. Given, every beat
   *  grows a flag above the waveform that says which it is and turns it
   *  into the other on a click; without it the grid is drawn but not
   *  editable here. */
  onToggleOne?(secs: number): void;
  waveHeight: number;
  playing: boolean;
  /** Playhead, in output-timeline seconds (drawn only inside the span). */
  playhead: number;
  /** Material is being fetched (a stem swap, a timeline edit). The audio
   *  in hand keeps playing until it lands. */
  loading: boolean;
  onTogglePlay(): void;
  /** Drop the selection, keeping everything else (the grid included):
   *  the page goes back to showing the source alone. */
  onClear(): void;
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
  onToggleOne,
  waveHeight: H,
  playing,
  playhead,
  loading,
  onTogglePlay,
  onClear,
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

  /** Every beat marker in the window, each knowing whether it is a one.
   *  The two lists are drawn as ONE set of markers so a beat has a
   *  single flag to click: `ones` can name beats the thinned `beats`
   *  list left out, and a one is a beat before it is anything else. */
  const oneAt = new Set(ones ?? []);
  const markers = [...new Set([...(beats ?? []), ...(ones ?? [])])].sort((a, b) => a - b);

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
        <button
          data-testid="clip-sel-clear"
          title="Clear the selection (the beat grid stays)"
          onClick={onClear}
        >
          ✕
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
          // The window is taller than the audio by the flag strip above
          // it: the waveform still runs 0…H, so the beat flags hang in
          // negative y rather than over the peaks.
          viewBox={`0 ${-HEAD} ${W} ${H + HEAD}`}
          preserveAspectRatio="none"
          onMouseDown={seekAt}
        >
          {bleed && region('bleed-left', bleed.left.peaks, 0, loopX0)}
          {region('loop', peaks, loopX0, loopX1)}
          {bleed && region('bleed-right', bleed.right.peaks, loopX1, W)}
          {/* The beat grid, drawn on the result as it is on the source
              track above: a span chosen in beats is checked in beats.
              The lines run from the flag strip down through the audio,
              so each of them reaches its own flag. */}
          {beats?.map((t, i) => (
            <line
              key={`beat${i}`}
              data-testid="clip-sel-beat-line"
              className="clip-beat-line"
              x1={xOf(t)}
              x2={xOf(t)}
              y1={-TICK}
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
              y1={-TICK}
              y2={H}
            >
              <title>the one</title>
            </line>
          ))}
          {/* And one FLAG per beat in the strip above, a triangle
              pointing down at the marker it belongs to: filled on a one,
              hollow on an ordinary beat. It is the handle — clicking it
              makes that beat a one, clicking a one gives it back. */}
          {onToggleOne &&
            markers.map((t, i) => {
              const x = xOf(t);
              const one = oneAt.has(t);
              return (
                <polygon
                  key={`flag${i}`}
                  data-testid={one ? 'clip-sel-one-flag' : 'clip-sel-beat-flag'}
                  className={one ? 'clip-sel-beat-flag is-one' : 'clip-sel-beat-flag'}
                  // Pointing DOWN onto the marker's top, and joined to
                  // it: the flag's tip is where the line ends.
                  points={`${x - FLAG_W},${-HEAD} ${x + FLAG_W},${-HEAD} ${x},${-TICK}`}
                  onMouseDown={(e) => {
                    // The waveform under it seeks on mousedown; a flag is
                    // about its beat, not about the playhead.
                    e.stopPropagation();
                    onToggleOne(t);
                  }}
                >
                  <title>
                    {one ? 'a one — click to make it an ordinary beat' : 'make this beat a one'}
                  </title>
                </polygon>
              );
            })}
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
