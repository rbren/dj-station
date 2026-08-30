// The Clip page's SELECTION pane: what the edit sounds like right now.
//
// The source track above it is the reference — its waveform is the
// material as it was cut, and tone never redraws it. This pane is the
// other half: the selected span with the EQ, the level automation and
// the chosen stems ON it, looping, and updating under the knob rather
// than after it (see clipLive.ts for the graph that plays it).
//
// It draws and gestures only: the span, the peaks and the playhead are
// props, seeking is a callback, and the level lane is passed in whole by
// the page that owns the automation (its geometry has to agree with this
// pane's x-mapping, which is why the lane travels with it).

import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { peaksPath, WAVEFORM_VIEW_W as W } from './WaveformView';

export interface ClipSelectionPaneProps {
  /** The selected span, in OUTPUT-timeline seconds. */
  span: { start: number; end: number };
  /** Peak per bucket over the span, tone included. */
  peaks: number[];
  waveHeight: number;
  playing: boolean;
  /** Playhead, in output-timeline seconds (drawn only inside the span). */
  playhead: number;
  /** True while this pane owns playback through the live graph — false
   *  means the page is auditioning it the old way (no Web Audio here, or
   *  a span too long to hold as one buffer), where tone still costs a
   *  render. */
  live: boolean;
  /** Material is being fetched (a stem swap, a timeline edit). The audio
   *  in hand keeps playing until it lands. */
  loading: boolean;
  onTogglePlay(): void;
  /** Seek, in output-timeline seconds. */
  onSeek(secs: number): void;
  timecode(secs: number): string;
  /** The level automation lane, drawn under the waveform. */
  levelLane?: ReactNode;
  /** Extra readout text (beats selected, sample rate…). */
  readoutExtra?: ReactNode;
}

export function ClipSelectionPane({
  span,
  peaks,
  waveHeight: H,
  playing,
  playhead,
  live,
  loading,
  onTogglePlay,
  onSeek,
  timecode,
  levelLane,
  readoutExtra,
}: ClipSelectionPaneProps) {
  const len = Math.max(0, span.end - span.start);
  const xOf = (secs: number) => (len > 0 ? ((secs - span.start) / len) * W : 0);
  const inside = playhead >= span.start - 1e-6 && playhead <= span.end + 1e-6;

  const seekAt = (e: ReactMouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || len <= 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    onSeek(span.start + Math.min(1, Math.max(0, frac)) * len);
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
          Selection {timecode(span.start)}–{timecode(span.end)} · loops
        </span>
        <span
          className={live ? 'clip-sel-live' : 'clip-sel-live clip-sel-live-off'}
          data-testid="clip-sel-live"
          title={
            live
              ? 'EQ, level and stems are applied live — playback never stops for an edit'
              : 'No live audio here: tone changes re-render this span'
          }
        >
          {loading ? 'loading…' : live ? 'live' : 'rendered'}
        </span>
      </div>

      <div className="clip-timeline clip-sel-timeline">
        <svg
          data-testid="clip-sel-waveform"
          className="clip-waveform clip-sel-waveform"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          onMouseDown={seekAt}
        >
          <path className="waveform-peaks clip-sel-peaks" d={peaksPath(peaks, 0, 1, H)} />
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
        {levelLane}
        <p className="clip-readout" data-testid="clip-sel-readout">
          {timecode(len)} selected{readoutExtra}
        </p>
      </div>
    </section>
  );
}
