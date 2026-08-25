// Launch Control XL panel: the connection indicator follows the polled
// device status, the Active button hands the (exclusive) surface to this
// module, and the poll behaves like every other panel poll — quiet on a
// removal race, stopped on unmount.
//
// The device layout itself (eight columns of jacks) is manifest-driven
// and covered by PanelLayout/engine tests; this suite is the panel body.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LaunchControlPanel, type LaunchControlApi } from '../src/components/LaunchControlPanel';
import type { LaunchControlStatus } from '../src/engine';

const status = (over: Partial<LaunchControlStatus> = {}): LaunchControlStatus => ({
  connected: false,
  active: false,
  active_instance: null,
  ...over,
});

function makeApi(
  s: LaunchControlStatus,
): LaunchControlApi & { status: ReturnType<typeof vi.fn>; setActive: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn().mockResolvedValue(s),
    setActive: vi.fn().mockResolvedValue(undefined),
  };
}

async function renderPanel(api: LaunchControlApi) {
  render(<LaunchControlPanel instance="lcxl1" api={api} pollMs={100000} />);
  // The initial status poll (a 0 ms timeout) fires and resolves.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}

describe('LaunchControlPanel', () => {
  it('shows a dark indicator and no owner when the controller is absent', async () => {
    await renderPanel(makeApi(status()));
    const led = screen.getByTestId('launchcontrol-led-lcxl1');
    expect(led.getAttribute('data-connected')).toBe('no');
    expect(led.getAttribute('class')).not.toContain('launchcontrol-led-on');
    expect(screen.getByTestId('launchcontrol-status-lcxl1').textContent).toBe('no controller');
    expect(screen.queryByTestId('launchcontrol-owner-lcxl1')).toBeNull();
  });

  it('lights the indicator when the controller is connected', async () => {
    await renderPanel(makeApi(status({ connected: true, active: true, active_instance: 'lcxl1' })));
    const led = screen.getByTestId('launchcontrol-led-lcxl1');
    expect(led.getAttribute('data-connected')).toBe('yes');
    expect(led.getAttribute('class')).toContain('launchcontrol-led-on');
    expect(screen.getByTestId('launchcontrol-status-lcxl1').textContent).toBe(
      'controller connected',
    );
    const button = screen.getByTestId('launchcontrol-active-lcxl1');
    expect(button.textContent).toBe('Active');
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('names the module holding the surface when this one does not', async () => {
    await renderPanel(makeApi(status({ connected: true, active_instance: 'lcxl2' })));
    expect(screen.getByTestId('launchcontrol-active-lcxl1').textContent).toBe('Inactive');
    expect(screen.getByTestId('launchcontrol-owner-lcxl1').textContent).toContain('lcxl2');
  });

  it('takes and releases the controller through the Active button', async () => {
    const api = makeApi(status({ connected: true, active_instance: 'lcxl2' }));
    await renderPanel(api);
    // Taking it: the panel asks for ownership and re-polls.
    api.status.mockResolvedValue(
      status({ connected: true, active: true, active_instance: 'lcxl1' }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('launchcontrol-active-lcxl1'));
    });
    expect(api.setActive).toHaveBeenCalledWith('lcxl1', true);
    expect(screen.getByTestId('launchcontrol-active-lcxl1').textContent).toBe('Active');
    expect(screen.queryByTestId('launchcontrol-owner-lcxl1')).toBeNull();

    // Clicking again gives it up.
    api.status.mockResolvedValue(status({ connected: true }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('launchcontrol-active-lcxl1'));
    });
    expect(api.setActive).toHaveBeenLastCalledWith('lcxl1', false);
    expect(screen.getByTestId('launchcontrol-active-lcxl1').textContent).toBe('Inactive');
  });

  it('can claim the surface before the controller is plugged in', async () => {
    const api = makeApi(status());
    await renderPanel(api);
    const button = screen.getByTestId('launchcontrol-active-lcxl1');
    expect(button.hasAttribute('disabled')).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(api.setActive).toHaveBeenCalledWith('lcxl1', true);
  });

  it('keeps the last snapshot when a poll returns null (removal/undo race)', async () => {
    vi.useFakeTimers();
    try {
      const api = makeApi(status({ connected: true }));
      render(<LaunchControlPanel instance="lcxl1" api={api} pollMs={10} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15);
      });
      expect(screen.getByTestId('launchcontrol-led-lcxl1').getAttribute('data-connected')).toBe(
        'yes',
      );
      api.status.mockResolvedValue(null);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.getByTestId('launchcontrol-led-lcxl1').getAttribute('data-connected')).toBe(
        'yes',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling on unmount (module removed from the rack)', async () => {
    vi.useFakeTimers();
    try {
      const api = makeApi(status());
      const { unmount } = render(<LaunchControlPanel instance="lcxl1" api={api} pollMs={10} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(api.status.mock.calls.length).toBeGreaterThan(0);
      unmount();
      const calls = api.status.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(api.status.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
