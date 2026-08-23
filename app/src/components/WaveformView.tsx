// Deck waveform: full-track overview + zoomed strip around the playhead.
// Pure SVG (testable in jsdom): peaks polygon, playhead line, hot-cue
// markers, loop region. Clicking either view seeks.
//
// React renders from the 100 ms status poll; between polls DeckPanel's
// rAF loop extrapolates the transport (position + rate) and moves the
// playhead lines / scrolls the zoom window by direct DOM mutation — the
// track content of each strip is wrapped in <g class="waveform-scroll">
// exactly so that scroll is a single transform write, and the strip
// exposes its rendered window via data-from/data-to for the loop to
// compute against (see useDeckPlayhead in DeckPanel.tsx). A poll-driven
// re-render resets the mutations to the freshly-sampled truth.

import type { MouseEvent as ReactMouseEvent } from 'react';

/** viewBox width — all x positions are fractions of this. Exported for
 *  DeckPanel's rAF extrapolation, which computes in the same units. */
export const WAVEFORM_VIEW_W = 1000;
const W = WAVEFORM_VIEW_W;
const OVERVIEW_H = 80;
const ZOOM_H = 60;
/** Zoomed strip window, seconds around the playhead. Exported for
 *  DeckPanel's rAF extrapolation, which recomputes the same window. */
export const ZOOM_WINDOW_SECS = 8;

/** Zoom window (track fractions) centered on `positionSecs`, clamped
 *  inside the track — the one window law, shared between the React
 *  render and DeckPanel's between-poll extrapolation. */
export function zoomWindow(
  durationSecs: number,
  positionSecs: number,
): { from: number; to: number } {
  if (durationSecs <= ZOOM_WINDOW_SECS) return { from: 0, to: 1 };
  const half = ZOOM_WINDOW_SECS / 2 / durationSecs;
  const center = Math.min(1 - half, Math.max(half, positionSecs / durationSecs));
  return { from: center - half, to: center + half };
}

export interface WaveformViewProps {
  /** Peak per bucket, 0..=1, spanning the whole track. */
  peaks: number[];
  durationSecs: number;
  positionSecs: number;
  cues?: (number | null)[];
  loopStartSecs?: number | null;
  loopEndSecs?: number | null;
  loopEnabled?: boolean;
  onSeek?(positionSecs: number): void;
}

/** One column per viewBox unit at most: past this the path is bytes the
 *  screen cannot show. */
const MAX_PATH_STEPS = W;

/** Symmetric min/max polygon for a peak window — shared with the Clip
 *  page's editor waveform so both read the same.
 *
 *  from/to are fractions of the track. Columns come from the peaks
 *  ALREADY IN HAND: zooming in draws more of them (up to one per bucket)
 *  rather than stretching a fixed 200, and zooming out takes the loudest
 *  bucket per column rather than sampling one and aliasing the rest — a
 *  peak display that misses the peaks is worse than a coarse one. */
export function peaksPath(peaks: number[], from: number, to: number, height: number): string {
  const n = peaks.length;
  if (n === 0 || to <= from) return '';
  const mid = height / 2;
  const span = to - from;
  const steps = Math.max(1, Math.min(MAX_PATH_STEPS, Math.round(span * n)));
  const top: string[] = [];
  const bottom: string[] = [];
  for (let s = 0; s <= steps; s++) {
    const frac = from + (span * s) / steps;
    let p = 0;
    if (frac >= 0 && frac <= 1) {
      const lo = Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
      const hi = Math.min(n - 1, Math.max(lo, Math.floor((frac + span / steps) * n) - 1));
      for (let i = lo; i <= hi; i++) p = Math.max(p, peaks[i]);
    }
    const x = (s / steps) * W;
    top.push(`${x},${mid - p * mid}`);
    bottom.unshift(`${x},${mid + p * mid}`);
  }
  return `M${top.join(' L')} L${bottom.join(' L')} Z`;
}

interface StripProps extends WaveformViewProps {
  testId: string;
  height: number;
  /** Visible window as track fractions. */
  from: number;
  to: number;
}

function Strip(props: StripProps) {
  const { durationSecs, from, to, height } = props;
  const span = to - from;
  const xOf = (secs: number) => {
    if (durationSecs <= 0 || span <= 0) return null;
    const frac = (secs / durationSecs - from) / span;
    return frac >= 0 && frac <= 1 ? frac * W : null;
  };
  const playX = xOf(props.positionSecs);
  const loopStart = props.loopStartSecs ?? null;
  const loopEnd = props.loopEndSecs ?? null;
  const loopX0 = loopStart !== null ? xOf(loopStart) : null;
  const loopX1 = loopEnd !== null ? xOf(loopEnd) : null;

  const seek = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (!props.onSeek || durationSecs <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = from + ((e.clientX - rect.left) / rect.width) * span;
    props.onSeek(Math.min(durationSecs, Math.max(0, frac * durationSecs)));
  };

  return (
    <svg
      data-testid={props.testId}
      className="waveform-strip"
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      data-from={from}
      data-to={to}
      onClick={seek}
    >
      <g className="waveform-scroll">
        {(loopX0 !== null || loopX1 !== null) && loopStart !== null && loopEnd !== null && (
          <rect
            data-testid={`${props.testId}-loop`}
            className={props.loopEnabled ? 'waveform-loop enabled' : 'waveform-loop'}
            x={loopX0 ?? 0}
            y={0}
            width={(loopX1 ?? W) - (loopX0 ?? 0)}
            height={height}
          />
        )}
        <path className="waveform-peaks" d={peaksPath(props.peaks, from, to, height)} />
        {(props.cues ?? []).map((pos, slot) => {
          if (pos === null) return null;
          const x = xOf(pos);
          if (x === null) return null;
          return (
            <g key={slot}>
              <line
                data-testid={`${props.testId}-cue-${slot + 1}`}
                className="waveform-cue"
                x1={x}
                x2={x}
                y1={0}
                y2={height}
              />
              <text className="waveform-cue-label" x={x + 3} y={12}>
                {slot + 1}
              </text>
            </g>
          );
        })}
      </g>
      {playX !== null && (
        <line
          data-testid={`${props.testId}-playhead`}
          className="waveform-playhead"
          x1={playX}
          x2={playX}
          y1={0}
          y2={height}
        />
      )}
    </svg>
  );
}

export function WaveformView(props: WaveformViewProps) {
  const { from: zoomFrom, to: zoomTo } = zoomWindow(props.durationSecs, props.positionSecs);
  return (
    <div className="waveform" data-testid="waveform">
      <Strip {...props} testId="waveform-overview" height={OVERVIEW_H} from={0} to={1} />
      <Strip {...props} testId="waveform-zoom" height={ZOOM_H} from={zoomFrom} to={zoomTo} />
    </div>
  );
}
