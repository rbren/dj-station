// Mixer mute/solo controls: the shipped manifest declares one switch jack
// per channel for each, and the channel-strip layout renders them as
// toggles under the fader (console order: fader, mute, solo). The solo law
// itself lives in the DSP (extensions/mixer/src/lib.rs); here we pin the
// controls the panel exposes and the knob positions clicking them writes.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import mixerJson from '../../extensions/mixer/manifest.json';
import { ModulePanel } from '../src/components/ModulePanel';
import { resolveLayout } from '../src/components/panelLayouts';
import type { KnobState, Manifest, ModuleHandle } from '../src/types';

const MIXER = mixerJson as unknown as Manifest;
const CHANNELS = [1, 2, 3, 4, 5, 6];

const HANDLE: ModuleHandle = {
  paramValue: () => 0,
  setParam: () => {},
  signalTap: () => ({ instantaneous: 0, rms_100ms: 0, display: 0, volatility: 0, is_fast: false }),
  size: { w: 300, h: 150 },
};

function panel(knobs: Record<string, KnobState> = {}, onKnobPosition = vi.fn()) {
  render(
    <ModulePanel
      instanceId="mix1"
      manifest={MIXER}
      knobs={knobs}
      wired={{}}
      handle={HANDLE}
      onKnobPosition={onKnobPosition}
      onKnobConfig={() => {}}
      onAttenOffset={() => {}}
    />,
  );
  return onKnobPosition;
}

const knob = (position: number): KnobState => ({ position, atten: 1, offset: 0 });

describe('mixer mute/solo manifest', () => {
  it('declares a mute and a solo switch for every channel, off by default', () => {
    for (const ch of CHANNELS) {
      for (const id of [`mute${ch}`, `solo${ch}`]) {
        const decl = MIXER.inputs.find((i) => i.id === id);
        expect(decl, `${id} missing from the mixer manifest`).toBeTruthy();
        expect(decl?.knob?.style).toBe('switch');
        expect(decl?.default ?? 0).toBe(0);
      }
    }
  });

  it('puts mute and solo under the fader in each channel strip', () => {
    const layout = resolveLayout(MIXER);
    for (const ch of CHANNELS) {
      const strip = layout.groups.find((g) => g.title === String(ch));
      expect(strip?.cells.map((c) => c.jack)).toEqual([
        `in${ch}_l`,
        `in${ch}_r`,
        `pan${ch}`,
        `lvl${ch}`,
        `mute${ch}`,
        `solo${ch}`,
      ]);
    }
  });
});

describe('mixer mute/solo panel controls', () => {
  it('renders every mute and solo as a two-state toggle', () => {
    panel();
    for (const ch of CHANNELS) {
      for (const id of [`mute${ch}`, `solo${ch}`]) {
        const toggle = screen.getByRole('switch', { name: id });
        expect(toggle.getAttribute('aria-checked')).toBe('false');
      }
    }
  });

  it('clicking a mute switches its jack on, clicking again switches it off', () => {
    const onKnobPosition = panel();
    fireEvent.click(screen.getByRole('switch', { name: 'mute2' }));
    expect(onKnobPosition).toHaveBeenCalledWith('mute2', 1);

    onKnobPosition.mockClear();
    panel({ mute2: knob(1) }, onKnobPosition);
    const [on] = screen.getAllByRole('switch', { name: 'mute2' }).slice(-1);
    expect(on.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(on);
    expect(onKnobPosition).toHaveBeenCalledWith('mute2', 0);
  });

  it('solo is a per-channel switch, independent of that channel mute', () => {
    const onKnobPosition = panel({ mute3: knob(1) });
    expect(screen.getByRole('switch', { name: 'mute3' }).getAttribute('aria-checked')).toBe('true');
    const solo = screen.getByRole('switch', { name: 'solo3' });
    expect(solo.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(solo);
    expect(onKnobPosition).toHaveBeenCalledWith('solo3', 1);
    expect(onKnobPosition).not.toHaveBeenCalledWith('mute3', expect.anything());
  });
});
