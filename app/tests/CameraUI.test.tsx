// Camera module panel: a live webcam monitor driven by getUserMedia,
// pure app-layer (the audio thread never sees the camera). Enablement is
// ephemeral per-session state — the panel mounts with the camera off —
// and the MediaStream is released on disable and on unmount.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CameraUI from '../../extensions/camera/ui-src/CameraUI';

// jsdom's HTMLMediaElement.play is not implemented (logs an error);
// the component ignores play() failures, so stub it out.
window.HTMLMediaElement.prototype.play = vi.fn(async () => {});

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

afterEach(() => {
  // jsdom has no navigator.mediaDevices by default; drop whatever a test set.
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

const flush = () => act(async () => {});

describe('CameraUI', () => {
  it('mounts with the camera off and does not touch getUserMedia', () => {
    const gum = mockGetUserMedia(async () => makeStream());
    render(<CameraUI />);
    expect(screen.getByTestId('camera-status').textContent).toBe('camera off');
    expect(gum).not.toHaveBeenCalled();
  });

  it('renders a 16:9 monitor big enough for a live feed (320x180)', () => {
    render(<CameraUI />);
    const frame = screen.getByTestId('camera-video').parentElement as HTMLElement;
    expect(frame.className).toContain('camera-frame');
    expect(frame.style.width).toBe('320px');
    expect(frame.style.height).toBe('180px');
  });

  it('enable acquires a video-only stream and shows the feed', async () => {
    const stream = makeStream();
    const gum = mockGetUserMedia(async () => stream);
    render(<CameraUI />);
    fireEvent.click(screen.getByTestId('camera-toggle'));
    await flush();
    expect(gum).toHaveBeenCalledTimes(1);
    expect(gum.mock.calls[0][0]).toMatchObject({ audio: false });
    const video = screen.getByTestId('camera-video') as HTMLVideoElement;
    expect(video.srcObject).toBe(stream);
    expect(video.style.display).toBe('block');
    expect(screen.getByTestId('camera-toggle').textContent).toBe('Disable camera');
  });

  it('disable stops every track and releases the stream', async () => {
    const stream = makeStream();
    mockGetUserMedia(async () => stream);
    render(<CameraUI />);
    fireEvent.click(screen.getByTestId('camera-toggle'));
    await flush();
    fireEvent.click(screen.getByTestId('camera-toggle'));
    expect(stream.tracks[0].stop).toHaveBeenCalled();
    const video = screen.getByTestId('camera-video') as HTMLVideoElement;
    expect(video.srcObject).toBeNull();
    expect(screen.getByTestId('camera-status').textContent).toBe('camera off');
  });

  it('unmount (module delete) stops the tracks', async () => {
    const stream = makeStream();
    mockGetUserMedia(async () => stream);
    const { unmount } = render(<CameraUI />);
    fireEvent.click(screen.getByTestId('camera-toggle'));
    await flush();
    unmount();
    expect(stream.tracks[0].stop).toHaveBeenCalled();
  });

  it('stops a stream that resolves only after the camera was disabled', async () => {
    const stream = makeStream();
    let resolve!: (s: MediaStream) => void;
    mockGetUserMedia(() => new Promise<MediaStream>((r) => (resolve = r)));
    render(<CameraUI />);
    fireEvent.click(screen.getByTestId('camera-toggle')); // enable: pending prompt
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
    fireEvent.click(screen.getByTestId('camera-toggle'));
    await flush();
    expect(screen.getByTestId('camera-error').textContent).toContain('denied');
    expect(screen.getByTestId('camera-toggle').textContent).toBe('Enable camera');
  });

  it('shows a no-camera message when no device exists', async () => {
    mockGetUserMedia(async () => {
      throw new DOMException('none', 'NotFoundError');
    });
    render(<CameraUI />);
    fireEvent.click(screen.getByTestId('camera-toggle'));
    await flush();
    expect(screen.getByTestId('camera-error').textContent).toBe('No camera found.');
  });

  it('handles environments without mediaDevices at all', async () => {
    // afterEach removed navigator.mediaDevices; render without re-adding it.
    render(<CameraUI />);
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
    fireEvent.click(screen.getByTestId('camera-toggle'));
    await flush();
    expect(screen.getByTestId('camera-error')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByTestId('camera-toggle'));
    await flush();
    const video = screen.getByTestId('camera-video') as HTMLVideoElement;
    expect(video.srcObject).toBe(stream);
  });
});
