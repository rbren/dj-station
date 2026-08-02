// Knob behavior: data-driven mapping (style/endpoints/curve), drag-to-set
// position, right-click config editing, attenuverter when wired.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Knob, mapPosition } from '../src/components/Knob';
import type { KnobConfig } from '../src/types';

const LINEAR: KnobConfig = { style: 'continuous', min: 0, max: 10, curve: 'linear' };

describe('mapPosition', () => {
  it('maps linear endpoints', () => {
    expect(mapPosition(LINEAR, 0)).toBe(0);
    expect(mapPosition(LINEAR, 0.5)).toBe(5);
    expect(mapPosition(LINEAR, 1)).toBe(10);
  });

  it('maps exp/log curves', () => {
    expect(mapPosition({ ...LINEAR, curve: 'exp' }, 0.5)).toBeCloseTo(2.5);
    expect(mapPosition({ ...LINEAR, curve: 'log' }, 0.25)).toBeCloseTo(5);
  });

  it('quantizes stepped style', () => {
    const cfg: KnobConfig = { style: 'stepped', min: 0, max: 4, curve: 'linear', steps: 5 };
    expect(mapPosition(cfg, 0.3)).toBe(1);
    expect(mapPosition(cfg, 0.6)).toBe(2);
  });

  it('snaps switch style to endpoints', () => {
    const cfg: KnobConfig = { style: 'switch', min: 0, max: 1, curve: 'linear' };
    expect(mapPosition(cfg, 0.4)).toBe(0);
    expect(mapPosition(cfg, 0.6)).toBe(1);
  });
});

describe('Knob', () => {
  it('drag up increases position', () => {
    const onPosition = vi.fn();
    render(<Knob label="cv" config={LINEAR} position={0.5} onPosition={onPosition} />);
    const dial = screen.getByRole('slider', { name: 'cv' });
    fireEvent.mouseDown(dial, { clientY: 100 });
    fireEvent.mouseMove(window, { clientY: 25 }); // -75px => +0.5
    fireEvent.mouseUp(window);
    expect(onPosition).toHaveBeenCalled();
    expect(onPosition.mock.lastCall![0]).toBeCloseTo(1.0, 5);
  });

  it('right-click opens config menu and edits are reported', () => {
    const onConfigChange = vi.fn();
    render(
      <Knob
        label="pitch"
        config={{ style: 'continuous', min: -5, max: 5, curve: 'linear' }}
        position={0.5}
        onPosition={() => {}}
        onConfigChange={onConfigChange}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'pitch' }));
    fireEvent.change(screen.getByLabelText('knob style'), { target: { value: 'stepped' } });
    expect(onConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({ style: 'stepped', min: -5, max: 5 }),
    );
    fireEvent.change(screen.getByLabelText('knob max'), { target: { value: '8' } });
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ max: 8 }));
    fireEvent.change(screen.getByLabelText('knob curve'), { target: { value: 'exp' } });
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ curve: 'exp' }));
  });

  it('shows attenuverter + offset controls only when wired', () => {
    const onAttenOffset = vi.fn();
    const { rerender } = render(
      <Knob
        label="fm"
        config={LINEAR}
        position={0}
        onPosition={() => {}}
        onAttenOffset={onAttenOffset}
        wired={false}
      />,
    );
    expect(screen.queryByTestId('atten-fm')).toBeNull();
    rerender(
      <Knob
        label="fm"
        config={LINEAR}
        position={0}
        onPosition={() => {}}
        onAttenOffset={onAttenOffset}
        wired={true}
        atten={1}
        offset={0}
      />,
    );
    fireEvent.change(screen.getByLabelText('fm attenuverter'), { target: { value: '-0.5' } });
    expect(onAttenOffset).toHaveBeenCalledWith(-0.5, 0);
    fireEvent.change(screen.getByLabelText('fm offset'), { target: { value: '2' } });
    expect(onAttenOffset).toHaveBeenCalledWith(1, 2);
  });
});
