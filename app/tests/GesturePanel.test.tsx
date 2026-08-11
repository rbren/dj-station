// Gesture Control panel (M5, PRD §7.3): overlay renders wheels/landmarks
// from detection data (no camera needed), mode selection, the learn flow,
// mapping list with live values, and the mock feed controls.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GesturePanel, type GestureApi } from '../src/components/GesturePanel';
import type { GestureStatus } from '../src/engine';

const baseStatus: GestureStatus = {
  mode: 'wheel',
  modes: ['wheel', 'landmark'],
  wheels: {
    wheels: [
      { cx: 0.28, cy: 0.5, radius: 0.22, center_radius: 0.08 },
      { cx: 0.72, cy: 0.5, radius: 0.22, center_radius: 0.08 },
    ],
  },
  mappings: [],
  detection: null,
  active_zones: [],
  feed: null,
  camera: 'mock',
};

function makeApi(status: GestureStatus): GestureApi & { status: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn().mockResolvedValue(status),
    setMode: vi.fn().mockResolvedValue(undefined),
    addMapping: vi.fn().mockResolvedValue(undefined),
    removeMapping: vi.fn().mockResolvedValue(undefined),
    learnBegin: vi.fn().mockResolvedValue(undefined),
    learnPoll: vi.fn().mockResolvedValue(false),
    feedStart: vi.fn().mockResolvedValue(undefined),
    feedStop: vi.fn().mockResolvedValue(undefined),
  };
}

const noop = () => {};

async function renderPanel(api: GestureApi) {
  render(<GesturePanel instance="gest1" api={api} onChanged={noop} pollMs={100000} />);
  // Initial status poll (a 0 ms timeout) fires and resolves.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}

describe('GesturePanel', () => {
  it('renders both wheels with 18 zones (8 sections + center each) in wheel mode', async () => {
    await renderPanel(makeApi(baseStatus));
    for (const w of [0, 1]) {
      for (let z = 0; z <= 8; z++) {
        expect(screen.getByTestId(`gesture-zone-${w}-${z}`)).toBeTruthy();
      }
    }
    expect(screen.getByTestId('gesture-camera-badge').textContent).toMatch(/no camera/);
  });

  it('highlights active and mapped zones from detection data', async () => {
    await renderPanel(
      makeApi({
        ...baseStatus,
        active_zones: [[1, 3]],
        mappings: [{ name: 'pad', mode: 'wheel', config: { wheel: 0, zone: 5 }, value: 0 }],
      }),
    );
    expect(screen.getByTestId('gesture-zone-1-3').getAttribute('class')).toContain(
      'gesture-zone-active',
    );
    expect(screen.getByTestId('gesture-zone-0-5').getAttribute('class')).toContain(
      'gesture-zone-mapped',
    );
    expect(screen.getByTestId('gesture-zone-0-1').getAttribute('class')).not.toContain(
      'gesture-zone-active',
    );
  });

  it('draws labeled hand landmarks in landmark mode', async () => {
    const points = Array.from({ length: 21 }, (_, i) => ({ x: i / 21, y: 0.5 }));
    await renderPanel(
      makeApi({
        ...baseStatus,
        mode: 'landmark',
        detection: { hands: [{ handedness: 'Left', points }] },
      }),
    );
    expect(screen.getByTestId('gesture-hand-Left')).toBeTruthy();
    expect(screen.getByTestId('gesture-label-L.index.tip').textContent).toBe('L.index.tip');
    expect(screen.getByTestId('gesture-label-L.thumb.tip')).toBeTruthy();
  });

  it('selects modes from the extensible mode list', async () => {
    const api = makeApi({ ...baseStatus, modes: ['wheel', 'landmark', 'spread'] });
    await renderPanel(api);
    const select = screen.getByTestId('gesture-mode') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['wheel', 'landmark', 'spread']);
    await act(async () => {
      fireEvent.change(select, { target: { value: 'spread' } });
    });
    expect(api.setMode).toHaveBeenCalledWith('gest1', 'spread');
  });

  it('runs the learn flow: arm, poll until captured, refresh', async () => {
    vi.useFakeTimers();
    try {
      const api = makeApi(baseStatus);
      api.learnPoll = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
      const onChanged = vi.fn();
      render(<GesturePanel instance="gest1" api={api} onChanged={onChanged} pollMs={10} />);
      await act(async () => {});
      fireEvent.change(screen.getByTestId('gesture-learn-name'), { target: { value: 'pinch' } });
      await act(async () => {
        fireEvent.click(screen.getByTestId('gesture-learn'));
      });
      expect(api.learnBegin).toHaveBeenCalledWith('gest1');
      expect(screen.getByTestId('gesture-learn-hint')).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(api.learnPoll).toHaveBeenCalledWith('gest1', 'pinch');
      expect(onChanged).toHaveBeenCalled();
      expect(screen.queryByTestId('gesture-learn-hint')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists mappings with live value bars and removes them', async () => {
    const api = makeApi({
      ...baseStatus,
      mappings: [
        {
          name: 'pinch',
          mode: 'landmark',
          config: { type: 'distance', a: 'L.thumb.tip', b: 'L.index.tip' },
          value: 5,
        },
      ],
    });
    await renderPanel(api);
    expect(screen.getByTestId('gesture-mapping-pinch').textContent).toContain('dist');
    expect((screen.getByTestId('gesture-value-pinch') as HTMLElement).style.width).toBe('50%');
    await act(async () => {
      fireEvent.click(screen.getByTestId('gesture-remove-pinch'));
    });
    expect(api.removeMapping).toHaveBeenCalledWith('gest1', 'pinch');
  });

  it('starts and stops the mock feed with the chosen fixture', async () => {
    const api = makeApi(baseStatus);
    await renderPanel(api);
    fireEvent.change(screen.getByTestId('gesture-feed-source'), { target: { value: 'pinch' } });
    // The refresh after starting reports the running feed.
    api.status.mockResolvedValue({ ...baseStatus, feed: 'pinch' });
    await act(async () => {
      fireEvent.click(screen.getByTestId('gesture-feed-start'));
    });
    expect(api.feedStart).toHaveBeenCalledWith('gest1', 'pinch');
    await waitFor(() => expect(screen.getByTestId('gesture-feed-stop')).toBeTruthy());
    expect(screen.getByTestId('gesture-camera-badge').textContent).toBe('mock feed: pinch');
    await act(async () => {
      fireEvent.click(screen.getByTestId('gesture-feed-stop'));
    });
    expect(api.feedStop).toHaveBeenCalledWith('gest1');
  });

  it('stops polling status on unmount (module removed from the rack)', async () => {
    vi.useFakeTimers();
    try {
      const api = makeApi(baseStatus);
      const { unmount } = render(
        <GesturePanel instance="gest1" api={api} onChanged={noop} pollMs={10} />,
      );
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

  it('keeps the last snapshot when a poll returns null (removal/undo race)', async () => {
    vi.useFakeTimers();
    try {
      const api = makeApi(baseStatus);
      render(<GesturePanel instance="gest1" api={api} onChanged={noop} pollMs={10} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15);
      });
      expect(screen.getByTestId('gesture-zone-0-1')).toBeTruthy();
      // The module disappears server-side; the quiet poll yields null.
      api.status.mockResolvedValue(null);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.getByTestId('gesture-zone-0-1')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
