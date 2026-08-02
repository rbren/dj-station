// Deck waveform: full-track overview + zoomed strip around the playhead.
// Pure SVG (testable in jsdom): peaks polygon, playhead line, hot-cue
// markers, loop region. Clicking either view seeks.

import type { MouseEvent as ReactMouseEvent } from 'react';

const W = 1000; // viewBox width (all x positions are fractions of this)
const OVERVIEW_H = 80;
const ZOOM_H = 60;
/// Zoomed strip window, seconds around the playhead.
const ZOOM_WINDOW_SECS = 8;

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

function peaksPath(peaks: number[], from: number, to: number, height: number): string {
  // from/to are fractions of the track; draw a symmetric min/max polygon.
  const n = peaks.length;
  if (n === 0 || to <= from) return '';
  const mid = height / 2;
  const top: string[] = [];
  const bottom: string[] = [];
  const steps = 200;
  for (let s = 0; s <= steps; s++) {
    const frac = from + ((to - from) * s) / steps;
    const idx = Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
    const p = frac >= 0 && frac <= 1 ? peaks[idx] : 0;
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
      onClick={seek}
    >
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
  const dur = props.durationSecs;
  // Zoom window centered on the playhead, clamped inside the track.
  let zoomFrom = 0;
  let zoomTo = 1;
  if (dur > ZOOM_WINDOW_SECS) {
    const half = ZOOM_WINDOW_SECS / 2 / dur;
    const center = Math.min(1 - half, Math.max(half, props.positionSecs / dur));
    zoomFrom = center - half;
    zoomTo = center + half;
  }
  return (
    <div className="waveform" data-testid="waveform">
      <Strip {...props} testId="waveform-overview" height={OVERVIEW_H} from={0} to={1} />
      <Strip {...props} testId="waveform-zoom" height={ZOOM_H} from={zoomFrom} to={zoomTo} />
    </div>
  );
}
