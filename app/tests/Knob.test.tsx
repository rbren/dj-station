// Knob behavior: data-driven mapping (style/endpoints/curve), drag-to-set
// position, style-dependent rendering (dial / toggle / plain wire jack),
// right-click config editing, attenuverter+offset in the menu when wired.

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
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

  it('fires onRelease once when a drag gesture ends', () => {
    const onRelease = vi.fn();
    render(
      <Knob
        label="cv"
        config={LINEAR}
        position={0.5}
        onPosition={() => {}}
        onRelease={onRelease}
      />,
    );
    const dial = screen.getByRole('slider', { name: 'cv' });
    fireEvent.mouseDown(dial, { clientY: 100 });
    fireEvent.mouseMove(window, { clientY: 50 });
    expect(onRelease).not.toHaveBeenCalled();
    fireEvent.mouseUp(window);
    expect(onRelease).toHaveBeenCalledTimes(1);
    // Stray mouseups without a drag don't re-fire.
    fireEvent.mouseUp(window);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('double-click resets to the default and ends the edit gesture', () => {
    const onReset = vi.fn();
    const onRelease = vi.fn();
    render(
      <Knob
        label="cv"
        config={LINEAR}
        position={0.7}
        onPosition={() => {}}
        onReset={onReset}
        onRelease={onRelease}
      />,
    );
    fireEvent.doubleClick(screen.getByRole('slider', { name: 'cv' }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('double-click on a fader also resets', () => {
    const onReset = vi.fn();
    render(
      <Knob
        label="cv"
        config={LINEAR}
        position={0.7}
        onPosition={() => {}}
        onReset={onReset}
        appearance="fader"
      />,
    );
    fireEvent.doubleClick(screen.getByRole('slider', { name: 'cv' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('double-click without onReset is a no-op', () => {
    const onPosition = vi.fn();
    render(<Knob label="cv" config={LINEAR} position={0.7} onPosition={onPosition} />);
    fireEvent.doubleClick(screen.getByRole('slider', { name: 'cv' }));
    expect(onPosition).not.toHaveBeenCalled();
  });

  it('shows the value only in the hover tooltip, not inline', () => {
    render(<Knob label="cv" config={LINEAR} position={0.5} onPosition={() => {}} />);
    const dial = screen.getByRole('slider', { name: 'cv' });
    expect(dial.getAttribute('data-tip')).toBe('cv: 5.00 V');
    expect(screen.queryByText('5.00')).toBeNull();
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

  it('style changes what renders: dial vs toggle vs plain wire jack', () => {
    const { rerender } = render(
      <Knob label="g" config={LINEAR} position={0} onPosition={() => {}} />,
    );
    expect(screen.getByRole('slider', { name: 'g' })).toBeTruthy();

    rerender(
      <Knob label="g" config={{ ...LINEAR, style: 'switch' }} position={0} onPosition={() => {}} />,
    );
    expect(screen.queryByRole('slider', { name: 'g' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'g' })).toBeTruthy();

    rerender(
      <Knob label="g" config={{ ...LINEAR, style: 'wire' }} position={0} onPosition={() => {}} />,
    );
    expect(screen.queryByRole('slider', { name: 'g' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'g' })).toBeNull();
    expect(screen.getByTestId('knob-g').className).toContain('knob-wire');
  });

  it('switch style toggles on click', () => {
    const onPosition = vi.fn();
    render(
      <Knob
        label="gate"
        config={{ ...LINEAR, style: 'switch' }}
        position={0}
        onPosition={onPosition}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'gate' }));
    expect(onPosition).toHaveBeenCalledWith(1);
  });

  it('button style is momentary: on while held, off on release', () => {
    const onPosition = vi.fn();
    const { rerender } = render(
      <Knob
        label="gate"
        config={{ ...LINEAR, style: 'button' }}
        position={0}
        onPosition={onPosition}
      />,
    );
    const btn = screen.getByRole('button', { name: 'gate' });
    fireEvent.mouseDown(btn, { button: 0 });
    expect(onPosition).toHaveBeenLastCalledWith(1);
    fireEvent.mouseUp(btn);
    expect(onPosition).toHaveBeenLastCalledWith(0);
    // clicking alone must NOT toggle it on
    onPosition.mockClear();
    fireEvent.click(btn);
    expect(onPosition).not.toHaveBeenCalledWith(1);
    // releasing by dragging off the button also turns it off
    onPosition.mockClear();
    rerender(
      <Knob
        label="gate"
        config={{ ...LINEAR, style: 'button' }}
        position={1}
        onPosition={onPosition}
      />,
    );
    fireEvent.mouseLeave(screen.getByRole('button', { name: 'gate' }));
    expect(onPosition).toHaveBeenLastCalledWith(0);
  });

  it('wired: the dial stays and drag still sets the baseline', () => {
    const onPosition = vi.fn();
    render(
      <Knob
        label="fm"
        config={LINEAR}
        position={0.5}
        onPosition={onPosition}
        onAttenOffset={() => {}}
        wired={true}
        atten={0.4}
        offset={0}
      />,
    );
    const dial = screen.getByRole('slider', { name: 'fm' });
    fireEvent.mouseDown(dial, { clientY: 100 });
    fireEvent.mouseMove(window, { clientY: 70 }); // +0.2
    fireEvent.mouseUp(window);
    expect(onPosition.mock.lastCall![0]).toBeCloseTo(0.7, 5);
    // The spread arc shows how far the wire can push the value.
    expect(screen.getByTestId('knob-spread-fm')).toBeTruthy();
    expect(dial.getAttribute('data-tip')).toBe('fm: 5.00 V (wire 3.00 V…7.00 V)');
  });

  it('wired: cmd-drag sets the wire amount instead of the baseline', () => {
    const onPosition = vi.fn();
    const onAttenOffset = vi.fn();
    render(
      <Knob
        label="fm"
        config={LINEAR}
        position={0.5}
        onPosition={onPosition}
        onAttenOffset={onAttenOffset}
        wired={true}
        atten={0.2}
        offset={0}
      />,
    );
    const dial = screen.getByRole('slider', { name: 'fm' });
    fireEvent.mouseDown(dial, { clientY: 100, metaKey: true });
    fireEvent.mouseMove(window, { clientY: 70 }); // +0.2
    fireEvent.mouseUp(window);
    expect(onPosition).not.toHaveBeenCalled();
    expect(onAttenOffset.mock.lastCall![0]).toBeCloseTo(0.4, 5);
  });

  it('wired: spread arc color flips live as a cmd-drag overscrolls past zero', () => {
    // Controlled wrapper so the atten from the drag feeds straight back in,
    // like the real rack does.
    function Wired() {
      const [atten, setAtten] = useState(0.2);
      return (
        <Knob
          label="fm"
          config={LINEAR}
          position={0.5}
          onPosition={() => {}}
          onAttenOffset={(a) => setAtten(a)}
          wired={true}
          atten={atten}
          offset={0}
        />
      );
    }
    render(<Wired />);
    const arc = () => screen.getByTestId('knob-spread-fm');
    // Positive atten: the normal (teal) styling, no reversed marker.
    expect(arc().getAttribute('class')).toBeNull();
    fireEvent.mouseDown(screen.getByRole('slider', { name: 'fm' }), {
      clientY: 100,
      metaKey: true,
    });
    // Drag down past zero (-0.4 delta => atten -0.2): reversed (orange).
    fireEvent.mouseMove(window, { clientY: 160 });
    expect(arc().getAttribute('class')).toBe('knob-spread-reversed');
    // Back above zero mid-drag: normal color returns live.
    fireEvent.mouseMove(window, { clientY: 85 });
    expect(arc().getAttribute('class')).toBeNull();
    fireEvent.mouseUp(window);
  });

  it('unwired: no spread arc, plain value tooltip', () => {
    render(<Knob label="fm" config={LINEAR} position={0.5} onPosition={() => {}} />);
    expect(screen.queryByTestId('knob-spread-fm')).toBeNull();
    expect(screen.getByRole('slider', { name: 'fm' }).getAttribute('data-tip')).toBe('fm: 5.00 V');
  });

  it('wired: spread min/max are editable in the right-click menu', () => {
    const onAttenOffset = vi.fn();
    render(
      <Knob
        label="fm"
        config={LINEAR}
        position={0.5}
        onPosition={() => {}}
        onConfigChange={() => {}}
        onAttenOffset={onAttenOffset}
        wired={true}
        atten={0.4}
        offset={0}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'fm' }));
    // Baseline 5, atten 0.4 => the wire swings ±2.
    expect((screen.getByLabelText('wire spread min') as HTMLInputElement).value).toBe('3');
    expect((screen.getByLabelText('wire spread max') as HTMLInputElement).value).toBe('7');
    // Widening the top end to 10 gives a 3..10 spread: atten 0.7, centre 6.5.
    fireEvent.change(screen.getByLabelText('wire spread max'), { target: { value: '10' } });
    const [atten, offset] = onAttenOffset.mock.lastCall!;
    expect(atten).toBeCloseTo(0.7, 5);
    expect(offset).toBeCloseTo(1.5, 5);
  });

  it('unwired: menu has no wire spread controls', () => {
    render(
      <Knob
        label="fm"
        config={LINEAR}
        position={0}
        onPosition={() => {}}
        onConfigChange={() => {}}
        onAttenOffset={() => {}}
        wired={false}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'fm' }));
    expect(screen.queryByLabelText('wire spread min')).toBeNull();
  });

  it('config menu closes on an outside click', () => {
    render(
      <Knob
        label="fm"
        config={LINEAR}
        position={0}
        onPosition={() => {}}
        onConfigChange={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'fm' }));
    expect(screen.getByRole('dialog', { name: 'Knob configuration' })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Knob configuration' })).toBeNull();
  });

  it('config menu renders outside the panel, anchored at the cursor', () => {
    const { container } = render(
      <Knob
        label="fm"
        config={LINEAR}
        position={0}
        onPosition={() => {}}
        onConfigChange={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'fm' }), {
      clientX: 120,
      clientY: 240,
    });
    const menu = screen.getByRole('dialog', { name: 'Knob configuration' }) as HTMLElement;
    // Portalled to the body, so a clipping module panel can't cut it off.
    expect(container.contains(menu)).toBe(false);
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.left).toBe('120px');
    expect(menu.style.top).toBe('240px');
  });
});
