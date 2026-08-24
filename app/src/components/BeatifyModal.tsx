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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  anchorStride,
  beatAt,
  beatTime,
  DEFAULT_RULER_GROUP,
  gridLines,
  gridLod,
  IN_BAND_MS,
  LEAD_IN_MAX_MS,
  qualityLevel,
  readingOf,
  scopePreMs,
  selectionLabel,
  snapSelection,
  timecode,
  verdictLabel,
  type BeatifyAnalysis,
  type BeatifyClientApi,
  type BeatifyScope,
  type BeatifyTrack,
  type Quality,
} from '../beatify';
import { ClipTransport, type TransportHost } from '../clipTransport';
import { logError } from '../errors';
import { AudioTimeline, viewSpan, type Range } from './AudioTimeline';
import { BeatifyCutScope } from './BeatifyCutScope';
import type { TimeTick } from '../clip';
import { beatSnap } from './BeatifyTrackView';
import { WAVEFORM_VIEW_W as W } from './WaveformView';

const WAVE_H = 110;
const STRIP_H = 70;
const BUCKETS = 1400;
/** Audition window length (MOD-A23: seconds, never a whole track). */
const AUDITION_SECS = 20;
/** Error strip scale (MOD-4), milliseconds. */
const STRIP_MS = 40;
/** Samples per inspector trace: enough for a transient to keep its shape
 *  across a pane a few hundred pixels wide. */
const SCOPE_POINTS = 300;
/** Where a dot stops being amber and turns red — the legend and the
 *  colour law read the same number. */
const STRIP_BAD_MS = 15;

export interface BeatifyModalProps {
  client: BeatifyClientApi;
  trackId: number;
  title: string;
  /** The project Save commits into. Empty means a NEW one — the modal is
   *  how a project is born; a re-beatify passes the id it replaces. */
  projectId?: string;
  /** What to call a new project. Ignored when replacing an existing one. */
  projectName?: string;
  onCommitted(track: BeatifyTrack): void;
  onCancel(): void;
}

export function BeatifyModal({
  client,
  trackId,
  title,
  projectId = '',
  projectName = '',
  onCommitted,
  onCancel,
}: BeatifyModalProps) {
  const [analysis, setAnalysis] = useState<BeatifyAnalysis | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [strength, setStrength] = useState(0);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [residuals, setResiduals] = useState<number[]>([]);
  const [scope, setScope] = useState<BeatifyScope | null>(null);
  const [leadInMs, setLeadInMs] = useState(0);
  const [rulerGroup, setRulerGroup] = useState(DEFAULT_RULER_GROUP);
  const [region, setRegion] = useState<[number, number] | null>(null);
  const [click, setClick] = useState(false);
  const [warpedAudition, setWarpedAudition] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** MOD-A18: the audition loops the region by default. */
  const [loop, setLoop] = useState(true);
  const [vp, setVp] = useState<Range | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Held for the sync-check render only; auditions go through the
   *  transport, which owns its own URLs. */
  const objectUrl = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  const duration = analysis?.source.durationSecs ?? 0;
  /** How far in front of the beat the inspector looks — wide enough to
   *  hold the cut, whatever the lead-in has been pushed to. */
  const scopePre = scopePreMs(leadInMs);

  // --- playback: one ClipTransport owns everything that sounds ----------
  //
  // Same ownership as the Clip page (see clipTransport.ts). The host
  // reads the CURRENT audition settings through a ref, so one transport
  // instance survives every knob.
  const transportRef = useRef<ClipTransport | null>(null);
  const live = useRef({ client, duration, warpedAudition, strength, click });
  useLayoutEffect(() => {
    live.current = { client, duration, warpedAudition, strength, click };
  });

  useEffect(() => {
    const host: TransportHost = {
      duration: () => live.current.duration,
      element: () => audioRef.current,
      render: (start, len) =>
        live.current.client.preview(
          start,
          len,
          live.current.warpedAudition,
          live.current.strength,
          live.current.click,
        ),
      onStatus: (s) => {
        setPlaying(s.playing);
        setPlayhead(s.playhead);
      },
    };
    const transport = new ClipTransport(host, { windowSecs: AUDITION_SECS });
    transportRef.current = transport;
    return () => {
      transportRef.current = null;
      transport.dispose();
    };
  }, []);

  // MOD-A18: what plays IS the region, looped, so dragging its edges is
  // audible — it catches the half-beat phase error no plot can show.
  const loopRange = useMemo(
    () =>
      !loop
        ? null
        : region
          ? { start: region[0], end: region[1] }
          : duration > 0
            ? { start: 0, end: duration }
            : null,
    [duration, loop, region],
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

  // A/B flips WHAT the times index (source vs warped render): stale.
  useEffect(() => {
    transportRef.current?.invalidate();
  }, [warpedAudition]);

  // The click track and the warp strength change the sound, not the
  // timeline: re-render the playing window in place (inaudible when
  // paused — refreshTone is a no-op then).
  useEffect(() => {
    transportRef.current?.refreshTone();
  }, [click, strength]);

  const adopt = useCallback((next: BeatifyAnalysis) => {
    setAnalysis(next);
    // MOD-A3: a fresh detection resets phase 2 to the recommendation.
    setStrength(next.strength);
    setQuality(next.quality);
    setResiduals(next.residuals);
    setLeadInMs(Math.round(next.leadIn * 1000));
    // On whole beats from the start, so the bracket, the readout and what
    // Re-run would send are the same span. The sub-beat head and tail are
    // dimmed because they really are dropped: the render begins and ends
    // on a beat.
    const [from, to] = next.region;
    const beats = snapSelection(next.sourceGrid, from, to);
    setRegion([
      beatTime(next.sourceGrid, beats.startBeat),
      beatTime(next.sourceGrid, beats.endBeat),
    ]);
    // A new grid: whatever was rendered belongs to the old one.
    transportRef.current?.invalidate();
  }, []);

  const run = useCallback(
    async (span: [number, number] | null) => {
      setBusy(true);
      setError(null);
      const next = await client.analyze(trackId, span, BUCKETS);
      setBusy(false);
      if (!next) {
        logError('beatify.analyze', `no analysis for track ${trackId} (span: ${span ?? 'whole'})`);
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
        logError('beatify.analyze', `no analysis for track ${trackId}`);
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

  // The inspector's traces (§3.5). They follow the warp — that is MOD-9,
  // the traces converging as strength rises — and the window width, which
  // only changes when the lead-in outgrows it. Moving the lead-in inside
  // the window costs nothing: the cut line is drawn client-side.
  useEffect(() => {
    if (!analysis) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const next = await client.scope(strength, SCOPE_POINTS, scopePre / 1000);
        if (!cancelled) setScope(next);
      })();
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [analysis, client, scopePre, strength]);

  // MOD-A16: spacebar plays/pauses, like every other transport here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
      if (e.key !== ' ') return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay]);

  const syncCheck = useCallback(async () => {
    const bytes = await client.syncCheck(strength, leadInMs / 1000);
    if (!bytes) return;
    // The sync render is its own little file, outside the audition
    // timeline: park the transport, then borrow the element.
    transportRef.current?.pause();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = url;
    const el = audioRef.current;
    if (!el) return;
    el.src = url;
    setStatus(
      `Sync check: four beats from each end, layered and looped, cut ${leadInMs} ms before the beat. Clean means commit.`,
    );
    try {
      await el.play();
    } catch {
      // jsdom (and a webview with no output device) cannot play; the
      // element still holds the rendered audio.
    }
  }, [client, leadInMs, strength]);

  const commit = useCallback(async () => {
    setBusy(true);
    setError(null);
    const track = await client.save(
      {
        strength,
        leadIn: leadInMs / 1000,
        rulerGroup,
        projectId,
        name: projectName,
      },
      BUCKETS,
    );
    setBusy(false);
    if (!track) {
      logError('beatify.save', `render failed for track ${trackId}`);
      setError('Rendering the warp failed');
      return;
    }
    onCommitted(track);
  }, [client, leadInMs, onCommitted, projectId, projectName, rulerGroup, strength, trackId]);

  const dismiss = useCallback(() => {
    void client.cancel();
    onCancel();
  }, [client, onCancel]);

  // --- region selection on the track waveform (MOD-A8/A9) ---------------
  //
  // The region IS the timeline's selection. Sweeping (re)draws it; a
  // plain click seeks to the nearest beat (MOD-A17, ⌘ frees it) and puts
  // the region back to what the analysis covered — an empty region would
  // mean "discard everything".
  //
  // Beats are the unit here exactly as they are in the track view, and
  // for the same reason: a region that starts a third of a beat late is
  // not a thing anyone means. The lattice is the SOURCE grid — the fitted
  // line where it lands in the file — which is also what ÷2, ×2 and
  // Shift ½ move, so the reading buttons can be judged against the audio
  // they are claiming to describe. It runs past the analyzed region on
  // purpose: the region is an input to the next detection run, so it has
  // to be growable, not trapped inside the last one.
  const sourceGrid = analysis?.sourceGrid ?? null;
  const onRegionChange = useCallback(
    (r: Range | null) => {
      if (!analysis) return;
      if (!r || r.end - r.start < 0.05) setRegion(analysis.region);
      else setRegion([r.start, r.end]);
    },
    [analysis],
  );
  const snap = useMemo(() => (sourceGrid ? beatSnap(sourceGrid) : undefined), [sourceGrid]);

  // --- the beat grid over the source (TV-1's law, one octave down) ------
  const { start: vpStart, end: vpEnd, len: vpLen } = viewSpan(vp, duration);
  const lod = gridLod(vpLen / Math.max(1e-6, sourceGrid?.period ?? 1), rulerGroup);
  const ticks = useMemo<TimeTick[]>(() => {
    if (!sourceGrid) return [];
    const period = Math.max(1e-6, sourceGrid.period);
    const fromBeat = Math.floor((vpStart - sourceGrid.phase) / period);
    const toBeat = Math.ceil((vpEnd - sourceGrid.phase) / period);
    const emphasized = new Set(gridLines(sourceGrid, fromBeat, toBeat, lod.emphasis));
    return gridLines(sourceGrid, fromBeat, toBeat, lod.step).map((t) => ({
      secs: t,
      major: emphasized.has(t),
      label: String(beatAt(sourceGrid, t)),
    }));
  }, [lod.emphasis, lod.step, sourceGrid, vpEnd, vpStart]);

  /** The region in beats — what "16 beats · 4 groups" is counting. */
  const regionBeats = sourceGrid && region ? snapSelection(sourceGrid, region[0], region[1]) : null;

  // --- error strip (§3.4) -----------------------------------------------
  //
  // It rides under the waveform and shares its x, so a dot sits beneath
  // the beat it is about (MOD-4) — which is only true if each residual is
  // placed by the BEAT IT MEASURES rather than by its position in the
  // array: a beat the tracker missed leaves a hole, and spacing the dots
  // evenly would slide everything after it under the wrong audio.
  //
  // Everything the strip means is written next to it. It was a field of
  // unlabelled dots, on a scale nobody could read, measuring a quantity
  // nobody had been told.
  const xOf = useCallback(
    (secs: number) => ((secs - vpStart) / Math.max(1e-9, vpLen)) * W,
    [vpLen, vpStart],
  );
  const strip = (
    <div className="beatify-strip-lane">
      <p className="beatify-strip-title">
        <span>Timing error, one dot per beat, under the beat it measures</span>
        <span className="beatify-strip-key" data-testid="beatify-strip-key">
          <i className="beatify-key-dot good" /> within ±{IN_BAND_MS} ms
          <i className="beatify-key-dot warn" /> to ±{STRIP_BAD_MS} ms
          <i className="beatify-key-dot bad" /> beyond
        </span>
      </p>
      <div className="beatify-strip-plot">
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
            const beat = analysis?.residualBeats[i];
            if (!sourceGrid || beat === undefined) return null;
            const t = beatTime(sourceGrid, beat);
            if (t < vpStart || t > vpEnd) return null;
            const ms = r * 1000;
            const y = STRIP_H / 2 - Math.max(-1, Math.min(1, ms / STRIP_MS)) * (STRIP_H / 2);
            const cls =
              Math.abs(ms) <= IN_BAND_MS
                ? 'beatify-res good'
                : Math.abs(ms) <= STRIP_BAD_MS
                  ? 'beatify-res warn'
                  : 'beatify-res bad';
            return (
              <circle key={i} className={cls} cx={xOf(t)} cy={y} r={1.6}>
                <title>{`beat ${beat}: ${ms >= 0 ? '+' : ''}${ms.toFixed(1)} ms`}</title>
              </circle>
            );
          })}
        </svg>
        {/* HTML, not SVG text: the plot is stretched to the pane width
            (preserveAspectRatio="none"), which would stretch text with it. */}
        <span className="beatify-strip-mark hi">+{STRIP_MS} ms late</span>
        <span className="beatify-strip-mark zero">on the grid</span>
        <span className="beatify-strip-mark lo">−{STRIP_MS} ms early</span>
      </div>
      <p className="beatify-strip-caption" data-testid="beatify-strip-caption">
        How far each beat lands from the grid line it is being pulled onto, after warping. Flat
        scatter inside the band is a locked track; a ramp means the tempo is slightly off; a step is
        a real tempo change; lone spikes are outliers and can be ignored.
      </p>
    </div>
  );

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

        <AudioTimeline
          idPrefix="beatify"
          duration={duration}
          peaks={analysis?.source.peaks ?? []}
          waveHeight={WAVE_H}
          vp={vp}
          onVpChange={setVp}
          selection={region ? { start: region[0], end: region[1] } : null}
          onSelectionChange={onRegionChange}
          playing={playing}
          playhead={playhead}
          loop={loop}
          onTogglePlay={togglePlay}
          onStop={() => transportRef.current?.stop(region ? region[0] : 0)}
          onToggleLoop={() => setLoop((v) => !v)}
          onSeek={(t) => transportRef.current?.seek(t)}
          snap={snap}
          ticks={ticks}
          tickGrid="all"
          allowSlide={false}
          selectionTitle="The region being beatified — everything outside it is discarded"
          loopTitle="Loop the region (MOD-A18)"
          timecode={timecode}
          readoutExtra={
            regionBeats
              ? ` · region beats ${regionBeats.startBeat}–${regionBeats.endBeat} · ${selectionLabel(
                  regionBeats.endBeat - regionBeats.startBeat,
                  rulerGroup,
                )}`
              : null
          }
          belowWave={strip}
          transportExtra={
            <label className="beatify-click-toggle">
              <input
                type="checkbox"
                data-testid="beatify-click"
                checked={click}
                onChange={(e) => setClick(e.target.checked)}
              />
              Click track
            </label>
          }
          renderOver={(xOf) => (
            <>
              {/* MOD-3a: everything outside the region is dimmed — it is
                  being discarded. */}
              {region && (
                <>
                  <rect
                    className="beatify-dim"
                    x={xOf(0)}
                    y={0}
                    width={Math.max(0, xOf(region[0]) - xOf(0))}
                    height={WAVE_H}
                  />
                  <rect
                    className="beatify-dim"
                    x={xOf(region[1])}
                    y={0}
                    width={Math.max(0, xOf(duration) - xOf(region[1]))}
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
            </>
          )}
        />

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
            <BeatifyCutScope scope={analysis ? scope : null} leadInMs={leadInMs} />
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
            <p className="beatify-line" data-testid="beatify-leadin-note">
              every cut starts this far before its beat; the grid itself does not move. Sync check
              is made of cuts, so it plays what this does.
            </p>
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
