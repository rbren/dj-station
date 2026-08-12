// Camera module panel: a live webcam monitor driven by getUserMedia,
// pure app-layer (the audio thread never sees the camera). Enablement is
// ephemeral per-session state (never persisted), but the panel
// AUTO-STARTS: mounting requests the camera and switches hand tracking
// on once the feed is live — once per mount, so the manual toggles
// stick. The MediaStream is released on disable and on unmount; the
// landmarker is closed when tracking stops, the camera stops, or the
// panel unmounts.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CameraUI from '../../extensions/camera/ui-src/CameraUI';
import {
  createHandLandmarker,
  type LandmarkerHandle,
} from '../../extensions/camera/ui-src/handLandmarker';

// The landmarker wrapper loads the vendored MediaPipe WASM; tests swap
// it for a deterministic stub.
vi.mock('../../extensions/camera/ui-src/handLandmarker', () => ({
  createHandLandmarker: vi.fn(),
}));

// jsdom's HTMLMediaElement.play is not implemented (logs an error);
// the component ignores play() failures, so stub it out.
window.HTMLMediaElement.prototype.play = vi.fn(async () => {});
// jsdom's HTMLCanvasElement.getContext is not implemented either; the
// component tolerates a null context, but returning a recording stub
// keeps stderr clean and lets tests assert the overlay was drawn.
const ctx2d = {
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  fillText: vi.fn(),
  globalAlpha: 1,
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 0,
  font: '',
};
window.HTMLCanvasElement.prototype.getContext = vi.fn(
  () => ctx2d,
) as unknown as typeof HTMLCanvasElement.prototype.getContext;

type Track = { stop: ReturnType<typeof vi.fn> };

function makeStream(): MediaStream & { tracks: Track[] } {
  const tracks = [{ stop: vi.fn() }];
  return {
    tracks,
    getTracks: () => tracks,
  } as unknown as MediaStream & { tracks: Track[] };
}

function mockGetUserMedia(impl: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {
  const getUserMedia = vi.fn(impl);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  return getUserMedia;
}

// jsdom has no requestVideoFrameCallback; install a controllable stub so
// tests can deliver frames by hand (fireFrame).
type Rvfc = (now: number, meta: { mediaTime: number; presentationTime: number }) => void;
let pendingFrame: Rvfc | null = null;
let rvfcCancelled: number[] = [];
(
  window.HTMLVideoElement.prototype as unknown as {
    requestVideoFrameCallback: (cb: Rvfc) => number;
    cancelVideoFrameCallback: (id: number) => void;
  }
).requestVideoFrameCallback = function (cb: Rvfc) {
  pendingFrame = cb;
  return 42;
};
(
  window.HTMLVideoElement.prototype as unknown as {
    cancelVideoFrameCallback: (id: number) => void;
  }
).cancelVideoFrameCallback = (id: number) => {
  rvfcCancelled.push(id);
  pendingFrame = null;
};

function fireFrame(mediaTime: number) {
  const cb = pendingFrame;
  pendingFrame = null;
  act(() => cb?.(performance.now(), { mediaTime, presentationTime: performance.now() }));
}

function makeLandmarker(overrides: Partial<LandmarkerHandle> = {}): LandmarkerHandle & {
  detect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    delegate: 'GPU',
    detect: vi.fn(() => ({
      landmarks: [],
      handedness: [],
    })),
    close: vi.fn(),
    ...overrides,
  } as LandmarkerHandle & { detect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

const mockedCreate = vi.mocked(createHandLandmarker);

beforeEach(() => {
  pendingFrame = null;
  rvfcCancelled = [];
  mockedCreate.mockReset();
  // Auto-start switches tracking on whenever the camera comes up, so
  // every test needs a resolvable landmarker; tests that care override.
  mockedCreate.mockResolvedValue(makeLandmarker());
  for (const fn of Object.values(ctx2d)) if (typeof fn === 'function') fn.mockClear();
});

afterEach(() => {
  // jsdom has no navigator.mediaDevices by default; drop whatever a test set.
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

const flush = () => act(async () => {});

describe('CameraUI', () => {
  it('auto-starts the camera and tracking on mount', async () => {
    const stream = makeStream();
    const gum = mockGetUserMedia(async () => stream);
    render(<CameraUI />);
    expect(gum).toHaveBeenCalledTimes(1);
    await flush(); // camera live
    await flush(); // landmarker loaded
    const video = screen.getByTestId('camera-video') as HTMLVideoElement;
    expect(video.srcObject).toBe(stream);
    expect(screen.getByTestId('camera-track-toggle').textContent).toBe('Stop tracking');
  });

  it('renders a 16:9 monitor big enough for the hand overlay (640x360)', () => {
    render(<CameraUI />);
    const frame = screen.getByTestId('camera-video').parentElement as HTMLElement;
    expect(frame.className).toContain('camera-frame');
    expect(frame.style.width).toBe('640px');
    expect(frame.style.height).toBe('360px');
  });

  it('acquires a video-only stream and shows the feed', async () => {
    const stream = makeStream();
    const gum = mockGetUserMedia(async () => stream);
    render(<CameraUI />);
    await flush();
    expect(gum).toHaveBeenCalledTimes(1);
    expect(gum.mock.calls[0][0]).toMatchObject({ audio: false });
    const video = screen.getByTestId('camera-video') as HTMLVideoElement;
    expect(video.srcObject).toBe(stream);
    expect(video.style.display).toBe('block');
    expect(screen.getByTestId('camera-toggle').textContent).toBe('Disable camera');
  });

  it('disable stops every track, releases the stream, and stays off', async () => {
    const stream = makeStream();
    const gum = mockGetUserMedia(async () => stream);
    render(<CameraUI />);
    await flush();
    fireEvent.click(screen.getByTestId('camera-toggle'));
    expect(stream.tracks[0].stop).toHaveBeenCalled();
    const video = screen.getByTestId('camera-video') as HTMLVideoElement;
    expect(video.srcObject).toBeNull();
    expect(screen.getByTestId('camera-status').textContent).toBe('camera off');
    // Auto-start ran once per mount: nothing re-enables behind the user.
    await flush();
    expect(gum).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('camera-status').textContent).toBe('camera off');
  });

  it('unmount (module delete) stops the tracks', async () => {
    const stream = makeStream();
    mockGetUserMedia(async () => stream);
    const { unmount } = render(<CameraUI />);
    await flush();
    unmount();
    expect(stream.tracks[0].stop).toHaveBeenCalled();
  });

  it('stops a stream that resolves only after the camera was disabled', async () => {
    const stream = makeStream();
    let resolve!: (s: MediaStream) => void;
    mockGetUserMedia(() => new Promise<MediaStream>((r) => (resolve = r)));
    render(<CameraUI />); // auto-start: pending prompt
    fireEvent.click(screen.getByTestId('camera-toggle')); // disable while pending
    resolve(stream);
    await flush();
    expect(stream.tracks[0].stop).toHaveBeenCalled();
    expect(screen.getByTestId('camera-status').textContent).toBe('camera off');
  });

  it('shows a permission-denied message instead of crashing', async () => {
    mockGetUserMedia(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    render(<CameraUI />);
    await flush();
    expect(screen.getByTestId('camera-error').textContent).toContain('denied');
    expect(screen.getByTestId('camera-toggle').textContent).toBe('Enable camera');
  });

  it('shows a no-camera message when no device exists', async () => {
    mockGetUserMedia(async () => {
      throw new DOMException('none', 'NotFoundError');
    });
    render(<CameraUI />);
    await flush();
    expect(screen.getByTestId('camera-error').textContent).toBe('No camera found.');
  });

  it('handles environments without mediaDevices at all', async () => {
    // afterEach removed navigator.mediaDevices; render without re-adding
    // it. Auto-start stays quiet; the manual button reports the error.
    render(<CameraUI />);
    await flush();
    expect(screen.getByTestId('camera-status').textContent).toBe('camera off');
    fireEvent.click(screen.getByTestId('camera-toggle'));
    await flush();
    expect(screen.getByTestId('camera-error').textContent).toBe('Camera is not supported here.');
  });

  it('can retry after an error', async () => {
    const stream = makeStream();
    let fail = true;
    mockGetUserMedia(async () => {
      if (fail) throw new DOMException('busy', 'NotReadableError');
      return stream;
    });
    render(<CameraUI />);
    await flush();
    expect(screen.getByTestId('camera-error')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByTestId('camera-toggle'));
    await flush();
    const video = screen.getByTestId('camera-video') as HTMLVideoElement;
    expect(video.srcObject).toBe(stream);
  });

  it('requests 60 fps in the getUserMedia constraints (R-5)', async () => {
    const gum = mockGetUserMedia(async () => makeStream());
    render(<CameraUI />);
    await flush();
    const constraints = gum.mock.calls[0][0] as { video: MediaTrackConstraints };
    expect(constraints.video.frameRate).toEqual({ ideal: 60 });
  });

  it('mirrors the video display only (R-7)', () => {
    render(<CameraUI />);
    const video = screen.getByTestId('camera-video') as HTMLVideoElement;
    expect(video.style.transform).toBe('scaleX(-1)');
  });
});

// Mount the panel and let auto-start bring the camera and tracking up.
async function startCameraAndTracking() {
  mockGetUserMedia(async () => makeStream());
  const view = render(<CameraUI />);
  await flush(); // camera live
  await flush(); // landmarker loaded
  return view;
}

describe('CameraUI hand tracking', () => {
  it('shows the tracking toggle only while the camera is live', async () => {
    mockGetUserMedia(async () => makeStream());
    render(<CameraUI />);
    expect(screen.queryByTestId('camera-track-toggle')).toBeNull();
    await flush();
    await flush();
    // Auto-start has already switched tracking on.
    expect(screen.getByTestId('camera-track-toggle').textContent).toBe('Stop tracking');
  });

  it('does not restart tracking after the user stops it', async () => {
    await startCameraAndTracking();
    fireEvent.click(screen.getByTestId('camera-track-toggle'));
    expect(screen.getByTestId('camera-track-toggle').textContent).toBe('Track hands');
    // Auto-track ran once per mount: state changes don't re-arm it.
    await flush();
    expect(screen.getByTestId('camera-track-toggle').textContent).toBe('Track hands');
  });

  it('drives inference from requestVideoFrameCallback with the frame mediaTime (R-6)', async () => {
    const lm = makeLandmarker();
    mockedCreate.mockResolvedValue(lm);
    await startCameraAndTracking();
    fireFrame(0.1);
    fireFrame(0.2);
    // detectForVideo takes ms; the mediaTime rides along in the frame.
    expect(lm.detect).toHaveBeenCalledTimes(2);
    expect(lm.detect.mock.calls[0][1]).toBeCloseTo(100);
    expect(lm.detect.mock.calls[1][1]).toBeCloseTo(200);
  });

  it('skips inference for rVFC ticks whose mediaTime did not advance', async () => {
    const lm = makeLandmarker();
    mockedCreate.mockResolvedValue(lm);
    await startCameraAndTracking();
    fireFrame(0.1);
    fireFrame(0.1); // duplicate frame: dropped, not re-inferred
    expect(lm.detect).toHaveBeenCalledTimes(1);
  });

  it('falls back to the rVFC clock when mediaTime is stuck (WebKit gUM bug)', async () => {
    const lm = makeLandmarker();
    mockedCreate.mockResolvedValue(lm);
    await startCameraAndTracking();
    // WebKit reports the same mediaTime on every tick for camera streams.
    fireFrame(0.05); // inferred (first frame)
    fireFrame(0.05); // stuck 1 — dropped
    fireFrame(0.05); // stuck 2 — dropped
    fireFrame(0.05); // stuck 3 — fallback engages, inferred via now-clock
    fireFrame(0.05); // still inferred
    fireFrame(0.05);
    expect(lm.detect.mock.calls.length).toBeGreaterThanOrEqual(4);
    // Timestamps fed to the landmarker keep advancing after the fallback.
    const stamps = lm.detect.mock.calls.map((c) => c[1] as number);
    for (let i = 4; i < stamps.length; i++) {
      expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);
    }
  });

  it('keeps the overlay out of the video: a separate toggleable canvas (R-13)', async () => {
    const lm = makeLandmarker();
    mockedCreate.mockResolvedValue(lm);
    await startCameraAndTracking();
    const overlay = screen.getByTestId('camera-overlay') as HTMLCanvasElement;
    expect(overlay.tagName).toBe('CANVAS');
    expect(overlay.style.display).toBe('block');
    // Toggling the overlay off hides the canvas; the video is untouched.
    fireEvent.click(screen.getByTestId('camera-overlay-toggle'));
    expect(overlay.style.display).toBe('none');
    const video = screen.getByTestId('camera-video') as HTMLVideoElement;
    expect(video.style.display).toBe('block');
  });

  it('stopping tracking closes the landmarker and cancels the frame loop', async () => {
    const lm = makeLandmarker();
    mockedCreate.mockResolvedValue(lm);
    await startCameraAndTracking();
    fireFrame(0.1);
    fireEvent.click(screen.getByTestId('camera-track-toggle'));
    expect(lm.close).toHaveBeenCalled();
    expect(rvfcCancelled).toContain(42);
  });

  it('disabling the camera stops tracking too', async () => {
    const lm = makeLandmarker();
    mockedCreate.mockResolvedValue(lm);
    await startCameraAndTracking();
    fireEvent.click(screen.getByTestId('camera-toggle'));
    expect(lm.close).toHaveBeenCalled();
    expect(screen.queryByTestId('camera-track-toggle')).toBeNull();
  });

  it('unmount closes the landmarker', async () => {
    const lm = makeLandmarker();
    mockedCreate.mockResolvedValue(lm);
    const { unmount } = await startCameraAndTracking();
    unmount();
    expect(lm.close).toHaveBeenCalled();
  });

  it('closes a landmarker that finishes loading after tracking was stopped', async () => {
    const lm = makeLandmarker();
    let resolve!: (l: LandmarkerHandle) => void;
    mockedCreate.mockReturnValue(new Promise((r) => (resolve = r)));
    mockGetUserMedia(async () => makeStream());
    render(<CameraUI />);
    await flush(); // camera live; auto-track load pending
    fireEvent.click(screen.getByTestId('camera-track-toggle')); // stop while pending
    resolve(lm);
    await flush();
    expect(lm.close).toHaveBeenCalled();
    expect(screen.getByTestId('camera-track-toggle').textContent).toBe('Track hands');
  });

  it('degrades to an inline message when the model fails to load', async () => {
    mockedCreate.mockRejectedValue(new Error('no wasm'));
    await startCameraAndTracking();
    expect(screen.getByTestId('camera-track-error').textContent).toContain('no wasm');
    expect(screen.getByTestId('camera-track-toggle').textContent).toBe('Track hands');
  });

  it('surfaces the diagnostics readout with delegate and drop count (§4.4)', async () => {
    const lm = makeLandmarker({ delegate: 'CPU' });
    mockedCreate.mockResolvedValue(lm);
    await startCameraAndTracking();
    fireFrame(0.1);
    fireFrame(0.1); // one dropped frame
    expect(screen.queryByTestId('camera-stats')).toBeNull(); // off by default
    fireEvent.click(screen.getByTestId('camera-stats-toggle'));
    const stats = screen.getByTestId('camera-stats');
    expect(stats.textContent).toContain('delegate CPU');
    expect(stats.textContent).toContain('dropped 1');
    expect(stats.textContent).toContain('infer');
    expect(stats.textContent).toContain('latency');
    expect(stats.textContent).toContain('fps');
  });

  it('counts a throwing detect as a dropped frame instead of crashing', async () => {
    const lm = makeLandmarker();
    lm.detect.mockImplementation(() => {
      throw new Error('inference blew up');
    });
    mockedCreate.mockResolvedValue(lm);
    await startCameraAndTracking();
    fireFrame(0.1);
    fireEvent.click(screen.getByTestId('camera-stats-toggle'));
    expect(screen.getByTestId('camera-stats').textContent).toContain('dropped 1');
    // The loop keeps running after a failed frame.
    fireFrame(0.2);
    expect(lm.detect).toHaveBeenCalledTimes(2);
  });
});
