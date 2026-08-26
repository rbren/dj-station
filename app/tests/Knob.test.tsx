// Knob behavior: data-driven mapping (style/endpoints/curve), drag-to-set
// position, style-dependent rendering (dial / toggle / plain wire jack),
// right-click config editing, attenuverter+offset in the menu when wired.

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Knob, LiveOverrideKnob, mapPosition } from '../src/components/Knob';
import type { JackTelemetry, KnobConfig } from '../src/types';

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

  it('config menu Value field sets the exact knob value', () => {
    const onPosition = vi.fn();
    const onRelease = vi.fn();
    render(
      <Knob
        label="freq"
        config={{ style: 'continuous', min: 20, max: 2000, curve: 'exp' }}
        position={0.5}
        onPosition={onPosition}
        onRelease={onRelease}
        onConfigChange={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'freq' }));
    const field = screen.getByLabelText('knob value') as HTMLInputElement;
    // Shows the current mapped value (geometric midpoint of 20..2000).
    expect(Number(field.value)).toBeCloseTo(200, 1);
    fireEvent.change(field, { target: { value: '440' } });
    expect(onPosition).toHaveBeenCalledTimes(1);
    const cfg: KnobConfig = { style: 'continuous', min: 20, max: 2000, curve: 'exp' };
    expect(mapPosition(cfg, onPosition.mock.lastCall![0])).toBeCloseTo(440, 2);
    // Enter commits the edit gesture and closes the menu.
    expect(onRelease).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('knob value')).toBeNull();
  });

  it('config menu Value shows the unit and accepts input in display units', () => {
    // The oscillator pitch case: a ±5 V volt-per-octave knob displayed in
    // Hz. Typing 440 must land the knob at the position whose raw value
    // is log2(440/261.626), not at "440 volts".
    const onPosition = vi.fn();
    render(
      <Knob
        label="pitch"
        config={{ style: 'continuous', min: -5, max: 5, curve: 'linear' }}
        display={{ unit: 'Hz', map: { kind: 'volt_per_octave' } }}
        position={0.5}
        onPosition={onPosition}
        onConfigChange={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'pitch' }));
    expect(screen.getByText(/Value \(Hz\)/)).toBeTruthy();
    const field = screen.getByLabelText('knob value') as HTMLInputElement;
    // Center position = 0 V = the v/oct base frequency (middle C).
    expect(Number(field.value)).toBeCloseTo(261.626, 2);
    fireEvent.change(field, { target: { value: '440' } });
    const cfg: KnobConfig = { style: 'continuous', min: -5, max: 5, curve: 'linear' };
    const raw = mapPosition(cfg, onPosition.mock.lastCall![0]);
    expect(261.626 * Math.pow(2, raw)).toBeCloseTo(440, 1);
  });

  it('config menu shows a note picker for Hz knobs that sets the frequency', () => {
    const onPosition = vi.fn();
    const onRelease = vi.fn();
    render(
      <Knob
        label="pitch"
        config={{ style: 'continuous', min: -5, max: 5, curve: 'linear' }}
        display={{ unit: 'Hz', map: { kind: 'volt_per_octave' } }}
        position={0.5}
        onPosition={onPosition}
        onRelease={onRelease}
        onConfigChange={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'pitch' }));
    const picker = screen.getByLabelText('knob note') as HTMLSelectElement;
    // 0 V is middle C in the default v/oct map.
    expect(picker.value).toBe('C4');
    fireEvent.change(picker, { target: { value: 'A4' } });
    const cfg: KnobConfig = { style: 'continuous', min: -5, max: 5, curve: 'linear' };
    const raw = mapPosition(cfg, onPosition.mock.lastCall![0]);
    expect(261.626 * Math.pow(2, raw)).toBeCloseTo(440, 1);
    expect(onRelease).toHaveBeenCalledTimes(1);
    // Note options stay within the knob's reachable range (±5 V ≈ C-1..C9,
    // clamped to the table's C0..B8).
    const names = Array.from(picker.options).map((o) => o.value);
    expect(names).toContain('C0');
    expect(names).toContain('B8');
    expect(names).not.toContain('C9');
  });

  it('non-Hz knobs get a plain Volts unit and no note picker', () => {
    render(
      <Knob
        label="cv"
        config={LINEAR}
        position={0.5}
        onPosition={() => {}}
        onConfigChange={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'cv' }));
    expect(screen.getByText(/Value \(V\)/)).toBeTruthy();
    expect(screen.queryByLabelText('knob note')).toBeNull();
  });

  it('config menu Value field ignores unparseable input', () => {
    const onPosition = vi.fn();
    render(
      <Knob
        label="cv"
        config={LINEAR}
        position={0.5}
        onPosition={onPosition}
        onConfigChange={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'cv' }));
    fireEvent.change(screen.getByLabelText('knob value'), { target: { value: '' } });
    expect(onPosition).not.toHaveBeenCalled();
  });

  it('config menu auto-focuses and selects the Value field on open', () => {
    render(
      <Knob
        label="cv"
        config={LINEAR}
        position={0.5}
        onPosition={() => {}}
        onConfigChange={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'cv' }));
    const field = screen.getByLabelText('knob value') as HTMLInputElement;
    expect(document.activeElement).toBe(field);
  });

  it('config menu Value field keeps the typed text while editing', () => {
    const onPosition = vi.fn();
    render(
      <Knob
        label="cv"
        config={LINEAR}
        position={0.5}
        onPosition={onPosition}
        onConfigChange={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'cv' }));
    const field = screen.getByLabelText('knob value') as HTMLInputElement;
    // Clearing the field must stick (not snap back to the knob value) so
    // the user can retype from empty; the knob itself is untouched.
    fireEvent.change(field, { target: { value: '' } });
    expect(field.value).toBe('');
    expect(onPosition).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: '0' } });
    expect(field.value).toBe('0');
    expect(onPosition).toHaveBeenCalledTimes(1);
    expect(onPosition.mock.lastCall![0]).toBeCloseTo(0);
    // Blur drops the draft and shows the knob-derived value again.
    fireEvent.blur(field);
    expect(field.value).toBe('5');
  });

  it('config menu on a wire-style input has no Value field', () => {
    render(
      <Knob
        label="gate"
        config={{ ...LINEAR, style: 'wire' }}
        position={0}
        onPosition={() => {}}
        onConfigChange={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId('knob-gate'));
    expect(screen.getByLabelText('knob style')).toBeTruthy();
    expect(screen.queryByLabelText('knob value')).toBeNull();
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
    // Baseline 5, atten 0.4 => the wire swings ±2 (±0.2 of the travel on
    // this linear 0..10 knob).
    expect((screen.getByLabelText('wire spread min') as HTMLInputElement).value).toBe('3');
    expect((screen.getByLabelText('wire spread max') as HTMLInputElement).value).toBe('7');
    // Widening the top end to 10 gives a 3..10 spread: atten 0.7 and a
    // position-space offset of +0.15 (centre 6.5 = baseline 5 + 1.5 V).
    fireEvent.change(screen.getByLabelText('wire spread max'), { target: { value: '10' } });
    const [atten, offset] = onAttenOffset.mock.lastCall!;
    expect(atten).toBeCloseTo(0.7, 5);
    expect(offset).toBeCloseTo(0.15, 5);
  });

  it('override wire mode: no spread arc, inert-knob tooltip, dimmed dial', () => {
    render(
      <Knob
        label="pitch"
        config={LINEAR}
        position={0.5}
        onPosition={() => {}}
        onAttenOffset={() => {}}
        wired={true}
        wireStyle="override"
        atten={0.4}
        offset={0}
      />,
    );
    expect(screen.queryByTestId('knob-spread-pitch')).toBeNull();
    const dial = screen.getByRole('slider', { name: 'pitch' });
    expect(dial.getAttribute('data-tip')).toBe('pitch: wire sets value');
    expect(dial.className).toContain('knob-dial-overridden');
  });

  it('override wire mode: cmd-drag no longer targets the wire amount', () => {
    const onPosition = vi.fn();
    const onAttenOffset = vi.fn();
    render(
      <Knob
        label="pitch"
        config={LINEAR}
        position={0.5}
        onPosition={onPosition}
        onAttenOffset={onAttenOffset}
        wired={true}
        wireStyle="override"
        atten={0.2}
        offset={0}
      />,
    );
    fireEvent.mouseDown(screen.getByRole('slider', { name: 'pitch' }), {
      clientY: 100,
      metaKey: true,
    });
    fireEvent.mouseMove(window, { clientY: 70 });
    fireEvent.mouseUp(window);
    expect(onAttenOffset).not.toHaveBeenCalled();
    expect(onPosition).toHaveBeenCalled();
  });

  it('wired: menu offers the wire mode selector and reports changes', () => {
    const onWireStyle = vi.fn();
    render(
      <Knob
        label="pitch"
        config={LINEAR}
        position={0.5}
        onPosition={() => {}}
        onConfigChange={() => {}}
        onAttenOffset={() => {}}
        onWireStyle={onWireStyle}
        wired={true}
        wireStyle="cv"
      />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'pitch' }));
    const select = screen.getByLabelText('wire mode') as HTMLSelectElement;
    expect(select.value).toBe('cv');
    fireEvent.change(select, { target: { value: 'override' } });
    expect(onWireStyle).toHaveBeenCalledWith('override');
  });

  it('override wire mode: menu hides the (inert) wire spread fields', () => {
    render(
      <Knob
        label="pitch"
        config={LINEAR}
        position={0.5}
        onPosition={() => {}}
        onConfigChange={() => {}}
        onAttenOffset={() => {}}
        onWireStyle={() => {}}
        wired={true}
        wireStyle="override"
      />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'pitch' }));
    expect((screen.getByLabelText('wire mode') as HTMLSelectElement).value).toBe('override');
    expect(screen.queryByLabelText('wire spread min')).toBeNull();
  });

  it('unwired: menu has no wire mode selector', () => {
    render(
      <Knob
        label="pitch"
        config={LINEAR}
        position={0}
        onPosition={() => {}}
        onConfigChange={() => {}}
        onWireStyle={() => {}}
        wired={false}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'pitch' }));
    expect(screen.queryByLabelText('wire mode')).toBeNull();
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

// An input in wire-override mode takes its value from the signal, not the
// knob — so the control has to MOVE with the signal instead of sitting on
// an inert baseline (dials and mixer-style level faders alike).
describe('LiveOverrideKnob', () => {
  const tele = (display: number): JackTelemetry => ({
    instantaneous: display,
    rms_100ms: 0,
    display,
    volatility: 0,
    is_fast: false,
  });

  const overrideProps = {
    instance: 'vco1',
    jack: 'pitch',
    label: 'pitch',
    config: LINEAR,
    wired: true,
    wireStyle: 'override' as const,
  };

  it('renders the dial at the live value, not at the knob baseline', () => {
    render(
      <LiveOverrideKnob
        {...overrideProps}
        position={0.2}
        onPosition={() => {}}
        telemetry={tele(7.5)}
      />,
    );
    const dial = screen.getByRole('slider', { name: 'pitch' });
    expect(Number(dial.getAttribute('aria-valuenow'))).toBeCloseTo(7.5, 5);
    // 7.5 V of a 0..10 knob = position 0.75 = -135 + 270 * 0.75 degrees.
    const pointer = dial.querySelector('.knob-pointer') as HTMLElement;
    expect(parseFloat(/rotate\((-?[\d.]+)deg\)/.exec(pointer.style.transform)![1])).toBeCloseTo(
      67.5,
      3,
    );
  });

  it('moves the mixer level fader cap with the wire', () => {
    const { rerender } = render(
      <LiveOverrideKnob
        {...overrideProps}
        jack="lvl1"
        label="lvl1"
        appearance="fader"
        position={0}
        onPosition={() => {}}
        telemetry={tele(2)}
      />,
    );
    const capPct = () =>
      parseFloat((document.querySelector('.fader-cap') as HTMLElement).style.bottom);
    expect(capPct()).toBeCloseTo(20, 3);
    rerender(
      <LiveOverrideKnob
        {...overrideProps}
        jack="lvl1"
        label="lvl1"
        appearance="fader"
        position={0}
        onPosition={() => {}}
        telemetry={tele(8)}
      />,
    );
    expect(capPct()).toBeCloseTo(80, 3);
  });

  it('falls back to the baseline while the jack has no reading yet', () => {
    render(<LiveOverrideKnob {...overrideProps} position={0.4} onPosition={() => {}} />);
    expect(
      Number(screen.getByRole('slider', { name: 'pitch' }).getAttribute('aria-valuenow')),
    ).toBeCloseTo(4, 5);
  });

  it('drags still move the (inert) baseline, not the displayed value', () => {
    const onPosition = vi.fn();
    render(
      <LiveOverrideKnob
        {...overrideProps}
        position={0.2}
        onPosition={onPosition}
        telemetry={tele(7.5)}
      />,
    );
    const dial = screen.getByRole('slider', { name: 'pitch' });
    fireEvent.mouseDown(dial, { clientY: 100 });
    fireEvent.mouseMove(window, { clientY: 70 }); // -30px => +0.2
    fireEvent.mouseUp(window);
    expect(onPosition.mock.lastCall![0]).toBeCloseTo(0.4, 5);
  });
});
