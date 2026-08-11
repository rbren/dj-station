// Custom UI for the Camera module: a live webcam monitor in the rack.
//
// The feed is pure front-end — getUserMedia renders into a <video>; the
// audio thread never sees the camera. Enablement is ephemeral app state
// (deliberately not persisted in the patch): the panel starts disabled
// and the user switches the camera on per session.
//
// Lifecycle: the MediaStream is acquired when the user enables the
// camera and every track is stopped when the camera is disabled, the
// panel unmounts, or the module is deleted (unmount runs the same
// cleanup). Permission-denied / no-camera / no-getUserMedia all
// degrade to an inline message — never a crash.

import { useCallback, useEffect, useRef, useState } from "react";

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

export default function CameraUI() {
  const [state, setState] = useState<CamState>({ kind: "off" });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Guards against a getUserMedia promise resolving after disable/unmount.
  const wantRef = useRef(false);

  const stop = useCallback(() => {
    wantRef.current = false;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

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
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (!wantRef.current) {
        // Disabled (or unmounted) while the permission prompt was up.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
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

  // Release the camera when the panel unmounts (module deleted, patch
  // closed, panel error boundary, ...).
  useEffect(() => stop, [stop]);

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
          style={{ display: state.kind === "live" ? "block" : "none" }}
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
      </div>
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
    </div>
  );
}
