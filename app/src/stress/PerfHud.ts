// Frame-time + React-commit HUD for the stress harness. Imperative DOM
// (never React) so the HUD's own 500 ms refresh cannot pollute the profile
// it is displaying.
//
// Reads three signals:
//  - rAF-to-rAF deltas: main-thread stalls push the next callback out, so
//    the delta distribution IS the frame-time distribution (p95 + worst,
//    plus "long" frames > 1.5× the measured vsync interval);
//  - PerformanceObserver 'longtask' entries (Chrome): blocking tasks >50ms;
//  - React <Profiler onRender> commits forwarded via onCommit(): commits/s
//    and React ms/s show how much of the frame budget React consumes;
//  - the instrumented render-pipeline phases from src/perf.ts (the cable
//    measure, the peaks path build, …): the dearest few per second, which
//    is what turns "React spent 40 ms" into a place to look.

import type { ProfilerOnRenderCallback } from 'react';
import { perfPhases, resetPerfPhases, setPerfEnabled } from '../perf';

const WINDOW_MS = 1000;
/** Instrumented phases shown per refresh, dearest first. */
const HUD_PHASES = 3;

export interface PerfHud {
  onCommit: ProfilerOnRenderCallback;
  setStatus(text: string): void;
  dispose(): void;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export function installPerfHud(subtitle: string): PerfHud {
  const el = document.createElement('div');
  el.id = 'stress-hud';
  el.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:99999;background:rgba(10,12,16,.92);' +
    'color:#cfe3ff;font:11px/1.5 ui-monospace,monospace;padding:8px 10px;' +
    'border:1px solid #2a3242;border-radius:6px;pointer-events:none;' +
    'white-space:pre;min-width:230px';
  document.body.appendChild(el);

  let frames: number[] = [];
  let commits = 0;
  let reactMs = 0;
  let maxCommitMs = 0;
  let longTasks = 0;
  let longTaskMs = 0;
  let status = '';
  let disposed = false;

  let lastFrame = performance.now();
  let raf = 0;
  const tick = (now: number) => {
    frames.push(now - lastFrame);
    lastFrame = now;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  let po: PerformanceObserver | null = null;
  try {
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks++;
        longTaskMs += e.duration;
      }
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch {
    po = null; // longtask unsupported (Firefox/WebKit) — HUD row shows n/a
  }

  // The instrumented stages of the render pipeline (src/perf.ts): which
  // of them the second's milliseconds went into, which is the difference
  // between "the page is slow" and "the cable measure is slow".
  setPerfEnabled(true);

  const phaseLines = () =>
    Object.entries(perfPhases())
      .sort((a, b) => b[1].ms - a[1].ms)
      .slice(0, HUD_PHASES)
      // Items as well as milliseconds: a stage getting dearer per item is
      // a slow machine, while a stage touching more items than it used to
      // is a lost window or a lost decimation.
      .map(
        ([label, p]) =>
          `  ${label} ${p.ms.toFixed(1)}ms/s ×${p.calls}` +
          (p.items ? ` ${p.items} items` : '') +
          `\n`,
      )
      .join('');

  const render = () => {
    const sorted = [...frames].sort((a, b) => a - b);
    const vsync = percentile(sorted, 0.5) || 16.7;
    const long = frames.filter((f) => f > vsync * 1.5).length;
    const fps = frames.length / (WINDOW_MS / 1000);
    el.textContent =
      `STRESS ${subtitle}\n` +
      `fps      ${fps.toFixed(0)}  (p95 ${percentile(sorted, 0.95).toFixed(1)}ms` +
      `  worst ${(sorted[sorted.length - 1] ?? 0).toFixed(1)}ms)\n` +
      `long>1.5x vsync  ${long}/s\n` +
      `longtask ${po ? `${longTasks}/s  ${longTaskMs.toFixed(0)}ms/s` : 'n/a'}\n` +
      `react    ${commits} commits/s  ${reactMs.toFixed(1)}ms/s` +
      `  max ${maxCommitMs.toFixed(1)}ms\n` +
      phaseLines() +
      (status ? `${status}\n` : '') +
      `keys: [t]elemetry pause  [l]og`;
    resetPerfPhases();
    frames = [];
    commits = 0;
    reactMs = 0;
    maxCommitMs = 0;
    longTasks = 0;
    longTaskMs = 0;
  };
  const interval = setInterval(render, WINDOW_MS);

  return {
    onCommit: (_id, _phase, actualDuration) => {
      commits++;
      reactMs += actualDuration;
      maxCommitMs = Math.max(maxCommitMs, actualDuration);
    },
    setStatus(text) {
      status = text;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      setPerfEnabled(false);
      cancelAnimationFrame(raf);
      clearInterval(interval);
      po?.disconnect();
      el.remove();
    },
  };
}
