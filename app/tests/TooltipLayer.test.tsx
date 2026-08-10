// The global tooltip layer: hovering any element with data-tip shows a
// styled tooltip after a delay, live-updates its text, and hides again on
// mouse-out / mousedown.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipLayer } from '../src/components/TooltipLayer';

function Fixture({ tip }: { tip: string }) {
  return (
    <>
      <TooltipLayer />
      <button data-tip={tip} data-testid="target">
        hover me
      </button>
      <button data-testid="plain">no tip</button>
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TooltipLayer', () => {
  it('shows the tooltip after the hover delay and hides on mouse-out', () => {
    render(<Fixture tip="cv: 5.00" />);
    fireEvent.mouseOver(screen.getByTestId('target'));
    expect(screen.queryByTestId('tooltip')).toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByTestId('tooltip').textContent).toBe('cv: 5.00');

    fireEvent.mouseOver(screen.getByTestId('plain'));
    expect(screen.queryByTestId('tooltip')).toBeNull();
  });

  it('live-updates the text while visible', () => {
    render(<Fixture tip="cv: 5.00" />);
    const target = screen.getByTestId('target');
    fireEvent.mouseOver(target);
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByTestId('tooltip').textContent).toBe('cv: 5.00');

    target.setAttribute('data-tip', 'cv: 7.25');
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByTestId('tooltip').textContent).toBe('cv: 7.25');
  });

  it('hides on mousedown so it never sits over a menu or drag', () => {
    render(<Fixture tip="hello" />);
    fireEvent.mouseOver(screen.getByTestId('target'));
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByTestId('tooltip')).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId('target'));
    expect(screen.queryByTestId('tooltip')).toBeNull();
  });
});
