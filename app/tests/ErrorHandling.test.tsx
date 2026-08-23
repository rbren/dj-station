// Regression cover for the hard UI crash: a jack whose telemetry `display`
// arrived as `null` (serde_json's rendering of a non-finite f32) threw
// `TypeError: null is not an object` out of render and blanked the app.
// Bad numbers must degrade to a placeholder, and anything that still throws
// must be caught and shown instead of killing the tree.
//
// It also pins the second half of that contract: nothing the user can see is
// allowed to be invisible in the devtools console.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBanner } from '../src/components/ErrorBanner';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { Jack } from '../src/components/Jack';
import { ModulePanel } from '../src/components/ModulePanel';
import {
  clearErrors,
  installGlobalErrorHandlers,
  logError,
  reportError,
  subscribeErrors,
} from '../src/errors';
import { fixed, safeNumber } from '../src/format';
import { IpcClient } from '../src/ipc';
import type { JackTelemetry, Manifest, ModuleHandle } from '../src/types';

/** Telemetry as it actually arrives when the engine emits NaN/Inf. */
const nullDisplay = { instantaneous: 0, rms_100ms: null, display: null, is_fast: true };

const MANIFEST: Manifest = {
  id: 'com.dj.mixer',
  name: 'Mixer',
  version: '0.1.0',
  abi: 'wasm-1',
  inputs: [
    { id: 'ch1', name: 'Ch1', knob: { style: 'continuous', min: 0, max: 1, curve: 'linear' } },
  ],
  outputs: [{ id: 'audio', name: 'Audio' }],
  params: [],
};

const noop = () => {};

const HANDLE: ModuleHandle = {
  paramValue: () => 0.5,
  setParam: noop,
  signalTap: () => ({ instantaneous: 0, rms_100ms: 0, display: 0, volatility: 0, is_fast: false }),
  size: { w: 300, h: 150 },
};

// Every path under test logs; the spy keeps the run readable and lets the
// console-logging cases assert on it.
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearErrors();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => consoleError.mockRestore());

describe('format helpers', () => {
  it('treats null/undefined/NaN/Infinity as unusable', () => {
    for (const bad of [null, undefined, NaN, Infinity, -Infinity, 'x', {}]) {
      expect(safeNumber(bad)).toBe(0);
      expect(fixed(bad)).toBe('—');
    }
  });

  it('formats real numbers normally', () => {
    expect(safeNumber(2.5)).toBe(2.5);
    expect(fixed(2.5)).toBe('2.50');
    expect(fixed(2.5, 1)).toBe('2.5');
    expect(fixed(0)).toBe('0.00');
  });
});

describe('Jack with malformed telemetry', () => {
  it('renders a placeholder instead of throwing on a null display', () => {
    expect(() =>
      render(
        <Jack
          instance="mixer1"
          id="ch1"
          kind="input"
          telemetry={nullDisplay as unknown as JackTelemetry}
        />,
      ),
    ).not.toThrow();
    expect(screen.getByTestId('jack-input-ch1').getAttribute('data-tip')).toBe('ch1: — (rms)');
  });

  it('degrades a NaN display to the neutral near-zero gray, not a crash', () => {
    render(
      <Jack
        instance="mixer1"
        id="ch1"
        kind="input"
        telemetry={{ instantaneous: 0, rms_100ms: 0, display: NaN, volatility: 0, is_fast: false }}
      />,
    );
    const glow = screen.getByTestId('jack-glow-ch1');
    // NaN reads as 0 → the neutral gray (low saturation), no volatile pulse.
    expect(glow.getAttribute('data-indicator')).toBe('hsl(210, 12%, 64%)');
    expect(glow.className).not.toContain('jack-glow-volatile');
  });

  it('renders a whole panel whose telemetry is all nulls', () => {
    render(
      <ModulePanel
        instanceId="mixer1"
        manifest={MANIFEST}
        knobs={{}}
        wired={{}}
        handle={HANDLE}
        telemetry={
          { ch1: nullDisplay, 'out:audio': nullDisplay } as unknown as Record<string, JackTelemetry>
        }
        onKnobPosition={noop}
        onKnobConfig={noop}
        onAttenOffset={noop}
      />,
    );
    expect(screen.getByTestId('jack-input-ch1').getAttribute('data-tip')).toBe('ch1: — (rms)');
    expect(screen.getByTestId('jack-output-audio').getAttribute('data-tip')).toBe('audio: — (rms)');
  });
});

describe('ErrorBoundary', () => {
  function Boom(): never {
    throw new TypeError("null is not an object (evaluating 'o.display.toFixed')");
  }

  it('shows the failure instead of unmounting the tree', () => {
    render(
      <div>
        <span data-testid="sibling">still here</span>
        <ErrorBoundary context="mixer1">
          <Boom />
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByTestId('sibling')).toBeTruthy();
    expect(screen.getByTestId('error-boundary-mixer1').textContent).toContain(
      'null is not an object',
    );
  });

  it('reports caught errors to the banner and the console', () => {
    render(
      <div>
        <ErrorBanner />
        <ErrorBoundary context="mixer1">
          <Boom />
        </ErrorBoundary>
      </div>,
    );
    const banner = screen.getByTestId('error-banner');
    expect(banner.textContent).toContain('mixer1');
    expect(banner.textContent).toContain('null is not an object');
    // …plus the component stack, which the banner has no room for.
    const logged = consoleError.mock.calls.find((c) => c[0] === '[mixer1]');
    expect(logged?.[1]).toBeInstanceOf(TypeError);
    expect(String(logged?.[2])).toContain('Boom');
  });
});

describe('ErrorBanner', () => {
  it('renders nothing when there are no errors', () => {
    render(<ErrorBanner />);
    expect(screen.queryByTestId('error-banner')).toBeNull();
  });

  it('shows reported errors and collapses duplicates', () => {
    render(<ErrorBanner />);
    act(() => {
      reportError('engine.tap', new Error('no such jack'));
      reportError('engine.tap', new Error('no such jack'));
    });
    expect(screen.getAllByText('no such jack')).toHaveLength(1);
    expect(screen.getByTestId('error-banner').textContent).toContain('engine.tap');
  });

  it('dismisses an error', () => {
    render(<ErrorBanner />);
    act(() => reportError('engine.start', new Error('audio device busy')));
    fireEvent.click(screen.getByText('✕'));
    expect(screen.queryByTestId('error-banner')).toBeNull();
  });

  it('carries the structured kind from backend CmdError payloads', () => {
    render(<ErrorBanner />);
    act(() => {
      // Shape a Tauri command rejects with (CmdError in the shell).
      reportError('remove_module', { kind: 'not_found', message: 'no such module instance: osc9' });
      reportError('window', new Error('plain frontend error'));
    });
    const items = screen
      .getByTestId('error-banner')
      .querySelectorAll<HTMLElement>('[data-testid^="error-item-"]');
    expect(items[0].dataset.kind).toBe('not_found');
    expect(items[0].textContent).toContain('no such module instance: osc9');
    expect(items[1].dataset.kind).toBe('unknown');
  });
});

describe('console trail', () => {
  it('logs every banner error with its context', () => {
    reportError('engine.start', new Error('audio device busy'));
    expect(consoleError).toHaveBeenCalledWith('[engine.start]', expect.any(Error));
  });

  it('collapses consecutive repeats in the console like the banner does', () => {
    reportError('telemetry', new Error('no such node'));
    reportError('telemetry', new Error('no such node'));
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('logs inline panel failures without pushing them into the banner', () => {
    let banner: unknown[] = [];
    const stop = subscribeErrors((errs) => (banner = errs));
    logError('search freesound', 'HTTP 503');
    expect(consoleError).toHaveBeenCalledWith('[search freesound]', 'HTTP 503');
    expect(banner).toHaveLength(0);
    stop();
  });

  it('captures stray window errors and unhandled rejections', () => {
    const stop = installGlobalErrorHandlers();
    render(<ErrorBanner />);
    act(() => {
      window.dispatchEvent(new ErrorEvent('error', { error: new Error('stray throw') }));
      // jsdom has no PromiseRejectionEvent constructor; the listener only
      // reads `reason`.
      const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
      rejection.reason = new Error('nobody caught me');
      window.dispatchEvent(rejection);
    });
    expect(consoleError).toHaveBeenCalledWith('[window]', expect.any(Error));
    expect(consoleError).toHaveBeenCalledWith('[promise]', expect.any(Error));
    const banner = screen.getByTestId('error-banner').textContent ?? '';
    expect(banner).toContain('stray throw');
    expect(banner).toContain('nobody caught me');
    stop();
  });
});

describe('IPC failures', () => {
  class TestClient extends IpcClient {
    run(cmd: string, quiet?: boolean) {
      return this.call<unknown>(cmd, undefined, { quiet });
    }
  }

  beforeEach(() => {
    window.__DJ_STRESS_INVOKE__ = () => Promise.reject(new Error('engine mutex poisoned'));
  });
  afterEach(() => delete window.__DJ_STRESS_INVOKE__);

  it('banners and logs a rejected command, and resolves null', async () => {
    render(<ErrorBanner />);
    let result: unknown = 'unset';
    await act(async () => {
      result = await new TestClient().run('add_module');
    });
    expect(result).toBeNull();
    expect(consoleError).toHaveBeenCalledWith('[add_module]', expect.any(Error));
    expect(screen.getByTestId('error-banner').textContent).toContain('engine mutex poisoned');
  });

  it('keeps a quiet poll out of the banner but still logs it', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    render(<ErrorBanner />);
    expect(await new TestClient().run('tap', true)).toBeNull();
    expect(debug).toHaveBeenCalledWith('[tap] (quiet)', expect.any(Error));
    expect(consoleError).not.toHaveBeenCalled();
    expect(screen.queryByTestId('error-banner')).toBeNull();
    debug.mockRestore();
  });
});
