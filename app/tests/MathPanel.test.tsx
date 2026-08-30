// Math panel: the expression box shows what the engine holds, typing
// reaches the engine debounced (one IPC per burst, not per keystroke),
// leaving the box commits and ends the undo gesture, and a compile error
// is shown without the text being taken away.
//
// The jack layout (one input, eight results) is manifest-driven and
// covered by the engine/PanelLayout tests; this suite is the panel body.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MathPanel, type MathApi } from '../src/components/MathPanel';
import type { MathStatus } from '../src/engine';

function makeApi(expr = 'x + i as f32', error: string | null = null) {
  const api = {
    status: vi.fn(async (): Promise<MathStatus | null> => ({ expr, error })),
    setExpr: vi.fn(async (_i: string, text: string): Promise<MathStatus | null> => ({
      expr: text,
      error: null,
    })),
    endEdit: vi.fn(async () => undefined),
  };
  return api satisfies MathApi;
}

async function renderPanel(api: MathApi, debounceMs = 10) {
  render(<MathPanel instance="math1" api={api} debounceMs={debounceMs} />);
  await act(async () => {
    await Promise.resolve();
  });
}

const box = () => screen.getByTestId('math-expr-math1') as HTMLTextAreaElement;

describe('MathPanel', () => {
  it('shows the expression the engine holds, with the variable hint', async () => {
    const api = makeApi('(3 * (x + i)).pow(2)');
    await renderPanel(api);
    expect(api.status).toHaveBeenCalledWith('math1');
    expect(box().value).toBe('(3 * (x + i)).pow(2)');
    expect(screen.getByTestId('math-hint-math1').textContent).toContain('output index');
    expect(screen.queryByTestId('math-error-math1')).toBeNull();
  });

  it('sends a burst of typing as ONE call after the debounce', async () => {
    vi.useFakeTimers();
    try {
      const api = makeApi();
      render(<MathPanel instance="math1" api={api} debounceMs={50} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      for (const text of ['x', 'x *', 'x * 2']) {
        fireEvent.change(box(), { target: { value: text } });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
      }
      expect(api.setExpr).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(api.setExpr.mock.calls).toEqual([['math1', 'x * 2']]);
      // Every keystroke is on screen the whole time — the debounce is
      // only about how often the engine hears.
      expect(box().value).toBe('x * 2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits a pending edit on blur and ends the undo gesture', async () => {
    vi.useFakeTimers();
    try {
      const api = makeApi();
      render(<MathPanel instance="math1" api={api} debounceMs={10_000} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      fireEvent.change(box(), { target: { value: 'i * 2.0' } });
      await act(async () => {
        fireEvent.blur(box());
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(api.setExpr).toHaveBeenCalledWith('math1', 'i * 2.0');
      expect(api.endEdit).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the compile error and keeps the text the user typed', async () => {
    const api = makeApi();
    api.setExpr.mockResolvedValue({
      expr: 'x * (2',
      error: 'expected `)` but found end of expression (column 7)',
    });
    await renderPanel(api);
    await act(async () => {
      fireEvent.change(box(), { target: { value: 'x * (2' } });
      await new Promise((r) => setTimeout(r, 20));
    });
    const error = screen.getByTestId('math-error-math1');
    expect(error.textContent).toContain('expected `)`');
    // The panel says what is still playing, so an error is never a mystery.
    expect(error.textContent).toContain('last expression that compiled');
    expect(box().value).toBe('x * (2');
    expect(box().className).toContain('math-expr-bad');
    expect(screen.queryByTestId('math-hint-math1')).toBeNull();
  });

  it('clears the error once the expression compiles again', async () => {
    const api = makeApi('x * (2', 'expected `)` but found end of expression (column 7)');
    await renderPanel(api);
    expect(screen.getByTestId('math-error-math1')).toBeTruthy();
    await act(async () => {
      fireEvent.change(box(), { target: { value: 'x * 2' } });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByTestId('math-error-math1')).toBeNull();
    expect(box().className).not.toContain('math-expr-bad');
  });

  it('survives a status read that races the module being removed', async () => {
    const api = makeApi();
    api.status.mockResolvedValue(null);
    await renderPanel(api);
    expect(box().value).toBe('');
    expect(screen.queryByTestId('math-error-math1')).toBeNull();
  });

  it('does not reach the engine after the panel is unmounted', async () => {
    vi.useFakeTimers();
    try {
      const api = makeApi();
      const { unmount } = render(<MathPanel instance="math1" api={api} debounceMs={50} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      fireEvent.change(box(), { target: { value: 'x + 1' } });
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(api.setExpr).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
