/**
 * The cut point inspector (PRD §3.5) — where a millisecond becomes
 * something you can look at.
 *
 * A dozen beats from across the track, drawn on top of each other around
 * their grid line (MOD-8). Two questions get answered at a glance that no
 * readout answers: are the attacks in one place (MOD-9, they converge as
 * the warp strength rises), and does the cut open BEFORE the attack does
 * (MOD-10) — which is the whole job of the lead-in, and the reason the
 * slider moves something on screen instead of only a number.
 */
import React, { useMemo } from 'react';
import type { BeatifyScope } from '../beatify';
import { cutClearanceMs } from '../beatify';

const W = 1000;
const H = 200;
/** Room for the labels along the top. */
const TOP = 22;

export interface BeatifyCutScopeProps {
  scope: BeatifyScope | null;
  leadInMs: number;
}

const ms = (secs: number, digits = 1) => `${(secs * 1000).toFixed(digits)} ms`;

export function BeatifyCutScope({ scope, leadInMs }: BeatifyCutScopeProps) {
  const span = scope ? scope.preSecs + scope.postSecs : 0;
  /** Seconds relative to the grid line → x. */
  const xOf = (t: number) => (scope && span > 0 ? ((t + scope.preSecs) / span) * W : 0);

  const paths = useMemo(() => {
    if (!scope) return [];
    return scope.traces.map((trace) => {
      const n = trace.samples.length;
      const mid = TOP + (H - TOP) / 2;
      const amp = (H - TOP) / 2 - 2;
      return trace.samples
        .map((s, i) => {
          const x = (i / Math.max(1, n - 1)) * W;
          const y = mid - Math.max(-1, Math.min(1, s)) * amp;
          return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(' ');
    });
  }, [scope]);

  const attacks = (scope?.traces ?? []).map((t) => t.attack).filter((a): a is number => a !== null);
  const cut = -leadInMs / 1000;
  const xCut = xOf(cut);
  const clearance = cutClearanceMs(scope, leadInMs);

  return (
    <figure className="beatify-scope" data-testid="beatify-scope">
      <figcaption className="beatify-scope-title">
        cut point · {scope?.traces.length ?? 0} beats from across the track, overlaid
      </figcaption>
      {/* The labels live in HTML, not in the SVG: the drawing is stretched
          to whatever width the column has, and stretched text is a mess. */}
      <div className="beatify-scope-plot">
        <span className="beatify-scope-tag beat" style={{ left: `${(xOf(0) / W) * 100}%` }}>
          beat
        </span>
        <span
          // Hard against the left edge there is no room to hang the label
          // off the line, so it swaps sides rather than clipping.
          className={`beatify-scope-tag cut${xCut / W < 0.12 ? ' after' : ''}`}
          data-testid="beatify-scope-cut-tag"
          style={{ left: `${(xCut / W) * 100}%` }}
        >
          cut
        </span>
        <svg
          className="beatify-scope-svg"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="cut point inspector"
        >
          {/* Everything left of the cut is thrown away by every cut made
            from this grid — so it is drawn as thrown away. */}
          <rect
            className="beatify-scope-drop"
            data-testid="beatify-scope-drop"
            x={0}
            y={TOP}
            width={Math.max(0, xCut)}
            height={H - TOP}
          />
          {attacks.length > 0 && (
            <rect
              className="beatify-scope-attacks"
              data-testid="beatify-scope-attacks"
              x={xOf(Math.min(...attacks))}
              y={TOP}
              width={Math.max(2, xOf(Math.max(...attacks)) - xOf(Math.min(...attacks)))}
              height={H - TOP}
            />
          )}
          {paths.map((d, i) => (
            <path key={i} className="beatify-scope-trace" d={d} />
          ))}
          <line
            className="beatify-scope-line"
            data-testid="beatify-scope-beat"
            x1={xOf(0)}
            x2={xOf(0)}
            y1={TOP - 6}
            y2={H}
          />
          <line
            className="beatify-scope-cut"
            data-testid="beatify-scope-cut"
            x1={xCut}
            x2={xCut}
            y1={TOP - 6}
            y2={H}
          />
        </svg>
      </div>
      <div className="beatify-scope-axis">
        <span>−{scope ? Math.round(scope.preSecs * 1000) : 0} ms</span>
        <span>the grid line</span>
        <span>+{scope ? Math.round(scope.postSecs * 1000) : 0} ms</span>
      </div>
      <figcaption className="beatify-scope-readout" data-testid="beatify-scope-readout">
        {scope && attacks.length > 0 ? (
          <>
            <span>attacks begin {ms(scope.attackLead)} before the beat</span>
            <span
              className={
                clearance !== null && clearance < 0
                  ? 'beatify-scope-clear bad'
                  : 'beatify-scope-clear good'
              }
              data-testid="beatify-scope-clearance"
            >
              {clearance !== null && clearance < 0
                ? `cut is ${Math.abs(clearance).toFixed(1)} ms INSIDE the attack`
                : `cut clears them by ${(clearance ?? 0).toFixed(1)} ms`}
            </span>
            <span>spread {ms(scope.spread)} across the traces</span>
          </>
        ) : (
          <span>no attack to measure here yet</span>
        )}
      </figcaption>
    </figure>
  );
}
