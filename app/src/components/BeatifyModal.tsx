// Beatify import modal (PRD §3): inspection, not configuration.
//
// Two phases, in order, because the second is meaningless until the first
// settles: DETECTION answers "where are the beats", ALIGNMENT answers "how
// hard do we force them". Analysis runs automatically on open (MOD-A1) and
// phase 2 is visible but inert until it lands (MOD-A2).
//
// Nothing here persists (§3.10). The warp slider never renders audio
// (MOD-A22) — it re-queries anchor arithmetic; auditioning renders only
// the beats being heard (MOD-A23); the one full render happens on Save
// (MOD-A24). Dismissing writes nothing (MOD-A25).
//
// Colour semantics (MOD-1): amber is what was played (detections, drift),
// teal is what the maths says (grid lines, anchors).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  anchorStride,
  DEFAULT_RULER_GROUP,
  IN_BAND_MS,
  LEAD_IN_MAX_MS,
  qualityLevel,
  readingOf,
  snapTime,
  timecode,
  verdictLabel,
  type BeatifyAnalysis,
  type BeatifyClientApi,
  type BeatifyTrack,
  type Quality,
} from '../beatify';
import { peaksPath, WAVEFORM_VIEW_W as W } from './WaveformView';

const WAVE_H = 110;
const STRIP_H = 70;
const BUCKETS = 1400;
/** Audition window length (MOD-A23: seconds, never a whole track). */
const AUDITION_SECS = 20;
/** Error strip scale (MOD-4), milliseconds. */
const STRIP_MS = 40;

export interface BeatifyModalProps {
  client: BeatifyClientApi;
  trackId: number;
  title: string;
  onCommitted(track: BeatifyTrack): void;
  onCancel(): void;
}

export function BeatifyModal({ client, trackId, title, onCommitted, onCancel }: BeatifyModalProps) {
  const [analysis, setAnalysis] = useState<BeatifyAnalysis | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [strength, setStrength] = useState(0);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [residuals, setResiduals] = useState<number[]>([]);
  const [leadInMs, setLeadInMs] = useState(0);
  const [rulerGroup, setRulerGroup] = useState(DEFAULT_RULER_GROUP);
  const [region, setRegion] = useState<[number, number] | null>(null);
  const [click, setClick] = useState(false);
  const [warpedAudition, setWarpedAudition] = useState(false);
  const [playhead, setPlayhead] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  const adopt = useCallback((next: BeatifyAnalysis) => {
    setAnalysis(next);
    // MOD-A3: a fresh detection resets phase 2 to the recommendation.
    setStrength(next.strength);
    setQuality(next.quality);
    setResiduals(next.residuals);
    setLeadInMs(Math.round(next.leadIn * 1000));
    setRegion(next.region);
  }, []);

  const run = useCallback(
    async (span: [number, number] | null) => {
      setBusy(true);
      setError(null);
      const next = await client.analyze(trackId, span, BUCKETS);
      setBusy(false);
      if (!next) {
        setError('Could not track beats in that audio');
        return;
      }
      adopt(next);
      setStatus(
        span ? 'Re-detected on the selected region — alignment reset to the recommendation' : null,
      );
    },
    [adopt, client, trackId],
  );

  // MOD-A1: analysis starts automatically on open — no "Analyze" button,
  // because the common case should present a finished result, not a form.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await client.analyze(trackId, null, BUCKETS);
      if (cancelled) return;
      setBusy(false);
      if (!next) {
        setError('Could not track beats in that audio');
        return;
      }
      adopt(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [adopt, client, trackId]);

  const applyReading = useCallback(
    async (factor: number, halfShift: boolean) => {
      setBusy(true);
      const next = await client.setReading({ factor, halfShift }, BUCKETS);
      setBusy(false);
      if (next) adopt(next);
    },
    [adopt, client],
  );

  // MOD-A22: the slider is arithmetic. Debounced only to spare the IPC.
  useEffect(() => {
    if (!analysis) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const meters = await client.meters(strength);
        if (!cancelled && meters) {
          setQuality(meters.quality);
          setResiduals(meters.residuals);
        }
      })();
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [analysis, client, strength]);

  const play = useCallback(
    async (fromSecs: number) => {
      if (!analysis) return;
      // MOD-A18: what plays IS the region, looped, so dragging its edges is
      // audible — it catches the half-beat phase error no plot can show.
      const span = region ? Math.min(AUDITION_SECS, region[1] - fromSecs) : AUDITION_SECS;
      const bytes = await client.preview(
        fromSecs,
        Math.max(1, span),
        warpedAudition,
        strength,
        click,
      );
      if (!bytes) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = url;
      const el = audioRef.current;
      if (!el) return;
      el.src = url;
      el.loop = true;
      setPlayhead(fromSecs);
      try {
        await el.play();
      } catch {
        // jsdom (and a webview with no output device) cannot play; the
        // element still holds the rendered audio.
      }
    },
    [analysis, click, client, region, strength, warpedAudition],
  );

  // MOD-A16: spacebar plays/pauses, like every other transport here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
      if (e.key !== ' ') return;
      e.preventDefault();
      const el = audioRef.current;
      if (el && !el.paused) {
        el.pause();
        return;
      }
      if (el?.src) {
        void el.play().catch(() => undefined);
        return;
      }
      void play(region ? region[0] : 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [play, region]);

  const syncCheck = useCallback(async () => {
    const bytes = await client.syncCheck(strength);
    if (!bytes) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = url;
    const el = audioRef.current;
    if (!el) return;
    el.src = url;
    setStatus('Sync check: four beats from each end, layered. Clean means commit.');
    try {
      await el.play();
    } catch {
      /* see play() */
    }
  }, [client, strength]);

  const commit = useCallback(async () => {
    setBusy(true);
    setError(null);
    const track = await client.save({ strength, leadIn: leadInMs / 1000, rulerGroup }, BUCKETS);
    setBusy(false);
    if (!track) {
      setError('Rendering the warp failed');
      return;
    }
    onCommitted(track);
  }, [client, leadInMs, onCommitted, rulerGroup, strength]);

  const dismiss = useCallback(() => {
    void client.cancel();
    onCancel();
  }, [client, onCancel]);

  // --- region selection on the whole-track waveform (MOD-A8/A9) --------
  const waveRef = useRef<SVGSVGElement | null>(null);
  const dragFrom = useRef<number | null>(null);
  const duration = analysis?.source.durationSecs ?? 0;

  const timeAt = useCallback(
    (clientX: number, rect: DOMRect) => {
      if (rect.width <= 0 || duration <= 0) return 0;
      const frac = (clientX - rect.left) / rect.width;
      return Math.min(duration, Math.max(0, frac * duration));
    },
    [duration],
  );

  const onWaveDown = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      if (!analysis) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const t = timeAt(e.clientX, rect);
      dragFrom.current = t;
      setRegion([t, t]);
    },
    [analysis, timeAt],
  );

  const onWaveMove = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      if (dragFrom.current === null) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const t = timeAt(e.clientX, rect);
      const a = dragFrom.current;
      setRegion([Math.min(a, t), Math.max(a, t)]);
    },
    [timeAt],
  );

  const onWaveUp = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      const start = dragFrom.current;
      dragFrom.current = null;
      if (start === null || !analysis) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const t = timeAt(e.clientX, rect);
      if (Math.abs(t - start) < 0.05) {
        // A click, not a drag: MOD-A17 seeks to the nearest beat.
        setRegion(analysis.region);
        void play(snapTime(analysis.grid, t));
        return;
      }
      setRegion([Math.min(start, t), Math.max(start, t)]);
    },
    [analysis, play, timeAt],
  );

  const xOf = (secs: number) => (duration > 0 ? (secs / duration) * W : 0);
  const agreement = analysis?.agreement;
  const reading = readingOf(analysis?.reading);
  const stride = anchorStride(strength);
  const zone = analysis?.sweep.zone ?? null;
  const level = quality ? qualityLevel(quality) : 'warn';

  return (
    <div className="beatify-modal-backdrop" data-testid="beatify-modal">
      <div className="beatify-modal">
        <header className="beatify-modal-head">
          <h2>Beatify · Import</h2>
          <span className="beatify-file">{title}</span>
          {/* MOD-31: provenance is never a click away. */}
          <span className="beatify-agreement" data-testid="beatify-verdict">
            {agreement
              ? `${agreement.readings.length} seed${
                  agreement.readings.length === 1 ? '' : 's'
                } · ${verdictLabel(agreement)} ${agreement.phaseAgreementPct.toFixed(0)}%`
              : 'analyzing…'}
          </span>
        </header>

        {error && (
          <p className="beatify-error" data-testid="beatify-error">
            {error}
          </p>
        )}
        {status && <p className="beatify-status">{status}</p>}

        <svg
          ref={waveRef}
          className="beatify-wave"
          data-testid="beatify-wave"
          viewBox={`0 0 ${W} ${WAVE_H}`}
          preserveAspectRatio="none"
          onMouseDown={onWaveDown}
          onMouseMove={onWaveMove}
          onMouseUp={onWaveUp}
        >
          <path
            className="beatify-peaks"
            d={peaksPath(analysis?.source.peaks ?? [], 0, 1, WAVE_H)}
          />
          {/* MOD-3a: the region is always drawn, and everything outside it
              is dimmed — it is being discarded. */}
          {region && (
            <>
              <rect className="beatify-dim" x={0} y={0} width={xOf(region[0])} height={WAVE_H} />
              <rect
                className="beatify-dim"
                x={xOf(region[1])}
                y={0}
                width={Math.max(0, W - xOf(region[1]))}
                height={WAVE_H}
              />
              <rect
                className="beatify-region"
                data-testid="beatify-region"
                x={xOf(region[0])}
                y={0}
                width={Math.max(1, xOf(region[1]) - xOf(region[0]))}
                height={WAVE_H}
              />
            </>
          )}
          {/* Drift: where the source tempo leaves the target (MOD-3). */}
          {analysis?.drift.map((d, i) => (
            <rect
              key={`drift-${i}`}
              className="beatify-drift"
              x={xOf(d.startSecs)}
              y={WAVE_H - 12}
              width={Math.max(1, xOf(d.endSecs) - xOf(d.startSecs))}
              height={12}
            >
              <title>{`${d.deltaBpm > 0 ? 'PUSHES' : 'DRAGS'} ${d.deltaBpm.toFixed(1)} BPM`}</title>
            </rect>
          ))}
          {/* Seed disagreement (MOD-A6). */}
          {agreement?.disagreementSpans.map((s, i) => (
            <rect
              key={`dis-${i}`}
              className="beatify-disagree"
              x={xOf(s[0])}
              y={0}
              width={Math.max(2, xOf(s[1]) - xOf(s[0]))}
              height={WAVE_H}
            />
          ))}
          <line
            className="beatify-playhead"
            x1={xOf(playhead)}
            x2={xOf(playhead)}
            y1={0}
            y2={WAVE_H}
          />
        </svg>

        {/* Error strip (§3.4): signed per-beat residual, ±40 ms. */}
        <svg
          className="beatify-strip"
          data-testid="beatify-strip"
          viewBox={`0 0 ${W} ${STRIP_H}`}
          preserveAspectRatio="none"
        >
          <rect
            className="beatify-inband"
            x={0}
            y={STRIP_H / 2 - (IN_BAND_MS / STRIP_MS) * (STRIP_H / 2)}
            width={W}
            height={((IN_BAND_MS * 2) / STRIP_MS) * (STRIP_H / 2)}
          />
          <line className="beatify-zero" x1={0} x2={W} y1={STRIP_H / 2} y2={STRIP_H / 2} />
          {residuals.map((r, i) => {
            const ms = r * 1000;
            const y = STRIP_H / 2 - Math.max(-1, Math.min(1, ms / STRIP_MS)) * (STRIP_H / 2);
            const cls =
              Math.abs(ms) <= IN_BAND_MS
                ? 'beatify-res good'
                : Math.abs(ms) <= 15
                  ? 'beatify-res warn'
                  : 'beatify-res bad';
            const x = residuals.length > 1 ? (i / (residuals.length - 1)) * W : 0;
            return <circle key={i} className={cls} cx={x} cy={y} r={1.6} />;
          })}
        </svg>

        <div className="beatify-panes">
          <section className="beatify-phase" data-testid="beatify-phase1">
            <h3>1 · Detection</h3>
            <p className="beatify-line">
              {analysis
                ? `region ${analysis.region[0].toFixed(2)}–${analysis.region[1].toFixed(2)}s · ${analysis.grid.beats} beats · ${analysis.grid.bpm.toFixed(2)} BPM`
                : '—'}
            </p>
            <p className="beatify-line">
              tracker {analysis?.tracker ?? '—'} · spread{' '}
              {agreement ? agreement.tempoSpreadBpm.toFixed(2) : '—'} BPM · phase{' '}
              {agreement ? agreement.phaseAgreementPct.toFixed(1) : '—'}%
              {agreement?.metricalSplit ? ' · metrical split' : ''}
            </p>
            <div className="beatify-row">
              <button
                data-testid="beatify-rerun"
                disabled={busy || !region}
                onClick={() => region && void run(region)}
              >
                Re-run on region
              </button>
              <button
                data-testid="beatify-region-reset"
                disabled={busy || !analysis}
                onClick={() => void run(null)}
              >
                Whole file
              </button>
            </div>
            <div className="beatify-row">
              <span>reading</span>
              <button
                data-testid="beatify-halve"
                className={reading.factor < 1 ? 'active' : undefined}
                disabled={busy || !analysis}
                onClick={() => void applyReading(reading.factor / 2, reading.halfShift)}
              >
                ÷2 {analysis ? (analysis.grid.bpm / 2).toFixed(1) : ''}
              </button>
              <button
                data-testid="beatify-double"
                className={reading.factor > 1 ? 'active' : undefined}
                disabled={busy || !analysis}
                onClick={() => void applyReading(reading.factor * 2, reading.halfShift)}
              >
                ×2 {analysis ? (analysis.grid.bpm * 2).toFixed(1) : ''}
              </button>
              <button
                data-testid="beatify-half-shift"
                className={reading.halfShift ? 'active' : undefined}
                disabled={busy || !analysis}
                onClick={() => void applyReading(reading.factor, !reading.halfShift)}
              >
                Shift ½ beat
              </button>
              {analysis?.metricalFlag && (
                <span className="beatify-flag" data-testid="beatify-metrical-flag">
                  intervals look 2:1 — check ÷2 / ×2
                </span>
              )}
            </div>
            <div className="beatify-row">
              <button
                data-testid="beatify-play"
                disabled={!analysis}
                onClick={() => void play(region ? region[0] : 0)}
              >
                ▶ Play
              </button>
              <button data-testid="beatify-pause" onClick={() => audioRef.current?.pause()}>
                ⏸
              </button>
              <label>
                <input
                  type="checkbox"
                  data-testid="beatify-click"
                  checked={click}
                  onChange={(e) => setClick(e.target.checked)}
                />
                Click track
              </label>
              <span className="beatify-line">{timecode(playhead)}</span>
            </div>
          </section>

          {/* MOD-A2: phase 2 dims until phase 1 has a result — it never
              hides, because hiding controls that reappear is disorienting. */}
          <section
            className={analysis ? 'beatify-phase' : 'beatify-phase inert'}
            data-testid="beatify-phase2"
          >
            <h3>2 · Alignment</h3>
            <label className="beatify-slider">
              <span>warp strength</span>
              <input
                type="range"
                data-testid="beatify-strength"
                min={0}
                max={1}
                step={0.05}
                value={strength}
                disabled={!analysis}
                onChange={(e) => setStrength(Number(e.target.value))}
              />
              <span data-testid="beatify-stride">
                {stride === 0 ? 'no warp' : `anchor every ${stride} beats`}
              </span>
            </label>
            {zone && (
              <p className="beatify-line" data-testid="beatify-zone">
                recommended {Math.round(zone[0] * 100)}–{Math.round(zone[1] * 100)}%
              </p>
            )}
            {!zone && analysis && (
              <p className="beatify-line" data-testid="beatify-zone">
                no setting passes both meters — this material fights the grid
              </p>
            )}
            <p className="beatify-line" data-testid="beatify-meters">
              worst flam {quality ? quality.worstFlamMs.toFixed(1) : '—'} ms · peak stretch{' '}
              {quality ? quality.peakStretchPct.toFixed(2) : '—'} %
            </p>
            <label className="beatify-slider">
              <span>lead-in</span>
              <input
                type="range"
                data-testid="beatify-leadin"
                min={0}
                max={LEAD_IN_MAX_MS}
                step={1}
                value={leadInMs}
                disabled={!analysis}
                onChange={(e) => setLeadInMs(Number(e.target.value))}
              />
              <span>{leadInMs} ms</span>
            </label>
            <label className="beatify-slider">
              <span>ruler group</span>
              <input
                type="number"
                data-testid="beatify-ruler-group"
                min={1}
                max={16}
                value={rulerGroup}
                onChange={(e) => setRulerGroup(Math.max(1, Number(e.target.value) || 1))}
              />
              <span>display only</span>
            </label>
            <div className="beatify-row">
              <button
                data-testid="beatify-ab"
                className={warpedAudition ? 'active' : undefined}
                disabled={!analysis}
                onClick={() => setWarpedAudition((v) => !v)}
              >
                A/B {warpedAudition ? 'warped' : 'original'}
              </button>
              <button
                data-testid="beatify-sync"
                disabled={!analysis}
                onClick={() => void syncCheck()}
              >
                Sync check
              </button>
            </div>
          </section>
        </div>

        <footer className="beatify-modal-foot">
          <span className={`beatify-verdict ${level}`} data-testid="beatify-quality">
            ● {quality ? quality.rmsMs.toFixed(2) : '—'} ms rms ·{' '}
            {quality ? quality.inBandPct.toFixed(0) : '—'}% in band · {analysis?.grid.beats ?? 0}{' '}
            beats · {analysis ? timecode(analysis.outputSecs) : '0:00.00'}
          </span>
          <button data-testid="beatify-cancel" onClick={dismiss}>
            Cancel
          </button>
          <button
            className="beatify-commit"
            data-testid="beatify-commit"
            disabled={!analysis || busy}
            onClick={() => void commit()}
          >
            Cut into beats
          </button>
        </footer>
        <audio ref={audioRef} data-testid="beatify-audio" />
      </div>
    </div>
  );
}
