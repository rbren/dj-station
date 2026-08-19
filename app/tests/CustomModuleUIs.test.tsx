// Custom state UIs added in the panel makeover: the trig_seq step grid
// (interactive, writes pattern bitmasks through the handle), the euclid
// pattern rings, the LFO shape preview, and the waveshaper transfer
// curve (display-only, reading module state through the handle). Plus the
// telemetry-driven additions: sequencer playheads (step_seq/trig_seq/
// euclid/turing via `out:` signal taps), the shared level meters (VCA,
// compressor GR) and the quantizer scale keyboard.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import EqUI from '../../extensions/eq/ui-src/EqUI';
import EuclidUI from '../../extensions/euclid/ui-src/EuclidUI';
import GridSeqUI from '../../extensions/grid_seq/ui-src/GridSeqUI';
import LfoUI from '../../extensions/lfo/ui-src/LfoUI';
import QuantizerUI from '../../extensions/quantizer/ui-src/QuantizerUI';
import SeqSwitchUI from '../../extensions/seq_switch/ui-src/SeqSwitchUI';
import StepSeqUI from '../../extensions/step_seq/ui-src/StepSeqUI';
import TrigSeqUI from '../../extensions/trig_seq/ui-src/TrigSeqUI';
import TuringUI from '../../extensions/turing/ui-src/TuringUI';
import WaveshaperUI from '../../extensions/waveshaper/ui-src/WaveshaperUI';
import { CompressorUI, VcaUI } from '../src/components/LevelMeter';
import type { ModuleHandle } from '../src/types';

function handleWith(values: Record<string, number>, taps: Record<string, number> = {}) {
  return {
    paramValue: (id: string) => values[id] ?? 0,
    setParam: vi.fn((id: string, v: number) => {
      values[id] = v;
    }),
    signalTap: (jackId: string) => ({
      instantaneous: taps[jackId] ?? 0,
      rms_100ms: taps[jackId] ?? 0,
      display: taps[jackId] ?? 0,
      volatility: 0,
      is_fast: false,
    }),
    endEdit: vi.fn(),
    size: { w: 360, h: 200 },
  } satisfies ModuleHandle;
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

  it('lights each track playhead from the pos output, mod track length', () => {
    // pos = 5 -> track 1 (len 16) on step 6, track 2 (len 4) on step 2.
    const handle = handleWith({ len1: 16, len2: 4 }, { 'out:pos': 5 });
    render(<TrigSeqUI handle={handle} />);
    expect(screen.getByTestId('trigseq-cell-1-6').className).toContain('playing');
    expect(screen.getByTestId('trigseq-cell-1-5').className).not.toContain('playing');
    expect(screen.getByTestId('trigseq-cell-2-2').className).toContain('playing');
  });

  it('shows no playhead before the first clock (pos = -1)', () => {
    const handle = handleWith({ len1: 16 }, { 'out:pos': -1 });
    const { container } = render(<TrigSeqUI handle={handle} />);
    expect(container.querySelector('.trigseq-cell.playing')).toBeNull();
  });
});

describe('GridSeqUI', () => {
  it('renders an 8x16 grid reflecting the row bitmasks', () => {
    // row1 = 0b101 -> columns 1 and 3 on.
    const handle = handleWith({ row1: 5 });
    render(<GridSeqUI handle={handle} />);
    expect(screen.getByTestId('gridseq-cell-1-1').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('gridseq-cell-1-2').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('gridseq-cell-1-3').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('gridseq-cell-8-16')).toBeTruthy();
  });

  it('clicking a cell toggles that bit via setParam and ends the edit', () => {
    const handle = handleWith({ row2: 0 });
    render(<GridSeqUI handle={handle} />);
    fireEvent.click(screen.getByTestId('gridseq-cell-2-4'));
    expect(handle.setParam).toHaveBeenCalledWith('row2', 8); // bit 3
    expect(handle.endEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('gridseq-cell-2-4'));
    expect(handle.setParam).toHaveBeenLastCalledWith('row2', 0);
  });

  it('lights the playhead column from the pos output, mod 16', () => {
    const handle = handleWith({}, { 'out:pos': 17 }); // wraps to column 2
    render(<GridSeqUI handle={handle} />);
    expect(screen.getByTestId('gridseq-cell-1-2').className).toContain('playing');
    expect(screen.getByTestId('gridseq-cell-8-2').className).toContain('playing');
    expect(screen.getByTestId('gridseq-cell-1-1').className).not.toContain('playing');
  });

  it('shows no playhead before the first clock (pos = -1)', () => {
    const handle = handleWith({}, { 'out:pos': -1 });
    const { container } = render(<GridSeqUI handle={handle} />);
    expect(container.querySelector('.trigseq-cell.playing')).toBeNull();
  });

  it('labels rows with scale notes in scale mode', () => {
    const handle = handleWith({ mode: 1 });
    const { container } = render(<GridSeqUI handle={handle} />);
    const labels = [...container.querySelectorAll('.trigseq-track-label')].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C']);
  });
});

describe('StepSeqUI', () => {
  it('lights the current step lamp from the step output', () => {
    const handle = handleWith({ length: 8 }, { 'out:step': 2 });
    render(<StepSeqUI handle={handle} />);
    expect(screen.getByTestId('stepseq-lamp-3').className).toContain('playing');
    expect(screen.getByTestId('stepseq-lamp-1').className).not.toContain('playing');
    // Steps beyond the length are dimmed.
    expect(screen.getByTestId('stepseq-lamp-9').className).toContain('beyond');
  });

  it('shows no playhead before the first clock (step = -1)', () => {
    const handle = handleWith({ length: 16 }, { 'out:step': -1 });
    const { container } = render(<StepSeqUI handle={handle} />);
    expect(container.querySelector('.stepseq-lamp.playing')).toBeNull();
  });
});

describe('SeqSwitchUI', () => {
  it('decodes the current step from the step_cv output', () => {
    // step_cv = (step + 0.5) / steps * 10; step 3 of 8 -> 4.375 V.
    const handle = handleWith({ steps: 8 }, { 'out:step_cv': 4.375 });
    render(<SeqSwitchUI handle={handle} />);
    expect(screen.getByTestId('seqswitch-lamp-4').className).toContain('playing');
    expect(screen.getByTestId('seqswitch-lamp-1').className).not.toContain('playing');
  });

  it('dims lamps beyond the step count', () => {
    const handle = handleWith({ steps: 4 }, { 'out:step_cv': 1.25 });
    render(<SeqSwitchUI handle={handle} />);
    expect(screen.getByTestId('seqswitch-lamp-1').className).toContain('playing');
    expect(screen.getByTestId('seqswitch-lamp-5').className).toContain('beyond');
  });
});

describe('TuringUI', () => {
  it('lights register bit lamps and highlights the head bit', () => {
    // reg = 0b101 -> bits 1 and 3 on; bit 1 is the head.
    const handle = handleWith({ length: 8 }, { 'out:reg': 5 });
    render(<TuringUI handle={handle} />);
    expect(screen.getByTestId('turing-bit-1').className).toContain('on');
    expect(screen.getByTestId('turing-bit-1').className).toContain('playing');
    expect(screen.getByTestId('turing-bit-2').className).not.toContain('on');
    expect(screen.getByTestId('turing-bit-3').className).toContain('on');
    // Bits beyond the loop length are dimmed.
    expect(screen.getByTestId('turing-bit-9').className).toContain('beyond');
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

  it('highlights each ring playhead from its step output, wrapping', () => {
    // step1 = 2 -> ring 1 dot 3; step2 = 5 on a 4-step ring -> dot 2.
    const handle = handleWith(
      { steps1: 8, fill1: 3, steps2: 4, fill2: 1 },
      { 'out:step1': 2, 'out:step2': 5, 'out:step3': -1, 'out:step4': -1 },
    );
    const { container } = render(<EuclidUI handle={handle} />);
    const dots1 = container.querySelectorAll('[data-testid="euclid-ring-1"] .euclid-dot');
    expect(dots1[2].getAttribute('data-playing')).toBe('true');
    const dots2 = container.querySelectorAll('[data-testid="euclid-ring-2"] .euclid-dot');
    expect(dots2[1].getAttribute('data-playing')).toBe('true');
    // -1 (not yet clocked) shows no playhead.
    expect(
      container.querySelectorAll('[data-testid="euclid-ring-3"] .euclid-dot.playing'),
    ).toHaveLength(0);
  });
});

describe('LevelMeter module UIs', () => {
  it('VCA shows CV and output meters with live values', () => {
    const handle = handleWith({}, { cv: 5, 'out:out': 2.5 });
    render(<VcaUI handle={handle} />);
    expect(screen.getByTestId('meter-value-cv').textContent).toBe('5.00 V');
    expect(screen.getByTestId('meter-value-out:out').textContent).toBe('2.50 V');
    const fill = screen.getByTestId('meter-cv').querySelector('.level-meter-fill') as HTMLElement;
    expect(fill.style.width).toBe('50%');
  });

  it('compressor shows gain reduction in dB (0.5 V per dB)', () => {
    const handle = handleWith({}, { 'out:gr': 3 });
    render(<CompressorUI handle={handle} />);
    expect(screen.getByTestId('meter-value-out:gr').textContent).toBe('6.00 dB');
  });
});

describe('QuantizerUI', () => {
  it('shows the preset scale notes on the keyboard, shifted by root', () => {
    // Major rooted at D: D E F# G A B C#.
    const handle = handleWith({ scale: 1, root: 2, custom: 4095 });
    render(<QuantizerUI handle={handle} />);
    const active = [2, 4, 6, 7, 9, 11, 1];
    for (let pc = 0; pc < 12; pc++) {
      expect(screen.getByTestId(`quantizer-key-${pc}`).getAttribute('aria-pressed')).toBe(
        active.includes(pc) ? 'true' : 'false',
      );
    }
    expect(screen.getByTestId('quantizer-scale-name').textContent).toContain('D major');
  });

  it('toggles pitch classes in the custom mask when scale 0 is selected', () => {
    // Custom mask = {0, 4, 7} (C E G), root C.
    const handle = handleWith({ scale: 0, root: 0, custom: 0b10010001 });
    render(<QuantizerUI handle={handle} />);
    expect(screen.getByTestId('quantizer-key-4').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('quantizer-key-4'));
    expect(handle.setParam).toHaveBeenCalledWith('custom', 0b10000001);
    expect(handle.endEdit).toHaveBeenCalled();
    // scale stays 0 — no scale switch needed.
    expect(handle.setParam).not.toHaveBeenCalledWith('scale', 0);
    // Toggling an off key adds it.
    fireEvent.click(screen.getByTestId('quantizer-key-2'));
    expect(handle.setParam).toHaveBeenLastCalledWith('custom', 0b10000101);
  });

  it('clicking a key on a preset forks it into the custom scale', () => {
    // Pentatonic major {0,2,4,7,9} rooted at C; clicking B (11) adds it.
    const handle = handleWith({ scale: 4, root: 0, custom: 4095 });
    render(<QuantizerUI handle={handle} />);
    fireEvent.click(screen.getByTestId('quantizer-key-11'));
    expect(handle.setParam).toHaveBeenCalledWith('scale', 0);
    const penta = (1 << 0) | (1 << 2) | (1 << 4) | (1 << 7) | (1 << 9);
    expect(handle.setParam).toHaveBeenCalledWith('custom', penta | (1 << 11));
    expect(screen.getByTestId('quantizer-scale-name').textContent).toContain('custom');
  });

  it('mask degrees are relative to the root', () => {
    // Custom {0, 7} rooted at D -> keys D and A active.
    const handle = handleWith({ scale: 0, root: 2, custom: 0b10000001 });
    render(<QuantizerUI handle={handle} />);
    expect(screen.getByTestId('quantizer-key-2').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('quantizer-key-9').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('quantizer-key-0').getAttribute('aria-pressed')).toBe('false');
    // Clicking C toggles degree (0 - 2) mod 12 = 10.
    fireEvent.click(screen.getByTestId('quantizer-key-0'));
    expect(handle.setParam).toHaveBeenCalledWith('custom', 0b10000001 | (1 << 10));
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

  it('renders the blink lamp and animates its level', async () => {
    const handle = handleWith({ shape: 0, rate: 1, pw: 0.5 });
    render(<LfoUI handle={handle} />);
    const lamp = screen.getByTestId('lfo-lamp');
    // The rAF loop sets --lfo-level (0..1 brightness) on the lamp.
    await vi.waitFor(() => {
      const level = lamp.style.getPropertyValue('--lfo-level');
      expect(level).not.toBe('');
      expect(Number(level)).toBeGreaterThanOrEqual(0);
      expect(Number(level)).toBeLessThanOrEqual(1);
    });
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

describe('EqUI', () => {
  const eqValues = () => ({
    freq1: -1.4,
    gain1: 0,
    q1: 1,
    freq2: 0.6,
    gain2: 6,
    q2: 2,
    freq3: 2.6,
    gain3: 0,
    q3: 1,
    freq4: 4.6,
    gain4: 0,
    q4: 1,
  });

  it('draws the response curve and four band handles with a readout', () => {
    const { container } = render(<EqUI handle={handleWith(eqValues())} />);
    expect(screen.getByTestId('eq-curve')).toBeTruthy();
    for (let b = 1; b <= 4; b++) expect(screen.getByTestId(`eq-handle-${b}`)).toBeTruthy();
    // Only the active (nonzero-gain) band draws its shadow curve.
    expect(container.querySelectorAll('.eq-band-curve')).toHaveLength(1);
    expect(screen.getByTestId('eq-readout').textContent).toContain('+6.0dB');
  });

  it('dragging a handle writes freq and gain; release is an edit boundary', () => {
    const handle = handleWith(eqValues());
    render(<EqUI handle={handle} />);
    fireEvent.mouseDown(screen.getByTestId('eq-handle-2'), {
      clientX: 100,
      clientY: 60,
      button: 0,
    });
    // Right = higher frequency, up = more gain.
    fireEvent.mouseMove(window, { clientX: 140, clientY: 40 });
    const calls = (handle.setParam as ReturnType<typeof vi.fn>).mock.calls;
    const freq = calls.find(([id]) => id === 'freq2');
    const gain = calls.find(([id]) => id === 'gain2');
    expect(freq).toBeTruthy();
    expect(freq![1]).toBeGreaterThan(0.6);
    expect(gain).toBeTruthy();
    expect(gain![1]).toBeGreaterThan(6);
    expect(handle.endEdit).not.toHaveBeenCalled();
    fireEvent.mouseUp(window);
    expect(handle.endEdit).toHaveBeenCalled();
  });

  it('scrolling over a handle adjusts that band Q within limits', () => {
    const handle = handleWith(eqValues());
    render(<EqUI handle={handle} />);
    // Scroll down = wider (lower Q).
    fireEvent.wheel(screen.getByTestId('eq-handle-2'), { deltaY: 480 });
    const calls = (handle.setParam as ReturnType<typeof vi.fn>).mock.calls;
    const q = calls.find(([id]) => id === 'q2');
    expect(q).toBeTruthy();
    expect(q![1]).toBeCloseTo(1, 3); // 2 * 2^-1
  });
});
