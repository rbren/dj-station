// Rendering stress harness (dev-only): profile the rack UI with N mock
// modules and live synthetic telemetry, without Tauri or the Rust engine.
//
//   npm run dev  →  http://localhost:1420/?stress=24
//
// URL params:
//   stress=N        number of mock modules (required to activate)
//   active=F        fraction of jacks with moving telemetry, 0..1 (default 0.6)
//
// Keys: [t] pause/resume telemetry movement  [l] log store contents.
//
// The whole module is loaded via a dynamic import guarded by
// `import.meta.env.DEV` in main.tsx, so nothing here reaches the
// production bundle. Inside Tauri the ?stress param never appears, so the
// harness can't shadow the real engine by accident.
//
// How to profile (plain Chrome — much better tooling than the webview):
//   1. React DevTools Profiler: record ~5 s idle → the flamegraph shows
//      which panels re-render on each telemetry tick and why.
//   2. Performance panel: record while dragging a module / panning /
//      dragging a knob → look at long tasks, forced reflows
//      (getBoundingClientRect under WireOverlay.measure) and paint costs.
//   3. The HUD (top right) gives live fps / long-frame / commit counts to
//      compare N=12/24/48/96 runs at a glance.

import type { ProfilerOnRenderCallback } from 'react';
import { createMockEngine, type MockEngine } from './mockEngine';
import { installPerfHud } from './PerfHud';

export interface StressHarness {
  onCommit: ProfilerOnRenderCallback;
  engine: MockEngine;
}

/** Parse ?stress=N; null means the harness is inactive. */
export function stressParams(search: string): { modules: number; activeFraction: number } | null {
  const params = new URLSearchParams(search);
  const raw = params.get('stress');
  if (raw === null) return null;
  const modules = Number(raw);
  if (!Number.isFinite(modules) || modules <= 0) return null;
  const active = Number(params.get('active') ?? '0.6');
  return {
    modules: Math.floor(modules),
    activeFraction: Number.isFinite(active) ? Math.min(1, Math.max(0, active)) : 0.6,
  };
}

export function installStressHarness(opts: {
  modules: number;
  activeFraction: number;
}): StressHarness {
  const engine = createMockEngine({ modules: opts.modules, activeFraction: opts.activeFraction });
  window.__DJ_STRESS_INVOKE__ = engine.invoke;

  // Saved rack positions belong to the user's real patch, not to
  // stress-<n> instance ids; clear them so defaultPosition tiling applies
  // and runs are comparable.
  try {
    localStorage.removeItem('dj-rack-positions');
  } catch {
    // fine — layout just follows whatever was saved
  }

  const { modules, wires, jacks } = engine.counts();
  const hud = installPerfHud(
    `${modules} modules  ${wires} wires  ${jacks} jacks  active=${opts.activeFraction}`,
  );

  let paused = false;
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLElement && e.target.tagName === 'INPUT') return;
    if (e.key === 't') {
      paused = !paused;
      engine.setActiveFraction(paused ? 0 : opts.activeFraction);
      hud.setStatus(paused ? 'telemetry PAUSED' : '');
    } else if (e.key === 'l') {
      console.log('[stress] engine counts', engine.counts());
    }
  });

  console.log(
    `[stress] harness active: ${modules} modules, ${wires} wires, ${jacks} jacks.\n` +
      'Profile with React DevTools (per-panel commits) and the Performance panel.',
  );

  return { onCommit: hud.onCommit, engine };
}
