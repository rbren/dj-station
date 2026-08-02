// Waveform view: overview + zoom strips, playhead position, cue markers,
// loop region, click-to-seek.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WaveformView } from '../src/components/WaveformView';

const PEAKS = Array.from({ length: 100 }, (_, i) => (i % 10) / 10);

const baseProps = {
  peaks: PEAKS,
  durationSecs: 100,
  positionSecs: 25,
};

describe('WaveformView', () => {
  it('renders an overview and a zoomed strip with peak paths', () => {
    render(<WaveformView {...baseProps} />);
    const overview = screen.getByTestId('waveform-overview');
    const zoom = screen.getByTestId('waveform-zoom');
    expect(overview.querySelector('.waveform-peaks')?.getAttribute('d')).toBeTruthy();
    expect(zoom.querySelector('.waveform-peaks')?.getAttribute('d')).toBeTruthy();
  });

  it('places the playhead proportionally in the overview', () => {
    render(<WaveformView {...baseProps} />);
    const playhead = screen.getByTestId('waveform-overview-playhead');
    // 25 s of 100 s over a 1000-unit viewBox -> x = 250.
    expect(Number(playhead.getAttribute('x1'))).toBeCloseTo(250, 5);
  });

  it('draws markers for set cues only', () => {
    render(<WaveformView {...baseProps} cues={[10, null, 50]} />);
    expect(screen.getByTestId('waveform-overview-cue-1').getAttribute('x1')).toBe('100');
    expect(screen.queryByTestId('waveform-overview-cue-2')).toBeNull();
    expect(screen.getByTestId('waveform-overview-cue-3').getAttribute('x1')).toBe('500');
  });

  it('shades the loop region and marks it enabled', () => {
    render(<WaveformView {...baseProps} loopStartSecs={20} loopEndSecs={40} loopEnabled={true} />);
    const loop = screen.getByTestId('waveform-overview-loop');
    expect(Number(loop.getAttribute('x'))).toBeCloseTo(200, 5);
    expect(Number(loop.getAttribute('width'))).toBeCloseTo(200, 5);
    expect(loop.classList.contains('enabled')).toBe(true);
  });

  it('click on the overview seeks to the clicked track position', () => {
    const onSeek = vi.fn();
    render(<WaveformView {...baseProps} onSeek={onSeek} />);
    const overview = screen.getByTestId('waveform-overview');
    overview.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 500, height: 52, right: 500, bottom: 52 }) as DOMRect;
    fireEvent.click(overview, { clientX: 125 });
    expect(onSeek).toHaveBeenCalledTimes(1);
    // 125/500 of a 100 s track = 25 s.
    expect(onSeek.mock.calls[0][0]).toBeCloseTo(25, 5);
  });

  it('zoom strip window is centered on the playhead', () => {
    // 100 s track, 8 s window centered at 25 s -> [21, 29]; playhead in
    // the middle of the zoom viewBox.
    render(<WaveformView {...baseProps} />);
    const playhead = screen.getByTestId('waveform-zoom-playhead');
    expect(Number(playhead.getAttribute('x1'))).toBeCloseTo(500, 5);
  });
});
