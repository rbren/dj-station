// The global tooltip layer: hovering any element with data-tip shows a
// styled tooltip after a delay, live-updates its text, and hides again on
// mouse-out. Dragging FROM the anchor keeps the tooltip alive (knob drags
// show live values); mousedowns elsewhere still dismiss it.

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
      <button data-tip="other tip" data-testid="other">
        other anchor
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

  it('hides on mousedown elsewhere so it never sits over a menu', () => {
    render(<Fixture tip="hello" />);
    fireEvent.mouseOver(screen.getByTestId('target'));
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByTestId('tooltip')).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId('plain'));
    expect(screen.queryByTestId('tooltip')).toBeNull();
  });

  it('stays visible and live-updates through a drag started on the anchor', () => {
    render(<Fixture tip="cv: 5.00" />);
    const target = screen.getByTestId('target');
    fireEvent.mouseOver(target);
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByTestId('tooltip')).toBeTruthy();

    // Drag starts on the anchor: the tooltip stays put...
    fireEvent.mouseDown(target);
    expect(screen.getByTestId('tooltip')).toBeTruthy();
    // ...even as the pointer wanders off it mid-drag (knobs capture the
    // pointer and keep reporting via data-tip)...
    fireEvent.mouseOver(screen.getByTestId('plain'));
    fireEvent.mouseMove(window, { clientY: 40 });
    target.setAttribute('data-tip', 'cv: 7.25');
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByTestId('tooltip').textContent).toBe('cv: 7.25');

    // ...and it survives a mouseup back over the same anchor.
    fireEvent.mouseUp(target);
    expect(screen.getByTestId('tooltip').textContent).toBe('cv: 7.25');
  });

  it('hides after a drag when the pointer ends up off the anchor', () => {
    render(<Fixture tip="cv: 5.00" />);
    const target = screen.getByTestId('target');
    fireEvent.mouseOver(target);
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByTestId('tooltip')).toBeTruthy();

    fireEvent.mouseDown(target);
    fireEvent.mouseUp(screen.getByTestId('plain'));
    expect(screen.queryByTestId('tooltip')).toBeNull();
  });

  it('retargets when a drag ends over a different anchor', () => {
    render(<Fixture tip="cv: 5.00" />);
    fireEvent.mouseOver(screen.getByTestId('target'));
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByTestId('tooltip').textContent).toBe('cv: 5.00');

    fireEvent.mouseDown(screen.getByTestId('target'));
    fireEvent.mouseUp(screen.getByTestId('other'));
    // Old tooltip is gone immediately; the new anchor's shows after the
    // usual hover delay.
    expect(screen.queryByTestId('tooltip')).toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByTestId('tooltip').textContent).toBe('other tip');
  });
});
