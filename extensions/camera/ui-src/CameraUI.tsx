// Custom UI for the Camera module: a live webcam monitor in the rack,
// with optional MediaPipe hand tracking drawn over the feed.
//
// The feed is pure front-end — getUserMedia renders into a <video>; the
// audio thread never sees the camera. Enablement is ephemeral app state
// (deliberately not persisted in the patch): the panel starts disabled
// and the user switches the camera on per session. Hand tracking is
// likewise per-session and off by default.
//
// Lifecycle: the MediaStream is acquired when the user enables the
// camera and every track is stopped when the camera is disabled, the
// panel unmounts, or the module is deleted (unmount runs the same
// cleanup). Disabling the camera also stops tracking and closes the
// landmarker. Permission-denied / no-camera / no-getUserMedia all
// degrade to an inline message — never a crash.
//
// Mirroring convention (R-7, canonical write-up in handTracking.ts):
// the <video> is CSS-mirrored so the panel behaves like a mirror; the
// tracker sees RAW frames and the handedness swap happens once, in
// handTracking.physicalHand. The overlay canvas is NOT mirrored —
// engine coordinates are already mirror-view.
//
// The tracking loop is driven by requestVideoFrameCallback — not
// requestAnimationFrame — and every landmark set carries the frame's
// mediaTime from the start (R-6): nothing in this phase needs real
// timestamps, everything after it does.

import { useCallback, useEffect, useRef, useState } from "react";
import { createHandLandmarker, type LandmarkerHandle } from "./handLandmarker";
import { resolveHands, type HandFrame } from "./handTracking";
import { clearOverlay, drawHandFrame } from "./HandOverlay";
import { StatsAccumulator, type TrackingStats } from "./trackingStats";

type CamState =
  | { kind: "off" }
  | { kind: "starting" }
  | { kind: "live" }
  | { kind: "error"; message: string };

// Monitor size: 16:9 and roughly double the old 192x144 area, so a live
// feed is comfortably visible in the rack (the panel sizes itself from
// this content).
const W = 320;
const H = 180;

function errorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera access denied. Allow camera permission and retry.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No camera found.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "Camera is unavailable (in use by another app?).";
  }
  return err instanceof Error && err.message
    ? err.message
    : "Camera failed to start.";
}

type TrackState = "off" | "loading" | "on";

export default function CameraUI() {
  const [state, setState] = useState<CamState>({ kind: "off" });
  const [trackState, setTrackState] = useState<TrackState>("off");
  const [trackError, setTrackError] = useState<string | null>(null);
  const [overlayOn, setOverlayOn] = useState(true);
  const [statsOn, setStatsOn] = useState(false);
  const [stats, setStats] = useState<TrackingStats | null>(null);
  // Delivered capture fps as reported by the video track (R-5): many
  // webcams silently supply 30 when asked for 60.
  const [deliveredFps, setDeliveredFps] = useState<number | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Guards against a getUserMedia promise resolving after disable/unmount.
  const wantRef = useRef(false);
  // Guards against the async landmarker load finishing after stop.
  const trackWantRef = useRef(false);
  const landmarkerRef = useRef<LandmarkerHandle | null>(null);
  const rvfcIdRef = useRef<number | null>(null);
  const statsAccRef = useRef(new StatsAccumulator());
  // The rVFC tick reads the overlay toggle through a ref so flipping it
  // doesn't restart the loop.
  const overlayOnRef = useRef(overlayOn);
  useEffect(() => {
    overlayOnRef.current = overlayOn;
  }, [overlayOn]);

  const stopTracking = useCallback(() => {
    trackWantRef.current = false;
    const video = videoRef.current;
    if (rvfcIdRef.current !== null && video?.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(rvfcIdRef.current);
    }
    rvfcIdRef.current = null;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    statsAccRef.current.reset();
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) clearOverlay(ctx, W, H);
    setTrackState("off");
    setStats(null);
  }, []);

  const stop = useCallback(() => {
    stopTracking();
    wantRef.current = false;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setDeliveredFps(null);
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [stopTracking]);

  const start = useCallback(async () => {
    if (wantRef.current) return;
    wantRef.current = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      wantRef.current = false;
      setState({ kind: "error", message: "Camera is not supported here." });
      return;
    }
    setState({ kind: "starting" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // 60 fps requested for tracking headroom (R-5); what the camera
        // actually delivers is reported in the diagnostics readout.
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60 },
        },
        audio: false,
      });
      if (!wantRef.current) {
        // Disabled (or unmounted) while the permission prompt was up.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      // getSettings is missing on jsdom's mock tracks, like play() below.
      const fps = stream.getVideoTracks?.()[0]?.getSettings?.().frameRate;
      setDeliveredFps(typeof fps === "number" ? fps : null);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // play() can reject on jsdom/tests or if the tab is backgrounded;
        // the stream is still live, so ignore it.
        void videoRef.current.play?.()?.catch?.(() => undefined);
      }
      setState({ kind: "live" });
    } catch (err) {
      wantRef.current = false;
      setState({ kind: "error", message: errorMessage(err) });
    }
  }, []);

  const startTracking = useCallback(async () => {
    if (trackWantRef.current) return;
    const video = videoRef.current;
    if (!video?.requestVideoFrameCallback) {
      setTrackError("Hand tracking is not supported here.");
      return;
    }
    trackWantRef.current = true;
    setTrackError(null);
    setTrackState("loading");
    let landmarker: LandmarkerHandle;
    try {
      landmarker = await createHandLandmarker();
    } catch (err) {
      trackWantRef.current = false;
      setTrackState("off");
      setTrackError(
        err instanceof Error && err.message
          ? `Hand tracking failed to start: ${err.message}`
          : "Hand tracking failed to start.",
      );
      return;
    }
    if (!trackWantRef.current) {
      // Tracking (or the camera) was switched off during the model load.
      landmarker.close();
      return;
    }
    landmarkerRef.current = landmarker;
    statsAccRef.current.reset();
    statsAccRef.current.delegate = landmarker.delegate;
    setTrackState("on");

    const acc = statsAccRef.current;
    const tick: VideoFrameRequestCallback = (now, meta) => {
      if (!trackWantRef.current || !landmarkerRef.current) return;
      const v = videoRef.current;
      if (!v) return;
      // rVFC ticks whose mediaTime did not advance are counted as
      // dropped and skipped — feeding a repeat timestamp to a VIDEO-mode
      // landmarker is invalid.
      if (acc.frameArrived(meta.mediaTime)) {
        try {
          const t0 = performance.now();
          const raw = landmarkerRef.current.detect(v, meta.mediaTime * 1000);
          const t1 = performance.now();
          // The frame carries its mediaTime from the start (R-6).
          const frame: HandFrame = resolveHands(raw, meta.mediaTime);
          const ctx = canvasRef.current?.getContext("2d");
          if (ctx) {
            if (overlayOnRef.current) {
              drawHandFrame(ctx, frame, v.videoWidth, v.videoHeight, W, H);
            } else {
              clearOverlay(ctx, W, H);
            }
          }
          // End-to-end latency: frame capture (when known) -> overlay
          // drawn. captureTime is only present on some pipelines; the
          // presentation timestamp is the fallback reference.
          const ref = meta.captureTime ?? meta.presentationTime ?? now;
          acc.frameProcessed(t1 - t0, performance.now() - ref);
        } catch {
          acc.frameFailed();
        }
      }
      rvfcIdRef.current = v.requestVideoFrameCallback(tick);
    };
    rvfcIdRef.current = video.requestVideoFrameCallback(tick);
  }, []);

  // Release the camera when the panel unmounts (module deleted, patch
  // closed, panel error boundary, ...).
  useEffect(() => stop, [stop]);

  const tracking = trackState === "on";

  // Poll the accumulator for the dev readout while it is visible.
  useEffect(() => {
    if (!tracking || !statsOn) return;
    const poll = () => setStats(statsAccRef.current.snapshot());
    poll();
    const id = setInterval(poll, 500);
    return () => clearInterval(id);
  }, [tracking, statsOn]);

  const live = state.kind === "live" || state.kind === "starting";

  return (
    <div className="camera-ui" data-testid="camera-ui">
      <div className="camera-frame" style={{ width: W, height: H }}>
        <video
          ref={videoRef}
          className="camera-video"
          data-testid="camera-video"
          width={W}
          height={H}
          muted
          playsInline
          style={{
            display: state.kind === "live" ? "block" : "none",
            // Mirror the DISPLAY only (R-7): the tracker reads the raw
            // frames from this element, not the mirrored pixels.
            transform: "scaleX(-1)",
          }}
        />
        <canvas
          ref={canvasRef}
          className="camera-overlay"
          data-testid="camera-overlay"
          width={W}
          height={H}
          style={{
            display:
              state.kind === "live" && tracking && overlayOn ? "block" : "none",
          }}
        />
        {state.kind === "off" && (
          <div className="camera-status" data-testid="camera-status">
            camera off
          </div>
        )}
        {state.kind === "starting" && (
          <div className="camera-status" data-testid="camera-status">
            starting…
          </div>
        )}
        {state.kind === "error" && (
          <div
            className="camera-status camera-error"
            data-testid="camera-error"
          >
            {state.message}
          </div>
        )}
        {statsOn && tracking && stats && (
          <div className="camera-stats" data-testid="camera-stats">
            <div>
              fps {stats.cameraFps.toFixed(1)}
              {deliveredFps !== null && ` (cam reports ${deliveredFps})`}
            </div>
            <div>infer {stats.inferenceMs.toFixed(1)} ms</div>
            <div>latency {stats.latencyMs.toFixed(1)} ms</div>
            <div>dropped {stats.droppedFrames}</div>
            <div>delegate {stats.delegate ?? "?"}</div>
          </div>
        )}
      </div>
      {trackError && (
        <div className="camera-error" data-testid="camera-track-error">
          {trackError}
        </div>
      )}
      <div className="camera-controls">
        <button
          className="camera-toggle"
          data-testid="camera-toggle"
          aria-pressed={live}
          onClick={() => {
            if (live) {
              stop();
              setState({ kind: "off" });
            } else {
              void start();
            }
          }}
        >
          {live ? "Disable camera" : "Enable camera"}
        </button>
        {state.kind === "live" && (
          <button
            className="camera-toggle"
            data-testid="camera-track-toggle"
            aria-pressed={trackState !== "off"}
            onClick={() => {
              if (trackState !== "off") {
                stopTracking();
                setTrackError(null);
              } else {
                void startTracking();
              }
            }}
          >
            {trackState === "on"
              ? "Stop tracking"
              : trackState === "loading"
                ? "Loading model…"
                : "Track hands"}
          </button>
        )}
        {tracking && (
          <>
            <button
              className="camera-toggle"
              data-testid="camera-overlay-toggle"
              aria-pressed={overlayOn}
              onClick={() => setOverlayOn((v) => !v)}
            >
              Overlay
            </button>
            <button
              className="camera-toggle"
              data-testid="camera-stats-toggle"
              aria-pressed={statsOn}
              onClick={() => setStatsOn((v) => !v)}
            >
              Stats
            </button>
          </>
        )}
      </div>
    </div>
  );
}
