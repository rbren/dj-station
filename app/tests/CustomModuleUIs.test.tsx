// Custom state UIs added in the panel makeover: the trig_seq step grid
// (interactive, writes pattern bitmasks through the handle), the euclid
// pattern rings, the LFO shape preview, and the waveshaper transfer
// curve (display-only, reading module state through the handle).

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import EuclidUI from '../../extensions/euclid/ui-src/EuclidUI';
import LfoUI from '../../extensions/lfo/ui-src/LfoUI';
import TrigSeqUI from '../../extensions/trig_seq/ui-src/TrigSeqUI';
import WaveshaperUI from '../../extensions/waveshaper/ui-src/WaveshaperUI';

function handleWith(values: Record<string, number>) {
  return {
    paramValue: (id: string) => values[id] ?? 0,
    setParam: vi.fn((id: string, v: number) => {
      values[id] = v;
    }),
    endEdit: vi.fn(),
  };
}

describe('TrigSeqUI', () => {
  it('renders an 8x16 grid reflecting the pattern bitmasks', () => {
    // pat1 = 0b101 -> steps 1 and 3 on.
    const handle = handleWith({ pat1: 5, len1: 16, len2: 16 });
    render(<TrigSeqUI handle={handle} />);
    expect(screen.getByTestId('trigseq-cell-1-1').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('trigseq-cell-1-2').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('trigseq-cell-1-3').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('trigseq-cell-8-16')).toBeTruthy();
  });

  it('clicking a cell toggles that bit via setParam and ends the edit', () => {
    const handle = handleWith({ pat2: 0 });
    render(<TrigSeqUI handle={handle} />);
    fireEvent.click(screen.getByTestId('trigseq-cell-2-4'));
    expect(handle.setParam).toHaveBeenCalledWith('pat2', 8); // bit 3
    expect(handle.endEdit).toHaveBeenCalled();
    // Toggling again clears the bit.
    fireEvent.click(screen.getByTestId('trigseq-cell-2-4'));
    expect(handle.setParam).toHaveBeenLastCalledWith('pat2', 0);
  });

  it('dims steps beyond the track length', () => {
    const handle = handleWith({ len1: 4 });
    render(<TrigSeqUI handle={handle} />);
    expect(screen.getByTestId('trigseq-cell-1-4').className).not.toContain('beyond');
    expect(screen.getByTestId('trigseq-cell-1-5').className).toContain('beyond');
  });
});

describe('EuclidUI', () => {
  it('renders four rings with fill/steps counts', () => {
    const handle = handleWith({
      steps1: 16,
      fill1: 4,
      rot1: 0,
      steps2: 16,
      fill2: 7,
      rot2: 0,
      steps3: 8,
      fill3: 3,
      rot3: 0,
      steps4: 12,
      fill4: 5,
      rot4: 0,
    });
    render(<EuclidUI handle={handle} />);
    for (let c = 1; c <= 4; c++) {
      expect(screen.getByTestId(`euclid-ring-${c}`)).toBeTruthy();
    }
    expect(screen.getByText('4/16')).toBeTruthy();
    expect(screen.getByText('3/8')).toBeTruthy();
  });

  it('marks the euclidean onsets on the ring', () => {
    const handle = handleWith({ steps1: 8, fill1: 3, rot1: 0 });
    const { container } = render(<EuclidUI handle={handle} />);
    const ring = container.querySelector('[data-testid="euclid-ring-1"]')!;
    const on = ring.querySelectorAll('.euclid-dot.on');
    expect(on).toHaveLength(3);
  });
});

describe('LfoUI', () => {
  it('shows the selected shape name and rate', () => {
    const handle = handleWith({ shape: 1, rate: 2, pw: 0.5 });
    render(<LfoUI handle={handle} />);
    expect(screen.getByTestId('lfo-readout').textContent).toContain('tri');
    expect(screen.getByTestId('lfo-readout').textContent).toContain('2.00 Hz');
  });

  it('draws a waveform polyline', () => {
    const handle = handleWith({ shape: 0, rate: 1, pw: 0.5 });
    const { container } = render(<LfoUI handle={handle} />);
    const poly = container.querySelector('.lfo-wave');
    expect(poly?.getAttribute('points')?.split(' ').length).toBeGreaterThan(50);
  });
});

describe('WaveshaperUI', () => {
  it('shows the mode name and draws the transfer curve', () => {
    const handle = handleWith({ mode: 1, drive: 3, bias: 0, level: 1 });
    const { container } = render(<WaveshaperUI handle={handle} />);
    expect(screen.getByTestId('shaper-mode').textContent).toBe('saturate');
    expect(container.querySelector('.shaper-curve')).toBeTruthy();
  });
});
